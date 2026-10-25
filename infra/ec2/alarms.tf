# Alerts for the backup system. The backup and restore-test scripts publish
# heartbeat metrics (namespace Talon/Backup); a missing heartbeat is an alarm,
# so a dead server, stopped timer, or failing dump is noticed without anyone
# having to look.

variable "alert_email" {
  description = "Email that receives backup alerts (set in terraform.tfvars). Empty: topic is created with no subscriber."
  type        = string
  default     = ""
}

resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

# The recipient must click the confirmation link AWS emails them.
resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# No successful nightly backup for 36 hours (six 6-hour windows in a row with
# no heartbeat; a missing datapoint counts as a failure).
resource "aws_cloudwatch_metric_alarm" "backup_missing" {
  alarm_name          = "${local.name}-backup-missing"
  alarm_description   = "No successful Talon database backup in 36 hours. Check: infra/scripts/backup.sh status, then journalctl -u talon-backup on the server."
  namespace           = "Talon/Backup"
  metric_name         = "BackupSuccess"
  statistic           = "Sum"
  period              = 21600
  evaluation_periods  = 6
  datapoints_to_alarm = 6
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# The weekly test restore reported a failure.
resource "aws_cloudwatch_metric_alarm" "restore_test_failed" {
  alarm_name          = "${local.name}-restore-test-failed"
  alarm_description   = "The weekly Talon test restore failed: the newest backup may be unusable. Check: infra/scripts/backup.sh restore-test."
  namespace           = "Talon/Backup"
  metric_name         = "RestoreTestFailure"
  statistic           = "Sum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

data "aws_iam_policy_document" "publish_metrics" {
  statement {
    sid       = "PublishBackupHeartbeats"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData does not support resource-level permissions
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["Talon/Backup"]
    }
  }
}

resource "aws_iam_role_policy" "publish_metrics" {
  name   = "${local.name}-publish-metrics"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.publish_metrics.json
}
