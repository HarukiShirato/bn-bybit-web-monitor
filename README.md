# 永续合约数据仪表盘

一个用于展示 Binance 和 Bybit 永续合约数据的 Web 仪表盘应用。

## 功能特性

- 📊 **实时数据展示**：从 Binance 和 Bybit 获取永续合约实时数据
- 🔍 **多维度过滤**：支持按交易所、币对名称、OI 量、保险基金比例等条件过滤
- 📈 **数据排序**：支持按任意列进行升序/降序排序
- 💰 **市值信息**：集成 CoinGecko API 获取币种市值和 FDV 数据
- 🔄 **自动刷新**：每 60 秒自动刷新数据，支持手动刷新
- 🎨 **现代化 UI**：使用 Tailwind CSS 构建的简洁美观界面

## 技术栈

- **框架**: Next.js 14 (App Router)
- **语言**: TypeScript
- **样式**: Tailwind CSS
- **HTTP 客户端**: Axios

## 数据字段说明

### OI (Open Interest)
- **定义**: 未平仓合约数量，单位为张数（contracts）
- **名义价值**: OI 量 × 标记价格，单位为 USDT

### 保险基金 (Insurance Fund)
- **定义**: 交易所用于覆盖穿仓损失的保险基金余额
- **单位**: USDT
- **来源**: 各交易所公开 API（部分交易所可能不直接提供，代码中已做相应处理）

### 保险基金/OI 比例
- **计算方式**: (保险基金余额 / OI 名义价值) × 100%
- **意义**: 反映交易所风险覆盖能力

### 市值 (Market Cap) 和 FDV
- **来源**: CoinGecko API
- **单位**: USD
- **说明**: 如果币种无法映射或查不到数据，显示为 `—`

## 项目结构

```
.
├── app/
│   ├── api/
│   │   └── perps/
│   │       └── route.ts          # API 路由，聚合所有数据
│   ├── globals.css               # 全局样式
│   ├── layout.tsx                # 根布局
│   └── page.tsx                  # 主页面
├── components/
│   ├── ExchangeFilter.tsx        # 交易所筛选组件
│   ├── FilterControls.tsx        # 数值过滤控件
│   ├── PerpTable.tsx             # 数据表格组件
│   └── SearchBox.tsx             # 搜索框组件
├── lib/
│   ├── exchanges/
│   │   ├── binance.ts            # Binance API 封装
│   │   └── bybit.ts              # Bybit API 封装
│   └── marketData.ts             # 市值数据获取模块
├── package.json
├── tsconfig.json
├── tailwind.config.js
└── README.md
```

## 安装与运行

### 前置要求

- Node.js 18+ 
- npm 或 yarn

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

应用将在 `http://localhost:3000` 启动。

### 生产构建

```bash
npm run build
npm start
```

## 生产部署

生产环境的代码唯一来源是 GitHub `master`：对该分支的任何 push（包括直接 push 和 PR 合并）都会触发 GitHub Actions，经过构建和部署契约检查后，通过 AWS SSM 发布到 EC2。正常协作应先经 PR 审查再合并；不要直接在 EC2 或本地生产副本修改代码并把它当作发布版本。任何保留的现场改动只可审计，不能自动并回 `master`。

生产环境变量和运行时数据不属于代码发布物，固定存放在 `shared/` 下，并由每个 release 以符号链接复用。完整的正常发布、故障排查和紧急回退步骤见 [生产部署运行手册](docs/production-deployment.md)。

## 环境变量

当前版本无需配置环境变量。所有 API 调用均使用公开接口，无需 API Key。

## API 说明

### 数据源

1. **Binance API**
   - 基础 URL: `https://fapi.binance.com`
   - 使用公开 REST API，无需认证

2. **Bybit API**
   - 基础 URL: `https://api.bybit.com`
   - 使用公开 REST API，无需认证

3. **CoinGecko API**
   - 基础 URL: `https://api.coingecko.com/api/v3`
   - 用于获取市值和 FDV 数据
   - 免费版有速率限制，代码中已实现缓存机制

### 内部 API

- `GET /api/perps`: 获取所有永续合约数据
  - 返回格式: `{ success: boolean, data: PerpData[], timestamp: number }`

## 注意事项

1. **保险基金数据**: 部分交易所可能不直接提供每个合约的保险基金余额。代码中已做相应处理，缺失数据将显示为 0 或 `—`。

2. **API 速率限制**: 
   - CoinGecko 免费版有速率限制，代码中实现了 60 秒缓存机制
   - 如遇到限制，建议增加缓存时间或使用付费 API

3. **币种映射**: 市值数据需要将合约符号（如 `BTCUSDT`）映射到 CoinGecko 的币种 ID。代码中已包含常见币种的映射，如需支持更多币种，可在 `lib/marketData.ts` 中扩展 `SYMBOL_TO_COINGECKO_ID` 映射表。

4. **数据准确性**: 本工具仅用于数据展示，不构成投资建议。实际交易请以交易所官方数据为准。

## 开发说明

### 添加新交易所

1. 在 `lib/exchanges/` 目录下创建新的交易所模块
2. 实现数据获取函数，返回统一的数据格式
3. 在 `app/api/perps/route.ts` 中集成新交易所
4. 在 `app/page.tsx` 的交易所列表中添加新选项

### 自定义样式

修改 `tailwind.config.js` 或直接在组件中使用 Tailwind 类名进行样式调整。

## 许可证

MIT
