#!/bin/bash
# Nightly database backup: pg_dump -> S3. Runs on the app server (systemd timer).
#
# Settings come from /etc/talon/backup.env (optional) or the environment:
#   BACKUP_DATABASE_URL   what to dump. Default: the local socket as the
#                         "talon" OS user (peer auth, no password).
#   BACKUP_BUCKET         default: read from SSM /talon/<env>/backup-bucket
#   BACKUP_SSM_PREFIX     default: /talon/demo
# To back up an external Postgres or RDS later, set BACKUP_DATABASE_URL (put
# the password in PGPASSFILE or the environment) and make sure pg_dump here is
# the same major version as the server or newer.
set -euo pipefail

[ -f /etc/talon/backup.env ] && . /etc/talon/backup.env
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
AWS="${AWS_BIN:-/snap/bin/aws}"
PREFIX="${BACKUP_SSM_PREFIX:-/talon/demo}"
DB_URL="${BACKUP_DATABASE_URL:-postgres://talon@%2Fvar%2Frun%2Fpostgresql/talon}"
BUCKET="${BACKUP_BUCKET:-$($AWS ssm get-parameter --name "$PREFIX/backup-bucket" --query Parameter.Value --output text)}"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
MONTH="$(date -u +%Y-%m)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FILE="$WORK/talon-$STAMP.dump"

# Sessions and login-attempt rows are transient (and session ids are
# sensitive): keep their table definitions, skip their data. After a restore
# everyone simply signs in again.
pg_dump --format=custom --no-owner --no-acl \
  --exclude-table-data=sessions --exclude-table-data=login_attempts \
  --file="$FILE" "$DB_URL"

# A dump that cannot even be listed is not a backup.
pg_restore --list "$FILE" > /dev/null
SIZE="$(stat -c %s "$FILE")"
[ "$SIZE" -gt 1024 ] || { echo "backup: dump is suspiciously small ($SIZE bytes)" >&2; exit 1; }

$AWS s3 cp --only-show-errors "$FILE" "s3://$BUCKET/daily/talon-$STAMP.dump"
echo "backup: uploaded daily/talon-$STAMP.dump ($SIZE bytes)"

# Heartbeat for the CloudWatch "no backup in 36 hours" alarm (infra/ec2/alarms.tf).
$AWS cloudwatch put-metric-data --namespace Talon/Backup --metric-name BackupSuccess --value 1 \
  || echo "backup: WARNING could not publish the BackupSuccess metric" >&2

# Keep the first dump of each month for longer.
MONTHLY_KEY="monthly/talon-$MONTH.dump"
if ! $AWS s3api head-object --bucket "$BUCKET" --key "$MONTHLY_KEY" > /dev/null 2>&1; then
  $AWS s3 cp --only-show-errors "$FILE" "s3://$BUCKET/$MONTHLY_KEY"
  echo "backup: uploaded $MONTHLY_KEY"
fi
