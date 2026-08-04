#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:-}"
readonly EXPECTED_USER="${EXPECTED_USER:-ec2-user}"
readonly PRODUCTION_ROOT="${PRODUCTION_ROOT:-/home/ec2-user/perp-dashboard}"
readonly WORK_ROOT="${WORK_ROOT:-/home/ec2-user/.deploy-work/perp-dashboard}"
readonly BACKUP_ROOT="${BACKUP_ROOT:-/home/ec2-user/.deploy-backups/perp-dashboard}"
readonly DEPLOY_LOG_ROOT="${DEPLOY_LOG_ROOT:-/home/ec2-user/.deploy-logs/perp-dashboard}"
readonly LOCK_ROOT="${LOCK_ROOT:-/home/ec2-user/.deploy-locks}"
readonly REPOSITORY_URL="https://github.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts.git"
readonly LOCAL_HEALTH_URL="${LOCAL_HEALTH_URL:-http://127.0.0.1:3000/}"
readonly PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL:-https://data.dvcapital.xyz/}"
readonly PM2_TARGETS=(perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector)

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid git SHA' >&2; exit 64; }
[[ "$(id -un)" == "$EXPECTED_USER" ]] || { echo "must run as $EXPECTED_USER" >&2; exit 77; }
[[ -d "$PRODUCTION_ROOT" && -d "$PRODUCTION_ROOT/.git" ]] || { echo 'production checkout is missing' >&2; exit 1; }
[[ -f "$PRODUCTION_ROOT/.env" && -d "$PRODUCTION_ROOT/data" ]] || { echo 'production runtime state is missing' >&2; exit 1; }

umask 077
mkdir -p "$WORK_ROOT" "$BACKUP_ROOT" "$DEPLOY_LOG_ROOT" "$LOCK_ROOT"
exec 9>"$LOCK_ROOT/perp-dashboard.lock"
flock -n 9 || { echo 'deployment already running' >&2; exit 75; }

readonly DEPLOY_LOG="$DEPLOY_LOG_ROOT/${SHA}-$(date -u +%Y%m%dT%H%M%SZ)-$$.log"
: >"$DEPLOY_LOG"
chmod 0600 "$DEPLOY_LOG"
exec 3>&1
exec >>"$DEPLOY_LOG" 2>&1
printf 'DEPLOY_SHA=%s\n' "$SHA" >&3

readonly STAGING="$WORK_ROOT/$SHA"
readonly BACKUP="$BACKUP_ROOT/${SHA}-$$"
readonly RECOVERY_DIR="$WORK_ROOT/recovery-$$"
readonly RECOVERY_CONFIG="$RECOVERY_DIR/ecosystem.config.cjs"
switched=0
completed=0

wait_for_local_health() {
  local attempt
  for attempt in {1..20}; do
    curl --fail --silent --show-error --max-time 2 "$LOCAL_HEALTH_URL" >/dev/null && return 0
    sleep 2
  done
  return 1
}

verify_pm2() {
  local state="$WORK_ROOT/pm2-state-$$.json"
  pm2 jlist >"$state"
  node - "$state" "$PRODUCTION_ROOT" "${PM2_TARGETS[@]}" <<'NODE'
const fs = require('fs');
const [file, cwd, ...names] = process.argv.slice(2);
const apps = JSON.parse(fs.readFileSync(file));
for (const name of names) {
  const matches = apps.filter((app) => (app.pm2_env ?? app).name === name);
  const env = matches.length === 1 ? (matches[0].pm2_env ?? matches[0]) : null;
  if (!env || env.status !== 'online' || env.pm_cwd !== cwd) process.exit(1);
}
NODE
  local status=$?
  rm -f -- "$state"
  return "$status"
}

build_recovery_config() {
  local state="$WORK_ROOT/pm2-before-$$.json"
  pm2 jlist >"$state"
  mkdir -p "$RECOVERY_DIR"
  node - "$state" "$RECOVERY_CONFIG" "${PM2_TARGETS[@]}" <<'NODE'
const fs = require('fs');
const [stateFile, output, ...names] = process.argv.slice(2);
const apps = JSON.parse(fs.readFileSync(stateFile));
const selected = names.map((name) => {
  const matches = apps.filter((app) => (app.pm2_env ?? app).name === name);
  if (matches.length !== 1) throw new Error(`expected one PM2 process named ${name}`);
  const env = matches[0].pm2_env ?? matches[0];
  return {name, script: env.pm_exec_path, args: env.args, cwd: env.pm_cwd, interpreter: env.exec_interpreter, autorestart: env.autorestart, env: env.env};
});
fs.writeFileSync(output, `module.exports = ${JSON.stringify({apps: selected}, null, 2)};\n`, {mode: 0o600});
NODE
  rm -f -- "$state"
}

restore_previous_code() {
  rsync -ac --delete --exclude='.git/' --exclude='.env' --exclude='data/' "$BACKUP/" "$PRODUCTION_ROOT/"
  pm2 delete "${PM2_TARGETS[@]}" || true
  pm2 start "$RECOVERY_CONFIG" --update-env
  verify_pm2 && wait_for_local_health && curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null
}

cleanup() {
  local code=$?
  trap - EXIT
  set +e
  if (( ! completed && switched )); then
    echo 'deployment failed; restoring previous code' >&2
    restore_previous_code || echo 'automatic rollback verification failed' >&2
  fi
  rm -rf -- "$STAGING" "$RECOVERY_DIR"
  (( completed )) && rm -rf -- "$BACKUP"
  exit "$code"
}
trap cleanup EXIT

rm -rf -- "$STAGING" "$BACKUP" "$RECOVERY_DIR"
git clone --no-checkout "$REPOSITORY_URL" "$STAGING"
git -C "$STAGING" fetch --depth 1 origin "$SHA"
git -C "$STAGING" checkout --detach "$SHA"
[[ "$(git -C "$STAGING" rev-parse HEAD)" == "$SHA" ]] || { echo 'checked out commit does not match requested SHA' >&2; exit 1; }
(cd "$STAGING" && npm ci && npm run build)

mkdir -p "$BACKUP"
rsync -a --delete --exclude='.git/' --exclude='.env' --exclude='data/' "$PRODUCTION_ROOT/" "$BACKUP/"
build_recovery_config
pm2 stop "${PM2_TARGETS[@]}"
switched=1
rsync -ac --delete --exclude='.git/' --exclude='.env' --exclude='data/' "$STAGING/" "$PRODUCTION_ROOT/"
cd "$PRODUCTION_ROOT"
pm2 startOrRestart "$PRODUCTION_ROOT/ecosystem.config.cjs" --update-env
verify_pm2
printf 'DEPLOY_PM2=online\n' >&3
wait_for_local_health
printf 'DEPLOY_LOCAL_HEALTH=ok\n' >&3
curl --fail --silent --show-error --max-time 15 "$PUBLIC_HEALTH_URL" >/dev/null
printf 'DEPLOY_PUBLIC_HEALTH=ok\n' >&3

completed=1
switched=0
echo 'deployment completed'
