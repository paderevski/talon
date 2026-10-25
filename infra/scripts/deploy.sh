#!/bin/bash
# Pull, build, and restart Talon on the instance via SSM Run Command.
# Deploys what is pushed to GitHub, not your local working tree.
# Usage: infra/scripts/deploy.sh [branch]
source "$(dirname "$0")/common.sh"

REF="${1:-main}"
ID="$(instance_id)"

CMD_ID="$(aws ssm send-command \
  --instance-ids "$ID" \
  --document-name AWS-RunShellScript \
  --comment "talon deploy $REF" \
  --parameters "{\"commands\":[\"/usr/local/bin/talon-deploy $REF\"],\"executionTimeout\":[\"900\"]}" \
  --query Command.CommandId --output text)"

echo "Deploying $REF to $ID (command $CMD_ID)..."
aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$ID" || true

aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -40

STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" --query Status --output text)"
[ "$STATUS" = "Success" ] || { echo "Deploy $STATUS"; exit 1; }
