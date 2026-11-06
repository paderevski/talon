#!/bin/bash
# Web server configuration that lives in the repo rather than in user_data
# (so it can change without replacing a server). Run as root by
# /usr/local/bin/talon-configure (written by infra/ec2/web_user_data.sh.tftpl)
# at the end of every talon-deploy (first boot and infra/scripts/deploy.sh);
# safe to run again.
#
# Never run from the working tree: the file is extracted from the deployed
# git commit (`git show HEAD:...`) to a root-owned path first.
#
# What it sets up:
# - nginx: Talon's site (static frontend, /api proxied to the backend), enabled
#   in place of nginx's default site.
# - talon-backend writes its JSON log lines to /var/log/talon/backend.log
#   (CloudWatch: /talon/<env>/backend). Not in journald or syslog any more:
#   `tail -f /var/log/talon/backend.log`, or `aws logs tail` from a laptop.
# - nginx access log in JSON (talon_json), same file as before
#   (/var/log/nginx/access.log, CloudWatch /talon/<env>/nginx-access).
# - nginx sends its $request_id to the backend as X-Request-Id, so an nginx
#   line and the backend's line for the same request share requestId.
#
# - CloudWatch agent: installed if missing; config loaded from the SSM
#   parameter in CW_AGENT_CONFIG_PARAM (/etc/talon/talon.env) when it changed.
#   Failures here are reported, never fatal (logs and metrics go missing, the
#   site keeps working).
#
# And proxy headers for the internal ALB in front (alb.tf):
# - nginx passes on X-Forwarded-Proto when the request came from inside the
#   VPC (the ALB), instead of overwriting it with its own "http".
# - the backend trusts loopback plus the VPC range as proxies
#   (TALON_TRUSTED_PROXIES), so req.ip is the client, not the ALB.
set -euo pipefail

changed_backend=false
changed_nginx=false

# install_file <path> <mode>: writes stdin to <path> if different; returns 0
# when the file changed.
install_file() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  echo "configure: updated $path"
  return 0
}

# --- backend log file -------------------------------------------------------
install -d -o root -g adm -m 750 /var/log/talon

if install_file /etc/systemd/system/talon-backend.service.d/logging.conf 644 <<'EOF'
# From infra/server/configure.sh. Backend output goes to a file that the
# CloudWatch agent ships to /talon/<env>/backend.
[Service]
Environment=TALON_LOG_FORMAT=json
StandardOutput=append:/var/log/talon/backend.log
StandardError=append:/var/log/talon/backend.log
EOF
then
  changed_backend=true
fi

