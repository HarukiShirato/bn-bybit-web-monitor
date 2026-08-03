/**
 * Deribit 期权数据采集器
 * 每 5 分钟从 Deribit 拉取 BTC 主力期权数据，缓存到本地 JSON
 */

const fs = require('fs');
const path = require('path');

const DERIBIT_API = 'https://www.deribit.com/api/v2/public';
const CACHE_FILE = path.join(__dirname, 'data', 'options-cache.json');
const INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

// 确保 data 目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function parseInstrument(name) {
  const parts = name.split('-');
  return {
    underlying: parts[0],
    expiry: parts[1],
    strike: parseInt(parts[2]),
    type: parts[3],
  };
}

function daysToExpiry(expiryTs) {
  return Math.max(0, (expiryTs - Date.now()) / (1000 * 86400));
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (resp.status === 429) {
        console.log(`  [429] Rate limited, waiting ${(i + 1) * 5}s...`);
        await new Promise(r => setTimeout(r, (i + 1) * 5000));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.log(`  Retry ${i + 1}/${retries}: ${err.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function collectOptions() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] 开始采集 Deribit 期权数据...`);

  try {
    // 1. 获取所有活跃 BTC 期权
    const instrumentsData = await fetchWithRetry(
      `${DERIBIT_API}/get_instruments?currency=BTC&kind=option&expired=false`
    );
    const instruments = instrumentsData.result || [];

    // 过滤: DTE 3~90 天
    const now = Date.now();
    const filtered = instruments.filter(i => {
      const dte = (i.expiration_timestamp - now) / (1000 * 86400);
      return dte > 3 && dte <= 90;
    });
    console.log(`  合约总数: ${instruments.length}, 过滤后: ${filtered.length}`);

    // 2. 获取 index price
    const indexData = await fetchWithRetry(
      `${DERIBIT_API}/get_index_price?index_name=btc_usd`
    );
    const underlyingPrice = indexData.result?.index_price || 0;
    console.log(`  BTC 价格: $${underlyingPrice.toLocaleString()}`);

    // 3. 获取 book summary（含 OI）
    const summaryData = await fetchWithRetry(
      `${DERIBIT_API}/get_book_summary_by_currency?currency=BTC&kind=option`
    );
    const summaries = summaryData.result || [];
    const summaryMap = new Map();
    for (const s of summaries) {
      summaryMap.set(s.instrument_name, s);
    }

    // 按 OI 排序，取 top 100
    const instrWithOi = filtered.map(inst => {
      const summary = summaryMap.get(inst.instrument_name);
      return { ...inst, oi: summary?.open_interest || 0 };
    }).sort((a, b) => b.oi - a.oi);

    const topInstruments = instrWithOi.slice(0, 100);
    console.log(`  采集 top ${topInstruments.length} 个合约的 Greeks...`);

    // 4. 分批获取 ticker（含 Greeks），每批 10 个，间隔 1 秒避免限流
    const BATCH_SIZE = 10;
    const rows = [];

    for (let i = 0; i < topInstruments.length; i += BATCH_SIZE) {
      const batch = topInstruments.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(topInstruments.length / BATCH_SIZE);

      const tickers = await Promise.all(
        batch.map(async (inst) => {
          try {
            const data = await fetchWithRetry(
              `${DERIBIT_API}/ticker?instrument_name=${inst.instrument_name}`
            );
            return data.result;
          } catch {
            return null;
          }
        })
      );

      for (let j = 0; j < batch.length; j++) {
        const inst = batch[j];
        const ticker = tickers[j];
        if (!ticker) continue;

        const parsed = parseInstrument(inst.instrument_name);
        const greeks = ticker.greeks || {};
        const dte = daysToExpiry(inst.expiration_timestamp);
        const markPriceBtc = ticker.mark_price || 0;
        const bidPrice = ticker.best_bid_price || 0;
        const askPrice = ticker.best_ask_price || 0;

        let otmPct = 0;
        if (parsed.type === 'P') {
          otmPct = ((underlyingPrice - parsed.strike) / underlyingPrice) * 100;
        } else {
          otmPct = ((parsed.strike - underlyingPrice) / underlyingPrice) * 100;
        }

        rows.push({
          instrument: inst.instrument_name,
          type: parsed.type,
          strike: parsed.strike,
          expiry: parsed.expiry,
          expiryTs: inst.expiration_timestamp,
          dte: Math.round(dte * 10) / 10,
          underlying: parsed.underlying,
          underlyingPrice,
          markPrice: markPriceBtc,
          markPriceUsd: markPriceBtc * underlyingPrice,
          bidPrice,
          askPrice,
          bidPriceUsd: bidPrice * underlyingPrice,
          askPriceUsd: askPrice * underlyingPrice,
          volume24h: ticker.stats?.volume || 0,
          openInterest: ticker.open_interest || 0,
          iv: ticker.mark_iv || 0,
          bidIv: ticker.bid_iv || 0,
          askIv: ticker.ask_iv || 0,
          delta: greeks.delta || 0,
          gamma: greeks.gamma || 0,
          theta: greeks.theta || 0,
          vega: greeks.vega || 0,
          last: ticker.last_price || 0,
          lastUsd: (ticker.last_price || 0) * underlyingPrice,
          change24h: ticker.stats?.price_change || 0,
          otmPct,
        });
      }

      // 批次间等 1 秒
      if (i + BATCH_SIZE < topInstruments.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
      process.stdout.write(`  批次 ${batchNum}/${totalBatches} 完成\r`);
    }

    // 5. 写入缓存文件
    const cacheData = {
      success: true,
      data: rows,
      timestamp: Date.now(),
      count: rows.length,
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n  采集完成: ${rows.length} 个合约, 耗时 ${elapsed}s`);
    console.log(`  缓存写入: ${CACHE_FILE}`);

  } catch (err) {
    console.error(`  采集失败: ${err.message}`);
  }
}

// 立即执行一次
collectOptions();

// 定时执行
setInterval(collectOptions, INTERVAL_MS);
console.log(`\n定时采集已启动，间隔 ${INTERVAL_MS / 1000}s`);
