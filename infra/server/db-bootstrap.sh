#!/bin/bash
# One-time RDS setup, safe to run again. Run as root on a web server by
# infra/scripts/db-bootstrap.sh (taken from the deployed commit), while
# Terraform's db_bootstrap = true lets the server sign in as the master.
#
# Creates:
#   talon_migrate  owns database "talon" and its schema (migrations, seed)
#   talon_app      the running backend: SELECT/INSERT/UPDATE/DELETE on the
#                  tables and their sequences, nothing else
# Both sign in with IAM tokens (rds_iam): no password is set for either.
#
# Master sign-in: the first block below makes the master a member of
# talon_migrate, which is in rds_iam. RDS's pg_hba rule "+rds_iam" matches
# indirect members, so after that the master must sign in with an IAM token
# (rds-db:connect, allowed while db_bootstrap = true); its password works only
# on a brand-new database. So: token first, then the Secrets Manager
# password. Neither is printed, logged or written to disk. To restore password
# sign-in for the master: REVOKE talon_migrate FROM talon_admin.
set -euo pipefail

set -a
. /etc/talon/talon.env
set +a
: "${DATABASE_URL:?not set in /etc/talon/talon.env}"

PGHOST="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).hostname)' "$DATABASE_URL")"
PGPORT="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).port or 5432)' "$DATABASE_URL")"
PGUSER="${RDS_MASTER_USER:-talon_admin}" # aws_db_instance.main.username in rds.tf
export PGHOST PGPORT PGUSER PGSSLMODE=verify-full PGSSLROOTCERT=/etc/talon/rds-ca.pem PGCONNECT_TIMEOUT=10

PGPASSWORD="$(/snap/bin/aws rds generate-db-auth-token --region "$AWS_REGION" \
  --hostname "$PGHOST" --port "$PGPORT" --username "$PGUSER")"
export PGPASSWORD
if psql -q -d postgres -Atc "SELECT 1" >/dev/null 2>&1; then
  echo "db-bootstrap: signed in to $PGHOST as $PGUSER with an IAM token"
else
  echo "db-bootstrap: IAM token refused for $PGUSER; trying the master password"
  if [ -z "${RDS_MASTER_SECRET_ARN:-}" ] || ! SECRET="$(/snap/bin/aws secretsmanager get-secret-value --region "$AWS_REGION" \
      --secret-id "$RDS_MASTER_SECRET_ARN" --query SecretString --output text 2>/dev/null)"; then
    echo "db-bootstrap: cannot read the master secret either. Apply Terraform with db_bootstrap = true first." >&2
    exit 1
  fi
  PGPASSWORD="$(printf '%s' "$SECRET" | python3 -c 'import json, sys; print(json.load(sys.stdin)["password"])')"
  unset SECRET
  export PGPASSWORD
  psql -q -d postgres -Atc "SELECT 1" >/dev/null || { echo "db-bootstrap: the master password was refused too." >&2; exit 1; }
  echo "db-bootstrap: signed in to $PGHOST as $PGUSER with the master password"
fi

# Roles and database (connected to the maintenance database "postgres").
psql -v ON_ERROR_STOP=1 -q -d postgres <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talon_migrate') THEN
    CREATE ROLE talon_migrate LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talon_app') THEN
    CREATE ROLE talon_app LOGIN;
  END IF;
END
$$;
GRANT rds_iam TO talon_migrate, talon_app;
-- The master user must be a member to create a database owned by it.
GRANT talon_migrate TO CURRENT_USER;
SELECT 'CREATE DATABASE talon OWNER talon_migrate'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'talon') \gexec
REVOKE ALL ON DATABASE talon FROM PUBLIC;
GRANT CONNECT ON DATABASE talon TO talon_app;
SQL

# Privileges inside "talon". Default privileges cover tables that future
# migrations (run as talon_migrate) create; the GRANT ... ALL covers existing ones.
psql -v ON_ERROR_STOP=1 -q -d talon <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO talon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE talon_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO talon_app;
ALTER DEFAULT PRIVILEGES FOR ROLE talon_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO talon_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO talon_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO talon_app;
SQL

psql -q -d talon -Atc "SELECT 'db-bootstrap: done. roles: ' || string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'talon\_%'"
