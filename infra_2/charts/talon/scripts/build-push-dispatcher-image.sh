#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <image-tag> [aws-region] [aws-account-id] [platform]"
  echo "Example: $0 dev-amd64 us-east-1 706194210592 linux/amd64"
  exit 1
fi

RAW_TAG="$1"
TAG="${RAW_TAG//./-}"
AWS_REGION="${2:-us-east-1}"
AWS_ACCOUNT_ID="${3:-$(aws sts get-caller-identity --query Account --output text)}"
PLATFORM="${4:-linux/amd64}"

if [[ "$TAG" != "$RAW_TAG" ]]; then
  echo "Normalized image tag: $RAW_TAG -> $TAG"
fi

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
DOCKERFILE_PATH="$ROOT_DIR/infra/images/dispatcher/Dockerfile"
REPO_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/talon-dev/dispatcher"

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker buildx build \
  --platform "$PLATFORM" \
  --file "$DOCKERFILE_PATH" \
  --tag "$REPO_URI:$TAG" \
  --push \
  "$ROOT_DIR"

echo "Pushed dispatcher image: $REPO_URI:$TAG ($PLATFORM)"
