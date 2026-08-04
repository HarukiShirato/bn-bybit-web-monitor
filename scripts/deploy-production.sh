#!/usr/bin/env bash
set -Eeuo pipefail

PREPARE_ONLY=0
if [[ "${1:-}" == --prepare-only ]]; then PREPARE_ONLY=1; shift; fi
readonly SHA="${1:-}"
[[ "${2:-}" != --prepare-only ]] || PREPARE_ONLY=1
readonly EXPECTED_USER="${EXPECTED_USER:-perp-dashboard}"
readonly APP_ROOT="${APP_ROOT:-/home/perp-dashboard/apps/perp-dashboard}"
readonly RELEASES="$APP_ROOT/releases" CURRENT="$APP_ROOT/current" PREVIOUS="$APP_ROOT/previous" SHARED="$APP_ROOT/shared"
readonly LOCK_FILE="$APP_ROOT/deploy.lock" REPOSITORY_URL="https://github.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts.git"
readonly LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/}" PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://data.dvcapital.xyz/}"
readonly BUILD_ENV_ALLOWLIST="${BUILD_ENV_ALLOWLIST:-}"
readonly PM2_TARGETS=(perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector)

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid git SHA' >&2; exit 64; }
[[ "$(id -un)" == "$EXPECTED_USER" ]] || { echo "must run as $EXPECTED_USER" >&2; exit 77; }
mkdir -p "$RELEASES" "$SHARED/deploy-logs" "$SHARED/data"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo 'deployment already running' >&2; exit 75; }
umask 077
command_id="${SHA}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly DEPLOY_LOG="$SHARED/deploy-logs/$command_id.log"
set -o noclobber
: >"$DEPLOY_LOG"
set +o noclobber
exec 3>&1 4>&2
exec >>"$DEPLOY_LOG" 2>&1
printf 'DEPLOY_SHA=%s\nDEPLOY_COMMAND_ID=%s\n' "$SHA" "$command_id" >&3

resolve_path() {
  local path="$1" target
  if target="$(realpath "$path" 2>/dev/null)"; then printf '%s\n' "$target"; return; fi
  [[ -L "$path" ]] || return 0
  target="$(readlink "$path")"; [[ "$target" == /* ]] || target="$(dirname "$path")/$target"
  (cd -P "$(dirname "$target")" 2>/dev/null && printf '%s/%s\n' "$PWD" "$(basename "$target")") || true
}
switch_link() { local tmp="$2.next.$$"; [[ ! -e "$2" || -L "$2" ]] || return 1; ln -s "$1" "$tmp" && mv -Tf "$tmp" "$2"; }
fail() { printf 'DEPLOY_FAILURE=%s DEPLOY_LOG=%s\n' "$1" "$DEPLOY_LOG" >&3; echo "$*" >&2; exit 1; }

verify_pm2() {
  local state="$APP_ROOT/.pm2-jlist.$$"
  pm2 jlist >"$state"
  node - "$state" "$CURRENT" "${PM2_TARGETS[@]}" <<'NODE'
const fs=require('fs'); const [file,cwd,...names]=process.argv.slice(2); const apps=JSON.parse(fs.readFileSync(file));
for (const name of names) { const m=apps.filter(a=>(a.pm2_env??a).name===name); const e=m[0]?.pm2_env??m[0]; if(m.length!==1||e.status!=='online'||e.pm_cwd!==cwd) process.exit(1); }
NODE
  rm -f "$state"
}

release="$RELEASES/$SHA"; tmp="$RELEASES/.$SHA.tmp.$$"; old="$(resolve_path "$CURRENT")"
switched=0; completed=0; published_here=0
cleanup() {
  local status=$?; trap - EXIT; set +e; rm -rf -- "$tmp"
  if (( status != 0 && switched )) && [[ -n "$old" && -d "$old" ]]; then
    pm2 stop funding-collector arbitrage-collector staking-collector positions-collector || true
    switch_link "$old" "$CURRENT" || true
    (cd "$CURRENT" && pm2 startOrReload ecosystem.config.cjs --update-env) || true
    verify_pm2 || echo 'rollback PM2 verification failed' >&2
  fi
  if (( status != 0 && published_here )) && [[ "$(resolve_path "$CURRENT")" != "$(resolve_path "$release")" ]]; then rm -rf -- "$release"; fi
  exit "$status"
}
trap cleanup EXIT

if [[ -d "$release" && -f "$release/.deployment-success.json" ]]; then
  if (( PREPARE_ONLY )); then echo 'release already prepared'; completed=1; exit 0; fi
  [[ "$(resolve_path "$CURRENT")" == "$(resolve_path "$release")" ]] || fail 'successful release exists but is not current'
  verify_pm2 || fail 'same-SHA PM2 verification failed'
  curl --fail --silent --show-error --max-time 2 "$LOCAL_HEALTH_URL" >/dev/null || fail 'same-SHA local health failed'
  echo 'deployment already complete and verified'; completed=1; exit 0
fi
[[ ! -e "$release" ]] || fail "unverified release already exists: $release"

git clone --no-checkout "$REPOSITORY_URL" "$tmp" || fail 'repository clone failed'
git -C "$tmp" fetch --depth 1 origin "$SHA" || fail 'commit fetch failed'
git -C "$tmp" checkout --detach "$SHA" || fail 'commit checkout failed'
[[ "$(git -C "$tmp" rev-parse HEAD)" == "$SHA" ]] || fail 'checked out commit does not match requested SHA'
rm -rf -- "$tmp/.env" "$tmp/data"

build_env=(env -i HOME="$HOME" PATH="$PATH" NODE_ENV=production)
for name in $BUILD_ENV_ALLOWLIST; do
  [[ "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]] || fail "invalid build env allowlist name: $name"
  if declare -p "$name" >/dev/null 2>&1; then build_env+=("$name=${!name}"); fi
done
(cd "$tmp" && "${build_env[@]}" npm ci && "${build_env[@]}" npm run build) || fail 'dependency install or build failed'
ln -s "$SHARED/data" "$tmp/data" || fail 'shared data link failed'
mv "$tmp" "$release" || fail 'release publish failed'; published_here=1
printf '{"sha":"%s","prepared_at":"%s"}\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$release/.deployment-prepared.json"
if (( PREPARE_ONLY )); then echo 'release prepared'; completed=1; exit 0; fi

ln -s "$SHARED/.env" "$release/.env" || fail 'runtime env link failed'
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector || fail 'collector stop failed'
[[ -z "$old" ]] || switch_link "$old" "$PREVIOUS" || fail 'previous switch failed'
switch_link "$release" "$CURRENT" || fail 'current switch failed'; switched=1
(cd "$CURRENT" && pm2 startOrReload ecosystem.config.cjs --update-env) || fail 'PM2 switch failed'
verify_pm2 || fail 'PM2 targets are not online from current'
printf 'DEPLOY_PM2=online\n' >&3
curl --fail --silent --show-error --max-time 10 "$LOCAL_HEALTH_URL" >/dev/null || fail 'local health failed'
printf 'DEPLOY_LOCAL_HEALTH=ok\n' >&3
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null || fail 'public health failed'
printf 'DEPLOY_PUBLIC_HEALTH=ok\n' >&3
printf '{"sha":"%s","deployed_at":"%s"}\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$release/.deployment-success.json"
completed=1; switched=0
echo 'deployment completed'
