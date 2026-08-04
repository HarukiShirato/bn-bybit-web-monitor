import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { windowApr } from './fundingWindows';

/**
 * 资金费率聚合器 v5
 * - 从 data/funding-history.json 读取后台采集器持续记录的费率数据
 * - Binance + Bybit 都从文件读取实际结算历史
 * - 正确处理 Bybit 不同结算间隔 (1h/4h/8h)
 * - 仍保留 bulk snapshot 用于 OI 数据
 */

export interface FundingStats {
  binance3d: number | null;
  binance7d: number | null;
  binance30d: number | null;
  bybit3d: number | null;
  bybit7d: number | null;
  bybit30d: number | null;
  hyperliquid3d: number | null;
  hyperliquid7d: number | null;
  hyperliquid30d: number | null;
  okx3d: number | null;
  okx7d: number | null;
  okx30d: number | null;
  aster3d: number | null;
  aster7d: number | null;
  aster30d: number | null;
}

const BINANCE_FAPI = 'https://www.binance.com';  // www proxy avoids 403
const BYBIT_API = 'https://api.bybit.com';
const ASTER_API = 'https://fapi.asterdex.com';
const DATA_FILE = path.join(process.cwd(), 'data', 'funding-history.json');

/* ── Types ── */
interface SettledRate { time: number; rate: number; }

interface FundingHistoryData {
  binance: Record<string, SettledRate[]>;
  bybit: Record<string, { intervalHours: number; rates: SettledRate[] }>;
  hyperliquid: Record<string, SettledRate[]>;
  okx: Record<string, SettledRate[]>;
  aster: Record<string, SettledRate[]>;
  asterOI: Record<string, { qty: number; value: number; time: number }>;
  updatedAt: number;
}

/* ── Snapshot for OI ── */
const SNAPSHOT_CACHE_TTL = 5 * 60 * 1000;
interface RateSnapshot {
  binance: Map<string, number>;
  bybit: Map<string, number>;
  hyperliquid: Map<string, number>;
  okx: Map<string, number>;
  aster: Map<string, number>;
  binanceOI: Map<string, number>;
  bybitOI: Map<string, number>;
  hyperliquidOI: Map<string, number>;
  okxOI: Map<string, number>;
  asterOI: Map<string, number>;
  binanceVol: Map<string, number>;
  bybitVol: Map<string, number>;
  hyperliquidVol: Map<string, number>;
  okxVol: Map<string, number>;
  asterVol: Map<string, number>;
  timestamp: number;
}

/* ── File data cache ── */
const FILE_CACHE_TTL = 60 * 1000; // 每分钟重新读取文件

interface Store {
  snapshot: RateSnapshot | null;
  fileData: FundingHistoryData | null;
  fileDataTs: number;
}

function getStore(): Store {
  const g = globalThis as any;
  if (!g.__fundingStore5) {
    g.__fundingStore5 = { snapshot: null, fileData: null, fileDataTs: 0 } as Store;
  }
  return g.__fundingStore5;
}

/* ── 读取采集器数据文件 ── */
function getFundingHistory(): FundingHistoryData | null {
  const store = getStore();
  if (store.fileData && Date.now() - store.fileDataTs < FILE_CACHE_TTL) {
    return store.fileData;
  }
  try {
    if (!fs.existsSync(DATA_FILE)) {
      console.log('[funding] data file not found:', DATA_FILE);
      return null;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw) as FundingHistoryData;
    store.fileData = data;
    store.fileDataTs = Date.now();
    return data;
  } catch (e: any) {
    console.error('[funding] Failed to read data file:', e.message);
    return null;
  }
}

