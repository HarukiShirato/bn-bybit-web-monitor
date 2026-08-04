#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash -n "$root/scripts/deploy-production.sh" "$root/scripts/run-ssm-deployment.sh"
node --check "$root/ecosystem.config.cjs"
node - "$root/ecosystem.config.cjs" <<'NODE'
const config=require(process.argv[2]);
const names=['perp-dashboard','funding-collector','arbitrage-collector','staking-collector','positions-collector'];
if(config.apps.length!==5) process.exit(1);
for(const name of names){const matches=config.apps.filter(app=>app.name===name);if(matches.length!==1||matches[0].cwd!=='/home/ec2-user/perp-dashboard')process.exit(1);}
NODE
node - "$root/.github/workflows/deploy-production.yml" <<'NODE'
const fs=require('fs'); const YAML=require('yaml'); const workflow=YAML.parse(fs.readFileSync(process.argv[2],'utf8'));
if(!workflow.jobs.verify||!workflow.jobs.deploy||workflow.jobs.deploy.needs!=='verify') process.exit(1);
if(workflow.jobs.deploy.permissions['id-token']!=='write') process.exit(1);
NODE
echo 'deployment asset tests passed'
