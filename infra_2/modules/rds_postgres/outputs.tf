output "db_instance_endpoint" {
  value       = aws_db_instance.this.address
  description = "RDS endpoint address."
}

output "db_instance_port" {
  value       = aws_db_instance.this.port
  description = "RDS endpoint port."
}

output "db_name" {
  value       = aws_db_instance.this.db_name
  description = "Database name."
}

output "master_secret_arn" {
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  description = "Secrets Manager ARN for the generated master password."
}
