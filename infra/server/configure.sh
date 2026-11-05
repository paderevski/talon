#!/bin/bash
# Server configuration that lives in the repo rather than in user_data (so it
# can change without replacing the instance). Run as root by
# infra/scripts/deploy.sh after every deploy; safe to run again.
#
# deploy.sh does not run this from the working tree: it extracts the file from
# the deployed git commit (`git show HEAD:...`) to a root-owned path first.
#
# What it sets up (logging):
# - talon-backend writes its JSON log lines to /var/log/talon/backend.log
#   (CloudWatch: /talon/<env>/backend). Not in journald or syslog any more:
#   `tail -f /var/log/talon/backend.log`, or `aws logs tail` from a laptop.
# - nginx access log in JSON (talon_json), same file as before
#   (/var/log/nginx/access.log, CloudWatch /talon/<env>/nginx-access).
# - nginx sends its $request_id to the backend as X-Request-Id, so an nginx
#   line and the backend's line for the same request share requestId.
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

# Same site as user_data.sh.tftpl writes, plus the JSON access log and the
# request id header. Keep the two in step until user_data next changes.
SITE=/etc/nginx/sites-available/talon
cp -p "$SITE" "$SITE.bak" 2>/dev/null || true
if install_file "$SITE" 644 <<'EOF'
# From infra/server/configure.sh (first written by user_data.sh.tftpl).
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
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }
}
EOF
then
  changed_nginx=true
fi

if $changed_nginx; then
  if nginx -t; then
    systemctl reload nginx
  else
    echo "configure: nginx config test failed; restoring the previous site" >&2
    [ -f "$SITE.bak" ] && mv "$SITE.bak" "$SITE"
    rm -f /etc/nginx/conf.d/talon-logging.conf
    nginx -t && systemctl reload nginx
    exit 1
  fi
fi
rm -f "$SITE.bak"

if $changed_backend; then
  systemctl daemon-reload
  systemctl restart talon-backend
fi

echo "configure: done (backend changed: $changed_backend, nginx changed: $changed_nginx)"
