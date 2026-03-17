variable "role_name" {
  type        = string
  description = "IAM role name."
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace for the service account."
}

variable "service_account_name" {
  type        = string
  description = "Kubernetes service account name."
}

variable "oidc_provider_arn" {
  type        = string
  description = "EKS OIDC provider ARN."
}

variable "oidc_provider_url" {
  type        = string
  description = "EKS OIDC provider URL."
}

variable "managed_policy_arns" {
  type        = list(string)
  description = "Managed policy ARNs to attach to the role."
  default     = []
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
