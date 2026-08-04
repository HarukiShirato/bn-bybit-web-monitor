#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/deploy-production.sh"
sha='0123456789abcdef0123456789abcdef01234567'

fail() {
  echo "deploy-production test failed: $*" >&2
  exit 1
}

assert_link() {
  local link="$1"
  local expected="$2"
  [[ "$(cd "$link" && pwd -P)" == "$(cd "$expected" && pwd -P)" ]] || fail "expected $link to link to $expected"
}

assert_absent() {
  [[ ! -e "$1" && ! -L "$1" ]] || fail "expected absent: $1"
}

write_success_marker() {
  local release="$1"
  local release_sha="$2"
  printf '{"sha":"%s","deployed_at":"fixture"}\n' "$release_sha" >"$release/.deployment-success.json"
}

pm2_calls() {
  local fixture="$1"
  [[ -f "$fixture/pm2-calls" ]] && cat "$fixture/pm2-calls" || printf '0\n'
}

make_fixture() {
  local fixture
  fixture="$(mktemp -d)"
  mkdir -p "$fixture/bin" "$fixture/app/releases" "$fixture/app/shared/data"
  : >"$fixture/app/shared/.env"
  printf '{"schema":1}\n' >"$fixture/app/shared/production-layout-migration-v1.json"

  cat >"$fixture/bin/flock" <<'EOF'
#!/usr/bin/env bash
[[ "${FLOCK_FAIL:-0}" != 1 ]]
EOF
  cat >"$fixture/bin/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == clone ]]; then
  destination="${@: -1}"
  mkdir -p "$destination/.git"
  exit 0
fi
if [[ "$1" == -C ]]; then
  directory="$2"
  shift 2
  case "$1" in
    fetch) exit 0 ;;
    checkout) printf '%s\n' "${@: -1}" >"$directory/.fake-head"; exit 0 ;;
    rev-parse)
      if [[ -n "${GIT_HEAD:-}" ]]; then
        printf '%s\n' "$GIT_HEAD"
      else
        cat "$directory/.fake-head"
      fi
      exit 0
      ;;
  esac
fi
exit 1
EOF
  cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMAND_LOG"
if [[ "${NPM_ASSERT_SHARED:-0}" == 1 ]]; then
  [[ ! -e .env ]]
fi
[[ "${NPM_FAIL:-0}" != 1 ]]
EOF
cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == jlist ]]; then
  printf '%s\n' "$*" >>"$COMMAND_LOG"
  calls=0
  [[ -f "$PM2_CALLS_FILE" ]] && calls="$(cat "$PM2_CALLS_FILE")"
  node - "$CURRENT_CWD" "$calls" <<'NODE'
const [cwd, calls] = process.argv.slice(2);
const names = ['perp-dashboard','funding-collector','arbitrage-collector','staking-collector','positions-collector'];
console.log(JSON.stringify(names.map((name) => ({pm2_env:{name,pm_cwd:cwd,status:(process.env.ERRORED_COLLECTOR==='1'||(process.env.ROLLBACK_ERRORED==='1'&&Number(calls)>=3))&&name==='funding-collector'?'errored':'online'}}))));
NODE
  exit 0
fi
calls=0
[[ -f "$PM2_CALLS_FILE" ]] && calls="$(cat "$PM2_CALLS_FILE")"
calls=$((calls + 1))
printf '%s\n' "$calls" >"$PM2_CALLS_FILE"
printf '%s\n' "$*" >>"$COMMAND_LOG"
[[ "${PM2_FAIL_AT:-0}" != "$calls" ]]
EOF
  cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMAND_LOG"
