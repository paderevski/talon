# Monitoring: server logs in CloudWatch Logs, server memory/disk metrics, and
# alarms that do not depend on the web server being honest.
#
# Logs and metrics: the CloudWatch agent on the web server, installed and
# configured by SSM State Manager (no user_data change, so the instance is not
# replaced). Its config lives in an SSM parameter; changing it re-runs the
# configure association.
#
# Alarms on EC2 vCPU usage (AWS/Usage) come from AWS itself, so they still fire
# if the web server is compromised and its reconciler stopped. They are
# account-wide: the account is shared, so another workload's instances count
# too. Alerts go to the SNS topic in alarms.tf.

variable "log_retention_days" {
  description = "Days to keep server logs in CloudWatch Logs."
  type        = number
  default     = 30
}

variable "alarm_gpu_vcpus" {
  description = "Alarm when GPU (G family) on-demand vCPUs in use exceed this. Default: 3 GPU jobs (EC2_MAX_GPU_JOBS_TOTAL) of up to 8 vCPUs (g6e.2xlarge)."
  type        = number
  default     = 24
}

variable "alarm_standard_vcpus" {
  description = "Alarm when standard (A, C, D, H, I, M, R, T, Z) on-demand vCPUs in use exceed this. Default: the web server (2) plus 10 CPU jobs (EC2_MAX_JOBS_TOTAL) of up to 4 vCPUs."
  type        = number
  default     = 42
}

variable "enable_guardduty" {
  description = "Turn on GuardDuty for the account (account-wide, shared account: agree with LCPS IT first) and email findings of medium severity and above."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------- server logs

locals {
  # Log group suffix => file on the web server. The backend writes JSON lines
  # to its own file (systemd drop-in from infra/server/configure.sh, applied by
  # deploy.sh); backups, deploys and the rest of the system log to journald,
  # which rsyslog copies to /var/log/syslog. nginx access lines are JSON too.
  server_logs = {
    backend      = "/var/log/talon/backend.log"
    syslog       = "/var/log/syslog"
    nginx-access = "/var/log/nginx/access.log"
    nginx-error  = "/var/log/nginx/error.log"
    bootstrap    = "/var/log/talon-bootstrap.log"
  }
  server_metrics_namespace = "Talon/Server"

  cw_agent_config = jsonencode({
    agent = {
      run_as_user                 = "root" # syslog is readable by root/adm only
      metrics_collection_interval = 60
    }
    logs = {
      logs_collected = {
        files = {
          collect_list = [for k, path in local.server_logs : {
            file_path       = path
            log_group_name  = aws_cloudwatch_log_group.server[k].name
            log_stream_name = "{instance_id}"
          }]
        }
      }
    }
    metrics = {
      namespace              = local.server_metrics_namespace
      append_dimensions      = { InstanceId = "$${aws:InstanceId}" }
      aggregation_dimensions = [["InstanceId"]]
      metrics_collected = {
        mem  = { measurement = ["mem_used_percent"] }
        disk = { measurement = ["used_percent"], resources = ["/"] }
      }
    }
  })
}

resource "aws_cloudwatch_log_group" "server" {
  for_each          = local.server_logs
  name              = "/talon/${var.environment}/${each.key}"
  retention_in_days = var.log_retention_days
}

# The AmazonCloudWatch- prefix is the agent's convention for config parameters.
resource "aws_ssm_parameter" "cw_agent_config" {
  name  = "AmazonCloudWatch-${local.name}"
  type  = "String"
  value = local.cw_agent_config
}

# Only what the agent needs: its config, these log groups, and metrics in one
# namespace (narrower than the CloudWatchAgentServerPolicy managed policy).
data "aws_iam_policy_document" "cw_agent" {
  statement {
    sid       = "ReadAgentConfig"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.cw_agent_config.arn]
  }

  statement {
    sid       = "WriteServerLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = flatten([for g in aws_cloudwatch_log_group.server : [g.arn, "${g.arn}:log-stream:*"]])
  }

  statement {
    sid       = "PublishServerMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"] # PutMetricData does not support resource-level permissions
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.server_metrics_namespace]
    }
  }
}

resource "aws_iam_role_policy" "cw_agent" {
  name   = "${local.name}-cloudwatch-agent"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.cw_agent.json
}

# Install the agent package, then load the config. Apply waits for each to
# succeed, so a failure shows up in `terraform apply`.
resource "aws_ssm_association" "cw_agent_install" {
  association_name = "${local.name}-cloudwatch-agent-install"
  name             = "AWS-ConfigureAWSPackage"
  parameters = {
    action = "Install"
    name   = "AmazonCloudWatchAgent"
  }
  targets {
    key    = "InstanceIds"
    values = [aws_instance.app.id]
  }
  wait_for_success_timeout_seconds = 600
}

resource "aws_ssm_association" "cw_agent_config" {
  # The config hash in the name: a changed config updates the association,
  # which runs it again.
  association_name = "${local.name}-cloudwatch-agent-config-${substr(sha1(local.cw_agent_config), 0, 8)}"
  name             = "AmazonCloudWatch-ManageAgent"
  parameters = {
    action                        = "configure"
    mode                          = "ec2"
    optionalConfigurationSource   = "ssm"
    optionalConfigurationLocation = aws_ssm_parameter.cw_agent_config.name
    optionalRestart               = "yes"
  }
  targets {
    key    = "InstanceIds"
    values = [aws_instance.app.id]
  }
  wait_for_success_timeout_seconds = 300
  depends_on                       = [aws_ssm_association.cw_agent_install, aws_iam_role_policy.cw_agent]
}

# ---------------------------------------------------------------- server alarms

