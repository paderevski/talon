# Database backups: nightly pg_dump files in a private, versioned, KMS-encrypted
# S3 bucket. The instance can write and read dumps but cannot delete them; only
# the lifecycle rules below expire objects. The scripts that make the dumps live
# in the repo (infra/backup/) and read the bucket name from SSM, so they do not
# care whether Postgres is local, on another server, or RDS.

variable "backup_daily_retention_days" {
  description = "Days to keep nightly dumps (daily/ prefix)."
  type        = number
  default     = 35
}

variable "backup_monthly_retention_days" {
  description = "Days to keep the first dump of each month (monthly/ prefix)."
  type        = number
  default     = 365
}

locals {
  backup_bucket_name = "${local.name}-backups-${data.aws_caller_identity.current.account_id}"
}

resource "aws_kms_key" "backups" {
  description             = "Talon ${var.environment} database backups (S3)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "backups" {
  name          = "alias/${local.name}-backups"
  target_key_id = aws_kms_key.backups.key_id
}

resource "aws_s3_bucket" "backups" {
  bucket = local.backup_bucket_name
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.backups.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  # Versioning is on, so an expired object leaves older versions behind;
  # they are cleaned up a week later.
  rule {
    id     = "daily"
    status = "Enabled"
    filter {
      prefix = "daily/"
    }
    expiration {
      days = var.backup_daily_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "monthly"
    status = "Enabled"
    filter {
      prefix = "monthly/"
    }
    expiration {
      days = var.backup_monthly_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.backups]
}

data "aws_iam_policy_document" "backups_bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*"]
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

resource "aws_s3_bucket_policy" "backups" {
  bucket     = aws_s3_bucket.backups.id
  policy     = data.aws_iam_policy_document.backups_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.backups]
}

# The scripts find the bucket here, so nothing about it is baked into user_data.
resource "aws_ssm_parameter" "backup_bucket" {
  name  = "${local.secrets_prefix}/backup-bucket"
  type  = "String"
  value = aws_s3_bucket.backups.id
}

# Instance permissions: write and read dumps, never delete or change bucket config.
data "aws_iam_policy_document" "backup_access" {
  statement {
    sid       = "WriteAndReadDumps"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.backups.arn}/daily/*", "${aws_s3_bucket.backups.arn}/monthly/*"]
  }

  statement {
    sid       = "ListDumps"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.backups.arn]
  }

  statement {
    sid       = "UseBackupKeyViaS3Only"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.backups.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.aws_region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "ReadBackupBucketName"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.backup_bucket.arn]
  }
}

resource "aws_iam_role_policy" "backup_access" {
  name   = "${local.name}-backup-access"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.backup_access.json
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}
