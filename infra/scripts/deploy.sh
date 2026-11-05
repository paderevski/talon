#!/bin/bash
# Pull, build, migrate and restart Talon on the instance via SSM Run Command,
# then reset the database to fresh demo data.
# Deploys what is pushed to GitHub, not your local working tree.
# Usage: infra/scripts/deploy.sh [branch] [--keep-data]
#
# The demo box holds disposable demo data, so every deploy reseeds it by
# default: all users, classes, jobs and sessions are replaced (everyone is
# signed out, GitHub links must be reconnected, and the reconciler terminates
# any job instance still running). --keep-data skips the reseed.
source "$(dirname "$0")/common.sh"

REF="main"
RESEED=1
for arg in "$@"; do
  case "$arg" in
    --keep-data) RESEED=0 ;;
    -*) echo "Unknown option: $arg (usage: deploy.sh [branch] [--keep-data])" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done
ID="$(instance_id)"

# After the deploy, apply the repo's server config (infra/server/configure.sh:
# logging). It runs as root, so it is taken from the deployed commit with
# `git show`, not from the working tree the talon user can write to. Older
# branches without the file skip it.
CONFIGURE='if sudo -u talon git -C /opt/talon cat-file -e HEAD:infra/server/configure.sh 2>/dev/null; then sudo -u talon git -C /opt/talon show HEAD:infra/server/configure.sh > /run/talon-configure.sh && bash /run/talon-configure.sh; fi'

# Wipes and reseeds the demo data (backend/src/db/seedDemo.js, replaceAll).
# Runs after the deploy so the new code's migrations are already applied.
SEED='sudo -u talon bash -c '"'"'set -a; . /etc/talon/talon.env; . /etc/talon/secrets.env; set +a; cd /opt/talon && npm run --silent db:seed:demo --workspace backend -- --replace-all'"'"''
STEPS="\"set -e\",\"/usr/local/bin/talon-deploy $REF\""
if [ "$RESEED" = 1 ]; then
  STEPS="$STEPS,\"$SEED\""
fi
STEPS="$STEPS,\"$CONFIGURE\""

CMD_ID="$(aws ssm send-command \
  --instance-ids "$ID" \
  --document-name AWS-RunShellScript \
  --comment "talon deploy $REF$([ "$RESEED" = 1 ] && echo ' + reseed')" \
  --parameters "{\"commands\":[$STEPS],\"executionTimeout\":[\"900\"]}" \
  --query Command.CommandId --output text)"

echo "Deploying $REF to $ID$([ "$RESEED" = 1 ] && echo ', then reseeding demo data' || echo ', keeping data') (command $CMD_ID)..."
aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$ID" || true

aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -40

STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" --query Status --output text)"
[ "$STATUS" = "Success" ] || { echo "Deploy $STATUS"; exit 1; }
