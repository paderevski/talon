# Plumbing for EC2-launched jobs (see infra/CURRENT_STATUS.md, "Building
# EC2-launched jobs"). Nothing here runs a job by itself: it creates the bucket,
# network rules, job instance role, launch template and the web server's
# (tightly limited) permission to launch and terminate job instances.
#
# Contract with the web server: each launch gets its own S3 folder,
# jobs/<id>-<random>. The server writes <folder>/input/, then runs a launch
# template with tags talon-job=<id>, talon-s3-prefix=<folder> and
# talon-max-seconds=<n> (plus Project=talon, Component=job). The instance
# (job_boot.sh) writes status.json, logs/, output/ and changed/ back and powers
# itself off, which terminates it. It also streams its boot log to CloudWatch
# (talon-log-group tag).

variable "jobs_retention_days" {
  description = "Days before job input, logs and output expire from S3. 30 to start; class projects may need longer."
  type        = number
  default     = 30
}

variable "ec2_jobs_enabled" {
  description = "Write EC2_JOBS_ENABLED into the web server's config at first boot. Changing it replaces the web server (user_data); the data in RDS stays."
  type        = bool
  default     = true
}

variable "ec2_gpu_admin_only" {
  description = "Write EC2_GPU_ADMIN_ONLY into the web server's config at first boot: true keeps GPU machines admin-only, false offers them to students. Changing it replaces the web server (user_data); the data in RDS stays."
  type        = bool
  default     = false
}

variable "job_instance_type" {
  description = "Default instance type in the job launch template (Graviton, matching the AMI; non-burstable, since t4g bills surplus CPU credits the job rate does not cover)."
  type        = string
  default     = "m7g.large"
}

variable "allowed_job_instance_types" {
  description = "CPU instance types the web server may launch (CPU launch template only). The vCPU quotas are far too high to act as a cap, so this is the cap."
  type        = list(string)
  default     = ["c7g.large", "c7g.xlarge", "m7g.large", "m7g.xlarge", "r7g.large"]
}

# GPU jobs (x86_64) on the PyTorch Deep Learning AMI, from their own launch
# template; the web server may launch it only with these types. Keep in step
# with backend/src/execution/ec2Rates.js. Types the PyTorch DLAMI does not
# support (G7e) would need a second template on the Base DLAMI (see
# CURRENT_STATUS.md, EC2 jobs step 4).
variable "gpu_job_instance_types" {
  description = "GPU types launched from the PyTorch Deep Learning AMI template."
  type        = list(string)
  default     = ["g4dn.xlarge", "g4dn.2xlarge", "g6.xlarge", "g6e.2xlarge"]
}

variable "gpu_job_ami_parameter" {
  description = "SSM parameter for the PyTorch Deep Learning AMI. Resolved at plan time, so the AMI moves forward only on terraform apply."
  type        = string
  default     = "/aws/service/deeplearning/ami/x86_64/oss-nvidia-driver-gpu-pytorch-2.12-ubuntu-24.04/latest/ami-id"
}

variable "gpu_job_root_volume_gb" {
  description = "Root volume for the PyTorch DLAMI template (the AMI itself is 30 GB)."
  type        = number
  default     = 60
}

variable "job_max_volume_gb" {
  description = "Largest root volume the web server may request for a job (IAM cap). Above the templates' own sizes so a per-job disk size can be added in the app without a policy change; the templates' sizes are the defaults."
  type        = number
  default     = 500
}

variable "job_root_volume_gb" {
  type    = number
  default = 30
}

variable "job_availability_zones" {
  description = "Zones that get a jobs subnet in Talon's VPC (network.tf); the web server launches jobs into these. A launch moves to the next zone when one has no capacity or does not offer the type (us-east-1e offers none of the job types)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c", "us-east-1d"]
}

locals {
  jobs_bucket_name = "${local.name}-jobs-${local.account_id}"
  job_subnet_ids   = [for az in var.job_availability_zones : aws_subnet.jobs[az].id]
}

# ---------------------------------------------------------------- bucket

resource "aws_s3_bucket" "jobs" {
  bucket = local.jobs_bucket_name
}

