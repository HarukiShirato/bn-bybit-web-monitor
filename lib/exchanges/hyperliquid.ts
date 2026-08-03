import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Hyperliquid 永续合约数据接口
 * 主路径：metaAndAssetCtxs 一次拿全量 markPrice / OI / 24h 成交额 / 当前资金费。
 * 除主 dex 外还遍历 HIP-3 builder dex（xyz / para / mkts / hyna …），
 * 这些 dex 上是股票、指数、商品等 RWA 合约，必须带 dex 参数单独查询。
 * API 挂掉时回落到 funding-history.json（采集器持续在写），此时仅有 fundingRate。
 * insuranceFund HL 未公开，恒为 0。
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
  /** builder dex 名（xyz / para / …）；主 dex 为空 */
  dex?: string;
}

// HL 资金费率结算间隔（小时）。HL 每小时整点结算一次。
const HL_FUNDING_INTERVAL_HOURS = 1;

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

/** 下一个整点结算时刻 */
function nextHourlyFunding(): number {
  return Math.ceil(Date.now() / 3600000) * 3600000;
}

/** kPEPE -> PEPE，其余原样返回 */
function normalizeCoin(coin: string): string {
  if (coin.startsWith('k') && coin.length > 1 && coin[1] === coin[1].toUpperCase()) {
    return coin.substring(1);
  }
  return coin;
}

async function hlPost(body: Record<string, unknown>, timeout = 15000) {
  const res = await axios.post(HL_INFO_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout,
  });
  return res.data;
}

/** 回落路径：只从采集器文件里读最新费率 */
function readFromFile(): HyperliquidPerpData[] {
  try {
    const dataFile = path.join(process.cwd(), 'data', 'funding-history.json');
    if (!fs.existsSync(dataFile)) return [];
    const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    const hlData = raw.hyperliquid || {};

    const results: HyperliquidPerpData[] = [];
    for (const [symbol, rates] of Object.entries(hlData)) {
      if (!Array.isArray(rates) || rates.length === 0) continue;
      const latest = rates[rates.length - 1] as { time: number; rate: number };
      results.push({
        symbol,
        markPrice: 0,
        lastPrice: 0,
        openInterest: 0,
        openInterestValue: 0,
        insuranceFund: 0,
        volume24h: 0,
        fundingRate: latest.rate,
        nextFundingTime: latest.time + HL_FUNDING_INTERVAL_HOURS * 3600 * 1000,
        fundingIntervalHours: HL_FUNDING_INTERVAL_HOURS,
        hasFundingData: true,
        hasOpenInterestData: false,
        dex: symbol.includes(':') ? symbol.split(':')[0] : undefined,
      });
    }
    return results;
  } catch (e) {
    console.error('[hyperliquid] read funding-history.json failed:', e);
    return [];
  }
}

/**
 * 拉取一个 dex 的全量合约。
 * dex 为空 = 主 dex，symbol 归一为 XXXUSDT；
 * builder dex 保留 HL 原始命名（xyz:NVDA），前端据此区分。
 */
async function fetchDex(dex: string): Promise<HyperliquidPerpData[]> {
  const body: Record<string, unknown> = { type: 'metaAndAssetCtxs' };
  if (dex) body.dex = dex;

  const data = await hlPost(body);
  const meta = data?.[0];
  const ctxs = data?.[1];
  if (!meta?.universe || !Array.isArray(ctxs)) {
    throw new Error(`metaAndAssetCtxs 格式异常 (dex=${dex || 'main'})`);
  }

  const nextFundingTime = nextHourlyFunding();
  const results: HyperliquidPerpData[] = [];

  for (let i = 0; i < meta.universe.length; i++) {
    const m = meta.universe[i];
    if (m.isDelisted) continue;
    const ctx = ctxs[i];
    if (!ctx) continue;

    const markPx = parseFloat(ctx.markPx || '0');
    const midPx = parseFloat(ctx.midPx || '0');
    const oiQty = parseFloat(ctx.openInterest || '0');
    const oiValue = oiQty > 0 && markPx > 0 ? oiQty * markPx : 0;

    // builder dex 里有大量挂着没量的僵尸合约，只保留真正有 OI 的
    if (dex && oiValue <= 0) continue;

    results.push({
      symbol: dex ? m.name : normalizeCoin(m.name) + 'USDT',
      markPrice: markPx,
      lastPrice: midPx || markPx,
      openInterest: oiQty,
      openInterestValue: oiValue,
      insuranceFund: 0,
      volume24h: parseFloat(ctx.dayNtlVlm || '0'),
      fundingRate: parseFloat(ctx.funding || '0'),
      nextFundingTime,
      fundingIntervalHours: HL_FUNDING_INTERVAL_HOURS,
      hasFundingData: true,
      hasOpenInterestData: oiValue > 0,
      dex: dex || undefined,
    });
  }

  return results;
}

/** builder dex 名单，取不到就只跑主 dex */
async function listBuilderDexs(): Promise<string[]> {
  try {
    const data = await hlPost({ type: 'perpDexs' }, 10000);
    if (!Array.isArray(data)) return [];
    return data.filter((d: any) => d?.name).map((d: any) => d.name as string);
  } catch (e: any) {
    console.error('[hyperliquid] perpDexs 失败，仅采主 dex:', e.message);
    return [];
  }
}

export async function getHyperliquidPerps(): Promise<HyperliquidPerpData[]> {
  const builderDexs = await listBuilderDexs();
  const targets = ['', ...builderDexs];

  const settled = await Promise.allSettled(targets.map(d => fetchDex(d)));

  const results: HyperliquidPerpData[] = [];
  const failed: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      results.push(...r.value);
    } else {
      failed.push(targets[i] || 'main');
      console.error(`[hyperliquid] dex=${targets[i] || 'main'} 拉取失败:`, r.reason?.message);
    }
  });

  // 主 dex 失败（数组首位）意味着核心数据缺失，回落读文件
  if (settled[0].status === 'rejected') {
    console.error('[hyperliquid] 主 dex 失败，回落读文件');
    return readFromFile();
  }
  if (results.length === 0) return readFromFile();

  const dexCount = new Set(results.filter(r => r.dex).map(r => r.dex)).size;
  console.log(
    `[hyperliquid] ${results.length} symbols (主 dex + ${dexCount} builder dex), ` +
    `${results.filter(r => r.hasOpenInterestData).length} with OI` +
    (failed.length ? `, 失败: ${failed.join(',')}` : '')
  );
  return results;
}
