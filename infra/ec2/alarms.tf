# Where alerts go: the SNS topic every Talon alarm notifies (monitoring.tf,
# alb.tf), and the account's cost budgets, which email alert_email directly.

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

variable "monthly_budget_usd" {
  description = "Account-wide monthly cost alert (emails alert_email at 80% and 100% of actual, and 100% forecast). Talon itself runs about $100 a month before jobs."
  type        = number
  default     = 150
}

variable "daily_budget_usd" {
  description = "Account-wide daily cost alert (emails alert_email at 100% of actual). An alarm, not a cap: billing data lags by hours."
  type        = number
  default     = 10
}


# ---------------------------------------------------------------- budgets

# Account-wide (the account is shared; cost allocation tags need the management
# account). These alert by email and do not stop anything.
resource "aws_budgets_budget" "monthly" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

resource "aws_budgets_budget" "daily" {
  count        = var.alert_email == "" ? 0 : 1
  name         = "${local.name}-daily"
  budget_type  = "COST"
  limit_amount = tostring(var.daily_budget_usd)
  limit_unit   = "USD"
  time_unit    = "DAILY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }
}
