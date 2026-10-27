#!/bin/bash
# Boot script for Talon job instances (launch template user_data, runs as root).
#
# Everything about the job comes from instance tags, so this file is static:
#   talon-job          job id (falls back to manual-<instance id>)
#   talon-bucket       jobs bucket (set by the launch template)
#   talon-max-seconds  time limit for the user's script (default 1800)
# Input (jobs/<id>/input/ in the bucket) is run.sh and, for real jobs,
# repo.tgz (the cloned repository, unpacked to /work/repo).
#
# Flow: fetch input from S3 -> run run.sh as an unprivileged user under
# `timeout` -> upload log, output and status.json -> power off (the launch
# template turns power off into terminate). The instance never accepts a
# connection and never calls the web server; the web server only reads S3.
#
# No `set -e`: every path must reach the upload and the shutdown.
set -uo pipefail
exec > >(tee -a /var/log/talon-job.log) 2>&1

IMDS=http://169.254.169.254/latest
TOKEN=$(curl -fsS -X PUT "$IMDS/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 900")
imds() { curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/$1"; }
tag() { imds "meta-data/tags/instance/$1" 2>/dev/null; }

INSTANCE_ID=$(imds meta-data/instance-id)
export AWS_DEFAULT_REGION=$(imds meta-data/placement/region)
JOB=$(tag talon-job); JOB=${JOB:-manual-$INSTANCE_ID}
BUCKET=$(tag talon-bucket)
MAX=$(tag talon-max-seconds); MAX=${MAX:-1800}
PREFIX="s3://$BUCKET/jobs/$JOB"
START=$(date -u +%FT%TZ)

# Failsafe: if anything below hangs, power off after the limit plus 15 minutes.
systemd-run --unit=talon-failsafe --on-active=$((MAX + 900)) /usr/sbin/shutdown -h now

status() { # state [exit_code] [message]
  printf '{"state":"%s","exit_code":%s,"message":"%s","started_at":"%s","updated_at":"%s","instance_id":"%s"}\n' \
    "$1" "${2:-null}" "${3:-}" "$START" "$(date -u +%FT%TZ)" "$INSTANCE_ID" |
    aws s3 cp - "$PREFIX/status.json" --only-show-errors
}
finish() { sync; shutdown -h now; }
trap finish EXIT

# The AWS CLI is not on the stock AMI (a baked AMI will replace this later).
for i in 1 2 3; do snap install aws-cli --classic && break; sleep 5; done
if ! command -v aws >/dev/null; then echo "no aws cli"; exit 1; fi
if [ -z "$BUCKET" ]; then echo "no talon-bucket tag"; exit 1; fi

# Ubuntu's default apt mirrors are plain HTTP and the security group only lets
# HTTPS out, so switch them to HTTPS.
sed -i 's#http://#https://#g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null

# Untrusted code runs as 'student'. Fail closed: if the instance metadata
# service cannot be blocked for that user, the job does not run.
useradd -m -s /bin/bash student
command -v iptables >/dev/null || { apt-get update -qq && apt-get install -y -qq iptables; }
if ! iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner student -j REJECT; then
  status failed "" "could not block instance metadata"
  exit 1
fi
ip6tables -I OUTPUT -d fd00:ec2::254 -m owner --uid-owner student -j REJECT 2>/dev/null || true

mkdir -p /work/output
if ! aws s3 cp --recursive "$PREFIX/input/" /work --only-show-errors; then
  status failed "" "could not fetch input"
  exit 1
fi
if [ -f /work/repo.tgz ]; then # a Talon job: the cloned repository
  mkdir -p /work/repo && tar -xzf /work/repo.tgz -C /work/repo && rm -f /work/repo.tgz
  # pip and venv are not on the stock image (a baked AMI will replace this).
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq python3-venv python3-pip
fi
if [ ! -f /work/run.sh ]; then # smoke test when launched by hand with no input
  cat > /work/run.sh <<'EOF'
echo "hello from talon job on $(uname -m) at $(date -u +%FT%TZ)"
echo "whoami: $(whoami)"
if curl -sS -m 5 -o /dev/null http://169.254.169.254/latest/meta-data/; then
  echo "SECURITY PROBLEM: instance metadata is reachable"
else
  echo "instance metadata blocked (expected)"
fi
echo hello > output/hello.txt
EOF
fi
chown -R student:student /work

status running
runuser -u student -- bash -c 'cd /work && exec timeout --kill-after=30 "$0" bash run.sh' "$MAX" > /tmp/job.log 2>&1
CODE=$?

case $CODE in
  0)   STATE=succeeded ;;
  124) STATE=timeout ;;
  *)   STATE=failed ;;
esac
aws s3 cp /tmp/job.log "$PREFIX/logs/job.log" --only-show-errors
aws s3 cp --recursive /work/output "$PREFIX/output/" --only-show-errors
status "$STATE" "$CODE"
