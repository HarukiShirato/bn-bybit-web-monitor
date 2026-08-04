#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/migrate-production-layout.sh"
target_names=(perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector)

fail() {
  echo "migrate-production-layout test failed: $*" >&2
  exit 1
}

[[ -f "$script" ]] || fail 'migration script is missing'

make_fixture() {
  local fixture
  fixture="$(mktemp -d)"
  local app_root="$fixture/app"
  local legacy_root="$fixture/legacy"
  local release="$fixture/release"
  local pm2_home="$fixture/pm2-home"
  mkdir -p "$fixture/bin" "$legacy_root/data/nested" "$release" "$pm2_home" "$app_root"
  printf 'SECRET=value\n' >"$legacy_root/.env"
  printf '{"preserved":true}\n' >"$legacy_root/data/funding-history.json"
  printf 'nested history\n' >"$legacy_root/data/nested/history.txt"
  cp "$root/ecosystem.config.cjs" "$release/ecosystem.config.cjs"
  ln -s "$release" "$app_root/current"

  node - "$fixture/initial-state.json" "$legacy_root" <<'NODE'
const fs = require('fs');
const [file, legacy] = process.argv.slice(2);
const names = [
  'perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector',
];
fs.writeFileSync(file, JSON.stringify({ apps: [
  ...names.map((name) => ({ name, cwd: legacy, status: 'online' })),
  { name: 'unrelated-worker', cwd: '/srv/unrelated', status: 'online', restarts: 7 },
] }, null, 2));
NODE
  cp "$fixture/initial-state.json" "$fixture/pm2-state.json"

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
if [[ -f "$COLLECTOR_STOP_MARKER" && "${FAIL_FINAL_RSYNC:-0}" == 1 ]]; then
  exit 1
fi
source="${2%/}"
destination="${3%/}"
mkdir -p "$destination"
cp -a "$source"/. "$destination"/
if [[ -f "$COLLECTOR_STOP_MARKER" && "${MANIFEST_MISMATCH:-0}" == 1 ]]; then
  printf 'mismatch\n' >>"$destination/funding-history.json"
fi
EOF

  cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$PM2_LOG"
command="$1"
shift
case "$command" in
  save)
    [[ "$#" == 0 ]] || exit 2
    cp "$PM2_STATE" "$PM2_HOME/dump.pm2"
    ;;
  stop)
    touch "$COLLECTOR_STOP_MARKER"
    node - "$PM2_STATE" "$@" <<'NODE'
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
for (const app of state.apps) if (names.includes(app.name)) app.status = 'stopped';
fs.writeFileSync(file, JSON.stringify(state));
NODE
    ;;
  startOrRestart)
    [[ "$1" == "$CURRENT_CWD/ecosystem.config.cjs" && "$2" == '--update-env' && "$#" == 2 ]] || exit 2
    [[ "${FAIL_PM2_START:-0}" != 1 ]] || exit 1
    node - "$PM2_STATE" "$CURRENT_CWD" <<'NODE'
const fs = require('fs');
const [file, current] = process.argv.slice(2);
const names = new Set(['perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector']);
const state = JSON.parse(fs.readFileSync(file));
for (const app of state.apps) {
  if (names.has(app.name)) { app.cwd = current; app.status = 'online'; }
}
fs.writeFileSync(file, JSON.stringify(state));
NODE
    ;;
  delete)
    node - "$PM2_STATE" "$@" <<'NODE'
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
state.apps = state.apps.filter((app) => !names.includes(app.name));
fs.writeFileSync(file, JSON.stringify(state));
NODE
    ;;
  resurrect)
    [[ "$#" == 0 ]] || exit 2
    cp "$PM2_HOME/dump.pm2" "$PM2_STATE"
    ;;
  *) exit 2 ;;
esac
EOF

  cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
