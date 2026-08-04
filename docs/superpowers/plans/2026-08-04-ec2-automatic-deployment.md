# EC2 Automatic Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically deploy every successful push to GitHub `master` onto EC2 `i-0d3456ec595259c39`, while preserving runtime data and rolling back failed releases.

**Architecture:** GitHub Actions builds the exact triggering commit, exchanges GitHub OIDC for a short-lived AWS role, and sends that SHA to the EC2 instance through SSM Run Command. EC2 builds an isolated release, atomically switches a `current` symlink, reloads PM2, verifies local and public health, and restores the previous symlink on failure.

**Tech Stack:** GitHub Actions, GitHub OIDC, AWS IAM, AWS Systems Manager Run Command, Bash, Git, Node.js 18, npm 10, Next.js 14, PM2 6, Cloudflare Tunnel.

---

## File map

- Create `.github/workflows/deploy-production.yml`: trigger, runner build, OIDC login, SSM invocation, and command polling.
- Create `scripts/deploy-production.sh`: release creation, build, symlink switch, PM2 reload, health checks, rollback, and cleanup.
- Create `scripts/migrate-production-layout.sh`: one-time migration of `.env`, runtime data, PM2 working directories, and collectors.
- Create `ecosystem.config.cjs`: version-controlled PM2 definitions using `current` and `shared/data`.
- Create `ops/aws/github-oidc-trust-policy.json`: GitHub `master`-only role trust policy.
- Create `ops/aws/github-deploy-permissions.json`: least-privilege SSM permissions for the target instance.
- Create `ops/aws/README.md`: exact one-time AWS setup and verification commands.
- Create `tests/test-deployment-assets.sh`: static safety and interface tests for scripts, workflow, policies, and PM2 config.
- Modify `.gitignore`: exclude generated deployment test artifacts only; runtime production data remains outside the repository.
- Modify `README.md`: document the production deployment source of truth and recovery entrypoints.

## Fixed production identifiers

```text
AWS_ACCOUNT_ID=890742583014
AWS_REGION=ap-northeast-1
EC2_INSTANCE_ID=i-0d3456ec595259c39
EC2_USER=ec2-user
GITHUB_REPOSITORY=HarukiShirato/real-time-monitoring-for-perpetual-contracts
GITHUB_BRANCH=master
APP_ROOT=/home/ec2-user/apps/perp-dashboard
LEGACY_ROOT=/home/ec2-user/perp-dashboard
PUBLIC_HEALTH_URL=https://data.dvcapital.xyz/
LOCAL_HEALTH_URL=http://127.0.0.1:3000/
PM2_APP=perp-dashboard
```

### Task 1: Add deployment asset safety tests

**Files:**
- Create: `tests/test-deployment-assets.sh`
- Modify: `package.json`

- [ ] **Step 1: Write the failing deployment asset test**

Create a Bash shell test that requires the planned files and verifies these exact invariants:

```bash
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
```

Add the package script:

```json
"test:deployment": "bash tests/test-deployment-assets.sh"
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:deployment`  
Expected: FAIL with `missing: .github/workflows/deploy-production.yml`.

- [ ] **Step 3: Commit the failing test**

```bash
git add package.json tests/test-deployment-assets.sh
git commit -m "test: define production deployment safeguards"
```

### Task 2: Define least-privilege AWS OIDC and SSM policies

**Files:**
- Create: `ops/aws/github-oidc-trust-policy.json`
- Create: `ops/aws/github-deploy-permissions.json`
- Create: `ops/aws/README.md`
- Test: `tests/test-deployment-assets.sh`

- [ ] **Step 1: Create the OIDC trust policy**

Use this exact condition so only `master` in this repository can assume the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::890742583014:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:HarukiShirato/real-time-monitoring-for-perpetual-contracts:ref:refs/heads/master"
      }
    }
  }]
}
```

- [ ] **Step 2: Create the SSM permissions policy**

Allow the standard shell document only for the target instance, plus the command-result read and cancellation needed to supervise that invocation. AWS does not define an IAM resource type for `ssm:CancelCommand`, so its separate statement must use `Resource: "*"`; the workflow still binds the captured command ID to the fixed instance ID when cancelling.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript",
        "arn:aws:ec2:ap-northeast-1:890742583014:instance/i-0d3456ec595259c39"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "ssm:CancelCommand",
      "Resource": "*"
    }
  ]
}
```

- [ ] **Step 3: Document one-time AWS setup**

Document commands that:

