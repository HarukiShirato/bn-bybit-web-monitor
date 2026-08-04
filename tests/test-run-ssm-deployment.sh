#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/run-ssm-deployment.sh"
sha='0123456789abcdef0123456789abcdef01234567'

make_fixture() {
  local fixture
  fixture="$(mktemp -d)"
  printf '0\n' >"$fixture/clock"
  : >"$fixture/calls"
  cat >"$fixture/aws" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALLS"
case " $* " in
  *' send-command '*) printf 'cmd-1\n' ;;
  *' get-command-invocation '*)
    status="$(head -1 "$STATUSES")"; sed -i.bak '1d' "$STATUSES"; rm -f "$STATUSES.bak"
    printf '{"Status":"%s","StandardOutputContent":"DEPLOY_SHA=0123456789abcdef0123456789abcdef01234567\\nDEPLOY_PM2=online\\nDEPLOY_LOCAL_HEALTH=ok\\nDEPLOY_PUBLIC_HEALTH=ok\\nSECRET=nope"}\n' "$status"
    ;;
  *' cancel-command '*) [[ "${CANCEL_FAIL:-0}" != 1 ]] ;;
esac
EOF
  cat >"$fixture/now" <<'EOF'
#!/usr/bin/env bash
cat "$CLOCK"
EOF
  cat >"$fixture/sleep" <<'EOF'
#!/usr/bin/env bash
echo $(( $(cat "$CLOCK") + ${1:-1} )) >"$CLOCK"
EOF
  chmod +x "$fixture/aws" "$fixture/now" "$fixture/sleep"
  printf '%s\n' "$fixture"
}

run_case() {
  local fixture="$1"; shift
  CALLS="$fixture/calls" STATUSES="$fixture/statuses" CLOCK="$fixture/clock" \
    AWS_BIN="$fixture/aws" NOW_CMD="$fixture/now" SLEEP_CMD="$fixture/sleep" \
    COMMAND_TIMEOUT_SECONDS=20 POLL_INTERVAL_SECONDS=10 CLEANUP_POLL_SECONDS=30 \
    "$@" bash "$script" "$sha" 'printf deploy'
}

fixture="$(make_fixture)"; printf 'Success\n' >"$fixture/statuses"
run_case "$fixture" >"$fixture/out"
grep -Fqx "DEPLOY_SHA=$sha" "$fixture/out"; grep -Fq 'SECRET=nope' "$fixture/out" && exit 1
grep -Fq 'executionTimeout' "$fixture/calls"; rm -rf "$fixture"

fixture="$(make_fixture)"; printf 'Pending\nSuccess\n' >"$fixture/statuses"
run_case "$fixture" >/dev/null; [[ "$(grep -Fc 'get-command-invocation' "$fixture/calls")" == 2 ]]; rm -rf "$fixture"

fixture="$(make_fixture)"; printf 'Failed\n' >"$fixture/statuses"
if run_case "$fixture" >/dev/null 2>&1; then exit 1; fi; ! grep -Fq 'cancel-command' "$fixture/calls"; rm -rf "$fixture"

fixture="$(make_fixture)"; printf 'Pending\nPending\nPending\nCancelled\n' >"$fixture/statuses"
if run_case "$fixture" >/dev/null 2>&1; then exit 1; fi; grep -Fq 'cancel-command' "$fixture/calls"; rm -rf "$fixture"

fixture="$(make_fixture)"; printf 'Pending\nPending\nPending\nCancelled\n' >"$fixture/statuses"
if run_case "$fixture" env CANCEL_FAIL=1 >/dev/null 2>&1; then exit 1; fi; grep -Fq 'cancel-command' "$fixture/calls"; rm -rf "$fixture"

fixture="$(make_fixture)"; printf 'Pending\nCancelled\n' >"$fixture/statuses"
CALLS="$fixture/calls" STATUSES="$fixture/statuses" CLOCK="$fixture/clock" AWS_BIN="$fixture/aws" NOW_CMD="$fixture/now" SLEEP_CMD=/bin/sleep \
  bash "$script" "$sha" 'printf deploy' >/dev/null 2>&1 & pid=$!
sleep 0.1; kill -TERM "$pid"; wait "$pid" || true
grep -Fq 'cancel-command' "$fixture/calls"; rm -rf "$fixture"

echo 'run-ssm-deployment behavior tests passed'