/* ── Bulk snapshot: Binance ── */
async function fetchBinanceData(): Promise<{ rates: Map<string, number>; oi: Map<string, number>; vol: Map<string, number> }> {
  const rates = new Map<string, number>();
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  try {
    const res = await axios.get(`${BINANCE_FAPI}/fapi/v1/premiumIndex`, { timeout: 15000 });
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        rates.set(item.symbol, parseFloat(item.lastFundingRate || '0'));
      }
    }
    console.log(`[funding] Binance premiumIndex: ${rates.size} symbols`);
  } catch (e: any) {
    console.error(`[funding] Binance premiumIndex failed: ${e.message}`);
  }
  try {
    const tickerRes = await axios.get(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`, { timeout: 15000 });
    if (Array.isArray(tickerRes.data)) {
      for (const item of tickerRes.data) {
        const v = parseFloat(item.quoteVolume || '0');
        if (v > 0) vol.set(item.symbol, v);
      }
    }
  } catch (e: any) {
    console.error(`[funding] Binance ticker24hr failed: ${e.message}`);
  }
  return { rates, oi, vol };
}

/* ── Bulk snapshot: Bybit ── */
async function fetchBybitData(): Promise<{ rates: Map<string, number>; oi: Map<string, number>; vol: Map<string, number> }> {
  const rates = new Map<string, number>();
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  try {
    const res = await axios.get(`${BYBIT_API}/v5/market/tickers`, {
      params: { category: 'linear' },
      timeout: 15000,
    });
    const list = res.data?.result?.list;
    if (Array.isArray(list)) {
      for (const item of list) {
        rates.set(item.symbol, parseFloat(item.fundingRate || '0'));
        const oiValue = parseFloat(item.openInterestValue || '0');
        if (oiValue > 0) oi.set(item.symbol, oiValue);
        const volValue = parseFloat(item.turnover24h || '0');
        if (volValue > 0) vol.set(item.symbol, volValue);
      }
    }
    console.log(`[funding] Bybit tickers: ${rates.size} symbols, ${oi.size} with OI`);
  } catch (e: any) {
    console.error(`[funding] Bybit tickers failed: ${e.message}`);
  }
  return { rates, oi, vol };
}


/* ── Bulk snapshot: Hyperliquid ── */
async function fetchHyperliquidData(): Promise<{ rates: Map<string, number>; oi: Map<string, number>; vol: Map<string, number> }> {
  const rates = new Map<string, number>();
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  try {
    const res = await axios.post('https://api.hyperliquid.xyz/info',
      { type: 'metaAndAssetCtxs' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const meta = res.data[0];
    const ctxs = res.data[1];
    for (let i = 0; i < meta.universe.length; i++) {
      const m = meta.universe[i];
      if (m.isDelisted || m.maxLeverage <= 3) continue; // Skip HIP-3
      const coin = m.name;
      const ctx = ctxs[i];
      // Handle k-prefix: kPEPE -> PEPEUSDT
      let base = coin;
      if (coin.startsWith('k') && coin.length > 1 && coin[1] === coin[1].toUpperCase()) {
        base = coin.substring(1);
      }
      const symbol = base + 'USDT';
      rates.set(symbol, parseFloat(ctx.funding || '0'));
      const oiVal = parseFloat(ctx.openInterest || '0');
      const markPx = parseFloat(ctx.markPx || '0');
      if (oiVal > 0 && markPx > 0) oi.set(symbol, oiVal * markPx);
      const dayVol = parseFloat(ctx.dayNtlVlm || '0');
      if (dayVol > 0) vol.set(symbol, dayVol);
    }
    console.log(`[funding] Hyperliquid: ${rates.size} symbols, ${oi.size} with OI`);
  } catch (e: any) {
    console.error(`[funding] Hyperliquid fetch failed: ${e.message}`);
  }
  return { rates, oi, vol };
}


/* ── Bulk snapshot: OKX ── */
async function fetchOkxData(): Promise<{ rates: Map<string, number>; oi: Map<string, number>; vol: Map<string, number> }> {
  const rates = new Map<string, number>();
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  try {
    const [tickerRes, fundingRes, oiRes] = await Promise.all([
      axios.get('https://www.okx.com/api/v5/market/tickers', {
        params: { instType: 'SWAP' },
        timeout: 15000,
      }),
      axios.get('https://www.okx.com/api/v5/public/funding-rate', {
        params: { instId: 'BTC-USDT-SWAP' },  // just to get one sample; rates come from file
        timeout: 5000,
      }).catch(() => ({ data: { data: [] } })),
      axios.get('https://www.okx.com/api/v5/public/open-interest', {
        params: { instType: 'SWAP' },
        timeout: 15000,
      }),
    ]);

    // Build price map from tickers
    const priceMap = new Map<string, number>();
    if (tickerRes.data?.data) {
      for (const item of tickerRes.data.data) {
        if (!item.instId.endsWith('-USDT-SWAP')) continue;
        const base = item.instId.split('-')[0];
        const symbol = base + 'USDT';
        priceMap.set(symbol, parseFloat(item.last || '0'));
        const volCcy = parseFloat(item.volCcy24h || '0');
        const lastPx = parseFloat(item.last || '0');
        if (volCcy > 0 && lastPx > 0) vol.set(symbol, volCcy * lastPx);
      }
    }

    // Read funding rates from file (collector writes these)
    try {
      const dataFile = path.join(process.cwd(), 'data', 'funding-history.json');
      if (fs.existsSync(dataFile)) {
        const raw = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
        const okxHist = raw.okx || {};
        for (const [symbol, rateList] of Object.entries(okxHist)) {
          if (Array.isArray(rateList) && rateList.length > 0) {
            const latest = rateList[rateList.length - 1] as { rate: number };
            rates.set(symbol, latest.rate);
          }
        }
      }
    } catch {}

    // OI in USDT value
    if (oiRes.data?.data) {
      for (const item of oiRes.data.data) {
        if (!item.instId.endsWith('-USDT-SWAP')) continue;
        const base = item.instId.split('-')[0];
        const symbol = base + 'USDT';
        const oiCcy = parseFloat(item.oiCcy || '0');
        const price = priceMap.get(symbol) || 0;
        const oiValue = oiCcy * price;
        if (oiValue > 0) oi.set(symbol, oiValue);
      }
    }
    console.log(`[funding] OKX: ${rates.size} symbols, ${oi.size} with OI`);
  } catch (e: any) {
    console.error(`[funding] OKX fetch failed: ${e.message}`);
  }
  return { rates, oi, vol };
}

/* ── Bulk snapshot: Aster ──
 * 只打 2 个批量请求：premiumIndex（费率）+ ticker/24hr（成交额）。
 * Aster 没有批量 OI 端点，OI 由 funding-collector 每小时慢速采集后写文件，
 * 这里直接读，避免逐 symbol 请求触发 CloudFront WAF 的频率封禁。
 */
async function fetchAsterData(): Promise<{ rates: Map<string, number>; oi: Map<string, number>; vol: Map<string, number> }> {
  const rates = new Map<string, number>();
  const oi = new Map<string, number>();
  const vol = new Map<string, number>();
  try {
    const res = await axios.get(`${ASTER_API}/fapi/v1/premiumIndex`, { timeout: 15000 });
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        if (!item.symbol?.endsWith('USDT')) continue;
        rates.set(item.symbol, parseFloat(item.lastFundingRate || '0'));
      }
    }
  } catch (e: any) {
    console.error(`[funding] Aster premiumIndex failed: ${e.message}`);
  }
  try {
    const tickerRes = await axios.get(`${ASTER_API}/fapi/v1/ticker/24hr`, { timeout: 15000 });
    if (Array.isArray(tickerRes.data)) {
      for (const item of tickerRes.data) {
        if (!item.symbol?.endsWith('USDT')) continue;
        const v = parseFloat(item.quoteVolume || '0');
        if (v > 0) vol.set(item.symbol, v);
      }
    }
  } catch (e: any) {
    console.error(`[funding] Aster ticker24hr failed: ${e.message}`);
  }
  // OI 走采集器落盘的快照
  try {
    const histData = getFundingHistory();
    for (const [symbol, entry] of Object.entries(histData?.asterOI || {})) {
      const v = (entry as any)?.value;
      if (typeof v === 'number' && v > 0) oi.set(symbol, v);
    }
  } catch {}
  console.log(`[funding] Aster: ${rates.size} symbols, ${oi.size} with OI`);
  return { rates, oi, vol };
}

async function getLatestSnapshot(): Promise<RateSnapshot> {
  const store = getStore();
  if (store.snapshot && Date.now() - store.snapshot.timestamp < SNAPSHOT_CACHE_TTL) {
    return store.snapshot;
  }
  const [binanceData, bybitData, hlData, okxData, asterData] = await Promise.all([
    fetchBinanceData(),
    fetchBybitData(),
    fetchHyperliquidData(),
    fetchOkxData(),
    fetchAsterData(),
  ]);
  const snapshot: RateSnapshot = {
    binance: binanceData.rates,
    bybit: bybitData.rates,
    hyperliquid: hlData.rates,
    okx: okxData.rates,
    aster: asterData.rates,
    binanceOI: binanceData.oi,
    bybitOI: bybitData.oi,
    hyperliquidOI: hlData.oi,
    okxOI: okxData.oi,
    asterOI: asterData.oi,
    binanceVol: binanceData.vol,
    bybitVol: bybitData.vol,
    hyperliquidVol: hlData.vol,
    okxVol: okxData.vol,
    asterVol: asterData.vol,
    timestamp: Date.now(),
  };
  store.snapshot = snapshot;
  return snapshot;
}


/* ── 从结算数据计算年化 ──
 * 口径统一到 lib/fundingWindows：窗口内费率之和 ÷ 实际覆盖小时数 × 8760。
 * 旧实现是"点均值 × 24/结算间隔 × 365"，而间隔取自**最老的 6 个点**，
 * 交易所把结算频率从 1h 改成 4h（或反过来）之后，年化会差整整 4 倍。
 * declaredIntervalHours 只在窗口内点太少、推不出间隔时兜底。
 */
function calcAprFromSettled(
  rates: SettledRate[],
  days: number,
  declaredIntervalHours?: number
): number | null {
  return windowApr(rates, days, { declaredIntervalHours });
}

const EXCHANGE_1000X_ASSETS = new Set([
  'PEPE', 'BONK', 'SHIB', 'FLOKI', 'LUNC', 'SATS', 'RATS', 'CAT',
  'CHEEMS', 'MOGCOIN', 'WHY', 'X', 'APU',
]);

/** 批量获取资金费率 */
export async function batchGetFundingStats(assets: string[]): Promise<Map<string, FundingStats>> {
  const snapshot = await getLatestSnapshot();
  const histData = getFundingHistory();
  const result = new Map<string, FundingStats>();

  for (const a of assets) {
    const upper = a.toUpperCase();
    const is1000x = EXCHANGE_1000X_ASSETS.has(upper);
    const bnSymbol = is1000x ? `1000${upper}USDT` : `${upper}USDT`;
    const bySymbol = is1000x ? `1000${upper}USDT` : `${upper}USDT`;

    // Binance: 从文件读取实际结算历史
    let binance3d: number | null = null, binance7d: number | null = null, binance30d: number | null = null;
    const bnHist = histData?.binance?.[bnSymbol];
    if (bnHist && bnHist.length > 0) {
      binance3d = calcAprFromSettled(bnHist, 3);
      binance7d = calcAprFromSettled(bnHist, 7);
      binance30d = calcAprFromSettled(bnHist, 30);
    }

    // Bybit: 从文件读取实际结算历史
    let bybit3d: number | null = null, bybit7d: number | null = null, bybit30d: number | null = null;
    const byData = histData?.bybit?.[bySymbol];
    if (byData && byData.rates && byData.rates.length > 0) {
      const intervalH = byData.intervalHours || 8;
      bybit3d = calcAprFromSettled(byData.rates, 3, intervalH);
      bybit7d = calcAprFromSettled(byData.rates, 7, intervalH);
      bybit30d = calcAprFromSettled(byData.rates, 30, intervalH);
    }

    // Hyperliquid: 从文件读取，1h结算间隔
    let hyperliquid3d: number | null = null, hyperliquid7d: number | null = null, hyperliquid30d: number | null = null;
    const hlHist = histData?.hyperliquid?.[upper + 'USDT'];
    if (hlHist && hlHist.length > 0) {
      hyperliquid3d = calcAprFromSettled(hlHist, 3, 1);
      hyperliquid7d = calcAprFromSettled(hlHist, 7, 1);
      hyperliquid30d = calcAprFromSettled(hlHist, 30, 1);
    }


    // OKX: 从文件读取，默认 8h 结算间隔
    let okx3d: number | null = null, okx7d: number | null = null, okx30d: number | null = null;
    const okxHist = histData?.okx?.[upper + 'USDT'];
    if (okxHist && okxHist.length > 0) {
      okx3d = calcAprFromSettled(okxHist, 3);
      okx7d = calcAprFromSettled(okxHist, 7);
      okx30d = calcAprFromSettled(okxHist, 30);
    }

    // Aster: 从文件读取，结算间隔按币种检测（BTC 8h，部分小币 1h/4h）
    let aster3d: number | null = null, aster7d: number | null = null, aster30d: number | null = null;
    const asterHist = histData?.aster?.[bnSymbol];  // Aster 的 1000x 命名与 Binance 一致
    if (asterHist && asterHist.length > 0) {
      aster3d = calcAprFromSettled(asterHist, 3);
      aster7d = calcAprFromSettled(asterHist, 7);
      aster30d = calcAprFromSettled(asterHist, 30);
    }

    result.set(upper, { binance3d, binance7d, binance30d, bybit3d, bybit7d, bybit30d, hyperliquid3d, hyperliquid7d, hyperliquid30d, okx3d, okx7d, okx30d, aster3d, aster7d, aster30d });
  }

  const withData = [...result.values()].filter(s =>
    s.binance3d != null || s.binance7d != null || s.bybit3d != null || s.bybit7d != null
  ).length;
  const bnSymCount = histData ? Object.keys(histData.binance || {}).length : 0;
  const bySymCount = histData ? Object.keys(histData.bybit || {}).length : 0;
  const age = histData ? Math.round((Date.now() - (histData.updatedAt || 0)) / 1000) : -1;
  const hlSymCount = histData ? Object.keys(histData.hyperliquid || {}).length : 0;
  const astSymCount = histData ? Object.keys(histData.aster || {}).length : 0;
  console.log(`[funding] ${withData}/${result.size} have data (file: bn=${bnSymCount} by=${bySymCount} hl=${hlSymCount} ast=${astSymCount}, age=${age}s)`);
  return result;
}

export interface ExchangeVolume {
  binance: number;
  bybit: number;
  hyperliquid: number;
  okx: number;
  aster: number;
}

export async function getVolumeMap(assets: string[]): Promise<Map<string, ExchangeVolume>> {
  const snapshot = await getLatestSnapshot();
  const result = new Map<string, ExchangeVolume>();
  for (const a of assets) {
    const upper = a.toUpperCase();
    const is1000x = EXCHANGE_1000X_ASSETS.has(upper);
    const symbol = is1000x ? `1000${upper}USDT` : `${upper}USDT`;
    const binanceVol = snapshot.binanceVol.get(symbol) ?? 0;
    const bybitVol = snapshot.bybitVol.get(symbol) ?? 0;
    const hlVol = snapshot.hyperliquidVol.get(symbol) ?? 0;
    const okxVol = snapshot.okxVol.get(symbol) ?? 0;
    const asterVol = snapshot.asterVol.get(symbol) ?? 0;
    if (binanceVol > 0 || bybitVol > 0 || hlVol > 0 || okxVol > 0 || asterVol > 0) {
      result.set(upper, { binance: binanceVol, bybit: bybitVol, hyperliquid: hlVol, okx: okxVol, aster: asterVol });
    }
  }
  return result;
}

export interface ExchangeOI {
  binance: number;
  bybit: number;
  hyperliquid: number;
  okx: number;
  aster: number;
}

/**
 * 获取各交易所 OI 数据（USDT 计价）
 */
export async function getOpenInterestMap(assets: string[]): Promise<Map<string, ExchangeOI>> {
  const snapshot = await getLatestSnapshot();
  const result = new Map<string, ExchangeOI>();

  // Read Binance OI from staking-rewards.json (collected every 8h)
  let fileBinanceOI: Record<string, number> = {};
  try {
    const stakingFile = path.join(process.cwd(), 'data', 'staking-rewards.json');
    if (fs.existsSync(stakingFile)) {
      const raw = JSON.parse(fs.readFileSync(stakingFile, 'utf-8'));
      fileBinanceOI = raw.binanceOI || {};
    }
  } catch {}

  for (const a of assets) {
    const upper = a.toUpperCase();
    const is1000x = EXCHANGE_1000X_ASSETS.has(upper);
    const symbol = is1000x ? `1000${upper}USDT` : `${upper}USDT`;
    const binanceOI = fileBinanceOI[symbol] ?? snapshot.binanceOI.get(symbol) ?? 0;
    const bybitOI = snapshot.bybitOI.get(symbol) ?? 0;
    const hlOI = snapshot.hyperliquidOI.get(symbol) ?? 0;
    const okxOI = snapshot.okxOI.get(symbol) ?? 0;
    const asterOI = snapshot.asterOI.get(symbol) ?? 0;
    if (binanceOI > 0 || bybitOI > 0 || hlOI > 0 || okxOI > 0 || asterOI > 0) {
      result.set(upper, { binance: binanceOI, bybit: bybitOI, hyperliquid: hlOI, okx: okxOI, aster: asterOI });
    }
  }

  return result;
}
