#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <job-name> <runner-image-tag> [namespace]"
  echo "Example: $0 talon-run-001 sha-abc123 talon"
  exit 1
fi

JOB_NAME="$1"
RUNNER_TAG="$2"
NAMESPACE="${3:-talon}"

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
CHART_PATH="$ROOT_DIR/infra/charts/talon"
VALUES_PATH="$CHART_PATH/values.dev.yaml"

RELEASE_NAME="runner-${JOB_NAME}"

helm upgrade --install "$RELEASE_NAME" "$CHART_PATH" \
  -n "$NAMESPACE" \
  -f "$VALUES_PATH" \
  --set api.enabled=false \
  --set dispatcher.enabled=false \
  --set runner.image.tag="$RUNNER_TAG" \
  --set runnerJob.create=true \
  --set runnerJob.name="$JOB_NAME"

echo "Submitted runner job release: $RELEASE_NAME"
kubectl get job "$JOB_NAME" -n "$NAMESPACE"
