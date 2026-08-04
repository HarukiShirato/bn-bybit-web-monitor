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

rollback_block="$(mktemp)"
trap 'rm -f -- "$block" "$rollback_block"' EXIT
awk '
  /^## 紧急人工回退$/ { section = 1; next }
  section && /^```bash$/ { capture = 1; next }
  capture && /^```$/ { exit }
  capture { print }
' "$runbook" >"$rollback_block"

[[ -s "$rollback_block" ]] || { echo 'missing emergency rollback command block' >&2; exit 1; }
bash -n "$rollback_block"
lock_line="$(grep -nF 'exec 9>"$APP_ROOT/deploy.lock"' "$rollback_block" | cut -d: -f1)"
flock_line="$(grep -nF "flock -n 9 || { echo 'deployment lock is held; check GitHub Actions and SSM before retrying rollback' >&2; exit 75; }" "$rollback_block" | cut -d: -f1)"
readlink_line="$(grep -nF 'target="$(readlink -f "$APP_ROOT/previous")"' "$rollback_block" | cut -d: -f1)"
[[ -n "$lock_line" && -n "$flock_line" && -n "$readlink_line" ]] || { echo 'rollback lock or previous-release lookup is missing' >&2; exit 1; }
(( lock_line < readlink_line && flock_line < readlink_line )) || { echo 'rollback must acquire the deployment lock before readlink' >&2; exit 1; }

echo 'production deployment runbook tests passed'
