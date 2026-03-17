output "api_log_group_name" {
  value       = aws_cloudwatch_log_group.api.name
  description = "API log group name."
}

output "jobs_log_group_name" {
  value       = aws_cloudwatch_log_group.jobs.name
  description = "Jobs log group name."
}
