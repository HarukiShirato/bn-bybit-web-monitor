#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:?SHA is required}"
readonly REMOTE_COMMAND="${2:?remote command is required}"
readonly INSTANCE_ID="${INSTANCE_ID:-i-0d3456ec595259c39}"
readonly AWS_REGION="${AWS_REGION:-ap-northeast-1}"
readonly COMMAND_TIMEOUT_SECONDS="${COMMAND_TIMEOUT_SECONDS:-900}"
readonly POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
readonly CLEANUP_POLL_SECONDS="${CLEANUP_POLL_SECONDS:-30}"
readonly AWS_BIN="${AWS_BIN:-aws}"
readonly NOW_CMD="${NOW_CMD:-date +%s}"
readonly SLEEP_CMD="${SLEEP_CMD:-sleep}"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'SSM_RESULT=invalid-sha' >&2; exit 64; }
command_id=''
terminal=0
completed=0
status='Unknown'
invocation=''

now() { $NOW_CMD; }
aws_ssm() { "$AWS_BIN" --cli-connect-timeout 5 --cli-read-timeout 10 ssm "$@"; }

get_invocation() {
  aws_ssm get-command-invocation --region "$AWS_REGION" --command-id "$command_id" --instance-id "$INSTANCE_ID" \
    --query '{Status:Status,StandardOutputContent:StandardOutputContent}' --output json
}

print_safe_milestones() {
  jq -r '.StandardOutputContent // ""' <<<"$invocation" | grep -E '^(DEPLOY_SHA=[0-9a-f]{40}|DEPLOY_PM2=online|DEPLOY_LOCAL_HEALTH=ok|DEPLOY_PUBLIC_HEALTH=ok)$' || true
}

poll_until() {
  local deadline="$1"
  while (( $(now) < deadline )); do
    if invocation="$(get_invocation 2>/dev/null)"; then
      status="$(jq -r '.Status // "Unknown"' <<<"$invocation")"
      printf 'SSM_STATUS=%s COMMAND_ID=%s\n' "$status" "$command_id"
      case "$status" in
        Success|Cancelled|TimedOut|Failed) terminal=1; return 0 ;;
      esac
    fi
    "$SLEEP_CMD" "$POLL_INTERVAL_SECONDS"
  done
  return 1
}

cancel_and_short_poll() {
  [[ -n "$command_id" && "$terminal" -eq 0 ]] || return 0
  "$AWS_BIN" --cli-connect-timeout 5 --cli-read-timeout 10 ssm cancel-command --region "$AWS_REGION" --command-id "$command_id" --instance-ids "$INSTANCE_ID" || printf 'SSM_CANCEL=failed COMMAND_ID=%s\n' "$command_id" >&2
  poll_until $(( $(now) + CLEANUP_POLL_SECONDS )) || true
  print_safe_milestones
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  [[ "$completed" -eq 1 ]] || cancel_and_short_poll
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

parameters="$(jq -cn --arg command "$REMOTE_COMMAND" --arg timeout "$COMMAND_TIMEOUT_SECONDS" '{commands: [$command], executionTimeout: [$timeout]}')"
command_id="$(aws_ssm send-command --region "$AWS_REGION" --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters "$parameters" --timeout-seconds "$COMMAND_TIMEOUT_SECONDS" --query 'Command.CommandId' --output text)"
printf 'SSM_SUBMITTED COMMAND_ID=%s SHA=%s\n' "$command_id" "$SHA"

if ! poll_until $(( $(now) + COMMAND_TIMEOUT_SECONDS )); then
  printf 'SSM_RESULT=deadline-exceeded COMMAND_ID=%s\n' "$command_id" >&2
  exit 1
fi
print_safe_milestones
[[ "$status" == Success ]] || { printf 'SSM_RESULT=%s COMMAND_ID=%s\n' "$status" "$command_id" >&2; exit 1; }
completed=1
printf 'SSM_RESULT=success COMMAND_ID=%s SHA=%s\n' "$command_id" "$SHA"
