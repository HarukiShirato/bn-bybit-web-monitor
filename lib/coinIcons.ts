import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * 币种图标兜底源：Binance 公开资产表（1000+ 币，无需 key）。
 * CoinGecko 免费额度会 429，很多合约因此拿不到图标；这里按 base symbol 补一层。
 * 结果缓存在内存 + data/coin-icons.json，上游挂了就继续用旧文件。
 */
const BINANCE_ASSETS_URL =
  'https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset';

const CACHE_FILE = path.join(process.cwd(), 'data', 'coin-icons.json');
const TTL_MS = 24 * 60 * 60 * 1000;

let memo: { map: Map<string, string>; ts: number } | null = null;

/** 合约符号 -> 币种 base，取不到图标的（指数、builder dex 股票）返回 null */
export function baseOfSymbol(symbol: string): string | null {
  if (!symbol) return null;
  // HL builder dex（xyz:NVDA）是股票/指数，交易所资产表里没有
  if (symbol.includes(':')) return null;

  let s = symbol.toUpperCase();
  s = s.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, '');
  // 1000SHIB / 1000000MOG 这类倍数合约，只剥 10 的整次幂，别把 1INCH 剥成 INCH
  const m = s.match(/^(1000|10000|100000|1000000)([A-Z0-9]+)$/);
  if (m) s = m[2];
  return s || null;
}

function readCache(): { map: Map<string, string>; ts: number } | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (!raw?.icons) return null;
    return { map: new Map(Object.entries(raw.icons as Record<string, string>)), ts: raw.ts || 0 };
  } catch {
    return null;
  }
}

function writeCache(map: Map<string, string>) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), icons: Object.fromEntries(map) }));
  } catch (e: any) {
    console.error('[coinIcons] write cache failed:', e.message);
  }
}

export async function getCoinIconMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (memo && now - memo.ts < TTL_MS) return memo.map;

  const cached = readCache();
  if (cached && now - cached.ts < TTL_MS) {
    memo = cached;
    return cached.map;
  }

  try {
    const res = await axios.get(BINANCE_ASSETS_URL, { timeout: 15000 });
    const list = res.data?.data;
    if (!Array.isArray(list) || list.length === 0) throw new Error('empty asset list');

    const map = new Map<string, string>();
    for (const a of list) {
      const code = String(a?.assetCode || '').toUpperCase();
      const url = a?.logoUrl;
      if (code && url) map.set(code, url);
    }

    memo = { map, ts: now };
    writeCache(map);
    console.log(`[coinIcons] ${map.size} icons from Binance asset list`);
    return map;
  } catch (e: any) {
    console.error('[coinIcons] fetch failed, falling back to cache:', e.message);
    // 上游挂了就用过期缓存，总比没图标强
    if (cached) {
      memo = { map: cached.map, ts: now - TTL_MS + 60 * 60 * 1000 }; // 一小时后重试
      return cached.map;
    }
    return new Map();
  }
}

/**
 * 第三层：CoinCap 的静态图标地址，纯拼接不发请求。
 * 命中不了的会 404，前端 img onError 会降级成首字母方块，所以这里不预校验
 * （几百个 symbol 逐个 HEAD 太慢，而 404 响应只有 153 字节且浏览器会缓存）。
 */
function coinCapIcon(base: string): string {
  return `https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`;
}

/** 给一批合约符号补图标；已有图标的不动 */
export async function fillMissingIcons(
  symbols: string[]
): Promise<Map<string, string>> {
  const icons = await getCoinIconMap();
  const out = new Map<string, string>();
  for (const sym of symbols) {
    const base = baseOfSymbol(sym);
    if (!base) continue;
    out.set(sym, icons.get(base) || coinCapIcon(base));
  }
  return out;
}
