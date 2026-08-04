#!/usr/bin/env bash
set -Eeuo pipefail

readonly EXPECTED_USER="${EXPECTED_USER:-ec2-user}"
readonly APP_ROOT="${APP_ROOT:-/home/ec2-user/apps/perp-dashboard}"
readonly LEGACY_ROOT="${LEGACY_ROOT:-/home/ec2-user/perp-dashboard}"
readonly SHARED="$APP_ROOT/shared"
readonly SHARED_DATA="$SHARED/data"
readonly CURRENT="$APP_ROOT/current"
readonly LEGACY_ENV="$LEGACY_ROOT/.env"
readonly PM2_HOME_DIR="${PM2_HOME:-$HOME/.pm2}"
readonly PM2_DUMP="$PM2_HOME_DIR/dump.pm2"
readonly MARKER="$SHARED/production-layout-migration-v1.json"
readonly MARKER_VERSION=1
readonly PATCH="$APP_ROOT/legacy-code-diff-20260804.patch"
readonly PATCH_CHECKSUM="$PATCH.sha256"
readonly UNTRACKED_LIST="$APP_ROOT/legacy-code-untracked-20260804.txt"
readonly UNTRACKED_LIST_CHECKSUM="$UNTRACKED_LIST.sha256"
readonly UNTRACKED_ARCHIVE="$APP_ROOT/legacy-code-untracked-20260804.tar"
readonly UNTRACKED_CHECKSUM="$UNTRACKED_ARCHIVE.sha256"
readonly LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/}"
readonly PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://data.dvcapital.xyz/}"
readonly PM2_TARGETS=(perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector)

fail() { echo "migration failed: $*" >&2; exit 1; }

