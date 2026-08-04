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

rollback() {
  local code=$?

  if (( switched )) && [[ -n "$old" && -d "$old" ]]; then
    echo "deployment failed; restoring previous release" >&2
    switch_link "$old" "$CURRENT"
    cd "$CURRENT"
    pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env
    curl --fail --silent --show-error --max-time 10 "$LOCAL_HEALTH_URL" >/dev/null
  fi
  exit "$code"
}
trap rollback ERR

[[ ! -e "$release" ]] || { echo "release already exists: $release" >&2; exit 1; }
rm -rf -- "$tmp"
git clone --no-checkout "$REPOSITORY_URL" "$tmp"
git -C "$tmp" fetch --depth 1 origin "$SHA"
git -C "$tmp" checkout --detach "$SHA"
test "$(git -C "$tmp" rev-parse HEAD)" = "$SHA"
ln -s "$SHARED/.env" "$tmp/.env"
rm -rf -- "$tmp/data"
ln -s "$SHARED/data" "$tmp/data"
(cd "$tmp" && npm ci && npm run build)
mv "$tmp" "$release"

[[ -z "$old" || -d "$old" ]] || { echo "current release target is missing: $old" >&2; exit 1; }
[[ -z "$old" ]] || switch_link "$old" "$PREVIOUS"
switch_link "$release" "$CURRENT"
switched=1

cd "$CURRENT"
pm2 reload ecosystem.config.cjs --only "$PM2_APP" --update-env
local_healthy=0
for _ in {1..12}; do
  if curl --fail --silent --show-error --max-time 5 "$LOCAL_HEALTH_URL" >/dev/null; then
    local_healthy=1
    break
  fi
  sleep 5
done
(( local_healthy )) || { echo "local health check failed" >&2; false; }
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null

switched=0
trap - ERR

current_target="$(resolve_link "$CURRENT")"
previous_target="$(resolve_link "$PREVIOUS")"
while IFS= read -r candidate; do
  [[ "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]] && continue
  rm -rf -- "$candidate"
done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '.*.tmp' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)

echo "deployed $SHA"
