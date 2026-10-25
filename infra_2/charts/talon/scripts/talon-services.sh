#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"

if [[ -z "$ACTION" || ( "$ACTION" != "sleep" && "$ACTION" != "wake" && "$ACTION" != "status" && "$ACTION" != "running" ) ]]; then
  echo "Usage: $0 <sleep|wake|status|running>"
  echo "Optional env vars: AWS_REGION, TALON_CLUSTER, TALON_NODEGROUP, TALON_NAMESPACE, TALON_DB_INSTANCE"
  exit 1
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
TALON_CLUSTER="${TALON_CLUSTER:-talon-dev-eks}"
TALON_NAMESPACE="${TALON_NAMESPACE:-talon}"
TALON_DB_INSTANCE="${TALON_DB_INSTANCE:-talon-dev-postgres}"
STATE_DIR="${HOME}/.talon"
STATE_FILE="${STATE_DIR}/${TALON_CLUSTER}-deployments.tsv"

mkdir -p "$STATE_DIR"

aws_cmd() {
  AWS_PAGER="" aws --region "$AWS_REGION" "$@"
}

discover_nodegroup() {
  if [[ -n "${TALON_NODEGROUP:-}" ]]; then
    echo "$TALON_NODEGROUP"
    return
  fi

  local ng
  ng="$(aws_cmd eks list-nodegroups --cluster-name "$TALON_CLUSTER" --query 'nodegroups[0]' --output text)"
  if [[ -z "$ng" || "$ng" == "None" ]]; then
    echo "Could not discover node group for cluster $TALON_CLUSTER" >&2
    exit 1
  fi

  echo "$ng"
}

nodegroup_scaling() {
  local nodegroup="$1"
  aws_cmd eks describe-nodegroup \
    --cluster-name "$TALON_CLUSTER" \
    --nodegroup-name "$nodegroup" \
    --query 'nodegroup.scalingConfig.[minSize,desiredSize,maxSize]' \
    --output text
}

save_deployment_state() {
  kubectl get deployment -n "$TALON_NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.replicas}{"\n"}{end}' > "$STATE_FILE"
}

restore_deployment_state() {
  if [[ ! -s "$STATE_FILE" ]]; then
    echo "No saved deployment state found at $STATE_FILE, defaulting all deployments to 1 replica"
    kubectl scale deployment -n "$TALON_NAMESPACE" --all --replicas=1
    return
  fi

  while IFS=$'\t' read -r name replicas; do
    [[ -z "$name" ]] && continue
    replicas="${replicas:-1}"
    kubectl scale deployment "$name" -n "$TALON_NAMESPACE" --replicas="$replicas"
  done < "$STATE_FILE"
}

status() {
  local nodegroup="$1"
  echo "Cluster: $TALON_CLUSTER"
  echo "Node group: $nodegroup"
  echo "Namespace: $TALON_NAMESPACE"
  echo "DB instance: $TALON_DB_INSTANCE"
  echo

  echo "EKS nodegroup scaling (min desired max):"
  nodegroup_scaling "$nodegroup"
  echo

  echo "RDS status:"
  aws_cmd rds describe-db-instances \
    --db-instance-identifier "$TALON_DB_INSTANCE" \
    --query 'DBInstances[0].DBInstanceStatus' \
    --output text
  echo

  echo "Deployments:"
  kubectl get deployment -n "$TALON_NAMESPACE"
}

running() {
  local nodegroup="$1"
  echo "Running Talon services"
  echo "Cluster: $TALON_CLUSTER"
  echo "Node group: $nodegroup"
  echo "Namespace: $TALON_NAMESPACE"
  echo

  echo "RDS (available):"
  aws_cmd rds describe-db-instances \
    --db-instance-identifier "$TALON_DB_INSTANCE" \
    --query 'DBInstances[?DBInstanceStatus==`available`].[DBInstanceIdentifier,DBInstanceStatus,DBInstanceClass]' \
    --output table
  echo

  echo "Nodegroup scaling (min desired max):"
  nodegroup_scaling "$nodegroup"
  echo

  echo "Running EC2 worker instances (Project=talon):"
  aws_cmd ec2 describe-instances \
    --filters Name=tag:Project,Values=talon Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[].[InstanceId,InstanceType,PrivateDnsName,Placement.AvailabilityZone]' \
    --output table
  echo

  echo "Running deployments in namespace $TALON_NAMESPACE:"
  kubectl get deployment -n "$TALON_NAMESPACE" \
    -o custom-columns='NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas' \
    --no-headers | awk '$2+0 > 0'
  echo

  echo "Running pods in namespace $TALON_NAMESPACE:"
  kubectl get pods -n "$TALON_NAMESPACE" --field-selector=status.phase=Running
}

sleep_services() {
  local nodegroup="$1"

  echo "Saving deployment replica state to $STATE_FILE"
  save_deployment_state

  echo "Scaling Talon deployments to 0"
  kubectl scale deployment -n "$TALON_NAMESPACE" --all --replicas=0

  read -r min desired max < <(nodegroup_scaling "$nodegroup")
  echo "Current nodegroup scaling: min=$min desired=$desired max=$max"
  echo "Scaling nodegroup min/desired to 0"
  aws_cmd eks update-nodegroup-config \
    --cluster-name "$TALON_CLUSTER" \
    --nodegroup-name "$nodegroup" \
    --scaling-config "minSize=0,desiredSize=0,maxSize=$max" \
    --query 'update.id' \
    --output text >/dev/null

  echo "Stopping RDS instance"
  aws_cmd rds stop-db-instance --db-instance-identifier "$TALON_DB_INSTANCE" >/dev/null

  echo "Sleep sequence started. Use '$0 wake' to resume."
}

wake_services() {
  local nodegroup="$1"

  read -r min desired max < <(nodegroup_scaling "$nodegroup")
  local wake_min wake_desired wake_max
  wake_min=1
  wake_desired=1
  wake_max="$max"
  if [[ "$wake_max" -lt 1 ]]; then
    wake_max=1
  fi

  echo "Starting RDS instance"
  aws_cmd rds start-db-instance --db-instance-identifier "$TALON_DB_INSTANCE" >/dev/null || true
  echo "Waiting for RDS availability"
  aws_cmd rds wait db-instance-available --db-instance-identifier "$TALON_DB_INSTANCE"

  echo "Scaling nodegroup to min=$wake_min desired=$wake_desired max=$wake_max"
  aws_cmd eks update-nodegroup-config \
    --cluster-name "$TALON_CLUSTER" \
    --nodegroup-name "$nodegroup" \
    --scaling-config "minSize=$wake_min,desiredSize=$wake_desired,maxSize=$wake_max" \
    --query 'update.id' \
    --output text >/dev/null

  echo "Waiting for at least one ready node"
  kubectl wait --for=condition=Ready node --all --timeout=10m

  echo "Restoring deployment replica counts"
  restore_deployment_state

  echo "Wake sequence completed."
}

NODEGROUP="$(discover_nodegroup)"

case "$ACTION" in
  sleep)
    sleep_services "$NODEGROUP"
    ;;
  wake)
    wake_services "$NODEGROUP"
    ;;
  status)
    status "$NODEGROUP"
    ;;
  running)
    running "$NODEGROUP"
    ;;
esac
