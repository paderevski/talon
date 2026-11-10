# Internet-facing Application Load Balancer (going public, step 1). It is
# created now but reachable only from Talon's own NAT gateways: the SSM
# tunnel path is laptop -> SSM -> a web server -> NAT -> this ALB's public
# address, so the ALB security group admits only the NAT gateways' Elastic IPs.
# Nobody else on the internet can connect.
#
# Not done yet (waits on LCPS IT and the exposure decision, see
# infra/CURRENT_STATUS.md "Going public"):
# - HTTPS:443 listener with the ACM certificate for talon.lcps.org, and the
#   HTTP:80 -> 301 redirect. Until then this ALB forwards plain HTTP, which is
#   fine because only the NAT gateways can reach it.
# - Opening the ALB security group to the internet or an allow-list.
# - WAF, SESSION_COOKIE_SECURE and removing the demo accounts.
#
# It has its own target group (a target group can belong to only one load
# balancer), with the same health check as the internal ALB's in alb.tf, and
# the Auto Scaling group registers the web servers in both. Do not replace this ALB once LCPS IT points a CNAME at it: the
# DNS name changes with it.

variable "public_alb_name" {
  description = "Name of the internet-facing ALB (the security group adds -alb). Deliberately has no environment in it. Set it differently for a second stack in the same account (a test or prod build), or the names collide."
  type        = string
  default     = "talon-public"
}

resource "aws_security_group" "public_alb" {
  name        = "${var.public_alb_name}-alb"
  description = "Talon public ALB - port 80 from the NAT gateways only (SSM tunnel path), port 80 to web servers"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${var.public_alb_name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "public_alb_from_nat" {
  for_each          = aws_eip.nat
  security_group_id = aws_security_group.public_alb.id
  description       = "HTTP from the NAT gateway in ${each.key} (SSM tunnel path)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "${each.value.public_ip}/32"
}

resource "aws_vpc_security_group_egress_rule" "public_alb_to_web" {
  security_group_id            = aws_security_group.public_alb.id
  description                  = "HTTP and health checks to web servers"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_ingress_rule" "web_from_public_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "HTTP from the public ALB"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.public_alb.id
}

resource "aws_lb" "public" {
  name                       = var.public_alb_name
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.public_alb.id]
  subnets                    = [for s in aws_subnet.public : s.id]
  idle_timeout               = var.alb_idle_timeout_seconds
  drop_invalid_header_fields = true
  enable_deletion_protection = true

  tags = {
    Name = var.public_alb_name
  }
}

resource "aws_lb_target_group" "public" {
  name                 = "${var.public_alb_name}-web"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  target_type          = "instance"
  deregistration_delay = 30

  # Same liveness check as the internal ALB's target group (alb.tf).
  health_check {
    path                = "/api/health/live"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "public_http" {
  load_balancer_arn = aws_lb.public.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.public.arn
  }
}
