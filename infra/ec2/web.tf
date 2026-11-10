# Talon's web servers (web tier plan, phase 3): an Auto Scaling group of
# var.web_server_count servers, one per zone in the private app subnets,
# behind an internal ALB (alb.tf). No public address; Postgres on RDS. People
# reach the ALB through infra/scripts/tunnel.sh (SSM port forward through a
# web server).
#
# Replacing a server never resets the data (it lives in RDS) and first boot
# does not seed: only infra/scripts/deploy.sh reseeds.

# The description still says "no inbound": changing it would replace the
# group. Its one inbound rule (port 80 from the ALB) is in alb.tf.
resource "aws_security_group" "web" {
  name        = "${local.name}-web"
  description = "Talon web servers - no inbound yet (SSM only), all outbound through NAT"
  vpc_id      = aws_vpc.main.id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${local.name}-web"
  }
}

locals {
  db_url_base = "postgres://%s@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${local.db_name}?sslmode=verify-full&sslrootcert=/etc/talon/rds-ca.pem"
}

resource "aws_launch_template" "web" {
  name                   = "${local.name}-web"
  description            = "Talon web server - Ubuntu 24.04 arm64, app on RDS"
  image_id               = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.instance_type
  vpc_security_group_ids = [aws_security_group.web.id]
  update_default_version = true

  iam_instance_profile {
    name = aws_iam_instance_profile.instance.name
  }

  user_data = base64encode(templatefile("${path.module}/web_user_data.sh.tftpl", {
    repo_url       = var.repo_url
    git_ref        = var.git_ref
    region         = var.aws_region
    secrets_prefix = local.secrets_prefix
    kms_alias      = aws_kms_alias.secrets.name

    database_url         = format(local.db_url_base, local.db_app_user)
    database_migrate_url = format(local.db_url_base, local.db_mig_user)
    db_master_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn
    cw_agent_param       = aws_ssm_parameter.cw_agent_config.name

    ec2_jobs_enabled   = var.ec2_jobs_enabled
    ec2_gpu_admin_only = var.ec2_gpu_admin_only
  }))

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      volume_type = "gp3"
      volume_size = var.root_volume_gb
      encrypted   = true
    }
  }

  # Instances the Auto Scaling group launches get only these tags, not the
  # provider's default_tags, so those are copied in (infra/scripts find web
  # servers by Project, Environment and Component).
  tag_specifications {
    resource_type = "instance"
    tags = merge(data.aws_default_tags.current.tags, {
      Name      = "${local.name}-web"
      Component = "web"
    })
  }

  tag_specifications {
    resource_type = "volume"
    tags = merge(data.aws_default_tags.current.tags, {
      Name      = "${local.name}-web"
      Component = "web"
    })
  }

  lifecycle {
    # A newer Ubuntu AMI should not create a new template version (and with
    # it a new server) on every apply.
    ignore_changes = [image_id]
  }
}

data "aws_default_tags" "current" {}

variable "web_server_count" {
  description = "Web servers in the Auto Scaling group (spread over web_availability_zones)."
  type        = number
  default     = 2
}

resource "aws_autoscaling_group" "web" {
  name                = "${local.name}-web"
  min_size            = var.web_server_count
  desired_capacity    = var.web_server_count
  max_size            = var.web_server_count + 1 # room to launch before terminating
  vpc_zone_identifier = [for s in aws_subnet.app : s.id]

  launch_template {
    id      = aws_launch_template.web.id
    version = aws_launch_template.web.latest_version
  }

  # The ALB's health check (GET /api/health/live: is the app up on this server)
  # decides when a server is replaced. First boot builds the app and takes
  # about 2 minutes; the grace period leaves room for a slow npm.
  target_group_arns         = [aws_lb_target_group.web.arn, aws_lb_target_group.public.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 600
  wait_for_capacity_timeout = "15m"

  # A new template version (user_data, type, disk) rolls through the servers
  # one at a time, starting a new one before stopping an old one.
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 100
      max_healthy_percentage = 150
      instance_warmup        = 300
      skip_matching          = true
    }
  }

  depends_on = [
    aws_iam_role_policy.app_secrets,
    aws_iam_role_policy.db_connect,
    aws_route_table_association.app, # first boot needs the NAT route
    aws_nat_gateway.main,
  ]
}