# copytruncate: the service keeps its file open (systemd opened it).
install_file /etc/logrotate.d/talon-backend 644 <<'EOF' || true
/var/log/talon/backend.log {
    daily
    maxsize 100M
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF

# --- VPC range: the only place a load balancer can connect from --------------
# Read from instance metadata (IMDSv2). Empty if that fails: then only
# loopback is trusted, which is the old behaviour and safe.
imds() {
  local token
  token="$(curl -sf -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" || return 1
  curl -sf -m 2 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
VPC_CIDR="$(imds "network/interfaces/macs/$(imds mac)/vpc-ipv4-cidr-block" 2>/dev/null || true)"
if ! [[ "$VPC_CIDR" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]]; then
  echo "configure: could not read the VPC range from instance metadata; trusting loopback only" >&2
  VPC_CIDR=""
fi

if install_file /etc/systemd/system/talon-backend.service.d/proxy.conf 644 <<EOF
# From infra/server/configure.sh. Proxies whose X-Forwarded-* headers the
# backend believes: nginx (loopback) and the load balancer (this VPC).
[Service]
Environment=TALON_TRUSTED_PROXIES=loopback${VPC_CIDR:+,$VPC_CIDR}
EOF
then
  changed_backend=true
fi

# --- nginx: JSON access log, request id to the backend -----------------------
# $uri has no query string (the GitHub callback carries an OAuth code there).
# No referer either, for the same reason.
if install_file /etc/nginx/conf.d/talon-logging.conf 644 <<'EOF'
# From infra/server/configure.sh.
log_format talon_json escape=json
  '{"time":"$time_iso8601","requestId":"$request_id","remoteAddr":"$remote_addr",'
  '"forwardedFor":"$http_x_forwarded_for","method":"$request_method","path":"$uri",'
  '"status":$status,"bytes":$body_bytes_sent,"requestTime":$request_time,'
  '"upstreamTime":"$upstream_response_time","upstreamStatus":"$upstream_status",'
  '"userAgent":"$http_user_agent"}';
EOF
then
  changed_nginx=true
fi

# X-Forwarded-Proto for the backend: the ALB's value when the request came
# from inside the VPC (only the ALB can connect from there once the web
# security group admits it), nginx's own $scheme otherwise (the SSM tunnel
# arrives on loopback, so a tunnel client cannot claim https).
GEO_VPC_LINE=""
[ -n "$VPC_CIDR" ] && GEO_VPC_LINE="    $VPC_CIDR 1;"
if { cat <<'EOF'; echo "$GEO_VPC_LINE"; cat <<'EOF2'; } | install_file /etc/nginx/conf.d/talon-proxy.conf 644
# From infra/server/configure.sh.
geo $talon_from_vpc {
    default 0;
EOF
}

map "$talon_from_vpc:$http_x_forwarded_proto" $talon_forwarded_proto {
    default $scheme;
    "~^1:(?<talon_proto>https?)$" $talon_proto;
}
EOF2
then
  changed_nginx=true
fi

# Talon's site, with the JSON access log, the request id header and the
# forwarded protocol, enabled in place of nginx's default site.
SITE=/etc/nginx/sites-available/talon
cp -p "$SITE" "$SITE.bak" 2>/dev/null || true
if install_file "$SITE" 644 <<'EOF'
# From infra/server/configure.sh.
server {
    listen 80 default_server;
    server_name _;

    access_log /var/log/nginx/access.log talon_json;

    root /opt/talon/frontend/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5174/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $talon_forwarded_proto;
        proxy_set_header X-Request-Id $request_id;
        # Match the load balancer's idle timeout (alb_idle_timeout_seconds in
        # infra/ec2/alb.tf, 180 s). nginx's 60 s default would cut off a slow
        # job submit (clone, upload, launch) or roster import first.
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }
}
EOF
then
  changed_nginx=true
fi
if [ "$(readlink /etc/nginx/sites-enabled/talon 2>/dev/null)" != "$SITE" ] || [ -e /etc/nginx/sites-enabled/default ]; then
  ln -sfn "$SITE" /etc/nginx/sites-enabled/talon
  rm -f /etc/nginx/sites-enabled/default
  echo "configure: enabled the talon site"
  changed_nginx=true
fi

if $changed_nginx; then
  if nginx -t; then
    systemctl reload nginx
  else
    echo "configure: nginx config test failed; restoring the previous site" >&2
    if [ -f "$SITE.bak" ]; then
      mv "$SITE.bak" "$SITE"
    else # first run: back to nginx's default site
      rm -f /etc/nginx/sites-enabled/talon
      ln -sfn /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    fi
    rm -f /etc/nginx/conf.d/talon-logging.conf /etc/nginx/conf.d/talon-proxy.conf
    nginx -t && systemctl reload nginx
    exit 1
  fi
fi
rm -f "$SITE.bak"

if $changed_backend; then
  systemctl daemon-reload
  systemctl restart talon-backend
fi

# --- CloudWatch agent (monitoring.tf) ----------------------------------------
# Never fatal: a failure here costs logs and metrics, not the site.
changed_cwa=false
cloudwatch_agent() {
  local param region cwa=/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl want have
  param="$(sed -n 's/^CW_AGENT_CONFIG_PARAM=//p' /etc/talon/talon.env 2>/dev/null | tail -1)"
  if [ -z "$param" ]; then
    echo "configure: no CW_AGENT_CONFIG_PARAM in /etc/talon/talon.env; CloudWatch agent skipped"
    return 0
  fi
  region="$(imds placement/region)" || { echo "configure: no region from instance metadata; CloudWatch agent skipped" >&2; return 1; }
  if [ ! -x "$cwa" ]; then
    curl -fsSL "https://amazoncloudwatch-agent-$region.s3.$region.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb" \
      -o /run/amazon-cloudwatch-agent.deb &&
      apt-get install -y -q -o DPkg::Lock::Timeout=600 /run/amazon-cloudwatch-agent.deb >/dev/null
    rm -f /run/amazon-cloudwatch-agent.deb
    [ -x "$cwa" ] || { echo "configure: CloudWatch agent install failed" >&2; return 1; }
    echo "configure: installed the CloudWatch agent"
  fi
  want="$(/snap/bin/aws ssm get-parameter --region "$region" --name "$param" --query Parameter.Value --output text | sha256sum)" ||
    { echo "configure: cannot read $param" >&2; return 1; }
  have="$(cat /etc/talon/cw-agent-config.sha256 2>/dev/null || true)"
  if [ "$want" != "$have" ] || ! systemctl is-active --quiet amazon-cloudwatch-agent; then
    "$cwa" -a fetch-config -m ec2 -s -c "ssm:$param" >/dev/null ||
      { echo "configure: CloudWatch agent config failed" >&2; return 1; }
    echo "$want" > /etc/talon/cw-agent-config.sha256
    changed_cwa=true
  fi
}
cloudwatch_agent || true

echo "configure: done (backend changed: $changed_backend, nginx changed: $changed_nginx, cloudwatch agent changed: $changed_cwa)"
