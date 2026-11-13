# HTTPS on the internet-facing ALB (public_alb.tf), with the ACM certificate
# from cert.tf. Going public, step 2.
#
# Merge and apply this only after the certificate shows Issued (LCPS IT has
# added the validation CNAME that cert.tf prints). aws_acm_certificate_validation
# below waits for that, so an early apply just waits, and fails after its timeout
# if the record never appears.
#
# What it changes:
# - HTTPS:443 listener, TLS 1.2 and 1.3, forwarding to the web servers.
# - HTTP:80 redirects to HTTPS (public_alb.tf), except from our NAT gateways.
# - The ALB security group admits port 443 from the NAT gateways (the SSM
#   tunnel path: `TALON_ALB=public TALON_ALB_PORT=443 infra/scripts/tunnel.sh`).
#
# What it does not change: who can reach the ALB from the internet. That is
# var.public_alb_ingress_cidrs, empty by default (still NAT gateways only).

variable "public_alb_ingress_cidrs" {
  description = "Who may connect to the public ALB (ports 80 and 443), besides our own NAT gateways. Empty keeps it closed. [\"0.0.0.0/0\"] is the open internet; LCPS ranges make it an allow-list. This is the exposure decision."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.public_alb_ingress_cidrs : can(cidrnetmask(c))])
    error_message = "public_alb_ingress_cidrs must be IPv4 CIDR blocks such as 203.0.113.0/24."
  }
}

# Waits until ACM has issued the certificate. No validation_record_fqdns: the
# DNS record is added by LCPS IT in GoDaddy, not by Terraform.
resource "aws_acm_certificate_validation" "public" {
  certificate_arn = aws_acm_certificate.public.arn
}

resource "aws_lb_listener" "public_https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.public.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.public.arn
  }
}

# Port 443 from our NAT gateways: the tunnel's HTTPS path (port 80 from them is
# in public_alb.tf).
resource "aws_vpc_security_group_ingress_rule" "public_alb_https_from_nat" {
  for_each          = aws_eip.nat
  security_group_id = aws_security_group.public_alb.id
  description       = "HTTPS from the NAT gateway in ${each.key} (SSM tunnel path)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "${each.value.public_ip}/32"
}

# The exposure decision. Empty by default: nothing here is created.
locals {
  public_alb_open_rules = {
    for p in setproduct(var.public_alb_ingress_cidrs, [80, 443]) : "${p[0]}-${p[1]}" => { cidr = p[0], port = p[1] }
  }
}

resource "aws_vpc_security_group_ingress_rule" "public_alb_open" {
  for_each          = local.public_alb_open_rules
  security_group_id = aws_security_group.public_alb.id
  description       = "Port ${each.value.port} from ${each.value.cidr} (public_alb_ingress_cidrs)"
  ip_protocol       = "tcp"
  from_port         = each.value.port
  to_port           = each.value.port
  cidr_ipv4         = each.value.cidr
}
