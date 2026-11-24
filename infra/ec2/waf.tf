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
# 5. SQL injection rule set (AWSManagedRulesSQLiRuleSet): COUNT at first, see
#    var.waf_new_rules_block.
# 6. Job submission rate limit per client IP (POST /api/jobs, which launches
#    paid EC2 instances): COUNT at first.
# 7. Write-request rate limit per client IP (POST/PUT/PATCH/DELETE under
#    /api/): COUNT at first.
# 8. Microsoft sign-in rate limit per client IP (GET /api/auth/entra/...,
#    var.waf_login_rate_limit in 5 minutes): COUNT at first. Each one
#    writes a session row, and the callback calls Microsoft.
# There is no general per-IP limit on reads (GET), for the same shared-address
# reason: the frontend polls job status and logs every 2 seconds per open job
# page, so a class legitimately sends thousands of GETs in 5 minutes.
#
# Rules 5-8 are new and ship in COUNT mode: WAF records what they would have
# blocked (metric CountedRequests, and the log's labels and rule lists) but
# lets the request through. Request bodies here carry script arguments, repo
# paths and roster CSV text that could trip the SQLi rules, and the real
# per-address request rates are not measured yet. Watch the counts for a few
# school days, then set waf_new_rules_block = true.
#
# The ALB sees clients directly (nothing in front of it), so WAF's IP is the
# real client. Health checks do not pass through WAF.
#
# Logs: CloudWatch log group aws-waf-logs-talon-public (WAF requires the
# prefix), 30 days. The cookie and authorization headers and the query string
# are redacted (OAuth callbacks carry code and state in the query string). Blocked requests: filter action = BLOCK.
#
# Capacity (WCU, limit 1,500): IP reputation 25 + known bad inputs 200 +
# common 700 + SQLi 200 + four rate rules (about 10 each) = about 1,165.
#
# Cost: about 5 USD a month for the web ACL, 1 USD per rule (7; a managed rule
# group counts as one), plus 0.60 USD per million requests.

variable "waf_login_rate_limit" {
  description = "Most POST /api/auth/login requests one client IP may send in 5 minutes before WAF blocks it (minimum 10). Loose because a school shares a few public addresses."
  type        = number
  default     = 300

  validation {
    condition     = var.waf_login_rate_limit >= 10
    error_message = "waf_login_rate_limit must be at least 10 (the WAF minimum)."
  }
}

variable "waf_job_submit_rate_limit" {
  description = "Most POST /api/jobs (job submissions, each can launch a paid EC2 instance) one client IP may send in 5 minutes (minimum 10). Sized for a class of about 30 students behind one address submitting at the start of a lesson, with resubmits."
  type        = number
  default     = 300

  validation {
    condition     = var.waf_job_submit_rate_limit >= 10
    error_message = "waf_job_submit_rate_limit must be at least 10 (the WAF minimum)."
  }
}

variable "waf_write_rate_limit" {
  description = "Most write requests (POST, PUT, PATCH, DELETE under /api/) one client IP may send in 5 minutes (minimum 10). Reads are not limited: job pages poll every 2 seconds. Includes logins and job submissions."
  type        = number
  default     = 1500

  validation {
    condition     = var.waf_write_rate_limit >= 10
    error_message = "waf_write_rate_limit must be at least 10 (the WAF minimum)."
  }
}

variable "waf_new_rules_block" {
  description = "false: the SQLi rule set and the job-submission, write-request and Microsoft sign-in rate rules only count (requests pass, WAF records the match). true: they block. Switch after watching the counts on real traffic."
  type        = bool
  default     = false
}

resource "aws_wafv2_web_acl" "public" {
  name        = "${var.public_alb_name}-waf"
  description = "Talon public ALB - managed rules and rate limits"
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

  # Count first (see the header): override_action count for a managed group.
  rule {
    name     = "sqli"
    priority = 35

    override_action {
      dynamic "none" {
        for_each = var.waf_new_rules_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_new_rules_block ? [] : [1]
        content {}
      }
    }

    statement {
      managed_rule_group_statement {
        vendor_name = "AWS"
        name        = "AWSManagedRulesSQLiRuleSet"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "sqli"
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

  # Sign in with Microsoft: GET /api/auth/entra/login and /callback (each
  # sign-in is one of each). Same limit as password logins.
  rule {
    name     = "entra-sign-in-rate-limit"
    priority = 45

    action {
      dynamic "block" {
        for_each = var.waf_new_rules_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_new_rules_block ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_login_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/auth/entra/"
            positional_constraint = "STARTS_WITH"
            field_to_match {
              uri_path {}
            }
            text_transformation {
              priority = 0
              type     = "LOWERCASE"
            }
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "entra-sign-in-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # Job submissions: POST /api/jobs (trailing slash allowed, any case).
  rule {
    name     = "job-submit-rate-limit"
    priority = 50

    action {
      dynamic "block" {
        for_each = var.waf_new_rules_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_new_rules_block ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_job_submit_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          and_statement {
            statement {
              regex_match_statement {
                regex_string = "^/api/jobs/?$"
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
      metric_name                = "job-submit-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # All state-changing requests under /api/. Reads are deliberately absent.
  rule {
    name     = "write-rate-limit"
    priority = 60

    action {
      dynamic "block" {
        for_each = var.waf_new_rules_block ? [1] : []
        content {}
      }
      dynamic "count" {
        for_each = var.waf_new_rules_block ? [] : [1]
        content {}
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_write_rate_limit
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"

        scope_down_statement {
          and_statement {
            statement {
              byte_match_statement {
                search_string         = "/api/"
                positional_constraint = "STARTS_WITH"
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
              or_statement {
                dynamic "statement" {
                  for_each = ["POST", "PUT", "PATCH", "DELETE"]
                  content {
                    byte_match_statement {
                      search_string         = statement.value
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
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "write-rate-limit"
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

  # Redaction applies to the stored log only; rules still inspect the real
  # values. WAF allows up to 100 redacted fields. The query string matters
  # most: OAuth callbacks carry code and state in it. The app does not use an
  # Authorization header, so that one is cheap insurance.
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    query_string {}
  }
}

# ---------------------------------------------------------------- alarms
# On the public ALB and its web ACL, same topic as the internal ALB's (alb.tf).

# Spike of requests the WAF blocked. The ALB admits only a few addresses today,
# so this should be quiet; once it is open, scanners will blip it, so the
# threshold is high. Counted (not blocked) rules do not add to this metric.
variable "waf_blocked_alarm_threshold" {
  description = "Blocked requests in 5 minutes (all WAF rules) that raise the WAF alarm."
  type        = number
  default     = 100
}

resource "aws_cloudwatch_metric_alarm" "waf_blocked" {
  alarm_name          = "${var.public_alb_name}-waf-blocked"
  alarm_description   = "${var.waf_blocked_alarm_threshold} or more requests blocked by the Talon public WAF in 5 minutes (attack or a rule blocking real users). Check the WAF log group aws-waf-logs-${var.public_alb_name}, filter action = BLOCK."
  namespace           = "AWS/WAFV2"
  metric_name         = "BlockedRequests"
  dimensions          = { WebACL = aws_wafv2_web_acl.public.name, Region = var.aws_region, Rule = "ALL" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.waf_blocked_alarm_threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
