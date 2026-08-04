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
  local original_dump_mode="${1:-absent}"
  local fixture
  fixture="$(mktemp -d)"
  local app_root="$fixture/app"
  local legacy_root="$fixture/legacy"
  local release="$fixture/release"
  local pm2_home="$fixture/pm2-home"
  mkdir -p "$fixture/bin" "$legacy_root/data/nested" "$legacy_root/src" "$release" "$pm2_home" "$app_root"
  printf 'SECRET=value\n' >"$legacy_root/.env"
  printf '{"preserved":true}\n' >"$legacy_root/data/funding-history.json"
  printf 'nested history\n' >"$legacy_root/data/nested/history.txt"
  printf 'untracked source\n' >"$legacy_root/src/untracked.js"
  printf 'dash\n' >"$legacy_root/src/-leading.js"
  printf 'space\n' >"$legacy_root/src/with space.js"
  printf 'newline\n' >"$legacy_root/src/line"$'\n'"break.js"
  cp "$root/ecosystem.config.cjs" "$release/ecosystem.config.cjs"
  ln -s "$release" "$app_root/current"

  node - "$fixture/initial-state.json" "$legacy_root" <<'NODE'
const fs = require('fs');
const [file, legacy] = process.argv.slice(2);
const names = [
  'perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector',
];
fs.writeFileSync(file, JSON.stringify({ apps: [
  ...names.map((name) => ({ pm_id: 1, pm2_env: { name, pm_exec_path: name === 'perp-dashboard' ? 'npm' : `scripts/${name}.js`, pm_cwd: legacy, status: 'online', env: { FIXTURE: 'yes' } } })),
  { pm_id: 99, pm2_env: { name: 'unrelated-worker', pm_exec_path: 'unrelated.js', pm_cwd: '/srv/unrelated', status: 'online', env: { KEEP: 'yes' }, restarts: 7 } },
] }, null, 2));
NODE
  cp "$fixture/initial-state.json" "$fixture/pm2-state.json"
  if [[ "$original_dump_mode" == present ]]; then
    node - "$pm2_home/dump.pm2" <<'NODE'
const fs = require('fs');
const names = [
  'perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector',
];
fs.writeFileSync(process.argv[2], JSON.stringify({ apps: [
  ...names.map((name) => ({ name, cwd: '/persisted-before-migration', status: 'stopped' })),
  { name: 'unrelated-worker', cwd: '/persisted-unrelated', status: 'stopped', restarts: 99 },
] }, null, 2));
NODE
    cp "$pm2_home/dump.pm2" "$fixture/expected-original-dump.pm2"
  fi

  cat >"$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == '-C' ]] || exit 2
printf '%s\n' "$*" >>"$GIT_LOG"
case "$3" in
  diff) printf 'diff --git a/staged.js b/staged.js\ndiff --git a/unstaged.js b/unstaged.js\n' ;;
  ls-files) printf 'src/untracked.js\0src/-leading.js\0src/with space.js\0src/line\nbreak.js\0.env\0data/runtime.json\0' ;;
  *) exit 2 ;;
esac
EOF

  cat >"$fixture/bin/rsync" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == '-a' ]] || exit 2
printf '%s\n' "$*" >>"$RSYNC_LOG"
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
  jlist)
    node - "$PM2_STATE" <<'NODE'
const fs = require('fs');
console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2])).apps));
NODE
    ;;
  stop)
    touch "$COLLECTOR_STOP_MARKER"
    node - "$PM2_STATE" "$@" <<'NODE'
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
for (const app of state.apps) if (names.includes(app.pm2_env?.name)) app.pm2_env.status = 'stopped';
fs.writeFileSync(file, JSON.stringify(state));
NODE
    ;;
  startOrRestart)
    [[ "$2" == '--update-env' && "$#" == 2 ]] || exit 2
    [[ "$1" != "$CURRENT_CWD/ecosystem.config.cjs" || "${FAIL_PM2_START:-0}" != 1 ]] || exit 1
    node - "$PM2_STATE" "$1" "$CURRENT_CWD" <<'NODE'
const fs = require('fs');
const [file, configFile, current] = process.argv.slice(2);
const names = new Set(['perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector']);
const state = JSON.parse(fs.readFileSync(file));
const config = require(configFile);
const currentConfig = configFile === `${current}/ecosystem.config.cjs`;
for (const replacement of config.apps) {
  if (!names.has(replacement.name)) continue;
  let app = state.apps.find((candidate) => candidate.pm2_env?.name === replacement.name);
  if (!app) {
    app = { pm_id: 1, pm2_env: { name: replacement.name, pm_exec_path: replacement.script, env: {} } };
    state.apps.push(app);
  }
  app.pm2_env.pm_exec_path = replacement.script;
  if (replacement.env) app.pm2_env.env = replacement.env;
  app.pm2_env.pm_cwd = currentConfig ? current : replacement.cwd;
  app.pm2_env.status = replacement.name === 'funding-collector' && currentConfig && process.env.ERRORED_COLLECTOR === '1' ? 'errored' : 'online';
}
fs.writeFileSync(file, JSON.stringify(state));
NODE
    ;;
  delete)
    node - "$PM2_STATE" "$@" <<'NODE'
