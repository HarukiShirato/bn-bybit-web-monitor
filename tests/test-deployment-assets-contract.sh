#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow="$root/.github/workflows/deploy-production.yml"
deploy="$root/scripts/deploy-production.sh"

for file in "$workflow" "$deploy" "$root/scripts/run-ssm-deployment.sh" "$root/ecosystem.config.cjs" "$root/docs/production-deployment.md"; do [[ -f "$file" ]] || { echo "missing $file" >&2; exit 1; }; done
[[ ! -e "$root/scripts/migrate-production-layout.sh" ]] || { echo 'migration script must be removed' >&2; exit 1; }
grep -Fq '/home/ec2-user/perp-dashboard' "$deploy"
for exclusion in "--exclude='.git/'" "--exclude='.env'" "--exclude='data/'"; do grep -Fq -- "$exclusion" "$deploy" || { echo "missing $exclusion" >&2; exit 1; }; done
for marker in DEPLOY_SHA DEPLOY_PM2 DEPLOY_LOCAL_HEALTH DEPLOY_PUBLIC_HEALTH; do grep -Fq "$marker" "$deploy" || exit 1; done
grep -Fq '/home/ec2-user/.deploy-scripts/perp-dashboard' "$workflow"
! grep -Eq 'prepare-only|production-layout-migration|apps/perp-dashboard/(current|shared|releases)' "$workflow" "$deploy"
echo 'deployment asset contract tests passed'
