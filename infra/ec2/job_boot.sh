#!/bin/bash
# Boot script for Talon job instances (launch template user_data, runs as root).
#
# Everything about the job comes from instance tags, so this file is static:
#   talon-job          job id (falls back to manual-<instance id>)
#   talon-s3-prefix    this launch's S3 folder, jobs/<id>-<random>; a hand
#                      launch without it uses jobs/manual-<instance id>
#   talon-bucket       jobs bucket (set by the launch template)
#   talon-max-seconds  time limit for the user's script (default 1800)
#   talon-image        cpu or gpu (PyTorch DLAMI); set by the launch template
#   talon-log-group    CloudWatch log group for this boot log; set by the
#                      launch template (empty: S3 only)
#   talon-egress-mb    outbound data limit for the user's code, in MB (set by
#                      the launch template; default 5120, 0 = no limit)
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
# CloudWatch every 5 seconds (stream <job id>/<instance id>). The last line is
# a JSON summary (event job.boot_summary) with the result and phase timings.
# The job log, /tmp/job.log, is what the app shows: setup steps ("[talon]
# HH:MM:SS ...", via step) then the student's output, capped by talon-logcap
# (the first and the last 10 MB of it; see below). Both logs go to S3
# (logs/job.log, logs/boot.log) every 3 seconds when changed, and on exit.
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

# Uploads the files of one output tree. Usage: talon-upload DIR DEST MODE
# STATE_DIR MAX_FILES MAX_FILE_BYTES MAX_TOTAL_BYTES UID NEWER_FILE
# (MODE output: every file; changed: files newer than NEWER_FILE, no hidden
# paths, caches or virtual environments).
# DIR is the student's, so nothing in it is trusted: it is walked with file
# descriptors and every file is opened with O_NOFOLLOW (a symlink, whether
# swapped in after the walk or part of the path, is never followed), must be a
# regular file owned by the job user, and is copied into a root-only folder
# before upload (what is counted is what is sent, even if the student keeps
# writing). Accounting is one small record per file in STATE_DIR/up, named by
# a hash of the S3 key, so no file name is ever parsed: the totals and the
# caps hold across passes and for any name. A re-uploaded file counts once,
# at its latest size (it replaces the object).

cat > /usr/local/sbin/talon-upload <<'PY'
import fcntl, hashlib, mimetypes, os, stat, subprocess, sys

root, dest, mode, state, max_files, max_file, max_total, uid, newer = sys.argv[1:10]
max_files, max_file, max_total, uid = int(max_files), int(max_file), int(max_total), int(uid)
SPOOL = "/var/lib/talon-upload"  # created by job_boot.sh before the job user runs
for d in (SPOOL, state):
    st = os.lstat(d)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != 0:
        sys.exit("talon-upload: " + d + " is not a root-owned folder")
for sub in ("up", "skip"):
    os.makedirs(state + "/" + sub, mode=0o700, exist_ok=True)
lock = open(state + "/lock", "w")
fcntl.flock(lock, fcntl.LOCK_EX)  # one pass at a time (the loop's and the last one)

def load(sub):
    out = {}
    for name in os.listdir(state + "/" + sub):
        try:
            out[name] = tuple(int(x) for x in open(state + "/" + sub + "/" + name).read().split())
        except (OSError, ValueError):
            pass
    return out

def record(sub, key, values):
    tmp = state + "/tmp"
    with open(tmp, "w") as f:
        f.write(" ".join(str(v) for v in values))
    os.replace(tmp, state + "/" + sub + "/" + key)

def forget(sub, key):
    try:
        os.unlink(state + "/" + sub + "/" + key)
    except OSError:
        pass

up = load("up")      # key -> (bytes counted, size, mtime_ns when uploaded)
skip = load("skip")  # key -> (size, mtime_ns) of files over a limit
total = sum(v[0] for v in up.values())
newer_ns = os.stat(newer).st_mtime_ns if mode == "changed" else 0
logged = 0

try:
    top = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
except OSError:
    sys.exit(0)  # no such folder (or a symlink in its place): nothing to upload

