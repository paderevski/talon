variable "aws_region" {
  type        = string
  description = "AWS region for bootstrap resources."
  default     = "us-east-1"
}

variable "project" {
  type        = string
  description = "Project tag/name root."
  default     = "talon"
}

variable "environment" {
  type        = string
  description = "Environment name."
  default     = "dev"
}

variable "owner" {
  type        = string
  description = "Owner tag value."
  default     = "talon-team"
}

variable "cost_center" {
  type        = string
  description = "Cost center tag value."
  default     = "engineering"
}

variable "state_bucket_name" {
  type        = string
  description = "Globally unique S3 bucket name for Terraform remote state."
}

variable "lock_table_name" {
  type        = string
  description = "DynamoDB table name for Terraform state locking."
  default     = "talon-dev-terraform-locks"
}
