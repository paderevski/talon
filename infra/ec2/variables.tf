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

# GitHub App (github.tf). Empty: that setting is not created.
variable "github_app_client_id" {
  description = "Client ID of the Talon GitHub App (not secret)"
  type        = string
  default     = ""
}

variable "github_app_slug" {
  description = "URL name of the Talon GitHub App (github.com/apps/<slug>)"
  type        = string
  default     = ""
}

variable "public_url" {
  description = "Where browsers reach Talon; the GitHub callback is <public_url>/api/github/callback"
  type        = string
  default     = "http://localhost:8080" # SSM tunnel (infra/scripts/tunnel.sh)
}
