resource "aws_cloudwatch_log_group" "api" {
  name              = "/talon/${var.environment}/api"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn == "" ? null : var.kms_key_arn

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/talon/${var.environment}/jobs"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_arn == "" ? null : var.kms_key_arn

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sqs_visible_messages_high" {
  alarm_name          = "${var.name_prefix}-sqs-visible-messages-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Average"
  threshold           = var.jobs_queue_depth_alarm_threshold
  alarm_description   = "Jobs queue depth is above expected range"

  dimensions = {
    QueueName = var.jobs_queue_name
  }

  alarm_actions = var.alarm_sns_topic_arns
  ok_actions    = var.alarm_sns_topic_arns

  tags = var.tags
}
