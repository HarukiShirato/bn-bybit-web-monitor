#!/usr/bin/env bash
set -Eeuo pipefail
file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/docs/production-deployment.md"
for value in PerpDashboardDeploy /usr/local/sbin/perp-dashboard-deploy /usr/local/libexec/perp-dashboard/deploy-production --prepare-only 169.254.169.254 BUILD_ENV_ALLOWLIST 'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector' 'pm2 startOrReload ecosystem.config.cjs --update-env' '同 SHA 重跑' '五个进程'; do grep -Fq -- "$value" "$file" || { echo "runbook missing $value" >&2; exit 1; }; done
! grep -Fq '/home/ec2-user/apps/perp-dashboard' "$file"
echo 'production deployment runbook tests passed'
