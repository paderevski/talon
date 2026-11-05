#!/bin/bash
# One-time RDS setup, safe to run again. Run as root on a web server by
# infra/scripts/db-bootstrap.sh (taken from the deployed commit), while
# Terraform's db_bootstrap = true lets the server read the master password.
#
# Creates:
#   talon_migrate  owns database "talon" and its schema (migrations, seed)
#   talon_app      the running backend: SELECT/INSERT/UPDATE/DELETE on the
#                  tables and their sequences, nothing else
# Both sign in with IAM tokens (rds_iam): no password is set for either.
#
# The master password is fetched into this process's environment only. It is
# never printed, logged or written to disk.
set -euo pipefail

set -a
. /etc/talon/talon.env
set +a
: "${RDS_MASTER_SECRET_ARN:?not set in /etc/talon/talon.env}"
: "${DATABASE_URL:?not set in /etc/talon/talon.env}"

PGHOST="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).hostname)' "$DATABASE_URL")"
PGPORT="$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).port or 5432)' "$DATABASE_URL")"
export PGHOST PGPORT PGSSLMODE=verify-full PGSSLROOTCERT=/etc/talon/rds-ca.pem PGCONNECT_TIMEOUT=10

if ! SECRET="$(/snap/bin/aws secretsmanager get-secret-value --region "$AWS_REGION" \
    --secret-id "$RDS_MASTER_SECRET_ARN" --query SecretString --output text 2>/dev/null)"; then
  echo "db-bootstrap: cannot read the master secret. Apply Terraform with db_bootstrap = true first." >&2
  exit 1
fi
PGUSER="$(printf '%s' "$SECRET" | python3 -c 'import json, sys; print(json.load(sys.stdin)["username"])')"
PGPASSWORD="$(printf '%s' "$SECRET" | python3 -c 'import json, sys; print(json.load(sys.stdin)["password"])')"
unset SECRET
export PGUSER PGPASSWORD

echo "db-bootstrap: connecting to $PGHOST as the master user"

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
