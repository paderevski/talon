#!/bin/bash
# Grafana for Talon on this laptop: http://localhost:3000
#
#   infra/grafana/grafana.sh up [--local]   start (or restart) it
#   infra/grafana/grafana.sh down           stop it (dashboards and settings stay)
#   infra/grafana/grafana.sh status         what is running
#
# CloudWatch panels read the Talon account with the lcps SSO profile.
# Postgres panels read the "reporting" views (migration 010) as the read-only
# role talon_grafana:
#   default   the RDS database, through an SSM tunnel via a web server, signed
#             in with IAM tokens (needs the role from infra/server/db-bootstrap.sh)
#   --local   the local talon_dev database (creates the role there if missing)
#
# A background loop keeps the AWS credentials and the IAM token fresh, and
# reopens the tunnel if it drops. Credentials, the admin password and logs
# live in $TALON_GRAFANA_HOME (default ~/.talon-grafana), never in the repo.
source "$(dirname "$0")/../scripts/common.sh"

GRAFANA_DIR="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="${TALON_GRAFANA_HOME:-$HOME/.talon-grafana}"
PORT="${TALON_GRAFANA_PORT:-3000}"
TUNNEL_PORT="${TALON_GRAFANA_TUNNEL_PORT:-15432}"
LOCAL_DB="${TALON_GRAFANA_LOCAL_DB:-talon_dev}"
DS_UID="talon-postgres"
REFRESH_SECONDS=300 # IAM tokens last 15 minutes; SSO role credentials about an hour
export TALON_GRAFANA_HOME="$HOME_DIR" TALON_GRAFANA_PORT="$PORT" TALON_ENV

log() { echo "grafana: $*"; }
die() { echo "grafana: $*" >&2; exit 1; }

compose() { docker compose -f "$GRAFANA_DIR/docker-compose.yml" "$@"; }

pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

stop_pid() {
  if pid_alive "$1"; then
    pkill -P "$(cat "$1")" 2>/dev/null || true # the tunnel's session-manager-plugin child
    kill "$(cat "$1")" 2>/dev/null || true
  fi
  rm -f "$1"
}

# --- AWS credentials -----------------------------------------------------

ensure_aws_login() {
  aws sts get-caller-identity >/dev/null 2>&1 && return
  log "signing in to AWS (profile $AWS_PROFILE)"
  aws sso login --profile "$AWS_PROFILE" >/dev/null
  aws sts get-caller-identity >/dev/null || die "AWS sign-in failed"
}

# Grafana's "talon" profile runs `cat creds.json` (credential_process); the
# file holds the lcps profile's temporary credentials with their expiry, so
# the AWS SDK in Grafana reloads it when they expire. Never printed.
write_aws_files() {
  mkdir -p "$HOME_DIR/aws"
  chmod 700 "$HOME_DIR"
  printf '[profile talon]\ncredential_process = cat /etc/grafana/aws/creds.json\nregion = %s\n' "$AWS_REGION" > "$HOME_DIR/aws/config"
  printf '[talon]\ncredential_process = cat /etc/grafana/aws/creds.json\n' > "$HOME_DIR/aws/credentials"
  refresh_aws_credentials
}

refresh_aws_credentials() {
  local tmp="$HOME_DIR/aws/creds.json.tmp"
  ( umask 077; aws configure export-credentials --profile "$AWS_PROFILE" --format process > "$tmp" ) || {
    rm -f "$tmp"; echo "grafana: could not refresh AWS credentials (SSO session expired? run grafana.sh up)" >&2; return 1; }
  chmod 644 "$tmp" # the container's grafana user must read it; the folder is 700
  mv "$tmp" "$HOME_DIR/aws/creds.json"
}

# --- Grafana API ---------------------------------------------------------

admin_password() {
  local f="$HOME_DIR/admin-password"
  [ -s "$f" ] || ( umask 077; openssl rand -hex 16 > "$f" )
  cat "$f"
}

