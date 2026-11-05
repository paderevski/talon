# Postgres on RDS (web tier plan, phase 2). Private (data subnets, no route
# out), TLS required, IAM authentication for the app.
#
# Credentials:
# - Master user: password generated and stored by RDS in Secrets Manager
#   (manage_master_user_password). Never in Terraform state or the repo.
#   Used only by infra/server/db-bootstrap.sh, and only while
#   db_bootstrap = true lets the web role read it.
# - talon_migrate (owns the database and schema: migrations, demo seed,
#   admin scripts) and talon_app (the running backend: rows only). Both sign
#   in with IAM tokens (rds-db:connect below); no password exists for them.
#
# First time: apply with db_bootstrap = true, run
# infra/scripts/db-bootstrap.sh, deploy, then apply with db_bootstrap = false.

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 50
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_bootstrap" {
  description = "Let the web server read the RDS master password (for infra/scripts/db-bootstrap.sh). Turn on only while bootstrapping or doing admin work, then back off."
  type        = bool
  default     = false
}

locals {
  db_name     = "talon"
  db_app_user = "talon_app"
  db_mig_user = "talon_migrate"
}

# ---------------------------------------------------------------- security groups

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Talon RDS - Postgres from the web servers only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-db"
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_web" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from web servers"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.web.id
}

# ---------------------------------------------------------------- instance

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = [for s in aws_subnet.data : s.id]

  tags = {
    Name = local.name
  }
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true # AWS-managed key (aws/rds)

  # No db_name: db-bootstrap.sh creates "talon" owned by talon_migrate.
  username                            = "talon_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = false
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "06:00-06:30"         # UTC: 1-1:30 am Eastern (EST)
  maintenance_window      = "sun:07:00-sun:08:00" # UTC: Sunday 2-3 am Eastern (EST)
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade = true
  apply_immediately          = false

  # Demo data: no final snapshot, no deletion protection. Revisit before real
  # students' data lives here.
  skip_final_snapshot = true
  deletion_protection = false

  tags = {
    Name = local.name
  }
}

# ---------------------------------------------------------------- IAM

locals {
  db_user_arn = "arn:aws:rds-db:${var.aws_region}:${local.account_id}:dbuser:${aws_db_instance.main.resource_id}"
}

# The web servers sign in as the two app roles. Job instances use another
# role and get nothing here; their security group cannot reach 5432 either.
data "aws_iam_policy_document" "db_connect" {
  statement {
    sid       = "ConnectAsTalonRoles"
    actions   = ["rds-db:connect"]
    resources = ["${local.db_user_arn}/${local.db_app_user}", "${local.db_user_arn}/${local.db_mig_user}"]
  }
}

resource "aws_iam_role_policy" "db_connect" {
  name   = "${local.name}-db-connect"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.db_connect.json
}

# Only while db_bootstrap = true. With IAM authentication on, RDS puts the
# master user in rds_iam (seen on 16.13: its password is refused, "PAM
# authentication failed"), so db-bootstrap.sh signs in as the master with an
# IAM token; the secret is the fallback if RDS ever stops doing that.
data "aws_iam_policy_document" "db_master_secret" {
  statement {
    sid       = "ConnectAsMasterWithIam"
    actions   = ["rds-db:connect"]
    resources = ["${local.db_user_arn}/${aws_db_instance.main.username}"]
  }

  statement {
    sid       = "ReadRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

resource "aws_iam_role_policy" "db_master_secret" {
  count  = var.db_bootstrap ? 1 : 0
  name   = "${local.name}-db-master-secret"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.db_master_secret.json
}
