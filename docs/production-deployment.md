# 生产部署运行手册

> **已接受的信任模型：** 能合并或直接推送 GitHub `master` 的维护者（目前仅本人/老板）等同于生产发布者。部署角色使用通用 `AWS-RunShellScript`，因此生产发布者能够在目标服务器执行通用 shell，并可能接触该服务器进程可访问的环境。本方案不宣称通过 IAM 把发布者与服务器环境隔离；安全边界是严格控制 `master` 写权限与审查流程。

本手册适用于 `data.dvcapital.xyz` 的永续合约仪表盘。生产部署由 GitHub Actions 通过 AWS Systems Manager（SSM，AWS 用来在受管服务器上执行命令的服务）完成；不要以 SSH 或 SSM 直接修改生产代码。

## 不可变规则与目录

GitHub `master` 是唯一的生产代码来源。对 `master` 的任何 push 都会触发发布：PR 合并会触发，直接 push 也会触发。正常协作必须先经 PR 审查再合并；直接 push 仅说明其同样会被自动部署，并不替代审查流程。本地工作树和 EC2 上的代码改动不得自动合并、提交或作为后续部署的来源。需要修复时，请在受控开发环境完成审查并合并到 `master`，让 Actions 发布该 commit。

EC2 的应用根目录是 `/home/ec2-user/apps/perp-dashboard`：

```text
releases/<40 位 Git SHA>/  不可变的代码与构建产物
current -> releases/<SHA>  正在服务的版本
previous -> releases/<SHA> 上一个版本，用于紧急回退
shared/.env               仅服务器保存的环境变量（0600）
shared/data/              跨 release 保留的运行时数据
shared/deploy-logs/       仅服务器保存的详细部署日志（0600）
```

每次发布将 `shared/.env` 和 `shared/data` 链接到新 release；它们不会进入 Git，也不能靠替换 release 恢复。`current` 像舞台上正在使用的剧本，`previous` 是上一版剧本；`shared/` 则像所有剧本共用的道具间。切换剧本不会替换道具，因此排障时要把“代码版本”和“环境变量/数据”分开判断。这个比喻不表示数据可随意修改：运行时数据仍应按其所属业务流程维护。

## 首次迁移（仅执行一次）

首次建立新目录时不存在 `current`，因此按“先构建、再迁移、再验证”执行，避免迁移脚本反过来依赖一个尚未存在的 release。以下命令全部以 `ec2-user` 执行，`SHA` 必须是已审查并合并到 `master` 的完整 40 位提交：

```bash
set -Eeuo pipefail
SHA='替换为 master 上的完整 40 位 SHA'
APP_ROOT=/home/ec2-user/apps/perp-dashboard
deploy_script="$APP_ROOT/shared/bin/deploy-production-$SHA.sh"
install -d -m 0755 "$APP_ROOT/shared/bin"
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/HarukiShirato/real-time-monitoring-for-perpetual-contracts/$SHA/scripts/deploy-production.sh" \
  --output "$deploy_script"
chmod 0755 "$deploy_script"
"$deploy_script" --prepare-only "$SHA"
PREPARED_SHA="$SHA" "$APP_ROOT/releases/$SHA/scripts/migrate-production-layout.sh"
"$deploy_script" "$SHA"
```

下载 URL、prepare 参数和 release 路径绑定同一个精确 SHA。第一步只构建并写 prepared marker，不切换 `current`、不触碰 PM2，也不向构建暴露生产 `.env`；第二步迁移并整体切换五个 PM2 进程；第三步做同 SHA 幂等验证。普通 workflow 在 migration marker 或有效 `current` 建立前会立即失败，不停止 PM2、不切换链接。

## 正常发布与验收

