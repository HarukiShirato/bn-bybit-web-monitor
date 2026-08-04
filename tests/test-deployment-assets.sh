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
const allowed = (statement) => statement && statement.Effect === 'Allow';

if (kind === 'trust') {
  const valid = statements.some((statement) =>
    allowed(statement) &&
    asArray(statement.Action).includes('sts:AssumeRoleWithWebIdentity') &&
    statement.Principal &&
    statement.Principal.Federated ===
      `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com` &&
    statement.Condition &&
    statement.Condition.StringEquals &&
    statement.Condition.StringEquals['token.actions.githubusercontent.com:aud'] === 'sts.amazonaws.com' &&
    statement.Condition.StringEquals['token.actions.githubusercontent.com:sub'] ===
      `repo:${repository}:ref:refs/heads/master`
  );
  if (!valid) {
    console.error(`${file}: missing the exact GitHub OIDC trust statement`);
    process.exit(1);
  }
  process.exit(0);
}

const expectedResources = new Set([
  'arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript',
  `arn:aws:ec2:ap-northeast-1:${accountId}:instance/${instanceId}`,
]);
const sendCommand = statements.find((statement) =>
  allowed(statement) && asArray(statement.Action).includes('ssm:SendCommand')
);
if (!sendCommand) {
  console.error(`${file}: missing an Allow ssm:SendCommand statement`);
  process.exit(1);
}
const resources = asArray(sendCommand.Resource);
if (resources.length !== expectedResources.size || resources.some((resource) => !expectedResources.has(resource))) {
  console.error(`${file}: ssm:SendCommand must use exactly the deployment document and target instance resources`);
  process.exit(1);
}
if (resources.some((resource) => resource === '*' || resource.includes('*'))) {
  console.error(`${file}: ssm:SendCommand must not use wildcard resources`);
  process.exit(1);
}
NODE
}

validate_workflow() {
  local file="$1"

  node - "$file" <<'NODE'
const fs = require('fs');
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

function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "'" || character === '"') && line[index - 1] !== '\\') {
      quote = quote === character ? null : (quote || character);
    } else if (character === '#' && !quote && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function fallbackParse(document) {
  const lines = document.split(/\r?\n/).map(stripComment);
  const valueInBlock = (block, key, expected) => {
    const header = new RegExp(`^(\\s*)${block}:\\s*$`);
    const property = new RegExp(`^\\s+${key}:\\s*${expected}\\s*$`);
    let indentation = null;
    for (const line of lines) {
      const match = line.match(header);
      if (match) {
        indentation = match[1].length;
        continue;
      }
      if (indentation !== null && /^\S/.test(line)) {
        indentation = null;
      }
      if (indentation !== null && line.match(property)) return true;
    }
    return false;
  };
  if (!valueInBlock('permissions', 'id-token', 'write')) {
    throw new Error('permissions.id-token must be write');
  }
  if (!valueInBlock('concurrency', 'cancel-in-progress', 'false')) {
    throw new Error('concurrency.cancel-in-progress must be false');
  }
}

try {
  let parser;
  try {
    parser = require('yaml');
  } catch (_) {
    try {
      parser = require('js-yaml');
    } catch (_) {
      parser = null;
    }
  }
  if (parser) {
    assertValues(parser.parse ? parser.parse(source) : parser.load(source));
  } else {
    fallbackParse(source);
  }
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
    'AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|ghp_[[:alnum:]_]+|github_pat_[[:alnum:]_]+|-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----' \
    "${paths[@]}" >/dev/null 2>&1; then
    fail 'potential credential material found in deployment assets'
  else
    status=$?
    if (( status != 1 )); then
      fail "credential scan failed with grep exit status $status"
    fi
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

for file in "${missing[@]}"; do
  echo "missing: $file" >&2
done

if (( failed || ${#missing[@]} )); then
  exit 1
fi

echo 'deployment asset tests passed'
