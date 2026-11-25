# Evidence for investigations (security review M9, tier 1 and job flow logs,
# 2026-11-24): who did what in AWS (CloudTrail), what was run on the web
# servers (SSM), and where job instances connected (VPC flow logs).

variable "ssm_log_retention_days" {
  description = "Days to keep SSM session transcripts and Run Command output (deploys, scripts) in CloudWatch Logs."
  type        = number
  default     = 365
}

variable "flow_log_retention_days" {
  description = "Days to keep the job subnets' VPC flow logs in S3."
  type        = number
  default     = 365
}

variable "cloudtrail_noncurrent_days" {
  description = "Days to keep overwritten or deleted CloudTrail log files (versioning) before they expire."
  type        = number
  default     = 365
}

# ---------------------------------------------------------------- CloudTrail

# The account's trail was made in the console before Terraform managed this
# account; adopted here unchanged except for log file validation (signed
# digest files, so altered or deleted log files can be detected with
# `aws cloudtrail validate-logs`). Its bucket keeps the console's name and
# policy; Terraform manages only its versioning and the expiry of old
# versions.
locals {
  cloudtrail_bucket = "aws-cloudtrail-logs-${local.account_id}-c4fd4cb5"
}

import {
  to = aws_cloudtrail.management
  id = "arn:aws:cloudtrail:${var.aws_region}:${local.account_id}:trail/management-events"
}

resource "aws_cloudtrail" "management" {
  name                          = "management-events"
  s3_bucket_name                = local.cloudtrail_bucket
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "Management events selector"
    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = local.cloudtrail_bucket
  versioning_configuration {
    status = "Enabled"
  }
}

# Current log files are kept indefinitely (as before; tens of MB). A file
# that is overwritten or deleted stays recoverable this long.
resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = local.cloudtrail_bucket

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.cloudtrail_noncurrent_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.cloudtrail]
}

# ---------------------------------------------------------------- SSM

# Session Manager shell sessions (transcripts) and Run Command output
# (deploy.sh, status.sh through infra/scripts/common.sh) go here, written by
# the SSM agent on the web servers with their instance role. Port-forwarding
# sessions (tunnel.sh, rds-tunnel.sh) carry no transcript; their start and
# end are in CloudTrail (StartSession, TerminateSession).
resource "aws_cloudwatch_log_group" "ssm" {
  name              = "/talon/${var.environment}/ssm"
  retention_in_days = var.ssm_log_retention_days
}

# Session Manager preferences for the account and region (this document name
# is the one Session Manager reads). The account holds only Talon.
resource "aws_ssm_document" "session_preferences" {
  name            = "SSM-SessionManagerRunShell"
  document_type   = "Session"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "1.0"
    description   = "Session Manager preferences: transcripts to CloudWatch Logs"
    sessionType   = "Standard_Stream"
    inputs = {
      cloudWatchLogGroupName      = aws_cloudwatch_log_group.ssm.name
      cloudWatchEncryptionEnabled = false # the group uses CloudWatch's default encryption, not a KMS key
      cloudWatchStreamingEnabled  = true
      s3BucketName                = ""
      s3EncryptionEnabled         = false
      idleSessionTimeout          = "20"
      runAsEnabled                = false
      runAsDefaultUser            = ""
      shellProfile                = { linux = "", windows = "" }
    }
  })
}

# ---------------------------------------------------------------- job flow logs

# Every connection to or from the job subnets (student code): accepted and
# rejected, with the instance id, so a job can be matched to its traffic.
# S3 rather than CloudWatch Logs: cheaper per GB, read with Athena when needed.
resource "aws_s3_bucket" "flow_logs" {
  bucket = "${local.name}-flow-logs-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "flow_logs" {
  bucket                  = aws_s3_bucket.flow_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}
    expiration {
      days = var.flow_log_retention_days
    }
  }
}

# Delivery by the log service for this account's flow logs only.
data "aws_iam_policy_document" "flow_logs_bucket" {
  statement {
    sid       = "AWSLogDeliveryWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.flow_logs.arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${var.aws_region}:${local.account_id}:*"]
    }
  }

  statement {
    sid       = "AWSLogDeliveryAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.flow_logs.arn]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:logs:${var.aws_region}:${local.account_id}:*"]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.flow_logs.arn,
      "${aws_s3_bucket.flow_logs.arn}/*",
    ]
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

resource "aws_s3_bucket_policy" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.flow_logs]
}

resource "aws_flow_log" "jobs" {
  for_each             = aws_subnet.jobs
  subnet_id            = each.value.id
  traffic_type         = "ALL"
  log_destination_type = "s3"
  log_destination      = aws_s3_bucket.flow_logs.arn
  # The default fields plus the instance id, the packet's real destination
  # and the direction.
  log_format = "$${version} $${account-id} $${interface-id} $${srcaddr} $${dstaddr} $${srcport} $${dstport} $${protocol} $${packets} $${bytes} $${start} $${end} $${action} $${log-status} $${instance-id} $${pkt-dstaddr} $${flow-direction}"

  destination_options {
    file_format        = "plain-text"
    per_hour_partition = true
  }

  tags = {
    Name = "${local.name}-jobs-${substr(each.key, -2, 2)}"
  }

  depends_on = [aws_s3_bucket_policy.flow_logs]
}
