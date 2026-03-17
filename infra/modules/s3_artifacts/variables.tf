variable "bucket_name" {
  type        = string
  description = "Globally unique bucket name for Talon artifacts."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for bucket encryption."
}

variable "transition_to_ia_days" {
  type        = number
  description = "Days before transitioning objects to STANDARD_IA."
  default     = 30
}

variable "transition_to_glacier_days" {
  type        = number
  description = "Days before transitioning objects to GLACIER."
  default     = 90
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