def candidates():
    for dirpath, dirnames, filenames, dirfd in os.fwalk(".", dir_fd=top):
        if mode == "changed":
            dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in ("__pycache__", "node_modules", "venv")]
            filenames = [f for f in filenames if not f.startswith(".") and not f.endswith(".pyc")]
        for name in filenames:
            yield os.path.normpath(os.path.join(dirpath, name)), name, dirfd

def spool(fd, path, limit):  # at most limit bytes of fd into path
    n = 0
    out = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        while n < limit:
            chunk = os.read(fd, min(1 << 20, limit - n))
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                view = view[os.write(out, view):]
            n += len(chunk)
    finally:
        os.close(out)
    return n

for rel, name, dirfd in candidates():
    key_path = dest + "/" + rel
    key = hashlib.sha256(os.fsencode(key_path)).hexdigest()
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dirfd)
    except OSError:
        continue  # symlink, vanished, unreadable
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != uid or (mode == "changed" and st.st_mtime_ns <= newer_ns):
            continue
        sig = (st.st_size, st.st_mtime_ns)
        if up.get(key, (0, None, None))[1:] == sig or skip.get(key) == sig:
            continue
        mine = up.get(key, (0,))[0]
        why = None
        if st.st_size > max_file:
            why = "over the per-file limit"
        elif len(up) - (key in up) >= max_files:
            why = "over the file count limit"
        elif total - mine + st.st_size > max_total:
            why = "over the total size limit"
        tmp = SPOOL + "/part"
        if why is None:
            try:
                n = spool(fd, tmp, max_file + 1)
                if n > max_file or total - mine + n > max_total:
                    why = "over a size limit"
                else:
                    cmd = ["aws", "s3", "cp", tmp, key_path, "--only-show-errors"]
                    ctype = mimetypes.guess_type(name)[0]
                    if ctype:
                        cmd += ["--content-type", ctype]
                    if subprocess.run(cmd, stdin=subprocess.DEVNULL).returncode != 0:
                        continue  # not recorded: the next pass tries again
                    up[key] = (n, st.st_size, st.st_mtime_ns)
                    total += n - mine
                    record("up", key, up[key])
                    forget("skip", key); skip.pop(key, None)
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        if why is not None:
            skip[key] = sig
            record("skip", key, sig)
            if logged < 50:
                logged += 1
                print("talon-upload: not saved (" + why + "): " + repr(rel), file=sys.stderr)
    finally:
        os.close(fd)
PY

# Caps the student's output. Usage: talon-logcap FIFO LOGFILE HEAD_BYTES
# TAIL_BYTES. Root runs it outside the student's unit; the unit's stdout and
# stderr are the FIFO, so the student only ever holds the write end of a pipe
# that leads here (the FIFO and LOGFILE are root's). The first HEAD_BYTES go to
# LOGFILE as they arrive (so the log still streams live), then one note line,
# and from then on only the latest TAIL_BYTES are kept in memory and appended
# at the end, after a line saying how much was dropped. The FIFO is opened
# read-write: this process is itself a writer, so opening never blocks and the
# pipe never reports EOF between the unit's start-up commands (they open and
# close it too). The supervisor ends it by creating FIFO.stop once the unit is
# gone; it then drains what is left in the pipe. FIFO.ready says it is reading.
cat > /usr/local/sbin/talon-logcap <<'PY'
import collections, os, select, sys, time

fifo, log_path, head_max, tail_max = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
rd = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
out = os.open(log_path, os.O_WRONLY | os.O_APPEND | os.O_CLOEXEC)
written, last, kept, skipped, noted = 0, b"", 0, 0, False
tail = collections.deque()

def emit(data):
    while data:
        try:
            data = data[os.write(out, data):]
        except OSError:
            return  # disk full or the like: drop it, but keep reading so the job never blocks

def note(text):  # a "[talon] HH:MM:SS ..." line, as step writes them, on a line of its own
    line = "[talon] %s %s\n" % (time.strftime("%H:%M:%S", time.gmtime()), text)
    return (b"" if last in (b"", b"\n") else b"\n") + line.encode()

