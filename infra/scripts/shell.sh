#!/bin/bash
# Interactive shell on the instance via SSM (no SSH keys or port 22).
# Useful: sudo journalctl -u talon-backend -f
#         sudo tail -f /var/log/talon-bootstrap.log
source "$(dirname "$0")/common.sh"

aws ssm start-session --target "$(instance_id)"
