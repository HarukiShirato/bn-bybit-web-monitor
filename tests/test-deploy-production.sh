#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
script="$root/scripts/deploy-production.sh"
sha=0123456789abcdef0123456789abcdef01234567
fail(){ echo "deploy-production test failed: $*" >&2; exit 1; }

fixture="$(mktemp -d)"; trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/app/shared/data" "$fixture/app/releases"
printf 'RUNTIME_SECRET=never-build-with-this\n' >"$fixture/app/shared/.env"
cat >"$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == clone ]]; then mkdir -p "${@: -1}"; cp "$ECOSYSTEM" "${@: -1}/ecosystem.config.cjs"; exit; fi
if [[ "$1" == -C && "$3" == checkout ]]; then printf %s "${@: -1}" >"$2/.head"; exit; fi
if [[ "$1" == -C && "$3" == rev-parse ]]; then cat "$2/.head"; exit; fi
exit 0
EOF
cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
[[ ! -e .env ]] || { echo '.env visible to build' >&2; exit 9; }
[[ -z "${RUNTIME_SECRET:-}" ]] || { echo 'runtime secret in build env' >&2; exit 9; }
exit 0
EOF
cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
printf 'pm2 %s\n' "$*" >>"$COMMAND_LOG"
[[ "${PM2_FAIL_START:-0}" != 1 || "$1" != startOrReload ]] || exit 1
if [[ "$1" == jlist ]]; then
  node - "$CURRENT" <<'NODE'
const c=process.argv[2], names=['perp-dashboard','funding-collector','arbitrage-collector','staking-collector','positions-collector'];
console.log(JSON.stringify(names.map(name=>({pm2_env:{name,status:'online',pm_cwd:c}}))));
NODE
fi
EOF
cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$fixture/bin/flock" <<'EOF'
#!/usr/bin/env bash
[[ "${FLOCK_FAIL:-0}" != 1 ]]
EOF
cat >"$fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == -Tf ]]; then rm -f "$3"; exec /bin/mv "$2" "$3"; fi
exec /bin/mv "$@"
EOF
chmod +x "$fixture/bin"/*

run(){ PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" EXPECTED_USER="$(id -un)" ECOSYSTEM="$root/ecosystem.config.cjs" COMMAND_LOG="$fixture/commands" CURRENT="$fixture/app/current" "$@" bash "$script" --prepare-only "$sha"; }
run env RUNTIME_SECRET=production-secret
[[ -f "$fixture/app/releases/$sha/.deployment-prepared.json" ]] || fail 'prepare marker missing'
[[ ! -e "$fixture/app/releases/$sha/.env" ]] || fail 'prepare-only linked runtime env'
[[ ! -e "$fixture/app/current" ]] || fail 'prepare-only switched current'
! grep -q '^pm2 ' "$fixture/commands" || fail 'prepare-only touched PM2'

# Finish the prepared release through a fresh fixture state, as migration would do.
rm -f "$fixture/app/releases/$sha/.deployment-prepared.json"
rm -rf "$fixture/app/releases/$sha"
PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" EXPECTED_USER="$(id -un)" ECOSYSTEM="$root/ecosystem.config.cjs" COMMAND_LOG="$fixture/commands" CURRENT="$fixture/app/current" bash "$script" "$sha"
[[ -L "$fixture/app/releases/$sha/.env" ]] || fail 'runtime env was not linked after build'
grep -Fq 'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector' "$fixture/commands" || fail 'collectors were not stopped'
grep -Fq 'pm2 startOrReload ecosystem.config.cjs --update-env' "$fixture/commands" || fail 'all apps were not switched together'

# Same SHA is a successful verification-only operation and creates another log.
before="$(find "$fixture/app/shared/deploy-logs" -type f | wc -l | tr -d ' ')"
PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" EXPECTED_USER="$(id -un)" ECOSYSTEM="$root/ecosystem.config.cjs" COMMAND_LOG="$fixture/commands" CURRENT="$fixture/app/current" bash "$script" "$sha"
after="$(find "$fixture/app/shared/deploy-logs" -type f | wc -l | tr -d ' ')"
(( after == before + 1 )) || fail 'same-SHA rerun reused or truncated a log'

# Lock contention happens before any command log is created.
before="$after"
if PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" EXPECTED_USER="$(id -un)" FLOCK_FAIL=1 bash "$script" "$sha" >/dev/null 2>&1; then fail 'lock contention succeeded'; fi
after="$(find "$fixture/app/shared/deploy-logs" -type f | wc -l | tr -d ' ')"
[[ "$after" == "$before" ]] || fail 'lock loser created a deployment log'

# A post-switch PM2 failure restores old current and attempts the same five-process unit.
sha2=fedcba9876543210fedcba9876543210fedcba98
old="$fixture/app/releases/old"; mkdir -p "$old"; cp "$root/ecosystem.config.cjs" "$old/ecosystem.config.cjs"
rm -f "$fixture/app/current"; ln -s "$old" "$fixture/app/current"
if PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" EXPECTED_USER="$(id -un)" ECOSYSTEM="$root/ecosystem.config.cjs" COMMAND_LOG="$fixture/commands" CURRENT="$fixture/app/current" PM2_FAIL_START=1 bash "$script" "$sha2"; then fail 'PM2 switch failure succeeded'; fi
[[ "$(cd "$fixture/app/current" && pwd -P)" == "$(cd "$old" && pwd -P)" ]] || fail 'PM2 failure did not restore old current'
(( $(grep -Fc 'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector' "$fixture/commands") >= 3 )) || fail 'rollback did not stop collectors as one unit'

echo 'deploy-production behavior tests passed'
