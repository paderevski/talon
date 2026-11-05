#!/bin/bash
# Boot script for Talon job instances (launch template user_data, runs as root).
#
# Everything about the job comes from instance tags, so this file is static:
#   talon-job          job id (falls back to manual-<instance id>)
#   talon-s3-prefix    this launch's S3 folder, jobs/<id>-<random> (falls
#                      back to jobs/<id> for launches from before it existed)
#   talon-bucket       jobs bucket (set by the launch template)
#   talon-max-seconds  time limit for the user's script (default 1800)
#   talon-image        cpu or gpu (PyTorch DLAMI); set by the launch template
#   talon-log-group    CloudWatch log group for this boot log; set by the
#                      launch template (empty: S3 only)
# Input (<folder>/input/ in the bucket) is run.sh and, for real jobs,
# repo.tgz (the cloned repository, unpacked to /work/repo).
#
# Flow: fetch input from S3 -> run run.sh as an unprivileged user under
# `timeout` -> upload log, output and status.json -> power off (the launch
# template turns power off into terminate). The instance never accepts a
# connection and never calls the web server; the web server only reads S3.
#
# Logs: this script's own output (not the student's) is the boot log,
# /var/log/talon-job.log, one "<UTC time> <line>" per line. It goes to
# CloudWatch every 15 seconds (stream <job id>/<instance id>) and to S3 as
# logs/boot.log at the end, on every exit path. The last line is a JSON
# summary (event job.boot_summary) with the result and phase timings. The
# student's output is /tmp/job.log -> S3 logs/job.log only.
#
# No `set -e`: every path must reach the upload and the shutdown.
set -uo pipefail
BOOT_LOG=/var/log/talon-job.log
T0=$(date +%s)
UPTIME_AT_START=$(cut -d' ' -f1 /proc/uptime) # kernel boot -> this script
exec > >(
  export TZ=UTC
  while IFS= read -r line || [ -n "$line" ]; do printf '%(%Y-%m-%dT%H:%M:%SZ)T %s\n' -1 "$line"; done | tee -a "$BOOT_LOG"
) 2>&1

# Ships new complete lines of the boot log to CloudWatch Logs with the AWS
# CLI (no agent to install). Usage: talon-cwlog GROUP STREAM FILE OFFSET_FILE.
# Keeps its byte offset in OFFSET_FILE, so each line is sent once; a failed
# send is retried on the next call.
cat > /usr/local/sbin/talon-cwlog <<'PY'
import calendar, json, os, re, subprocess, sys, tempfile, time

group, stream, path, offset_file = sys.argv[1:5]
MAX_SHIPPED = 20 * 1024 * 1024  # a boot log is far smaller; a runaway one stops here
try:
    offset = int(open(offset_file).read())
except (OSError, ValueError):
    offset = -1  # first call: create the stream
if offset < 0:
    r = subprocess.run(["aws", "logs", "create-log-stream", "--log-group-name", group, "--log-stream-name", stream],
                       capture_output=True, text=True)
    if r.returncode != 0 and "ResourceAlreadyExists" not in r.stderr:
        print("talon-cwlog: create-log-stream failed: " + r.stderr.strip()[:300], file=sys.stderr)
        sys.exit(1)
    offset = 0
    open(offset_file, "w").write("0")
if offset >= MAX_SHIPPED:
    sys.exit(0)
with open(path, "rb") as f:
    f.seek(offset)
    data = f.read(MAX_SHIPPED - offset)
end = data.rfind(b"\n")
if end < 0:
    sys.exit(0)

stamp = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) ?(.*)$", re.S)
last_ms = int(time.time() * 1000)
events = []
for raw in data[: end + 1].split(b"\n")[:-1]:
    line = raw.decode("utf-8", "replace").rstrip("\r")
    m = stamp.match(line)
    if m:
        last_ms = calendar.timegm(time.strptime(m.group(1), "%Y-%m-%dT%H:%M:%SZ")) * 1000
        line = m.group(2)
    events.append({"timestamp": last_ms, "message": line[:200000] or " "})
