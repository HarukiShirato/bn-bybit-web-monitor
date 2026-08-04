#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/deploy-production.sh"
sha=0123456789abcdef0123456789abcdef01234567

fail() { echo "simple deploy test failed: $*" >&2; exit 1; }

make_fixture() {
  local fixture
  fixture="$(mktemp -d)"
  mkdir -p "$fixture/bin" "$fixture/live/.git" "$fixture/live/data" "$fixture/source/data" "$fixture/home"
  printf 'old-code\n' >"$fixture/live/app.txt"
  printf 'server-secret\n' >"$fixture/live/.env"
  printf 'runtime-data\n' >"$fixture/live/data/runtime.json"
  printf 'git-state\n' >"$fixture/live/.git/state"
  printf 'new-code\n' >"$fixture/source/app.txt"
  printf 'repository-secret\n' >"$fixture/source/.env"
  printf 'repository-data\n' >"$fixture/source/data/runtime.json"
  cp "$root/ecosystem.config.cjs" "$fixture/source/ecosystem.config.cjs"
  node - "$fixture/source/ecosystem.config.cjs" "$fixture/live" <<'NODE'
const fs = require('fs'); const [file, live] = process.argv.slice(2); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('/home/ec2-user/perp-dashboard', live));
NODE

  node - "$fixture/pm2-state.json" "$fixture/live" <<'NODE'
const fs = require('fs');
const [file, cwd] = process.argv.slice(2);
const names = ['perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector'];
fs.writeFileSync(file, JSON.stringify(names.map((name) => ({pm2_env: {name, status: 'online', pm_cwd: cwd, pm_exec_path: name === 'perp-dashboard' ? '/usr/bin/npm' : `${cwd}/scripts/${name}.js`, env: {KEEP: 'yes'}}}))));
NODE

  cat >"$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "$1" in
  clone) destination="${@: -1}"; mkdir -p "$destination"; cp -a "$SOURCE/." "$destination/"; mkdir -p "$destination/.git" ;;
  -C)
    case "$3" in
      fetch|checkout) : ;;
      rev-parse) printf '%s\n' "$EXPECTED_SHA" ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
EOF
  cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$NPM_LOG"
[[ "${FAIL_BUILD:-0}" != 1 ]]
EOF
  cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$PM2_LOG"
command="$1"; shift
case "$command" in
  jlist) cat "$PM2_STATE" ;;
  stop)
    node - "$PM2_STATE" "$@" <<'NODE'
const fs=require('fs'); const [file,...names]=process.argv.slice(2); const apps=JSON.parse(fs.readFileSync(file)); for(const app of apps) if(names.includes(app.pm2_env.name)) app.pm2_env.status='stopped'; fs.writeFileSync(file,JSON.stringify(apps));
NODE
    ;;
  delete)
    node - "$PM2_STATE" "$@" <<'NODE'
const fs=require('fs'); const [file,...names]=process.argv.slice(2); const apps=JSON.parse(fs.readFileSync(file)).filter(app=>!names.includes(app.pm2_env.name)); fs.writeFileSync(file,JSON.stringify(apps));
NODE
    ;;
  startOrRestart|start)
    config="$1"
    node - "$PM2_STATE" "$config" <<'NODE'
const fs=require('fs'); const [file,configFile]=process.argv.slice(2); const config=require(configFile); let apps=JSON.parse(fs.readFileSync(file)); for(const item of config.apps){let app=apps.find(x=>x.pm2_env.name===item.name); if(!app){app={pm2_env:{name:item.name}};apps.push(app)} app.pm2_env.status='online';app.pm2_env.pm_cwd=item.cwd;app.pm2_env.pm_exec_path=item.script;app.pm2_env.env=item.env??{};} fs.writeFileSync(file,JSON.stringify(apps));
NODE
    ;;
  *) exit 2 ;;
esac
EOF
  cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
url="${@: -1}"
if [[ "$url" == https://* && "${FAIL_FIRST_PUBLIC:-0}" == 1 && ! -e "$PUBLIC_FAILED" ]]; then touch "$PUBLIC_FAILED"; exit 1; fi
EOF
  cat >"$fixture/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$fixture/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod 0755 "$fixture/bin"/*
  printf '%s\n' "$fixture"
}

run_deploy() {
  local fixture="$1"; shift
  PATH="$fixture/bin:$PATH" HOME="$fixture/home" SOURCE="$fixture/source" EXPECTED_SHA="$sha" \
    PRODUCTION_ROOT="$fixture/live" WORK_ROOT="$fixture/work" BACKUP_ROOT="$fixture/backups" \
    DEPLOY_LOG_ROOT="$fixture/logs" LOCK_ROOT="$fixture/locks" PM2_STATE="$fixture/pm2-state.json" \
    PM2_LOG="$fixture/pm2.log" NPM_LOG="$fixture/npm.log" PUBLIC_FAILED="$fixture/public-failed" \
    EXPECTED_USER="$(id -un)" LOCAL_HEALTH_URL=http://local/ PUBLIC_HEALTH_URL=https://public/ \
    "$@" bash "$script" "$sha"
}

fixture="$(make_fixture)"
output="$(run_deploy "$fixture")"
[[ "$(cat "$fixture/live/app.txt")" == new-code ]] || fail 'code was not updated'
[[ "$(cat "$fixture/live/.env")" == server-secret ]] || fail '.env was overwritten'
[[ "$(cat "$fixture/live/data/runtime.json")" == runtime-data ]] || fail 'runtime data was overwritten'
[[ "$(cat "$fixture/live/.git/state")" == git-state ]] || fail '.git was overwritten'
for marker in "DEPLOY_SHA=$sha" DEPLOY_PM2=online DEPLOY_LOCAL_HEALTH=ok DEPLOY_PUBLIC_HEALTH=ok; do grep -Fxq "$marker" <<<"$output" || fail "missing $marker"; done
rm -rf -- "$fixture"

fixture="$(make_fixture)"
if run_deploy "$fixture" env FAIL_FIRST_PUBLIC=1; then fail 'public-health failure unexpectedly succeeded'; fi
[[ "$(cat "$fixture/live/app.txt")" == old-code ]] || fail 'rollback did not restore old code'
[[ "$(cat "$fixture/live/.env")" == server-secret ]] || fail 'rollback changed .env'
[[ "$(cat "$fixture/live/data/runtime.json")" == runtime-data ]] || fail 'rollback changed runtime data'
node - "$fixture/pm2-state.json" "$fixture/live" <<'NODE'
const fs=require('fs'); const [file,cwd]=process.argv.slice(2); const apps=JSON.parse(fs.readFileSync(file)); if(apps.length!==5||apps.some(app=>app.pm2_env.status!=='online'||app.pm2_env.pm_cwd!==cwd)) process.exit(1);
NODE
rm -rf -- "$fixture"

fixture="$(make_fixture)"
if run_deploy "$fixture" env FAIL_BUILD=1; then fail 'build failure unexpectedly succeeded'; fi
[[ "$(cat "$fixture/live/app.txt")" == old-code ]] || fail 'build failure touched production code'
! grep -Eq 'stop|start|delete' "$fixture/pm2.log" 2>/dev/null || fail 'build failure touched PM2'
rm -rf -- "$fixture"

echo 'simple deploy behavior tests passed'
