#!/bin/bash
# Forward localhost:<port> (default 8080) to Talon over SSM.
# Usage: infra/scripts/tunnel.sh [local-port]
#
# Goes through the oldest running web server (common.sh) to the internal ALB,
# which picks a healthy server, so the tunnel works while any one server is
# down. TALON_INSTANCE=<id> picks the server the tunnel passes through.
# TALON_DIRECT=1 skips the ALB and reaches nginx on that server itself
# (debugging one server); so does a stack with no ALB.
# TALON_ALB=public goes to the internet-facing ALB (public_alb.tf) instead of
# the internal one, to test it (it admits only the NAT gateways until Talon
# goes public). Use another local port to have both open:
#   infra/scripts/tunnel.sh 8080                      # internal ALB
#   TALON_ALB=public infra/scripts/tunnel.sh 8081     # public ALB
# TALON_PUBLIC_ALB_NAME overrides the public ALB's name (a second stack).
# TALON_ALB_PORT=443 forwards to the ALB's HTTPS listener (default 80). The
# certificate is for talon.lcps.org, so a browser shows a name warning for
# localhost; to test it properly, map the name to localhost in /etc/hosts and
# open https://talon.lcps.org:<local-port>, or use
#   curl --resolve talon.lcps.org:<local-port>:127.0.0.1 https://talon.lcps.org:<local-port>/api/health/live
source "$(dirname "$0")/common.sh"

LOCAL_PORT="${1:-8080}"
ID="$(web_instance_id)"
ALB=""
if [ "${TALON_DIRECT:-0}" != 1 ]; then
  case "${TALON_ALB:-internal}" in
    internal) ALB="$(web_alb_dns)" ;;
    public) ALB="$(web_public_alb_dns)" ;;
    *) echo "TALON_ALB must be internal or public" >&2; exit 1 ;;
  esac
fi
[ "$ALB" = "None" ] && ALB=""
if [ -z "$ALB" ] && [ "${TALON_ALB:-internal}" = public ] && [ "${TALON_DIRECT:-0}" != 1 ]; then
  echo "No public ALB found (name ${TALON_PUBLIC_ALB_NAME:-talon-public})" >&2
  exit 1
fi

if [ -n "$ALB" ]; then
  echo "Talon (ALB $ALB, via $ID) -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
  aws ssm start-session \
    --target "$ID" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$ALB\"],\"portNumber\":[\"${TALON_ALB_PORT:-80}\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
else
  echo "Talon ($ID directly, no ALB) -> http://localhost:$LOCAL_PORT  (Ctrl-C to close)"
  aws ssm start-session \
    --target "$ID" \
    --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"80\"],\"localPortNumber\":[\"$LOCAL_PORT\"]}"
fi
