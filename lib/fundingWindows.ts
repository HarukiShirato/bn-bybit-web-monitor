import fs from 'fs';
import path from 'path';

/**
 * 每个合约在多个回看窗口下的资金费年化，数据源同样是采集器落盘的 funding-history.json。
 *
 * 一次算好 3d / 7d，perps 表和持仓表共用同一套口径。
 * 文件 20MB+ 且每小时才重写，所以按 mtime 缓存解析结果。
 */
const DATA_FILE = path.join(process.cwd(), 'data', 'funding-history.json');

const EXCHANGE_KEYS: Record<string, string> = {
  Binance: 'binance',
  Bybit: 'bybit',
  OKX: 'okx',
  Hyperliquid: 'hyperliquid',
  Aster: 'aster',
};

const WINDOWS = [3, 7] as const;
/** 窗口内实际覆盖不足一半就不给数，别把半天历史当成一周 */
export const MIN_COVERAGE_RATIO = 0.5;

export interface FundingWindows {
  apr3d: number | null;
  apr7d: number | null;
}

let cache: { mtimeMs: number; map: Map<string, FundingWindows> } | null = null;

export interface Point { time: number; rate: number }

function ratesOf(entry: unknown): Point[] {
  if (Array.isArray(entry)) return entry as Point[];
  // bybit 存成 { intervalHours, rates }
  const rates = (entry as { rates?: Point[] })?.rates;
  return Array.isArray(rates) ? rates : [];
}

/**
 * 结算间隔由相邻点的时间差推出来，不写死 8h。
 * 取中位数是为了躲开补采造成的异常间隔。
 *
 * 只在传进来的这批点上推断：交易所改过结算频率（1h→4h 这类）时，
 * 全历史的中位数会停在旧频率上，拿它去年化最近几天必然错几倍。
 */
export function inferIntervalHours(pts: Point[], fallback: number): number {
  if (pts.length < 3) return fallback;
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = (pts[i].time - pts[i - 1].time) / 3600000;
    if (gap > 0.1 && gap < 48) gaps.push(gap);
  }
  if (!gaps.length) return fallback;
  gaps.sort((a, b) => a - b);
  const mid = gaps[Math.floor(gaps.length / 2)];
  return mid > 0 ? mid : fallback;
}

/**
 * 单个窗口的资金费年化，返回**小数**（0.05 = 5%），数据不够就 null。
 *
 * 口径：窗口内费率之和 ÷ 实际覆盖小时数 × 8760。
 * 不用"点均值 × 每日结算次数"，因为那要求先猜准结算间隔，猜错就是成倍的误差；
 * 求和除以真实时长对间隔变更、采集缺口、混合间隔都免疫，间隔只用来补
 * 第一个点自己代表的那一期，最多差一期。
 */
export function windowApr(
  points: Point[],
  days: number,
  opts: { declaredIntervalHours?: number; minCoverageRatio?: number; now?: number } = {}
): number | null {
  const now = opts.now ?? Date.now();
  const minRatio = opts.minCoverageRatio ?? MIN_COVERAGE_RATIO;
  const cutoff = now - days * 86400000;

  const pts = points
    .filter(p => p && typeof p.time === 'number' && typeof p.rate === 'number' && p.time >= cutoff)
    .sort((a, b) => a.time - b.time);
  if (pts.length < 2) return null;

  // 覆盖不足窗口的一半就跳过，避免用极短历史外推出离谱年化
  const coveredDays = (now - pts[0].time) / 86400000;
  if (coveredDays < days * minRatio) return null;

  const intervalHours = inferIntervalHours(pts, opts.declaredIntervalHours || 8);
  const spanHours = (pts[pts.length - 1].time - pts[0].time) / 3600000 + intervalHours;
  if (spanHours <= 0) return null;

  const sum = pts.reduce((s, p) => s + p.rate, 0);
  return (sum / spanHours) * 8760;
}

/** key 形如 `Binance:BTCUSDT`，值是各窗口的百分比年化（市场费率，未按持仓方向取号） */
export function getFundingWindowMap(): Map<string, FundingWindows> {
  try {
    const stat = fs.statSync(DATA_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.map;

    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const now = Date.now();
    const map = new Map<string, FundingWindows>();

    for (const [exchange, storeKey] of Object.entries(EXCHANGE_KEYS)) {
      const bucket = raw?.[storeKey];
      if (!bucket) continue;

      for (const [symbol, entry] of Object.entries(bucket)) {
        const all = ratesOf(entry);
        if (all.length < 2) continue;

        const declared = (entry as { intervalHours?: number })?.intervalHours;
        const out: FundingWindows = { apr3d: null, apr7d: null };

        for (const days of WINDOWS) {
          const apr = windowApr(all, days, { declaredIntervalHours: declared, now });
          if (apr === null) continue;
          if (days === 3) out.apr3d = apr * 100;
          else out.apr7d = apr * 100;
        }

        if (out.apr3d !== null || out.apr7d !== null) {
          map.set(`${exchange}:${symbol}`, out);
        }
      }
    }

    cache = { mtimeMs: stat.mtimeMs, map };
    return map;
  } catch (e: any) {
    console.error('[fundingWindows] 解析失败:', e.message);
    return cache?.map ?? new Map();
  }
}
