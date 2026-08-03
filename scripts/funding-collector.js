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
// asterOI 是快照（非时间序列）：{ SYMBOL: { qty, value, time } }
let store = { binance: {}, bybit: {}, hyperliquid: {}, okx: {}, aster: {}, asterOI: {}, updatedAt: 0 };

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      store.binance = saved.binance || {};
      store.bybit = saved.bybit || {};
      store.hyperliquid = saved.hyperliquid || {};
      store.okx = saved.okx || {};
      store.aster = saved.aster || {};
      store.asterOI = saved.asterOI || {};
      store.updatedAt = saved.updatedAt || 0;
      console.log(`[collector] Loaded: bn=${Object.keys(store.binance).length}, by=${Object.keys(store.bybit).length}, hl=${Object.keys(store.hyperliquid).length}, okx=${Object.keys(store.okx).length}, ast=${Object.keys(store.aster).length}`);
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
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
// fundingHistory 单次最多返回 500 条，新 symbol 首采 31 天需要翻页补齐
const HL_PAGE_LIMIT = 500;
const HL_MAX_PAGES = 5;

function hlPost(body, timeout = 15000) {
  return axios.post(HL_INFO_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout,
  });
}

function hlNormalize(coin) {
  if (coin.startsWith('k') && coin.length > 1 && coin[1] === coin[1].toUpperCase()) {
    return coin.substring(1);
  }
  return coin;
}

/** 主 dex：全部未下架合约。storeKey = XXXUSDT */
async function hlMainDexCoins() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(10000 * attempt); // 10s, 20s backoff
      const metaRes = await hlPost({ type: 'meta' });
      return metaRes.data.universe
        .filter(m => !m.isDelisted)
        .map(m => ({ coin: m.name, storeKey: hlNormalize(m.name) + 'USDT' }));
    } catch (e) {
      if (attempt === 2) {
        console.error('[collector] Hyperliquid meta failed after 3 attempts:', e.message);
        return null;
      }
      console.log('[collector] Hyperliquid meta retry ' + (attempt+1) + ': ' + e.message);
    }
  }
  return null;
}

/**
 * HIP-3 builder dex（xyz / para / mkts / hyna …）上的 RWA 合约。
 * 这些不在主 dex 的 universe 里，必须带 dex 参数单独查；
 * 各 dex 有大量零 OI 的僵尸合约，只采真正有持仓的。
 * storeKey 保留 HL 原始命名（xyz:NVDA），与主 dex 的 XXXUSDT 天然区分开。
 */
async function hlBuilderDexCoins() {
  let dexs;
  try {
    const res = await hlPost({ type: 'perpDexs' }, 10000);
    dexs = (res.data || []).filter(d => d && d.name).map(d => d.name);
  } catch (e) {
    console.error('[collector] Hyperliquid perpDexs failed:', e.message);
    return [];
  }

  const out = [];
  for (const dex of dexs) {
    try {
      const res = await hlPost({ type: 'metaAndAssetCtxs', dex });
      const meta = res.data?.[0];
      const ctxs = res.data?.[1];
      if (!meta?.universe || !Array.isArray(ctxs)) continue;
      for (let i = 0; i < meta.universe.length; i++) {
        const m = meta.universe[i];
        const ctx = ctxs[i];
        if (!m || m.isDelisted || !ctx) continue;
        const oiValue = parseFloat(ctx.openInterest || '0') * parseFloat(ctx.markPx || '0');
        if (!(oiValue > 0)) continue;
        out.push({ coin: m.name, storeKey: m.name });
      }
    } catch (e) {
      console.error('[collector] Hyperliquid dex=' + dex + ' failed:', e.message);
    }
    await sleep(500);
  }
  return out;
}