# Events in a batch must be in time order; lines are, but keep it so.
for i in range(1, len(events)):
    events[i]["timestamp"] = max(events[i]["timestamp"], events[i - 1]["timestamp"])

def put(batch):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tmp:
        json.dump(batch, tmp)
    try:
        r = subprocess.run(["aws", "logs", "put-log-events", "--log-group-name", group, "--log-stream-name", stream,
                            "--log-events", "file://" + tmp.name], capture_output=True, text=True)
    finally:
        os.unlink(tmp.name)
    if r.returncode != 0:
        print("talon-cwlog: put-log-events failed: " + r.stderr.strip()[:300], file=sys.stderr)
    return r.returncode == 0

# Limits per call: 10,000 events and 1 MiB (message bytes + 26 per event).
batch, size = [], 0
for e in events:
    n = len(e["message"].encode()) + 26
    if batch and (len(batch) >= 5000 or size + n > 900_000):
        if not put(batch):
            sys.exit(1)  # offset not advanced: the whole chunk is retried (duplicates are possible, gaps are not)
        batch, size = [], 0
    batch.append(e)
    size += n
if batch and not put(batch):
    sys.exit(1)
open(offset_file, "w").write(str(offset + end + 1))
PY

IMDS=http://169.254.169.254/latest
TOKEN=$(curl -fsS -X PUT "$IMDS/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 900")
imds() { curl -fsS -H "X-aws-ec2-metadata-token: $TOKEN" "$IMDS/$1"; }
tag() { imds "meta-data/tags/instance/$1" 2>/dev/null; }

INSTANCE_ID=$(imds meta-data/instance-id)
export AWS_DEFAULT_REGION=$(imds meta-data/placement/region)
JOB=$(tag talon-job); JOB=${JOB:-manual-$INSTANCE_ID}
BUCKET=$(tag talon-bucket)
MAX=$(tag talon-max-seconds); MAX=${MAX:-1800}
IMAGE=$(tag talon-image); IMAGE=${IMAGE:-cpu}
LOG_GROUP=$(tag talon-log-group)
INSTANCE_TYPE=$(imds meta-data/instance-type)
S3P=$(tag talon-s3-prefix)
[[ "$S3P" =~ ^jobs/[A-Za-z0-9-]+$ ]] || S3P="jobs/$JOB"
PREFIX="s3://$BUCKET/$S3P"
START=$(date -u +%FT%TZ)
echo "[talon] job $JOB on $INSTANCE_ID ($INSTANCE_TYPE, image $IMAGE), ${UPTIME_AT_START}s after kernel boot"

# For the summary line (emit_summary).
RESULT=setup_failed; EXIT_CODE=null; FAIL_MESSAGE=""; T_RUN=""; T_DONE=""; SKIPPED=0; SCRATCH_KIND=""
SHIP_LOOP=""; SUMMARY_DONE=false

ship_boot_log() {
  [ -n "$LOG_GROUP" ] && command -v aws >/dev/null || return 0
  flock -w 30 /run/talon-cwlog.lock \
    python3 /usr/local/sbin/talon-cwlog "$LOG_GROUP" "$JOB/$INSTANCE_ID" "$BOOT_LOG" /run/talon-cwlog.offset || true
}

# One JSON line (no spaces in the values printed raw): Logs Insights can then
# chart setup and run times by instance type and find failed boots.
emit_summary() {
  $SUMMARY_DONE && return 0
  SUMMARY_DONE=true
  local now setup run
  now=$(date +%s)
  setup=null; run=null
  [ -n "$T_RUN" ] && setup=$((T_RUN - T0))
  [ -n "$T_RUN" ] && [ -n "$T_DONE" ] && run=$((T_DONE - T_RUN))
  printf '{"event":"job.boot_summary","jobId":"%s","instanceId":"%s","instanceType":"%s","image":"%s","result":"%s","exitCode":%s,"message":"%s","bootSeconds":%s,"setupSeconds":%s,"runSeconds":%s,"totalSeconds":%s,"skippedFiles":%s,"scratch":"%s"}\n' \
    "$JOB" "$INSTANCE_ID" "$INSTANCE_TYPE" "$IMAGE" "$RESULT" "$EXIT_CODE" "$FAIL_MESSAGE" \
    "${UPTIME_AT_START%.*}" "$setup" "$run" "$((now - T0))" "$SKIPPED" "$SCRATCH_KIND"
}

