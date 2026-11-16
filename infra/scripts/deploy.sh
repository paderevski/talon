#!/bin/bash
# Migrate from this laptop, then pull, build and restart Talon on every web
# server via SSM Run Command, one server at a time. Deploys what is pushed to
# GitHub, not your local working tree. Data is never touched (Talon is live:
# no reseed).
# Usage: infra/scripts/deploy.sh [branch] [--no-migrate]
#
# Migrations run first, here, as talon_migrate with your own AWS credentials
# (SSM tunnel through a web server, IAM token: rds-tunnel.sh), from the exact
# commit being deployed. The web servers cannot sign in as the schema owner,
# so they never migrate. A failed migration stops the deploy before any
# server changes. --no-migrate skips the step (nothing to apply, or the
# migration was run by hand with db-run.sh).
#
# Web servers are found by tag (common.sh, web_instance_ids). Old and new
# versions run side by side against one database until the last server is
# done (see the web tier plan), so a migration must not break the code still
# running on the servers not yet deployed.
#
# --keep-data is still accepted (it was needed before go-live, when deploys
# reseeded demo data) and does nothing.
source "$(dirname "$0")/common.sh"
source "$(dirname "$0")/rds-tunnel.sh"

REF="main"
MIGRATE=true
USAGE="usage: deploy.sh [branch] [--no-migrate]"
for arg in "$@"; do
  case "$arg" in
    --keep-data) ;;
    --no-migrate) MIGRATE=false ;;
    -*) echo "Unknown option: $arg ($USAGE)" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done
case "$REF" in
  *[!A-Za-z0-9._/-]*) echo "Unexpected characters in branch name: $REF" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$INFRA_DIR/.." && pwd)"
# The servers pull from GitHub, so the commit is the branch's tip there.
SHA="$(git -C "$REPO_ROOT" ls-remote origin "refs/heads/$REF" | cut -f1)"
[ -n "$SHA" ] || { echo "Branch $REF is not on origin (push it first)" >&2; exit 2; }
git -C "$REPO_ROOT" cat-file -e "$SHA^{commit}" 2>/dev/null || git -C "$REPO_ROOT" fetch -q origin "$REF"

if $MIGRATE; then
  echo "Migrating from this machine as talon_migrate (commit ${SHA:0:12})..."
  CHECKOUT_DIR=""
  cleanup() { rds_tunnel_close; [ -z "$CHECKOUT_DIR" ] || rm -rf "$CHECKOUT_DIR"; }
  trap cleanup EXIT
  CHECKOUT_DIR="$(prepare_checkout "$REPO_ROOT" "$SHA")"
  rds_tunnel_open
  ( rds_db_env talon_migrate && cd "$CHECKOUT_DIR" && npm run db:migrate --workspace backend ) \
    || { echo "Migration failed; no server was changed." >&2; exit 1; }
  rds_tunnel_close
fi

ID_LIST="$(web_instance_ids)" # macOS bash 3.2: no mapfile
IDS=($ID_LIST)

# talon-deploy (web_user_data.sh.tftpl) builds, applies the repo's server
# config (infra/server/configure.sh, via talon-configure) and restarts.

echo "Deploying $REF to ${#IDS[@]} web server(s): ${IDS[*]}"
n=0
for ID in "${IDS[@]}"; do
  n=$((n + 1))
  echo "--- [$n/${#IDS[@]}] $ID"
  run_ssm "$ID" "talon deploy $REF" "[\"set -e\",\"/usr/local/bin/talon-deploy $REF\"]" \
    || { echo "Deploy failed on $ID; servers after it still run the previous version." >&2; exit 1; }
done

echo "Deploy of $REF done."
