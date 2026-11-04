# Saved CloudWatch Logs Insights queries (console: CloudWatch > Logs Insights >
# Queries, folder "Talon"). Edit the placeholder value (job id, user id,
# request id) after opening a query. Field names come from the backend's JSON
# lines (backend/src/utils/log.js, requestLog.js) and the nginx talon_json
# format (infra/server/configure.sh).

locals {
  lg = { for k, g in aws_cloudwatch_log_group.server : k => g.name }

  log_queries = {
    "Backend errors" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, event, msg, error, requestId, userId, jobId, path
        | filter level = "error"
        | sort @timestamp desc
        | limit 200
      EOQ
    }

    "Warnings and errors" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, level, event, msg, error, userId, jobId, instanceId
        | filter level in ["warn", "error"]
        | sort @timestamp desc
        | limit 200
      EOQ
    }

    "Trace one request (set requestId)" = {
      groups = [local.lg.backend, local.lg["nginx-access"]]
      query  = <<-EOQ
        fields @timestamp, @log, level, event, msg, method, path, status, durationMs, requestTime, error
        | filter requestId = "REPLACE_WITH_REQUEST_ID"
        | sort @timestamp asc
      EOQ
    }

    "Job history (set jobId)" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, level, event, msg, userId, method, path, status, instanceId, reason, costCents, error
        | filter jobId = "job-REPLACE"
        | sort @timestamp asc
        | limit 500
      EOQ
    }

    "User activity (set userId)" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, event, method, path, status, jobId, ip
        | filter userId = "REPLACE_WITH_USER_ID"
        | sort @timestamp desc
        | limit 500
      EOQ
    }

    "Job lifecycle events" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, event, jobId, userId, provider, instanceType, instanceId, status, durationSeconds, costCents, reason
        | filter event like /^(job|ec2)\./
        | sort @timestamp desc
        | limit 300
      EOQ
    }

    "Failed logins" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        filter event in ["auth.login_failed", "auth.login_locked"]
        | stats count(*) as attempts, max(@timestamp) as last by username, ip, event
        | sort attempts desc
      EOQ
    }

    "Slow API requests" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        fields @timestamp, method, path, status, durationMs, userId, requestId
        | filter event = "http.request" and durationMs > 1000
        | sort durationMs desc
        | limit 100
      EOQ
    }

    "API traffic by status (5 min)" = {
      groups = [local.lg.backend]
      query  = <<-EOQ
        filter event = "http.request"
        | stats count(*) as requests, avg(durationMs) as avgMs, pct(durationMs, 95) as p95Ms by bin(5m), status
        | sort bin(5m) desc
      EOQ
    }

    "nginx errors (4xx and 5xx)" = {
      groups = [local.lg["nginx-access"]]
      query  = <<-EOQ
        filter status >= 400
        | stats count(*) as hits by status, method, path
        | sort hits desc
        | limit 100
      EOQ
    }

    "nginx error log" = {
      groups = [local.lg["nginx-error"]]
      query  = <<-EOQ
        fields @timestamp, @message
        | sort @timestamp desc
        | limit 200
      EOQ
    }

    "System log problems (backups, deploys, services)" = {
      groups = [local.lg.syslog]
      query  = <<-EOQ
        fields @timestamp, @message
        | filter @message like /(?i)(error|fail|denied|oom|killed)/
        | sort @timestamp desc
        | limit 200
      EOQ
    }
  }
}

resource "aws_cloudwatch_query_definition" "talon" {
  for_each        = local.log_queries
  name            = "Talon/${each.key}"
  log_group_names = each.value.groups
  query_string    = trimspace(each.value.query)
}
