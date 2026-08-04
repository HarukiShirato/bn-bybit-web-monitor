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
    { Effect: 'Allow', Action: 'ssm:CancelCommand', Resource: '*' },
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
  'ssm:CancelCommand requires "Resource": "*" because it has no IAM resource type',
  '```bash',
  'command_id="$( aws ssm send-command --region ap-northeast-1 --instance-ids i-0d3456ec595259c39 --document-name AWS-RunShellScript --parameters \'commands=["printf ssm-ready"]\' --query \'Command.CommandId\' --output text )"',
  'aws ssm wait command-executed --region ap-northeast-1 --command-id "$command_id" --instance-id i-0d3456ec595259c39',
  'invocation="$( aws ssm get-command-invocation --region ap-northeast-1 --command-id "$command_id" --instance-id i-0d3456ec595259c39 --query \'{Status:Status,StandardOutputContent:StandardOutputContent}\' --output json )"',
  '[[ "$(jq -r \'.Status\' <<<"$invocation")" == "Success" ]]',
  '[[ "$(jq -r \'.StandardOutputContent\' <<<"$invocation")" == "ssm-ready" ]]',
  '```',
].join('\n\n'));
write('.github/workflows/deploy-production.yml', [
  "name: Deploy production",
  'on:',
  '  push:',
  '    branches: [master]',
  'permissions:',
  '  contents: read',
  '  id-token: write',
  'concurrency:',
  '  group: perp-dashboard-production',
  '  cancel-in-progress: false',
  'jobs:',
  '  deploy:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: actions/setup-node@v4',
  '        with:',
  "          node-version: '18'",
  '          cache: npm',
  '      - run: npm ci',
  '      - run: npm run build',
  '      - run: npm run test:deployment',
  '      - uses: aws-actions/configure-aws-credentials@v4',
  '        with:',
  '          role-to-assume: arn:aws:iam::890742583014:role/GitHubActionsPerpDashboardDeployRole',
  '          aws-region: ap-northeast-1',
  '      - name: Deploy the checked-out commit through SSM',
  '        run: |',
  '          set -Eeuo pipefail',
  "          INSTANCE_ID='i-0d3456ec595259c39'",
  "          AWS_REGION='ap-northeast-1'",
  '          COMMAND_TIMEOUT_SECONDS=900',
  '          POLL_INTERVAL_SECONDS=10',
  '          POLL_MAX_ATTEMPTS=90',
  "          command_id=''",
  '          completed=0',
  '          terminal=0',
  "          invocation=''",
  "          status='Unknown'",
  '          for sensitive_var in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN ACTIONS_ID_TOKEN_REQUEST_TOKEN; do',
  '            sensitive_value="${!sensitive_var:-}"',
  "            [[ -z \"$sensitive_value\" ]] || printf '::add-mask::%s\\n' \"$sensitive_value\"",
  '          done',
  '          get_invocation() {',
  "            aws ssm get-command-invocation --region \"$AWS_REGION\" --command-id \"$command_id\" --instance-id \"$INSTANCE_ID\" --query '{Status:Status,StandardOutputContent:StandardOutputContent,StandardErrorContent:StandardErrorContent}' --output json",
  '          }',
  '          print_invocation_logs() {',
  "            jq -r '.StandardOutputContent // \"\"' <<<\"$invocation\"",
  "            jq -r '.StandardErrorContent // \"\"' <<<\"$invocation\" >&2",
  '          }',
  '          await_terminal_status() {',
  '            local attempt',
  '            for ((attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt += 1)); do',
  '              if invocation="$(get_invocation)"; then',
  "                status=\"$(jq -r '.Status // \"Unknown\"' <<<\"$invocation\")\"",
  '                case "$status" in Success|Cancelled|TimedOut|Failed) terminal=1; return 0 ;; esac',
  '              fi',
  '              (( attempt == POLL_MAX_ATTEMPTS )) || sleep "$POLL_INTERVAL_SECONDS"',
  '            done',
  '            return 1',
  '          }',
  '          cancel_and_wait() {',
  '            aws ssm cancel-command --region "$AWS_REGION" --command-id "$command_id" --instance-ids "$INSTANCE_ID" || true',
  '            if await_terminal_status; then print_invocation_logs; fi',
  '          }',
  '          cleanup() {',
  '            local exit_code=$?',
  '            trap - EXIT INT TERM',
  '            if [[ -n "$command_id" && "$completed" -eq 0 && "$terminal" -eq 0 ]]; then cancel_and_wait; fi',
  '            exit "$exit_code"',
  '          }',
  '          trap cleanup EXIT',
  "          trap 'exit 130' INT",
  "          trap 'exit 143' TERM",
  '          [[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]',
  '          script_url="https://raw.githubusercontent.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts/${GITHUB_SHA}/scripts/deploy-production.sh"',
  "          remote_command=\"$(jq -nr --arg sha \"$GITHUB_SHA\" --arg script_url \"$script_url\" '[\"install -d -m 0755 -o ec2-user -g ec2-user /home/ec2-user/apps/perp-dashboard/shared/bin\", \"sudo -u ec2-user -H\", \"target=/home/ec2-user/apps/perp-dashboard/shared/bin/deploy-production-$sha.sh\", \"curl --fail --silent --show-error --location\", \"exec \\\"$target\\\" \\\"$sha\\\"\"] | join(\"\\\\n\")')\"",
  "          parameters=\"$(jq -cn --arg command \"$remote_command\" '{commands: [$command]}')\"",
  "          command_id=\"$(aws ssm send-command --region \"$AWS_REGION\" --instance-ids \"$INSTANCE_ID\" --document-name AWS-RunShellScript --parameters \"$parameters\" --timeout-seconds \"$COMMAND_TIMEOUT_SECONDS\" --query 'Command.CommandId')\"",
  '          if ! await_terminal_status; then exit 1; fi',
  '          print_invocation_logs',
  "          [[ \"$status\" == 'Success' ]] || exit 1",
  '          completed=1',
].join('\n'));
write('scripts/deploy-production.sh', '#!/usr/bin/env bash\nEXPECTED_USER=ec2-user\nid -un\nflock\nnpm ci\nnpm run build\npm2 reload\ndata.dvcapital.xyz\ndeployment SHA\nPM2 reload confirmed\nlocal health confirmed\npublic health confirmed\n');
write('scripts/migrate-production-layout.sh', [
  '#!/usr/bin/env bash',
  'rsync -a legacy/data/ shared/data/',
  'git diff > legacy-code-diff-20260804.patch',
  'sha256sum legacy-code-diff-20260804.patch',
  'test -f /home/ec2-user/perp-dashboard/.env',
  'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector',
  'pm2 startOrRestart ecosystem.config.cjs',
  'pm2 jlist',
  'production-layout-migration-v1.json',
].join('\n'));
write('ecosystem.config.cjs', [
  'const CURRENT = "/home/ec2-user/apps/perp-dashboard/current";',
  'const SHARED_DATA = "/home/ec2-user/apps/perp-dashboard/shared/data";',
  'module.exports = { apps: [',
  '  { name: "perp-dashboard", script: "npm", args: "start", cwd: CURRENT },',
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
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('sudo -u ec2-user -H', 'sudo -u root -H'));
NODE
expect_fail "$fixture" 'SSM deployment that does not switch to ec2-user'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('jq -cn --arg command', 'printf'));
NODE
expect_fail "$fixture" 'SSM deployment with manually constructed parameters'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('|| exit 1', '|| true'));
NODE
expect_fail "$fixture" 'SSM deployment that does not fail after a non-success status'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('--parameters "$parameters"', '--parameters "{}"'));
NODE
expect_fail "$fixture" 'SSM deployment missing safe JSON parameters'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('aws ssm cancel-command', 'aws ssm list-commands'));
NODE
expect_fail "$fixture" 'SSM deployment without cancellation on timeout or interruption'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('print_invocation_logs', 'discard_invocation_logs'));
NODE
expect_fail "$fixture" 'SSM deployment without stdout and stderr logs'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace('permissions:', '  schedule:\n    - cron: "0 0 * * *"\npermissions:'));
NODE
expect_fail "$fixture" 'workflow with an additional trigger'
rm -rf "$fixture"

fixture="$(make_fixture)"
node - "$fixture/.github/workflows/deploy-production.yml" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, source.replace('  contents: read', '  contents: read\n  actions: read'));
NODE
expect_fail "$fixture" 'workflow with an additional permission'
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
