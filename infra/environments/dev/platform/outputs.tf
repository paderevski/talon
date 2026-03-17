output "aws_region" {
  value       = var.aws_region
  description = "Region for platform deployment."
}

output "name_prefix" {
  value       = "${var.project}-${var.environment}"
  description = "Common resource name prefix."
}

output "platform_kms_key_arn" {
  value       = aws_kms_key.platform.arn
  description = "KMS key ARN for platform resources."
}

output "vpc_id" {
  value       = module.network.vpc_id
  description = "VPC ID."
}

output "private_subnet_ids" {
  value       = module.network.private_subnet_ids
  description = "Private subnet IDs."
}

output "eks_cluster_name" {
  value       = module.eks.cluster_name
  description = "EKS cluster name."
}

output "eks_oidc_provider_arn" {
  value       = module.eks.oidc_provider_arn
  description = "EKS OIDC provider ARN for IRSA."
}

output "eks_oidc_issuer_url" {
  value       = module.eks.cluster_oidc_issuer_url
  description = "EKS OIDC issuer URL for IRSA."
}

output "ecr_repository_urls" {
  value       = module.ecr.repository_urls
  description = "ECR repository URLs."
}

output "artifacts_bucket_name" {
  value       = module.artifacts.bucket_name
  description = "Artifacts S3 bucket name."
}

output "jobs_queue_url" {
  value       = module.jobs_queue.jobs_queue_url
  description = "Jobs queue URL."
}

output "jobs_queue_arn" {
  value       = module.jobs_queue.jobs_queue_arn
  description = "Jobs queue ARN."
}

output "db_endpoint" {
  value       = module.postgres.db_instance_endpoint
  description = "RDS endpoint."
}

output "db_port" {
  value       = module.postgres.db_instance_port
  description = "RDS port."
}

output "db_master_secret_arn" {
  value       = module.postgres.master_secret_arn
  description = "RDS master credential secret ARN."
}

output "resource_group_name" {
  value       = module.resource_group.resource_group_name
  description = "AWS Resource Group name for Talon project resources."
}
