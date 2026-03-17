output "jobs_queue_url" {
  value       = aws_sqs_queue.jobs.url
  description = "SQS jobs queue URL."
}

output "jobs_queue_name" {
  value       = aws_sqs_queue.jobs.name
  description = "SQS jobs queue name."
}

output "jobs_queue_arn" {
  value       = aws_sqs_queue.jobs.arn
  description = "SQS jobs queue ARN."
}

output "dlq_queue_arn" {
  value       = aws_sqs_queue.dlq.arn
  description = "SQS dead letter queue ARN."
}
