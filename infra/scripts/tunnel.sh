#!/bin/bash
# Forward localhost:<port> (default 8080) to Talon over SSM.
# Usage: infra/scripts/tunnel.sh [local-port]
#
# Goes through the oldest running web server (common.sh) to the internal ALB,
# which picks a healthy server, so the tunnel works while any one server is
# down. TALON_INSTANCE=<id> picks the server the tunnel passes through.
# TALON_DIRECT=1 skips the ALB and reaches nginx on that server itself
# (debugging one server); so does a stack with no ALB.
source "$(dirname "$0")/common.sh"

LOCAL_PORT="${1:-8080}"
ID="$(web_instance_id)"
ALB=""
[ "${TALON_DIRECT:-0}" = 1 ] || ALB="$(web_alb_dns)"
[ "$ALB" = "None" ] && ALB=""

if [ -n "$ALB" ]; then
  echo "Talon (ALB $ALB, via $ID) -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
  aws ssm start-session \
    --target "$ID" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$ALB\"],\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
else
  echo "Talon ($ID directly, no ALB) -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
  aws ssm start-session \
    --target "$ID" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
fi
