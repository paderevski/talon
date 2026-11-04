#!/bin/bash
# Put fresh LCPS credentials in the current shell for Terraform, which cannot
# read SSO / `aws login` profiles directly. Must be sourced, not run:
#
#   source infra/scripts/aws-env.sh          # clear stale vars, log in if needed, export
#   source infra/scripts/aws-env.sh clear    # only clear the exported vars
#
# Works in bash and zsh. The exported credentials expire with the SSO role
# session; when Terraform reports ExpiredToken, source this again.

(return 0 2>/dev/null) || {
  echo "Source this file instead of running it: source ${0}" >&2
  exit 1
}

_talon_aws_env() {
  local profile="${TALON_AWS_PROFILE:-lcps}"

  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_CREDENTIAL_EXPIRATION
  if [ "${1:-}" = "clear" ]; then
    echo "Cleared exported AWS credentials."
    return 0
  fi

  if ! aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1; then
    echo "No valid session for profile $profile; logging in..."
    aws sso login --profile "$profile" || return 1
  fi

  local expected actual
  expected="$(aws configure get sso_account_id --profile "$profile")"
  actual="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)" || return 1
  if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
    echo "Profile $profile resolved to an unexpected account; not exporting." >&2
    return 1
  fi

  eval "$(aws configure export-credentials --profile "$profile" --format env)" || return 1
  echo "Exported credentials for profile $profile:"
  aws sts get-caller-identity --query Arn --output text
  if [ -n "${AWS_CREDENTIAL_EXPIRATION:-}" ]; then
    echo "Expires: $AWS_CREDENTIAL_EXPIRATION"
  fi
  echo "Run 'source infra/scripts/aws-env.sh clear' when done."
}

_talon_aws_env "$@"
set -- $?
unset -f _talon_aws_env
return "$1"
