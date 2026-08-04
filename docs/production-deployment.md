# 生产部署运行手册

## 安全边界

GitHub Actions 只能向自定义 SSM Document `PerpDashboardDeploy` 传一个 `CommitSha`。Document 只执行 root-owned 的 `/usr/local/sbin/perp-dashboard-deploy <sha>`；GitHub Role 不允许 `AWS-RunShellScript`。wrapper 用 `env -i` 清空 SSM/root 环境，再以专用低权限用户 `perp-dashboard` 调用固定的 `/usr/local/libexec/perp-dashboard/deploy-production`，因此部署进程环境不会继承交易密钥。应用用户不能改 wrapper/engine，也被 OUTPUT owner 规则禁止访问 IMDS `169.254.169.254`。

运行时 `.env` 只能包含仪表盘/采集器所需的只读配置，不得包含交易、下单、提现或账户控制密钥。默认构建环境是空白环境加 `HOME`、`PATH`、`NODE_ENV=production`；确有公开构建变量时才用 `BUILD_ENV_ALLOWLIST` 逐项批准。

目录统一归 `perp-dashboard` 用户：

```text
/home/perp-dashboard/apps/perp-dashboard/
  releases/<sha>/
  current -> releases/<sha>
  previous -> releases/<sha>
  shared/.env
  shared/data/
  shared/deploy-logs/<sha>-<UTC>-<pid>.log
/home/perp-dashboard/.pm2
```

## 一次性 bootstrap 与首次迁移

在可信、已审计的 checkout 中以 root 人工执行（不是 GitHub workflow）：

```bash
sudo ops/ec2/bootstrap-perp-dashboard-deploy.sh
sudo -u perp-dashboard -H env PM2_HOME=/home/perp-dashboard/.pm2 \
  /usr/local/libexec/perp-dashboard/deploy-production --prepare-only <40位SHA>
sudo -u perp-dashboard -H env PM2_HOME=/home/perp-dashboard/.pm2 \
  /usr/local/libexec/perp-dashboard/migrate-production-layout <同一SHA>
```

bootstrap 后必须确认 engine/wrapper 是 `root:root 0755`、应用目录属于 `perp-dashboard`，并验证 IMDS 阻断且规则已持久化。若检测到旧 `/home/ec2-user/.pm2/dump.pm2`，bootstrap 会在维护窗口先 `pm2 save`、kill 旧 daemon（避免两个采集器同时写），复制 dump 并以新 `PM2_HOME=/home/perp-dashboard/.pm2` resurrect；随后迁移用 prepared release 建立 `current`、最后同步数据、一次性切换专用用户的五个 PM2 进程并写 marker。迁移早期失败不会碰已有 `dump.pm2`；只有本次已初始化快照且确实改写 dump 后，失败 trap 才恢复它。

## 正常发布与成功判据

合并到 `master` 后，`verify` 先构建和测试，`deploy` 再用 OIDC 调自定义 Document。部署会在获取 `flock` 后创建唯一日志，拉取并构建精确 SHA，构建成功后才链接 `.env`。切换时先停止四个 collector，再原子切换 `current`，最后 `pm2 startOrReload ecosystem.config.cjs --update-env` 启动 dashboard 与四个 collector。

成功必须同时满足：五个进程各只有一个、均为 `online`、`pm_cwd` 都是 `current`；四个 collector 的 `PERP_DATA_DIR` 都指向唯一的 `shared/data`；本机与公网健康检查成功。同 SHA 重跑是验证操作，满足这些条件即成功，不重复构建或切换。

## 失败与回退

构建失败不会触碰 `current`/PM2。切换后任一步失败，会停止 collector、恢复旧 `current`，并对同一份 ecosystem 执行 `startOrReload`，验证全部五个进程。日志不上传完整内容；以 Actions 的 CommandId、SHA 和固定 `DEPLOY_*` 里程碑定位服务器上的唯一日志。

人工回退也必须切换全部五个进程，且先取得部署锁：

```bash
set -Eeuo pipefail
APP_ROOT=/home/perp-dashboard/apps/perp-dashboard
export PM2_HOME=/home/perp-dashboard/.pm2
exec 9>"$APP_ROOT/deploy.lock"
flock -n 9
target="$(readlink -f "$APP_ROOT/previous")"
test -f "$target/.deployment-success.json"
pm2 stop funding-collector arbitrage-collector staking-collector positions-collector
ln -s "$target" "$APP_ROOT/current.rollback.$$"
mv -Tf "$APP_ROOT/current.rollback.$$" "$APP_ROOT/current"
cd "$APP_ROOT/current"
pm2 startOrReload ecosystem.config.cjs --update-env
curl --fail --max-time 2 http://127.0.0.1:3000/ >/dev/null
```
