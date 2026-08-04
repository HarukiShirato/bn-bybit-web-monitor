#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

failed=0
missing=()

fail() {
  echo "deployment asset test failed: $*" >&2
  failed=1
}

require_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    missing+=("$file")
    return 1
  fi
  return 0
}

validate_json_policy() {
  local file="$1"
  local kind="$2"

  node - "$file" "$kind" <<'NODE'
const fs = require('fs');
const [file, kind] = process.argv.slice(2);
const repository = 'HarukiShirato/real-time-monitoring-for-perpetual-contracts';
const accountId = '890742583014';
const instanceId = 'i-0d3456ec595259c39';

let policy;
try {
  policy = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`${file}: invalid JSON: ${error.message}`);
  process.exit(1);
}

const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
const asArray = (value) => Array.isArray(value) ? value : [value];
const sameSet = (actual, expected) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return (
    actualSet.size === actual.length &&
    expectedSet.size === expected.length &&
    actualSet.size === expectedSet.size &&
    [...actualSet].every((value) => expectedSet.has(value))
  );
};

if (kind === 'trust') {
  const statement = statements[0];
  const condition = statement && statement.Condition;
  const stringEquals = condition && condition.StringEquals;
  const valid =
    statements.length === 1 &&
    statement &&
    statement.Effect === 'Allow' &&
    sameSet(asArray(statement.Action), ['sts:AssumeRoleWithWebIdentity']) &&
    statement.Principal &&
    Object.keys(statement.Principal).length === 1 &&
    statement.Principal.Federated ===
      `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com` &&
    condition &&
    Object.keys(condition).length === 1 &&
    stringEquals &&
    Object.keys(stringEquals).length === 2 &&
    stringEquals['token.actions.githubusercontent.com:aud'] === 'sts.amazonaws.com' &&
    stringEquals['token.actions.githubusercontent.com:sub'] ===
      `repo:${repository}:ref:refs/heads/master`;
  if (!valid) {
    console.error(`${file}: must contain exactly one least-privilege GitHub OIDC trust statement`);
    process.exit(1);
  }
  process.exit(0);
}

const expectedResources = new Set([
  'arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript',
  `arn:aws:ec2:ap-northeast-1:${accountId}:instance/${instanceId}`,
]);
const sendCommand = statements.find((statement) => asArray(statement && statement.Action).includes('ssm:SendCommand'));
const statusRead = statements.find((statement) =>
  sameSet(asArray(statement && statement.Action), ['ssm:GetCommandInvocation'])
);
const valid =
  statements.length === 2 &&
  sendCommand &&
  sendCommand.Effect === 'Allow' &&
  sameSet(asArray(sendCommand.Action), ['ssm:SendCommand']) &&
  sameSet(asArray(sendCommand.Resource), [...expectedResources]) &&
  statusRead &&
  statusRead.Effect === 'Allow' &&
  sameSet(asArray(statusRead.Action), ['ssm:GetCommandInvocation']) &&
  sameSet(asArray(statusRead.Resource), ['*']);
if (!valid) {
  console.error(`${file}: must contain only exact SendCommand and GetCommandInvocation permissions`);
  process.exit(1);
}
NODE
}

validate_workflow() {
  local file="$1"

  node - "$file" <<'NODE'
const fs = require('fs');
const YAML = require('yaml');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');

function assertValues(document) {
  if (!document || !document.permissions || document.permissions['id-token'] !== 'write') {
    throw new Error('permissions.id-token must be write');
  }
  if (!document.concurrency || document.concurrency['cancel-in-progress'] !== false) {
    throw new Error('concurrency.cancel-in-progress must be false');
  }
}

try {
  assertValues(YAML.parse(source));
} catch (error) {
  console.error(`${file}: ${error.message}`);
  process.exit(1);
}
NODE
}

