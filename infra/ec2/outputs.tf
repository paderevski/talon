output "instance_id" {
  description = "The web server (web.tf). infra/scripts find it by tag; this is for reference."
  value       = aws_instance.web.id
}

output "legacy_instance_id" {
  description = "The old single box, until legacy_web_server = false."
  value       = one(aws_instance.app[*].id)
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "tunnel_command" {
  value = "infra/scripts/tunnel.sh   # then open http://localhost:8080"
}
