#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-}"
MODE="${2:-standard}"

if [[ -z "$ACTION" || ( "$ACTION" != "park" && "$ACTION" != "unpark" && "$ACTION" != "status" ) ]]; then
  echo "Usage: $0 <park|unpark|status> [standard|full]"
  echo "  standard: destroy/apply app+platform (keeps bootstrap state infra)"
  echo "  full: destroy/apply app+platform+bootstrap"
  exit 1
fi

if [[ "$MODE" != "standard" && "$MODE" != "full" ]]; then
  echo "Invalid mode: $MODE (expected standard or full)"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
BOOTSTRAP_DIR="$ROOT_DIR/infra/environments/dev/bootstrap"
PLATFORM_DIR="$ROOT_DIR/infra/environments/dev/platform"
APP_DIR="$ROOT_DIR/infra/environments/dev/app"

BOOTSTRAP_TFVARS="$BOOTSTRAP_DIR/terraform.tfvars"
PLATFORM_TFVARS="$PLATFORM_DIR/terraform.tfvars"
APP_TFVARS="$APP_DIR/terraform.tfvars"

if [[ ! -f "$BOOTSTRAP_TFVARS" || ! -f "$PLATFORM_TFVARS" || ! -f "$APP_TFVARS" ]]; then
  echo "Missing one or more terraform.tfvars files in dev bootstrap/platform/app"
  exit 1
fi

parse_tfvar() {
  local key="$1"
  local file="$2"
  local value
  value="$(awk -F= -v k="$key" '$1 ~ "^[[:space:]]*"k"[[:space:]]*$" {v=$2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); gsub(/"/, "", v); print v; exit}' "$file")"
  if [[ -z "$value" ]]; then
    echo "Could not parse $key from $file" >&2
    exit 1
  fi
  echo "$value"
}

AWS_REGION="$(parse_tfvar aws_region "$BOOTSTRAP_TFVARS")"
STATE_BUCKET="$(parse_tfvar state_bucket_name "$BOOTSTRAP_TFVARS")"
LOCK_TABLE="$(parse_tfvar lock_table_name "$BOOTSTRAP_TFVARS")"

init_remote_backend() {
  local dir="$1"
  local key="$2"
  terraform -chdir="$dir" init -reconfigure \
    -backend-config="bucket=$STATE_BUCKET" \
    -backend-config="key=$key" \
    -backend-config="region=$AWS_REGION" \
    -backend-config="dynamodb_table=$LOCK_TABLE" \
    -backend-config="encrypt=true" >/dev/null
}

init_local_backend() {
  local dir="$1"
  terraform -chdir="$dir" init >/dev/null
}

park() {
  echo "Parking Talon infrastructure (mode=$MODE)"

  init_remote_backend "$APP_DIR" "talon/dev/app/terraform.tfstate"
  echo "Destroying app layer"
  terraform -chdir="$APP_DIR" destroy -auto-approve -var-file=terraform.tfvars

  init_remote_backend "$PLATFORM_DIR" "talon/dev/platform/terraform.tfstate"
  echo "Destroying platform layer"
  terraform -chdir="$PLATFORM_DIR" destroy -auto-approve -var-file=terraform.tfvars

  if [[ "$MODE" == "full" ]]; then
    init_local_backend "$BOOTSTRAP_DIR"
    echo "Destroying bootstrap layer"
    terraform -chdir="$BOOTSTRAP_DIR" destroy -auto-approve -var-file=terraform.tfvars
  fi

  echo "Park complete."
}

unpark() {
  echo "Unparking Talon infrastructure (mode=$MODE)"

  if [[ "$MODE" == "full" ]]; then
    init_local_backend "$BOOTSTRAP_DIR"
    echo "Applying bootstrap layer"
    terraform -chdir="$BOOTSTRAP_DIR" apply -auto-approve -var-file=terraform.tfvars
  fi

  init_remote_backend "$PLATFORM_DIR" "talon/dev/platform/terraform.tfstate"
  echo "Applying platform layer"
  terraform -chdir="$PLATFORM_DIR" apply -auto-approve -var-file=terraform.tfvars

  init_remote_backend "$APP_DIR" "talon/dev/app/terraform.tfstate"
  echo "Applying app layer"
  terraform -chdir="$APP_DIR" apply -auto-approve -var-file=terraform.tfvars

  echo "Unpark complete."
  echo "Next: helm upgrade --install talon infra/charts/talon -n talon -f infra/charts/talon/values.dev.yaml"
}

status() {
  echo "Talon Terraform lifecycle status"
  echo "AWS region: $AWS_REGION"
  echo "State bucket: $STATE_BUCKET"
  echo "Lock table: $LOCK_TABLE"
  echo

  AWS_PAGER="" aws --region "$AWS_REGION" eks list-clusters --output table
  echo
  AWS_PAGER="" aws --region "$AWS_REGION" ec2 describe-nat-gateways \
    --filter Name=tag:Project,Values=talon Name=tag:Environment,Values=dev \
    --query 'NatGateways[].{NatId:NatGatewayId,State:State}' --output table
  echo
  AWS_PAGER="" aws --region "$AWS_REGION" rds describe-db-instances \
    --query 'DBInstances[?contains(DBInstanceIdentifier, `talon-dev`)].{Id:DBInstanceIdentifier,Status:DBInstanceStatus,Class:DBInstanceClass}' --output table
}

case "$ACTION" in
  park)
    park
    ;;
  unpark)
    unpark
    ;;
  status)
    status
    ;;
esac
