#!/bin/bash
# Run a backend script against the live RDS database from this laptop, signed
# in as a database role with your own AWS credentials, through an SSM tunnel
# (rds-tunnel.sh). The web servers cannot do this themselves: they sign in
# as talon_app only.
# Usage: infra/scripts/db-run.sh [--as talon_migrate|talon_app] [--ref <sha-or-branch>] -- <command...>
#   infra/scripts/db-run.sh -- npm run db:migrate --workspace backend
#   infra/scripts/db-run.sh -- npm run db:create-admin --workspace backend -- --username you@example.org
#
# The command runs in a clean checkout of --ref (default origin/main, after a
# fetch), never your working tree: dependencies are installed there with
# `npm ci --ignore-scripts`. The role defaults to talon_migrate (schema
# owner). Anything that needs the app's secrets (db:rotate-credentials-key)
# cannot run here: run it on a web server as the service, see infra/README.md.
source "$(dirname "$0")/common.sh"
source "$(dirname "$0")/rds-tunnel.sh"

ROLE=talon_migrate
REF=origin/main
USAGE="usage: db-run.sh [--as talon_migrate|talon_app] [--ref <sha-or-branch>] -- <command...>"
while [ $# -gt 0 ]; do
  case "$1" in
    --as) ROLE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) echo "$USAGE" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "$USAGE" >&2; exit 2; }
case "$ROLE" in talon_migrate | talon_app) ;; *) echo "--as must be talon_migrate or talon_app" >&2; exit 2 ;; esac

REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
git -C "$REPO_ROOT" fetch -q origin
SHA="$(git -C "$REPO_ROOT" rev-parse --verify "$REF^{commit}" 2>/dev/null || git -C "$REPO_ROOT" rev-parse --verify "origin/$REF^{commit}")" \
  || { echo "Unknown ref: $REF" >&2; exit 2; }
echo "db-run: $ROLE at ${SHA:0:12} -> $*"

CHECKOUT_DIR=""
cleanup() { rds_tunnel_close; [ -z "$CHECKOUT_DIR" ] || rm -rf "$CHECKOUT_DIR"; }
trap cleanup EXIT
CHECKOUT_DIR="$(prepare_checkout "$REPO_ROOT" "$SHA")"
rds_tunnel_open
( rds_db_env "$ROLE" && cd "$CHECKOUT_DIR" && "$@" )
