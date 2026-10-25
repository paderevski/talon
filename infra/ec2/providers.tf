terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State lives in the S3 bucket made by infra/state (versioned, encrypted,
  # native locking). The bucket name contains the account id, so it comes from
  # backend.hcl (gitignored; copy backend.hcl.example):
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    key          = "ec2/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
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
