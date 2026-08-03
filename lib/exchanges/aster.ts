import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Aster 永续合约数据接口
 *
 * Aster 的 fapi 与 Binance fapi 格式兼容，但没有批量 OI 端点
 * （/fapi/v1/openInterest 强制要求 symbol），逐 symbol 拉会触发
 * CloudFront WAF 的频率封禁。因此这里只打 2 个批量请求
 * （exchangeInfo 走缓存），OI 由 funding-collector 每小时慢速采集
 * 后写入 funding-history.json 的 asterOI 字段，本模块直接读文件。
 */

export interface AsterPerpData {
  symbol: string; // 合约符号，如 BTCUSDT
  markPrice: number; // 标记价格
  lastPrice: number; // 最新成交价
  openInterest: number; // 未平仓量（张数）
  openInterestValue: number; // 未平仓名义价值（USDT）
  insuranceFund: number; // 保险基金余额（USDT）—— Aster 未公开，恒为 0
  volume24h: number; // 24小时成交额 (USDT)
  fundingRate: number; // 资金费率
  nextFundingTime: number; // 下次资金费率结算时间 (timestamp)
  fundingIntervalHours: number; // 资金费率结算间隔（小时）
  hasFundingData?: boolean;
  hasOpenInterestData?: boolean;
}

const ASTER_API_BASE = 'https://fapi.asterdex.com';

/** exchangeInfo 缓存（合约列表变动很慢，1 小时足够） */
const EXCHANGE_INFO_TTL = 60 * 60 * 1000;
let cachedSymbols: { list: string[]; timestamp: number } | null = null;

/**
 * 获取 Aster USDT 永续合约列表
 * 只保留 PERPETUAL + TRADING + USDT 计价（排除 SETTLING / PENDING_TRADING
 * 以及 USD1、U 等其他计价的合约）
 */
async function getAsterSymbols(): Promise<string[]> {
  if (cachedSymbols && Date.now() - cachedSymbols.timestamp < EXCHANGE_INFO_TTL) {
    return cachedSymbols.list;
  }
  try {
    const res = await axios.get(`${ASTER_API_BASE}/fapi/v1/exchangeInfo`, { timeout: 20000 });
    const list = (res.data?.symbols || [])
      .filter((s: any) =>
        s.contractType === 'PERPETUAL' &&
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT'
      )
      .map((s: any) => s.symbol as string);
    cachedSymbols = { list, timestamp: Date.now() };
    return list;
  } catch (error: any) {
    console.error('[aster] exchangeInfo 失败:', error.message);
    // 拿不到就沿用上一次的结果，避免整表消失
    return cachedSymbols?.list || [];
  }
}

/** 从 funding-collector 落盘的数据里读 OI（USDT 名义价值）与结算间隔 */
function readAsterFileData(): {
  oi: Record<string, { value: number; qty: number }>;
  intervals: Record<string, number>;
} {
  const empty = { oi: {}, intervals: {} };
  try {
    const dataFile = path.join(process.cwd(), 'data', 'funding-history.json');
    if (!fs.existsSync(dataFile)) return empty;
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    const oi = raw.asterOI || {};
    const intervals: Record<string, number> = {};
    for (const [symbol, rates] of Object.entries(raw.aster || {})) {
      if (!Array.isArray(rates) || rates.length < 2) continue;
      const diffs: number[] = [];
      for (let i = rates.length - 1; i > 0 && diffs.length < 5; i--) {
        const d = ((rates[i] as any).time - (rates[i - 1] as any).time) / 3600000;
        if (d > 0) diffs.push(d);
      }
      if (diffs.length === 0) continue;
      diffs.sort((a, b) => a - b);
      const median = diffs[Math.floor(diffs.length / 2)];
      intervals[symbol] = median <= 1.5 ? 1 : median <= 3 ? 2 : median <= 6 ? 4 : 8;
    }
    return { oi, intervals };
  } catch (e: any) {
    console.error('[aster] 读取 funding-history.json 失败:', e.message);
    return empty;
  }
}

/**
 * 获取 Aster 永续合约数据
 * 实时字段（价格/资金费/成交额）走批量接口，OI 走文件
 */
export async function getAsterPerps(): Promise<AsterPerpData[]> {
  try {
    const symbols = await getAsterSymbols();
    if (symbols.length === 0) return [];
    const symbolSet = new Set(symbols);

    const [premiumRes, tickerRes] = await Promise.all([
      axios.get(`${ASTER_API_BASE}/fapi/v1/premiumIndex`, { timeout: 20000 }).catch((e) => {
        console.error('[aster] premiumIndex 失败:', e.message);
        return null;
      }),
      axios.get(`${ASTER_API_BASE}/fapi/v1/ticker/24hr`, { timeout: 20000 }).catch((e) => {
        console.error('[aster] ticker/24hr 失败:', e.message);
        return null;
      }),
    ]);

    const premiumMap = new Map<string, { markPrice: number; fundingRate: number; nextFundingTime: number }>();
    if (Array.isArray(premiumRes?.data)) {
      for (const item of premiumRes!.data) {
        if (!symbolSet.has(item.symbol)) continue;
        premiumMap.set(item.symbol, {
          markPrice: parseFloat(item.markPrice || '0'),
          fundingRate: parseFloat(item.lastFundingRate || '0'),
          nextFundingTime: parseInt(item.nextFundingTime || '0'),
        });
      }
    }

    const tickerMap = new Map<string, { lastPrice: number; volume24h: number }>();
    if (Array.isArray(tickerRes?.data)) {
      for (const item of tickerRes!.data) {
        if (!symbolSet.has(item.symbol)) continue;
        tickerMap.set(item.symbol, {
          lastPrice: parseFloat(item.lastPrice || '0'),
          volume24h: parseFloat(item.quoteVolume || '0'),
        });
      }
    }

    // premiumIndex 全挂时不要返回一堆全 0 的行，直接判定本轮失败
    if (premiumMap.size === 0) {
      console.error('[aster] premiumIndex 无有效数据，跳过本轮');
      return [];
    }

    const { oi: fileOI, intervals } = readAsterFileData();

    const results: AsterPerpData[] = [];
    for (const symbol of symbols) {
      const premium = premiumMap.get(symbol);
      const ticker = tickerMap.get(symbol);
      const oiEntry = fileOI[symbol];
      const markPrice = premium?.markPrice ?? 0;
      const lastPrice = ticker?.lastPrice ?? 0;

      results.push({
        symbol,
        markPrice,
        lastPrice,
        openInterest: oiEntry?.qty ?? 0,
        openInterestValue: oiEntry?.value ?? 0,
        insuranceFund: 0,
        volume24h: ticker?.volume24h ?? 0,
        fundingRate: premium?.fundingRate ?? 0,
        nextFundingTime: premium?.nextFundingTime ?? 0,
        fundingIntervalHours: intervals[symbol] ?? 8,
        hasFundingData: premium != null,
        hasOpenInterestData: oiEntry != null && oiEntry.value > 0,
      });
    }

    console.log(`[aster] ${results.length} symbols, ${results.filter(r => r.hasOpenInterestData).length} with OI`);
    return results;
  } catch (error: any) {
    console.error('[aster] 获取永续数据失败:', error.message);
    return [];
  }
}