# curl against the local Grafana with the admin password from a config file
# (keeps it out of the process list).
api() {
  local method="$1" path="$2"
  ( umask 077; printf 'user = "admin:%s"\n' "$(admin_password)" > "$HOME_DIR/curlrc" )
  curl -sS -K "$HOME_DIR/curlrc" -X "$method" -H 'Content-Type: application/json' \
    "http://127.0.0.1:$PORT$path" "${@:3}"
}

wait_for_grafana() {
  for _ in $(seq 1 60); do
    curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return
    sleep 1
  done
  die "Grafana did not start; see: docker compose -f $GRAFANA_DIR/docker-compose.yml logs"
}

# Create or update the Postgres data source. The password comes from the
# environment variable TALON_PG_PASSWORD (an IAM token in RDS mode), passed
# on stdin, never in arguments.
upsert_postgres_datasource() {
  local host="$1" db="$2" sslmode="$3" body status
  body="$(TALON_PG_URL="$host" TALON_PG_DB="$db" TALON_PG_SSLMODE="$sslmode" DS_UID="$DS_UID" python3 -I -c '
import json, os
ssl = os.environ["TALON_PG_SSLMODE"]
json_data = {"database": os.environ["TALON_PG_DB"], "sslmode": ssl, "postgresVersion": 1600,
             "maxOpenConns": 2, "maxIdleConns": 2, "connMaxLifetime": 600}
if ssl == "verify-full":
    json_data.update({"tlsConfigurationMethod": "file-path", "sslRootCertFile": "/etc/grafana/rds-ca.pem"})
print(json.dumps({"uid": os.environ["DS_UID"], "name": "Talon Postgres", "type": "grafana-postgresql-datasource",
                  "access": "proxy", "url": os.environ["TALON_PG_URL"], "user": "talon_grafana",
                  "jsonData": json_data, "secureJsonData": {"password": os.environ.get("TALON_PG_PASSWORD", "")}}))')"
  status="$(api GET "/api/datasources/uid/$DS_UID" -o /dev/null -w '%{http_code}')"
  if [ "$status" = 200 ]; then
    printf '%s' "$body" | api PUT "/api/datasources/uid/$DS_UID" --data-binary @- -o /dev/null -w '%{http_code}' | grep -q '^2' \
      || { echo "grafana: updating the Postgres data source failed" >&2; return 1; }
  else
    printf '%s' "$body" | api POST /api/datasources --data-binary @- -o /dev/null -w '%{http_code}' | grep -q '^2' \
      || { echo "grafana: creating the Postgres data source failed" >&2; return 1; }
  fi
}

# --- Database: RDS over SSM, or local -------------------------------------

rds_endpoint() {
  aws rds describe-db-instances --db-instance-identifier "talon-$TALON_ENV" \
    --query 'DBInstances[0].Endpoint.Address' --output text
}

start_tunnel() {
  local host="$1" id
  stop_pid "$HOME_DIR/tunnel.pid"
  id="$(web_instance_id)"
  nohup aws ssm start-session --target "$id" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$host\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$TUNNEL_PORT\"]}" \
    >> "$HOME_DIR/tunnel.log" 2>&1 &
  echo $! > "$HOME_DIR/tunnel.pid"
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "$TUNNEL_PORT" 2>/dev/null && return
    sleep 1
  done
  die "the SSM tunnel to RDS did not open; see $HOME_DIR/tunnel.log"
}

rds_token() {
  aws rds generate-db-auth-token --hostname "$1" --port 5432 --username talon_grafana --region "$AWS_REGION"
}

ensure_local_role() {
  psql -v ON_ERROR_STOP=1 -q -d "$LOCAL_DB" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talon_grafana') THEN
    CREATE ROLE talon_grafana LOGIN;
  END IF;
END
$$;
ALTER ROLE talon_grafana CONNECTION LIMIT 5;
ALTER ROLE talon_grafana SET statement_timeout = '10s';
ALTER ROLE talon_grafana SET default_transaction_read_only = on;
SQL
  psql -v ON_ERROR_STOP=1 -q -d "$LOCAL_DB" -c "GRANT CONNECT ON DATABASE \"$LOCAL_DB\" TO talon_grafana" \
    -c "GRANT USAGE ON SCHEMA reporting TO talon_grafana" \
    -c "GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO talon_grafana" \
    || die "local database $LOCAL_DB has no reporting schema: npm run db:migrate --workspace backend"
}

