locals {
  name_prefix = "${var.project}-${var.environment}"
  tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = var.owner
    CostCenter  = var.cost_center
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)
}

resource "aws_kms_key" "platform" {
  description             = "KMS key for Talon platform resources"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(local.tags, {
    Name = "${local.name_prefix}-platform-kms"
  })
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${local.name_prefix}-platform"
  target_key_id = aws_kms_key.platform.key_id
}

module "network" {
  source = "../../../modules/network"

  name_prefix          = local.name_prefix
  vpc_cidr             = var.vpc_cidr
  azs                  = local.azs
  public_subnet_cidrs  = var.public_subnet_cidrs
  private_subnet_cidrs = var.private_subnet_cidrs
  tags                 = local.tags
}

module "eks" {
  source = "../../../modules/eks"

  cluster_name                   = "${local.name_prefix}-eks"
  cluster_version                = var.eks_cluster_version
  vpc_id                         = module.network.vpc_id
  private_subnet_ids             = module.network.private_subnet_ids
  cluster_endpoint_public_access = var.eks_cluster_endpoint_public_access
  node_instance_types            = var.eks_node_instance_types
  node_group_min_size            = var.eks_node_group_min_size
  node_group_max_size            = var.eks_node_group_max_size
  node_group_desired_size        = var.eks_node_group_desired_size
  node_capacity_type             = var.eks_node_capacity_type
  tags                           = local.tags
}

module "ecr" {
  source = "../../../modules/ecr"

  name_prefix  = local.name_prefix
  repositories = var.ecr_repositories
  kms_key_arn  = aws_kms_key.platform.arn
  tags         = local.tags
}

module "artifacts" {
  source = "../../../modules/s3_artifacts"

  bucket_name = var.artifacts_bucket_name
  kms_key_arn = aws_kms_key.platform.arn
  tags        = local.tags
}

module "jobs_queue" {
  source = "../../../modules/sqs_jobs"

  name_prefix = local.name_prefix
  kms_key_arn = aws_kms_key.platform.arn
  tags        = local.tags
}

module "postgres" {
  source = "../../../modules/rds_postgres"

  name_prefix           = local.name_prefix
  vpc_id                = module.network.vpc_id
  vpc_cidr              = module.network.vpc_cidr
  private_subnet_ids    = module.network.private_subnet_ids
  kms_key_arn           = aws_kms_key.platform.arn
  database_name         = var.database_name
  master_username       = var.database_master_username
  instance_class        = var.database_instance_class
  allocated_storage     = var.database_allocated_storage
  max_allocated_storage = var.database_max_allocated_storage
  backup_retention_days = var.database_backup_retention_days
  deletion_protection   = var.database_deletion_protection
  skip_final_snapshot   = var.database_skip_final_snapshot
  multi_az              = var.database_multi_az
  tags                  = local.tags
}

module "observability" {
  source = "../../../modules/observability"

  name_prefix                      = local.name_prefix
  environment                      = var.environment
  kms_key_arn                      = ""
  jobs_queue_name                  = module.jobs_queue.jobs_queue_name
  jobs_queue_depth_alarm_threshold = var.jobs_queue_depth_alarm_threshold
  alarm_sns_topic_arns             = var.alarm_sns_topic_arns
  log_retention_days               = var.log_retention_days
  tags                             = local.tags
}

module "resource_group" {
  source = "../../../modules/resource_group"

  group_name            = "${local.name_prefix}-resources"
  project_tag_value     = var.project
  environment_tag_value = var.environment
  tags                  = local.tags
}
