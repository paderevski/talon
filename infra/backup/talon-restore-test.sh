#!/bin/bash
# Restore test: download the newest nightly dump, restore it into a scratch
# database, sanity-check it, and drop the scratch database. A backup that has
# never been restored is only a hope. Runs weekly (systemd timer) and on demand.
#
# Settings come from /etc/talon/backup.env (optional) or the environment:
#   RESTORE_ADMIN_URL   server where the scratch database is created. Default:
#                       local Postgres as the "postgres" OS user (run this
#                       script as that user).
#   BACKUP_BUCKET, BACKUP_SSM_PREFIX   as in talon-backup.sh
set -euo pipefail

[ -f /etc/talon/backup.env ] && . /etc/talon/backup.env
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
AWS="${AWS_BIN:-/snap/bin/aws}"
PREFIX="${BACKUP_SSM_PREFIX:-/talon/demo}"
ADMIN_URL="${RESTORE_ADMIN_URL:-postgres:///postgres}"
BUCKET="${BACKUP_BUCKET:-$($AWS ssm get-parameter --name "$PREFIX/backup-bucket" --query Parameter.Value --output text)}"
SCRATCH="talon_restore_test"

KEY="$($AWS s3api list-objects-v2 --bucket "$BUCKET" --prefix daily/ \
  --query 'sort_by(Contents, &LastModified)[-1].Key' --output text)"
if [ -z "$KEY" ] || [ "$KEY" = "None" ]; then
  echo "restore-test: no dumps found in s3://$BUCKET/daily/" >&2
  exit 1
fi

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "restore-test: restoring $KEY"
$AWS s3 cp --only-show-errors "s3://$BUCKET/$KEY" "$WORK/latest.dump"

psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $SCRATCH"
psql "$ADMIN_URL" -qc "CREATE DATABASE $SCRATCH"
SCRATCH_URL="$(printf '%s' "$ADMIN_URL" | sed "s#/postgres\$#/$SCRATCH#")"
pg_restore --no-owner --no-acl --exit-on-error --dbname="$SCRATCH_URL" "$WORK/latest.dump"

count() { psql "$SCRATCH_URL" -tAc "SELECT count(*) FROM $1"; }
USERS="$(count users)"
MIGRATIONS="$(count schema_migrations)"
echo "restore-test: users=$USERS classes=$(count classes) ledger_rows=$(count budget_ledger) migrations=$MIGRATIONS"

if [ "$USERS" -lt 1 ] || [ "$MIGRATIONS" -lt 1 ]; then
  echo "restore-test: FAILED sanity check (empty users or schema_migrations)" >&2
  exit 1
fi
echo "restore-test: OK ($KEY)"
