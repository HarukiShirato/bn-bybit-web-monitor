# Perpetual Dashboard EC2 自动部署设计

> **已接受的信任模型：** 能合并或直接推送 `master` 的维护者（目前仅本人/老板）等同于生产发布者。发布使用通用 `AWS-RunShellScript`；生产发布者因此可以在目标 EC2 执行通用 shell，并可能访问服务器进程可见的环境。本设计依赖 `master` 权限治理，不宣称部署角色与服务器环境之间存在技术隔离。

**日期：** 2026-08-04  
**状态：** 待用户书面复核  
**目标仓库：** `HarukiShirato/real-time-monitoring-for-perpetual-contracts`  
**生产实例：** 东京 EC2 `13.193.65.245`  
**生产域名：** `https://data.dvcapital.xyz`

**代码唯一事实源：** GitHub `master`。本地工作区和 EC2 上的未提交源码不参与
合并，也不得反向覆盖 GitHub。

## 1. 目标与边界

当 GitHub `master` 分支收到新提交后，GitHub Actions 自动部署该精确 commit 到
东京 EC2。部署必须满足：

- 不在 GitHub 保存长期 AWS Access Key 或 EC2 SSH 私钥；
- 不覆盖采集器生成的运行数据、生产 `.env` 或其他现场文件；
- 新版本构建失败时，当前线上版本继续运行；
- 切换后健康检查失败时，自动恢复到上一个成功版本；
- 同一时间最多运行一个生产部署；
- OIDC 信任只覆盖这个仓库的 `master`，SSM 调用只指向这台 EC2；所用文档是通用 `AWS-RunShellScript`；
- 不读取或修改交易密钥、账户、持仓、订单及其他交易服务。

本项目是只读监控网站。本次不修改页面功能、采集算法、依赖版本或交易相关系统。

## 2. 已确认现状

- EC2 上的仓库目录是 `/home/ec2-user/perp-dashboard`；
- 应用由 PM2 进程 `perp-dashboard` 运行，监听本机 `3000`；
- `perp-dashboard-tunnel.service` 将 `data.dvcapital.xyz` 转发到
  `http://localhost:3000`；
- EC2 的 Amazon SSM Agent 为 active；
- 当前 EC2 IAM Role 为 `Quant-Bot-Secrets-Role`，其现有权限不作为本设计中的
  GitHub 部署权限使用；
- 2026-08-04 核验时，本机与公网首页均返回 HTTP 200；
- EC2 仓库存在采集数据变更和两个未提交源码变更；其中运行数据必须迁移保留，
  未提交源码不参与合并，首次切换后由 GitHub `master` 版本取代；
- 最新 GitHub 基线可完成 `npm ci` 和 `npm run build`；
- 依赖审计报告 1 个中等和 7 个高危漏洞，依赖升级另开任务处理。

## 3. 方案选择

采用 `GitHub Actions OIDC → AWS SSM Run Command → EC2 发布脚本`。

不采用：

- GitHub Actions 保存 EC2 SSH 私钥并直接 SSH；
- EC2 上的定时任务轮询并执行 `git pull`；
- 在正在运行的仓库目录内执行 `git reset --hard`；
- 构建前先停止线上 PM2 进程。

OIDC 只向本仓库 `master` 分支签发短期 AWS 会话。SSM 负责向目标 EC2 发送固定的
部署命令，SSH 端口和长期云密钥都不进入 GitHub。

## 4. 目录结构

生产部署改为版本目录与共享目录分离：

```text
/home/ec2-user/apps/perp-dashboard/
├── releases/
│   └── <full-git-sha>/
├── current -> releases/<active-git-sha>
├── previous -> releases/<previous-git-sha>
└── shared/
    ├── .env
    └── data/
```

规则：

- `releases/<sha>` 只放该 Git commit 的代码、依赖和构建产物；
- `.env` 和所有采集器运行数据只放在 `shared/`，不受 Git 更新影响；
- 每个 release 内通过软链接访问共享 `.env` 和数据路径；
- `current` 是 PM2 唯一运行入口；
- 只保留最近 5 个成功 release，当前和上一个版本永不在清理时删除。

现有 `/home/ec2-user/perp-dashboard` 在首次迁移成功前保留，作为人工恢复入口。

## 5. GitHub Actions

新增 `.github/workflows/deploy-production.yml`，只响应：

```yaml
on:
  push:
    branches: [master]
```

工作流权限固定为：

```yaml
permissions:
  id-token: write
  contents: read
```

并发保护：

```yaml
concurrency:
  group: perp-dashboard-production
  cancel-in-progress: false
```

工作流步骤：

1. `verify` job 仅有 `contents: read`，checkout 后执行依赖安装、生产构建和测试；
2. `deploy` job 必须等待 `verify`，才取得 `id-token: write` 并通过 OIDC 承担专用 AWS Role；
3. 所有 GitHub Action 固定到完整 commit SHA；升级时人工审阅上游 release 与 commit，再同步更新 pin 和测试；
4. 使用 SSM `SendCommand` 将完整 commit SHA 和发布命令发送给目标 EC2；
5. SSM 同时设置 delivery `timeout-seconds` 和 RunShellScript `executionTimeout`，以绝对 deadline 轮询；超时或中断时取消该 command，清理阶段只短轮询；
6. EC2 将 Git/npm/build 明细写入权限 0600 的本地日志；Actions 仅白名单输出固定 SHA、PM2 和健康检查里程碑，绝不转发原始 stdout/stderr；
7. 任何一步失败，GitHub Actions 以失败结束并保留日志。

