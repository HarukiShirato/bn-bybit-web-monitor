import axios from 'axios';

/**
 * Binance 永续合约数据接口
 * 
 * 数据字段说明：
 * - OI (Open Interest): 未平仓合约数量，单位为张数（contracts）
 * - Insurance Fund: 保险基金余额，单位为 USDT
 */

export interface BinancePerpData {
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

const BINANCE_API_BASE = 'https://fapi.binance.com';

/**
 * 获取 Binance 永续合约列表
 */
async function getBinanceSymbols(): Promise<{symbol: string, fundingIntervalHours: number}[]> {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/exchangeInfo`);
    return response.data.symbols
      .filter((s: any) => 
        s.contractType === 'PERPETUAL' && 
        s.status === 'TRADING' &&
        s.symbol.endsWith('USDT') // 只保留USDT交易对
      )
      .map((s: any) => ({
        symbol: s.symbol,
        // 如果没有 fundingIntervalHours，默认 8 小时
        fundingIntervalHours: s.fundingIntervalHours || 8
      }));
  } catch (error) {
    console.error('获取 Binance 合约列表失败:', error);
    return [];
  }
}

/**
 * 通过资金费率历史数据推断结算间隔
 */
async function getBinanceFundingIntervals(symbols: string[]): Promise<Map<string, number>> {
  const intervalMap = new Map<string, number>();

  try {
    const batchSize = 8;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async (symbol) => {
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/fundingRate`, {
            params: { symbol, limit: 2 },
          });
          const list = response.data;
          if (Array.isArray(list) && list.length >= 2) {
            const intervalMs = Math.abs(
              Number(list[0].fundingTime) - Number(list[1].fundingTime)
            );
            const intervalHours = Math.max(
              1,
              Math.round(intervalMs / (1000 * 60 * 60))
            );
            return { symbol, intervalHours };
          }
        } catch (err) {
          console.error(`获取 ${symbol} 资金费率历史失败:`, err);
        }
        return { symbol, intervalHours: 8 };
      });

      const results = await Promise.all(promises);
      results.forEach(({ symbol, intervalHours }) => {
        intervalMap.set(symbol, intervalHours);
      });

      if (i + batchSize < symbols.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } catch (error) {
    console.error('推断 Binance 资金间隔失败:', error);
  }

  return intervalMap;
}

/**
 * 获取 Binance 标记价格及资金费率信息
 */
async function getBinancePremiumIndex(): Promise<Map<string, { markPrice: number; fundingRate: number; nextFundingTime: number }>> {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/premiumIndex`);
    const data = new Map<string, { markPrice: number; fundingRate: number; nextFundingTime: number }>();
    response.data.forEach((item: any) => {
      data.set(item.symbol, {
        markPrice: parseFloat(item.markPrice),
        fundingRate: parseFloat(item.lastFundingRate),
        nextFundingTime: parseInt(item.nextFundingTime)
      });
    });
    return data;
  } catch (error) {
    console.error('获取 Binance Premium Index 失败:', error);
    return new Map();
  }
}

/**
 * 获取 Binance 24小时行情（包含价格和成交量）
 */
async function getBinance24hrTicker(): Promise<Map<string, { lastPrice: number; quoteVolume: number }>> {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/ticker/24hr`);
    const data = new Map<string, { lastPrice: number; quoteVolume: number }>();
    response.data.forEach((item: any) => {
      data.set(item.symbol, {
        lastPrice: parseFloat(item.lastPrice),
        quoteVolume: parseFloat(item.quoteVolume) // quoteVolume is USDT volume for USDT pairs
      });
    });
    return data;
  } catch (error) {
    console.error('获取 Binance 24hr Ticker 失败:', error);
    return new Map();
  }
}

/**
 * 获取 Binance 未平仓量
 */
