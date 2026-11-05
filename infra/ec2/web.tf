# The web server in Talon's VPC (web tier plan, phase 2): private app subnet,
# no public address, Postgres on RDS. Phase 3 replaces the single instance
# with an Auto Scaling group built from the same launch template.
#
# Replacing this instance no longer resets the data (it lives in RDS) and
# first boot does not seed: only infra/scripts/deploy.sh reseeds.

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

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name      = "${local.name}-web"
      Component = "web" # infra/scripts find web servers by this tag
    }
  }

  tag_specifications {
    resource_type = "volume"
    tags = {
      Name      = "${local.name}-web"
      Component = "web"
    }
  }

  lifecycle {
    # A newer Ubuntu AMI should not create a new template version (and with
    # it a new server) on every apply.
    ignore_changes = [image_id]
  }
}

resource "aws_instance" "web" {
  subnet_id = aws_subnet.app[var.web_availability_zones[0]].id

  # A new template version (user_data, type, disk) replaces the server.
  launch_template {
    id      = aws_launch_template.web.id
    version = aws_launch_template.web.latest_version
  }

  tags = {
    Name      = "${local.name}-web"
    Component = "web"
  }

  depends_on = [
    aws_iam_role_policy.app_secrets,
    aws_iam_role_policy.db_connect,
    aws_route_table_association.app, # first boot needs the NAT route
    aws_nat_gateway.main,
  ]

  lifecycle {
    # User data comes from the launch template. The provider records it on the
    # instance after launch and would then plan to clear it, which it does by
    # stopping and starting the server. A template change still replaces the
    # server through latest_version above.
    ignore_changes = [user_data, user_data_base64]
  }
}