canonical_path() {
  local candidate="$1"
  local parent
  local -a suffix=()

  if realpath -m "$candidate" 2>/dev/null; then return 0; fi
  while [[ ! -e "$candidate" ]]; do
    suffix=("$(basename "$candidate")" "${suffix[@]:-}")
    candidate="$(dirname "$candidate")"
  done
  parent="$(realpath "$candidate")" || return 1
  if ((${#suffix[@]})); then
    for candidate in "${suffix[@]}"; do parent="$parent/$candidate"; done
  fi
  printf '%s\n' "$parent"
}

path_is_within() { [[ "$1" == "$2" || "$1" == "$2"/* ]]; }

owner_of() {
  if stat -c '%U' "$1" >/dev/null 2>&1; then stat -c '%U' "$1"; else stat -f '%Su' "$1"; fi
}

require_owner() { [[ "$(owner_of "$1")" == "$EXPECTED_USER" ]] || fail "unexpected owner for $1"; }

data_manifest() {
  local root="$1" file relative metadata
  [[ -d "$root" ]] || return 0
  while IFS= read -r file; do
    relative="${file#"$root"/}"
    if stat -c '%s %Y' "$file" >/dev/null 2>&1; then metadata="$(stat -c '%s %Y' "$file")"; else metadata="$(stat -f '%z %m' "$file")"; fi
    printf '%s\t%s\n' "$relative" "$metadata"
  done < <(find "$root" -type f -print | LC_ALL=C sort)
}

pm2_verify_current() {
  local jlist="$1"
  pm2 jlist >"$jlist"
  node - "$jlist" "$CURRENT" "${PM2_TARGETS[@]}" <<'NODE'
const fs = require('fs');
const [file, current, ...names] = process.argv.slice(2);
const apps = JSON.parse(fs.readFileSync(file));
const nameOf = (app) => app.name ?? app.pm2_env?.name;
const cwdOf = (app) => app.cwd ?? app.pm2_env?.pm_cwd;
for (const name of names) {
  const matches = apps.filter((app) => nameOf(app) === name);
  if (matches.length !== 1 || cwdOf(matches[0]) !== current) process.exit(1);
}
NODE
}

build_target_snapshot() {
  local jlist="$1" snapshot="$2"
  node - "$jlist" "$snapshot" "${PM2_TARGETS[@]}" <<'NODE'
const fs = require('fs');
const [jlistFile, snapshotFile, ...names] = process.argv.slice(2);
const apps = JSON.parse(fs.readFileSync(jlistFile));
const nameOf = (app) => app.name ?? app.pm2_env?.name;
const envOf = (app) => app.pm2_env ?? app;
const selected = names.map((name) => {
  const matches = apps.filter((app) => nameOf(app) === name);
  if (matches.length !== 1) throw new Error(`expected one PM2 process named ${name}`);
  const env = envOf(matches[0]);
  const script = env.pm_exec_path ?? env.script;
  const cwd = env.pm_cwd ?? env.cwd;
  if (!script || !cwd) throw new Error(`PM2 process ${name} is not executable`);
  return {
    name,
    script,
    args: env.args,
    cwd,
    interpreter: env.exec_interpreter ?? env.interpreter,
    autorestart: env.autorestart,
    env: env.env,
  };
});
fs.writeFileSync(snapshotFile, `module.exports = ${JSON.stringify({ apps: selected }, null, 2)};\n`, { mode: 0o600 });
NODE
}

merge_target_dump() {
  local current_jlist="$1" output="$2"
  node - "$PM2_DUMP" "$current_jlist" "$output" "${PM2_TARGETS[@]}" <<'NODE'
const fs = require('fs');
const [dumpFile, jlistFile, outputFile, ...names] = process.argv.slice(2);
const targets = new Set(names);
const current = JSON.parse(fs.readFileSync(jlistFile));
const nameOf = (entry) => entry.name ?? entry.pm2_env?.name;
const selected = current.filter((entry) => targets.has(nameOf(entry)));
if (selected.length !== targets.size || new Set(selected.map(nameOf)).size !== targets.size) process.exit(1);
let original = [];
if (fs.existsSync(dumpFile)) original = JSON.parse(fs.readFileSync(dumpFile));
const wrapped = !Array.isArray(original);
const apps = wrapped ? (original.apps ?? []) : original;
const merged = apps.filter((entry) => !targets.has(nameOf(entry)));
for (const name of names) merged.push(selected.find((entry) => nameOf(entry) === name));
const result = wrapped ? { ...original, apps: merged } : merged;
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
NODE
}

write_marker() {
  local manifest="$1"
  node - "$MARKER" "$MARKER_VERSION" "$CURRENT" "$manifest" <<'NODE'
const fs = require('fs');
const [file, version, current, manifest] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({ version: Number(version), current, shared: { manifest } }, null, 2) + '\n', { mode: 0o640 });
NODE
}

validate_marker() {
  local manifest="$1"
  node - "$MARKER" "$MARKER_VERSION" "$CURRENT" "$manifest" <<'NODE'
const fs = require('fs');
const [file, version, current, manifest] = process.argv.slice(2);
const marker = JSON.parse(fs.readFileSync(file));
if (marker.version !== Number(version) || marker.current !== current || marker.shared?.manifest !== manifest) process.exit(1);
NODE
}

should_archive_untracked() {
  case "$1" in
    .env|.env/*|.env.*|data|data/*|node_modules|node_modules/*|.next|.next/*|*.pem|*.key|*id_rsa*|*secret*|*credential*) return 1 ;;
  esac
  return 0
}

archive_legacy_audit() {
  local patch_tmp="$PATCH.tmp.$$" list_tmp="$UNTRACKED_LIST.tmp.$$" list_checksum_tmp="$UNTRACKED_LIST_CHECKSUM.tmp.$$" archive_tmp="$UNTRACKED_ARCHIVE.tmp.$$" checksum_tmp="$UNTRACKED_CHECKSUM.tmp.$$"
  # git diff HEAD --binary covers both staged and unstaged tracked source changes.
  git -C "$legacy_real" diff HEAD --binary -- . \
    ':(exclude).env' ':(exclude).env/**' ':(exclude).env.*' ':(exclude)data/**' \
    ':(exclude)node_modules/**' ':(exclude).next/**' ':(exclude)**/*.pem' ':(exclude)**/*.key' \
    ':(exclude)**/*secret*' ':(exclude)**/*credential*' ':(exclude)**/*id_rsa*' >"$patch_tmp"
  chmod 0400 "$patch_tmp"; mv -f -- "$patch_tmp" "$PATCH"; sha256sum "$PATCH" >"$PATCH_CHECKSUM"; chmod 0440 "$PATCH_CHECKSUM"
  while IFS= read -r file; do should_archive_untracked "$file" && printf '%s\n' "$file"; done \
    < <(git -C "$legacy_real" ls-files --others --exclude-standard) >"$list_tmp"
  chmod 0400 "$list_tmp"; mv -f -- "$list_tmp" "$UNTRACKED_LIST"
  sha256sum "$UNTRACKED_LIST" >"$list_checksum_tmp"; chmod 0440 "$list_checksum_tmp"; mv -f -- "$list_checksum_tmp" "$UNTRACKED_LIST_CHECKSUM"
  if [[ -s "$UNTRACKED_LIST" ]]; then tar -C "$legacy_real" -cf "$archive_tmp" -T "$UNTRACKED_LIST"; else tar -cf "$archive_tmp" --files-from /dev/null; fi
  chmod 0400 "$archive_tmp"; mv -f -- "$archive_tmp" "$UNTRACKED_ARCHIVE"
  sha256sum "$UNTRACKED_ARCHIVE" >"$checksum_tmp"; chmod 0440 "$checksum_tmp"; mv -f -- "$checksum_tmp" "$UNTRACKED_CHECKSUM"
}

original_dump_backup=""
runtime_snapshot=""
jlist_before="$APP_ROOT/.pm2-targets-before.$$.json"
jlist_after="$APP_ROOT/.pm2-targets-after.$$.json"
dump_tmp="$PM2_HOME_DIR/.dump.pm2.migration.$$.tmp"
dump_existed=0
collectors_stopped=0
completed=0

restore_original_dump() {
  if (( dump_existed )); then cp -- "$original_dump_backup" "$dump_tmp" && mv -f -- "$dump_tmp" "$PM2_DUMP"; else rm -f -- "$PM2_DUMP"; fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if (( ! completed )); then
    if (( collectors_stopped )) && [[ -f "$runtime_snapshot" ]]; then
      pm2 delete "${PM2_TARGETS[@]}" || true
      pm2 startOrRestart "$runtime_snapshot" --update-env || echo 'unable to restore migration PM2 targets' >&2
    fi
    restore_original_dump || echo 'unable to restore the original PM2 dump' >&2
  fi
  rm -f -- "$runtime_snapshot" "$jlist_before" "$jlist_after" "$dump_tmp"
  [[ -z "$original_dump_backup" ]] || rm -f -- "$original_dump_backup"
  exit "$status"
}
trap cleanup EXIT

[[ "$(id -un)" == "$EXPECTED_USER" ]] || fail "must run as $EXPECTED_USER"
[[ "$APP_ROOT" == /* && "$LEGACY_ROOT" == /* ]] || fail 'application paths must be absolute'
[[ -d "$LEGACY_ROOT" ]] || fail "legacy checkout is missing: $LEGACY_ROOT"
legacy_real="$(canonical_path "$LEGACY_ROOT")" || fail 'cannot resolve legacy root'
app_candidate="$(canonical_path "$APP_ROOT")" || fail 'cannot resolve application root'
shared_candidate="$(canonical_path "$APP_ROOT/shared")" || fail 'cannot resolve shared path'
[[ "$app_candidate" != / ]] || fail 'application root must not be /'
! path_is_within "$app_candidate" "$legacy_real" || fail 'application root must not be inside legacy root'
! path_is_within "$legacy_real" "$app_candidate" || fail 'legacy root must not be inside application root'
path_is_within "$shared_candidate" "$app_candidate" || fail 'shared path must remain inside application root'
require_owner "$legacy_real"

mkdir -p "$APP_ROOT"
app_real="$(canonical_path "$APP_ROOT")" || fail 'cannot resolve created application root'
[[ "$app_real" == "$app_candidate" ]] || fail 'application root changed while being created'
[[ ! -L "$SHARED" && ! -L "$SHARED_DATA" ]] || fail 'shared runtime paths must not be symlinks during migration'
umask 027
install -d -m 0750 "$SHARED" "$SHARED_DATA"
chmod 0750 "$SHARED" "$SHARED_DATA"
require_owner "$app_real"; require_owner "$SHARED"; require_owner "$SHARED_DATA"
[[ -f "$CURRENT/ecosystem.config.cjs" ]] || fail "current ecosystem config is missing: $CURRENT/ecosystem.config.cjs"

if [[ -f "$MARKER" ]]; then
  shared_manifest="$(data_manifest "$SHARED_DATA")"
  validate_marker "$shared_manifest" || fail 'migration marker does not match shared runtime data'
  pm2_verify_current "$jlist_after" || fail 'PM2 targets are not running from current'
  completed=1
  echo 'production runtime layout already verified'
  exit 0
fi

[[ -f "$LEGACY_ENV" && -r "$LEGACY_ENV" ]] || fail "legacy .env is required and must be readable: /home/ec2-user/perp-dashboard/.env"
install -m 0600 "$LEGACY_ENV" "$SHARED/.env"; chmod 0600 "$SHARED/.env"; require_owner "$SHARED/.env"
archive_legacy_audit
if [[ -e "$PM2_DUMP" ]]; then
  [[ -f "$PM2_DUMP" ]] || fail 'PM2 dump is not a regular file'
  dump_existed=1; original_dump_backup="$(mktemp "$APP_ROOT/.pm2-original-dump.XXXXXX")"; cp -- "$PM2_DUMP" "$original_dump_backup"
fi
pm2 jlist >"$jlist_before"
runtime_snapshot="$(mktemp "$APP_ROOT/.pm2-target-snapshot.XXXXXX")"
build_target_snapshot "$jlist_before" "$runtime_snapshot"

collectors_stopped=1
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector
legacy_manifest_before_final="$(data_manifest "$legacy_real/data")"
[[ -d "$legacy_real/data" ]] && rsync -a "$legacy_real/data/" "$SHARED_DATA/"
chmod 0750 "$SHARED" "$SHARED_DATA"
shared_manifest_after_final="$(data_manifest "$SHARED_DATA")"
[[ "$legacy_manifest_before_final" == "$shared_manifest_after_final" ]] || fail 'runtime data manifest mismatch after final rsync'
pm2 startOrRestart "$CURRENT/ecosystem.config.cjs" --update-env
curl --fail --silent --show-error --max-time 10 "$LOCAL_HEALTH_URL" >/dev/null
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null
pm2_verify_current "$jlist_after" || fail 'PM2 targets did not switch to current'
merge_target_dump "$jlist_after" "$dump_tmp"
mv -f -- "$dump_tmp" "$PM2_DUMP"
write_marker "$shared_manifest_after_final"
collectors_stopped=0
completed=1
echo 'production runtime layout migration completed'
