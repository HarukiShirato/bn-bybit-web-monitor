#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"

fail() { echo "deployment hardening contract failed: $*" >&2; exit 1; }
contains() { grep -Fq -- "$2" "$1" || fail "$1 is missing: $2"; }
absent() { ! grep -Fq -- "$2" "$1" || fail "$1 must not contain: $2"; }

for file in \
  ops/aws/perp-dashboard-deploy-document.yml \
  ops/ec2/perp-dashboard-deploy-wrapper.sh \
  ops/ec2/bootstrap-perp-dashboard-deploy.sh; do
  [[ -f "$file" ]] || fail "missing $file"
done

contains ops/aws/perp-dashboard-deploy-document.yml 'allowedPattern: "^[0-9a-f]{40}$"'
contains ops/aws/perp-dashboard-deploy-document.yml '/usr/local/sbin/perp-dashboard-deploy "{{ CommitSha }}"'
contains ops/aws/github-deploy-permissions.json 'document/PerpDashboardDeploy'
absent ops/aws/github-deploy-permissions.json 'AWS-RunShellScript'

contains .github/workflows/deploy-production.yml '--document-name PerpDashboardDeploy'
contains .github/workflows/deploy-production.yml 'CommitSha'
absent .github/workflows/deploy-production.yml 'raw.githubusercontent.com'
absent .github/workflows/deploy-production.yml 'sudo -u ec2-user'

contains ops/ec2/perp-dashboard-deploy-wrapper.sh '^[0-9a-f]{40}$'
contains ops/ec2/perp-dashboard-deploy-wrapper.sh 'runuser -u perp-dashboard'
contains ops/ec2/perp-dashboard-deploy-wrapper.sh 'env -i'
contains ops/ec2/perp-dashboard-deploy-wrapper.sh '/usr/local/libexec/perp-dashboard/deploy-production'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh 'useradd'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh '169.254.169.254'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh 'iptables'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh '/usr/local/sbin/perp-dashboard-deploy'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh 'PM2_HOME=/home/ec2-user/.pm2 pm2 kill'
contains ops/ec2/bootstrap-perp-dashboard-deploy.sh 'PM2_HOME="$APP_HOME/.pm2"'

contains scripts/deploy-production.sh '--prepare-only'
contains scripts/deploy-production.sh 'PM2_TARGETS='
contains scripts/deploy-production.sh 'pm2 stop'
contains scripts/deploy-production.sh 'pm2 startOrReload'
contains scripts/deploy-production.sh 'BUILD_ENV_ALLOWLIST'

contains scripts/migrate-production-layout.sh 'pm2_snapshot_initialized=0'
contains scripts/migrate-production-layout.sh 'pm2_dump_modified=0'
contains ecosystem.config.cjs '/home/perp-dashboard/apps/perp-dashboard'

echo 'deployment hardening contract tests passed'
