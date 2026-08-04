#!/usr/bin/env bash
set -Eeuo pipefail

# One-time, manually audited bootstrap. Run from a trusted checkout as root.
readonly SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
readonly APP_USER=perp-dashboard
readonly APP_HOME=/home/perp-dashboard
readonly APP_ROOT="$APP_HOME/apps/perp-dashboard"
readonly ENGINE_DIR=/usr/local/libexec/perp-dashboard
readonly ENGINE="$ENGINE_DIR/deploy-production"
readonly WRAPPER=/usr/local/sbin/perp-dashboard-deploy

[[ "$(id -u)" == 0 ]] || { echo 'bootstrap must run as root' >&2; exit 77; }
id "$APP_USER" >/dev/null 2>&1 || useradd --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
install -d -o root -g root -m 0755 "$ENGINE_DIR"
install -o root -g root -m 0755 "$SOURCE_ROOT/scripts/deploy-production.sh" "$ENGINE"
install -o root -g root -m 0755 "$SOURCE_ROOT/scripts/migrate-production-layout.sh" "$ENGINE_DIR/migrate-production-layout"
install -o root -g root -m 0755 "$SOURCE_ROOT/ops/ec2/perp-dashboard-deploy-wrapper.sh" "$WRAPPER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_ROOT" "$APP_ROOT/releases" "$APP_ROOT/shared" "$APP_ROOT/shared/data" "$APP_HOME/.pm2"

# One-time PM2 ownership transition. Do this in the announced maintenance window:
# persist the legacy daemon, stop it so there cannot be two data writers, then
# resurrect the same snapshot under the dedicated user's PM2_HOME. Migration
# subsequently moves the five target processes to current and preserves others.
legacy_dump=/home/ec2-user/.pm2/dump.pm2
new_dump="$APP_HOME/.pm2/dump.pm2"
if [[ -f "$legacy_dump" && ! -e "$new_dump" ]]; then
  runuser -u ec2-user -- env PM2_HOME=/home/ec2-user/.pm2 pm2 save
  runuser -u ec2-user -- env PM2_HOME=/home/ec2-user/.pm2 pm2 kill
  install -o "$APP_USER" -g "$APP_USER" -m 0600 "$legacy_dump" "$new_dump"
  runuser -u "$APP_USER" -- env -i HOME="$APP_HOME" PM2_HOME="$APP_HOME/.pm2" PATH=/usr/local/bin:/usr/bin:/bin pm2 resurrect
fi

app_uid="$(id -u "$APP_USER")"
rule=(-d 169.254.169.254/32 -m owner --uid-owner "$app_uid" -j REJECT)
iptables -C OUTPUT "${rule[@]}" 2>/dev/null || iptables -I OUTPUT 1 "${rule[@]}"
iptables -C OUTPUT "${rule[@]}"
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save
elif [[ -d /etc/iptables ]]; then
  iptables-save > /etc/iptables/rules.v4
else
  echo 'install iptables-persistent and rerun bootstrap; IMDS rule is not persistent' >&2
  exit 1
fi

[[ "$(stat -c '%U:%G:%a' "$ENGINE")" == root:root:755 ]]
[[ "$(stat -c '%U:%G:%a' "$WRAPPER")" == root:root:755 ]]
[[ ! -e "$new_dump" || "$(stat -c '%U:%G' "$new_dump")" == "$APP_USER:$APP_USER" ]]
echo 'perp-dashboard deployment bootstrap complete'
