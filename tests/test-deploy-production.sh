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
    rev-parse) cat "$directory/.fake-head"; exit 0 ;;
  esac
fi
exit 1
EOF
  cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMAND_LOG"
[[ "${NPM_FAIL:-0}" != 1 ]]
EOF
  cat >"$fixture/bin/pm2" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMAND_LOG"
if [[ "${PM2_FAIL_ONCE:-0}" == 1 && ! -e "$PM2_FAILED_MARKER" ]]; then
  : >"$PM2_FAILED_MARKER"
  exit 1
fi
EOF
  cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$COMMAND_LOG"
[[ "${CURL_FAIL:-0}" != 1 ]]
EOF
  cat >"$fixture/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$fixture/bin/find" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${FIND_OUTPUT:-}" ]]; then
  printf '%s\n' "$FIND_OUTPUT"
else
  exit 0
fi
EOF
  cat >"$fixture/bin/mv" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
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
  PM2_FAILED_MARKER="$fixture/pm2-failed" \
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
[[ ! -e "$fixture/app/current" ]] || fail 'invalid SHA changed current release'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env NPM_FAIL=1; then
  fail 'build failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
[[ ! -e "$fixture/app/previous" ]] || fail 'build failure changed previous release'
rm -rf "$fixture"

fixture="$(make_fixture)"
old="$fixture/app/releases/old"
mkdir -p "$old"
ln -s "$old" "$fixture/app/current"
if run_deploy "$fixture" env PM2_FAIL_ONCE=1; then
  fail 'reload failure unexpectedly succeeded'
fi
assert_link "$fixture/app/current" "$old"
assert_link "$fixture/app/previous" "$old"
grep -Fq 'reload ecosystem.config.cjs --only perp-dashboard --update-env' "$fixture/commands.log" || fail 'rollback did not reload PM2'
rm -rf "$fixture"

fixture="$(make_fixture)"
for release in old keep1 keep2 keep3 remove1 remove2; do
  mkdir -p "$fixture/app/releases/$release"
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
[[ -d "$fixture/app/releases/old" ]] || fail 'cleanup deleted current release'
[[ -d "$fixture/app/releases/$sha" ]] || fail 'cleanup deleted current release'
assert_link "$fixture/app/current" "$fixture/app/releases/$sha"
assert_link "$fixture/app/previous" "$fixture/app/releases/old"
[[ ! -d "$fixture/app/releases/remove1" && ! -d "$fixture/app/releases/remove2" ]] || fail 'cleanup did not remove releases beyond five newest'
rm -rf "$fixture"

echo 'deploy-production behavior tests passed'
