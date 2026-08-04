#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

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
    { Effect: 'Allow', Action: ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'], Resource: '*' },
  ],
};
write('ops/aws/github-oidc-trust-policy.json', JSON.stringify(trust));
write('ops/aws/github-deploy-permissions.json', JSON.stringify(permissions));
write('.github/workflows/deploy-production.yml', 'permissions:\n  id-token: write\nconcurrency:\n  cancel-in-progress: false\n');
write('scripts/deploy-production.sh', '#!/usr/bin/env bash\nflock\nnpm ci\nnpm run build\npm2 reload\ndata.dvcapital.xyz\n');
write('scripts/migrate-production-layout.sh', '#!/usr/bin/env bash\n');
write('ecosystem.config.cjs', 'module.exports = {};\n');
NODE

expect_pass() {
  (cd "$fixture" && NODE_PATH="$root/node_modules" bash tests/test-deployment-assets.sh) >/dev/null
}

expect_fail() {
  if (cd "$fixture" && NODE_PATH="$root/node_modules" bash tests/test-deployment-assets.sh) >/dev/null 2>&1; then
    echo "fixture validation unexpectedly passed" >&2
    exit 1
  fi
}

expect_pass

cp "$fixture/ops/aws/github-oidc-trust-policy.json" "$fixture/trust.valid"
node - "$fixture/ops/aws/github-oidc-trust-policy.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement.push({ Effect: 'Allow', Principal: '*', Action: 'sts:AssumeRoleWithWebIdentity' });
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail
mv "$fixture/trust.valid" "$fixture/ops/aws/github-oidc-trust-policy.json"

cp "$fixture/ops/aws/github-deploy-permissions.json" "$fixture/permissions.valid"
node - "$fixture/ops/aws/github-deploy-permissions.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const policy = JSON.parse(fs.readFileSync(file));
policy.Statement[0].Action = ['ssm:SendCommand', 'ssm:StartSession'];
fs.writeFileSync(file, JSON.stringify(policy));
NODE
expect_fail
mv "$fixture/permissions.valid" "$fixture/ops/aws/github-deploy-permissions.json"

node - "$fixture" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
fs.writeFileSync(path.join(root, '.github/workflows/deploy-production.yml'), '# id-token: write\npermissions: {}\nconcurrency:\n  cancel-in-progress: false\n');
fs.writeFileSync(path.join(root, 'scripts/migrate-production-layout.sh'), '#!/usr/bin/env bash\nAKIA1234567890ABCDEF\n');
NODE
expect_fail

node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], 'permissions:\n  id-token: write\nconcurrency:\n  cancel-in-progress: false\n');
NODE
expect_fail

echo 'deployment asset contract tests passed'
