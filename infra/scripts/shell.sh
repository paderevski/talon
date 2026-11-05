#!/bin/bash
# Interactive shell on a web server via SSM (no SSH keys or port 22).
# Usage: infra/scripts/shell.sh [instance-id]
# Without an id: TALON_INSTANCE, else the oldest running web server
# (common.sh). The others are listed so you can pick one.
# Useful: tail -f /var/log/talon/backend.log
#         sudo tail -f /var/log/talon-bootstrap.log
source "$(dirname "$0")/common.sh"

if [ -n "${1:-}" ]; then
  ID="$1"
else
  ID="$(web_instance_id)"
  OTHERS="$(web_instance_ids | grep -vx "$ID" || true)"
  [ -n "$OTHERS" ] && echo "Other web servers: $(echo $OTHERS)"
fi
aws ssm start-session --target "$ID"
