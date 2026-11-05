# Talon's own VPC. Four tiers:
#   public  (1a, 1b)       a NAT gateway in each (and an internet-facing ALB when Talon goes public)
#   app     (1a, 1b)       web servers and the internal ALB; out via NAT
#   data    (1a, 1b)       RDS; no route to the internet at all
#   jobs    (1a-1d, /20)   job instances: own public IP, no inbound (jobs.tf)
# Each zone has its own NAT gateway and app route table, so a zone outage
# leaves the other zone's web server with outbound access (job launches,
# GitHub). The S3 gateway endpoint (no charge) keeps S3 traffic off the NAT
# gateways and the internet.

variable "vpc_cidr" {
  description = "Address range of the Talon VPC. Only matters if it is ever connected to LCPS networks; changing it rebuilds the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "web_availability_zones" {
  description = "Zones for the public, app and data subnets (two: RDS needs a subnet group in two zones, and the Auto Scaling group puts one web server in each)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

locals {
  # 10.20.0.0/24, .1  public | 10.20.10.0/24, .11 app | 10.20.20.0/24, .21 data
  # 10.20.64.0/20, .80, .96, .112 jobs
  public_subnets = { for i, az in var.web_availability_zones : az => cidrsubnet(var.vpc_cidr, 8, i) }
  app_subnets    = { for i, az in var.web_availability_zones : az => cidrsubnet(var.vpc_cidr, 8, 10 + i) }
  data_subnets   = { for i, az in var.web_availability_zones : az => cidrsubnet(var.vpc_cidr, 8, 20 + i) }
  job_subnets    = { for i, az in var.job_availability_zones : az => cidrsubnet(var.vpc_cidr, 4, 4 + i) }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # RDS endpoint and SSM need both

  tags = {
    Name = local.name
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = local.name
  }
}

# ---------------------------------------------------------------- subnets

resource "aws_subnet" "public" {
  for_each          = local.public_subnets
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = {
    Name = "${local.name}-public-${substr(each.key, -2, 2)}"
    Tier = "public"
  }
}

resource "aws_subnet" "app" {
  for_each          = local.app_subnets
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = {
    Name = "${local.name}-app-${substr(each.key, -2, 2)}"
    Tier = "app"
  }
}

resource "aws_subnet" "data" {
  for_each          = local.data_subnets
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = {
    Name = "${local.name}-data-${substr(each.key, -2, 2)}"
    Tier = "data"
  }
}

# Job instances get their own public address (no NAT charge for pip, dataset
# downloads and the like); their security group admits nothing inbound.
resource "aws_subnet" "jobs" {
  for_each                = local.job_subnets
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.name}-jobs-${substr(each.key, -2, 2)}"
    Tier = "jobs"
  }
}

# ---------------------------------------------------------------- NAT

# One per zone. The first zone's kept its original names (moved blocks).
resource "aws_eip" "nat" {
  for_each = aws_subnet.public
  domain   = "vpc"

  tags = {
    Name = "${local.name}-nat-${substr(each.key, -2, 2)}"
  }
}

resource "aws_nat_gateway" "main" {
  for_each      = aws_subnet.public
  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = each.value.id

  tags = {
    Name = "${local.name}-${substr(each.key, -2, 2)}"
  }

  depends_on = [aws_internet_gateway.main]
}

moved {
  from = aws_eip.nat
  to   = aws_eip.nat["us-east-1a"]
}

moved {
  from = aws_nat_gateway.main
  to   = aws_nat_gateway.main["us-east-1a"]
}

# ---------------------------------------------------------------- routes

# Public and jobs: straight to the internet gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${local.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "jobs" {
  for_each       = aws_subnet.jobs
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

# App: out through the NAT gateway in the same zone.
resource "aws_route_table" "app" {
  for_each = aws_subnet.app
  vpc_id   = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[each.key].id
  }

  tags = {
    Name = "${local.name}-app-${substr(each.key, -2, 2)}"
  }
}

moved {
  from = aws_route_table.app
  to   = aws_route_table.app["us-east-1a"]
}

resource "aws_route_table_association" "app" {
  for_each       = aws_subnet.app
  subnet_id      = each.value.id
  route_table_id = aws_route_table.app[each.key].id
}

# Data: local traffic only (plus S3 through the endpoint).
resource "aws_route_table" "data" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${local.name}-data"
  }
}

resource "aws_route_table_association" "data" {
  for_each       = aws_subnet.data
  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}

# S3 gateway endpoint: no hourly or per-GB charge. App traffic to S3 (job
# input and results) skips the NAT gateway's per-GB charge; jobs traffic
# stays on AWS's network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat([aws_route_table.public.id, aws_route_table.data.id], [for rt in aws_route_table.app : rt.id])

  tags = {
    Name = "${local.name}-s3"
  }
}

# Nothing may use the VPC's default security group.
resource "aws_default_security_group" "main" {
  vpc_id = aws_vpc.main.id
}
