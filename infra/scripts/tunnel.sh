#!/bin/bash
# Forward localhost:<port> (default 8080) to nginx on the instance over SSM.
# Usage: infra/scripts/tunnel.sh [local-port]
source "$(dirname "$0")/common.sh"

LOCAL_PORT="${1:-8080}"
ID="$(instance_id)"

echo "Talon -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
aws ssm start-session \
  --target "$ID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
