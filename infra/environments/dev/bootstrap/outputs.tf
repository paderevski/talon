output "state_bucket_name" {
  value       = aws_s3_bucket.terraform_state.bucket
  description = "Terraform state bucket name."
}

output "lock_table_name" {
  value       = aws_dynamodb_table.terraform_locks.name
  description = "Terraform lock table name."
}

output "state_kms_key_arn" {
  value       = aws_kms_key.terraform_state.arn
  description = "KMS key ARN used for Terraform state encryption."
}
