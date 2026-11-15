# AWS WAF on the internet-facing ALB (public_alb.tf). Going public, step 3.
#
# Rules, in order:
# 1. Amazon IP reputation list (known botnets, scanners): block.
# 2. Known bad inputs (Log4Shell-style payloads, exploit paths): block.
# 3. Common rule set (OWASP-style: XSS, path traversal, bad bots, ...): block,
#    except SizeRestrictions_BODY, which only counts. It would block every body
#    over 8 KB, and roster imports send up to 512 KB (server.js).
# 4. Login rate limit per client IP on POST /api/auth/login: block above
#    var.waf_login_rate_limit in 5 minutes. Kept loose on purpose: a school
#    reaches the internet through a few shared addresses, so a whole class
#    signing in at once comes from one IP. The app's own per-account lockout
#    (login throttling) stops guessing one account's password.
# There is no general per-IP request limit, for the same shared-address reason
# (a class polling job logs adds up fast).
#
# The ALB sees clients directly (nothing in front of it), so WAF's IP is the
# real client. Health checks do not pass through WAF.
#
# Logs: CloudWatch log group aws-waf-logs-talon-public (WAF requires the
# prefix), 30 days, cookies redacted. Blocked requests: filter action = BLOCK.
#
# Cost: about 5 USD a month for the web ACL, 1 USD per rule (4), plus 0.60 USD
# per million requests.

variable "waf_login_rate_limit" {
  description = "Most POST /api/auth/login requests one client IP may send in 5 minutes before WAF blocks it (minimum 10). Loose because a school shares a few public addresses."
  type        = number
  default     = 300

  validation {
    condition     = var.waf_login_rate_limit >= 10
    error_message = "waf_login_rate_limit must be at least 10 (the WAF minimum)."
  }
}

resource "aws_wafv2_web_acl" "public" {
  name        = "${var.public_alb_name}-waf"
  description = "Talon public ALB - managed rules and login rate limit"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "ip-reputation"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesAmazonIpReputationList"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "known-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "common"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesCommonRuleSet"

        # Roster imports are larger than 8 KB: count, do not block.
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "login-rate-limit"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_login_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/auth/login"
                positional_constraint = "EXACTLY"
                field_to_match {
                  uri_path {}
                }
                text_transformation {
                  priority = 0
                  type     = "LOWERCASE"
                }
              }
            }
            statement {
              byte_match_statement {
                search_string         = "POST"
                positional_constraint = "EXACTLY"
                field_to_match {
                  method {}
                }
                text_transformation {
                  priority = 0
                  type     = "NONE"
                }
              }
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "login-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.public_alb_name}-waf"
    sampled_requests_enabled   = true
  }

  tags = {
    Name = "${var.public_alb_name}-waf"
  }
}

resource "aws_wafv2_web_acl_association" "public" {
  resource_arn = aws_lb.public.arn
  web_acl_arn  = aws_wafv2_web_acl.public.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  name              = "aws-waf-logs-${var.public_alb_name}"
  retention_in_days = 30
}

resource "aws_wafv2_web_acl_logging_configuration" "public" {
  resource_arn            = aws_wafv2_web_acl.public.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}
