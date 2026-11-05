# RETIRED (web tier phase 2, 2026-11-05): the old box's nightly pg_dump files.
# The database is on RDS now, with its own automated backups and
# point-in-time restore (rds.tf); nothing writes here any more and no server
# can read it. The bucket, its key and its lifecycle rules stay so the
# existing dumps expire on schedule (daily after backup_daily_retention_days,
# monthly after backup_monthly_retention_days); remove this file after that.

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
  backup_bucket_name = "${local.name}-backups-${local.account_id}"
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
  bucket        = local.backup_bucket_name
  force_destroy = true # step 1 of removing this file: lets the next apply delete it with its dumps
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

output "backup_bucket" {
  value = aws_s3_bucket.backups.id
}
