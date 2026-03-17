variable "name_prefix" {
  type        = string
  description = "Prefix used in resource names."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for queue encryption."
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "Message visibility timeout in seconds."
  default     = 300
}

variable "message_retention_seconds" {
  type        = number
  description = "Retention period for messages in seconds."
  default     = 345600
}

variable "max_receive_count" {
  type        = number
  description = "How many receives before moving to DLQ."
  default     = 5
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
