variable "aws_region" {
  type        = string
  description = "AWS region for platform resources."
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

variable "az_count" {
  type        = number
  description = "Number of AZs to use."
  default     = 2
}

variable "vpc_cidr" {
  type        = string
  description = "VPC CIDR block."
  default     = "10.40.0.0/16"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "Public subnet CIDRs for selected AZs."
  default     = ["10.40.0.0/20", "10.40.16.0/20"]
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "Private subnet CIDRs for selected AZs."
  default     = ["10.40.128.0/20", "10.40.144.0/20"]
}

variable "eks_cluster_version" {
  type        = string
  description = "EKS version."
  default     = "1.31"
}

variable "eks_cluster_endpoint_public_access" {
  type        = bool
  description = "Expose EKS API endpoint publicly."
  default     = true
}

variable "eks_node_instance_types" {
  type        = list(string)
  description = "Node group EC2 instance types."
  default     = ["t3.large"]
}

variable "eks_node_group_min_size" {
  type        = number
  description = "Minimum default node group size."
  default     = 1
}

variable "eks_node_group_max_size" {
  type        = number
  description = "Maximum default node group size."
  default     = 3
}

variable "eks_node_group_desired_size" {
  type        = number
  description = "Desired default node group size."
  default     = 1
}

variable "eks_node_capacity_type" {
  type        = string
  description = "Node capacity type: ON_DEMAND or SPOT."
  default     = "ON_DEMAND"
}

variable "ecr_repositories" {
  type        = list(string)
  description = "Container images to create in ECR."
  default     = ["api", "runner", "dispatcher"]
}

variable "artifacts_bucket_name" {
  type        = string
  description = "Globally unique S3 bucket name for artifacts."
}

variable "database_name" {
  type        = string
  description = "Initial Postgres database name."
  default     = "talondb"
}

variable "database_master_username" {
  type        = string
  description = "RDS master username."
  default     = "talonadmin"
}

variable "database_instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.medium"
}

variable "database_allocated_storage" {
  type        = number
  description = "Initial RDS storage allocation."
  default     = 20
}

variable "database_max_allocated_storage" {
  type        = number
  description = "Max autoscaled RDS storage."
  default     = 100
}

variable "database_backup_retention_days" {
  type        = number
  description = "RDS backup retention period."
  default     = 7
}

variable "database_deletion_protection" {
  type        = bool
  description = "RDS deletion protection."
  default     = true
}

variable "database_skip_final_snapshot" {
  type        = bool
  description = "Skip final snapshot when destroying DB."
  default     = false
}

variable "database_multi_az" {
  type        = bool
  description = "Enable Multi-AZ for RDS."
  default     = false
}

variable "jobs_queue_depth_alarm_threshold" {
  type        = number
  description = "Alarm threshold for visible jobs queue messages."
  default     = 50
}

variable "alarm_sns_topic_arns" {
  type        = list(string)
  description = "SNS topics for alarm notifications."
  default     = []
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention in days."
  default     = 30
}
