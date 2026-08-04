import fs from 'fs';
import path from 'path';

/**
 * 每个合约在多个回看窗口下的资金费年化，数据源同样是采集器落盘的 funding-history.json。
 *
 * 与 funding7d.ts 的区别：那个只出 7d 单值供 perps 表用，这里一次算好 3d / 7d 供持仓表用。
 * 文件 20MB+ 且每小时才重写，所以照同样的路子按 mtime 缓存解析结果。
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
const MIN_COVERAGE_RATIO = 0.5; // 窗口内实际覆盖不足一半就不给数，别把半天历史当成一周

export interface FundingWindows {
  apr3d: number | null;
  apr7d: number | null;
}

let cache: { mtimeMs: number; map: Map<string, FundingWindows> } | null = null;

interface Point { time: number; rate: number }

function ratesOf(entry: unknown): Point[] {
  if (Array.isArray(entry)) return entry as Point[];
  // bybit 存成 { intervalHours, rates }
  const rates = (entry as { rates?: Point[] })?.rates;
  return Array.isArray(rates) ? rates : [];
}

/**
 * 结算间隔由相邻点的时间差推出来，不写死 8h。
 * 取中位数是为了躲开补采造成的异常间隔。
 */
function inferIntervalHours(pts: Point[], fallback: number): number {
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
        const all = ratesOf(entry)
          .filter(p => p && typeof p.time === 'number' && typeof p.rate === 'number')
          .sort((a, b) => a.time - b.time);
        if (all.length < 2) continue;

        const declared = (entry as { intervalHours?: number })?.intervalHours;
        const intervalHours = inferIntervalHours(all, declared || 8);
        const cyclesPerDay = intervalHours > 0 ? 24 / intervalHours : 3;

        const out: FundingWindows = { apr3d: null, apr7d: null };

        for (const days of WINDOWS) {
          const cutoff = now - days * 86400000;
          const pts = all.filter(p => p.time >= cutoff);
          if (!pts.length) continue;

          // 覆盖不足窗口的一半就跳过，避免用极短历史外推出离谱年化
          const covered = (now - pts[0].time) / 86400000;
          if (covered < days * MIN_COVERAGE_RATIO) continue;

          const avg = pts.reduce((s, p) => s + p.rate, 0) / pts.length;
          const apr = avg * cyclesPerDay * 365 * 100;
          if (days === 3) out.apr3d = apr;
          else out.apr7d = apr;
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
