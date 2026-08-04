# GitHub OIDC 部署角色设置

以下命令仅供具备 AWS IAM 管理权限的人工操作员执行；本仓库的自动化不会创建、修改或删除 AWS 资源。请在仓库根目录执行，并确认当前 AWS CLI 身份属于账户 `890742583014`。

工作流中的 `actions/checkout`、`actions/setup-node` 与 `aws-actions/configure-aws-credentials` 均固定到完整 commit SHA；升级时必须人工审阅官方 release 对应 commit，再同时更新 workflow 与契约测试，不能改回可变 tag。

```bash
aws sts get-caller-identity
```

## 1. 创建或确认 GitHub OIDC Provider

先确认 Provider 是否已经存在。若不存在，再创建它；audience 必须是 `sts.amazonaws.com`。

```bash
aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::890742583014:oidc-provider/token.actions.githubusercontent.com \
  || aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

## 2. 创建 GitHub 部署角色

角色 `GitHubActionsPerpDashboardDeployRole` 的信任策略严格限定为仓库 `HarukiShirato/real-time-monitoring-for-perpetual-contracts` 的 `master` 分支。

```bash
aws iam create-role \
  --role-name GitHubActionsPerpDashboardDeployRole \
  --assume-role-policy-document file://ops/aws/github-oidc-trust-policy.json
```

若角色已经存在，先检查其信任策略与 `github-oidc-trust-policy.json` 完全一致，而不是创建第二个角色。

## 3. 绑定最小 SSM 权限

先从 `ops/aws/perp-dashboard-deploy-document.yml` 创建自定义 Document `PerpDashboardDeploy`。该 Document 只有一个满足 40 位十六进制正则的 `CommitSha` 参数，并固定调用 root-owned wrapper；完成一次人工 bootstrap 后才能启用 workflow。

```bash
aws ssm create-document --region ap-northeast-1 --name PerpDashboardDeploy --document-type Command --content file://ops/aws/perp-dashboard-deploy-document.yml
```

内联策略只允许向 `i-0d3456ec595259c39` 使用这个自定义 Document，明确不允许 `AWS-RunShellScript`，以及读取/取消该次命令。

```bash
aws iam put-role-policy \
  --role-name GitHubActionsPerpDashboardDeployRole \
  --policy-name GitHubActionsPerpDashboardDeploy \
  --policy-document file://ops/aws/github-deploy-permissions.json
```

## 4. 确认 EC2 已受 SSM 管理

```bash
aws ssm describe-instance-information \
  --region ap-northeast-1 \
  --filters Key=InstanceIds,Values=i-0d3456ec595259c39
```

输出必须包含目标实例，且 `PingStatus` 为 `Online`。若没有，请先在该实例上修复 SSM Agent 和实例角色；不要扩大 GitHub 部署角色的权限范围。

## 5. 无副作用地验证配置

不要为了探针临时授权任意 shell。只读确认目标实例在线、自定义 Document 内容正确、IAM policy 精确匹配：

```bash
aws ssm get-document --region ap-northeast-1 --name PerpDashboardDeploy
aws iam get-role-policy --role-name GitHubActionsPerpDashboardDeployRole --policy-name GitHubActionsPerpDashboardDeploy
```

输出必须只有 `CommitSha` 参数，策略资源只能是自定义 Document 与目标 instance。随后才允许用无业务变更的已审查 commit 做首次端到端部署。
