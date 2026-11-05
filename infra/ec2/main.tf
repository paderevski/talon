locals {
  name = "talon-${var.environment}"
}

# The old single box (Postgres on the instance) in the default VPC. Kept
# only for the phase 2 cutover: it runs beside the new web server (web.tf)
# until that is checked, then legacy_web_server = false removes it, its
# Elastic IP and its security group. Tagged Component=web-legacy so the
# scripts leave it alone (TALON_INSTANCE=<id> still reaches it).
variable "legacy_web_server" {
  description = "Keep the old single box (default VPC, local Postgres). Set false after the phase 2 cutover."
  type        = bool
  default     = true
}

moved {
  from = aws_security_group.app
  to   = aws_security_group.app[0]
}

moved {
  from = aws_instance.app
  to   = aws_instance.app[0]
}

moved {
  from = aws_eip.app
  to   = aws_eip.app[0]
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnet" "this" {
  vpc_id            = data.aws_vpc.default.id
  availability_zone = var.availability_zone
  default_for_az    = true
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

# No ingress at all: access is only through SSM Session Manager
# (shell and port forwarding). Egress is needed for apt, npm, GitHub, and SSM.
resource "aws_security_group" "app" {
  count       = var.legacy_web_server ? 1 : 0
  name        = "${local.name}-app"
  description = "Talon app - no inbound, SSM only"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-app"
  }
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-instance"
  role = aws_iam_role.instance.name
}

resource "aws_instance" "app" {
  count                  = var.legacy_web_server ? 1 : 0
  ami                    = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnet.this.id
  vpc_security_group_ids = [aws_security_group.app[0].id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    repo_url       = var.repo_url
    git_ref        = var.git_ref
    region         = var.aws_region
    secrets_prefix = local.secrets_prefix
    kms_alias      = aws_kms_alias.secrets.name

    ec2_jobs_enabled   = var.ec2_jobs_enabled
    ec2_gpu_admin_only = var.ec2_gpu_admin_only
  })
  user_data_replace_on_change = true

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_gb
    encrypted   = true
  }

  tags = {
    Name = "${local.name}-app"
    # Not "web": infra/scripts deploy to Component=web servers only.
    Component = "web-legacy"
  }

  depends_on = [aws_iam_role_policy.app_secrets]

  lifecycle {
    # A newer Ubuntu AMI should not replace a running instance.
    ignore_changes = [ami]
  }
}

# Stable public IP reserved for the planned hostname (talon.lcps.org). Nothing listens
# publicly yet (no ingress rules).
resource "aws_eip" "app" {
  count    = var.legacy_web_server ? 1 : 0
  domain   = "vpc"
  instance = aws_instance.app[0].id

  tags = {
    Name = "${local.name}-app"
  }
}
