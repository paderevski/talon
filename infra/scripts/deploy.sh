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
# be reconnected). --keep-data skips the reseed. The reseed refuses while EC2
# jobs are queued or running (it would delete them and the reconciler would
# terminate their instances): the code is then deployed and the data kept.
# --allow-running-jobs reseeds anyway.
source "$(dirname "$0")/common.sh"

REF="main"
RESEED=1
SEED_ARGS="--replace-all"
USAGE="usage: deploy.sh [branch] [--keep-data] [--allow-running-jobs]"
for arg in "$@"; do
  case "$arg" in
    --keep-data) RESEED=0 ;;
    --allow-running-jobs) SEED_ARGS="--replace-all --allow-running-jobs" ;;
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

# Wipes and reseeds the demo data (backend/src/db/seedDemo.js, replaceAll).
SEED='sudo -u talon bash -c '"'"'set -a; . /etc/talon/talon.env; . /etc/talon/secrets.env; set +a; cd /opt/talon && npm run --silent db:seed:demo --workspace backend -- '"$SEED_ARGS"''"'"''

echo "Deploying $REF to ${#IDS[@]} web server(s): ${IDS[*]}"
n=0
for ID in "${IDS[@]}"; do
  n=$((n + 1))
  echo "--- [$n/${#IDS[@]}] $ID"
  run_ssm "$ID" "talon deploy $REF" "[\"set -e\",\"/usr/local/bin/talon-deploy $REF\"]" \
    || { echo "Deploy failed on $ID; servers after it still run the previous version." >&2; exit 1; }
done

if [ "$RESEED" = 1 ]; then
  echo "--- reseeding demo data (on ${IDS[0]})"
  run_ssm "${IDS[0]}" "talon reseed demo data" "[\"set -e\",\"$SEED\"]" || {
    echo "Reseed failed or refused (see above). $REF is deployed; the data was kept." >&2
    echo "If EC2 jobs are running: wait or cancel them, or rerun with --allow-running-jobs." >&2
    exit 1
  }
else
  echo "--- keeping data (no reseed)"
fi
echo "Deploy of $REF done."