def feed(data):
    global written, last, kept, skipped, noted
    if written < head_max:
        part = data[: head_max - written]
        emit(part)
        written += len(part)
        last = part[-1:]
        data = data[len(part):]
    if not data:
        return
    if not noted:
        noted = True
        emit(note("output passed %d MB: the rest is not shown live; the last %d MB will be added when the job ends"
                  % (head_max >> 20, tail_max >> 20)))
        last = b"\n"
    tail.append(data)
    kept += len(data)
    while kept - len(tail[0]) >= tail_max:  # the oldest chunk is not needed
        old = tail.popleft()
        kept -= len(old)
        skipped += len(old)

open(fifo + ".ready", "w").close()
while True:
    stopping = os.path.exists(fifo + ".stop")  # checked before the read: a read that finds nothing then means drained
    if not stopping:
        select.select([rd], [], [], 0.2)
    try:
        chunk = os.read(rd, 1 << 16)
    except BlockingIOError:
        chunk = b""
    if chunk:
        feed(chunk)
    elif stopping:
        break

data = b"".join(tail)
if kept > tail_max:
    skipped += kept - tail_max
    data = data[kept - tail_max:]
if skipped:
    nl = data.find(b"\n")  # start the kept part at a line boundary when there is one
    if 0 <= nl < len(data) - 1:
        skipped += nl + 1
        data = data[nl + 1:]
    emit(note("%.1f MB of output not kept" % (skipped / 1048576)))
emit(data)  # past the head but nothing skipped (under head + tail): all of it
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
EGRESS_MB=$(tag talon-egress-mb)
case $EGRESS_MB in ''|*[!0-9]*) EGRESS_MB=5120 ;; esac
INSTANCE_TYPE=$(imds meta-data/instance-type)
S3P=$(tag talon-s3-prefix)
[ -z "$S3P" ] && [[ "$JOB" == manual-* ]] && S3P="jobs/$JOB"
if ! [[ "$S3P" =~ ^jobs/[A-Za-z0-9-]+$ ]]; then
  echo "[talon] missing or bad talon-s3-prefix tag: '$S3P'"; exit 1
fi
PREFIX="s3://$BUCKET/$S3P"
START=$(date -u +%FT%TZ)
: > /tmp/job.log
step() { echo "[talon] $*"; echo "[talon] $(date -u +%T) $*" >> /tmp/job.log; }
step "job $JOB on $INSTANCE_ID ($INSTANCE_TYPE, image $IMAGE), ${UPTIME_AT_START}s after kernel boot"

# For the summary line (emit_summary).
# Which image this boot came from: the release file a baked image carries (the
# Image Builder component in image.tf), "stock" on plain Ubuntu or a DLAMI.
IMAGE_RELEASE=$(tr -cd 'A-Za-z0-9._-' < /etc/talon-image-release 2>/dev/null)
IMAGE_RELEASE=${IMAGE_RELEASE:-stock}
RESULT=setup_failed; EXIT_CODE=null; FAIL_MESSAGE=""; T_RUN=""; T_DONE=""; SKIPPED=0; SCRATCH_KIND=""
SHIP_LOOP=""; LOG_LOOP=""; SUMMARY_DONE=false

# Upload each log to S3 if its size or mtime changed. The lock keeps an older
# upload from landing after a newer one.
ship_logs() {
  local f n key
  for f in /tmp/job.log "$BOOT_LOG"; do
    n=job.log; [ "$f" = "$BOOT_LOG" ] && n=boot.log
    key=$(stat -c %s.%Y "$f" 2>/dev/null) || continue
    [ "$key" = "$(cat /run/talon-sent.$n 2>/dev/null)" ] && continue
    flock -w 60 /run/talon-s3log.lock aws s3 cp "$f" "$PREFIX/logs/$n" --only-show-errors &&
      echo "$key" > /run/talon-sent.$n
  done
}
stop_log_loop() { # let the loop finish its upload, so ours is the last
  [ -n "$LOG_LOOP" ] || return 0
  touch /run/talon-logs.stop; wait "$LOG_LOOP"; LOG_LOOP=""
}

