variable "cluster_name" {
  type        = string
  description = "EKS cluster name."
}

variable "cluster_version" {
  type        = string
  description = "EKS control plane version."
  default     = "1.31"
}

variable "vpc_id" {
  type        = string
  description = "VPC ID for the cluster."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs used by the control plane and node groups."
}

variable "cluster_endpoint_public_access" {
  type        = bool
  description = "Whether to expose a public cluster endpoint."
  default     = true
}

variable "node_instance_types" {
  type        = list(string)
  description = "Instance types for the default node group."
  default     = ["t3.large"]
}

variable "node_group_min_size" {
  type        = number
  description = "Minimum nodes in the default node group."
  default     = 1
}

variable "node_group_max_size" {
  type        = number
  description = "Maximum nodes in the default node group."
  default     = 3
}

variable "node_group_desired_size" {
  type        = number
  description = "Desired nodes in the default node group."
  default     = 1
}

variable "node_capacity_type" {
  type        = string
  description = "ON_DEMAND or SPOT for the default node group."
  default     = "ON_DEMAND"
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
