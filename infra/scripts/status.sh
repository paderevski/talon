#!/bin/bash
# One-screen status of Talon in AWS: web servers, load balancer, database,
# running jobs, alarms, cost, and anything running that is not Talon's.
# Read-only. Usage: infra/scripts/status.sh [--deep] [--plan]
#   --deep  also ask each web server (SSM) which commit it runs
#   --plan  also run `terraform plan` to show drift (needs aws-env.sh creds
#           for Terraform; slow)
# Cost Explorer charges $0.01 per request; this makes two.
source "$(dirname "$0")/common.sh"

DEEP=0; PLAN=0
for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=1 ;;
    --plan) PLAN=1 ;;
    *) echo "Usage: status.sh [--deep] [--plan]" >&2; exit 2 ;;
  esac
done

NAME="talon-$TALON_ENV"
q() { aws "$@" --output text 2>/dev/null; }
section() { printf '\n== %s\n' "$1"; }
iso_ago() { date -u -v-"$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "$1 ago" +%Y-%m-%dT%H:%M:%SZ; }
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; HOUR_AGO="$(iso_ago 1H)"

printf 'Talon %s - %s - %s - %s\n' "$TALON_ENV" "$(q sts get-caller-identity --query Arn | sed 's/.*assumed-role\///')" "$AWS_REGION" "$NOW"

# ---------------------------------------------------------------- web
section "Web servers (Auto Scaling group $NAME-web)"
read -r DESIRED MIN MAX <<<"$(q autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$NAME-web" \
  --query 'AutoScalingGroups[0].[DesiredCapacity,MinSize,MaxSize]')"
LT_LATEST="$(q ec2 describe-launch-templates --launch-template-names "$NAME-web" --query 'LaunchTemplates[0].LatestVersionNumber')"
echo "desired $DESIRED (min $MIN, max $MAX), launch template latest v$LT_LATEST"
TG="$(q elbv2 describe-target-groups --names "$NAME-web" --query 'TargetGroups[0].TargetGroupArn')"
TARGETS="$(q elbv2 describe-target-health --target-group-arn "$TG" --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]')"
q autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$NAME-web" \
  --query 'AutoScalingGroups[0].Instances[].[InstanceId,AvailabilityZone,LifecycleState,HealthStatus,LaunchTemplate.Version]' |
while read -r id az state health ver; do
  alb="$(awk -v i="$id" '$1 == i {print $2}' <<<"$TARGETS")"
  commit=""
  if [ "$DEEP" = 1 ]; then
    commit="$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
      --parameters 'commands=["sudo -u talon git -C /opt/talon log -1 --format=%h"]' --query Command.CommandId --output text 2>/dev/null)"
    sleep 3
    commit="commit $(q ssm get-command-invocation --command-id "$commit" --instance-id "$id" --query StandardOutputContent | tr -d '\n')"
  fi
  printf '  %-20s %-11s %-10s asg:%-8s alb:%-10s v%s %s\n' "$id" "$az" "$state" "$health" "${alb:-none}" "$ver" "$commit"
done
REFRESH="$(q autoscaling describe-instance-refreshes --auto-scaling-group-name "$NAME-web" --max-records 1 \
  --query 'InstanceRefreshes[0].[Status,StartTime]')"
[ -n "$REFRESH" ] && echo "last instance refresh: $REFRESH"

# ---------------------------------------------------------------- database
section "Database (RDS $NAME)"
read -r DB_STATUS DB_CLASS DB_GB DB_VER <<<"$(q rds describe-db-instances --db-instance-identifier "$NAME" \
  --query 'DBInstances[0].[DBInstanceStatus,DBInstanceClass,AllocatedStorage,EngineVersion]')"
metric() { # namespace metric dimension-name dimension-value statistic
  q cloudwatch get-metric-statistics --namespace "$1" --metric-name "$2" --dimensions "Name=$3,Value=$4" \
    --start-time "$HOUR_AGO" --end-time "$NOW" --period 3600 --statistics "$5" --query "Datapoints[0].$5"
}
CPU="$(metric AWS/RDS CPUUtilization DBInstanceIdentifier "$NAME" Average)"
CONNS="$(metric AWS/RDS DatabaseConnections DBInstanceIdentifier "$NAME" Maximum)"
FREE="$(metric AWS/RDS FreeStorageSpace DBInstanceIdentifier "$NAME" Minimum)"
printf '  %s, %s, Postgres %s, %s GB; last hour: CPU %.0f%%, max %.0f connections, %.1f GB free\n' \
  "$DB_STATUS" "$DB_CLASS" "$DB_VER" "$DB_GB" "${CPU:-0}" "${CONNS:-0}" "$(awk -v b="${FREE:-0}" 'BEGIN {print b / 1e9}')"
