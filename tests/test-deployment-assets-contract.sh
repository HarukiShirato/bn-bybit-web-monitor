#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

make_fixture() {
  local fixture
  fixture="$(mktemp -d)"
  mkdir -p "$fixture/tests" "$fixture/.github/workflows" "$fixture/scripts" "$fixture/ops/aws"
  cp "$root/tests/test-deployment-assets.sh" "$fixture/tests/test-deployment-assets.sh"

  node - "$fixture" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const write = (file, content) => fs.writeFileSync(path.join(root, file), content);
const trust = {
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow',
    Principal: { Federated: 'arn:aws:iam::890742583014:oidc-provider/token.actions.githubusercontent.com' },
    Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringEquals: {
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub': 'repo:HarukiShirato/real-time-monitoring-for-perpetual-contracts:ref:refs/heads/master',
    } },
  }],
};
const permissions = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: 'ssm:SendCommand', Resource: [
      'arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript',
      'arn:aws:ec2:ap-northeast-1:890742583014:instance/i-0d3456ec595259c39',
    ] },
    { Effect: 'Allow', Action: 'ssm:GetCommandInvocation', Resource: '*' },
  ],
};
write('ops/aws/github-oidc-trust-policy.json', JSON.stringify(trust));
write('ops/aws/github-deploy-permissions.json', JSON.stringify(permissions));
write('ops/aws/README.md', [
  'GitHubActionsPerpDashboardDeployRole',
  'aws iam create-open-id-connect-provider',
  'aws iam create-role',
  'aws iam put-role-policy',
  'aws ssm describe-instance-information',
  '```bash',
  'command_id="$( aws ssm send-command --region ap-northeast-1 --instance-ids i-0d3456ec595259c39 --document-name AWS-RunShellScript --parameters \'commands=["printf ssm-ready"]\' --query \'Command.CommandId\' --output text )"',
  'aws ssm wait command-executed --region ap-northeast-1 --command-id "$command_id" --instance-id i-0d3456ec595259c39',
  'invocation="$( aws ssm get-command-invocation --region ap-northeast-1 --command-id "$command_id" --instance-id i-0d3456ec595259c39 --query \'{Status:Status,StandardOutputContent:StandardOutputContent}\' --output json )"',
  '[[ "$(jq -r \'.Status\' <<<"$invocation")" == "Success" ]]',
  '[[ "$(jq -r \'.StandardOutputContent\' <<<"$invocation")" == "ssm-ready" ]]',
  '```',
].join('\n\n'));
write('.github/workflows/deploy-production.yml', 'permissions:\n  id-token: write\nconcurrency:\n  cancel-in-progress: false\n');
write('scripts/deploy-production.sh', '#!/usr/bin/env bash\nflock\nnpm ci\nnpm run build\npm2 reload\ndata.dvcapital.xyz\n');
write('scripts/migrate-production-layout.sh', [
  '#!/usr/bin/env bash',
  'rsync -a legacy/data/ shared/data/',
  'git diff > legacy-code-diff-20260804.patch',
  'sha256sum legacy-code-diff-20260804.patch',
  'test -f /home/ec2-user/perp-dashboard/.env',
  'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector',
  'pm2 startOrRestart ecosystem.config.cjs',
  'pm2 resurrect previous.pm2',
].join('\n'));
write('ecosystem.config.cjs', [
  'const CURRENT = "current";',
  'const SHARED_DATA = "shared/data";',
  'module.exports = { apps: [',
  '  { name: "perp-dashboard", cwd: CURRENT },',
  '  { name: "funding-collector", cwd: CURRENT, env: { PERP_DATA_DIR: SHARED_DATA } },',
  '  { name: "arbitrage-collector", cwd: CURRENT, env: { PERP_DATA_DIR: SHARED_DATA } },',
  '  { name: "staking-collector", cwd: CURRENT, env: { PERP_DATA_DIR: SHARED_DATA } },',
  '  { name: "positions-collector", cwd: CURRENT, env: { PERP_DATA_DIR: SHARED_DATA } },',
  '] };',
].join('\n'));
for (const collector of [
  'funding-collector.js',
  'arbitrage-collector.js',
  'staking-collector.js',
  'positions-collector.js',
]) {
  write(`scripts/${collector}`, 'const dataDir = process.env.PERP_DATA_DIR;\n');
}
NODE
  printf '%s\n' "$fixture"
}

expect_pass() {
  local fixture="$1"
  (cd "$fixture" && NODE_PATH="$root/node_modules" bash tests/test-deployment-assets.sh) >/dev/null
}

expect_fail() {
  local fixture="$1"
  local label="$2"
  if (cd "$fixture" && NODE_PATH="$root/node_modules" bash tests/test-deployment-assets.sh) >/dev/null 2>&1; then
    echo "fixture validation unexpectedly passed: $label" >&2
    exit 1
  fi
}

fixture="$(make_fixture)"
expect_pass "$fixture"
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/github-oidc-trust-policy.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement.push({ Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRoleWithWebIdentity' });
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail "$fixture" 'additional OIDC allow statement'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], '# id-token: write\npermissions: {}\nconcurrency:\n  cancel-in-progress: false\n');
NODE
expect_fail "$fixture" 'workflow with commented id-token permission'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/github-deploy-permissions.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement = [policy.Statement[0]];
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail "$fixture" 'missing command-status read permissions'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/github-deploy-permissions.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement[0].Resource[1] = policy.Statement[0].Resource[0];
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail "$fixture" 'duplicate SSM resource replacing the target instance'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/README.md" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace('--instance-id i-0d3456ec595259c39', ''));
NODE
expect_fail "$fixture" 'SSM readiness probe missing the wait instance id'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/README.md" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, [
  'aws ssm send-command --query \'Command.CommandId\'',
  'aws ssm wait command-executed --command-id "$command_id" --instance-id i-0d3456ec595259c39',
  'aws ssm get-command-invocation --command-id "$command_id" --instance-id i-0d3456ec595259c39',
  'Success',
  'ssm-ready',
].join('\\n'));
NODE
expect_fail "$fixture" 'scattered SSM readiness instructions'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ops/aws/github-deploy-permissions.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement.push({ Effect: 'Allow', Action: 'ssm:StartSession', Resource: '*' });
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail "$fixture" 'additional SSM permission'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/scripts/migrate-production-layout.sh" <<'NODE'
const fs = require('fs');
fs.appendFileSync(process.argv[2], 'AKIA1234567890ABCDEF\n');
NODE
expect_fail "$fixture" 'AKIA access key'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ecosystem.config.cjs" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], 'module.exports = { "AWS_SECRET_ACCESS_KEY": "plain-test-value" };\n');
NODE
expect_fail "$fixture" 'quoted JSON or JavaScript secret assignment'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/ecosystem.config.cjs" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], 'module.exports = { "AWS_ACCESS_KEY_ID": "$AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY": "plain-test-value" };\n');
NODE
expect_fail "$fixture" 'hard-coded secret after a safe reference on the same line'
rm -rf "$fixture"

echo 'deployment asset contract tests passed'
