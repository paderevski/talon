# Public TLS certificate for the internet-facing ALB (public_alb.tf), from ACM.
#
# The ALB takes its certificate from ACM by reference; ACM keeps the private
# key and renews the certificate by itself. A certificate belongs to one
# account and region, so it is requested here, in the account that owns the
# ALB (it cannot be shared from another account).
#
# DNS validation: LCPS IT adds the CNAME this prints (output
# public_cert_validation_records) to the public zone and leaves it there
# permanently, because ACM re-checks it at every renewal. The zone is on
# GoDaddy; its host field usually wants only the part before the domain.
#
# Not here yet, on purpose: aws_acm_certificate_validation (it would make
# terraform apply wait until IT adds the record) and the HTTPS listener. Both
# come once the certificate shows Issued. Until then nothing uses it.

variable "public_hostname" {
  description = "Hostname browsers use to reach Talon (the ACM certificate's name and the DNS record LCPS IT points at the public ALB)."
  type        = string
  default     = "talon.lcps.org"
}

resource "aws_acm_certificate" "public" {
  domain_name       = var.public_hostname
  validation_method = "DNS"

  tags = {
    Name = var.public_hostname
  }

  lifecycle {
    create_before_destroy = true
  }
}

output "public_cert_arn" {
  description = "The public ACM certificate (cert.tf). Status Pending validation until the DNS record below exists."
  value       = aws_acm_certificate.public.arn
}

output "public_cert_validation_records" {
  description = "DNS records LCPS IT must add (and keep) to validate and renew the certificate."
  value = [
    for o in aws_acm_certificate.public.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}