# The cap on the student's output (see talon-logcap): the first and the last
# LOG_HEAD_BYTES / LOG_TAIL_BYTES of it are kept in the job log.
LOG_HEAD_BYTES=$((10 * 1024 * 1024))
LOG_TAIL_BYTES=$((10 * 1024 * 1024))
LOG_FIFO=/run/talon-job.fifo
LOGCAP=""
start_logcap() { # before the unit, so the reader is there when systemd opens the FIFO
  rm -f "$LOG_FIFO" "$LOG_FIFO.stop" "$LOG_FIFO.ready"
  mkfifo -m 600 "$LOG_FIFO" || return 1
  python3 /usr/local/sbin/talon-logcap "$LOG_FIFO" /tmp/job.log "$LOG_HEAD_BYTES" "$LOG_TAIL_BYTES" </dev/null &
  LOGCAP=$!
  local i
  for i in $(seq 1 50); do
    [ -e "$LOG_FIFO.ready" ] && return 0
    kill -0 "$LOGCAP" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$LOGCAP" 2>/dev/null; wait "$LOGCAP" 2>/dev/null; LOGCAP=""
  return 1
}
stop_logcap() { # the unit is gone: the capper drains the pipe, adds the tail and exits
  [ -n "$LOGCAP" ] || return 0
  : > "$LOG_FIFO.stop"
  ( sleep 60; kill -KILL "$LOGCAP" 2>/dev/null ) &
  local dog=$!
  wait "$LOGCAP" 2>/dev/null
  kill "$dog" 2>/dev/null
  LOGCAP=""
  rm -f "$LOG_FIFO" "$LOG_FIFO.stop" "$LOG_FIFO.ready"
}

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
  printf '{"event":"job.boot_summary","jobId":"%s","instanceId":"%s","instanceType":"%s","image":"%s","imageRelease":"%s","result":"%s","exitCode":%s,"message":"%s","bootSeconds":%s,"setupSeconds":%s,"runSeconds":%s,"totalSeconds":%s,"skippedFiles":%s,"scratch":"%s"}\n' \
    "$JOB" "$INSTANCE_ID" "$INSTANCE_TYPE" "$IMAGE" "$IMAGE_RELEASE" "$RESULT" "$EXIT_CODE" "$FAIL_MESSAGE" \
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
# Every exit path: summary, last log lines to CloudWatch, logs to S3,
# power off.
finish() {
  [ -n "$SHIP_LOOP" ] && kill "$SHIP_LOOP" 2>/dev/null
  emit_summary
  sleep 1 # let the timestamping pipe write the last lines
  ship_boot_log
  if command -v aws >/dev/null && [ -n "${PREFIX:-}" ]; then
    stop_logcap; stop_log_loop; ship_logs
  fi
  # Flush the CloudWatch agent's last interval (baked CPU image; a no-op elsewhere).
  timeout 15 systemctl stop amazon-cloudwatch-agent >/dev/null 2>&1 || true
  sync; shutdown -h now
}
trap finish EXIT

# The AWS CLI is not on the stock Ubuntu AMI (a baked AMI will replace this
# later); the Deep Learning AMIs may already have it.
if ! command -v aws >/dev/null; then
  step "installing the AWS CLI"
  for i in 1 2 3; do snap install aws-cli --classic && break; sleep 5; done
fi
if ! command -v aws >/dev/null; then echo "no aws cli"; exit 1; fi
if [ -z "$BUCKET" ]; then echo "no talon-bucket tag"; exit 1; fi
ship_boot_log
( while sleep 5; do ship_boot_log; done ) &
SHIP_LOOP=$!
( while [ ! -e /run/talon-logs.stop ]; do ship_logs; sleep 3; done ) &
LOG_LOOP=$!

# apt: the security group only lets HTTPS out, and the instance has no IPv6
# route. Ubuntu's default sources are HTTP, and on arm64 the regional EC2 mirror
# (<region>.ec2.ports.ubuntu.com) does not serve HTTPS at all, so use the
# global mirror over HTTPS and IPv4 only.
sed -E -i 's#https?://([a-z0-9-]+\.ec2\.)?#https://#g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99talon-ipv4

# Untrusted code runs as 'student'. Fail closed: if the instance metadata
# service cannot be blocked for that user, the job does not run.
step "creating the job user, blocking instance metadata for it"
useradd -m -s /bin/bash student
command -v iptables >/dev/null || { apt-get update -qq && apt-get install -y -qq iptables; }
if ! iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner student -j REJECT; then
  status failed "" "could not block instance metadata"
  exit 1
