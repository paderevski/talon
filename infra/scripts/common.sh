#!/bin/bash
# Shared helpers for infra/scripts. Source, don't run.
set -euo pipefail

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export AWS_PROFILE="${AWS_PROFILE:-lcps}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""

instance_id() {
  terraform -chdir="$INFRA_DIR/ec2" output -raw instance_id
}
