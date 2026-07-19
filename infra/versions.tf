terraform {
  required_version = ">= 1.10"

  # Remote state in S3 with native S3 locking (no DynamoDB needed on TF >= 1.10).
  backend "s3" {
    bucket       = "wcp-tf-state-030635937586"
    key          = "infra/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
  default_tags {
    tags = {
      Project   = "wcp"
      ManagedBy = "terraform"
    }
  }
}
