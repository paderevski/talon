terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Local state for now (single operator). Move to an S3 backend before
  # anyone else runs this stack.
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  # Refuse to touch any account other than the intended one.
  allowed_account_ids = [var.account_id]

  default_tags {
    tags = {
      Project     = "talon"
      Environment = var.environment
      Owner       = var.owner
      ManagedBy   = "terraform"
    }
  }
}
