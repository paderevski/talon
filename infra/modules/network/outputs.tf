output "vpc_id" {
  value       = aws_vpc.this.id
  description = "VPC ID."
}

output "vpc_cidr" {
  value       = aws_vpc.this.cidr_block
  description = "VPC CIDR block."
}

output "public_subnet_ids" {
  value       = [for subnet in values(aws_subnet.public) : subnet.id]
  description = "Public subnet IDs."
}

output "private_subnet_ids" {
  value       = [for subnet in values(aws_subnet.private) : subnet.id]
  description = "Private subnet IDs."
}