fi
ip6tables -I OUTPUT -d fd00:ec2::254 -m owner --uid-owner student -j REJECT 2>/dev/null || true
STUDENT_UID=$(id -u student)

# Outbound data limit for the student's code only (root's own traffic, such as
# the upload to S3, is not matched; neither is loopback). The quota rule lets
# packets through until EGRESS_MB is used up, then the next rule rejects them
# and its counter tells egress_watch to end the job. Downloads barely count:
# only the acknowledgements go out. The instance has no IPv6 route. If the
# rules cannot be set the job still runs (a cost limit, not a security one:
# the budget alerts are the backstop) and the boot log says so.
if [ "$EGRESS_MB" -gt 0 ]; then
  if iptables -N TALON_EGRESS &&
    iptables -A TALON_EGRESS -o lo -j RETURN &&
    iptables -A TALON_EGRESS -m quota --quota $((EGRESS_MB * 1024 * 1024)) -j RETURN &&
    iptables -A TALON_EGRESS -m comment --comment talon-egress-over -j REJECT &&
    iptables -A OUTPUT -m owner --uid-owner student -j TALON_EGRESS; then
    echo "outbound data limit for the job user: $EGRESS_MB MB"
  else
    EGRESS_MB=0
    echo "WARNING: could not set the outbound data limit; the job runs without it"
  fi
fi

mkdir -p /work/output
step "downloading job input"
if ! aws s3 cp --recursive "$PREFIX/input/" /work --only-show-errors; then
  status failed "" "could not fetch input"
  exit 1
fi
if [ -f /work/repo.tgz ]; then # a Talon job: the cloned repository
  step "unpacking the repository ($(du -h /work/repo.tgz | cut -f1))"
  mkdir -p /work/repo && tar -xzf /work/repo.tgz -C /work/repo && rm -f /work/repo.tgz
  # pip and venv are not on the stock image (a baked AMI will replace this).
  # The PyTorch DLAMI has its own Python with venv (run.sh uses it).
  # A baked CPU image already has both (python3 -m venv --help works without
  # the package, so ask dpkg).
  if [ "$IMAGE" != gpu ] && ! dpkg -s python3-venv python3-pip >/dev/null 2>&1; then
    step "installing Python venv and pip (apt)"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq python3-venv python3-pip
  fi
fi
if [ "$IMAGE" != cpu ]; then # the driver can take a moment after boot
  step "waiting for the GPU driver"
  for i in $(seq 1 30); do nvidia-smi >/dev/null 2>&1 && break; sleep 2; done
  step "GPU: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader || echo "nvidia-smi failed")"
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
step "TALON_SCRATCH_DIR=/work/scratch: $SCRATCH_KIND, $(df -h --output=avail /work/scratch | tail -1 | tr -d ' ') free, not saved"

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
# Upload state (root only; talon-upload above keeps it, so the limits hold
# across the loop's passes and the last one) and the folder it copies files into.
UPSTATE=/run/talon-upload
install -d -m 700 "$UPSTATE" /var/lib/talon-upload

# upload_tree DIR DEST MODE: regular files of the job user, never through a
# symlink, not already uploaded in their current size and mtime.
upload_tree() {
  python3 /usr/local/sbin/talon-upload "$1" "$2" "$3" "$UPSTATE" \
    "$MAX_FILES" "$MAX_FILE_BYTES" "$MAX_TOTAL_BYTES" "$STUDENT_UID" /work/.talon-start || true
}

sync_all() { # output files only; the log loop ships the logs
  upload_tree /work/output "$PREFIX/output" output
  # Nothing hidden (any path part starting with "."): .git, .venv, .cache
  # (model and dataset caches), .ipynb_checkpoints, dotfiles.
  upload_tree /work/repo "$PREFIX/changed" changed
}

# Ends the job when the student's outbound quota is used up (the rule that
# rejects the traffic has seen a packet).
egress_watch() {
  local over
  while sleep 5; do
    over=$(iptables -nvxL TALON_EGRESS 2>/dev/null | awk '/talon-egress-over/ {print $1}')
    [ "${over:-0}" -gt 0 ] || continue
    : > /run/talon-egress-over
    step "outbound data limit reached ($EGRESS_MB MB sent); stopping the job"
    systemctl kill --signal=SIGTERM talon-student-job.service
    sleep 20
    systemctl kill --signal=SIGKILL talon-student-job.service
    return
  done
}