const fs = require('fs');
const [file, ...names] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
state.apps = state.apps.filter((app) => !names.includes(app.pm2_env?.name));
fs.writeFileSync(file, JSON.stringify(state));
NODE
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
  cat >"$fixture/bin/tar" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TAR_LOG"
archive=""
list=""
while (($#)); do
  case "$1" in
    -cf) archive="$2"; shift 2 ;;
    -T) list="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$archive" ]] || exit 2
if [[ -n "$list" && -s "$list" ]]; then cp "$list" "$archive"; else : >"$archive"; fi
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
  GIT_LOG="$fixture/git.log" \
  RSYNC_LOG="$fixture/rsync.log" \
  TAR_LOG="$fixture/tar.log" \
  CURRENT_CWD="$fixture/app/current" \
  EXPECTED_USER="${EXPECTED_USER_TEST:-$(id -un)}" \
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
const assert = require('assert/strict');
const [expected, actual] = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file)));
const normalize = (state) => state.apps.slice().sort((a, b) => a.pm2_env.name.localeCompare(b.pm2_env.name));
assert.deepStrictEqual(normalize(actual), normalize(expected));
NODE
  if [[ "$dump_expected" == absent ]]; then
    [[ ! -e "$fixture/pm2-home/dump.pm2" ]] || fail 'recovery left a dump.pm2 that did not exist before migration'
  else
    [[ -f "$fixture/pm2-home/dump.pm2" ]] || fail 'recovery removed a pre-existing dump.pm2'
    cmp -s "$fixture/expected-original-dump.pm2" "$fixture/pm2-home/dump.pm2" || fail 'recovery changed the pre-existing PM2 dump'
  fi
  grep -Fxq 'delete perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector' "$fixture/pm2.log" || fail 'PM2 recovery did not delete only migration targets'
  grep -Fq 'startOrRestart ' "$fixture/pm2.log" || fail 'PM2 recovery did not start the target-only snapshot'
  ! grep -Fq 'unrelated-worker' "$fixture/pm2.log" || fail 'migration directly touched an unrelated PM2 process'
}

assert_dump_targets_current() {
  node - "$1/pm2-home/dump.pm2" "$1/app/current" <<'NODE'
const fs = require('fs');
const [file, current] = process.argv.slice(2);
const names = new Set(['perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector']);
const dump = JSON.parse(fs.readFileSync(file));
const targets = (dump.apps ?? dump).filter((app) => names.has(app.name));
if (targets.length !== names.size || targets.some((app) => app.pm_cwd !== current || app.status !== 'online' || !app.pm_exec_path || !app.env)) process.exit(1);
NODE
}

fixture="$(make_fixture)"
run_migration "$fixture"
assert_dump_targets_current "$fixture" || fail 'successful migration did not persist the current PM2 configuration'
node - "$fixture/app/legacy-code-untracked-20260804.txt" <<'NODE'
const fs = require('fs');
const names = fs.readFileSync(process.argv[2]).toString('utf8').split('\0').filter(Boolean);
for (const name of ['src/untracked.js', 'src/-leading.js', 'src/with space.js', 'src/line\nbreak.js']) if (!names.includes(name)) process.exit(1);
if (names.some((name) => name === '.env' || name.startsWith('data/'))) process.exit(1);
NODE
node - "$fixture/app/legacy-code-untracked-20260804.tar" <<'NODE'
const fs = require('fs');
const names = fs.readFileSync(process.argv[2]).toString('utf8').split('\0').filter(Boolean);
if (names.some((name) => name === '.env' || name.startsWith('data/'))) process.exit(1);
NODE
grep -Fq -- '--null --verbatim-files-from' "$fixture/tar.log" || fail 'untracked archive did not use NUL-safe tar input'
grep -Fq 'staged.js' "$fixture/app/legacy-code-diff-20260804.patch" || fail 'staged tracked diff was not archived'
grep -Fq 'unstaged.js' "$fixture/app/legacy-code-diff-20260804.patch" || fail 'unstaged tracked diff was not archived'
grep -Fq 'diff HEAD --binary' "$fixture/git.log" || fail 'audit did not request staged and unstaged tracked changes from HEAD'
grep -Fq ':(exclude).env' "$fixture/git.log" || fail 'audit did not exclude .env from tracked diff output'
node - "$fixture/app/legacy-code-diff-20260804.patch" "$fixture/app/legacy-code-diff-20260804.patch.sha256" "$fixture/app/legacy-code-untracked-20260804.txt" "$fixture/app/legacy-code-untracked-20260804.txt.sha256" "$fixture/app/legacy-code-untracked-20260804.tar" "$fixture/app/legacy-code-untracked-20260804.tar.sha256" <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
for (let index = 2; index < process.argv.length; index += 2) {
  const file = process.argv[index];
  const checksum = process.argv[index + 1];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const expected = fs.readFileSync(checksum, 'utf8').trim().split(/\s+/)[0];
  if (actual !== expected) process.exit(1);
}
NODE
rm -f -- "$fixture/collectors-stopped"
run_migration "$fixture"
assert_data_manifest_matches "$fixture" || fail 'shared data manifest differs after idempotent migration'
node - "$fixture/pm2-state.json" "$fixture/app/current" <<'NODE'
const fs = require('fs');
const [file, current] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
const targets = state.apps.filter((app) => app.pm2_env.name !== 'unrelated-worker');
if (targets.length !== 5 || targets.some((app) => app.pm2_env.pm_cwd !== current || app.pm2_env.status !== 'online')) process.exit(1);
const unrelated = state.apps.find((app) => app.pm2_env.name === 'unrelated-worker')?.pm2_env;
if (!unrelated || unrelated.pm_cwd !== '/srv/unrelated' || unrelated.status !== 'online' || unrelated.restarts !== 7) process.exit(1);
NODE
printf 'shared growth\n' >>"$fixture/app/shared/data/funding-history.json"
rsync_calls_before="$(wc -l < "$fixture/rsync.log" | tr -d ' ')"
run_migration "$fixture"
grep -Fq 'shared growth' "$fixture/app/shared/data/funding-history.json" || fail 'marker validation overwrote shared data growth'
[[ "$(wc -l < "$fixture/rsync.log" | tr -d ' ')" == "$rsync_calls_before" ]] || fail 'marker validation ran rsync'
rm -rf -- "$fixture"

