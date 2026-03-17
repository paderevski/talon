variable "name_prefix" {
  type        = string
  description = "Prefix used in resource names."
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
}

variable "azs" {
  type        = list(string)
  description = "Availability zones to spread subnets across."
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDRs for public subnets, same length/order as azs."
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "CIDRs for private subnets, same length/order as azs."
}

variable "tags" {
  type        = map(string)
  description = "Common tags applied to all resources."
  default     = {}
}