PENDING="$(q rds describe-pending-maintenance-actions --filters "Name=db-instance-id,Values=$NAME" \
  --query 'PendingMaintenanceActions[].PendingMaintenanceActionDetails[].[Action,AutoAppliedAfterDate]')"
[ -n "$PENDING" ] && echo "  pending maintenance: $PENDING"

# ---------------------------------------------------------------- jobs
section "Job instances (running now)"
JOBS="$(q ec2 describe-instances --filters Name=tag:Project,Values=talon Name=tag:Component,Values=job \
  Name=instance-state-name,Values=pending,running \
  --query 'Reservations[].Instances[].[Tags[?Key==`talon-job`]|[0].Value,InstanceId,InstanceType,Placement.AvailabilityZone,LaunchTime]')"
if [ -n "$JOBS" ]; then
  while read -r job id type az launched; do printf '  %-10s %-20s %-13s %-11s since %s\n' "$job" "$id" "$type" "$az" "$launched"; done <<<"$JOBS"
else
  echo "  none"
fi

# ---------------------------------------------------------------- alarms
section "Alarms not OK"
ALARMS="$(q cloudwatch describe-alarms --alarm-name-prefix "$NAME" --query 'MetricAlarms[?StateValue!=`OK`].[StateValue,AlarmName]')"
if [ -n "$ALARMS" ]; then sed 's/^/  /' <<<"$ALARMS"; else echo "  none ($(q cloudwatch describe-alarms --alarm-name-prefix "$NAME" --query 'length(MetricAlarms)') alarms, all OK)"; fi

# ---------------------------------------------------------------- cost
section "Cost (account-wide, Cost Explorer; lags by about a day)"
echo "  what this account pays, net of LCPS's Savings Plans and discounts (EC2 compute is mostly covered)"
MONTH_START="$(date -u +%Y-%m-01)"; TODAY="$(date -u +%Y-%m-%d)"; TOMORROW="$(date -u -v+1d +%Y-%m-%d 2>/dev/null || date -u -d tomorrow +%Y-%m-%d)"
NEXT_MONTH="$(date -u -v1d -v+1m +%Y-%m-%d 2>/dev/null || date -u -d "$MONTH_START +1 month" +%Y-%m-%d)"
if [ "$TODAY" = "$MONTH_START" ]; then echo "  first day of the month: no data yet"; else
  q ce get-cost-and-usage --time-period "Start=$MONTH_START,End=$TODAY" --granularity MONTHLY --metrics UnblendedCost \
    --group-by Type=DIMENSION,Key=SERVICE --query 'ResultsByTime[0].Groups[].[Metrics.UnblendedCost.Amount,Keys[0]]' |
    sort -rn | awk '$1 >= 0.01 {amt = $1; $1 = ""; total += amt; printf "  %8.2f USD %s\n", amt, $0} END {printf "  %8.2f USD month to date\n", total}'
fi
FORECAST="$(q ce get-cost-forecast --time-period "Start=$TOMORROW,End=$NEXT_MONTH" --granularity MONTHLY --metric UNBLENDED_COST \
  --query 'Total.Amount')"
[ -n "$FORECAST" ] && printf '  %8.2f USD forecast for the rest of the month\n' "$FORECAST"
q budgets describe-budgets --account-id "$(q sts get-caller-identity --query Account)" \
  --query "Budgets[?starts_with(BudgetName, \`$NAME\`)].[BudgetName,CalculatedSpend.ActualSpend.Amount,BudgetLimit.Amount]" |
  while read -r name spent limit; do printf '  budget %-18s %8.2f of %.2f USD\n' "$name" "$spent" "$limit"; done

# ---------------------------------------------------------------- not Talon's
section "Other running instances in $AWS_REGION (not Talon's; the account is shared)"
OTHERS="$(q ec2 describe-instances --filters Name=instance-state-name,Values=pending,running \
  --query 'Reservations[].Instances[?!(Tags[?Key==`Project`&&Value==`talon`])].[InstanceId,InstanceType,Tags[?Key==`Name`]|[0].Value,LaunchTime][]')"
if [ -n "$OTHERS" ]; then sed 's/^/  /' <<<"$OTHERS"; else echo "  none"; fi

# ---------------------------------------------------------------- drift
if [ "$PLAN" = 1 ]; then
  section "Terraform drift (infra/ec2)"
  PLAN_OUT="$(mktemp)" # holds the account id: deleted below, never in the repo
  terraform -chdir="$INFRA_DIR/ec2" plan -input=false -no-color -detailed-exitcode -lock=false >"$PLAN_OUT" 2>&1
  case $? in
    0) echo "  no changes" ;;
    2) grep -E '^  # |^Plan:' "$PLAN_OUT" | sed 's/^/  /' ;;
    *) echo "  plan failed (source infra/scripts/aws-env.sh first?): $(grep -m1 -i error "$PLAN_OUT")" ;;
  esac
  rm -f "$PLAN_OUT"
fi
