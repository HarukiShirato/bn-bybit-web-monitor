# EC2 原目录自动部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitHub `master` 自动、安全地更新现有 EC2 生产目录，同时保留服务器运行数据。

**Architecture:** GitHub Actions 继续通过 OIDC 和 SSM 发送精确 SHA。EC2 先在临时目录构建，成功后备份并同步到现有目录；`.git`、`.env`、`data/` 不参与同步，失败时从备份恢复程序文件。

**Tech Stack:** GitHub Actions、AWS OIDC、AWS SSM、Bash、rsync、Node.js、PM2、Next.js

---

### Task 1: 用行为测试定义原目录部署

**Files:**
- Rewrite: `tests/test-deploy-production.sh`
- Modify: `tests/test-deployment-assets-contract.sh`

- [ ] 写入会验证临时构建、三类排除路径、五进程重启、健康检查和失败回滚的 fixture。
- [ ] 运行 `bash tests/test-deploy-production.sh`，确认旧 release/current 实现无法满足测试。

### Task 2: 实现原目录部署脚本

**Files:**
- Rewrite: `scripts/deploy-production.sh`

- [ ] 使用 `flock` 阻止并发部署，并验证 SHA 与执行用户。
- [ ] 在临时目录克隆精确 SHA，执行 `npm ci && npm run build`。
- [ ] 备份并同步程序文件，所有 rsync 调用排除 `.git`、`.env` 和 `data/`。
- [ ] 重启并验证五个 PM2 进程与两个健康地址。
- [ ] 在切换后的任何失败中恢复备份并重新验证旧版本。
- [ ] 运行 `bash tests/test-deploy-production.sh`，确认通过。

### Task 3: 移除迁移触发链路并更新文档

**Files:**
- Modify: `.github/workflows/deploy-production.yml`
- Delete: `scripts/migrate-production-layout.sh`
- Rewrite: `docs/production-deployment.md`
- Modify: `package.json`
- Modify: `tests/test-workflow-remote-command.sh`
- Modify: `tests/test-deployment-assets.sh`
- Modify: `tests/test-production-deployment-runbook.sh`

- [ ] 确认工作流把下载后的脚本直接用于现有生产目录。
- [ ] 删除首次迁移、release/current/shared 和 marker 的代码与说明。
- [ ] 更新测试入口，确保仓库不再依赖迁移脚本。

### Task 4: 验证、合并与生产验收

**Files:**
- Verify only

- [ ] 运行 `npm run test:deployment`、`npm run build`、`actionlint`、`bash -n scripts/*.sh` 和 `git diff --check`。
- [ ] 创建并合并 PR，等待 `Deploy production` Actions 完成。
- [ ] 只读验证生产目录、五个 PM2 进程、本机首页、公网页面和服务器数据文件仍存在。
