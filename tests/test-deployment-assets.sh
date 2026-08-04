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
const sameSet = (actual, expected) =>
  actual.length === expected.length && actual.every((value) => expected.includes(value));

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
  sameSet(asArray(statement && statement.Action), ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'])
);
const valid =
  statements.length === 2 &&
  sendCommand &&
  sendCommand.Effect === 'Allow' &&
  sameSet(asArray(sendCommand.Action), ['ssm:SendCommand']) &&
  sameSet(asArray(sendCommand.Resource), [...expectedResources]) &&
  statusRead &&
  statusRead.Effect === 'Allow' &&
  sameSet(asArray(statusRead.Action), ['ssm:GetCommandInvocation', 'ssm:ListCommandInvocations']) &&
  sameSet(asArray(statusRead.Resource), ['*']);
if (!valid) {
  console.error(`${file}: must contain only exact SendCommand and command-status read permissions`);
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
const names = /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)\s*[:=]\s*(.*?)\s*(?:#.*)?$/i;
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
    const match = line.match(names);
    if (!match) continue;
    const value = match[1].trim().replace(/^['"]|['"]$/g, '').trim();
    if (value && !value.startsWith('$')) process.exit(1);
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

if require_file .github/workflows/deploy-production.yml; then
  validate_workflow .github/workflows/deploy-production.yml || fail 'invalid deployment workflow'
fi

if require_file scripts/deploy-production.sh; then
  bash -n scripts/deploy-production.sh || fail 'deploy-production.sh has invalid Bash syntax'
  contains_all scripts/deploy-production.sh flock 'npm ci' 'npm run build' 'pm2 reload' 'data.dvcapital.xyz'
fi

if require_file scripts/migrate-production-layout.sh; then
  bash -n scripts/migrate-production-layout.sh || fail 'migrate-production-layout.sh has invalid Bash syntax'
fi

if require_file ecosystem.config.cjs; then
  node --check ecosystem.config.cjs || fail 'ecosystem.config.cjs has invalid JavaScript syntax'
fi

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