async function getBinanceOpenInterest(symbols: {symbol: string}[], markPrices: Map<string, number>): Promise<Map<string, { contracts: number; value: number }>> {
  try {
    const oiMap = new Map<string, { contracts: number; value: number }>();
    
    // 批量获取 OI 数据，平衡速度和速率限制
    // Binance API 限制：每秒最多 10 次请求（权重限制）
    const batchSize = 15; 
    const delayBetweenBatches = 200; 
    
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async ({symbol}) => {
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/openInterest`, {
            params: { symbol }
          });
          
          // API 只返回 openInterest（张数），没有 openInterestValue
          const contracts = parseFloat(response.data.openInterest || '0');
          const markPrice = markPrices.get(symbol) || 0;
          // 计算名义价值：张数 × 标记价格
          const value = contracts * markPrice;
          
          return { symbol, contracts, value };
        } catch (error) {
          console.error(`获取 ${symbol} OI 失败:`, error);
          return null;
        }
      });
      
      const results = await Promise.all(promises);
      results.forEach(result => {
        if (result) {
          oiMap.set(result.symbol, { contracts: result.contracts, value: result.value });
        }
      });
      
      // 批次之间添加延迟（最后一个批次不需要延迟）
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
      }
    }
    
    return oiMap;
  } catch (error) {
    console.error('获取 Binance 未平仓量失败:', error);
    return new Map();
  }
}

/**
 * 获取 Binance 保险基金余额
 */
async function getBinanceInsuranceFund(symbols: {symbol: string}[]): Promise<Map<string, number>> {
  const fundMap = new Map<string, number>();

  try {
    // 为每个 symbol 单独查询保险基金余额
    // 批量处理，避免速率限制
    const batchSize = 10;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async ({symbol}) => {
        try {
          // 为每个 symbol 单独查询
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/insuranceBalance`, {
            params: { symbol }
          });

          // 如果返回的是对象格式（传了 symbol 时）
          if (response.data && response.data.assets) {
            const usdtAsset = response.data.assets.find((a: any) => a.asset === 'USDT');
            if (usdtAsset) {
              const fundBalance = parseFloat(usdtAsset.marginBalance || '0');
              return { symbol, balance: fundBalance };
            }
          }
          return { symbol, balance: 0 };
        } catch (error) {
          console.error(`获取 ${symbol} 保险基金余额失败:`, error);
          return { symbol, balance: 0 };
        }
      });

      const results = await Promise.all(promises);
      results.forEach(result => {
        fundMap.set(result.symbol, result.balance);
      });

      // 避免速率限制，批次之间添加延迟
      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return fundMap;
  } catch (error) {
    console.error('获取 Binance 保险基金余额失败:', error);
    return new Map();
  }
}

/**
 * 获取所有 Binance 永续合约数据
 */
export async function getBinancePerps(): Promise<BinancePerpData[]> {
  try {
    const [symbolsData, premiumIndexMap, ticker24hMap] = await Promise.all([
      getBinanceSymbols(),
      getBinancePremiumIndex(),
      getBinance24hrTicker(),
    ]);

    const symbolList = symbolsData.map((item) => item.symbol);
    const computedIntervals = await getBinanceFundingIntervals(symbolList);

    // 提取仅用于 OI 计算的 markPrices Map
    const markPricesForOi = new Map<string, number>();
    premiumIndexMap.forEach((value, key) => {
      markPricesForOi.set(key, value.markPrice);
    });

    // 获取 OI 数据需要 markPrices，所以在这里调用
    const openInterest = await getBinanceOpenInterest(symbolsData, markPricesForOi);
    
    // 获取保险基金数据需要 symbols，所以在这里调用
    const insuranceFund = await getBinanceInsuranceFund(symbolsData);

    const results: BinancePerpData[] = [];

    for (const {symbol, fundingIntervalHours} of symbolsData) {
      const premiumData = premiumIndexMap.get(symbol);
      const tickerData = ticker24hMap.get(symbol);
      
      if (!premiumData || !tickerData) continue;

      const oi = openInterest.get(symbol);
      const fund = insuranceFund.get(symbol) || 0;

      const intervalHours =
        computedIntervals.get(symbol) ??
        fundingIntervalHours ??
        8;

      if (oi) {
        results.push({
          symbol,
          markPrice: premiumData.markPrice,
          lastPrice: tickerData.lastPrice,
          openInterest: oi.contracts,
          openInterestValue: oi.value,
          insuranceFund: fund,
          volume24h: tickerData.quoteVolume,
          fundingRate: premiumData.fundingRate,
          nextFundingTime: premiumData.nextFundingTime,
          fundingIntervalHours: intervalHours
        });
      }
    }

    return results;
  } catch (error) {
    console.error('获取 Binance 数据失败:', error);
    return [];
  }
}