1. create the GitHub OIDC provider if absent;
2. create `GitHubActionsPerpDashboardDeployRole` with the trust policy;
3. attach the inline SSM policy;
4. verify the instance appears as an SSM managed node;
5. run a harmless `printf` command through SSM, capture its `CommandId`, wait for that exact instance command, retrieve the same invocation, and verify `Success` plus its stdout.

The harmless verification must capture the returned `CommandId`, wait for that instance command, retrieve the same invocation, and assert both `Success` and stdout `ssm-ready`:

```bash
command_id="$(
  aws ssm send-command \
    --region ap-northeast-1 \
    --instance-ids i-0d3456ec595259c39 \
    --document-name AWS-RunShellScript \
    --parameters 'commands=["printf ssm-ready"]' \
    --query 'Command.CommandId' \
    --output text
)"
aws ssm wait command-executed \
  --region ap-northeast-1 \
  --command-id "$command_id" \
  --instance-id i-0d3456ec595259c39
invocation="$(
  aws ssm get-command-invocation \
    --region ap-northeast-1 \
    --command-id "$command_id" \
    --instance-id i-0d3456ec595259c39 \
    --query '{Status:Status,StandardOutputContent:StandardOutputContent}' \
    --output json
)"
[[ "$(jq -r '.Status' <<<"$invocation")" == "Success" ]]
[[ "$(jq -r '.StandardOutputContent' <<<"$invocation")" == "ssm-ready" ]]
```

- [ ] **Step 4: Run policy validation**

Run:

```bash
jq empty ops/aws/github-oidc-trust-policy.json
jq empty ops/aws/github-deploy-permissions.json
npm run test:deployment
```

Expected: JSON checks PASS; deployment asset test still FAILS only for files from later tasks.

- [ ] **Step 5: Commit**

```bash
git add ops/aws tests/test-deployment-assets.sh
git commit -m "docs: define GitHub OIDC deployment permissions"
```

### Task 3: Implement the isolated release script

**Files:**
- Create: `scripts/deploy-production.sh`
- Test: `tests/test-deployment-assets.sh`

- [ ] **Step 1: Add SHA validation and deployment locking**

The script must start with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

readonly SHA="${1:-}"
readonly APP_ROOT=/home/ec2-user/apps/perp-dashboard
readonly RELEASES="$APP_ROOT/releases"
readonly CURRENT="$APP_ROOT/current"
readonly PREVIOUS="$APP_ROOT/previous"
readonly SHARED="$APP_ROOT/shared"
readonly LOCK_FILE="$APP_ROOT/deploy.lock"

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid git SHA" >&2; exit 64; }
mkdir -p "$RELEASES" "$SHARED"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "deployment already running" >&2; exit 75; }
```

- [ ] **Step 2: Add release fetch, dependency install, and build**

Clone the public repository without reusing the mutable legacy checkout, fetch the exact SHA,
verify it, link shared files, and build:

```bash
release="$RELEASES/$SHA"
tmp="$RELEASES/.${SHA}.tmp"
rm -rf "$tmp"
git clone --no-checkout https://github.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts.git "$tmp"
git -C "$tmp" fetch --depth 1 origin "$SHA"
git -C "$tmp" checkout --detach "$SHA"
test "$(git -C "$tmp" rev-parse HEAD)" = "$SHA"
ln -s "$SHARED/.env" "$tmp/.env"
rm -rf "$tmp/data"
ln -s "$SHARED/data" "$tmp/data"
(cd "$tmp" && npm ci && npm run build)
mv "$tmp" "$release"
```

- [ ] **Step 3: Add atomic switch, health checks, and rollback trap**

Record the old target, switch only after build, reload PM2, then poll local and public URLs.
The error trap must restore the old target after the switch and verify local recovery.

```bash
old="$(readlink -f "$CURRENT" 2>/dev/null || true)"
switched=0
rollback() {
  code=$?
  if (( switched )) && [[ -n "$old" && -d "$old" ]]; then
    ln -sfn "$old" "$CURRENT"
    pm2 reload ecosystem.config.cjs --only perp-dashboard --update-env
    curl --fail --silent --show-error --max-time 10 http://127.0.0.1:3000/ >/dev/null
  fi
  exit "$code"
}
trap rollback ERR
[[ -n "$old" ]] && ln -sfn "$old" "$PREVIOUS"
ln -sfn "$release" "$CURRENT"
switched=1
cd "$CURRENT"
pm2 reload ecosystem.config.cjs --only perp-dashboard --update-env
for _ in {1..12}; do
  curl --fail --silent --max-time 5 http://127.0.0.1:3000/ >/dev/null && break
  sleep 5
