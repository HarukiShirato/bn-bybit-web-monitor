import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * OKX 永续合约数据接口
 * - tickers + open-interest 批量获取价格和 OI
 * - funding rate 从采集器数据文件读取最新值
 * - 逐个请求 funding-rate API 太慢（282个），改为读文件
 */

export interface OkxPerpData {
  symbol: string;
  instId: string;
  markPrice: number;
  lastPrice: number;
  openInterest: number;
  openInterestValue: number;
  insuranceFund: number;
  volume24h: number;
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHours: number;
  hasFundingData?: boolean;
  hasOpenInterestData?: boolean;
}

const OKX_API_BASE = 'https://www.okx.com';

function instIdToSymbol(instId: string): string {
  const parts = instId.split('-');
  if (parts.length >= 2) {
    return parts[0] + parts[1];
  }
  return instId;
}

/**
 * 从 funding-history.json 读取 OKX 最新 funding rate
 */
function getLatestFundingRates(): Map<string, { rate: number; time: number }> {
  const result = new Map<string, { rate: number; time: number }>();
  try {
    const dataFile = path.join(process.cwd(), 'data', 'funding-history.json');
    if (!fs.existsSync(dataFile)) return result;
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    const okxData = raw.okx || {};
    for (const [symbol, rates] of Object.entries(okxData)) {
      if (Array.isArray(rates) && rates.length > 0) {
        const latest = rates[rates.length - 1] as { time: number; rate: number };
        result.set(symbol, { rate: latest.rate, time: latest.time });
      }
    }
  } catch (e) {
    // silent
  }
  return result;
}

export async function getOkxPerps(): Promise<OkxPerpData[]> {
  try {
    // 批量获取 tickers 和 OI
    const [tickersRes, oiRes] = await Promise.all([
      axios.get(`${OKX_API_BASE}/api/v5/market/tickers`, {
        params: { instType: 'SWAP' },
        timeout: 15000,
      }),
      axios.get(`${OKX_API_BASE}/api/v5/public/open-interest`, {
        params: { instType: 'SWAP' },
        timeout: 15000,
      }),
    ]);

    // 获取 funding rate 历史数据（top 20 按 OI 从文件读取，其余也从文件）
    const fundingRates = getLatestFundingRates();

    // 构建 tickers map
    const tickersMap = new Map<string, any>();
    if (tickersRes.data?.data) {
      for (const item of tickersRes.data.data) {
        if (item.instId.endsWith('-USDT-SWAP')) {
          tickersMap.set(item.instId, item);
        }
      }
    }

    // 构建 OI map
    const oiMap = new Map<string, any>();
    if (oiRes.data?.data) {
      for (const item of oiRes.data.data) {
        if (item.instId.endsWith('-USDT-SWAP')) {
          oiMap.set(item.instId, item);
        }
      }
    }

    // 对 top 20 OI 合约，实时请求 funding rate（并发，速度快）
    const oiEntries: { instId: string; oiValue: number }[] = [];
    for (const [instId, ticker] of tickersMap) {
      const oi = oiMap.get(instId);
      const price = parseFloat(ticker.last || '0');
      const oiCcy = oi ? parseFloat(oi.oiCcy || '0') : 0;
      oiEntries.push({ instId, oiValue: oiCcy * price });
    }
    oiEntries.sort((a, b) => b.oiValue - a.oiValue);
    const top20 = oiEntries.slice(0, 20).map(e => e.instId);

    // 并发请求 top 20 的实时 funding rate
    const liveFunding = new Map<string, { rate: number; nextTime: number; interval: number }>();
    const fundingPromises = top20.map(async (instId) => {
      try {
        const res = await axios.get(`${OKX_API_BASE}/api/v5/public/funding-rate`, {
          params: { instId },
          timeout: 5000,
        });
        const data = res.data?.data?.[0];
        if (data) {
          let interval = 8;
          if (data.fundingTime && data.nextFundingTime) {
            const ft = parseInt(data.fundingTime);
            const nft = parseInt(data.nextFundingTime);
            if (ft > 0 && nft > ft) {
              const diffH = Math.round((nft - ft) / 3600000);
              if (diffH >= 1 && diffH <= 24) interval = diffH;
            }
          }
          liveFunding.set(instId, {
            rate: parseFloat(data.fundingRate || '0'),
            nextTime: parseInt(data.nextFundingTime || '0'),
            interval,
          });
        }
      } catch {
        // silent
      }
    });
    await Promise.all(fundingPromises);

    const results: OkxPerpData[] = [];

    for (const [instId, ticker] of tickersMap) {
      const oi = oiMap.get(instId);
      const lastPrice = parseFloat(ticker.last || '0');
      const oiCcy = oi ? parseFloat(oi.oiCcy || '0') : 0;
      const oiValue = oiCcy * lastPrice;
      const vol24h = parseFloat(ticker.volCcy24h || '0') * lastPrice;
      const symbol = instIdToSymbol(instId);

      // 优先用实时数据，否则用文件数据
      const live = liveFunding.get(instId);
      const fileFunding = fundingRates.get(symbol);
      
      let fundingRate = 0;
      let nextFundingTime = 0;
      let fundingIntervalHours = 8;
      let hasFundingData = false;

      if (live) {
        fundingRate = live.rate;
        nextFundingTime = live.nextTime;
        fundingIntervalHours = live.interval;
        hasFundingData = true;
      } else if (fileFunding) {
        fundingRate = fileFunding.rate;
        hasFundingData = true;
      }

      results.push({
        symbol,
        instId,
        markPrice: lastPrice,
        lastPrice,
        openInterest: oiCcy,
        openInterestValue: oiValue,
        insuranceFund: 0,
        volume24h: vol24h,
        fundingRate,
        nextFundingTime,
        fundingIntervalHours,
        hasFundingData,
        hasOpenInterestData: !!oi && oiCcy > 0,
      });
    }

    console.log(`[okx] Fetched ${results.length} perp pairs (${liveFunding.size} live funding, ${fundingRates.size} from file)`);
    return results;
  } catch (error) {
    console.error('获取 OKX 数据失败:', error);
    return [];
  }
}
