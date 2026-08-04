#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:-}"
readonly ENGINE=/usr/local/libexec/perp-dashboard/deploy-production
readonly APP_USER=perp-dashboard
readonly APP_HOME=/home/perp-dashboard

[[ "$#" == 1 && "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid git SHA' >&2; exit 64; }
[[ "$(id -u)" == 0 ]] || { echo 'wrapper must run as root' >&2; exit 77; }
[[ -f "$ENGINE" && ! -L "$ENGINE" && "$(stat -c '%U:%G:%a' "$ENGINE")" == root:root:755 ]] || {
  echo 'deploy engine ownership or mode is unsafe' >&2; exit 78;
}
exec runuser -u perp-dashboard -- env -i \
  HOME="$APP_HOME" PM2_HOME="$APP_HOME/.pm2" \
  PATH=/usr/local/bin:/usr/bin:/bin \
  "$ENGINE" "$SHA"
