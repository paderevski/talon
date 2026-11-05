# Internal Application Load Balancer in front of the web servers (web tier
# plan, phase 3). Private: internal scheme, app subnets, and the only thing
# allowed to connect is a web server (the SSM tunnel's path: laptop -> SSM ->
# a web server -> ALB -> any healthy web server). Going public (internet
# facing, HTTPS on talon.lcps.org, WAF) is a later phase and waits on the
# exposure and subnet decisions in CURRENT_STATUS.md.
#
# Two proxies sit in front of Node (ALB -> nginx -> Node). nginx keeps the
# ALB's X-Forwarded-Proto for requests from the VPC, and the backend trusts
# the VPC range as proxies (infra/server/configure.sh).

variable "alb_idle_timeout_seconds" {
  description = "ALB idle timeout. Long enough for job submit and roster import, which can take over a minute."
  type        = number
  default     = 180
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Talon internal ALB - port 80 from web servers (SSM tunnel path), port 80 to web servers"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_from_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP from web servers (SSM tunnel)"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "HTTP and health checks to web servers"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.web.id
}

resource "aws_vpc_security_group_ingress_rule" "web_from_alb" {
  security_group_id            = aws_security_group.web.id
  description                  = "HTTP from the ALB"
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_lb" "web" {
  name                       = "${local.name}-web"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for s in aws_subnet.app : s.id]
  idle_timeout               = var.alb_idle_timeout_seconds
  drop_invalid_header_fields = true

  tags = {
    Name = "${local.name}-web"
  }
}

resource "aws_lb_target_group" "web" {
  name                 = "${local.name}-web"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.main.id
  target_type          = "instance"
  deregistration_delay = 30

  # Liveness only (backend/src/server.js): is the app on this server up? Not
  # the database, which both servers share: a database outage or failover
  # must not get healthy servers replaced (seen 2026-11-05). /api/health
  # still checks the database, for people and scripts.
  # Until a server is marked unhealthy the ALB keeps sending it its share of
  # requests (502s from nginx when the backend is down): about interval x
  # unhealthy_threshold. Measured 2026-11-05 with 15 s x 3: 44 s, half the
  # requests failing. 10 s x 2 brings that to about 20 s.
  health_check {
    path                = "/api/health/live"
    matcher             = "200"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
}

resource "aws_lb_listener" "web" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# ---------------------------------------------------------------- alarms

# Fewer healthy servers than the group should have, for 10 minutes (longer
# than a replacement's first boot, so a normal replacement does not alarm).
resource "aws_cloudwatch_metric_alarm" "web_healthy_hosts" {
  alarm_name          = "${local.name}-web-healthy-hosts"
  alarm_description   = "Fewer than ${var.web_server_count} healthy Talon web servers behind the ALB for 10 minutes. Check the target group's health and the Auto Scaling group's activity."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 10
  threshold           = var.web_server_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# 5xx the ALB itself returns (502/503/504: no healthy server, a server
# dropped the connection, or the idle timeout). Backend errors have their own
# alarm (monitoring.tf).
resource "aws_cloudwatch_metric_alarm" "web_alb_5xx" {
  alarm_name          = "${local.name}-web-alb-5xx"
  alarm_description   = "5 or more 5xx responses from the Talon ALB itself in 5 minutes (no healthy server, dropped connection, or idle timeout)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.web.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
