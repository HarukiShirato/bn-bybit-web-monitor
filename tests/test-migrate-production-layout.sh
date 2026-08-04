#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/migrate-production-layout.sh"

fail() {
  echo "migrate-production-layout test failed: $*" >&2
  exit 1
}

[[ -f "$script" ]] || fail 'migration script is missing'

fixture="$(mktemp -d)"
cleanup() { rm -rf -- "$fixture"; }
trap cleanup EXIT

app_root="$fixture/app"
legacy_root="$fixture/legacy"
release="$fixture/release"
mkdir -p "$fixture/bin" "$legacy_root/data" "$release"
printf 'SECRET=value\n' >"$legacy_root/.env"
printf '{"preserved":true}\n' >"$legacy_root/data/funding-history.json"
cp "$root/ecosystem.config.cjs" "$release/ecosystem.config.cjs"
ln -s "$release" "$app_root-current"
mkdir -p "$app_root"
mv "$app_root-current" "$app_root/current"

cat >"$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == '-C' && "$3" == 'diff' && "$4" == '--no-ext-diff' ]] || exit 2
printf 'diff --git a/legacy.js b/legacy.js\n'
EOF

cat >"$fixture/bin/rsync" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == '-a' ]] || exit 2
if [[ -f "$COLLECTOR_STOP_MARKER" ]]; then
  printf 'stopped\n' >>"$MIGRATION_LOG"
else
  printf 'running\n' >>"$MIGRATION_LOG"
fi
source="${2%/}"
destination="${3%/}"
mkdir -p "$destination"
cp -a "$source"/. "$destination"/
EOF

cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MIGRATION_LOG"
case "$1" in
  save) printf '{}' >"${@: -1}" ;;
  stop) touch "$COLLECTOR_STOP_MARKER" ;;
  startOrRestart)
    [[ -f "$COLLECTOR_STOP_MARKER" ]] || exit 1
    [[ "${PM2_FAIL_START:-0}" != 1 ]]
    ;;
  resurrect) touch "$PM2_RESTORED_MARKER" ;;
esac
EOF

cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$MIGRATION_LOG"
exit 0
EOF
chmod 0755 "$fixture/bin"/*

run_migration() {
  PATH="$fixture/bin:$PATH" \
  APP_ROOT="$app_root" \
  LEGACY_ROOT="$legacy_root" \
  LOCAL_HEALTH_URL='http://127.0.0.1:3000/' \
  PUBLIC_HEALTH_URL='https://data.dvcapital.xyz/' \
  MIGRATION_LOG="$fixture/migration.log" \
  COLLECTOR_STOP_MARKER="$fixture/collectors-stopped" \
  PM2_RESTORED_MARKER="$fixture/pm2-restored" \
  "$@" bash "$script"
}

run_migration
rm -f -- "$fixture/collectors-stopped"
run_migration

[[ "$(cat "$legacy_root/.env")" == 'SECRET=value' ]] || fail 'migration modified legacy .env'
[[ "$(cat "$legacy_root/data/funding-history.json")" == '{"preserved":true}' ]] || fail 'migration modified legacy runtime data'
[[ "$(cat "$app_root/shared/.env")" == 'SECRET=value' ]] || fail 'shared .env was not copied'
[[ -f "$app_root/shared/data/funding-history.json" ]] || fail 'legacy data was not copied to shared/data'
[[ -f "$app_root/legacy-code-diff-20260804.patch" ]] || fail 'legacy diff was not archived'
[[ -f "$app_root/legacy-code-diff-20260804.patch.sha256" ]] || fail 'legacy diff checksum was not written'

node - "$app_root/shared" "$app_root/legacy-code-diff-20260804.patch" "$app_root/legacy-code-diff-20260804.patch.sha256" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const [shared, patch, checksum] = process.argv.slice(2);
if ((fs.statSync(shared).mode & 0o777) !== 0o750) throw new Error('shared mode is not 0750');
if ((fs.statSync(`${shared}/data`).mode & 0o777) !== 0o750) throw new Error('shared/data mode is not 0750');
if ((fs.statSync(`${shared}/.env`).mode & 0o777) !== 0o600) throw new Error('shared .env mode is not 0600');
const expected = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
const actual = crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex');
if (actual !== expected) throw new Error('legacy diff checksum does not match');
NODE

[[ "$(grep -c '^running$' "$fixture/migration.log")" == 2 ]] || fail 'initial rsync did not run before collectors stopped'
[[ "$(grep -c '^stopped$' "$fixture/migration.log")" == 2 ]] || fail 'final rsync did not run after collectors stopped'
grep -Fq 'stop funding-collector arbitrage-collector staking-collector positions-collector' "$fixture/migration.log" || fail 'collectors were not stopped for final sync'
grep -Fq "startOrRestart $app_root/current/ecosystem.config.cjs --update-env" "$fixture/migration.log" || fail 'PM2 did not switch to the current ecosystem config'
grep -Fq 'http://127.0.0.1:3000/' "$fixture/migration.log" || fail 'local health check did not run'
grep -Fq 'https://data.dvcapital.xyz/' "$fixture/migration.log" || fail 'public health check did not run'

rm -f -- "$fixture/collectors-stopped" "$fixture/pm2-restored"
if run_migration env PM2_FAIL_START=1; then
  fail 'PM2 switch failure unexpectedly succeeded'
fi
[[ -f "$fixture/pm2-restored" ]] || fail 'failed PM2 switch did not restore the previous PM2 process snapshot'
grep -Fq 'resurrect ' "$fixture/migration.log" || fail 'migration did not invoke pm2 resurrect after a failed switch'

echo 'migration layout tests passed'
