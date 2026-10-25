output "instance_id" {
  value = aws_instance.app.id
}

output "public_ip" {
  description = "Elastic IP (no ports open yet; reserved for future DNS)."
  value       = aws_eip.app.public_ip
}

output "tunnel_command" {
  value = "infra/scripts/tunnel.sh   # then open http://localhost:8080"
}