# Failsafe: if anything below hangs, power off after the limit plus 15 minutes.
systemd-run --unit=talon-failsafe --on-active=$((MAX + 900)) /usr/sbin/shutdown -h now

status() { # state [exit_code] [message]
  [ "$1" = failed ] && [ -n "${3:-}" ] && FAIL_MESSAGE=$3
  printf '{"state":"%s","exit_code":%s,"message":"%s","started_at":"%s","updated_at":"%s","instance_id":"%s"}\n' \
    "$1" "${2:-null}" "${3:-}" "$START" "$(date -u +%FT%TZ)" "$INSTANCE_ID" |
    aws s3 cp - "$PREFIX/status.json" --only-show-errors
}
# Every exit path: summary, last log lines to CloudWatch, boot.log to S3,
# power off.
finish() {
  [ -n "$SHIP_LOOP" ] && kill "$SHIP_LOOP" 2>/dev/null
  emit_summary
  sleep 1 # let the timestamping pipe write the last lines
  ship_boot_log
  if command -v aws >/dev/null && [ -n "$BUCKET" ]; then
    aws s3 cp "$BOOT_LOG" "$PREFIX/logs/boot.log" --only-show-errors
  fi
  sync; shutdown -h now
}
trap finish EXIT

# The AWS CLI is not on the stock Ubuntu AMI (a baked AMI will replace this
# later); the Deep Learning AMIs may already have it.
if ! command -v aws >/dev/null; then
  for i in 1 2 3; do snap install aws-cli --classic && break; sleep 5; done
fi
if ! command -v aws >/dev/null; then echo "no aws cli"; exit 1; fi
if [ -z "$BUCKET" ]; then echo "no talon-bucket tag"; exit 1; fi
ship_boot_log
( while sleep 15; do ship_boot_log; done ) &
SHIP_LOOP=$!

