import { NextResponse } from 'next/server';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
// 各所统一按 31 天拉历史，保证 30d 年化窗口有完整数据；
// 单次条数有上限的（HL 500 / Bybit 200 / OKX 100），1h 结算的币需要翻页补齐
const HISTORY_TARGET_DAYS = 31;
const HL_PAGE_LIMIT = 500;
const HL_MAX_PAGES = 3;

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
          limit: 1000 // 1h 结算的币要覆盖 30d 年化需要 720 条，API 上限 1000
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
      // Bybit API: GET /v5/market/funding/history，单次上限 200 条（倒序）。
      // 1h 结算的币 200 条只有 8 天，要覆盖 30d 年化需用 endTime 往前翻页。
      const target = Date.now() - HISTORY_TARGET_DAYS * 86400000;
      let endTime = 0;

      for (let page = 0; page < 5; page++) {
        const params: any = { category: 'linear', symbol, limit: 200 };
        if (endTime) params.endTime = endTime;
        const response = await axios.get('https://api.bybit.com/v5/market/funding/history', {
          params,
          timeout: 10000,
        });

        const list = response.data?.retCode === 0 ? response.data.result?.list : null;
        if (!list?.length) break;

        const batch = list.map((item: any) => ({
          time: parseInt(item.fundingRateTimestamp),
          rate: parseFloat(item.fundingRate)
        }));
        historyData.push(...batch);

        const earliest = batch[batch.length - 1].time; // 倒序，末尾最早
        if (batch.length < 200 || earliest <= target) break;
        endTime = earliest - 1;
      }
      historyData.sort((a, b) => a.time - b.time);

    } else if (exchange === 'OKX') {
      // OKX API: GET /api/v5/public/funding-rate-history
      // OKX uses instId format: BTC-USDT-SWAP
      // Convert BTCUSDT -> BTC-USDT-SWAP
      const base = symbol.replace(/USDT$/, '');
      const instId = base + '-USDT-SWAP';

      // 单次上限 100 条（倒序）。1h 结算的币要覆盖 30d 得用 after 游标往前翻页
      const target = Date.now() - HISTORY_TARGET_DAYS * 86400000;
      let after = '';

      for (let page = 0; page < 10; page++) {
        const params: any = { instId, limit: 100 };
        if (after) params.after = after;
        const response = await axios.get('https://www.okx.com/api/v5/public/funding-rate-history', {
          params,
          timeout: 10000,
        });

        const list = response.data?.data;
        if (!list?.length) break;

        const batch = list.map((item: any) => ({
          time: parseInt(item.fundingTime || 0),
          rate: parseFloat(item.realizedRate || item.fundingRate || 0),
        }));
        historyData.push(...batch);

        const earliest = batch[batch.length - 1].time; // 倒序，末尾最早
        if (batch.length < 100 || earliest <= target) break;
        after = String(earliest);
      }
      historyData.sort((a, b) => a.time - b.time);
    } else if (exchange === 'Hyperliquid') {
      // HL: POST /info {type:'fundingHistory'}，每小时结算一次
      // builder dex（xyz:NVDA 等）symbol 本身就是 coin 名，主 dex 需还原 kXXX
      let coin = symbol;
      if (!symbol.includes(':')) {
        const map = await getHlCoinMap();
        coin = map.get(symbol) || symbol.replace(/USDT$/, '');
      }
      const now = Date.now();
      let startTime = now - HISTORY_TARGET_DAYS * 86400000;

      for (let page = 0; page < HL_MAX_PAGES; page++) {
        const response = await axios.post(HL_INFO_URL,
          { type: 'fundingHistory', coin, startTime },
          { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        const batch = (response.data || []).map((item: any) => ({
          time: item.time,
          rate: parseFloat(item.fundingRate || '0'),
        }));
        historyData.push(...batch);
        if (batch.length < HL_PAGE_LIMIT) break;
        startTime = Math.max(...batch.map((r: { time: number }) => r.time)) + 1;
        if (startTime >= now) break;
      }

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