url="${@: -1}"
if [[ "$url" == http://127.0.0.1:3000/* && "${FAIL_LOCAL_HEALTH:-0}" == 1 ]]; then exit 1; fi
if [[ "$url" == https://data.dvcapital.xyz/* && "${FAIL_PUBLIC_HEALTH:-0}" == 1 ]]; then exit 1; fi
EOF
  chmod 0755 "$fixture/bin"/*
  printf '%s\n' "$fixture"
}

run_migration() {
  local fixture="$1"
  shift
  PATH="$fixture/bin:$PATH" \
  APP_ROOT="$fixture/app" \
  LEGACY_ROOT="$fixture/legacy" \
  PM2_HOME="$fixture/pm2-home" \
  PM2_STATE="$fixture/pm2-state.json" \
  PM2_LOG="$fixture/pm2.log" \
  CURRENT_CWD="$fixture/app/current" \
  COLLECTOR_STOP_MARKER="$fixture/collectors-stopped" \
  LOCAL_HEALTH_URL='http://127.0.0.1:3000/' \
  PUBLIC_HEALTH_URL='https://data.dvcapital.xyz/' \
  "$@" bash "$script"
}

assert_data_manifest_matches() {
  node - "$1/legacy/data" "$1/app/shared/data" <<'NODE'
const fs = require('fs');
const path = require('path');
const manifest = (root) => {
  const result = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const stat = fs.statSync(file);
        result.push([path.relative(root, file), stat.size, stat.mtimeMs]);
      }
    }
  };
  walk(root);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
};
if (JSON.stringify(manifest(process.argv[2])) !== JSON.stringify(manifest(process.argv[3]))) process.exit(1);
NODE
}

assert_recovered() {
  local fixture="$1"
  local dump_expected="$2"
  node - "$fixture/initial-state.json" "$fixture/pm2-state.json" <<'NODE'
const fs = require('fs');
const [expected, actual] = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file)));
if (JSON.stringify(actual) !== JSON.stringify(expected)) process.exit(1);
NODE
  if [[ "$dump_expected" == absent ]]; then
    [[ ! -e "$fixture/pm2-home/dump.pm2" ]] || fail 'recovery left a dump.pm2 that did not exist before migration'
  else
    [[ -f "$fixture/pm2-home/dump.pm2" ]] || fail 'recovery removed a pre-existing dump.pm2'
  fi
  grep -Fxq 'save' "$fixture/pm2.log" || fail 'PM2 snapshot did not use pm2 save without arguments'
  grep -Fxq 'resurrect' "$fixture/pm2.log" || fail 'PM2 recovery did not use pm2 resurrect without arguments'
  grep -Fxq 'delete perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector' "$fixture/pm2.log" || fail 'PM2 recovery did not delete only migration targets'
  ! grep -Fq 'unrelated-worker' "$fixture/pm2.log" || fail 'migration directly touched an unrelated PM2 process'
}

fixture="$(make_fixture)"
run_migration "$fixture"
rm -f -- "$fixture/collectors-stopped"
run_migration "$fixture"
assert_data_manifest_matches "$fixture" || fail 'shared data manifest differs after idempotent migration'
node - "$fixture/pm2-state.json" "$fixture/app/current" <<'NODE'
const fs = require('fs');
const [file, current] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
const targets = state.apps.filter((app) => app.name !== 'unrelated-worker');
if (targets.length !== 5 || targets.some((app) => app.cwd !== current || app.status !== 'online')) process.exit(1);
const unrelated = state.apps.find((app) => app.name === 'unrelated-worker');
if (!unrelated || unrelated.cwd !== '/srv/unrelated' || unrelated.status !== 'online' || unrelated.restarts !== 7) process.exit(1);
NODE
rm -rf -- "$fixture"

for failure in final_rsync pm2_start local_health public_health manifest; do
  fixture="$(make_fixture)"
  case "$failure" in
    final_rsync) command=(env FAIL_FINAL_RSYNC=1) ;;
    pm2_start) command=(env FAIL_PM2_START=1) ;;
    local_health) command=(env FAIL_LOCAL_HEALTH=1) ;;
    public_health) command=(env FAIL_PUBLIC_HEALTH=1) ;;
    manifest) command=(env MANIFEST_MISMATCH=1) ;;
  esac
  if run_migration "$fixture" "${command[@]}"; then
    fail "$failure failure unexpectedly succeeded"
  fi
  assert_recovered "$fixture" absent
  rm -rf -- "$fixture"
done

fixture="$(make_fixture)"
cp "$fixture/initial-state.json" "$fixture/pm2-home/dump.pm2"
if run_migration "$fixture" env FAIL_PM2_START=1; then
  fail 'failure with an existing PM2 dump unexpectedly succeeded'
fi
assert_recovered "$fixture" present
rm -rf -- "$fixture"

echo 'migration layout tests passed'
