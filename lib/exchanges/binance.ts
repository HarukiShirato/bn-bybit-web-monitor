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
  hasFundingData?: boolean; // 是否拿到 funding/premium 数据
  hasOpenInterestData?: boolean; // 是否拿到 OI 数据
  isTradFi?: boolean; // TRADIFI_PERPETUAL：股票/商品类永续
}

const BINANCE_API_BASE = 'https://fapi.binance.com';

/**
 * 获取 Binance 永续合约列表
 */
async function getBinanceSymbols(): Promise<{symbol: string, fundingIntervalHours: number, isTradFi: boolean}[]> {
  try {
    const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/exchangeInfo`);
    return response.data.symbols
      .filter((s: any) =>
        // TRADIFI_PERPETUAL 是股票/商品类永续（NVDA、TSLA、XAU…），同样是永续合约
        (s.contractType === 'PERPETUAL' || s.contractType === 'TRADIFI_PERPETUAL') &&
        s.status === 'TRADING' &&
        s.symbol.endsWith('USDT') // 只保留USDT交易对
      )
      .map((s: any) => ({
        symbol: s.symbol,
        // 如果没有 fundingIntervalHours，默认 8 小时
        fundingIntervalHours: s.fundingIntervalHours || 8,
        isTradFi: s.contractType === 'TRADIFI_PERPETUAL',
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
    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async (symbol) => {
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/fundingRate`, {
            params: { symbol, limit: 2 },
            timeout: 5000,
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
          // 静默失败，使用默认值
        }
        return { symbol, intervalHours: 8 };
      });

      const results = await Promise.all(promises);
      results.forEach(({ symbol, intervalHours }) => {
        intervalMap.set(symbol, intervalHours);
      });

      if (i + batchSize < symbols.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    const batchSize = 25;
    const delayBetweenBatches = 100;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async ({symbol}) => {
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/openInterest`, {
            params: { symbol },
            timeout: 5000,
          });

          const contracts = parseFloat(response.data.openInterest || '0');
          const markPrice = markPrices.get(symbol) || 0;
          const value = contracts * markPrice;

          return { symbol, contracts, value };
        } catch (error) {
          return null;
        }
      });

      const results = await Promise.all(promises);
      results.forEach(result => {
        if (result) {
          oiMap.set(result.symbol, { contracts: result.contracts, value: result.value });
        }
      });

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
  const symbolSet = new Set(symbols.map((item) => item.symbol));

  try {
    const batchSize = 20;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async ({symbol}) => {
        if (fundMap.has(symbol)) {
          return null;
        }
        try {
          const response = await axios.get(`${BINANCE_API_BASE}/fapi/v1/insuranceBalance`, {
            params: { symbol },
            timeout: 5000,
          });

          const poolSymbols = Array.isArray(response.data?.symbols)
            ? response.data.symbols
            : [symbol];
          const usdtAsset = response.data?.assets?.find((a: any) => a.asset === 'USDT');
          const fundBalance = parseFloat(usdtAsset?.marginBalance || '0');
          return { poolSymbols, balance: fundBalance };
        } catch (error) {
          return { poolSymbols: [symbol], balance: 0 };
        }
      });

      const results = await Promise.all(promises);
      results.forEach(result => {
        if (!result) return;
        result.poolSymbols
          .filter((poolSymbol: string) => symbolSet.has(poolSymbol))
          .forEach((poolSymbol: string) => {
            fundMap.set(poolSymbol, result.balance);
          });
      });

      if (i + batchSize < symbols.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return fundMap;
  } catch (error) {
    console.error('Failed to fetch Binance insurance fund:', error);
    return new Map();
  }
}

export async function getBinancePerps(): Promise<BinancePerpData[]> {
  try {
    // 第一阶段：并行获取基础数据（symbols、premiumIndex、ticker）
    const [symbolsData, premiumIndexMap, ticker24hMap] = await Promise.all([
      getBinanceSymbols(),
      getBinancePremiumIndex(),
      getBinance24hrTicker(),
    ]);

    // 提取 markPrices（OI 计算需要）
    const markPricesForOi = new Map<string, number>();
    premiumIndexMap.forEach((value, key) => {
      markPricesForOi.set(key, value.markPrice);
    });
    ticker24hMap.forEach((value, key) => {
      if (!markPricesForOi.has(key)) {
        markPricesForOi.set(key, value.lastPrice);
      }
    });

    const symbolList = symbolsData.map((item) => item.symbol);

    // 第二阶段：并行获取 FundingIntervals、OI、InsuranceFund（关键优化！）
    const [computedIntervals, openInterest, insuranceFund] = await Promise.all([
      getBinanceFundingIntervals(symbolList),
      getBinanceOpenInterest(symbolsData, markPricesForOi),
      getBinanceInsuranceFund(symbolsData),
    ]);

    const results: BinancePerpData[] = [];

    for (const {symbol, fundingIntervalHours, isTradFi} of symbolsData) {
      const premiumData = premiumIndexMap.get(symbol);
      const tickerData = ticker24hMap.get(symbol);

      // 至少需要价格数据（premium 或 ticker）才展示
      if (!premiumData && !tickerData) continue;

      const oi = openInterest.get(symbol);
      const fund = insuranceFund.get(symbol) || 0;

      const intervalHours =
        computedIntervals.get(symbol) ??
        fundingIntervalHours ??
        8;

      results.push({
        symbol,
        markPrice: premiumData?.markPrice ?? tickerData?.lastPrice ?? 0,
        lastPrice: tickerData?.lastPrice ?? premiumData?.markPrice ?? 0,
        openInterest: oi?.contracts ?? 0,
        openInterestValue: oi?.value ?? 0,
        insuranceFund: fund,
        volume24h: tickerData?.quoteVolume ?? 0,
        fundingRate: premiumData?.fundingRate ?? 0,
        nextFundingTime: premiumData?.nextFundingTime ?? 0,
        fundingIntervalHours: intervalHours,
        hasFundingData: !!premiumData,
        hasOpenInterestData: !!oi,
        isTradFi,
      });
    }

    return results;
  } catch (error) {
    console.error('获取 Binance 数据失败:', error);
    return [];
  }
}
