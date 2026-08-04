import { NextResponse } from 'next/server';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const HL_HISTORY_HOURS = 200; // 与其它所的 limit=200 对齐

// perps 表里主 dex 的 symbol 被归一成 XXXUSDT（kPEPE -> PEPEUSDT），
// 查 HL 需要还原成原始 coin 名，用 meta 建映射，缓存 5 分钟。
let hlCoinMap: { map: Map<string, string>; ts: number } | null = null;

async function getHlCoinMap(): Promise<Map<string, string>> {
  if (hlCoinMap && Date.now() - hlCoinMap.ts < 5 * 60 * 1000) return hlCoinMap.map;
  const map = new Map<string, string>();
  try {
    const res = await axios.post(HL_INFO_URL, { type: 'meta' }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    for (const m of res.data?.universe || []) {
      const name: string = m.name;
      const normalized =
        name.startsWith('k') && name.length > 1 && name[1] === name[1].toUpperCase()
          ? name.substring(1)
          : name;
      map.set(normalized + 'USDT', name);
    }
    hlCoinMap = { map, ts: Date.now() };
  } catch (e: any) {
    console.error('[funding-history] HL meta failed:', e.message);
  }
  return map;
}

/* ── 响应缓存 ──
   资金费最快也要 1h 才结算一次，10 分钟内重复展开同一行没有新信息可拿，
   直接回缓存，省掉对交易所的重复请求（反复折叠/展开、多人同时看都只打一次）。
   拿到空数组则只缓存 1 分钟：那多半是交易所临时抽风，不该被钉住十分钟。 */
interface CacheEntry {
  data: { time: number; rate: number }[];
  constituents: any[];
  expires: number;
}

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;
const EMPTY_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 500; // HL builder dex 币种多，给个上限免得无界增长

function cacheGet(key: string): CacheEntry | null {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    CACHE.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key: string, data: any[], constituents: any[]) {
  // Map 迭代按插入序，最老的排在最前，超限就从头削
  if (CACHE.size >= MAX_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, {
    data,
    constituents,
    expires: Date.now() + (data.length ? TTL_MS : EMPTY_TTL_MS),
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const exchange = searchParams.get('exchange');

  if (!symbol || !exchange) {
    return NextResponse.json({ error: 'Missing symbol or exchange' }, { status: 400 });
  }

  const cacheKey = `${exchange}:${symbol}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return NextResponse.json({
      success: true,
      data: cached.data,
      constituents: cached.constituents,
      cached: true,
    });
  }

  try {
    let historyData: { time: number; rate: number }[] = [];
    let constituents: { exchange: string; symbol: string; price: number; weight: number }[] = [];

    if (exchange === 'Binance') {
      // Binance API: GET /fapi/v1/fundingRate
      // Returns latest funding rate history
      const response = await axios.get('https://www.binance.com/fapi/v1/fundingRate', {
        params: {
          symbol: symbol,
          limit: 200 // 7d × 24h/1h = 168, 需要至少 168 条
        }
      });
      
      historyData = response.data.map((item: any) => ({
        time: item.fundingTime,
        rate: parseFloat(item.fundingRate)
      }));

      try {
        const constituentsRes = await axios.get('https://www.binance.com/fapi/v1/constituents', {
          params: { symbol }
        });
        if (constituentsRes.data?.constituents) {
          constituents = constituentsRes.data.constituents.map((entry: any) => ({
            exchange: entry.exchange,
            symbol: entry.symbol,
            price: parseFloat(entry.price || '0'),
            weight: parseFloat(entry.weight || '0')
          }));
        }
      } catch (err) {
        console.error('Failed to fetch Binance constituents:', err);
      }

    } else if (exchange === 'Bybit') {
      // Bybit API: GET /v5/market/funding/history
      const response = await axios.get('https://api.bybit.com/v5/market/funding/history', {
        params: {
          category: 'linear',
          symbol: symbol,
          limit: 200
        }
      });

      if (response.data.retCode === 0 && response.data.result.list) {
        // Bybit returns data in reverse chronological order
        historyData = response.data.result.list.map((item: any) => ({
          time: parseInt(item.fundingRateTimestamp),
          rate: parseFloat(item.fundingRate)
        })).reverse();
      }

    } else if (exchange === 'OKX') {
      // OKX API: GET /api/v5/public/funding-rate-history
      // OKX uses instId format: BTC-USDT-SWAP
      // Convert BTCUSDT -> BTC-USDT-SWAP
      const base = symbol.replace(/USDT$/, '');
      const instId = base + '-USDT-SWAP';
      
      const response = await axios.get('https://www.okx.com/api/v5/public/funding-rate-history', {
        params: {
          instId,
          limit: 200,
        },
        timeout: 10000,
      });

      if (response.data?.data) {
        // OKX returns data in reverse chronological order
        historyData = response.data.data.map((item: any) => ({
          time: parseInt(item.fundingTime || 0),
          rate: parseFloat(item.realizedRate || item.fundingRate || 0),
        })).reverse();
      }
    } else if (exchange === 'Hyperliquid') {
      // HL: POST /info {type:'fundingHistory'}，每小时结算一次
      // builder dex（xyz:NVDA 等）symbol 本身就是 coin 名，主 dex 需还原 kXXX
      let coin = symbol;
      if (!symbol.includes(':')) {
        const map = await getHlCoinMap();
        coin = map.get(symbol) || symbol.replace(/USDT$/, '');
      }
      const startTime = Date.now() - HL_HISTORY_HOURS * 3600 * 1000;

      const response = await axios.post(HL_INFO_URL,
        { type: 'fundingHistory', coin, startTime },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );

      historyData = (response.data || []).map((item: any) => ({
        time: item.time,
        rate: parseFloat(item.fundingRate || '0'),
      }));

    } else if (exchange === 'Aster') {
      // Aster 没有公开的历史资金费接口，用采集器落盘的数据
      try {
        const file = path.join(process.cwd(), 'data', 'funding-history.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const entry = raw?.aster?.[symbol];
        const rates = Array.isArray(entry) ? entry : entry?.rates;
        if (Array.isArray(rates)) {
          historyData = rates
            .map((r: any) => ({ time: r.time, rate: r.rate }))
            .sort((a: any, b: any) => a.time - b.time)
            .slice(-200);
        }
      } catch (e: any) {
        console.error('[funding-history] Aster read failed:', e.message);
      }
    }

    cacheSet(cacheKey, historyData, constituents);
    return NextResponse.json({ success: true, data: historyData, constituents, cached: false });
  } catch (error) {
    // 失败不写缓存，下次请求照常重试
    console.error('Failed to fetch funding history:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}

