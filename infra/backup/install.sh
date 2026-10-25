#!/bin/bash
# Installs the backup scripts and systemd timers on the app server (run as
# root; idempotent). Called by first-boot setup and safe to re-run after a deploy.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 755 "$HERE/talon-backup.sh" /usr/local/bin/talon-backup
install -m 755 "$HERE/talon-restore-test.sh" /usr/local/bin/talon-restore-test
install -m 644 "$HERE/talon-backup.service" "$HERE/talon-backup.timer" \
  "$HERE/talon-restore-test.service" "$HERE/talon-restore-test.timer" /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now talon-backup.timer talon-restore-test.timer
echo "backup timers installed"
