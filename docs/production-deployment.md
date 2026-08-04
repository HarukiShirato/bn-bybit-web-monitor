# 生产自动部署

`data.dvcapital.xyz` 已部署在 `/home/ec2-user/perp-dashboard`。GitHub `master` 每次更新后，Actions 会先验证项目，再通过 AWS OIDC 和 SSM 让 EC2 更新这个现有目录。

## 数据边界

- GitHub 管理程序代码。
- EC2 上的 `.env` 和 `data/` 是运行时状态，部署、删除和回滚都不会覆盖它们。
- `.git` 保留在服务器，供只读审计使用，但部署不执行 `git pull`，也不把服务器改动推回 GitHub。

## 自动流程

1. Actions 执行 `npm ci`、`npm run build` 和 `npm run test:deployment`。
2. EC2 在 `/home/ec2-user/.deploy-work/perp-dashboard` 克隆并构建精确 SHA。
3. 构建成功后备份现有程序文件，短暂停止 Dashboard 和四个采集器。
4. 使用内容校验同步程序文件，排除 `.git`、`.env`、`data/`。
5. 重启并验证五个 PM2 进程、本机首页和公网首页。
6. 若切换后失败，自动恢复备份程序文件和原 PM2 配置。

## 验收

在 Actions 中应看到四个里程碑：

```text
DEPLOY_SHA=<40 位 SHA>
DEPLOY_PM2=online
DEPLOY_LOCAL_HEALTH=ok
DEPLOY_PUBLIC_HEALTH=ok
```

服务器只读检查：

```bash
cd /home/ec2-user/perp-dashboard
git status --short
pm2 status perp-dashboard funding-collector arbitrage-collector staking-collector positions-collector
curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3000/ >/dev/null && echo 'local health: ok'
curl --fail --silent --show-error --max-time 15 https://data.dvcapital.xyz/ >/dev/null && echo 'public health: ok'
```

详细部署日志位于 `/home/ec2-user/.deploy-logs/perp-dashboard/`，不要把 `.env`、运行数据或完整日志贴入 Actions、issue 或聊天。

## 故障处理

Actions 失败时不要在服务器执行 `git pull`。先确认网站健康和五个 PM2 进程；部署脚本在切换后的错误中会自动恢复旧程序。需要再次发布时，修复代码并合并新的 `master` commit，或在确认失败原因已经消失后重跑对应 Actions。

GitHub 部署角色只允许仓库 `master` 向实例 `i-0d3456ec595259c39` 使用 SSM。它使用通用 `AWS-RunShellScript`，因此能合并 `master` 的维护者等同于生产发布者。