fixture="$(make_fixture present)"
run_migration "$fixture"
node - "$fixture/expected-original-dump.pm2" "$fixture/pm2-home/dump.pm2" <<'NODE'
const fs = require('fs');
const [before, after] = process.argv.slice(2).map((file) => JSON.parse(fs.readFileSync(file)));
const find = (value) => (value.apps ?? value).find((app) => app.name === 'unrelated-worker');
if (JSON.stringify(find(before)) !== JSON.stringify(find(after))) process.exit(1);
NODE
! grep -Fq 'unrelated-worker' "$fixture/pm2.log" || fail 'successful migration touched an unrelated PM2 process'
rm -rf -- "$fixture"

fixture="$(make_fixture)"
bad_app="$fixture/must-not-exist"
if run_migration "$fixture" env EXPECTED_USER=definitely-not-"$(id -un)" APP_ROOT="$bad_app"; then
  fail 'migration unexpectedly ran as an incorrect user'
fi
[[ ! -e "$bad_app" ]] || fail 'incorrect-user migration created application directories'
rm -rf -- "$fixture"

# A failure before PM2 snapshot initialization must leave an existing dump byte-for-byte untouched.
fixture="$(make_fixture present)"
bad_app="$fixture/must-not-exist"
if run_migration "$fixture" env EXPECTED_USER=definitely-not-"$(id -un)" APP_ROOT="$bad_app"; then
  fail 'early failure unexpectedly succeeded'
fi
cmp -s "$fixture/expected-original-dump.pm2" "$fixture/pm2-home/dump.pm2" || fail 'early failure modified the pre-existing PM2 dump'
rm -rf -- "$fixture"

fixture="$(make_fixture)"
bad_app="$fixture/legacy/must-not-exist"
if run_migration "$fixture" env APP_ROOT="$bad_app"; then
  fail 'migration unexpectedly allowed application root inside legacy checkout'
fi
[[ ! -e "$bad_app" ]] || fail 'misconfigured application root modified the legacy checkout'
rm -rf -- "$fixture"

for failure in final_rsync pm2_start local_health public_health manifest collector_errored; do
  fixture="$(make_fixture)"
  case "$failure" in
    final_rsync) command=(env FAIL_FINAL_RSYNC=1) ;;
    pm2_start) command=(env FAIL_PM2_START=1) ;;
    local_health) command=(env FAIL_LOCAL_HEALTH=1) ;;
    public_health) command=(env FAIL_PUBLIC_HEALTH=1) ;;
    manifest) command=(env MANIFEST_MISMATCH=1) ;;
    collector_errored) command=(env ERRORED_COLLECTOR=1) ;;
  esac
  if run_migration "$fixture" "${command[@]}"; then
    fail "$failure failure unexpectedly succeeded"
  fi
  assert_recovered "$fixture" absent
  rm -rf -- "$fixture"
done

fixture="$(make_fixture present)"
if run_migration "$fixture" env FAIL_PM2_START=1; then
  fail 'failure with an existing PM2 dump unexpectedly succeeded'
fi
assert_recovered "$fixture" present
rm -rf -- "$fixture"

echo 'migration layout tests passed'
