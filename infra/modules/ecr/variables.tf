variable "name_prefix" {
  type        = string
  description = "Prefix used in resource names."
}

variable "repositories" {
  type        = list(string)
  description = "Container repository names to create under the prefix."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN for ECR encryption."
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
