import fs from 'fs';
import path from 'path';

/**
 * 各交易所每个合约的 7 日资金费年化，数据源是采集器落盘的 funding-history.json。
 * 该文件 20MB+，每小时才重写一次，所以按 mtime 缓存解析结果，只留算好的数值。
 */
const DATA_FILE = path.join(process.cwd(), 'data', 'funding-history.json');

const EXCHANGE_KEYS: Record<string, string> = {
  Binance: 'binance',
  Bybit: 'bybit',
  OKX: 'okx',
  Hyperliquid: 'hyperliquid',
  Aster: 'aster',
};

const WINDOW_DAYS = 7;
const MIN_COVERAGE_DAYS = 1; // 覆盖不足一天的不给数，避免噪声被年化放大

let cache: { mtimeMs: number; map: Map<string, number> } | null = null;

interface Point { time: number; rate: number }

function ratesOf(entry: unknown): Point[] {
  if (Array.isArray(entry)) return entry as Point[];
  // bybit 存成 { intervalHours, rates }
  const rates = (entry as { rates?: Point[] })?.rates;
  return Array.isArray(rates) ? rates : [];
}

/** key 形如 `Binance:BTCUSDT`，值是百分比年化 */
export function get7dAprMap(): Map<string, number> {
  try {
    const stat = fs.statSync(DATA_FILE);
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.map;

    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const now = Date.now();
    const cutoff = now - WINDOW_DAYS * 86400000;
    const map = new Map<string, number>();

    for (const [exchange, storeKey] of Object.entries(EXCHANGE_KEYS)) {
      const bucket = raw?.[storeKey];
      if (!bucket) continue;

      for (const [symbol, entry] of Object.entries(bucket)) {
        const pts = ratesOf(entry).filter(p => p && p.time >= cutoff);
        if (pts.length === 0) continue;

        let sum = 0;
        let first = Infinity;
        for (const p of pts) {
          sum += p.rate;
          if (p.time < first) first = p.time;
        }

        // 实际覆盖天数，不足 7 天就按真实跨度折算，别把短历史当成整周
        const covered = (now - Math.max(first, cutoff)) / 86400000;
        if (covered < MIN_COVERAGE_DAYS) continue;

        map.set(`${exchange}:${symbol}`, (sum / covered) * 365 * 100);
      }
    }

    cache = { mtimeMs: stat.mtimeMs, map };
    console.log(`[funding7d] ${map.size} contracts`);
    return map;
  } catch (e: any) {
    console.error('[funding7d] failed:', e.message);
    return cache?.map ?? new Map();
  }
}