async function collectHyperliquid() {
  const mainCoins = await hlMainDexCoins();
  if (!mainCoins) return; // 主 dex 拿不到就整轮跳过，避免半量覆盖
  const builderCoins = await hlBuilderDexCoins();
  const coins = [...mainCoins, ...builderCoins];
  console.log('[collector] Hyperliquid: main=' + mainCoins.length + ', builder=' + builderCoins.length);

  // Filter to only coins that need updating (stale >50min since HL settles every 1h)
  const now = Date.now();
  const STALE_MS = 50 * 60 * 1000;
  const staleCoins = coins.filter(({ storeKey }) => {
    const lastTime = getLatestTime(store.hyperliquid[storeKey]);
    return lastTime === 0 || (now - lastTime) > STALE_MS;
  });
  console.log('[collector] Hyperliquid: ' + staleCoins.length + '/' + coins.length + ' coins need update');

  let success = 0, fail = 0, newRecords = 0;
  // Sequential requests with 2s delay to avoid 429
  for (const { coin, storeKey } of staleCoins) {
    try {
      const existing = store.hyperliquid[storeKey];
      let startTime = getLatestTime(existing) > 0
        ? getLatestTime(existing) + 1
        : now - MAX_AGE_MS;

      const rates = [];
      for (let page = 0; page < HL_MAX_PAGES; page++) {
        const res = await hlPost({ type: 'fundingHistory', coin, startTime }, 10000);
        const batch = (res.data || []).map(item => ({
          time: item.time,
          rate: parseFloat(item.fundingRate || '0'),
        }));
        rates.push(...batch);
        if (batch.length < HL_PAGE_LIMIT) break;
        startTime = Math.max(...batch.map(r => r.time)) + 1;
        if (startTime >= now) break;
        await sleep(1000);
      }

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

/* ── Aster ──
 * Aster 走 CloudFront，WAF 按 IP 频率封禁（429 后整个 IP 冷却约 8 分钟，
 * 且持续重试会自我维持封禁）。所以这里：
 *   - 只采日成交额 >= ASTER_MIN_VOL_USD 的合约（518 → ~250，其余是僵尸合约）
 *   - 按各 symbol 自己的结算间隔判 stale，8h 的币不会每小时都被查
 *   - 一旦连续吃到 429/403 立刻放弃本轮，绝不重试
 */
const ASTER_API = 'https://fapi.asterdex.com';
const ASTER_MIN_VOL_USD = 10000;
const ASTER_BATCH = 5;
const ASTER_BATCH_SLEEP = 500;

/** 拉 Aster 活跃 USDT 永续列表（带 24h 成交额） */
async function getAsterActiveSymbols() {
  const [eiRes, tkRes] = await Promise.all([
    axios.get(`${ASTER_API}/fapi/v1/exchangeInfo`, { timeout: 20000 }),
    axios.get(`${ASTER_API}/fapi/v1/ticker/24hr`, { timeout: 20000 }),
  ]);

  const tradable = new Set(
    (eiRes.data?.symbols || [])
      .filter(s => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
      .map(s => s.symbol)
  );

  const out = [];
  for (const t of (tkRes.data || [])) {
    if (!tradable.has(t.symbol)) continue;
    const vol = parseFloat(t.quoteVolume || '0');
    if (vol < ASTER_MIN_VOL_USD) continue;
    out.push({ symbol: t.symbol, vol, lastPrice: parseFloat(t.lastPrice || '0') });
  }
  // 成交额大的先采，万一中途被 WAF 掐断，留下的是重要的
  out.sort((a, b) => b.vol - a.vol);
  return out;
}

/** WAF 触发判定：429 / 403 都当作被限流 */
function isAsterBlocked(e) {
  const s = e?.response?.status;
  return s === 429 || s === 403;
}

async function collectAster() {
  let active;
  try {
    active = await getAsterActiveSymbols();
  } catch (e) {
    console.error('[collector] Aster symbols failed:', e.message);
    return;
  }
  console.log(`[collector] Aster: ${active.length} active symbols (vol >= ${ASTER_MIN_VOL_USD})`);

  const now = Date.now();

  /* —— 1. 资金费历史（增量） —— */
  const stale = active.filter(({ symbol }) => {
    const existing = store.aster[symbol];
    const lastTime = getLatestTime(existing);
    if (lastTime === 0) return true;               // 首次，回补 30 天
    if (!existing || existing.length < 3) return true; // 数据太少，还在积累
    const intervalMs = detectInterval(existing) * 3600 * 1000;
    return now - lastTime >= intervalMs * 0.9;     // 到点了才查
  });
  console.log(`[collector] Aster: ${stale.length}/${active.length} need funding update`);

  let blocked = false;
  let success = 0, fail = 0, newRecords = 0;

  for (let i = 0; i < stale.length && !blocked; i += ASTER_BATCH) {
    const batch = stale.slice(i, i + ASTER_BATCH);
    const results = await Promise.all(batch.map(async ({ symbol }) => {
      try {
        const existing = store.aster[symbol];
        const lastTime = getLatestTime(existing);
        const startTime = lastTime > 0 ? lastTime + 1 : now - MAX_AGE_MS;
        const res = await axios.get(`${ASTER_API}/fapi/v1/fundingRate`, {
          params: { symbol, startTime, limit: 1000 },
          timeout: 15000,
        });
        const rates = (res.data || []).map(item => ({
          time: parseInt(item.fundingTime || '0'),
          rate: parseFloat(item.fundingRate || '0'),
        })).filter(r => r.time > 0);
        newRecords += rates.length;
        store.aster[symbol] = mergeAndTrim(existing, rates);
        return 'ok';
      } catch (e) {
        return isAsterBlocked(e) ? 'blocked' : 'fail';
      }
    }));

    for (const r of results) {
      if (r === 'ok') success++;
      else if (r === 'blocked') { blocked = true; fail++; }
      else fail++;
    }
    if (i + ASTER_BATCH < stale.length && !blocked) await sleep(ASTER_BATCH_SLEEP);
  }

  if (blocked) {
    console.error('[collector] Aster: WAF blocked (429/403), aborting this round');
    return;
  }
  console.log(`[collector] Aster funding: ${success} ok, ${fail} fail, +${newRecords} new records`);

  /* —— 2. OI 快照（Aster 没有批量 OI 端点，只能逐 symbol） —— */
  let oiOk = 0, oiFail = 0;
  const freshOI = {};
  for (let i = 0; i < active.length && !blocked; i += ASTER_BATCH) {
    const batch = active.slice(i, i + ASTER_BATCH);
    const results = await Promise.all(batch.map(async ({ symbol, lastPrice }) => {
      try {
        const res = await axios.get(`${ASTER_API}/fapi/v1/openInterest`, {
          params: { symbol },
          timeout: 15000,
        });
        const qty = parseFloat(res.data?.openInterest || '0');
        if (qty > 0 && lastPrice > 0) {
          freshOI[symbol] = { qty, value: qty * lastPrice, time: res.data?.time || Date.now() };
        }
        return 'ok';
      } catch (e) {
        return isAsterBlocked(e) ? 'blocked' : 'fail';
      }
    }));
    for (const r of results) {
      if (r === 'ok') oiOk++;
      else if (r === 'blocked') { blocked = true; oiFail++; }
      else oiFail++;
    }
    if (i + ASTER_BATCH < active.length && !blocked) await sleep(ASTER_BATCH_SLEEP);
  }

  // 部分成功也写入：合并进旧快照，避免一次失败把整列清空
  if (Object.keys(freshOI).length > 0) {
    store.asterOI = { ...store.asterOI, ...freshOI };
  }
  console.log(
    `[collector] Aster OI: ${oiOk} ok, ${oiFail} fail` +
    (blocked ? ' (WAF blocked, partial)' : '')
  );
}

/* ── 采集一轮 ── */
async function collectAll() {
  const start = Date.now();
  console.log(`[collector] Starting collection at ${new Date().toISOString()}`);

  await Promise.all([collectBinance(), collectBybit(), collectHyperliquid(), collectOkx(), collectAster()]);
  saveStore();

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[collector] Done in ${elapsed}s. bn=${Object.keys(store.binance).length}, by=${Object.keys(store.bybit).length}, hl=${Object.keys(store.hyperliquid).length}, okx=${Object.keys(store.okx).length}, ast=${Object.keys(store.aster).length}, astOI=${Object.keys(store.asterOI).length}`);
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
