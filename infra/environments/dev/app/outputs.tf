output "kubernetes_namespace" {
  value       = kubernetes_namespace.talon.metadata[0].name
  description = "Kubernetes namespace for Talon workloads."
}

output "dispatcher_service_account_name" {
  value       = kubernetes_service_account.dispatcher.metadata[0].name
  description = "Dispatcher service account name."
}

output "runner_service_account_name" {
  value       = kubernetes_service_account.runner.metadata[0].name
  description = "Runner service account name."
}

output "dispatcher_irsa_role_arn" {
  value       = module.dispatcher_irsa.role_arn
  description = "Dispatcher IRSA role ARN."
}

output "runner_irsa_role_arn" {
  value       = module.runner_irsa.role_arn
  description = "Runner IRSA role ARN."
}
