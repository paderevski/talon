variable "aws_region" {
  type        = string
  description = "AWS region for app resources."
  default     = "us-east-1"
}

variable "project" {
  type        = string
  description = "Project name used in tags and names."
  default     = "talon"
}

variable "environment" {
  type        = string
  description = "Environment label."
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

variable "platform_state_bucket" {
  type        = string
  description = "S3 bucket that stores platform Terraform state."
}

variable "platform_state_key" {
  type        = string
  description = "S3 key path to the platform Terraform state file."
  default     = "talon/dev/platform/terraform.tfstate"
}

variable "kubernetes_namespace" {
  type        = string
  description = "Namespace where Talon workloads run."
  default     = "talon"
}

variable "dispatcher_service_account_name" {
  type        = string
  description = "Service account name used by the queue dispatcher."
  default     = "talon-dispatcher"
}

variable "runner_service_account_name" {
  type        = string
  description = "Service account name used by job runner pods."
  default     = "talon-runner"
}