# apt: the security group only lets HTTPS out, and the instance has no IPv6
# route. Ubuntu's default sources are HTTP, and on arm64 the regional EC2 mirror
# (<region>.ec2.ports.ubuntu.com) does not serve HTTPS at all, so use the
# global mirror over HTTPS and IPv4 only.
sed -E -i 's#https?://([a-z0-9-]+\.ec2\.)?#https://#g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99talon-ipv4

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
  # The PyTorch DLAMI has its own Python with venv (run.sh uses it).
  if [ "$IMAGE" != gpu ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq python3-venv python3-pip
  fi
fi
if [ "$IMAGE" != cpu ]; then # the driver can take a moment after boot
  for i in $(seq 1 30); do nvidia-smi >/dev/null 2>&1 && break; sleep 2; done
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || echo "nvidia-smi failed"
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
# Scratch space for large data (TALON_SCRATCH_DIR in run.sh; never uploaded).
# GPU types have a local NVMe instance-store drive, included in the price and
# erased when the instance ends: use it when there is one, else a folder on the
# root volume. Any failure here falls back to the root volume.
SCRATCH_KIND="root volume"
mkdir -p /work/scratch
if mountpoint -q /opt/dlami/nvme; then # some Deep Learning AMIs mount it here themselves
  mkdir -p /opt/dlami/nvme/talon-scratch &&
    mount --bind /opt/dlami/nvme/talon-scratch /work/scratch && SCRATCH_KIND="instance NVMe"
else
  for dev in /dev/nvme*n1; do
    [ -b "$dev" ] || continue
    grep -q "Instance Storage" "/sys/block/${dev#/dev/}/device/model" 2>/dev/null || continue
    findmnt -rn -S "$dev" >/dev/null && continue # already in use
    if mkfs.ext4 -q -F -E nodiscard "$dev" && mount -o noatime "$dev" /work/scratch; then
      SCRATCH_KIND="instance NVMe"
      break
    fi
  done
fi
echo "scratch: /work/scratch on $SCRATCH_KIND"

chown -R student:student /work
touch /work/.talon-start # files newer than this were created or changed by the job

# Output has two sources, as with the local runner: /work/output (the script
# writes there via TALON_OUTPUT_DIR) and files created or changed in the
# repository directory. Both are uploaded every 30 seconds while the job runs
# (so a cancel or a crash keeps what was already saved) and once more at the
# end. Limits protect the bucket; anything over them is skipped and noted in
# the job log.
MAX_FILES=500
MAX_FILE_BYTES=$((200 * 1024 * 1024))
MAX_TOTAL_BYTES=$((500 * 1024 * 1024))
STATE=/tmp/uploaded.state; : > "$STATE"

# upload_tree DIR DEST [find tests...]: upload regular files (never symlinks)
# not already uploaded in their current size and mtime.
upload_tree() {
  local dir=$1 dest=$2 f size mtime rel key n total
  shift 2
  n=$(wc -l < "$STATE"); total=$(awk -F'|' '{s += $2} END {print s + 0}' "$STATE")
  while IFS= read -r -d '' f; do
    size=$(stat -c %s "$f" 2>/dev/null) || continue
    mtime=$(stat -c %Y "$f" 2>/dev/null) || continue
    rel=${f#"$dir"/}; key="$dest/$rel|$size|$mtime"
    grep -qxF -- "$key" "$STATE" && continue
    if [ "$size" -gt "$MAX_FILE_BYTES" ] || [ "$n" -ge "$MAX_FILES" ] || [ $((total + size)) -gt "$MAX_TOTAL_BYTES" ]; then
      SKIPPED=$((SKIPPED + 1)); continue
    fi
    if aws s3 cp "$f" "$dest/$rel" --only-show-errors; then
      echo "$key" >> "$STATE"; n=$((n + 1)); total=$((total + size))
    fi
  done < <(find "$dir" -type f "$@" -print0 2>/dev/null)
}

sync_all() {
  aws s3 cp /tmp/job.log "$PREFIX/logs/job.log" --only-show-errors 2>/dev/null
  upload_tree /work/output "$PREFIX/output"
  upload_tree /work/repo "$PREFIX/changed" -newer /work/.talon-start \
    ! -path '*/.git/*' ! -path '*/__pycache__/*' ! -name '*.pyc' ! -path '*/node_modules/*' \
    ! -path '*/.venv/*' ! -path '*/venv/*' ! -path '*/.ipynb_checkpoints/*'
}

status running
: > /tmp/job.log
echo "[talon] TALON_SCRATCH_DIR=/work/scratch: $SCRATCH_KIND, $(df -h --output=avail /work/scratch | tail -1 | tr -d ' ') free, not saved" >> /tmp/job.log
( while sleep 30; do sync_all; done ) &
LOOP=$!
T_RUN=$(date +%s)
echo "[talon] setup took $((T_RUN - T0))s; running the job (limit ${MAX}s)"
runuser -u student -- bash -c 'cd /work && exec timeout --kill-after=30 "$0" bash run.sh' "$MAX" >> /tmp/job.log 2>&1
CODE=$?
T_DONE=$(date +%s)
kill "$LOOP" 2>/dev/null; wait "$LOOP" 2>/dev/null
echo "[talon] job ended after $((T_DONE - T_RUN))s with exit code $CODE"

case $CODE in
  0)   STATE_NAME=succeeded ;;
  124) STATE_NAME=timeout ;;
  *)   STATE_NAME=failed ;;
esac
sync_all
if [ "$SKIPPED" -gt 0 ]; then
  echo "[talon] $SKIPPED file(s) were not saved (limits: $MAX_FILES files, 200 MB per file, 500 MB total)." >> /tmp/job.log
  aws s3 cp /tmp/job.log "$PREFIX/logs/job.log" --only-show-errors
fi
RESULT=$STATE_NAME; EXIT_CODE=$CODE
emit_summary
sleep 1 # let the timestamping pipe write the summary
aws s3 cp "$BOOT_LOG" "$PREFIX/logs/boot.log" --only-show-errors
status "$STATE_NAME" "$CODE"