resource "aws_s3_bucket_public_access_block" "jobs" {
  bucket                  = aws_s3_bucket.jobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "jobs" {
  bucket = aws_s3_bucket.jobs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3 (no KMS key): job data is short-lived and the job role then needs no
# key grants.
resource "aws_s3_bucket_server_side_encryption_configuration" "jobs" {
  bucket = aws_s3_bucket.jobs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "jobs" {
  bucket = aws_s3_bucket.jobs.id

  rule {
    id     = "expire-job-files"
    status = "Enabled"
    filter {
      prefix = "jobs/"
    }
    expiration {
      days = var.jobs_retention_days
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "jobs_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.jobs.arn, "${aws_s3_bucket.jobs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "jobs" {
  bucket     = aws_s3_bucket.jobs.id
  policy     = data.aws_iam_policy_document.jobs_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.jobs]
}

# ---------------------------------------------------------------- network

# No inbound at all. Outbound is HTTPS and DNS only: enough for the S3 and SSM
# endpoints, pip, kagglehub, Hugging Face and most dataset hosts, while SMTP,
# SSH, scanning and most mining pools are blocked. Never add a rule here that
# lets this group reach the web server's group.
resource "aws_security_group" "job" {
  name        = "${local.name}-job"
  description = "Talon job instances - no inbound, HTTPS and DNS out"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS (udp)"
    from_port   = 53
    to_port     = 53
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "DNS (tcp)"
    from_port   = 53
    to_port     = 53
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-job"
  }
}

# ---------------------------------------------------------------- job boot logs

# Job instances' boot logs (job_boot.sh), stream <job id>/<instance id>. The
# same log also goes to S3 (<job folder>/logs/boot.log), which the app reads; this
# copy arrives every 15 seconds, survives an instance that dies, and can be
# searched across jobs. The student's own output (job.log) stays in S3 only.
resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/talon/${var.environment}/jobs"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------- job role

resource "aws_iam_role" "job" {
  name               = "${local.name}-job"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# Admin shell on a job instance for debugging (aws ssm start-session).
resource "aws_iam_role_policy_attachment" "job_ssm_core" {
  role       = aws_iam_role.job.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# The role is shared by all jobs, so it cannot be limited to one job id: a job
# that escapes its sandbox could read another job's input or overwrite its
# status, if it knows that job's folder. Folders are jobs/<id>-<128 random
# bits> (talon-s3-prefix tag) and ListBucket needs a full folder prefix, so
# they cannot be guessed or listed.
# Student code does not get these credentials (metadata is blocked for its
# user). Per-job scoped credentials are the real fix (Batch phase 0).
data "aws_iam_policy_document" "job_access" {
  statement {
    sid       = "ReadInput"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.jobs.arn}/jobs/*/input/*"]
  }

  statement {
    sid       = "ListInput"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.jobs.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["jobs/*/input/*"]
    }
  }

  # Boot logs (job_boot.sh, written by root; never the student's output) to
  # CloudWatch, one stream per job. Same caveat as above: any job could write
  # another job's stream.
  statement {
    sid       = "WriteBootLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [aws_cloudwatch_log_group.jobs.arn, "${aws_cloudwatch_log_group.jobs.arn}:log-stream:*"]
  }

  statement {
    sid     = "WriteStatusLogsOutput"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.jobs.arn}/jobs/*/status.json",
      "${aws_s3_bucket.jobs.arn}/jobs/*/logs/*",
      "${aws_s3_bucket.jobs.arn}/jobs/*/output/*",
      "${aws_s3_bucket.jobs.arn}/jobs/*/changed/*",
    ]
  }
}

resource "aws_iam_role_policy" "job_access" {
  name   = "${local.name}-job-access"
  role   = aws_iam_role.job.id
  policy = data.aws_iam_policy_document.job_access.json
}

resource "aws_iam_instance_profile" "job" {
  name = "${local.name}-job"
  role = aws_iam_role.job.name
}

# ---------------------------------------------------------------- launch template

resource "aws_launch_template" "job" {
  name                   = "${local.name}-job"
  description            = "Talon job instance (CPU, Ubuntu arm64)"
  image_id               = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.job_instance_type
  vpc_security_group_ids = [aws_security_group.job.id]
  update_default_version = true

  user_data = base64encode(file("${path.module}/job_boot.sh"))

  lifecycle {
    precondition {
      # EC2 refuses user data over 16 KB (before base64). Trim comments, or
      # switch both templates to base64gzip (cloud-init reads gzip), if this fails.
      condition     = length(file("${path.module}/job_boot.sh")) <= 16384
      error_message = "job_boot.sh is over EC2's 16 KB user data limit."
    }
  }

  # A power off from inside (job_boot.sh) terminates the instance. Never stop:
  # stopped instances keep billing for their volume.
  instance_initiated_shutdown_behavior = "terminate"

  iam_instance_profile {
    arn = aws_iam_instance_profile.job.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled" # job_boot.sh reads its job id from tags
  }

  # One-minute CPU and network metrics instead of five (the job dashboards in
  # infra/grafana). Billed per instance-hour while a job runs.
  monitoring {
    enabled = true
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.job_root_volume_gb
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name            = "${local.name}-job"
      Project         = "talon"
      Component       = "job"
      Environment     = var.environment
      Owner           = var.owner
      ManagedBy       = "talon-web"
      talon-bucket    = aws_s3_bucket.jobs.id
      talon-image     = "cpu"
      talon-log-group = aws_cloudwatch_log_group.jobs.name
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name      = "${local.name}-job"
      Project   = "talon"
      Component = "job"
    }
  }
}

# GPU job template: the same contract, role, security group and boot script
# as the CPU template, on the x86_64 PyTorch Deep Learning AMI. job_boot.sh
# reads the talon-image tag to know which image it is on.
data "aws_ssm_parameter" "gpu_job_ami" {
  name = var.gpu_job_ami_parameter
}

moved {
  from = aws_launch_template.job_gpu["gpu"]
  to   = aws_launch_template.job_gpu
}

resource "aws_launch_template" "job_gpu" {
  name                   = "${local.name}-job-gpu"
  description            = "Talon GPU job instance (PyTorch Deep Learning AMI, Ubuntu x86_64)"
  image_id               = data.aws_ssm_parameter.gpu_job_ami.value
  instance_type          = var.gpu_job_instance_types[0]
  vpc_security_group_ids = [aws_security_group.job.id]
  update_default_version = true

  user_data = base64encode(file("${path.module}/job_boot.sh"))

  instance_initiated_shutdown_behavior = "terminate"

  iam_instance_profile {
    arn = aws_iam_instance_profile.job.arn
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  # One-minute CPU and network metrics instead of five (the job dashboards in
  # infra/grafana). Billed per instance-hour while a job runs.
  monitoring {
    enabled = true
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type           = "gp3"
      volume_size           = var.gpu_job_root_volume_gb
      encrypted             = true
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name            = "${local.name}-job-gpu"
      Project         = "talon"
      Component       = "job"
      Environment     = var.environment
      Owner           = var.owner
      ManagedBy       = "talon-web"
      talon-bucket    = aws_s3_bucket.jobs.id
      talon-image     = "gpu"
      talon-log-group = aws_cloudwatch_log_group.jobs.name
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name      = "${local.name}-job-gpu"
      Project   = "talon"
      Component = "job"
    }
  }
}

# ---------------------------------------------------------------- settings for the web server

# The backend reads these at startup.
resource "aws_ssm_parameter" "jobs_bucket" {
  name  = "${local.secrets_prefix}/jobs-bucket"
  type  = "String"
  value = aws_s3_bucket.jobs.id
}

resource "aws_ssm_parameter" "jobs_launch_template" {
  name  = "${local.secrets_prefix}/jobs-launch-template-id"
  type  = "String"
  value = aws_launch_template.job.id
}

resource "aws_ssm_parameter" "jobs_subnets" {
  name  = "${local.secrets_prefix}/jobs-subnet-ids"
  type  = "String"
  value = join(",", local.job_subnet_ids)
}

moved {
  from = aws_ssm_parameter.jobs_gpu_launch_template["gpu"]
  to   = aws_ssm_parameter.jobs_gpu_launch_template
}

resource "aws_ssm_parameter" "jobs_gpu_launch_template" {
  name  = "${local.secrets_prefix}/jobs-gpu-launch-template-id"
  type  = "String"
  value = aws_launch_template.job_gpu.id
}

# ---------------------------------------------------------------- web server permissions

locals {
  ec2_arn = "arn:aws:ec2:${var.aws_region}:${local.account_id}"

  # The AMIs the job templates use (the only images the web server may launch).
  # insecure_value: AMI ids are public and readable in the plan.
  job_ami_ids = distinct([
    data.aws_ssm_parameter.ubuntu_ami.insecure_value,
    data.aws_ssm_parameter.gpu_job_ami.insecure_value,
  ])
  job_max_root_gb = max(var.job_max_volume_gb, var.job_root_volume_gb, var.gpu_job_root_volume_gb)

  # Each launch template with the only instance types it may be launched as.
  job_launch_rules = {
    cpu = { arn = aws_launch_template.job.arn, types = var.allowed_job_instance_types }
    gpu = { arn = aws_launch_template.job_gpu.arn, types = var.gpu_job_instance_types }
  }
}

data "aws_iam_policy_document" "web_launch_jobs" {
  # The instance itself: only a Talon launch template with one of its own
  # types, IMDSv2 required, and tagged as a Talon job.
  dynamic "statement" {
    for_each = local.job_launch_rules
    content {
      sid       = "LaunchJobInstances${replace(title(replace(statement.key, "-", " ")), " ", "")}"
      actions   = ["ec2:RunInstances"]
      resources = ["${local.ec2_arn}:instance/*"]
      condition {
        test     = "StringEquals"
        variable = "ec2:InstanceType"
        values   = statement.value.types
      }
      condition {
        test     = "StringEquals"
        variable = "ec2:MetadataHttpTokens"
        values   = ["required"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/Project"
        values   = ["talon"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:RequestTag/Component"
        values   = ["job"]
      }
      condition {
        test     = "ArnEquals"
        variable = "ec2:LaunchTemplate"
        values   = [statement.value.arn]
      }
    }
  }

  # Everything else a launch touches. RunInstances parameters override the
  # launch template, so each resource is pinned here too: only the templates'
  # own AMIs (no swapping in another image) and the job security group. User
  # data cannot be limited by IAM; the vCPU usage alarms (monitoring.tf) catch
  # launches the app did not make.
  statement {
    sid     = "LaunchJobInstanceParts"
    actions = ["ec2:RunInstances"]
    resources = concat(
      [
        "${local.ec2_arn}:network-interface/*",
        "${local.ec2_arn}:security-group/${aws_security_group.job.id}",
        "${local.ec2_arn}:launch-template/${aws_launch_template.job.id}",
        "${local.ec2_arn}:launch-template/${aws_launch_template.job_gpu.id}",
      ],
      [for id in local.job_ami_ids : "arn:aws:ec2:${var.aws_region}::image/${id}"],
      [for s in local.job_subnet_ids : "${local.ec2_arn}:subnet/${s}"],
    )
  }

  # Root volumes up to job_max_volume_gb (the templates' sizes are the
  # defaults; this caps what a request may ask for).
  statement {
    sid       = "LaunchJobVolumes"
    actions   = ["ec2:RunInstances"]
    resources = ["${local.ec2_arn}:volume/*"]
    condition {
      test     = "NumericLessThanEquals"
      variable = "ec2:VolumeSize"
      values   = [tostring(local.job_max_root_gb)]
    }
  }

  statement {
    sid       = "TagOnLaunchOnly"
    actions   = ["ec2:CreateTags"]
    resources = ["${local.ec2_arn}:instance/*", "${local.ec2_arn}:volume/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }

  statement {
    sid       = "TerminateJobInstancesOnly"
    actions   = ["ec2:TerminateInstances"]
    resources = ["${local.ec2_arn}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = ["talon"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Component"
      values   = ["job"]
    }
  }

  statement {
    sid       = "DescribeForReconciler"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"] # Describe calls do not support resource-level permissions
  }

  statement {
    sid       = "PassOnlyTheJobRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.job.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ec2.amazonaws.com"]
    }
  }

  statement {
    sid     = "WriteJobInputAndCancelMarkers"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.jobs.arn}/jobs/*/input/*",
      "${aws_s3_bucket.jobs.arn}/jobs/*/control/*",
    ]
  }

  statement {
    sid     = "ReadJobSettings"
    actions = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = concat(
      [
        aws_ssm_parameter.jobs_bucket.arn,
        aws_ssm_parameter.jobs_launch_template.arn,
        aws_ssm_parameter.jobs_subnets.arn,
        aws_ssm_parameter.jobs_gpu_launch_template.arn,
      ],
    )
  }

  statement {
    sid       = "ReadJobResults"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.jobs.arn}/jobs/*"]
  }

  statement {
    sid       = "ListJobs"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.jobs.arn]
  }
}

resource "aws_iam_role_policy" "web_launch_jobs" {
  name   = "${local.name}-launch-jobs"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.web_launch_jobs.json
}
