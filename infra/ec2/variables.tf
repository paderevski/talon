variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile to deploy with."
  type        = string
  default     = "lcps"
}

variable "account_id" {
  description = "The only AWS account this stack may deploy into (set in terraform.tfvars)."
  type        = string
}

variable "environment" {
  type    = string
  default = "demo"
}

variable "owner" {
  description = "Owner tag value (set in terraform.tfvars)."
  type        = string
}

variable "availability_zone" {
  type    = string
  default = "us-east-1a"
}

variable "instance_type" {
  description = "Graviton (arm64) instance type."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  type    = number
  default = 20
}

variable "repo_url" {
  type    = string
  default = "https://github.com/paderevski/talon.git"
}

variable "git_ref" {
  description = "Branch the instance builds on first boot."
  type        = string
  default     = "main"
}
