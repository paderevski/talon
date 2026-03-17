variable "name_prefix" {
  type        = string
  description = "Prefix used in resource names."
}

variable "environment" {
  type        = string
  description = "Environment label (dev/staging/prod)."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for log group encryption."
}

variable "jobs_queue_name" {
  type        = string
  description = "Name of the jobs SQS queue for queue depth alarms."
}

variable "jobs_queue_depth_alarm_threshold" {
  type        = number
  description = "Threshold for visible SQS messages alarm."
  default     = 50
}

variable "alarm_sns_topic_arns" {
  type        = list(string)
  description = "SNS topic ARNs to notify for alarms."
  default     = []
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention in days."
  default     = 30
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
