#!/bin/bash
# One-time RDS setup (roles talon_migrate and talon_app, database "talon",
# grants), run on a web server over SSM. Safe to run again.
# Usage: infra/scripts/db-bootstrap.sh
#
# Order for a new database (web tier plan, phase 2):
#   1. terraform apply with db_bootstrap = true (the web server may sign in
#      as the RDS master user)
#   2. infra/scripts/db-bootstrap.sh
#   3. infra/scripts/deploy.sh <branch>   (migrates as talon_migrate from your laptop)
#   4. terraform apply with db_bootstrap = false
#
# The script runs as root from the deployed commit, taken from the root-owned
# clone (talon-repo-script, like configure.sh). Master credentials stay on the
# server: never printed.
source "$(dirname "$0")/common.sh"

ID="$(web_instance_id)"
BOOT="/usr/local/bin/talon-repo-script infra/server/db-bootstrap.sh"
echo "Bootstrapping the database from $ID..."
run_ssm "$ID" "talon db bootstrap" "[\"$BOOT\"]"
