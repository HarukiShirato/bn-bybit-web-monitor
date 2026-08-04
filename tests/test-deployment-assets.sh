#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

required=(
  .github/workflows/deploy-production.yml
  scripts/deploy-production.sh
  scripts/migrate-production-layout.sh
  ecosystem.config.cjs
  ops/aws/github-oidc-trust-policy.json
  ops/aws/github-deploy-permissions.json
)
for file in "${required[@]}"; do
  test -f "$file" || { echo "missing: $file" >&2; exit 1; }
done

grep -q 'refs/heads/master' ops/aws/github-oidc-trust-policy.json
grep -q 'HarukiShirato/real-time-monitoring-for-perpetual-contracts' ops/aws/github-oidc-trust-policy.json
grep -q 'i-0d3456ec595259c39' ops/aws/github-deploy-permissions.json
grep -q 'id-token: write' .github/workflows/deploy-production.yml
grep -q 'cancel-in-progress: false' .github/workflows/deploy-production.yml
grep -q 'flock' scripts/deploy-production.sh
grep -q 'npm ci' scripts/deploy-production.sh
grep -q 'npm run build' scripts/deploy-production.sh
grep -q 'pm2 reload' scripts/deploy-production.sh
grep -q 'data.dvcapital.xyz' scripts/deploy-production.sh
! grep -R 'aws_access_key_id\|BEGIN.*PRIVATE KEY' .github ops scripts ecosystem.config.cjs

echo 'deployment asset tests passed'