status running
( while sleep 30; do sync_all; done ) &
LOOP=$!
WATCH=""
if [ "$EGRESS_MB" -gt 0 ]; then egress_watch & WATCH=$!; fi
T_RUN=$(date +%s)
step "setup took $((T_RUN - T0))s; running the job (limit ${MAX}s)"
# The student's code runs in its own transient unit (own cgroup, in its own
# slice), not in this script's: it cannot starve or signal the supervisor and
# the upload loop, its leftover processes die with the unit, and memory and
# process counts are capped (MemoryMax leaves the rest of the RAM to this
# script and the system; TasksMax stops a fork bomb). Output goes through a
# FIFO to talon-logcap (root, outside the unit), which writes the job log and
# keeps only the first and last LOG_*_BYTES of it. If the cap cannot be set
# up, or the unit does not start with its output on the FIFO, systemd appends
# to the job log itself, without a cap (a retry is safe: the marker shows no
# student code ran). RuntimeMaxSec is the time limit the student cannot kill
# (`timeout` inside gives the usual exit code 124). The marker, touched with
# full privileges before the command starts, tells "the job failed" from "the
# unit did not start". Exit code of systemd-run --wait = the job's.
UNCAPPED=(-p StandardOutput=append:/tmp/job.log -p StandardError=append:/tmp/job.log)
run_unit() {
  systemd-run --wait --collect --unit=talon-student-job --slice=talon-student.slice \
    --uid=student --gid=student --setenv=PATH \
    -p WorkingDirectory=/work \
    "$@" \
    -p MemoryMax=90% -p TasksMax=16384 -p NoNewPrivileges=yes \
    -p RuntimeMaxSec=$((MAX + 60)) -p TimeoutStopSec=30 \
    -p "ExecStartPre=+/usr/bin/touch /run/talon-job-started" \
    /usr/bin/timeout --kill-after=30 "$MAX" bash run.sh
}
rm -f /run/talon-job-started /run/talon-egress-over
if start_logcap; then
  run_unit -p "StandardOutput=file:$LOG_FIFO" -p StandardError=inherit
  CODE=$?
  if [ ! -e /run/talon-job-started ]; then
    stop_logcap
    echo "WARNING: the job did not start with the job log cap; retrying without it"
    run_unit "${UNCAPPED[@]}"
    CODE=$?
  fi
else
  echo "WARNING: could not start the job log cap; the job runs without it"
  run_unit "${UNCAPPED[@]}"
  CODE=$?
fi
T_DONE=$(date +%s)
kill "$LOOP" $WATCH 2>/dev/null; wait "$LOOP" 2>/dev/null
stop_logcap # the tail of the output lands before the lines below
# A job stopped mid-line (time limit, kill): start our lines on a new line.
[ -s /tmp/job.log ] && [ -n "$(tail -c 1 /tmp/job.log)" ] && echo >> /tmp/job.log
JOB_MESSAGE=""
if [ ! -e /run/talon-job-started ]; then
  CODE=126; JOB_MESSAGE="could not start the job"
elif [ -e /run/talon-egress-over ]; then
  JOB_MESSAGE="outbound data limit reached ($EGRESS_MB MB)"
fi
step "job ended after $((T_DONE - T_RUN))s with exit code $CODE; saving output"

case $CODE in
  0)   STATE_NAME=succeeded ;;
  124) STATE_NAME=timeout ;;
  *)   STATE_NAME=failed ;;
esac
[ -n "$JOB_MESSAGE" ] && STATE_NAME=failed
sync_all
SKIPPED=$(find "$UPSTATE/skip" -type f 2>/dev/null | wc -l)
[ "$SKIPPED" -gt 0 ] && step "$SKIPPED file(s) were not saved (limits: $MAX_FILES files, 200 MB per file, 500 MB total)."
step "done ($STATE_NAME); shutting down"
RESULT=$STATE_NAME; EXIT_CODE=$CODE
emit_summary
sleep 1 # let the timestamping pipe write the summary
stop_log_loop; ship_logs # complete logs before the final status
status "$STATE_NAME" "$CODE" "$JOB_MESSAGE"