validate_aws_setup_documentation() {
  local file="$1"

  node - "$file" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const source = fs.readFileSync(file, 'utf8');
const required = [
  'GitHubActionsPerpDashboardDeployRole',
  'aws iam create-open-id-connect-provider',
  'aws iam create-role',
  'aws iam put-role-policy',
  'aws ssm describe-instance-information',
];
const missing = required.filter((value) => !source.includes(value));
if (missing.length) {
  console.error(`${file}: missing required AWS setup instructions: ${missing.join(', ')}`);
  process.exit(1);
}

const probeBlocks = [...source.matchAll(/```bash\n([\s\S]*?)```/g)]
  .map((match) => match[1])
  .filter((block) => block.includes('aws ssm send-command'));
if (probeBlocks.length !== 1) {
  console.error(`${file}: must contain exactly one executable SSM readiness probe block`);
  process.exit(1);
}
const probe = probeBlocks[0];
const sendCommand = probe.match(/command_id="\$\(\s*([\s\S]*?)\s*\)"/)?.[1];
const waitCommand = probe.match(/aws ssm wait command-executed[\s\S]*?(?=\n\s*\n|$)/)?.[0];
const getCommand = probe.match(/invocation="\$\(\s*([\s\S]*?)\s*\)"/)?.[1];
const includesAll = (command, values) => command && values.every((value) => command.includes(value));
const validProbe =
  includesAll(sendCommand, [
    'aws ssm send-command',
    '--region ap-northeast-1',
    '--instance-ids i-0d3456ec595259c39',
    '--document-name AWS-RunShellScript',
    "--parameters 'commands=[\"printf ssm-ready\"]'",
    "--query 'Command.CommandId'",
    '--output text',
  ]) &&
  includesAll(waitCommand, [
    'aws ssm wait command-executed',
    '--region ap-northeast-1',
    '--command-id "$command_id"',
    '--instance-id i-0d3456ec595259c39',
  ]) &&
  includesAll(getCommand, [
    'aws ssm get-command-invocation',
    '--region ap-northeast-1',
    '--command-id "$command_id"',
    '--instance-id i-0d3456ec595259c39',
    "--query '{Status:Status,StandardOutputContent:StandardOutputContent}'",
    '--output json',
  ]) &&
  /jq -r '\.Status' <<<"\$invocation"[^\n]*== "Success"/.test(probe) &&
  /jq -r '\.StandardOutputContent' <<<"\$invocation"[^\n]*== "ssm-ready"/.test(probe);
if (!validProbe) {
  console.error(`${file}: SSM readiness probe must capture one CommandId, wait and retrieve that invocation, then verify Success and stdout`);
  process.exit(1);
}
NODE
}

contains_all() {
  local file="$1"
  shift
  local needle
  for needle in "$@"; do
    if ! grep -Fq -- "$needle" "$file"; then
      fail "$file: missing required deployment safeguard: $needle"
    fi
  done
}

scan_for_secrets() {
  local paths=()
  local path status
  for path in .github ops scripts ecosystem.config.cjs; do
    [[ -e "$path" ]] && paths+=("$path")
  done
  ((${#paths[@]})) || return

  if grep -R -I -i -E \
    'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|ghp_[[:alnum:]_]{36}|github_pat_[[:alnum:]_]{20,}|-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----' \
    "${paths[@]}" >/dev/null 2>&1; then
    fail 'potential credential material found in deployment assets'
  else
    status=$?
    if (( status != 1 )); then
      fail "credential scan failed with grep exit status $status"
    fi
  fi

  if ! node - "${paths[@]}" <<'NODE'
const fs = require('fs');
const paths = process.argv.slice(2);
const assignments = /(?:['"])?\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)(?:['"])?\s*[:=]\s*(?:(['"])(.*?)\1|([^\s,;]+))/gi;
const files = [];
for (const path of paths) {
  const stat = fs.statSync(path);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) files.push(`${entry.parentPath || entry.path}/${entry.name}`);
    }
  } else {
    files.push(path);
  }
}
for (const file of files) {
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (_) {
    continue;
  }
  for (const line of lines) {
    for (const match of line.matchAll(assignments)) {
      const value = (match[2] ?? match[3] ?? '').trim();
      if (value && !value.startsWith('$')) process.exit(1);
    }
  }
}
NODE
  then
    fail 'direct AWS credential variable assignment found in deployment assets'
  fi
}

