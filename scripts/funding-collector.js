#!/usr/bin/env node
/**
 * 资金费率采集器 v4 - 增量采集版
 * 每次只请求上次最后一条之后的新数据，追加到已有数据
 * 定期清理超过31天的旧数据
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'funding-history.json');
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

const BINANCE_FAPI = 'https://www.binance.com';
const BYBIT_API = 'https://api.bybit.com';

/* ── Store ── */
let store = { binance: {}, bybit: {}, hyperliquid: {}, okx: {}, updatedAt: 0 };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      store.binance = saved.binance || {};
      store.bybit = saved.bybit || {};
      store.hyperliquid = saved.hyperliquid || {};
      store.okx = saved.okx || {};
      store.updatedAt = saved.updatedAt || 0;
      console.log(`[collector] Loaded: bn=${Object.keys(store.binance).length}, by=${Object.keys(store.bybit).length}, hl=${Object.keys(store.hyperliquid).length}, okx=${Object.keys(store.okx).length}`);
    }
  } catch (e) {
    console.error('[collector] Load failed:', e.message);
  }
}

function saveStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    store.updatedAt = Date.now();
    fs.writeFileSync(DATA_FILE, JSON.stringify(store));
  } catch (e) {
    console.error('[collector] Save failed:', e.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 获取已存数据的最新时间戳 */
function getLatestTime(rates) {
  if (!rates || rates.length === 0) return 0;
  return Math.max(...rates.map(r => r.time));
}

/** 追加新数据并清理过期数据 */
function mergeAndTrim(existing, newRates) {
  if (!existing) existing = [];
  if (!newRates || newRates.length === 0) return existing;

  // 用 Set 去重（基于时间戳）
  const timeSet = new Set(existing.map(r => r.time));
  for (const r of newRates) {
    if (!timeSet.has(r.time)) {
      existing.push(r);
      timeSet.add(r.time);
    }
  }

  // 按时间排序
  existing.sort((a, b) => a.time - b.time);

  // 清理超过31天的数据
  const cutoff = Date.now() - MAX_AGE_MS;
  return existing.filter(r => r.time >= cutoff);
}

/* ── Binance ── */
async function getBinanceSymbols() {
  const res = await axios.get(`${BINANCE_FAPI}/fapi/v1/premiumIndex`, { timeout: 15000 });
  return res.data.filter(item => item.symbol.endsWith('USDT')).map(item => item.symbol);
}

let binanceIntervals = {};

function detectInterval(rates) {
  if (!rates || rates.length < 3) return 8;
  const diffs = [];
  for (let i = 1; i < Math.min(rates.length, 6); i++) {
    diffs.push((rates[i].time - rates[i - 1].time) / 3600000);
  }
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  if (median <= 1.5) return 1;
  if (median <= 6) return 4;
  return 8;
}

async function collectBinance() {
  let allSymbols;
  try {
    allSymbols = await getBinanceSymbols();
  } catch (e) {
    console.error('[collector] Binance symbols failed:', e.message);
    return;
  }

  const hour = new Date().getUTCHours();
  const hasIntervals = Object.keys(binanceIntervals).length > 0;
  let symbols;
  if (!hasIntervals) {
    symbols = allSymbols;
    console.log('[collector] Binance: full fetch (initial, ' + allSymbols.length + ' symbols)');
  } else {
    symbols = allSymbols.filter(sym => {
      const interval = binanceIntervals[sym] || 8;
      if (interval === 1) return true;
      if (interval === 4) return hour % 4 === 0;
      return hour % 8 === 0;
    });
    const counts = { '1h': 0, '4h': 0, '8h': 0 };
    for (const sym of symbols) {
      const iv = binanceIntervals[sym] || 8;
      if (iv === 1) counts['1h']++;
      else if (iv === 4) counts['4h']++;
      else counts['8h']++;
    }
    console.log('[collector] Binance: ' + symbols.length + '/' + allSymbols.length + ' symbols this run (1h:' + counts['1h'] + ' 4h:' + counts['4h'] + ' 8h:' + counts['8h'] + ') hour=' + hour);
  }

  let success = 0, fail = 0, newRecords = 0;
  for (const symbol of symbols) {
    try {
      // 增量：从已有数据的最新时间戳开始请求
      const existing = store.binance[symbol];
      const lastTime = getLatestTime(existing);
      const startTime = lastTime > 0 ? lastTime + 1 : Date.now() - MAX_AGE_MS;

      const res = await axios.get(`${BINANCE_FAPI}/fapi/v1/fundingRate`, {
        params: { symbol, startTime, limit: 1000 },
        timeout: 10000,
      });
      const rates = (res.data || []).map(item => ({
        time: parseInt(item.fundingTime),
        rate: parseFloat(item.fundingRate || '0'),
      }));

      newRecords += rates.length;
      store.binance[symbol] = mergeAndTrim(existing, rates);

      // 检测并缓存间隔
      if (store.binance[symbol].length >= 3) {
        binanceIntervals[symbol] = detectInterval(store.binance[symbol]);
      }
      success++;
    } catch {
      fail++;
    }
    await sleep(500);
  }
  console.log('[collector] Binance: ' + success + ' ok, ' + fail + ' fail, +' + newRecords + ' new records');
}

/* ── Bybit ── */
async function collectBybit() {
  let symbolsData;
  try {
    const res = await axios.get(`${BYBIT_API}/v5/market/instruments-info`, {
      params: { category: 'linear', limit: 1000 },
      timeout: 15000,
    });
    symbolsData = (res.data?.result?.list || [])
      .filter(item => item.status === 'Trading' && item.symbol.endsWith('USDT'))
      .map(item => ({
        symbol: item.symbol,
        intervalHours: parseInt(item.fundingInterval || '480') / 60,
      }));
  } catch (e) {
    console.error('[collector] Bybit instruments failed:', e.message);
    return;
  }

  const hour = new Date().getUTCHours();
  const hasBybitData = Object.keys(store.bybit).length > 0;
  let due;
  if (!hasBybitData) {
    due = symbolsData;
    console.log('[collector] Bybit: full fetch (initial, ' + symbolsData.length + ' symbols)');
  } else {
    due = symbolsData.filter(({ intervalHours }) => {
      if (intervalHours <= 1) return true;
      if (intervalHours <= 4) return hour % 4 === 0;
      return hour % 8 === 0;
    });
    const counts = { '1h': 0, '4h': 0, '8h': 0 };
    for (const { intervalHours } of due) {
      if (intervalHours <= 1) counts['1h']++;
      else if (intervalHours <= 4) counts['4h']++;
      else counts['8h']++;
    }
    console.log('[collector] Bybit: ' + due.length + '/' + symbolsData.length + ' symbols this run (1h:' + counts['1h'] + ' 4h:' + counts['4h'] + ' 8h:' + counts['8h'] + ') hour=' + hour);
  }

  let success = 0, fail = 0, newRecords = 0;
  for (const { symbol, intervalHours } of due) {
    try {
      // Bybit API 返回的是最新在前，不支持 startTime
      // 所以还是取最近 N 条，但用 merge 去重追加
      const limit = intervalHours <= 1 ? 200 : 50;
      const res = await axios.get(`${BYBIT_API}/v5/market/funding/history`, {
        params: { category: 'linear', symbol, limit },
        timeout: 10000,
      });
      const rates = (res.data?.result?.list || []).map(item => ({
        time: parseInt(item.fundingRateTimestamp),
        rate: parseFloat(item.fundingRate || '0'),
      }));
      if (rates.length > 0) {
        const existingData = store.bybit[symbol];
        const existingRates = existingData?.rates || [];
        const merged = mergeAndTrim(existingRates, rates);
        newRecords += rates.length;
        store.bybit[symbol] = { intervalHours, rates: merged };
        success++;
      }
    } catch {
      fail++;
    }
    await sleep(1200);
  }
  console.log('[collector] Bybit: ' + success + ' ok, ' + fail + ' fail, +' + newRecords + ' new records');
}

/* ── Hyperliquid ── */
async function collectHyperliquid() {
  let coins;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(10000 * attempt); // 10s, 20s backoff
      const metaRes = await axios.post('https://api.hyperliquid.xyz/info',
        { type: 'meta' },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      coins = metaRes.data.universe
        .filter(m => !m.isDelisted && m.maxLeverage > 3)
        .map(m => m.name);
      break;
    } catch (e) {
      if (attempt === 2) {
        console.error('[collector] Hyperliquid meta failed after 3 attempts:', e.message);
        return;
      }
      console.log('[collector] Hyperliquid meta retry ' + (attempt+1) + ': ' + e.message);
    }
  }

  // Filter to only coins that need updating (stale >50min since HL settles every 1h)
  const now = Date.now();
  const STALE_MS = 50 * 60 * 1000;
  const staleCoins = coins.filter(coin => {
    let symbol = coin;
    if (coin.startsWith('k') && coin.length > 1 && coin[1] === coin[1].toUpperCase()) {
      symbol = coin.substring(1);
    }
    const storeKey = symbol + 'USDT';
    const existing = store.hyperliquid[storeKey];
    const lastTime = getLatestTime(existing);
    return lastTime === 0 || (now - lastTime) > STALE_MS;
  });
  console.log('[collector] Hyperliquid: ' + staleCoins.length + '/' + coins.length + ' coins need update');

  let success = 0, fail = 0, newRecords = 0;
  // Sequential requests with 1s delay to avoid 429
  for (const coin of staleCoins) {
    try {
      let symbol = coin;
      if (coin.startsWith('k') && coin.length > 1 && coin[1] === coin[1].toUpperCase()) {
        symbol = coin.substring(1);
      }
      const storeKey = symbol + 'USDT';
      const existing = store.hyperliquid[storeKey];
      const lastTime = getLatestTime(existing);
      const startTime = lastTime > 0 ? lastTime + 1 : now - MAX_AGE_MS;

      const res = await axios.post('https://api.hyperliquid.xyz/info',
        { type: 'fundingHistory', coin, startTime },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      const rates = (res.data || []).map(item => ({
        time: item.time,
        rate: parseFloat(item.fundingRate || '0'),
      }));
      newRecords += rates.length;
      store.hyperliquid[storeKey] = mergeAndTrim(existing, rates);
      success++;
    } catch (e) {
      fail++;
      // If 429, wait longer before next request
      if (e?.response?.status === 429) {
        await sleep(10000);
      }
    }
    await sleep(2000);
  }
  console.log('[collector] Hyperliquid: ' + success + ' ok, ' + fail + ' fail, +' + newRecords + ' new records');
}


/* ── OKX ── */
async function collectOkx() {
  let instruments;
  try {
    const res = await axios.get('https://www.okx.com/api/v5/public/instruments', {
      params: { instType: 'SWAP' },
      timeout: 15000,
    });
    instruments = (res.data?.data || [])
      .filter(item => item.instId.endsWith('-USDT-SWAP') && item.state === 'live')
      .map(item => {
        const parts = item.instId.split('-');
        return {
          instId: item.instId,
          symbol: parts[0] + parts[1],  // BTC-USDT-SWAP -> BTCUSDT
        };
      });
  } catch (e) {
    console.error('[collector] OKX instruments failed:', e.message);
    return;
  }

  console.log('[collector] OKX: fetching ' + instruments.length + ' symbols');

  let success = 0, fail = 0, newRecords = 0;
  const batchSize = 20;
  for (let i = 0; i < instruments.length; i += batchSize) {
    const batch = instruments.slice(i, i + batchSize);
    const batchPromises = batch.map(async ({ instId, symbol }) => {
      try {
        const existing = store.okx[symbol];
        const lastTime = getLatestTime(existing);
        // OKX funding-rate-history: before/after are timestamps
        const params = { instId, limit: '100' };
        if (lastTime > 0) params.before = String(lastTime + 1);

        const res = await axios.get('https://www.okx.com/api/v5/public/funding-rate-history', {
          params,
          timeout: 10000,
        });
        const rates = (res.data?.data || []).map(item => ({
          time: parseInt(item.fundingTime || '0'),
          rate: parseFloat(item.realizedRate || item.fundingRate || '0'),
        }));
        newRecords += rates.length;
        store.okx[symbol] = mergeAndTrim(existing, rates);
        return true;
      } catch {
        return false;
      }
    });
    const results = await Promise.all(batchPromises);
    results.forEach(ok => ok ? success++ : fail++);
    if (i + batchSize < instruments.length) {
      await sleep(500);
    }
  }
  console.log('[collector] OKX: ' + success + ' ok, ' + fail + ' fail, +' + newRecords + ' new records');
}

/* ── 采集一轮 ── */
async function collectAll() {
  const start = Date.now();
  console.log(`[collector] Starting collection at ${new Date().toISOString()}`);

  await Promise.all([collectBinance(), collectBybit(), collectHyperliquid(), collectOkx()]);
  saveStore();

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[collector] Done in ${elapsed}s. bn=${Object.keys(store.binance).length}, by=${Object.keys(store.bybit).length}, hl=${Object.keys(store.hyperliquid).length}, okx=${Object.keys(store.okx).length}`);
}

/* ── 主循环 ── */
async function run() {
  console.log('[collector] Starting funding collector v4 (incremental)');
  loadStore();

  // 从已有数据初始化 Binance 结算间隔
  for (const [sym, rates] of Object.entries(store.binance)) {
    if (Array.isArray(rates) && rates.length >= 3) {
      binanceIntervals[sym] = detectInterval(rates);
    }
  }
  const ivCounts = { 1: 0, 4: 0, 8: 0 };
  for (const iv of Object.values(binanceIntervals)) ivCounts[iv] = (ivCounts[iv] || 0) + 1;
  console.log('[collector] Binance intervals from cache: 1h=' + (ivCounts[1]||0) + ' 4h=' + (ivCounts[4]||0) + ' 8h=' + (ivCounts[8]||0));

  // 立即采集一次
  await collectAll();

  // 每小时采集一次
  setInterval(async () => {
    try { await collectAll(); } catch (e) { console.error('[collector] Error:', e.message); }
  }, 60 * 60 * 1000);
}

run().catch(e => { console.error('[collector] Fatal:', e); process.exit(1); });
