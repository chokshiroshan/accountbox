# Accountbox Infrastructure (AWS)
#
# NOTE on Terraform state:
# - This stack expects the remote state bucket + DynamoDB lock table to already exist.
# - Bootstrap them once via ./bootstrap (see bootstrap/README.md).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  backend "s3" {
    bucket         = "accountbox-terraform-state"
    key            = "accountbox/infrastructure/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "accountbox-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "Accountbox"
      ManagedBy   = "Terraform"
      Environment = var.environment
    }
  }
}

# --- Networking (optional but handy for future managed services) ---
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "accountbox-${var.environment}"
  cidr = var.vpc_cidr

  azs             = var.availability_zones
  private_subnets = var.private_subnet_cidrs
  public_subnets  = var.public_subnet_cidrs

  enable_nat_gateway   = var.environment == "production"
  single_nat_gateway   = var.environment == "production"
  enable_vpn_gateway   = false
  enable_dns_hostnames = true
  enable_dns_support   = true
}

# --- Container registry (Codex image / future app images) ---
resource "aws_ecr_repository" "accountbox_codex" {
  name                 = "accountbox-codex-${var.environment}"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "accountbox_codex" {
  repository = aws_ecr_repository.accountbox_codex.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep last 10 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = { type = "expire" }
      }
    ]
  })
}

# --- Alerts ---
resource "aws_sns_topic" "alerts" {
  name = "accountbox-alerts-${var.environment}"
}

resource "aws_cloudwatch_metric_alarm" "ecr_scan_findings" {
  count = var.enable_monitoring ? 1 : 0

  alarm_name          = "accountbox-ecr-scan-findings-${var.environment}"
  alarm_description   = "Alert when ECR scan finds vulnerabilities"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0

  metric_name = "ImageScanFindingsSeverity"
  namespace   = "AWS/ECR"
  period      = 86400
  statistic   = "Maximum"

  dimensions = {
    RepositoryName = aws_ecr_repository.accountbox_codex.name
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
}

# --- Release notifier Lambda (optional; mostly a template) ---
resource "aws_iam_role" "lambda_role" {
  name = "accountbox-release-notifier-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "archive_file" "release_notifier_zip" {
  type        = "zip"
  source_file = "${path.module}/lambda/index.js"
  output_path = "${path.module}/lambda/release-notifier.zip"
}

resource "aws_lambda_function" "release_notifier" {
  function_name = "accountbox-release-notifier-${var.environment}"
  role          = aws_iam_role.lambda_role.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  filename         = data.archive_file.release_notifier_zip.output_path
  source_code_hash = data.archive_file.release_notifier_zip.output_base64sha256

  environment {
    variables = {
      SLACK_WEBHOOK_URL = var.slack_webhook_url
    }
  }
}

# Data sources
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
