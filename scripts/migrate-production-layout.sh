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
readonly PM2_HOME_DIR="${PM2_HOME:-$HOME/.pm2}"
readonly PM2_DUMP="$PM2_HOME_DIR/dump.pm2"
readonly PM2_TARGETS=(perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector)

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
original_dump_backup=""
runtime_snapshot=""
restore_tmp=""
dump_existed=0
pm2_dump_saved=0
collectors_stopped=0
completed=0

data_manifest() {
  local root="$1"
  local file
  local relative
  local metadata

  [[ -d "$root" ]] || return 0
  while IFS= read -r file; do
    relative="${file#"$root"/}"
    if stat -c '%s %Y' "$file" >/dev/null 2>&1; then
      metadata="$(stat -c '%s %Y' "$file")"
    else
      metadata="$(stat -f '%z %m' "$file")"
    fi
    printf '%s\t%s\n' "$relative" "$metadata"
  done < <(find "$root" -type f -print | LC_ALL=C sort)
}

restore_dump_atomically() {
  local source="$1"
  restore_tmp="$PM2_HOME_DIR/.dump.pm2.migration-restore.$$.tmp"
  cp -- "$source" "$restore_tmp"
  mv -f -- "$restore_tmp" "$PM2_DUMP"
  restore_tmp=""
}

restore_original_dump() {
  if (( dump_existed )); then
    [[ -n "$original_dump_backup" && -f "$original_dump_backup" ]] || return 1
    restore_dump_atomically "$original_dump_backup"
  elif (( pm2_dump_saved )); then
    rm -f -- "$PM2_DUMP"
  fi
}

restore_previous_pm2() {
  pm2 delete "${PM2_TARGETS[@]}" || echo 'unable to delete migration PM2 targets before recovery' >&2
  [[ -n "$runtime_snapshot" && -f "$runtime_snapshot" ]] || return 1

  restore_dump_atomically "$runtime_snapshot"
  pm2 resurrect
  restore_original_dump
}

cleanup() {
  local status=$?

  trap - EXIT
  set +e
  if (( ! completed )); then
    if (( collectors_stopped )) && [[ -n "$runtime_snapshot" && -f "$runtime_snapshot" ]]; then
      echo 'migration failed after collector stop; restoring previous PM2 processes' >&2
      restore_previous_pm2 || echo 'unable to restore the previous PM2 process snapshot' >&2
    else
      restore_original_dump || echo 'unable to restore the previous PM2 dump' >&2
    fi
  fi
  rm -f -- "$patch_tmp" "$checksum_tmp" "$restore_tmp"
  [[ -z "$original_dump_backup" ]] || rm -f -- "$original_dump_backup"
  [[ -z "$runtime_snapshot" ]] || rm -f -- "$runtime_snapshot"
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
if [[ -e "$PM2_DUMP" ]]; then
  [[ -f "$PM2_DUMP" ]] || fail "PM2 dump is not a regular file: $PM2_DUMP"
  dump_existed=1
  original_dump_backup="$(mktemp "$APP_ROOT/.pm2-original-dump.XXXXXX")"
  chmod 0600 "$original_dump_backup"
  cp -- "$PM2_DUMP" "$original_dump_backup"
fi
pm2 save
[[ -f "$PM2_DUMP" ]] || fail "PM2 did not create its process dump: $PM2_DUMP"
pm2_dump_saved=1
runtime_snapshot="$(mktemp "$APP_ROOT/.pm2-runtime-snapshot.XXXXXX")"
chmod 0600 "$runtime_snapshot"
cp -- "$PM2_DUMP" "$runtime_snapshot"

# Keep the writer outage to the final synchronization and the PM2 cwd switch.
collectors_stopped=1
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector
legacy_manifest_before_final="$(data_manifest "$legacy_real/data")"
sync_legacy_data
chmod 0750 "$SHARED" "$SHARED_DATA"
shared_manifest_after_final="$(data_manifest "$SHARED_DATA")"
[[ "$legacy_manifest_before_final" == "$shared_manifest_after_final" ]] || fail 'runtime data manifest mismatch after final rsync'
pm2 startOrRestart "$CURRENT/ecosystem.config.cjs" --update-env
curl --fail --silent --show-error --max-time 10 "$LOCAL_HEALTH_URL" >/dev/null
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null
pm2 save
[[ -f "$PM2_DUMP" ]] || fail "PM2 did not persist the current process dump: $PM2_DUMP"

collectors_stopped=0
completed=1
echo 'production runtime layout migration completed'
