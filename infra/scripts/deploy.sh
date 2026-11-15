#!/bin/bash
# Pull, build, migrate and restart Talon on every web server via SSM Run
# Command, one server at a time. Deploys what is pushed to GitHub, not your
# local working tree. Data is never touched (Talon is live: no reseed).
# Usage: infra/scripts/deploy.sh [branch]
#
# Web servers are found by tag (common.sh, web_instance_ids). The first
# server's deploy applies any new migrations; the others find them applied.
# Old and new versions run side by side against one database until the last
# server is done (see the web tier plan), so a migration must not break the
# code still running on the other server.
#
# --keep-data is still accepted (it was needed before go-live, when deploys
# reseeded demo data) and does nothing.
source "$(dirname "$0")/common.sh"

REF="main"
USAGE="usage: deploy.sh [branch]"
for arg in "$@"; do
  case "$arg" in
    --keep-data) ;;
    -*) echo "Unknown option: $arg ($USAGE)" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done
case "$REF" in
  *[!A-Za-z0-9._/-]*) echo "Unexpected characters in branch name: $REF" >&2; exit 2 ;;
esac

ID_LIST="$(web_instance_ids)" # macOS bash 3.2: no mapfile
IDS=($ID_LIST)

# talon-deploy (web_user_data.sh.tftpl) builds, migrates, applies the repo's
# server config (infra/server/configure.sh, via talon-configure) and restarts.

echo "Deploying $REF to ${#IDS[@]} web server(s): ${IDS[*]}"
n=0
for ID in "${IDS[@]}"; do
  n=$((n + 1))
  echo "--- [$n/${#IDS[@]}] $ID"
  run_ssm "$ID" "talon deploy $REF" "[\"set -e\",\"/usr/local/bin/talon-deploy $REF\"]" \
    || { echo "Deploy failed on $ID; servers after it still run the previous version." >&2; exit 1; }
done

echo "Deploy of $REF done."
