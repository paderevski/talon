#!/bin/bash
# Pull, build, migrate and restart Talon on every web server via SSM Run
# Command, one server at a time, then reset the database to fresh demo data.
# Deploys what is pushed to GitHub, not your local working tree.
# Usage: infra/scripts/deploy.sh [branch] [--keep-data]
#
# Web servers are found by tag (common.sh, web_instance_ids). The first
# server's deploy applies any new migrations; the others find them applied.
# Old and new versions run side by side against one database until the last
# server is done, which the demo accepts (see the web tier plan).
#
# The demo data is disposable, so every deploy reseeds it by default, once,
# on the first server, after all servers run the new code: all users, classes,
# jobs and sessions are replaced (everyone is signed out, GitHub links must
# be reconnected, and the reconciler terminates any job instance still
# running). --keep-data skips the reseed.
source "$(dirname "$0")/common.sh"

REF="main"
RESEED=1
for arg in "$@"; do
  case "$arg" in
    --keep-data) RESEED=0 ;;
    -*) echo "Unknown option: $arg (usage: deploy.sh [branch] [--keep-data])" >&2; exit 2 ;;
    *) REF="$arg" ;;
  esac
done
case "$REF" in
  *[!A-Za-z0-9._/-]*) echo "Unexpected characters in branch name: $REF" >&2; exit 2 ;;
esac

ID_LIST="$(web_instance_ids)" # macOS bash 3.2: no mapfile
IDS=($ID_LIST)

# After the deploy, apply the repo's server config (infra/server/configure.sh:
# logging, proxy headers). It runs as root, so it is taken from the deployed
# commit with `git show`, not from the working tree the talon user can write
# to. Older branches without the file skip it.
CONFIGURE='if sudo -u talon git -C /opt/talon cat-file -e HEAD:infra/server/configure.sh 2>/dev/null; then sudo -u talon git -C /opt/talon show HEAD:infra/server/configure.sh > /run/talon-configure.sh && bash /run/talon-configure.sh; fi'

# Wipes and reseeds the demo data (backend/src/db/seedDemo.js, replaceAll).
SEED='sudo -u talon bash -c '"'"'set -a; . /etc/talon/talon.env; . /etc/talon/secrets.env; set +a; cd /opt/talon && npm run --silent db:seed:demo --workspace backend -- --replace-all'"'"''

echo "Deploying $REF to ${#IDS[@]} web server(s): ${IDS[*]}"
n=0
for ID in "${IDS[@]}"; do
  n=$((n + 1))
  echo "--- [$n/${#IDS[@]}] $ID"
  run_ssm "$ID" "talon deploy $REF" "[\"set -e\",\"/usr/local/bin/talon-deploy $REF\",\"$CONFIGURE\"]" \
    || { echo "Deploy failed on $ID; servers after it still run the previous version." >&2; exit 1; }
done

if [ "$RESEED" = 1 ]; then
  echo "--- reseeding demo data (on ${IDS[0]})"
  run_ssm "${IDS[0]}" "talon reseed demo data" "[\"set -e\",\"$SEED\"]" || { echo "Reseed failed" >&2; exit 1; }
else
  echo "--- keeping data (no reseed)"
fi
echo "Deploy of $REF done."
