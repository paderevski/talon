# Postgres on RDS. Private (data subnets, no route out), TLS required, IAM
# authentication for the app. Multi-AZ: a standby in the other zone takes
# over in about 1-2 minutes if the primary's zone fails, and patches go to
# the standby first, so maintenance is a short failover, not downtime.
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
  description = "db.t4g.small (2 GB): the micro (1 GB) ran critically low on memory during a failover restart (2026-11-05)."
  type        = string
  default     = "db.t4g.small"
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

variable "db_multi_az" {
  description = "Standby database in a second zone (about double the instance and storage cost)."
  type        = bool
  default     = true
}

variable "db_apply_immediately" {
  description = "Apply database changes now instead of in the Sunday maintenance window. Pass -var db_apply_immediately=true for one apply; leave false otherwise."
  type        = bool
  default     = false
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
    # What AWS records for it; with the default ("immediate") every plan
    # shows a change.
    apply_method = "pending-reboot"
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
  multi_az               = var.db_multi_az
  parameter_group_name   = aws_db_parameter_group.main.name

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "06:00-06:30"         # UTC: 1-1:30 am Eastern (EST)
  maintenance_window      = "sun:07:00-sun:08:00" # UTC: Sunday 2-3 am Eastern (EST)
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade = true
  apply_immediately          = var.db_apply_immediately

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

# Only while db_bootstrap = true. db-bootstrap.sh makes the master a member
# of talon_migrate (to create the database it owns), and talon_migrate is in
# rds_iam; RDS's pg_hba rule "+rds_iam" matches indirect members, so from then
# on the master's password is refused ("PAM authentication failed") and it
# signs in with an IAM token. The secret is only read on a brand-new database,
# before that first grant.
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
