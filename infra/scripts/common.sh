#!/bin/bash
# Shared helpers for infra/scripts. Source, don't run.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-lcps}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""
TALON_ENV="${TALON_ENV:-demo}"

# Running web servers, oldest first, one id per line. Found by tag
# (Project=talon, Component=web, Environment=$TALON_ENV), so it works for one
# server or an Auto Scaling group. Falls back to the Terraform output for a
# box launched before the Component tag existed.
web_instance_ids() {
  local ids
  ids="$(aws ec2 describe-instances \
    --filters Name=tag:Project,Values=talon Name=tag:Component,Values=web \
              "Name=tag:Environment,Values=$TALON_ENV" Name=instance-state-name,Values=running \
    --query 'sort_by(Reservations[].Instances[], &LaunchTime)[].InstanceId' --output text | tr '\t' '\n' | sed '/^$/d')"
  if [ -z "$ids" ]; then
    ids="$(terraform -chdir="$INFRA_DIR/ec2" output -raw instance_id 2>/dev/null || true)"
    [ -n "$ids" ] && echo "note: no running instance tagged Component=web; using the Terraform output ($ids)" >&2
  fi
  [ -n "$ids" ] || { echo "No running Talon web server found (TALON_ENV=$TALON_ENV)" >&2; return 1; }
  echo "$ids"
}

# One web server for shell, tunnel and checks: TALON_INSTANCE if set,
# otherwise the oldest running one.
web_instance_id() {
  if [ -n "${TALON_INSTANCE:-}" ]; then
    echo "$TALON_INSTANCE"
  else
    web_instance_ids | head -1
  fi
}

# run_ssm <instance-id> <comment> <commands-json-array>: runs a shell script
# through SSM Run Command, waits, prints the output; fails unless it succeeded.
run_ssm() {
  local id="$1" comment="$2" commands="$3" cmd_id status
  cmd_id="$(aws ssm send-command \
    --instance-ids "$id" \
    --document-name AWS-RunShellScript \
    --comment "$comment" \
    --parameters "{\"commands\":$commands,\"executionTimeout\":[\"900\"]}" \
    --query Command.CommandId --output text)"
  # Poll rather than `aws ssm wait`, which gives up after 100 s (a deploy
  # with a build takes longer).
  status=Pending
  for _ in $(seq 1 200); do
    sleep 5
    status="$(aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$id" \
      --query Status --output text 2>/dev/null || echo Pending)"
    case "$status" in Pending | InProgress | Delayed) ;; *) break ;; esac
  done
  aws ssm get-command-invocation --command-id "$cmd_id" --instance-id "$id" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -40
  [ "$status" = "Success" ] || { echo "$comment on $id: $status" >&2; return 1; }
}
