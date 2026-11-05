# The alert topic every Talon alarm notifies (monitoring.tf). The old box's
# pg_dump backup alarms were removed with it (web tier phase 2): RDS keeps
# automated backups with point-in-time restore.

variable "alert_email" {
  description = "Email that receives Talon alerts (set in terraform.tfvars). Empty: topic is created with no subscriber."
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
