#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:-}"
readonly EXPECTED_USER="${EXPECTED_USER:-ec2-user}"
readonly APP_ROOT="${APP_ROOT:-/home/ec2-user/apps/perp-dashboard}"
readonly RELEASES="$APP_ROOT/releases"
readonly CURRENT="$APP_ROOT/current"
readonly PREVIOUS="$APP_ROOT/previous"
readonly SHARED="$APP_ROOT/shared"
readonly LOCK_FILE="$APP_ROOT/deploy.lock"
readonly REPOSITORY_URL="https://github.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts.git"
readonly LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/}"
readonly PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://data.dvcapital.xyz/}"
readonly PM2_APP="${PM2_APP:-perp-dashboard}"
readonly LOCAL_HEALTH_BUDGET_SECONDS=57

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid git SHA" >&2; exit 64; }
[[ "$(id -un)" == "$EXPECTED_USER" ]] || { echo "must run as $EXPECTED_USER" >&2; exit 77; }

printf 'deployment SHA: %s\n' "$SHA"

mkdir -p "$RELEASES" "$SHARED"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "deployment already running" >&2; exit 75; }

resolve_path() {
  local path="$1"
  local target
  local parent

  target="$(readlink -f "$path" 2>/dev/null || true)"
  if [[ -n "$target" ]]; then
    printf '%s\n' "$target"
    return 0
  fi
  if [[ -L "$path" ]]; then
    target="$(readlink "$path")"
    if [[ "$target" != /* ]]; then
      target="$(dirname "$path")/$target"
    fi
    resolve_path "$target"
    return 0
  fi
  if [[ -e "$path" ]]; then
    parent="$(cd -P "$(dirname "$path")" && pwd -P)"
    printf '%s/%s\n' "$parent" "$(basename "$path")"
    return 0
  fi
  return 1
}

successful_release_candidate() {
  local candidate="$1"
  local candidate_real

  candidate_real="$(resolve_path "$candidate" 2>/dev/null || true)"
  [[ -n "$candidate_real" && -d "$candidate_real" ]] || return 1
  [[ "$(dirname "$candidate_real")" == "$RELEASES_REAL" ]] || return 1
  [[ -f "$candidate_real/.deployment-success.json" ]] || return 1
  printf '%s\n' "$candidate_real"
}

switch_link() {
  local target="$1"
  local link="$2"
  local temporary="${link}.next.$$"

  if [[ -e "$link" && ! -L "$link" ]]; then
    echo "refusing to replace non-symlink: $link" >&2
    return 1
  fi
  rm -f -- "$temporary"
  ln -s "$target" "$temporary"
  mv -Tf "$temporary" "$link"
}

release="$RELEASES/$SHA"
tmp="$RELEASES/.${SHA}.tmp"
readonly RELEASES_REAL="$(resolve_path "$RELEASES")"
old="$(resolve_path "$CURRENT" 2>/dev/null || true)"
original_previous="$(resolve_path "$PREVIOUS" 2>/dev/null || true)"
switched=0
release_published=0
completed=0

restore_original_previous() {
  if [[ -n "$original_previous" && -d "$original_previous" ]]; then
    switch_link "$original_previous" "$PREVIOUS"
  elif [[ -L "$PREVIOUS" ]]; then
    rm -f -- "$PREVIOUS"
  elif [[ ! -e "$PREVIOUS" ]]; then
    return 0
  else
    echo "refusing to replace non-symlink previous release: $PREVIOUS" >&2
    return 1
  fi
}

cleanup_failed_deployment() {
  local code=$?
  local rollback_ok=1
  local current_after_rollback
  local current_before_removal
  local release_real
  local remove_failed_release=0

  trap - EXIT
  set +e
  rm -rf -- "$tmp"
  if (( ! completed && release_published )); then
    if (( switched )); then
      if [[ -n "$old" && -d "$old" ]]; then
        echo "deployment failed; restoring previous release" >&2
        if ! switch_link "$old" "$CURRENT"; then
          rollback_ok=0
        fi
        current_after_rollback="$(resolve_path "$CURRENT" 2>/dev/null || true)"
        if [[ "$current_after_rollback" == "$old" && -d "$current_after_rollback" ]]; then
          remove_failed_release=1
          if ! (cd "$CURRENT" && pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env); then
            rollback_ok=0
          elif ! curl --fail --silent --show-error --max-time 2 "$LOCAL_HEALTH_URL" >/dev/null; then
            rollback_ok=0
          fi
        else
          rollback_ok=0
        fi
        if (( ! remove_failed_release )); then
          echo "rollback could not restore current; retaining failed release for manual inspection" >&2
        fi
      else
        rollback_ok=0
        echo "deployment failed without a previous release; retaining failed release for manual inspection" >&2
      fi
    else
      remove_failed_release=1
    fi
    (( rollback_ok )) || echo "rollback recovery failed" >&2
    if (( remove_failed_release )); then
      current_before_removal="$(resolve_path "$CURRENT" 2>/dev/null || true)"
      release_real="$(resolve_path "$release" 2>/dev/null || true)"
      if [[ -n "$release_real" && "$current_before_removal" != "$release_real" ]]; then
        rm -rf -- "$release_real"
      else
        echo "current still points to failed release; retaining it for manual inspection" >&2
      fi
    fi
  fi
  exit "$code"
}
trap cleanup_failed_deployment EXIT

fail_deployment() {
  echo "$*" >&2
  exit 1
}

wait_for_local_health() {
  local deadline
  local attempt
  local remaining
  local curl_timeout
  local sleep_seconds

  deadline=$(( $(date +%s) + LOCAL_HEALTH_BUDGET_SECONDS ))
  for ((attempt = 1; attempt <= 12; attempt += 1)); do
    remaining=$(( deadline - $(date +%s) ))
    if (( remaining <= 0 )); then
      break
    fi
    curl_timeout=2
    if (( remaining < curl_timeout )); then
      curl_timeout="$remaining"
    fi
    if curl --fail --silent --show-error --max-time "$curl_timeout" "$LOCAL_HEALTH_URL" >/dev/null; then
      return 0
    fi
    if (( attempt == 12 )); then
      break
    fi
    remaining=$(( deadline - $(date +%s) ))
    if (( remaining <= 0 )); then
      break
    fi
    sleep_seconds=3
    if (( remaining < sleep_seconds )); then
      sleep_seconds="$remaining"
    fi
    sleep "$sleep_seconds"
  done
  fail_deployment "local health check failed"
}

[[ ! -e "$release" ]] || fail_deployment "release already exists: $release"
rm -rf -- "$tmp"
git clone --no-checkout "$REPOSITORY_URL" "$tmp" || fail_deployment 'repository clone failed'
git -C "$tmp" fetch --depth 1 origin "$SHA" || fail_deployment 'commit fetch failed'
git -C "$tmp" checkout --detach "$SHA" || fail_deployment 'commit checkout failed'
test "$(git -C "$tmp" rev-parse HEAD)" = "$SHA" || fail_deployment 'checked out commit does not match requested SHA'
ln -s "$SHARED/.env" "$tmp/.env" || fail_deployment 'shared .env link failed'
rm -rf -- "$tmp/data"
ln -s "$SHARED/data" "$tmp/data" || fail_deployment 'shared data link failed'
(cd "$tmp" && npm ci && npm run build) || fail_deployment 'dependency install or build failed'
mv "$tmp" "$release" || fail_deployment 'release publish failed'
release_published=1

[[ -z "$old" || -d "$old" ]] || fail_deployment "current release target is missing: $old"
previous_changed=0
if [[ -n "$old" ]]; then
  switch_link "$old" "$PREVIOUS" || fail_deployment 'previous release link switch failed'
  previous_changed=1
fi
if ! switch_link "$release" "$CURRENT"; then
  forward_current="$(resolve_path "$CURRENT" 2>/dev/null || true)"
  forward_release="$(resolve_path "$release" 2>/dev/null || true)"
  if [[ -n "$forward_release" && "$forward_current" == "$forward_release" ]]; then
    switched=1
  fi
  if (( previous_changed )) && ! restore_original_previous; then
    echo "failed to restore original previous release" >&2
  fi
  fail_deployment 'current release link switch failed'
fi
switched=1

cd "$CURRENT"
pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env || fail_deployment 'PM2 reload failed'
printf 'PM2 reload confirmed for %s at SHA %s\n' "$PM2_APP" "$SHA"
wait_for_local_health || fail_deployment 'local health check failed'
printf 'local health confirmed for SHA %s\n' "$SHA"
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null || fail_deployment 'public health check failed'
printf 'public health confirmed for SHA %s\n' "$SHA"

printf '{"sha":"%s","deployed_at":"%s"}\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$release/.deployment-success.json"
completed=1
switched=0

current_target="$(resolve_path "$CURRENT" 2>/dev/null || true)"
previous_target="$(resolve_path "$PREVIOUS" 2>/dev/null || true)"
while IFS= read -r candidate; do
  candidate="$(successful_release_candidate "$candidate" || true)"
  [[ -n "$candidate" ]] || continue
  [[ "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]] && continue
  rm -rf -- "$candidate"
done < <(find "$RELEASES" -mindepth 2 -maxdepth 2 -type f -name '.deployment-success.json' -printf '%T@ %h\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)

echo "deployed $SHA with PM2 and health checks confirmed"