1. 将已审查的代码经 PR 合并到 GitHub `master`。任何直接 push 也会自动部署，因此不得用它绕过审查。不要在 EC2 检出分支、`git pull`、编辑文件或手动运行发布脚本来替代该流程。
2. 在 GitHub Actions 中打开此次 `Deploy production` 工作流。`verify` 必须先完成 `npm ci`、`npm run build` 和 `npm run test:deployment`；随后 `deploy` 使用短期 OIDC 凭证发起 SSM 命令。
3. 记录 Actions 输出中的 `SSM_SUBMITTED COMMAND_ID=... SHA=...`。这是排查部署的索引，不是密钥。

Actions 日志与 SSM 原始输出的用途不同：Actions 固定输出状态字段 `SSM_SUBMITTED`、轮询中的 `SSM_STATUS` 和最终 `SSM_RESULT`，并从远程输出中仅筛出四个 `DEPLOY_*` 里程碑。它不会回显完整远程部署日志。若需要从本机核验该 SSM 调用，先从同一次 Actions 输出记录 `CommandId` 和完整的 40 位 `SHA`；下列命令只检查 `Status=Success` 与这四个 `DEPLOY_*` 里程碑，任一条件缺失会立刻失败：

```bash
( set -Eeuo pipefail
  command_id='替换为 Actions 输出中的 CommandId'
  expected_sha='替换为同一次 Actions 输出中的精确 40 位 SHA'
  [[ "$expected_sha" =~ ^[0-9a-f]{40}$ ]]

  invocation="$(aws ssm get-command-invocation \
    --region ap-northeast-1 \
    --command-id "$command_id" \
    --instance-id i-0d3456ec595259c39 \
    --query '{Status:Status,StandardOutputContent:StandardOutputContent}' \
    --output json)"
  [[ "$(jq -r '.Status' <<<"$invocation")" == 'Success' ]]

  deployment_output="$(jq -r '.StandardOutputContent // ""' <<<"$invocation")"
  grep -Fx "DEPLOY_SHA=$expected_sha" <<<"$deployment_output" >/dev/null
  for milestone in \
    'DEPLOY_PM2=online' \
    'DEPLOY_LOCAL_HEALTH=ok' \
    'DEPLOY_PUBLIC_HEALTH=ok'; do
    grep -Fx "$milestone" <<<"$deployment_output" >/dev/null
  done
  echo 'SSM invocation verified'
)
```

`DEPLOY_SHA` 用于将里程碑与本次提交对应；其余三项确认 PM2、本机健康检查和公网健康检查。`SSM_RESULT=success` 是 Actions 的最终状态字段，不是原始 SSM 输出的核验条件。命令状态不是 `Success` 或任一里程碑缺失时，不要重试未知的远程 shell；先查看 Actions 的固定状态字段，再按下面的服务器检查定位原因。

## 服务器检查（只读）

以下命令应通过 AWS SSM Session Manager 以 `ec2-user` 身份执行，或由有权限的值班人员在受控会话中执行。它们不显示 `.env` 内容，也不修改代码或数据。

```bash
APP_ROOT=/home/ec2-user/apps/perp-dashboard
readlink -f "$APP_ROOT/current"
readlink -f "$APP_ROOT/previous"
pm2 status perp-dashboard
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3000/ >/dev/null && echo 'local health: ok'
curl --fail --silent --show-error --max-time 15 https://data.dvcapital.xyz/ >/dev/null && echo 'public health: ok'
```

要将正在运行的 PM2 定义与 `current` 对照，可执行：

```bash
APP_ROOT=/home/ec2-user/apps/perp-dashboard
pm2 describe perp-dashboard
readlink -f "$APP_ROOT/current/ecosystem.config.cjs"
```

详细部署日志在服务器本地：`$APP_ROOT/shared/deploy-logs/<SHA>-<UTC 时间>-<PID>.log`。该目录权限为 `0700`，日志文件权限为 `0600`；不要把日志整体复制到 GitHub Actions、工单或聊天中，因为依赖安装或运行时输出可能包含不应扩散的上下文。优先用 SSM/Actions 的里程碑和错误状态沟通，必要时由有服务器权限的人员在受控会话中最小范围查看对应 SHA 的日志。

