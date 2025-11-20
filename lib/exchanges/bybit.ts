import axios from 'axios';

/**
 * Bybit 永续合约数据接口
 * 
 * 数据字段说明：
 * - OI (Open Interest): 未平仓合约数量，单位为张数（contracts）
 * - Insurance Fund: 保险基金余额，单位为 USDT
 */

export interface BybitPerpData {
  symbol: string; // 合约符号，如 BTCUSDT
  markPrice: number; // 标记价格
  lastPrice: number; // 最新成交价
  openInterest: number; // 未平仓量（张数）
  openInterestValue: number; // 未平仓名义价值（USDT）
  insuranceFund: number; // 保险基金余额（USDT）
  volume24h: number; // 24小时成交额 (USDT)
  fundingRate: number; // 资金费率
  nextFundingTime: number; // 下次资金费率结算时间 (timestamp)
  fundingIntervalHours: number; // 资金费率结算间隔（小时）
}

const BYBIT_API_BASE = 'https://api.bybit.com';

/**
 * 获取 Bybit 永续合约数据
 */
export async function getBybitPerps(): Promise<BybitPerpData[]> {
  try {
    // 获取合约信息
    const instrumentsResponse = await axios.get(`${BYBIT_API_BASE}/v5/market/instruments-info`, {
      params: {
        category: 'linear',
        limit: 1000,
      },
    });

    const symbolsData = instrumentsResponse.data.result.list
      .filter((item: any) => 
        item.status === 'Trading' &&
        item.symbol.endsWith('USDT') // 只保留USDT交易对
      )
      .map((item: any) => ({
        symbol: item.symbol,
        fundingInterval: parseInt(item.fundingInterval || '480'), // 分钟，默认 8 小时 (480 min)
      }));

    if (symbolsData.length === 0) {
      return [];
    }
    
    // 提取纯 symbol 数组用于后续查询
    const symbols = symbolsData.map((s: any) => s.symbol);

    // 获取标记价格、资金费率、成交量等
    const tickersResponse = await axios.get(`${BYBIT_API_BASE}/v5/market/tickers`, {
      params: {
        category: 'linear',
        limit: 1000,
      },
    });

    const tickersMap = new Map<string, any>();
    tickersResponse.data.result.list.forEach((item: any) => {
      tickersMap.set(item.symbol, item);
    });

    // 获取未平仓量
    // Bybit v5 API: GET /v5/market/open-interest
    // 需要为每个 symbol 单独请求，获取最新的 OI 数据
    // 参考: https://bybit-exchange.github.io/docs/v5/market/open-interest
    const oiMap = new Map<string, { contracts: number; value: number }>();
    
    // 批量获取 OI 数据，平衡速度和速率限制
    // Bybit API 限制：每秒最多 10 次请求
    const batchSize = 15; // 增加批次大小到 15
    const delayBetweenBatches = 200; // 减少延迟到 200ms
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchPromises = batch.map(async (symbol: string) => {
        try {
          // 获取最新的 OI 数据（使用 5min 间隔，获取最新一条）
          const response = await axios.get(`${BYBIT_API_BASE}/v5/market/open-interest`, {
            params: {
              category: 'linear',
              symbol: symbol,
              intervalTime: '5min',
              limit: 1,
            },
          });

          if (response.data.retCode === 0 && response.data.result.list.length > 0) {
            const latestOi = response.data.result.list[0];
            // Bybit 返回的 openInterest 单位：
            // - linear 合约（如 BTCUSDT）是 BTC 数量
            // - 需要转换为 USDT 名义价值
            const oiInBaseCurrency = parseFloat(latestOi.openInterest || '0');
            const markPrice = parseFloat(tickersMap.get(symbol)?.markPrice || '0');
            const value = oiInBaseCurrency * markPrice; // 转换为 USDT 名义价值
            const contracts = oiInBaseCurrency; // 对于 linear 合约，OI 本身就是基础币数量（可视为张数）
            
            return { symbol, contracts, value };
          }
          return null;
        } catch (error) {
          console.error(`获取 ${symbol} OI 失败:`, error);
          return null;
        }
      });
      
      // 等待当前批次完成
      const batchResults = await Promise.all(batchPromises);
      batchResults.forEach(result => {
        if (result) {
          oiMap.set(result.symbol, { contracts: result.contracts, value: result.value });
        }
      });
      
      // 批次之间添加延迟（最后一个批次不需要延迟）
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }

    // 获取保险基金余额
    // Bybit v5 API: GET /v5/market/insurance
    // 参考: https://bybit-exchange.github.io/docs/v5/market/insurance
    // 返回格式: { "retCode": 0, "retMsg": "OK", "result": { "list": [{ "coin": "USDT", "symbols": "BTCUSDT,ETHUSDT", "balance": "...", "value": "..." }] } }
    // symbols 字段是逗号分隔的字符串，表示共享同一个保险池的合约
    // 注意：每个 symbol 应该显示整个池的余额，而不是平均分配
    const insuranceFundMap = new Map<string, number>();
    
    try {
      // 获取 USDT 保险基金数据
      const insuranceResponse = await axios.get(`${BYBIT_API_BASE}/v5/market/insurance`, {
        params: {
          coin: 'USDT',
        },
      });

      if (insuranceResponse.data.retCode === 0 && insuranceResponse.data.result?.list) {
        const insuranceList = insuranceResponse.data.result.list;
        
        // 遍历每个保险池
        insuranceList.forEach((pool: any) => {
          const balance = parseFloat(pool.balance || '0');
          const symbolsStr = pool.symbols || '';
          
          if (balance > 0 && symbolsStr) {
            // symbols 是逗号分隔的字符串，如 "BTCUSDT,ETHUSDT,SOLUSDT"
            const poolSymbols = symbolsStr.split(',').map((s: string) => s.trim());
            
            // 每个 symbol 显示整个池的余额（因为它们共享同一个保险池）
            poolSymbols.forEach((symbol: string) => {
              // 如果该 symbol 已经在我们的列表中，则设置保险基金余额
              if (symbols.includes(symbol)) {
                // 如果该 symbol 已经有保险基金余额，取最大值（某些 symbol 可能在多个池中，取最大的）
                const currentBalance = insuranceFundMap.get(symbol) || 0;
                insuranceFundMap.set(symbol, Math.max(currentBalance, balance));
              }
            });
          }
        });
      }
    } catch (error) {
      console.error('获取 Bybit 保险基金余额失败:', error);
      // 如果失败，继续使用空 Map
    }

    const results: BybitPerpData[] = [];

    for (const {symbol, fundingInterval} of symbolsData) {
      const ticker = tickersMap.get(symbol);
      if (!ticker) continue;

      const markPrice = parseFloat(ticker.markPrice || '0');
      const lastPrice = parseFloat(ticker.lastPrice || '0');
      const oi = oiMap.get(symbol);
      const fund = insuranceFundMap.get(symbol) || 0;

      if (oi && (markPrice > 0 || lastPrice > 0)) {
        results.push({
          symbol,
          markPrice,
          lastPrice,
          openInterest: oi.contracts,
          openInterestValue: oi.value,
          insuranceFund: fund,
          volume24h: parseFloat(ticker.turnover24h || '0'), // Bybit linear turnover is Quote Volume (USDT)
          fundingRate: parseFloat(ticker.fundingRate || '0'),
          nextFundingTime: parseInt(ticker.nextFundingTime || '0'),
          fundingIntervalHours: fundingInterval / 60
        });
      }
    }

    return results;
  } catch (error) {
    console.error('获取 Bybit 数据失败:', error);
    return [];
  }
}
