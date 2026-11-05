#!/bin/bash
# One-time RDS setup (roles talon_migrate and talon_app, database "talon",
# grants), run on a web server over SSM. Safe to run again.
# Usage: infra/scripts/db-bootstrap.sh
#
# Order for a new database (web tier plan, phase 2):
#   1. terraform apply with db_bootstrap = true (the web server may sign in
#      as the RDS master user)
#   2. infra/scripts/db-bootstrap.sh
#   3. infra/scripts/deploy.sh <branch>   (migrates as talon_migrate, reseeds)
#   4. terraform apply with db_bootstrap = false
#
# The script runs as root from the deployed commit (`git show`, like
# configure.sh). Master credentials stay on the server: never printed.
source "$(dirname "$0")/common.sh"

ID="$(web_instance_id)"
BOOT='sudo -u talon git -C /opt/talon show HEAD:infra/server/db-bootstrap.sh > /run/talon-db-bootstrap.sh && bash /run/talon-db-bootstrap.sh; rc=$?; rm -f /run/talon-db-bootstrap.sh; exit $rc'
echo "Bootstrapping the database from $ID..."
run_ssm "$ID" "talon db bootstrap" "[\"$BOOT\"]"
