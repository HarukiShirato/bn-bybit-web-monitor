import fs from "fs";
import path from "path";

const DATA_FILE = path.join(process.cwd(), "data", "arbitrage-data.json");
const FILE_CACHE_TTL = 60 * 1000; // re-read file every 60s

export interface ArbitrageInfo {
  asset: string;
  investAmount: number;
  swapToken: string;
  swapAmount: number;
  redeemAmount: number;
  profit: number;
  apr: number; // decimal, e.g. 0.104 = 10.4%
  redeemDays: number;
  officialRate?: number;
  updatedAt: number;
}

let cache: { data: Map<string, ArbitrageInfo>; ts: number } | null = null;

/**
 * Read arbitrage data from data/arbitrage-data.json
 * (written by scripts/arbitrage-collector.js every 8 hours)
 * Returns Map<asset, ArbitrageInfo>
 */
export async function getArbitrageMap(): Promise<Map<string, ArbitrageInfo>> {
  if (cache && Date.now() - cache.ts < FILE_CACHE_TTL) return cache.data;

  const result = new Map<string, ArbitrageInfo>();
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      for (const [key, val] of Object.entries(raw)) {
        if (key === "collectedAt") continue;
        const entry = val as ArbitrageInfo;
        if (entry.apr > 0 && entry.asset) {
          result.set(entry.asset, entry);
        }
      }
      console.log(`[arbitrage] Loaded ${result.size} arbitrage rates from file`);
    }
  } catch (e: any) {
    console.error(`[arbitrage] Failed to read arbitrage data: ${e.message}`);
  }

  cache = { data: result, ts: Date.now() };
  return result;
}
