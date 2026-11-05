#!/bin/bash
# Forward localhost:<port> (default 8080) to nginx on a web server over SSM.
# Usage: infra/scripts/tunnel.sh [local-port]
# The server is the oldest running one tagged Component=web (common.sh);
# TALON_INSTANCE=<id> picks another.
source "$(dirname "$0")/common.sh"

LOCAL_PORT="${1:-8080}"
ID="$(web_instance_id)"

echo "Talon ($ID) -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
aws ssm start-session \
  --target "$ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
