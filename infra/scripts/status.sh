#!/bin/bash
# One-screen status of Talon in AWS: web servers, load balancer, database,
# running jobs, network (VPC, subnets, NAT, endpoints), security groups,
# IAM roles, alarms, cost, and anything running that is not Talon's.
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
PUBLIC_ALB="${TALON_PUBLIC_ALB_NAME:-talon-public}" # public_alb.tf; no environment in its name
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
# The public ALB has its own target group (a target group serves one ALB only).
PUB_TG="$(q elbv2 describe-target-groups --names "$PUBLIC_ALB-web" --query 'TargetGroups[0].TargetGroupArn')"
PUB_TARGETS=""
[ -n "$PUB_TG" ] && PUB_TARGETS="$(q elbv2 describe-target-health --target-group-arn "$PUB_TG" --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]')"
q autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$NAME-web" \
  --query 'AutoScalingGroups[0].Instances[].[InstanceId,AvailabilityZone,LifecycleState,HealthStatus,LaunchTemplate.Version]' |
while read -r id az state health ver; do
  alb="$(awk -v i="$id" '$1 == i {print $2}' <<<"$TARGETS")"
  pub="$(awk -v i="$id" '$1 == i {print $2}' <<<"$PUB_TARGETS")"
  commit=""
  if [ "$DEEP" = 1 ]; then
    commit="$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript \
      --parameters 'commands=["sudo -u talon git -C /opt/talon log -1 --format=%h"]' --query Command.CommandId --output text 2>/dev/null)"
    sleep 3
    commit="commit $(q ssm get-command-invocation --command-id "$commit" --instance-id "$id" --query StandardOutputContent | tr -d '\n')"
  fi
  printf '  %-20s %-11s %-10s asg:%-8s alb:%-10s public:%-10s v%s %s\n' "$id" "$az" "$state" "$health" "${alb:-none}" "${pub:-none}" "$ver" "$commit"
done
REFRESH="$(q autoscaling describe-instance-refreshes --auto-scaling-group-name "$NAME-web" --max-records 1 \
  --query 'InstanceRefreshes[0].[Status,StartTime]')"
[ -n "$REFRESH" ] && echo "last instance refresh: $REFRESH"

# ---------------------------------------------------------------- load balancers
# lb_status <load balancer name> <target group arn> <targets (id state lines)>
lb_status() {
  local lb_name="$1" tg="$2" targets="$3" lb_arn lb_state lb_scheme lb_dns idle listeners hc_path hc_int hc_bad healthy total
  read -r lb_arn lb_state lb_scheme lb_dns <<<"$(q elbv2 describe-load-balancers --names "$lb_name" \
    --query 'LoadBalancers[0].[LoadBalancerArn,State.Code,Scheme,DNSName]')"
  if [ -z "$lb_arn" ]; then echo "  not found"; return; fi
  idle="$(q elbv2 describe-load-balancer-attributes --load-balancer-arn "$lb_arn" \
    --query 'Attributes[?Key==`idle_timeout.timeout_seconds`].Value|[0]')"
  listeners="$(q elbv2 describe-listeners --load-balancer-arn "$lb_arn" --query 'Listeners[].[Protocol,Port]' | awk '{printf "%s%s:%s", sep, $1, $2; sep=", "}')"
  read -r hc_path hc_int hc_bad <<<"$(q elbv2 describe-target-groups --target-group-arns "$tg" \
    --query 'TargetGroups[0].[HealthCheckPath,HealthCheckIntervalSeconds,UnhealthyThresholdCount]')"
  healthy="$(awk '$2 == "healthy"' <<<"$targets" | wc -l | tr -d ' ')"; total="$(sed '/^$/d' <<<"$targets" | wc -l | tr -d ' ')"
  echo "  $lb_state, $lb_scheme, listeners ${listeners:-none}, idle timeout ${idle}s"
  echo "  targets $healthy of $total healthy; health check $hc_path every ${hc_int}s, unhealthy after $hc_bad"
  echo "  $lb_dns"
}
section "Load balancer, internal (ALB $NAME-web; the SSM tunnel's path)"
lb_status "$NAME-web" "$TG" "$TARGETS"

