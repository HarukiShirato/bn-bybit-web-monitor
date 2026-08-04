# EC2 原目录自动部署设计

## 目标

保留已经运行的 `/home/ec2-user/perp-dashboard`，在 GitHub `master` 更新后自动构建并更新该目录，不再迁移到 release/current/shared 目录结构。

## 部署流程

1. GitHub Actions 先执行 `npm ci`、`npm run build` 和部署测试。
2. Actions 使用 OIDC 临时承担现有 AWS 部署角色，通过 SSM 把精确的 40 位提交 SHA 发送到 EC2。
3. EC2 在临时目录克隆并构建该 SHA；构建成功前不停止生产进程。
4. 停止四个数据采集进程，备份现有程序文件，再把临时目录同步到现有目录。
5. `.git`、`.env` 和 `data/` 始终排除在覆盖、删除和回滚之外。
6. 从现有目录重启 Dashboard 与四个采集进程，检查五个进程、本机首页和公网首页。
7. 切换失败时，用备份恢复程序文件并重新启动五个进程。

## 边界

- GitHub `master` 是程序代码来源；服务器 `.env` 和 `data/` 是运行时状态来源。
- 不创建或使用 `current`、`previous`、迁移 marker 或首次迁移命令。
- 同一 SHA 再次运行时仍执行完整的构建、同步和验证，保证操作简单且可重复。
- 详细构建日志保留在服务器，Actions 只输出 SHA、PM2、本机健康和公网健康里程碑。

## 成功标准

- 生产目录仍为 `/home/ec2-user/perp-dashboard`。
- `.env` 与 `data/` 内容在部署前后保持不被部署脚本修改。
- 五个目标 PM2 进程各一份、状态为 `online`、工作目录为现有生产目录。
- `http://127.0.0.1:3000/` 与 `https://data.dvcapital.xyz/` 均返回成功。
- 合并到 `master` 后 GitHub Actions 自动完成部署。
