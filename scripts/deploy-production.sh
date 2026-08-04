#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:-}"
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

mkdir -p "$RELEASES" "$SHARED"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "deployment already running" >&2; exit 75; }

resolve_link() {
  local link="$1"
  local target

  target="$(readlink -f "$link" 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    target="$(readlink "$link" 2>/dev/null || true)"
  fi
  printf '%s\n' "$target"
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
old="$(resolve_link "$CURRENT")"
switched=0
release_published=0
completed=0

cleanup_failed_deployment() {
  local code=$?
  local rollback_ok=1

  trap - EXIT
  set +e
  rm -rf -- "$tmp"
  if (( ! completed && switched )) && [[ -n "$old" && -d "$old" ]]; then
    echo "deployment failed; restoring previous release" >&2
    if ! switch_link "$old" "$CURRENT"; then
      rollback_ok=0
    elif ! (cd "$CURRENT" && pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env); then
      rollback_ok=0
    elif ! curl --fail --silent --show-error --max-time 2 "$LOCAL_HEALTH_URL" >/dev/null; then
      rollback_ok=0
    fi
    (( rollback_ok )) || echo "rollback recovery failed" >&2
  fi
  if (( ! completed && release_published )); then
    rm -rf -- "$release"
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
[[ -z "$old" ]] || switch_link "$old" "$PREVIOUS" || fail_deployment 'previous release link switch failed'
switch_link "$release" "$CURRENT" || fail_deployment 'current release link switch failed'
switched=1

cd "$CURRENT"
pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env || fail_deployment 'PM2 reload failed'
wait_for_local_health || fail_deployment 'local health check failed'
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null || fail_deployment 'public health check failed'

printf '{"sha":"%s","deployed_at":"%s"}\n' \
  "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$release/.deployment-success.json"
completed=1
switched=0

current_target="$(resolve_link "$CURRENT")"
previous_target="$(resolve_link "$PREVIOUS")"
while IFS= read -r candidate; do
  [[ "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]] && continue
  rm -rf -- "$candidate"
done < <(find "$RELEASES" -mindepth 2 -maxdepth 2 -type f -name '.deployment-success.json' -printf '%T@ %h\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)

echo "deployed $SHA"