## 旧目录审计

旧检出目录 `/home/ec2-user/perp-dashboard` 仅用于迁移后的审计，不是部署来源，也不能从这里运行 `git pull` 或 PM2。迁移时会保留可校验的代码差异与未跟踪文件审计物；敏感环境文件、运行数据和常见密钥文件被排除。只查看状态与校验和，不要输出审计补丁或归档内容：

```bash
APP_ROOT=/home/ec2-user/apps/perp-dashboard
git -C /home/ec2-user/perp-dashboard status --short
sha256sum --check "$APP_ROOT/legacy-code-diff-20260804.patch.sha256"
sha256sum --check "$APP_ROOT/legacy-code-untracked-20260804.txt.sha256"
sha256sum --check "$APP_ROOT/legacy-code-untracked-20260804.tar.sha256"
```

若发现旧目录存在改动，记录其路径和审计结果，然后在受控开发环境中重新实现并走 `master` 发布；不要把旧目录直接同步到 `releases/`、`current` 或仓库。

## 紧急人工回退

仅当已确认当前版本导致服务不可用，且 `previous` 指向已成功发布的 release 时执行。此操作在 EC2 上切换符号链接，并把仪表盘与四个采集器作为同一个发布单元切回，不会改动 `shared/.env` 或 `shared/data`。请以 `ec2-user` 在受控 SSM 会话执行：

```bash
set -Eeuo pipefail
APP_ROOT=/home/ec2-user/apps/perp-dashboard
exec 9>"$APP_ROOT/deploy.lock"
flock -n 9 || { echo 'deployment lock is held; check GitHub Actions and SSM before retrying rollback' >&2; exit 75; }
target="$(readlink -f "$APP_ROOT/previous")"
test -d "$target"
test "$(dirname "$target")" = "$APP_ROOT/releases"
test -f "$target/.deployment-success.json"
next_link="$APP_ROOT/current.rollback.$$"
ln -s "$target" "$next_link"
mv -Tf "$next_link" "$APP_ROOT/current"
cd "$APP_ROOT/current"
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector
pm2 startOrRestart ecosystem.config.cjs --update-env
deadline=$(( $(date +%s) + 57 ))
until curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3000/ >/dev/null; do
  (( $(date +%s) < deadline )) || { echo 'local rollback health check failed' >&2; exit 1; }
  sleep 3
done
curl --fail --silent --show-error --max-time 15 https://data.dvcapital.xyz/ >/dev/null
printf 'rollback current=%s\n' "$(readlink -f "$APP_ROOT/current")"
```

任一命令失败时立刻停止，不要猜测性修改 `current`、`previous`、PM2 配置或代码。记录当前 `CommandId`、`readlink` 输出和健康检查结果，并从 GitHub 的已知正确 commit 发起修复发布。若仪表盘已恢复而采集器仍需处理，按事故流程单独评估；不要在未验证仪表盘前批量重载所有 PM2 进程。

## 权限与日志边界

GitHub 的部署角色只允许由仓库 `master` 承担，并只向实例 `i-0d3456ec595259c39` 使用 SSM；但所用文档是通用 `AWS-RunShellScript`，所以这不是“不能执行任意 shell”的隔离边界。IAM、OIDC Provider、SSM 托管节点的建立和只读连通性验证，请使用 [AWS 部署角色设置](../ops/aws/README.md)。

不要把 AWS 长期访问密钥、OIDC 令牌、`.env`、运行时数据或完整服务器日志写入仓库、Actions 输出、issue 或聊天。Actions 会掩码其短期凭证，并固定输出 `SSM_SUBMITTED`、`SSM_STATUS`、`SSM_RESULT` 状态字段及四个 `DEPLOY_*` 里程碑，不回显完整远程日志；服务器详细日志留在 `shared/deploy-logs/`。需要扩大 AWS 权限、读取密钥或导出日志时，应走单独的最小权限审批，不要为排障临时扩大 GitHub 部署角色。
