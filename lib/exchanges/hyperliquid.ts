import fs from 'fs';
import path from 'path';

/**
 * Hyperliquid 永续合约数据接口
 * 最小实现：仅从 funding-history.json 读取最新 fundingRate，
 * 不调用 HL info API（funding-collector 已在持续采集）。
 * mark price / OI / volume / insurance fund 全部留空。
 */
export interface HyperliquidPerpData {
  symbol: string;
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

// HL 资金费率结算间隔（小时）。HL 每小时结算一次。
const HL_FUNDING_INTERVAL_HOURS = 1;

export async function getHyperliquidPerps(): Promise<HyperliquidPerpData[]> {
  try {
    const dataFile = path.join(process.cwd(), 'data', 'funding-history.json');
    if (!fs.existsSync(dataFile)) return [];
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    const hlData = raw.hyperliquid || {};

    const results: HyperliquidPerpData[] = [];
    for (const [symbol, rates] of Object.entries(hlData)) {
      if (!Array.isArray(rates) || rates.length === 0) continue;
      const latest = rates[rates.length - 1] as { time: number; rate: number };
      const nextFundingTime = latest.time + HL_FUNDING_INTERVAL_HOURS * 3600 * 1000;
      results.push({
        symbol,
        markPrice: 0,
        lastPrice: 0,
        openInterest: 0,
        openInterestValue: 0,
        insuranceFund: 0,
        volume24h: 0,
        fundingRate: latest.rate,
        nextFundingTime,
        fundingIntervalHours: HL_FUNDING_INTERVAL_HOURS,
        hasFundingData: true,
        hasOpenInterestData: false,
      });
    }
    return results;
  } catch (e) {
    console.error('[hyperliquid] read funding-history.json failed:', e);
    return [];
  }
}
