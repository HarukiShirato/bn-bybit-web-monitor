#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"; cd "$root"
for f in .github/workflows/deploy-production.yml ops/aws/perp-dashboard-deploy-document.yml ops/aws/github-deploy-permissions.json ops/ec2/perp-dashboard-deploy-wrapper.sh ops/ec2/bootstrap-perp-dashboard-deploy.sh scripts/deploy-production.sh scripts/migrate-production-layout.sh ecosystem.config.cjs; do [[ -f "$f" ]] || { echo "missing $f" >&2; exit 1; }; done
bash -n ops/ec2/*.sh scripts/deploy-production.sh scripts/migrate-production-layout.sh
node - <<'NODE'
const fs=require('fs'), YAML=require('yaml');
const workflow=YAML.parse(fs.readFileSync('.github/workflows/deploy-production.yml','utf8'));
if (JSON.stringify(workflow.on?.push?.branches)!==JSON.stringify(['master'])) throw Error('workflow trigger');
const deploy=workflow.jobs.deploy;
if(deploy.permissions?.['id-token']!=='write'||deploy.permissions?.contents!=='read'||deploy.needs!=='verify') throw Error('deploy permissions');
const run=deploy.steps.at(-1).run;
for(const value of ['--document-name PerpDashboardDeploy','CommitSha','--instance-ids i-0d3456ec595259c39']) if(!run.includes(value)) throw Error(`workflow missing ${value}`);
for(const forbidden of ['AWS-RunShellScript','raw.githubusercontent.com','sudo -u ec2-user']) if(run.includes(forbidden)) throw Error(`workflow contains ${forbidden}`);
const doc=YAML.parse(fs.readFileSync('ops/aws/perp-dashboard-deploy-document.yml','utf8'));
if(doc.parameters.CommitSha.allowedPattern!=='^[0-9a-f]{40}$'||Object.keys(doc.parameters).length!==1) throw Error('document parameters');
const policy=JSON.parse(fs.readFileSync('ops/aws/github-deploy-permissions.json'));
const send=policy.Statement.find(s=>(Array.isArray(s.Action)?s.Action:[s.Action]).includes('ssm:SendCommand'));
const resources=Array.isArray(send.Resource)?send.Resource:[send.Resource];
if(resources.length!==2||resources.some(r=>r.includes('AWS-RunShellScript'))||!resources.some(r=>r.endsWith('document/PerpDashboardDeploy'))||!resources.some(r=>r.endsWith('instance/i-0d3456ec595259c39'))) throw Error('send-command resources');
NODE
if grep -R -I -E 'AKIA[0-9A-Z]{16}|-----BEGIN( [A-Z0-9]+)? PRIVATE KEY-----' .github ops scripts ecosystem.config.cjs >/dev/null; then echo 'credential material found' >&2; exit 1; fi
echo 'deployment asset tests passed'
