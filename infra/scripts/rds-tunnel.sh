#!/bin/bash
# Helpers for reaching RDS from this laptop as a database role, with your own
# SSO credentials. Source after common.sh; don't run.
#
# The web servers can only sign in as talon_app (rows). Schema changes and
# admin scripts sign in as talon_migrate (schema owner) from here instead:
# an SSM port forward through a web server to RDS, an IAM sign-in token made
# with your credentials, and TLS checked against the real RDS name
# (backend/src/db/pool.js: DATABASE_CONNECT_HOST / DATABASE_CONNECT_PORT).
# infra/scripts/db-run.sh and deploy.sh use these; so can you:
#
#   rds_tunnel_open            opens the forward; the caller must run
#                              rds_tunnel_close when done (trap ... EXIT)
#   rds_db_env <db-role>       exports DATABASE_URL etc. for that role
#
# Needs the Session Manager plugin (brew install --cask session-manager-plugin),
# node/npm, nc, and an AWS identity allowed rds-db:connect as the role.

RDS_TUNNEL_PID=""
RDS_HOST=""
RDS_TUNNEL_PORT=""
RDS_TUNNEL_LOG=""

rds_endpoint() {
  aws rds describe-db-instances --db-instance-identifier "talon-$TALON_ENV" \
    --query 'DBInstances[0].Endpoint.Address' --output text
}

rds_tunnel_close() {
  if [ -n "$RDS_TUNNEL_PID" ]; then
    pkill -P "$RDS_TUNNEL_PID" 2>/dev/null || true # session-manager-plugin child
    kill "$RDS_TUNNEL_PID" 2>/dev/null || true
    RDS_TUNNEL_PID=""
  fi
  if [ -n "$RDS_TUNNEL_LOG" ]; then
    rm -f "$RDS_TUNNEL_LOG"
    RDS_TUNNEL_LOG=""
  fi
}

# Opens the forward on a free local port: sets RDS_HOST and RDS_TUNNEL_PORT.
rds_tunnel_open() {
  command -v session-manager-plugin >/dev/null || { echo "Install the Session Manager plugin (brew install --cask session-manager-plugin)" >&2; return 1; }
  command -v nc >/dev/null || { echo "nc is needed to wait for the tunnel" >&2; return 1; }
  aws sts get-caller-identity >/dev/null 2>&1 || { echo "Not signed in to AWS: source infra/scripts/aws-env.sh or aws sso login --profile $AWS_PROFILE" >&2; return 1; }
  RDS_HOST="$(rds_endpoint)"
  { [ -n "$RDS_HOST" ] && [ "$RDS_HOST" != None ]; } || { echo "No RDS instance talon-$TALON_ENV" >&2; return 1; }
  RDS_TUNNEL_PORT="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
  RDS_TUNNEL_LOG="$(mktemp)"
  aws ssm start-session --target "$(web_instance_id)" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$RDS_HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$RDS_TUNNEL_PORT\"]}" \
    >> "$RDS_TUNNEL_LOG" 2>&1 &
  RDS_TUNNEL_PID=$!
  for _ in $(seq 1 30); do
    nc -z 127.0.0.1 "$RDS_TUNNEL_PORT" 2>/dev/null && return 0
    kill -0 "$RDS_TUNNEL_PID" 2>/dev/null || break
    sleep 1
  done
  echo "The SSM tunnel to RDS did not open:" >&2
  tail -5 "$RDS_TUNNEL_LOG" >&2
  return 1
}

# The RDS CA bundle, cached under ~/.talon-deploy (never in the repo).
rds_ca_file() {
  local dir="$HOME/.talon-deploy" f
  f="$dir/rds-ca-$AWS_REGION.pem"
  if [ ! -s "$f" ]; then
    mkdir -p "$dir"
    curl -fsSL "https://truststore.pki.rds.amazonaws.com/$AWS_REGION/$AWS_REGION-bundle.pem" -o "$f.tmp" && mv "$f.tmp" "$f"
  fi
  echo "$f"
}

# rds_db_env <role>: exports what backend scripts need to sign in to the open
# tunnel as <role> (talon_migrate or talon_app). Call it in a subshell so the
# exported credentials stay with the command you run.
rds_db_env() {
  local role="$1" ca
  [ -n "$RDS_TUNNEL_PORT" ] || { echo "rds_db_env: open the tunnel first (rds_tunnel_open)" >&2; return 1; }
  ca="$(rds_ca_file)"
  # Node's AWS SDK may not read `aws login` / SSO sessions itself, so hand it
  # the profile's temporary credentials.
  eval "$(aws configure export-credentials --profile "$AWS_PROFILE" --format env)"
  export DATABASE_URL="postgres://$role@$RDS_HOST:5432/talon?sslmode=verify-full&sslrootcert=$ca"
  export DATABASE_IAM_AUTH=true DATABASE_CONNECT_HOST=127.0.0.1 DATABASE_CONNECT_PORT="$RDS_TUNNEL_PORT"
  export AWS_REGION
  unset DATABASE_MIGRATE_URL
}
