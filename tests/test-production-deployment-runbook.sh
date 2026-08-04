#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runbook="$root/docs/production-deployment.md"
for text in '/home/ec2-user/perp-dashboard' '.env' 'data/' 'DEPLOY_PM2=online' 'local health: ok' 'public health: ok'; do grep -Fq "$text" "$runbook" || { echo "runbook missing $text" >&2; exit 1; }; done
! grep -Eq '首次迁移|prepare-only|apps/perp-dashboard/current' "$runbook"
echo 'production deployment runbook tests passed'