Runner 预构建用于尽早失败；EC2 仍需再次构建，避免不同 CPU、Node 或原生依赖导致
Runner 成功而生产失败。

## 6. AWS 权限

创建专用 Role：`GitHubActionsPerpDashboardDeployRole`。

信任策略只允许：

- GitHub OIDC provider `token.actions.githubusercontent.com`；
- audience `sts.amazonaws.com`；
- repository `HarukiShirato/real-time-monitoring-for-perpetual-contracts`；
- ref `refs/heads/master`。

权限策略只允许：

- 对指定 EC2 实例调用通用 `AWS-RunShellScript` 的 `ssm:SendCommand`；
- 查询该次命令结果所需的 `ssm:GetCommandInvocation`；
- IAM 策略不授予 Secrets Manager、交易资源或其他实例权限；但目标实例上的通用 shell 仍继承 `ec2-user` 与服务器运行环境可访问的能力。

EC2 实例 Role 只补充成为 SSM Managed Node 所需的最小权限。不得把 GitHub 部署权限
合并进当前 `Quant-Bot-Secrets-Role` 的业务权限范围。

## 7. EC2 发布脚本

新增版本化脚本 `scripts/deploy-production.sh`，SSM 只调用该脚本并传入完整 SHA。

脚本流程：

1. 校验 SHA 为 40 位十六进制字符串；
2. 使用 `flock` 获取部署锁；无法获取则失败，不并行部署；
3. 创建临时 release 目录；
4. 从 GitHub 获取精确 SHA，验证 `HEAD` 与输入完全一致；
5. 链接共享 `.env` 和运行数据目录；
6. 执行 `npm ci`；
7. 执行 `npm run build`；
8. 记录旧 `current` 为回滚目标；
9. 原子切换 `current`；
10. 执行 `pm2 reload perp-dashboard --update-env`；
11. 轮询 `http://127.0.0.1:3000/`，最多 60 秒；
12. 检查公网 `https://data.dvcapital.xyz/`；
13. 成功后保存部署元数据并清理旧 release；
14. 健康检查失败时切回旧 `current`，再次 reload，并验证旧版本恢复。

在构建完成前，不停止、不 reload 当前生产进程。

## 8. 数据与现场修改迁移

首次启用自动部署前必须完成一次人工迁移：

1. 暂停采集器写入或取得一致性快照；
2. 识别所有运行数据文件；
3. 将其复制到 `shared/data` 并校验文件数量、大小和时间戳；
4. 修改采集器与应用使用共享路径；
5. 恢复采集器并确认数据继续更新；
6. 将 EC2 未提交源码差异导出为只读审计补丁，记录文件名和校验值，避免无记录
   丢失现场证据；
7. 不把该补丁合并进 GitHub，也不让它阻塞部署；
8. 首次切换直接使用 GitHub `master` 的精确 commit，旧目录保持不动作为短期人工
   回看入口。

禁止把采集历史简单删除后重新生成，也禁止在未备份时执行强制覆盖。

## 9. PM2 与采集器

补充受版本控制的 PM2 ecosystem 配置，明确：

- Dashboard 的 cwd 为 `/home/ec2-user/apps/perp-dashboard/current`；
- 各 collector 的代码来自 `current/scripts`；
- 各 collector 的数据输出进入 `shared/data`；
- reload 时尽量保持 Dashboard 可用；
- collector 切换版本时避免两份进程同时写同一个数据文件。

首次迁移需要安排一个短维护窗口，顺序停止旧 collector、切换路径、启动新 collector。
Dashboard 的版本构建阶段不需要停机。

## 10. 故障与回滚

- GitHub Runner 构建失败：不发送 SSM 命令；
- SSM 不可达或超时：线上版本不变；
- EC2 构建失败：删除失败 release，线上版本不变；
- PM2 reload 后本机健康失败：自动切回旧版本；
- 本机正常但公网异常：自动回滚，并保留 Cloudflare 日志线索；
- 回滚也失败：工作流失败，保留 current/previous 指针和完整日志，不继续尝试；
- 连续 push：按顺序部署，不取消已经开始的生产发布。

## 11. 验收标准

首次启用前：

- 已确认 GitHub `master` 是唯一代码事实源；EC2 现场源码差异只归档、不合并；
- 运行数据已迁移到共享目录并继续增长；
- GitHub 无 AWS 长期密钥或 EC2 私钥；
- OIDC trust 仅匹配目标仓库和 `master`；
- SSM 权限不能操作其他实例；
- release 目录中的 `.env` 是共享文件链接，不进入 Git。

自动部署测试：

1. 推送只修改静态文案的测试 commit；
2. Actions 自动触发且 Runner 构建成功；
3. SSM 部署精确 SHA；
4. PM2 online；
5. 本机和公网均返回 HTTP 200；
6. 页面能显示本次测试文案；
7. collector 数据持续更新；
8. 人为制造一次构建失败，确认线上版本不变；
9. 人为制造一次健康检查失败，确认自动回滚；
10. 记录恢复旧版的人工命令与位置。

## 12. 实施顺序

1. 迁移 EC2 运行数据，并把未提交源码差异归档为只读补丁；
2. 增加共享数据路径、PM2 ecosystem 和发布脚本；
3. 本地测试发布脚本的校验、锁、失败不切换和回滚；
4. 配置 AWS OIDC、专用 Role 和 SSM 最小权限；
5. 添加 GitHub Actions；
6. 手动执行一次 SSM dry-run，只创建 release、不切换；
7. 在维护窗口完成现有进程迁移；
8. 推送测试 commit，完成自动发布与回滚演练；
9. 验收后将 `master` 自动部署作为正式流程。