done
curl --fail --silent --show-error --max-time 15 https://data.dvcapital.xyz/ >/dev/null
switched=0
trap - ERR
```

- [ ] **Step 4: Add safe release cleanup**

Sort releases by modification time, keep the newest five, and never remove the resolved
`current` or `previous` target.

```bash
current_target="$(readlink -f "$CURRENT" 2>/dev/null || true)"
previous_target="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
mapfile -t old_releases < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d \
  ! -name '.*.tmp' -printf '%T@ %p\n' | sort -nr | tail -n +6 | cut -d' ' -f2-)
for candidate in "${old_releases[@]}"; do
  [[ "$candidate" == "$current_target" || "$candidate" == "$previous_target" ]] && continue
  rm -rf -- "$candidate"
done
```

- [ ] **Step 5: Run static and syntax tests**

```bash
bash -n scripts/deploy-production.sh
npm run test:deployment
```

Expected: shell syntax PASS; asset test still fails only for migration/workflow/PM2 files.

- [ ] **Step 6: Commit**

```bash
git add scripts/deploy-production.sh tests/test-deployment-assets.sh
git commit -m "feat: add atomic EC2 release deployment"
```

### Task 4: Separate runtime data and define PM2 processes

**Files:**
- Create: `scripts/migrate-production-layout.sh`
- Create: `ecosystem.config.cjs`
- Test: `tests/test-deployment-assets.sh`

- [ ] **Step 1: Write the PM2 ecosystem config**

Define `perp-dashboard`, `funding-collector`, `arbitrage-collector`, `staking-collector`, and
`positions-collector`. Every `cwd` must be `/home/ec2-user/apps/perp-dashboard/current` and
all collector output paths must resolve under `/home/ec2-user/apps/perp-dashboard/shared/data`.
The dashboard command remains `npm start` on port 3000.

- [ ] **Step 2: Write an idempotent migration script**

The migration script must:

1. require `/home/ec2-user/perp-dashboard/.env`;
2. create `shared/data` with mode `0750`;
3. copy `.env` with mode `0600`;
4. use `rsync -a` to copy legacy `data/` into shared data;
5. export the legacy code diff to
   `/home/ec2-user/apps/perp-dashboard/legacy-code-diff-20260804.patch`;
6. write a SHA-256 checksum for that patch;
7. never delete or modify the legacy checkout;
8. stop collectors only during the final rsync and PM2 cwd switch;
9. start the ecosystem file and run local/public health checks.

- [ ] **Step 3: Extend safety tests**

Assert that the migration script contains `rsync -a`, `git diff`, `sha256sum`, and no
`rm -rf /home/ec2-user/perp-dashboard`. Assert every PM2 cwd uses the `current` symlink.

- [ ] **Step 4: Run tests**

```bash
bash -n scripts/migrate-production-layout.sh
node -e "require('./ecosystem.config.cjs')"
npm run test:deployment
```

Expected: all current deployment asset tests PASS except the missing workflow.

- [ ] **Step 5: Commit**

```bash
git add ecosystem.config.cjs scripts/migrate-production-layout.sh tests/test-deployment-assets.sh
git commit -m "feat: isolate production runtime data"
```

### Task 5: Add the GitHub Actions production workflow

**Files:**
- Create: `.github/workflows/deploy-production.yml`
- Test: `tests/test-deployment-assets.sh`

- [ ] **Step 1: Create the workflow trigger, permissions, and concurrency**

Use `push` to `master`, `id-token: write`, `contents: read`, and:

```yaml
concurrency:
  group: perp-dashboard-production
  cancel-in-progress: false
