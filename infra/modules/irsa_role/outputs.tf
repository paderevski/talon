output "role_arn" {
  value       = aws_iam_role.this.arn
  description = "IRSA IAM role ARN."
}