section "Load balancer, internet-facing (ALB $PUBLIC_ALB; public_alb.tf)"
lb_status "$PUBLIC_ALB" "$PUB_TG" "$PUB_TARGETS"
# Who may connect: the ALB's own security group, with NAT gateway IPs named.
PUB_SG="$(q elbv2 describe-load-balancers --names "$PUBLIC_ALB" --query 'LoadBalancers[0].SecurityGroups[0]')"
if [ -n "$PUB_SG" ]; then
  NAT_IPS="$(q ec2 describe-nat-gateways --filter Name=state,Values=available --query 'NatGateways[].NatGatewayAddresses[0].PublicIp')"
  OPEN="$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=$PUB_SG" \
    --query 'SecurityGroupRules[?IsEgress==`false`].[FromPort,CidrIpv4]')"
  if awk '$2 == "0.0.0.0/0"' <<<"$OPEN" | grep -q .; then
    echo "  reachable from: the whole internet (ports $(awk '$2 == "0.0.0.0/0" {printf "%s%s", sep, $1; sep=","}' <<<"$OPEN"))"
  else
    OUTSIDE=""
    while read -r port cidr; do
      [ -n "$cidr" ] || continue
      case " $(echo $NAT_IPS) " in *" ${cidr%/32} "*) ;; *) OUTSIDE="$OUTSIDE${OUTSIDE:+, }$cidr" ;; esac
    done <<<"$OPEN"
    if [ -n "$OUTSIDE" ]; then echo "  reachable from: the NAT gateways and $OUTSIDE"
    else echo "  reachable from: the NAT gateways only (SSM tunnel: TALON_ALB=public tunnel.sh)"; fi
  fi
fi

# ---------------------------------------------------------------- database
section "Database (RDS $NAME)"
read -r DB_STATUS DB_CLASS DB_GB DB_VER DB_MAZ DB_AZ DB_AZ2 <<<"$(q rds describe-db-instances --db-instance-identifier "$NAME" \
  --query 'DBInstances[0].[DBInstanceStatus,DBInstanceClass,AllocatedStorage,EngineVersion,MultiAZ,AvailabilityZone,SecondaryAvailabilityZone]')"
if [ "$DB_MAZ" = True ]; then DB_ZONES="Multi-AZ (primary $DB_AZ, standby ${DB_AZ2/None/in the other zone})"; else DB_ZONES="single zone ($DB_AZ)"; fi
metric() { # namespace metric dimension-name dimension-value statistic
  q cloudwatch get-metric-statistics --namespace "$1" --metric-name "$2" --dimensions "Name=$3,Value=$4" \
    --start-time "$HOUR_AGO" --end-time "$NOW" --period 3600 --statistics "$5" --query "Datapoints[0].$5"
}
CPU="$(metric AWS/RDS CPUUtilization DBInstanceIdentifier "$NAME" Average)"
CONNS="$(metric AWS/RDS DatabaseConnections DBInstanceIdentifier "$NAME" Maximum)"
FREE="$(metric AWS/RDS FreeStorageSpace DBInstanceIdentifier "$NAME" Minimum)"
printf '  %s, %s, Postgres %s, %s GB, %s\n  last hour: CPU %.0f%%, max %.0f connections, %.1f GB free\n' \
  "$DB_STATUS" "$DB_CLASS" "$DB_VER" "$DB_GB" "$DB_ZONES" "${CPU:-0}" "${CONNS:-0}" "$(awk -v b="${FREE:-0}" 'BEGIN {print b / 1e9}')"
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

# ---------------------------------------------------------------- network
VPC="$(q ec2 describe-vpcs --filters "Name=tag:Name,Values=$NAME" Name=tag:Project,Values=talon --query 'Vpcs[0].[VpcId,CidrBlock,State]')"
VPC_ID="${VPC%%[[:space:]]*}"
section "Network (VPC $VPC_ID)"
echo "  $(echo $VPC | cut -d' ' -f2-)"
q ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[].[Tags[?Key==`Tier`]|[0].Value,AvailabilityZone,CidrBlock,AvailableIpAddressCount]' | sort |
  awk '{z = substr($2, length($2)); t[$1] = t[$1] sep[$1] z " " $3; sep[$1] = ", "; free[$1] += $4}
       END {for (k in t) printf "  subnets %-7s %s (%d addresses free)\n", k, t[k], free[k]}' | sort
q ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC_ID" Name=state,Values=pending,available,deleting \
  --query 'NatGateways[].[NatGatewayId,State,SubnetId,NatGatewayAddresses[0].PublicIp]' |
  while read -r id state subnet ip; do echo "  NAT gateway $id $state, public IP $ip ($subnet)"; done
IGW="$(q ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC_ID" --query 'InternetGateways[].InternetGatewayId')"
echo "  internet gateway ${IGW:-none}"
q ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$VPC_ID" --query 'VpcEndpoints[].[ServiceName,VpcEndpointType,State]' |
  while read -r svc type state; do echo "  endpoint ${svc##*.} ($type) $state"; done
OTHER_EIPS="$(q ec2 describe-addresses --query 'Addresses[?AssociationId==null].PublicIp')"
[ -n "$OTHER_EIPS" ] && echo "  unattached Elastic IPs (billed): $OTHER_EIPS"

# ---------------------------------------------------------------- security groups
section "Security groups (inbound rules; every group allows all outbound unless noted)"
SG_NAMES="$(q ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" --query 'SecurityGroups[].[GroupId,GroupName]')"
sg_name() { awk -v i="$1" '$1 == i {print $2}' <<<"$SG_NAMES"; }
while read -r sg_id sg_name_; do
  [ -n "$sg_id" ] || continue
  rules="$(q ec2 describe-security-group-rules --filters "Name=group-id,Values=$sg_id" \
    --query 'SecurityGroupRules[].[IsEgress,IpProtocol,FromPort,ToPort,ReferencedGroupInfo.GroupId,CidrIpv4]')"
  inbound=""; egress=""; egress_rules=0
  while read -r is_egress proto from to ref cidr; do
    [ -n "$is_egress" ] || continue
    if [ "$proto" = "-1" ]; then port=all; elif [ "$from" = "$to" ]; then port="$proto/$from"; else port="$proto/$from-$to"; fi
    if [ "$ref" != "None" ]; then src="$(sg_name "$ref")"; src="${src:-$ref}"; else src="$cidr"; fi
    if [ "$is_egress" = "True" ]; then
      egress_rules=$((egress_rules + 1))
      [ "$port" = all ] && [ "$src" = "0.0.0.0/0" ] || egress="$egress${egress:+, }$port to $src"
    else
      inbound="$inbound${inbound:+, }$port from $src"
    fi
  done <<<"$rules"
  printf '  %-18s in: %s\n' "$sg_name_" "${inbound:-none}"
  if [ "$egress_rules" = 0 ]; then printf '  %-18s out: none\n' ""
  elif [ -n "$egress" ]; then printf '  %-18s out only: %s\n' "" "$egress"; fi
done <<<"$SG_NAMES"

# ---------------------------------------------------------------- IAM
section "IAM (global)"
q iam list-roles --query "Roles[?starts_with(RoleName, \`$NAME-\`)].RoleName" | tr '\t' '\n' | sed '/^$/d' |
while read -r role; do
  inline="$(q iam list-role-policies --role-name "$role" --query 'PolicyNames' | tr '\t' ' ')"
  managed="$(q iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[].PolicyName' | tr '\t' ' ')"
  echo "  role $role"
  [ -n "$inline" ] && echo "    inline:  $inline"
  [ -n "$managed" ] && echo "    managed: $managed"
done
PROFILES="$(q iam list-instance-profiles --query "InstanceProfiles[?starts_with(InstanceProfileName, \`$NAME-\`)].InstanceProfileName" | tr '\t' ' ')"
echo "  instance profiles: ${PROFILES:-none}"
SLR="$(q iam list-roles --path-prefix /aws-service-role/ --query 'Roles[?contains(RoleName, `AutoScaling`) || contains(RoleName, `ElasticLoadBalancing`) || contains(RoleName, `RDS`)].RoleName' | tr '\t' ' ')"
echo "  service-linked roles used: ${SLR:-none}"

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
