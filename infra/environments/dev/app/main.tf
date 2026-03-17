data "terraform_remote_state" "platform" {
  backend = "s3"

  config = {
    bucket = var.platform_state_bucket
    key    = var.platform_state_key
    region = var.aws_region
  }
}

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

resource "kubernetes_namespace" "talon" {
  metadata {
    name = var.kubernetes_namespace
    labels = {
      app = "talon"
    }
  }
}

resource "aws_iam_policy" "dispatcher" {
  name = "${local.name_prefix}-dispatcher-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:ChangeMessageVisibility",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl"
        ]
        Resource = data.terraform_remote_state.platform.outputs.jobs_queue_arn
      }
    ]
  })

  tags = local.tags
}

resource "aws_iam_policy" "runner" {
  name = "${local.name_prefix}-runner-policy"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "arn:aws:s3:::${data.terraform_remote_state.platform.outputs.artifacts_bucket_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket"
        ]
        Resource = "arn:aws:s3:::${data.terraform_remote_state.platform.outputs.artifacts_bucket_name}"
      }
    ]
  })

  tags = local.tags
}

module "dispatcher_irsa" {
  source = "../../../modules/irsa_role"

  role_name            = "${local.name_prefix}-dispatcher-irsa"
  namespace            = var.kubernetes_namespace
  service_account_name = var.dispatcher_service_account_name
  oidc_provider_arn    = data.terraform_remote_state.platform.outputs.eks_oidc_provider_arn
  oidc_provider_url    = data.terraform_remote_state.platform.outputs.eks_oidc_issuer_url
  managed_policy_arns  = [aws_iam_policy.dispatcher.arn]
  tags                 = local.tags
}

module "runner_irsa" {
  source = "../../../modules/irsa_role"

  role_name            = "${local.name_prefix}-runner-irsa"
  namespace            = var.kubernetes_namespace
  service_account_name = var.runner_service_account_name
  oidc_provider_arn    = data.terraform_remote_state.platform.outputs.eks_oidc_provider_arn
  oidc_provider_url    = data.terraform_remote_state.platform.outputs.eks_oidc_issuer_url
  managed_policy_arns  = [aws_iam_policy.runner.arn]
  tags                 = local.tags
}

resource "kubernetes_service_account" "dispatcher" {
  metadata {
    name      = var.dispatcher_service_account_name
    namespace = kubernetes_namespace.talon.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = module.dispatcher_irsa.role_arn
    }
    labels = {
      app = "talon-dispatcher"
    }
  }
}

resource "kubernetes_service_account" "runner" {
  metadata {
    name      = var.runner_service_account_name
    namespace = kubernetes_namespace.talon.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = module.runner_irsa.role_arn
    }
    labels = {
      app = "talon-runner"
    }
  }
}