if require_file ops/aws/github-oidc-trust-policy.json; then
  validate_json_policy ops/aws/github-oidc-trust-policy.json trust || fail 'invalid GitHub OIDC trust policy'
fi

if require_file ops/aws/github-deploy-permissions.json; then
  validate_json_policy ops/aws/github-deploy-permissions.json permissions || fail 'invalid SSM deployment permissions policy'
fi

if require_file ops/aws/README.md; then
  validate_aws_setup_documentation ops/aws/README.md || fail 'invalid AWS setup documentation'
fi

if require_file .github/workflows/deploy-production.yml; then
  validate_workflow .github/workflows/deploy-production.yml || fail 'invalid deployment workflow'
fi

if require_file scripts/deploy-production.sh; then
  bash -n scripts/deploy-production.sh || fail 'deploy-production.sh has invalid Bash syntax'
  contains_all scripts/deploy-production.sh flock 'npm ci' 'npm run build' 'pm2 reload' 'data.dvcapital.xyz' 'id -un' 'EXPECTED_USER'
fi

if require_file scripts/migrate-production-layout.sh; then
  bash -n scripts/migrate-production-layout.sh || fail 'migrate-production-layout.sh has invalid Bash syntax'
  contains_all scripts/migrate-production-layout.sh \
    'rsync -a' 'git diff' 'sha256sum' '/home/ec2-user/perp-dashboard/.env' \
    'pm2 stop funding-collector arbitrage-collector staking-collector positions-collector' \
    'pm2 startOrRestart' 'pm2 jlist' 'production-layout-migration-v1.json'
  if grep -Eq '^[[:space:]]*pm2 (save|resurrect)' scripts/migrate-production-layout.sh; then
    fail 'migration must not save or resurrect the global PM2 process list'
  fi
  if grep -Fq 'rm -rf /home/ec2-user/perp-dashboard' scripts/migrate-production-layout.sh; then
    fail 'migrate-production-layout.sh must not delete the legacy checkout'
  fi
fi

if require_file ecosystem.config.cjs; then
  node --check ecosystem.config.cjs || fail 'ecosystem.config.cjs has invalid JavaScript syntax'
  contains_all ecosystem.config.cjs \
    'perp-dashboard' 'funding-collector' 'arbitrage-collector' 'staking-collector' 'positions-collector' \
    'cwd: CURRENT' 'PERP_DATA_DIR: SHARED_DATA'
  node - <<'NODE' || fail 'ecosystem.config.cjs must define exactly the production PM2 processes'
const config = require(process.cwd() + '/ecosystem.config.cjs');
const current = '/home/ec2-user/apps/perp-dashboard/current';
const sharedData = '/home/ec2-user/apps/perp-dashboard/shared/data';
const expected = new Set(['perp-dashboard', 'funding-collector', 'arbitrage-collector', 'staking-collector', 'positions-collector']);
const apps = config.apps;
if (!Array.isArray(apps) || apps.length !== expected.size || new Set(apps.map((app) => app.name)).size !== expected.size) process.exit(1);
for (const app of apps) {
  if (!expected.has(app.name) || app.cwd !== current) process.exit(1);
  if (app.name === 'perp-dashboard') {
    if (app.script !== 'npm' || app.args !== 'start') process.exit(1);
  } else if (app.env?.PERP_DATA_DIR !== sharedData) {
    process.exit(1);
  }
}
NODE
fi

for collector in scripts/funding-collector.js scripts/arbitrage-collector.js scripts/staking-collector.js scripts/positions-collector.js; do
  if require_file "$collector"; then
    contains_all "$collector" 'process.env.PERP_DATA_DIR'
  fi
done

scan_for_secrets

if ((${#missing[@]})); then
  for file in "${missing[@]}"; do
    echo "missing: $file" >&2
  done
fi

if (( failed || ${#missing[@]} )); then
  exit 1
fi

echo 'deployment asset tests passed'