# --- Commands --------------------------------------------------------------

cmd_up() {
  local mode=rds pg_host=""
  [ "${1:-}" = "--local" ] && mode=local
  command -v docker >/dev/null || die "docker is not installed"
  docker info >/dev/null 2>&1 || die "Docker is not running"

  ensure_aws_login
  mkdir -p "$HOME_DIR"
  write_aws_files
  [ -s "$HOME_DIR/rds-ca.pem" ] || curl -fsSL "https://truststore.pki.rds.amazonaws.com/$AWS_REGION/$AWS_REGION-bundle.pem" -o "$HOME_DIR/rds-ca.pem"
  chmod 644 "$HOME_DIR/rds-ca.pem"
  stop_pid "$HOME_DIR/refresh.pid"

  if [ "$mode" = rds ]; then
    command -v session-manager-plugin >/dev/null || die "install the Session Manager plugin (brew install --cask session-manager-plugin)"
    pg_host="$(rds_endpoint)"
    [ -n "$pg_host" ] && [ "$pg_host" != None ] || die "no RDS instance talon-$TALON_ENV"
    start_tunnel "$pg_host"
    export TALON_PG_TUNNEL_HOST="$pg_host"
  else
    stop_pid "$HOME_DIR/tunnel.pid"
    ensure_local_role
    export TALON_PG_TUNNEL_HOST=""
  fi
  echo "$mode" > "$HOME_DIR/mode"

  TALON_GRAFANA_ADMIN_PASSWORD="$(admin_password)" compose up -d --force-recreate >/dev/null
  wait_for_grafana

  if [ "$mode" = rds ]; then
    TALON_PG_PASSWORD="$(rds_token "$pg_host")" upsert_postgres_datasource "$pg_host:$TUNNEL_PORT" talon verify-full
  else
    TALON_PG_PASSWORD="" upsert_postgres_datasource "host.docker.internal:5432" "$LOCAL_DB" disable
  fi

  nohup "$0" _refresh "$mode" "$pg_host" >> "$HOME_DIR/refresh.log" 2>&1 &
  echo $! > "$HOME_DIR/refresh.pid"
  log "ready: http://localhost:$PORT  (database: $mode; stop with grafana.sh down)"
}

# Background loop started by `up`.
cmd_refresh() {
  local mode="$1" pg_host="${2:-}"
  while sleep "$REFRESH_SECONDS"; do
    refresh_aws_credentials || continue
    [ "$mode" = rds ] || continue
    if ! nc -z 127.0.0.1 "$TUNNEL_PORT" 2>/dev/null; then
      echo "$(date '+%F %T') tunnel down; reopening"
      ( start_tunnel "$pg_host" ) || continue
    fi
    TALON_PG_PASSWORD="$(rds_token "$pg_host")" upsert_postgres_datasource "$pg_host:$TUNNEL_PORT" talon verify-full || true
  done
}

cmd_down() {
  stop_pid "$HOME_DIR/refresh.pid"
  stop_pid "$HOME_DIR/tunnel.pid"
  TALON_GRAFANA_ADMIN_PASSWORD=unused compose down >/dev/null 2>&1 || true
  log "stopped (dashboards and settings kept in the Docker volume)"
}

cmd_status() {
  local health
  health="$(curl -fs "http://127.0.0.1:$PORT/api/health" 2>/dev/null | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["database"])' 2>/dev/null || echo "not running")"
  echo "grafana:  $health (http://localhost:$PORT)"
  echo "database: $(cat "$HOME_DIR/mode" 2>/dev/null || echo -)"
  pid_alive "$HOME_DIR/tunnel.pid" && echo "tunnel:   open on 127.0.0.1:$TUNNEL_PORT" || echo "tunnel:   closed"
  pid_alive "$HOME_DIR/refresh.pid" && echo "refresh:  running" || echo "refresh:  stopped"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  status) cmd_status ;;
  _refresh) shift; cmd_refresh "$@" ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