```

- [ ] **Step 2: Add runner verification**

Use `actions/checkout`, `actions/setup-node` with Node 18 and npm cache, then run:

```yaml
- run: npm ci
- run: npm run build
- run: npm run test:deployment
```

- [ ] **Step 3: Add OIDC and SSM deployment**

Use `aws-actions/configure-aws-credentials` with:

```yaml
role-to-assume: arn:aws:iam::890742583014:role/GitHubActionsPerpDashboardDeployRole
aws-region: ap-northeast-1
```

Send `scripts/deploy-production.sh $GITHUB_SHA` through `AWS-RunShellScript`, capture the
command ID, and set an SSM command timeout. Do not use the AWS CLI waiter: poll the same
command ID and instance with `aws ssm get-command-invocation` every 10 seconds for at most
15 minutes. On a poll timeout or GitHub Actions interruption, the `EXIT` trap must call
`aws ssm cancel-command` for that captured command and instance, then continue bounded
polling until a terminal status so the remote shell receives termination and the deployment
script can run its rollback trap. Print both SSM stdout and stderr to the Actions log after
masking known runner credentials; the remote deployment script must log its SHA, PM2 reload,
and both health-check confirmations without printing secrets. Because the first deployment
cannot assume the script is already installed, the SSM command must first download the script
from the exact triggering commit and then execute it as `ec2-user`:

```bash
install -d -m 0755 /home/ec2-user/apps/perp-dashboard/shared/bin
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts/${GITHUB_SHA}/scripts/deploy-production.sh" \
  -o /home/ec2-user/apps/perp-dashboard/shared/bin/deploy-production.sh
chmod 0755 /home/ec2-user/apps/perp-dashboard/shared/bin/deploy-production.sh
/home/ec2-user/apps/perp-dashboard/shared/bin/deploy-production.sh "${GITHUB_SHA}"
```

The workflow must fail unless SSM status is `Success`.

- [ ] **Step 4: Run workflow lint and repository build**

```bash
actionlint .github/workflows/deploy-production.yml
npm run test:deployment
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy-production.yml tests/test-deployment-assets.sh
git commit -m "ci: deploy master to EC2 automatically"
```

### Task 6: Document production operations

**Files:**
- Modify: `README.md`
- Create: `docs/production-deployment.md`

- [ ] **Step 1: Document the source of truth**

State explicitly that GitHub `master` is the only code source, local and EC2 code changes
must not be merged automatically, and `.env` plus runtime data live under `shared/`.

- [ ] **Step 2: Document normal deployment and rollback inspection**

Include commands to inspect GitHub Actions, SSM command output, `readlink -f current`, PM2,
local health, public health, and the legacy checkout. Include an emergency manual rollback
that switches `current` to `previous` and reloads only the dashboard first.

- [ ] **Step 3: Run documentation and build verification**

```bash
npm run test:deployment
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/production-deployment.md
git commit -m "docs: add production deployment runbook"
```

### Task 7: Configure AWS and perform the controlled first release

**Files:**
- No additional repository files unless verification reveals a documented defect.

- [ ] **Step 1: Create or verify the GitHub OIDC provider**

Use the commands in `ops/aws/README.md`. Verify provider URL and audience exactly match the
trust policy; do not reuse a role that can read trading secrets.

- [ ] **Step 2: Create the dedicated role and attach its inline policy**

Verify with IAM policy simulation that `ssm:SendCommand` is allowed for
`i-0d3456ec595259c39` and denied for a different instance ARN.

- [ ] **Step 3: Make the EC2 instance an SSM managed node**

If it does not appear online, add only `AmazonSSMManagedInstanceCore` to the instance role and
restart `amazon-ssm-agent`. Verify `PingStatus=Online` before continuing.

- [ ] **Step 4: Run the harmless SSM probe**

Send `printf ssm-ready`, wait for completion, and verify stdout equals `ssm-ready`.

- [ ] **Step 5: Fetch the committed deployment scripts without switching production**

Use SSM to fetch the exact GitHub commit into a temporary directory and execute only
`bash -n` plus the static deployment tests. Do not run the migration script yet.

- [ ] **Step 6: Back up and migrate runtime data**

Record counts, byte sizes, newest timestamps, and SHA-256 checksums before and after migration.
Run `scripts/migrate-production-layout.sh` once during the maintenance window. Verify all PM2
processes are online and collectors continue updating shared data.

- [ ] **Step 7: Push the workflow commit and watch the first automatic release**

Confirm the triggered SHA equals the GitHub `master` SHA, SSM reports `Success`, `current`
resolves to that SHA, PM2 is online, and both health URLs return 200.

- [ ] **Step 8: Exercise failure safety**

On a temporary branch or controlled test release, prove a build failure leaves `current`
unchanged. Then use a controlled invalid health target to prove rollback restores `previous`.
Do not merge intentionally failing code into `master`.

- [ ] **Step 9: Final verification**

```bash
npm ci
npm run test:deployment
npm run build
git status --short
```

Expected: tests and build exit 0; Git status is clean; production `current` equals GitHub
`master`; `data.dvcapital.xyz` returns HTTP 200; shared data timestamps continue advancing.
