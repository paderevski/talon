output "web_asg_name" {
  description = "The web servers' Auto Scaling group (web.tf). infra/scripts find the servers by tag."
  value       = aws_autoscaling_group.web.name
}

output "alb_dns_name" {
  description = "Internal ALB (alb.tf), reached through infra/scripts/tunnel.sh."
  value       = aws_lb.web.dns_name
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "public_alb_dns_name" {
  description = "Internet-facing ALB (public_alb.tf). LCPS IT points the talon.lcps.org CNAME here, once the certificate and exposure are settled."
  value       = aws_lb.public.dns_name
}
