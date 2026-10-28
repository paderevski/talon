# Plumbing for EC2-launched jobs (see infra/CURRENT_STATUS.md, "Building
# EC2-launched jobs"). Nothing here runs a job by itself: it creates the bucket,
# network rules, job instance role, launch template and the web server's
# (tightly limited) permission to launch and terminate job instances.
#
# Contract with the web server: it writes jobs/<id>/input/ to the bucket, then
# runs the launch template with tags talon-job=<id> and talon-max-seconds=<n>
# (plus Project=talon, Component=job). The instance (job_boot.sh) writes
# status.json, logs/ and output/ back and powers itself off, which terminates it.

variable "jobs_retention_days" {
  description = "Days before job input, logs and output expire from S3. 30 to start; class projects may need longer."
  type        = number
  default     = 30
}

variable "ec2_jobs_enabled" {
  description = "Write EC2_JOBS_ENABLED into the web server's config at first boot. Changing it replaces the web instance (user_data), which resets the database."
  type        = bool
  default     = true
}

variable "job_instance_type" {
  description = "Default instance type in the job launch template (Graviton, matching the AMI; non-burstable, since t4g bills surplus CPU credits the job rate does not cover)."
  type        = string
  default     = "m7g.large"
}

variable "allowed_job_instance_types" {
  description = "Instance types the web server may launch. The vCPU quotas are far too high to act as a cap, so this is the cap."
  type        = list(string)
  default     = ["c7g.large", "c7g.xlarge", "m7g.large", "m7g.xlarge", "r7g.large"]
}

variable "job_root_volume_gb" {
  type    = number
  default = 30
}

variable "job_vpc_id" {
  description = "VPC for job instances. Empty: the default VPC."
  type        = string
  default     = ""
}

variable "job_subnet_ids" {
  description = "Subnets the web server may launch jobs into. Empty: the same default subnet as the web server. Must give instances a route to the internet (public IP or NAT)."
  type        = list(string)
  default     = []
}

variable "monthly_budget_usd" {
  description = "Account-wide monthly cost alert (emails alert_email at 80% and 100% of actual, and 100% forecast)."
  type        = number
  default     = 50
}

variable "daily_budget_usd" {
  description = "Account-wide daily cost alert (emails alert_email at 100% of actual). An alarm, not a cap: billing data lags by hours."
  type        = number
  default     = 10
}

locals {
  jobs_bucket_name = "${local.name}-jobs-${data.aws_caller_identity.current.account_id}"
  job_vpc_id       = var.job_vpc_id != "" ? var.job_vpc_id : data.aws_vpc.default.id
  job_subnet_ids   = length(var.job_subnet_ids) > 0 ? var.job_subnet_ids : [data.aws_subnet.this.id]
  account_id       = data.aws_caller_identity.current.account_id
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
  vpc_id      = local.job_vpc_id

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
# status. Student code does not get these credentials (metadata is blocked for
# its user). Per-job scoped credentials are the follow-up.
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

  statement {
    sid     = "WriteStatusLogsOutput"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.jobs.arn}/jobs/*/status.json",
      "${aws_s3_bucket.jobs.arn}/jobs/*/logs/*",
      "${aws_s3_bucket.jobs.arn}/jobs/*/output/*",
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
      Name         = "${local.name}-job"
      Project      = "talon"
      Component    = "job"
      Environment  = var.environment
      Owner        = var.owner
      ManagedBy    = "talon-web"
      talon-bucket = aws_s3_bucket.jobs.id
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

# ---------------------------------------------------------------- settings for the web server

# The backend reads these at startup, so moving jobs to another VPC is a
# change of variables here, not of backend configuration.
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

# ---------------------------------------------------------------- web server permissions

locals {
  ec2_arn = "arn:aws:ec2:${var.aws_region}:${local.account_id}"
}

data "aws_iam_policy_document" "web_launch_jobs" {
  # The instance itself: only the Talon launch template, an allowed type,
  # IMDSv2 required, and tagged as a Talon job.
  statement {
    sid       = "LaunchJobInstances"
    actions   = ["ec2:RunInstances"]
    resources = ["${local.ec2_arn}:instance/*"]
    condition {
      test     = "StringEquals"
      variable = "ec2:InstanceType"
      values   = var.allowed_job_instance_types
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
      values   = [aws_launch_template.job.arn]
    }
  }

  # Everything else a launch touches.
  statement {
    sid     = "LaunchJobInstanceParts"
    actions = ["ec2:RunInstances"]
    resources = concat(
      [
        "${local.ec2_arn}:volume/*",
        "${local.ec2_arn}:network-interface/*",
        "${local.ec2_arn}:security-group/${aws_security_group.job.id}",
        "${local.ec2_arn}:launch-template/${aws_launch_template.job.id}",
        "arn:aws:ec2:${var.aws_region}::image/*",
      ],
      [for s in local.job_subnet_ids : "${local.ec2_arn}:subnet/${s}"],
    )
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
    sid = "DescribeForReconciler"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeInstanceStatus",
      "ec2:DescribeInstanceTypes",
      "ec2:DescribeLaunchTemplates",
      "ec2:DescribeLaunchTemplateVersions",
      "ec2:DescribeSubnets",
    ]
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
    resources = [
      aws_ssm_parameter.jobs_bucket.arn,
      aws_ssm_parameter.jobs_launch_template.arn,
      aws_ssm_parameter.jobs_subnets.arn,
    ]
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

# ---------------------------------------------------------------- budgets

# Account-wide (the account is shared; cost allocation tags need the management
# account). These alert by email and do not stop anything.
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_budgets_budget" "daily" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-daily"
  budget_type  = "COST"
  limit_amount = tostring(var.daily_budget_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ---------------------------------------------------------------- outputs

output "jobs_bucket" {
  value = aws_s3_bucket.jobs.id
}

output "job_launch_template_id" {
  value = aws_launch_template.job.id
}

output "job_security_group_id" {
  value = aws_security_group.job.id
}

output "job_role_arn" {
  value = aws_iam_role.job.arn
}
