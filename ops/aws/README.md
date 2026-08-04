# GitHub OIDC 部署角色设置

以下命令仅供具备 AWS IAM 管理权限的人工操作员执行；本仓库的自动化不会创建、修改或删除 AWS 资源。请在仓库根目录执行，并确认当前 AWS CLI 身份属于账户 `890742583014`。

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

此内联策略只允许向 `i-0d3456ec595259c39` 使用 `AWS-RunShellScript`，以及读取该实例命令的结果。它还包含 `ssm:CancelCommand`：AWS 的服务授权参考没有为该操作定义可放进 IAM `Resource` 的资源类型，因此这个单独语句必须使用 `"Resource": "*"`。工作流只会对它刚刚捕获的 `CommandId` 调用取消，并且同时传入该目标实例 ID；这使超时或 GitHub Actions 被取消时，SSM 会终止远端 shell，让部署脚本的 `EXIT` 回滚处理运行。

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

## 5. 发送无副作用的连通性验证

下面完整命令只输出 `ssm-ready`，不修改服务器文件或服务。它会捕获本次 `CommandId`，等待该实例上的同一命令完成，再读取并核验该命令的状态和标准输出：

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

两个断言均成立时，探针成功。这一步完成后，GitHub Actions 才可以用 OIDC 获得短期凭证并调用受限的 SSM 命令。
