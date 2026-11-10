# Custom CPU job image (EC2 Image Builder). Plan: docs/talon-cpu-image-plan.md
# (local only).
#
# The CPU launch template can boot from this image instead of stock Ubuntu
# (var.cpu_job_image in jobs.tf). The image only pre-installs what
# job_boot.sh installs on every job otherwise (AWS CLI, venv, pip); the boot
# script keeps its "install if missing" guards, so it still runs on stock
# Ubuntu and a bad image is rolled back by setting cpu_job_image = "stock".
#
# Order of events on a first setup: apply this file (nothing uses the image
# yet), start the pipeline once (aws imagebuilder start-image-pipeline-execution),
# wait for the build and its tests (about 20 to 30 minutes), then set
# cpu_job_image = "baked" and apply. The pipeline then rebuilds monthly; the
# launch template follows only on terraform apply. There is no lifecycle
# policy on purpose: deleting images on a schedule could remove the one the
# template still points at. Delete old images by hand.

variable "cpu_image_version" {
  description = "Version of the CPU image's component and recipe (semantic, three numbers). Both are immutable in Image Builder: bump this whenever the component text below changes."
  type        = string
  default     = "1.0.0"
}

variable "cpu_image_root_gb" {
  description = "Root volume of the CPU image. job_root_volume_gb must be at least this."
  type        = number
  default     = 12
}

variable "cpu_image_build_instance_type" {
  description = "Instance type that builds and tests the CPU image (Graviton, like the jobs)."
  type        = string
  default     = "m7g.large"
}

variable "cpu_image_schedule" {
  description = "When the pipeline rebuilds the CPU image (UTC cron)."
  type        = string
  default     = "cron(0 6 1 * ? *)"
}

locals {
  cpu_image_param = "/talon-images/${var.environment}/cpu-job"
}

# ---------------------------------------------------------------- component

