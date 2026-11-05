#!/bin/bash
# Backup helpers.
#   infra/scripts/backup.sh status        list recent dumps and how old the newest is
#   infra/scripts/backup.sh now           run a backup on the server right now
#   infra/scripts/backup.sh restore-test  restore the newest dump into a scratch DB and check it
#   infra/scripts/backup.sh install       (re)install the scripts and timers from the deployed repo
#
# Only the old single box (legacy_web_server in main.tf, local Postgres) runs
# these backups. Web servers on RDS have none: RDS keeps automated backups
# with point-in-time restore. Retire this script with the old box; `status`
# keeps working until the bucket's copies expire.
source "$(dirname "$0")/common.sh"

run_on_box() {
  local ID CMD_ID STATUS
  ID="${TALON_INSTANCE:-$(terraform -chdir="$INFRA_DIR/ec2" output -raw legacy_instance_id 2>/dev/null || true)}"
  [ -n "$ID" ] && [ "$ID" != "null" ] || { echo "No old box (legacy_instance_id): database backups are RDS's now." >&2; exit 1; }
  CMD_ID="$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --comment "talon backup $1" \
    --parameters "{\"commands\":[\"$2\"],\"executionTimeout\":[\"900\"]}" \
    --query Command.CommandId --output text)"
  aws ssm wait command-executed --command-id "$CMD_ID" --instance-id "$ID" || true
  aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" \
    --query '[StandardOutputContent,StandardErrorContent]' --output text
  STATUS="$(aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$ID" --query Status --output text)"
  [ "$STATUS" = "Success" ] || { echo "$1: $STATUS"; exit 1; }
}

case "${1:-status}" in
  status)
    BUCKET="$(terraform -chdir="$INFRA_DIR/ec2" output -raw backup_bucket)"
    echo "s3://$BUCKET"
    aws s3 ls "s3://$BUCKET/daily/" | tail -8
    aws s3 ls "s3://$BUCKET/monthly/"
    NEWEST="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix daily/ \
      --query 'sort_by(Contents, &LastModified)[-1].LastModified' --output text)"
    echo "newest daily dump: $NEWEST"
    ;;
  now) run_on_box backup "systemctl start talon-backup.service && journalctl -u talon-backup.service -n 5 --no-pager" ;;
  restore-test) run_on_box restore-test "systemctl start talon-restore-test.service; journalctl -u talon-restore-test.service -n 8 --no-pager" ;;
  install) run_on_box install "/opt/talon/infra/backup/install.sh" ;;
  *) echo "usage: $0 status|now|restore-test|install"; exit 1 ;;
esac