url="${@: -1}"
if [[ "$url" == http://127.0.0.1:3000/* && "${LOCAL_FAIL:-0}" == 1 ]]; then
  exit 1
fi
if [[ "$url" == https://data.dvcapital.xyz/* && "${PUBLIC_FAIL:-0}" == 1 ]]; then
  exit 1
fi
if [[ "$url" == https://data.dvcapital.xyz/* && "${PUBLIC_FAIL_ONCE:-0}" == 1 ]]; then
  count=0; [[ -f "$PUBLIC_CALLS_FILE" ]] && count="$(cat "$PUBLIC_CALLS_FILE")"; count=$((count + 1)); printf '%s\n' "$count" >"$PUBLIC_CALLS_FILE"
  (( count > 1 )) || exit 1
fi
exit 0
EOF
  cat >"$fixture/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf 'sleep %s\n' "$*" >>"$COMMAND_LOG"
exit 0
EOF
  cat >"$fixture/bin/find" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FIND_ARGUMENT_LOG"
if [[ -n "${FIND_OUTPUT:-}" ]]; then
  printf '%s\n' "$FIND_OUTPUT"
fi
EOF
  cat >"$fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
calls=0
[[ -f "$MV_CALLS_FILE" ]] && calls="$(cat "$MV_CALLS_FILE")"
calls=$((calls + 1))
printf '%s\n' "$calls" >"$MV_CALLS_FILE"
if [[ "${MV_FAIL_AT:-0}" == "$calls" ]]; then
  exit 1
fi
if [[ "$1" == '-Tf' ]]; then
  rm -f -- "$3"
  /bin/mv "$2" "$3"
  [[ "${MV_MOVE_THEN_FAIL_AT:-0}" != "$calls" ]] || exit 1
  exit 0
fi
/bin/mv "$@"
[[ "${MV_MOVE_THEN_FAIL_AT:-0}" != "$calls" ]] || exit 1
EOF
  chmod 0755 "$fixture/bin"/*
  printf '%s\n' "$fixture"
}

run_deploy() {
  local fixture="$1"
  shift
  PATH="$fixture/bin:$PATH" \
  APP_ROOT="$fixture/app" \
  EXPECTED_USER="${EXPECTED_USER_TEST:-$(id -un)}" \
  COMMAND_LOG="$fixture/commands.log" \
  PM2_CALLS_FILE="$fixture/pm2-calls" \
  FIND_ARGUMENT_LOG="$fixture/find-arguments.log" \
  MV_CALLS_FILE="$fixture/mv-calls" \
  EXPECTED_SHARED="$fixture/app/shared" \
  CURRENT_CWD="$fixture/app/current" \
  PUBLIC_CALLS_FILE="$fixture/public-calls" \
  "$@" bash "$script" "$sha"
}

run_prepare() {
  local fixture="$1"
  PATH="$fixture/bin:$PATH" \
  APP_ROOT="$fixture/app" \
  EXPECTED_USER="$(id -un)" \
  COMMAND_LOG="$fixture/commands.log" \
  PM2_CALLS_FILE="$fixture/pm2-calls" \
  FIND_ARGUMENT_LOG="$fixture/find-arguments.log" \
  MV_CALLS_FILE="$fixture/mv-calls" \
  EXPECTED_SHARED="$fixture/app/shared" \
  CURRENT_CWD="$fixture/app/current" \
  PUBLIC_CALLS_FILE="$fixture/public-calls" \
  bash "$script" --prepare-only "$sha"
}

[[ -f "$script" ]] || fail 'deployment script is missing'

fixture="$(make_fixture)"
wrong_user_app="$fixture/must-not-exist"
if PATH="$fixture/bin:$PATH" APP_ROOT="$wrong_user_app" EXPECTED_USER=definitely-not-"$(id -un)" bash "$script" "$sha" >/dev/null 2>&1; then
  fail 'incorrect deployment user unexpectedly succeeded'
fi
assert_absent "$wrong_user_app"
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"; mkdir -p "$old"; ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env ERRORED_COLLECTOR=1; then fail 'errored collector unexpectedly passed deployment verification'; fi
assert_link "$fixture/app/current" "$old"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'collector verification failure was deleted without a verified rollback'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"; mkdir -p "$old"; ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PUBLIC_FAIL_ONCE=1 ROLLBACK_ERRORED=1; then fail 'rollback collector verification failure unexpectedly succeeded'; fi
assert_link "$fixture/app/current" "$old"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'failed release was deleted despite an errored rollback collector'
rm -rf "$fixture"

fixture="$(make_fixture)"
if PATH="$fixture/bin:$PATH" APP_ROOT="$fixture/app" bash "$script" not-a-sha >/dev/null 2>&1; then
  fail 'invalid SHA unexpectedly succeeded'
else
  status=$?
  [[ "$status" == 64 ]] || fail "invalid SHA exited $status, expected 64"
fi
assert_absent "$fixture/app/current"
rm -rf "$fixture"

fixture="$(make_fixture)"
if run_deploy "$fixture" env FLOCK_FAIL=1; then
  fail 'lock contention unexpectedly succeeded'
else
  status=$?
  [[ "$status" == 75 ]] || fail "lock contention exited $status, expected 75"
fi
assert_absent "$fixture/app/current"
assert_absent "$fixture/app/releases/.$sha.tmp"
[[ ! -d "$fixture/app/shared/deploy-logs" ]] || [[ -z "$(find "$fixture/app/shared/deploy-logs" -type f -print -quit)" ]] || fail 'lock loser created a deployment log'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env GIT_HEAD=ffffffffffffffffffffffffffffffffffffffff; then
  fail 'HEAD mismatch unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_absent "$fixture/app/releases/.$sha.tmp"
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env NPM_FAIL=1; then
  fail 'build failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_absent "$fixture/app/previous"
assert_absent "$fixture/app/releases/.$sha.tmp"
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
run_prepare "$fixture"
[[ -f "$fixture/app/releases/$sha/.deployment-prepared.json" ]] || fail 'prepare-only did not create a prepared release'
[[ ! -e "$fixture/app/releases/$sha/.env" ]] || fail 'prepare-only linked production env before migration'
assert_absent "$fixture/app/current"
[[ "$(pm2_calls "$fixture")" == 0 ]] || fail 'prepare-only touched PM2'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
run_deploy "$fixture" env NPM_ASSERT_SHARED=1
[[ "$(readlink "$fixture/app/releases/$sha/.env")" == "$fixture/app/shared/.env" ]] || fail 'release .env is not shared'
[[ "$(readlink "$fixture/app/releases/$sha/data")" == "$fixture/app/shared/data" ]] || fail 'release data is not shared'
grep -Fq "\"sha\":\"$sha\"" "$fixture/app/releases/$sha/.deployment-success.json" || fail 'success marker lacks SHA'
grep -Fq '"deployed_at"' "$fixture/app/releases/$sha/.deployment-success.json" || fail 'success marker lacks deployment time'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
run_deploy "$fixture"
logs_before="$(find "$fixture/app/shared/deploy-logs" -type f | wc -l | tr -d ' ')"
commands_before="$(wc -l <"$fixture/commands.log" | tr -d ' ')"
rerun_output="$(run_deploy "$fixture")"
for milestone in "DEPLOY_SHA=$sha" 'DEPLOY_PM2=online' 'DEPLOY_LOCAL_HEALTH=ok' 'DEPLOY_PUBLIC_HEALTH=ok'; do
  grep -Fxq "$milestone" <<<"$rerun_output" || fail "same-SHA rerun omitted milestone: $milestone"
done
logs_after="$(find "$fixture/app/shared/deploy-logs" -type f | wc -l | tr -d ' ')"
[[ "$logs_after" == $((logs_before + 1)) ]] || fail 'same-SHA rerun was not idempotent with a unique log'
[[ "$(pm2_calls "$fixture")" == 2 ]] || fail 'same-SHA rerun mutated PM2 state'
tail -n "+$((commands_before + 1))" "$fixture/commands.log" >"$fixture/same-sha-commands.log"
grep -Fxq 'jlist' "$fixture/same-sha-commands.log" || fail 'same-SHA rerun did not inspect PM2 state'
! grep -Eq '(^| )(start|startOrRestart|startOrReload|stop|reload|restart|delete)( |$)' "$fixture/same-sha-commands.log" || fail 'same-SHA rerun issued a mutating PM2 command'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PM2_FAIL_AT=2; then
  fail 'initial PM2 reload failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$old"
[[ "$(pm2_calls "$fixture")" == 3 ]] || fail 'PM2 reload failure did not invoke rollback exactly once'
[[ "$(grep -Fc 'startOrRestart ecosystem.config.cjs --update-env' "$fixture/commands.log")" == 2 ]] || fail 'deploy and rollback did not switch all five PM2 targets'
assert_absent "$fixture/app/releases/.$sha.tmp"
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env LOCAL_FAIL=1; then
  fail 'local health failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
[[ "$(pm2_calls "$fixture")" == 3 ]] || fail 'local health failure did not trigger exactly one PM2 rollback reload'
[[ "$(grep -Fc -- '--max-time 2 http://127.0.0.1:3000/' "$fixture/commands.log")" == 24 ]] || fail 'deploy and rollback did not use bounded local-health polling'
[[ "$(grep -Fc 'sleep 3' "$fixture/commands.log")" == 22 ]] || fail 'local health did not use the bounded three-second retry interval'
! grep -Fq 'https://data.dvcapital.xyz/' "$fixture/commands.log" || fail 'public health ran after local health failed'
[[ -d "$fixture/app/releases/$sha" ]] || fail 'failed release was deleted before rollback health recovered'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PUBLIC_FAIL=1; then
  fail 'public health failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
[[ "$(pm2_calls "$fixture")" == 3 ]] || fail 'rollback recovery failure did not invoke PM2 exactly three times'
[[ "$(grep -Fc 'https://data.dvcapital.xyz/' "$fixture/commands.log")" == 2 ]] || fail 'rollback did not verify public health'
assert_absent "$fixture/app/releases/.$sha.tmp"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'failed release was deleted after rollback public health failed'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PUBLIC_FAIL=1 MV_FAIL_AT=4; then
  fail 'rollback link-switch failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$fixture/app/releases/$sha"
assert_link "$fixture/app/previous" "$old"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'rollback link-switch failure deleted the active failed release'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PUBLIC_FAIL=1 MV_MOVE_THEN_FAIL_AT=4; then
  fail 'rollback move-then-fail unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$old"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'failed release was deleted after rollback verification failed'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
original_previous="$fixture/app/releases/original-previous"
mkdir -p "$old" "$original_previous"
ln -s "$old" "$fixture/app/current"
ln -s "$original_previous" "$fixture/app/previous"
if run_deploy "$fixture" env MV_FAIL_AT=3; then
  fail 'forward current link-switch failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$original_previous"
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
original_previous="$fixture/app/releases/original-previous"
mkdir -p "$old" "$original_previous"
ln -s "$old" "$fixture/app/current"
ln -s "$original_previous" "$fixture/app/previous"
if run_deploy "$fixture" env MV_MOVE_THEN_FAIL_AT=3; then
  fail 'forward move-then-fail unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$original_previous"
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
rm -f "$fixture/app/shared/production-layout-migration-v1.json"
if run_deploy "$fixture"; then
  fail 'ordinary deployment before migration unexpectedly succeeded'
fi
[[ "$(pm2_calls "$fixture")" == 0 ]] || fail 'pre-migration deployment touched PM2'
assert_absent "$fixture/app/releases/$sha"
assert_absent "$fixture/app/previous"
rm -rf "$fixture"

fixture="$(make_fixture)"
for release in old keep1 keep2 keep3 remove1 remove2 remove3 unverified; do
  mkdir -p "$fixture/app/releases/$release"
done
for release in old keep1 keep2 keep3 remove1 remove2 remove3; do
  write_success_marker "$fixture/app/releases/$release" "$release"
done
mkdir -p "$fixture/app/shared/external-success"
write_success_marker "$fixture/app/shared/external-success" 'external'
ln -s "$fixture/app/releases/old" "$fixture/app/current"
find_output="9 $fixture/app/releases/keep1"$'\n'
find_output+="8 $fixture/app/releases/keep2"$'\n'
find_output+="7 $fixture/app/releases/keep3"$'\n'
find_output+="6 $fixture/app/releases/remove1"$'\n'
find_output+="5 $fixture/app/releases/remove2"$'\n'
find_output+="4 $fixture/app/releases/remove3"$'\n'
find_output+="3 $fixture/app/releases/$sha"$'\n'
find_output+="2 $fixture/app/releases/old"$'\n'
find_output+="1 $fixture/app/shared/external-success"
run_deploy "$fixture" env FIND_OUTPUT="$find_output"
assert_link "$fixture/app/current" "$fixture/app/releases/$sha"
assert_link "$fixture/app/previous" "$fixture/app/releases/old"
[[ -d "$fixture/app/releases/old" ]] || fail 'cleanup deleted previous release'
[[ -d "$fixture/app/releases/$sha" ]] || fail 'cleanup deleted current release'
[[ ! -d "$fixture/app/releases/remove3" ]] || fail 'cleanup did not remove old successful releases'
[[ -d "$fixture/app/releases/unverified" ]] || fail 'cleanup deleted an unverified release'
[[ -d "$fixture/app/shared/external-success" ]] || fail 'cleanup deleted a successful marker outside releases'
[[ "$(find "$fixture/app/releases" -mindepth 2 -maxdepth 2 -name .deployment-success.json | wc -l | tr -d ' ')" == 5 ]] || fail 'cleanup did not retain exactly five successful releases'
grep -Fq -- "-name .deployment-success.json" "$fixture/find-arguments.log" || fail 'cleanup did not select successful-release markers'
rm -rf "$fixture"

echo 'deploy-production behavior tests passed'