resource "aws_cloudwatch_metric_alarm" "server_disk" {
  alarm_name          = "${local.name}-server-disk"
  alarm_description   = "Talon web server root disk is over 85% full (Postgres, job runs and logs live there)."
  namespace           = local.server_metrics_namespace
  metric_name         = "disk_used_percent"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Backend lines at level "error": unhandled route errors, reconciler failures,
# database errors (backend/src/utils/log.js).
resource "aws_cloudwatch_log_metric_filter" "backend_errors" {
  name           = "${local.name}-backend-errors"
  log_group_name = aws_cloudwatch_log_group.server["backend"].name
  pattern        = "{ $.level = \"error\" }"
  metric_transformation {
    name      = "BackendErrors"
    namespace = local.server_metrics_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "backend_errors" {
  alarm_name          = "${local.name}-backend-errors"
  alarm_description   = "10 or more Talon backend errors in 15 minutes. Logs Insights saved query Talon/Backend errors, or log group /talon/${var.environment}/backend with level = error."
  namespace           = local.server_metrics_namespace
  metric_name         = "BackendErrors"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# The reconciler found a job instance with no job row: something launched it
# without going through Talon.
resource "aws_cloudwatch_log_metric_filter" "unknown_job_instance" {
  name           = "${local.name}-unknown-job-instance"
  log_group_name = aws_cloudwatch_log_group.server["backend"].name
  pattern        = "{ ($.event = \"ec2.instance_terminated\") && ($.reason = \"no job row\") }"
  metric_transformation {
    name      = "UnknownJobInstanceTerminated"
    namespace = local.server_metrics_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "unknown_job_instance" {
  alarm_name          = "${local.name}-unknown-job-instance"
  alarm_description   = "The reconciler terminated a job instance that had no job row: it was launched outside Talon. Check CloudTrail RunInstances events for the instance."
  namespace           = local.server_metrics_namespace
  metric_name         = "UnknownJobInstanceTerminated"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Many failed or locked-out logins: someone guessing passwords. Per-account
# lockout already slows one account down; this catches a spread-out attempt.
resource "aws_cloudwatch_log_metric_filter" "failed_logins" {
  name           = "${local.name}-failed-logins"
  log_group_name = aws_cloudwatch_log_group.server["backend"].name
  pattern        = "{ ($.event = \"auth.login_failed\") || ($.event = \"auth.login_locked\") }"
  metric_transformation {
    name      = "FailedLogins"
    namespace = local.server_metrics_namespace
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "failed_logins" {
  alarm_name          = "${local.name}-failed-logins"
  alarm_description   = "50 or more failed or locked-out Talon logins in 15 minutes. Logs Insights saved query Talon/Failed logins shows usernames and IPs."
  namespace           = local.server_metrics_namespace
  metric_name         = "FailedLogins"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 50
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------- vCPU usage alarms

locals {
  vcpu_alarms = {
    gpu      = { class = "G/OnDemand", threshold = var.alarm_gpu_vcpus, label = "GPU (G family)" }
    standard = { class = "Standard/OnDemand", threshold = var.alarm_standard_vcpus, label = "standard" }
  }
}

resource "aws_cloudwatch_metric_alarm" "vcpus" {
  for_each            = local.vcpu_alarms
  alarm_name          = "${local.name}-${each.key}-vcpus"
  alarm_description   = "More ${each.value.label} on-demand vCPUs are running in this account than Talon's job limits allow (${each.value.threshold}). Something may be launching instances outside Talon. Account-wide: check running instances and CloudTrail RunInstances events."
  namespace           = "AWS/Usage"
  metric_name         = "ResourceCount"
  dimensions          = { Service = "EC2", Type = "Resource", Resource = "vCPU", Class = each.value.class }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# ---------------------------------------------------------------- GuardDuty (optional)

resource "aws_guardduty_detector" "this" {
  count                        = var.enable_guardduty ? 1 : 0
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_cloudwatch_event_rule" "guardduty_findings" {
  count       = var.enable_guardduty ? 1 : 0
  name        = "${local.name}-guardduty-findings"
  description = "GuardDuty findings of medium severity and above to the Talon alerts topic"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail        = { severity = [{ numeric = [">=", 4] }] }
  })
}

resource "aws_cloudwatch_event_target" "guardduty_findings" {
  count = var.enable_guardduty ? 1 : 0
  rule  = aws_cloudwatch_event_rule.guardduty_findings[0].name
  arn   = aws_sns_topic.alerts.arn
}

# EventBridge needs permission to publish. This replaces the topic's default
# policy, so the default (account owner) statement is kept.
data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid = "AccountOwner"
    actions = [
      "SNS:GetTopicAttributes", "SNS:SetTopicAttributes", "SNS:AddPermission", "SNS:RemovePermission",
      "SNS:DeleteTopic", "SNS:Subscribe", "SNS:ListSubscriptionsByTopic", "SNS:Publish",
    ]
    resources = [aws_sns_topic.alerts.arn]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceOwner"
      values   = [local.account_id]
    }
  }

  dynamic "statement" {
    for_each = var.enable_guardduty ? [1] : []
    content {
      sid       = "GuardDutyFindingsFromEventBridge"
      actions   = ["SNS:Publish"]
      resources = [aws_sns_topic.alerts.arn]
      principals {
        type        = "Service"
        identifiers = ["events.amazonaws.com"]
      }
      condition {
        test     = "ArnEquals"
        variable = "aws:SourceArn"
        values   = [aws_cloudwatch_event_rule.guardduty_findings[0].arn]
      }
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  count  = var.enable_guardduty ? 1 : 0
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}
