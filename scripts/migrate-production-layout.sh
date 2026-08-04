#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_ROOT="${APP_ROOT:-/home/ec2-user/apps/perp-dashboard}"
readonly LEGACY_ROOT="${LEGACY_ROOT:-/home/ec2-user/perp-dashboard}"
readonly SHARED="$APP_ROOT/shared"
readonly SHARED_DATA="$SHARED/data"
readonly CURRENT="$APP_ROOT/current"
readonly LEGACY_ENV="$LEGACY_ROOT/.env"
readonly PATCH="$APP_ROOT/legacy-code-diff-20260804.patch"
readonly CHECKSUM="$PATCH.sha256"
readonly LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/}"
readonly PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://data.dvcapital.xyz/}"

fail() {
  echo "migration failed: $*" >&2
  exit 1
}

require_absolute_path() {
  [[ "$1" == /* && "$1" != *'/../'* && "$1" != */.. ]] || fail "unsafe path: $1"
}

require_absolute_path "$APP_ROOT"
require_absolute_path "$LEGACY_ROOT"
[[ -d "$LEGACY_ROOT" ]] || fail "legacy checkout is missing: $LEGACY_ROOT"
[[ -f "$LEGACY_ENV" && -r "$LEGACY_ENV" ]] || fail "legacy .env is required and must be readable: /home/ec2-user/perp-dashboard/.env"

mkdir -p "$APP_ROOT"
legacy_real="$(cd -P "$LEGACY_ROOT" && pwd -P)"
app_real="$(cd -P "$APP_ROOT" && pwd -P)"
[[ "$legacy_real" != "$app_real" && "$app_real" != "$legacy_real"/* && "$legacy_real" != "$app_real"/* ]] || \
  fail 'legacy and production roots must be separate directories'
[[ ! -L "$SHARED" && ! -L "$SHARED_DATA" ]] || fail 'shared runtime paths must not be symlinks during migration'

umask 027
install -d -m 0750 "$SHARED" "$SHARED_DATA"
chmod 0750 "$SHARED" "$SHARED_DATA"
install -m 0600 "$LEGACY_ENV" "$SHARED/.env"
chmod 0600 "$SHARED/.env"

patch_tmp="$PATCH.tmp.$$"
checksum_tmp="$CHECKSUM.tmp.$$"
backup=""
collectors_stopped=0
completed=0

cleanup() {
  local status=$?

  trap - EXIT
  set +e
  if (( ! completed && collectors_stopped )) && [[ -n "$backup" && -f "$backup" ]]; then
    echo 'migration failed after collector stop; restoring previous PM2 processes' >&2
    pm2 resurrect "$backup" || echo 'unable to restore the previous PM2 process snapshot' >&2
  fi
  rm -f -- "$patch_tmp" "$checksum_tmp"
  [[ -z "$backup" ]] || rm -f -- "$backup"
  exit "$status"
}
trap cleanup EXIT

archive_legacy_diff() {
  # git diff is read-only: it captures the legacy working-tree evidence without changing it.
  git -C "$legacy_real" diff --no-ext-diff >"$patch_tmp"
  chmod 0400 "$patch_tmp"
  mv -f -- "$patch_tmp" "$PATCH"
  sha256sum "$PATCH" >"$checksum_tmp"
  chmod 0440 "$checksum_tmp"
  mv -f -- "$checksum_tmp" "$CHECKSUM"
}

sync_legacy_data() {
  [[ -d "$legacy_real/data" ]] || return 0
  rsync -a "$legacy_real/data/" "$SHARED_DATA/"
}

archive_legacy_diff
sync_legacy_data

[[ -f "$CURRENT/ecosystem.config.cjs" ]] || fail "current ecosystem config is missing: $CURRENT/ecosystem.config.cjs"
backup="$(mktemp "$APP_ROOT/.pm2-before-production-layout.XXXXXX")"
chmod 0600 "$backup"
pm2 save "$backup"

# Keep the writer outage to the final synchronization and the PM2 cwd switch.
collectors_stopped=1
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector
sync_legacy_data
chmod 0750 "$SHARED" "$SHARED_DATA"
pm2 startOrRestart "$CURRENT/ecosystem.config.cjs" --update-env
curl --fail --silent --show-error --max-time 10 "$LOCAL_HEALTH_URL" >/dev/null
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null

collectors_stopped=0
completed=1
rm -f -- "$backup"
backup=""
echo 'production runtime layout migration completed'
