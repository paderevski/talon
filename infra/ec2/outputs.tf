output "instance_id" {
  description = "The web server (web.tf). infra/scripts find it by tag; this is for reference."
  value       = aws_instance.web.id
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "tunnel_command" {
  value = "infra/scripts/tunnel.sh   # then open http://localhost:8080"
}
