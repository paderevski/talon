output "bucket_name" {
  value       = aws_s3_bucket.this.bucket
  description = "Artifacts bucket name."
}

output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "Artifacts bucket ARN."
}
