#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runbook="$root/docs/production-deployment.md"
block="$(mktemp)"
trap 'rm -f -- "$block"' EXIT

awk '
  /^```bash$/ { code = 1; next }
  code && /^\( set -Eeuo pipefail$/ { capture = 1; print; next }
  capture && /^```$/ { exit }
  capture { print }
' "$runbook" >"$block"

[[ -s "$block" ]] || { echo 'missing SSM verification command block' >&2; exit 1; }
bash -n "$block"
grep -Fxq '( set -Eeuo pipefail' "$block"
grep -Fxq '  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]' "$block"
grep -Fxq '  grep -Fx "DEPLOY_SHA=$expected_sha" <<<"$deployment_output" >/dev/null' "$block"
grep -Fxq '  [[ "$(jq -r '\''.Status'\'' <<<"$invocation")" == '\''Success'\'' ]]' "$block"
grep -Fxq "  echo 'SSM invocation verified'" "$block"

echo 'production deployment runbook tests passed'