# Build: what job_boot.sh would install, plus the same apt rewrite it does
# (HTTPS and IPv4 only, so the build security group needs 443 only), plus a
# full upgrade so each monthly rebuild patches the base. Test: the tools work
# and the image carries no student user. Runs as root.
resource "aws_imagebuilder_component" "cpu_job" {
  name                  = "${local.name}-cpu-job"
  version               = var.cpu_image_version
  platform              = "Linux"
  supported_os_versions = ["Ubuntu 24"]
  description           = "Talon CPU job image: AWS CLI, Python venv and pip"
  change_description    = "Version ${var.cpu_image_version}"

  data = <<-YAML
    name: talon-cpu-job
    description: Tools job_boot.sh needs on a CPU job instance
    schemaVersion: 1.0
    phases:
      - name: build
        steps:
          - name: Apt
            action: ExecuteBash
            inputs:
              commands:
                - set -e
                - sed -E -i 's#https?://([a-z0-9-]+\.ec2\.)?#https://#g' /etc/apt/sources.list.d/ubuntu.sources
                - echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99talon-ipv4
                - export DEBIAN_FRONTEND=noninteractive
                - apt-get update -qq
                - apt-get upgrade -y -qq
                - apt-get install -y -qq iptables python3-venv python3-pip
          - name: AwsCli
            action: ExecuteBash
            inputs:
              commands:
                - set -e
                - snap install aws-cli --classic
                - snap refresh --hold aws-cli
          - name: Release
            action: ExecuteBash
            inputs:
              commands:
                - set -e
                - echo "cpu-${var.cpu_image_version}-$(date -u +%Y%m%d)" > /etc/talon-image-release
          - name: Clean
            action: ExecuteBash
            inputs:
              commands:
                - apt-get clean
                - rm -rf /var/lib/apt/lists/*
      - name: test
        steps:
          - name: Tools
            action: ExecuteBash
            inputs:
              commands:
                - set -e
                - aws --version
                - python3 -c 'import ensurepip, venv'
                - dpkg -s python3-venv python3-pip iptables > /dev/null
                - iptables -V
                - test -s /etc/talon-image-release
                - cat /etc/talon-image-release
          - name: NoStudent
            action: ExecuteBash
            inputs:
              commands:
                - test ! -e /home/student
  YAML

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------- recipe

resource "aws_imagebuilder_image_recipe" "cpu_job" {
  name              = "${local.name}-cpu-job"
  version           = var.cpu_image_version
  description       = "Talon CPU job image on Ubuntu 24.04 arm64"
  working_directory = "/tmp"

  # The SSM parameter itself, resolved by Image Builder at each build, so a
  # new Canonical release does not change (and so replace) the recipe.
  parent_image = "ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"

  block_device_mapping {
    device_name = "/dev/sda1" # the launch template's root device
    ebs {
      delete_on_termination = true
      volume_size           = var.cpu_image_root_gb
      volume_type           = "gp3"
    }
  }

  component {
    component_arn = aws_imagebuilder_component.cpu_job.arn
  }

  tags = {
    Component = "image"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------- build instance

resource "aws_iam_role" "image_build" {
  name               = "${local.name}-image-build"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "image_build_ssm" {
  role       = aws_iam_role.image_build.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "image_build_builder" {
  role       = aws_iam_role.image_build.name
  policy_arn = "arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder"
}

resource "aws_iam_instance_profile" "image_build" {
  name = "${local.name}-image-build"
  role = aws_iam_role.image_build.name
}

# No inbound. HTTPS out (apt, the snap store, SSM, Image Builder) and DNS to
# the VPC resolver. The build instance sits in an app subnet (NAT egress).
resource "aws_security_group" "image_build" {
  name        = "${local.name}-image-build"
  description = "Talon image build instances - no inbound, HTTPS and DNS out"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-image-build"
  }
}

resource "aws_vpc_security_group_egress_rule" "image_build_https" {
  security_group_id = aws_security_group.image_build.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "image_build_dns_udp" {
  security_group_id = aws_security_group.image_build.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_vpc_security_group_egress_rule" "image_build_dns_tcp" {
  security_group_id = aws_security_group.image_build.id
  description       = "DNS to the VPC resolver"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = var.vpc_cidr
}

resource "aws_imagebuilder_infrastructure_configuration" "cpu_job" {
  name                          = "${local.name}-cpu-job"
  description                   = "Build and test instances for the Talon CPU job image"
  instance_profile_name         = aws_iam_instance_profile.image_build.name
  instance_types                = [var.cpu_image_build_instance_type]
  security_group_ids            = [aws_security_group.image_build.id]
  subnet_id                     = values(aws_subnet.app)[0].id
  terminate_instance_on_failure = true

  instance_metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  tags = {
    Component = "image"
  }
}

# ---------------------------------------------------------------- distribution

# One private AMI in this region and account. Its id is written to an SSM
# parameter outside /talon/<env>/ (the app secrets prefix), where
# data.aws_ssm_parameter.cpu_job_baked_ami in jobs.tf reads it.
resource "aws_imagebuilder_distribution_configuration" "cpu_job" {
  name        = "${local.name}-cpu-job"
  description = "Talon CPU job image: private AMI and SSM parameter"

  distribution {
    region = var.aws_region

    ami_distribution_configuration {
      name        = "${local.name}-cpu-job-{{ imagebuilder:buildDate }}"
      description = "Talon CPU job image"
      ami_tags = {
        Project     = "talon"
        Environment = var.environment
        Component   = "image"
      }
    }

    ssm_parameter_configuration {
      parameter_name = local.cpu_image_param
      data_type      = "aws:ec2:image"
    }
  }

  tags = {
    Component = "image"
  }
}

# ---------------------------------------------------------------- pipeline

resource "aws_imagebuilder_image_pipeline" "cpu_job" {
  name                             = "${local.name}-cpu-job"
  description                      = "Monthly rebuild of the Talon CPU job image"
  image_recipe_arn                 = aws_imagebuilder_image_recipe.cpu_job.arn
  infrastructure_configuration_arn = aws_imagebuilder_infrastructure_configuration.cpu_job.arn
  distribution_configuration_arn   = aws_imagebuilder_distribution_configuration.cpu_job.arn
  status                           = "ENABLED"

  image_tests_configuration {
    image_tests_enabled = true
    timeout_minutes     = 60
  }

  schedule {
    schedule_expression = var.cpu_image_schedule
    # The default (EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE) can skip
    # a scheduled run.
    pipeline_execution_start_condition = "EXPRESSION_MATCH_ONLY"
  }

  tags = {
    Component = "image"
  }
}

output "cpu_image_pipeline_arn" {
  description = "Start a build: aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <this>"
  value       = aws_imagebuilder_image_pipeline.cpu_job.arn
}
