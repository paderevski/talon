variable "name_prefix" {
  type        = string
  description = "Prefix used in resource names."
}

variable "vpc_id" {
  type        = string
  description = "VPC ID where RDS is deployed."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block of the VPC for DB ingress."
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the DB subnet group."
}

variable "kms_key_arn" {
  type        = string
  description = "KMS key ARN used for RDS encryption."
}

variable "database_name" {
  type        = string
  description = "Initial database name."
  default     = "talondb"
}

variable "master_username" {
  type        = string
  description = "Master database username."
  default     = "talonadmin"
}

variable "instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.medium"
}

variable "engine_version" {
  type        = string
  description = "PostgreSQL engine version."
  default     = "16.4"
}

variable "allocated_storage" {
  type        = number
  description = "Initial storage allocation (GiB)."
  default     = 20
}

variable "max_allocated_storage" {
  type        = number
  description = "Autoscaling storage cap (GiB)."
  default     = 100
}

variable "backup_retention_days" {
  type        = number
  description = "Automated backup retention in days."
  default     = 7
}

variable "deletion_protection" {
  type        = bool
  description = "Enable deletion protection for the DB."
  default     = true
}

variable "skip_final_snapshot" {
  type        = bool
  description = "Skip final snapshot on destroy."
  default     = false
}

variable "multi_az" {
  type        = bool
  description = "Enable Multi-AZ standby."
  default     = false
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
