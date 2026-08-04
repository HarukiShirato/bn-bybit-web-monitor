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
  [[ -L .env && "$(readlink .env)" == "$EXPECTED_SHARED/.env" ]]
  [[ -L data && "$(readlink data)" == "$EXPECTED_SHARED/data" ]]
fi
[[ "${NPM_FAIL:-0}" != 1 ]]
EOF
  cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
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
  exec /bin/mv "$2" "$3"
fi
exec /bin/mv "$@"
EOF
  chmod 0755 "$fixture/bin"/*
  printf '%s\n' "$fixture"
}

run_deploy() {
  local fixture="$1"
  shift
  PATH="$fixture/bin:$PATH" \
  APP_ROOT="$fixture/app" \
  COMMAND_LOG="$fixture/commands.log" \
  PM2_CALLS_FILE="$fixture/pm2-calls" \
  FIND_ARGUMENT_LOG="$fixture/find-arguments.log" \
  MV_CALLS_FILE="$fixture/mv-calls" \
  EXPECTED_SHARED="$fixture/app/shared" \
  "$@" bash "$script" "$sha"
}

[[ -f "$script" ]] || fail 'deployment script is missing'

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
if run_deploy "$fixture" env PM2_FAIL_AT=1; then
  fail 'initial PM2 reload failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$old"
[[ "$(pm2_calls "$fixture")" == 2 ]] || fail 'PM2 reload failure did not invoke rollback exactly once'
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
[[ "$(pm2_calls "$fixture")" == 2 ]] || fail 'local health failure did not trigger exactly one PM2 rollback reload'
[[ "$(grep -Fc -- '--max-time 2 http://127.0.0.1:3000/' "$fixture/commands.log")" == 13 ]] || fail 'local health did not use 12 bounded attempts plus rollback verification'
[[ "$(grep -Fc 'sleep 3' "$fixture/commands.log")" == 11 ]] || fail 'local health did not use the bounded three-second retry interval'
! grep -Fq 'https://data.dvcapital.xyz/' "$fixture/commands.log" || fail 'public health ran after local health failed'
assert_absent "$fixture/app/releases/$sha"
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PUBLIC_FAIL=1 PM2_FAIL_AT=2; then
  fail 'public health failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
[[ "$(pm2_calls "$fixture")" == 2 ]] || fail 'rollback recovery failure did not invoke PM2 exactly twice'
assert_absent "$fixture/app/releases/.$sha.tmp"
assert_absent "$fixture/app/releases/$sha"
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
if run_deploy "$fixture" env PUBLIC_FAIL=1; then
  fail 'first-deployment public health failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$fixture/app/releases/$sha"
[[ -d "$fixture/app/releases/$sha" ]] || fail 'first-deployment failure deleted the current release'
assert_absent "$fixture/app/previous"
rm -rf "$fixture"

fixture="$(make_fixture)"
for release in old keep1 keep2 keep3 remove1 remove2 unverified; do
  mkdir -p "$fixture/app/releases/$release"
done
for release in old keep1 keep2 keep3 remove1 remove2; do
  write_success_marker "$fixture/app/releases/$release" "$release"
done
ln -s "$fixture/app/releases/old" "$fixture/app/current"
find_output="8 $fixture/app/releases/$sha"$'\n'
find_output+="7 $fixture/app/releases/keep1"$'\n'
find_output+="6 $fixture/app/releases/keep2"$'\n'
find_output+="5 $fixture/app/releases/keep3"$'\n'
find_output+="4 $fixture/app/releases/old"$'\n'
find_output+="2 $fixture/app/releases/remove1"$'\n'
find_output+="1 $fixture/app/releases/remove2"
run_deploy "$fixture" env FIND_OUTPUT="$find_output"
assert_link "$fixture/app/current" "$fixture/app/releases/$sha"
assert_link "$fixture/app/previous" "$fixture/app/releases/old"
[[ -d "$fixture/app/releases/old" ]] || fail 'cleanup deleted previous release'
[[ -d "$fixture/app/releases/$sha" ]] || fail 'cleanup deleted current release'
[[ ! -d "$fixture/app/releases/remove1" && ! -d "$fixture/app/releases/remove2" ]] || fail 'cleanup did not remove old successful releases'
[[ -d "$fixture/app/releases/unverified" ]] || fail 'cleanup deleted an unverified release'
grep -Fq -- "-name .deployment-success.json" "$fixture/find-arguments.log" || fail 'cleanup did not select successful-release markers'
rm -rf "$fixture"

echo 'deploy-production behavior tests passed'
