/**
 * eb65 永续持仓采集器
 *
 * 覆盖两处：
 *   - Binance 统一账户（Portfolio Margin，走 papi）的 UM / CM 永续持仓
 *   - Hyperliquid 主 dex + HIP-3 builder dex（xyz / para / mkts …，必须带 dex 参数单独查）
 *
 * 每轮把持仓、当期资金费、按当前名义算出的资金费收支写进 data/positions-eb65.json，
 * API 只读这个文件，不给交易所打高频请求。
 *
 * symbol 字段直接对齐 /api/funding-history 的入参约定：
 *   Binance -> BTCUSDT；HL 主 dex -> LITUSDT（kPEPE 归一后加 USDT）；builder dex -> xyz:STRC
 */

const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const envFile = path.join(__dirname, "..", ".env");
try {
  fs.readFileSync(envFile, "utf-8").split("\n").forEach(line => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#")) process.env[k.trim()] = v.join("=").trim();
  });
} catch (e) { /* .env 缺失时下面的凭证检查会兜住 */ }

const OUT_FILE = path.join(process.env.PERP_DATA_DIR || path.join(__dirname, "..", "data"), "positions-eb65.json");
const INTERVAL_MS = 60 * 1000;
// 收益流水是历史数据，不需要跟持仓一样每分钟重拉
const SLOW_INTERVAL_MS = 10 * 60 * 1000;
const LOOKBACK_DAYS = 7;

const PAPI_BASE = "https://papi.binance.com";
// fapi 的部分端点在本机出口会被 WAF 403（fundingInfo 就是），www 那份是同数据的镜像，做兜底
const FAPI_HOSTS = ["https://fapi.binance.com", "https://www.binance.com"];
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const KEY = process.env.EB65_BINANCE_API_KEY;
const SECRET = process.env.EB65_BINANCE_API_SECRET;
const HL_ADDR = process.env.EB65_HL_ADDRESS;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ────────────── Binance（统一账户 papi） ────────────── */

function signedQuery(params = {}) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 }).toString();
  return qs + "&signature=" + crypto.createHmac("sha256", SECRET).update(qs).digest("hex");
}

async function papiGet(endpoint, params = {}) {
  const res = await axios.get(`${PAPI_BASE}${endpoint}?${signedQuery(params)}`, {
    headers: { "X-MBX-APIKEY": KEY },
    timeout: 15000,
  });
  return res.data;
}

/** fapi 公开端点：主机逐个试，全挂才抛 */
async function fapiGet(endpoint) {
  let lastErr;
  for (const host of FAPI_HOSTS) {
    try {
      return await axios.get(host + endpoint, { timeout: 15000 });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 全市场当期费率 + 下次结算时间，一次请求拿全量 */
async function fetchBinanceFundingMeta() {
  const rate = new Map();   // symbol -> { rate, nextFundingTime }
  const interval = new Map(); // symbol -> 结算间隔小时

  const [pi, fi] = await Promise.allSettled([
    fapiGet("/fapi/v1/premiumIndex"),
    fapiGet("/fapi/v1/fundingInfo"),
  ]);

  if (pi.status === "fulfilled") {
    for (const it of pi.value.data || []) {
      rate.set(it.symbol, {
        rate: parseFloat(it.lastFundingRate || "0"),
        nextFundingTime: Number(it.nextFundingTime || 0),
        markPrice: parseFloat(it.markPrice || "0"),
      });
    }
  } else {
    log("[binance] premiumIndex 失败:", pi.reason?.message);
  }

  // fundingInfo 只列出非 8h 的合约，缺省即 8h
  if (fi.status === "fulfilled") {
    for (const it of fi.value.data || []) {
      interval.set(it.symbol, Number(it.fundingIntervalHours) || 8);
    }
  } else {
    log("[binance] fundingInfo 失败:", fi.reason?.message);
  }

  return { rate, interval };
}

async function fetchBinancePositions() {
  if (!KEY || !SECRET) {
    log("[binance] 缺 EB65_BINANCE_API_KEY / EB65_BINANCE_API_SECRET，跳过");
    return { positions: [], error: "missing credentials" };
  }

  const [umRes, cmRes, meta] = await Promise.allSettled([
    papiGet("/papi/v1/um/positionRisk"),
    papiGet("/papi/v1/cm/positionRisk"),
    fetchBinanceFundingMeta(),
  ]);

  if (umRes.status === "rejected") {
    const msg = umRes.reason?.response?.data?.msg || umRes.reason?.message;
    log("[binance] um/positionRisk 失败:", msg);
    return { positions: [], error: String(msg) };
  }

  const fundingMeta = meta.status === "fulfilled" ? meta.value : { rate: new Map(), interval: new Map() };
  const positions = [];

  const pushRow = (p, isCoinMargined) => {
    const amt = parseFloat(p.positionAmt || "0");
    if (!amt) return;

    const symbol = p.symbol;
    const fm = fundingMeta.rate.get(symbol) || {};
    const markPrice = parseFloat(p.markPrice || "0") || fm.markPrice || 0;
    const intervalHours = fundingMeta.interval.get(symbol) || 8;

    // 币本位的 notional 用张数×合约面值不好还原，这里直接用接口给的 notional（U 本位）；
    // 币本位则用 markPrice × 数量近似
    const notional = Math.abs(
      p.notional !== undefined ? parseFloat(p.notional) : amt * markPrice
    );

    positions.push({
      exchange: "Binance",
      account: isCoinMargined ? "PM · COIN-M" : "PM · USDⓈ-M",
      symbol,
      base: symbol.replace(/USDT$|USDC$|USD_PERP$/, ""),
      side: amt > 0 ? "LONG" : "SHORT",
      size: Math.abs(amt),
      notional,
      entryPrice: parseFloat(p.entryPrice || "0"),
      markPrice,
      unrealizedPnl: parseFloat(p.unRealizedProfit || "0"),
      liquidationPrice: parseFloat(p.liquidationPrice || "0") || null,
      leverage: parseFloat(p.leverage || "0") || null,
      fundingRate: fm.rate ?? null,
      fundingIntervalHours: intervalHours,
      nextFundingTime: fm.nextFundingTime || null,
      cumFundingSinceOpen: null, // Binance 不在持仓接口里给累计资金费
      updateTime: Number(p.updateTime || 0) || null,
    });
  };

  for (const p of umRes.value || []) pushRow(p, false);
  if (cmRes.status === "fulfilled") {
    for (const p of cmRes.value || []) pushRow(p, true);
  } else {
    log("[binance] cm/positionRisk 失败（忽略）:", cmRes.reason?.response?.data?.msg || cmRes.reason?.message);
  }

  return { positions, error: null };
}

/* ────────────── Hyperliquid ────────────── */

async function hlInfo(body) {
  const res = await axios.post(HL_INFO_URL, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });
  return res.data;
}

/** kPEPE -> PEPE，主 dex 的 symbol 归一成 XXXUSDT 才能对上 funding-history */
function normalizeCoin(name) {
  return name.startsWith("k") && name.length > 1 && name[1] === name[1].toUpperCase()
    ? name.substring(1)
    : name;
}

/** 拉一个 dex 的持仓；dex 为空 = 主 dex */
async function fetchHlDex(dex) {
  const body = { type: "clearinghouseState", user: HL_ADDR };
  if (dex) body.dex = dex;

  const state = await hlInfo(body);
  const assetPositions = state?.assetPositions || [];
  if (!assetPositions.length) return { positions: [], accountValue: parseFloat(state?.marginSummary?.accountValue || "0") };

  // 只有确实有仓位时才去拉这个 dex 的行情（funding / markPx）
  const ctxBody = { type: "metaAndAssetCtxs" };
  if (dex) ctxBody.dex = dex;
  const fundingByCoin = new Map();
  try {
    const [meta, ctxs] = await hlInfo(ctxBody);
    (meta?.universe || []).forEach((u, i) => {
      const c = ctxs?.[i];
      if (c) fundingByCoin.set(u.name, { funding: parseFloat(c.funding || "0"), markPx: parseFloat(c.markPx || "0") });
    });
  } catch (e) {
    log(`[hyperliquid] metaAndAssetCtxs 失败 (dex=${dex || "main"}):`, e.message);
  }

  const positions = [];
  for (const ap of assetPositions) {
    const p = ap.position;
    const szi = parseFloat(p.szi || "0");
    if (!szi) continue;

    const ctx = fundingByCoin.get(p.coin) || {};
    const markPrice = ctx.markPx || 0;
    const notional = Math.abs(parseFloat(p.positionValue || "0")) || Math.abs(szi) * markPrice;

    positions.push({
      exchange: "Hyperliquid",
      account: dex ? `HL · ${dex}` : "HL · main",
      // 主 dex 归一成 XXXUSDT，builder dex 用 dex:COIN，两者都能直接喂给 funding-history
      symbol: dex ? `${dex}:${p.coin}` : normalizeCoin(p.coin) + "USDT",
      base: dex ? p.coin : normalizeCoin(p.coin),
      side: szi > 0 ? "LONG" : "SHORT",
      size: Math.abs(szi),
      notional,
      entryPrice: parseFloat(p.entryPx || "0"),
      markPrice,
      unrealizedPnl: parseFloat(p.unrealizedPnl || "0"),
      liquidationPrice: p.liquidationPx ? parseFloat(p.liquidationPx) : null,
      leverage: p.leverage?.value ?? null,
      fundingRate: ctx.funding ?? null,
      fundingIntervalHours: 1, // HL 每小时结算
      nextFundingTime: nextHourTs(),
      cumFundingSinceOpen: p.cumFunding ? -parseFloat(p.cumFunding.sinceOpen || "0") : null,
      updateTime: null,
    });
  }

  return { positions, accountValue: parseFloat(state?.marginSummary?.accountValue || "0") };
}

function nextHourTs() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.getTime() + 3600 * 1000;
}

async function fetchHyperliquidPositions() {
  if (!HL_ADDR) {
    log("[hyperliquid] 缺 EB65_HL_ADDRESS，跳过");
    return { positions: [], error: "missing address" };
  }

  let dexes = [];
  try {
    const list = await hlInfo({ type: "perpDexs" });
    dexes = (list || []).filter(Boolean).map(d => d.name).filter(Boolean);
  } catch (e) {
    log("[hyperliquid] perpDexs 失败，仅采主 dex:", e.message);
  }

  const targets = ["", ...dexes];
  const results = await Promise.allSettled(targets.map(d => fetchHlDex(d)));

  if (results[0].status === "rejected") {
    log("[hyperliquid] 主 dex 失败:", results[0].reason?.message);
    return { positions: [], error: String(results[0].reason?.message) };
  }

  const positions = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") positions.push(...r.value.positions);
    else log(`[hyperliquid] dex=${targets[i] || "main"} 失败:`, r.reason?.message);
  });

  return { positions, error: null };
}

/* ────────────── 真实收益（已到账，不是按当前费率外推的估算） ────────────── */

const SAPI_BASE = "https://api.binance.com";

async function sapiGet(endpoint, params = {}) {
  const res = await axios.get(`${SAPI_BASE}${endpoint}?${signedQuery(params)}`, {
    headers: { "X-MBX-APIKEY": KEY },
    timeout: 20000,
  });
  return res.data;
}

/** 活期理财持仓：A 腿现货实际躺在理财里的数量与累计收益（币本位） */
async function fetchEarnPositions() {
  const byAsset = new Map();
  let current = 1;
  for (;;) {
    const res = await sapiGet("/sapi/v1/simple-earn/flexible/position", { current, size: 100 });
    for (const r of res?.rows || []) {
      const prev = byAsset.get(r.asset) || { amount: 0, cumulativeRewards: 0 };
      byAsset.set(r.asset, {
        amount: prev.amount + parseFloat(r.totalAmount || "0"),
        cumulativeRewards: prev.cumulativeRewards + parseFloat(r.cumulativeTotalRewards || "0"),
        apr: parseFloat(r.latestAnnualPercentageRate || "0"),
      });
    }
    if (!res?.rows?.length || current * 100 >= Number(res.total || 0)) break;
    current++;
  }
  return byAsset;
}

/** 理财派息流水：按币种聚合 3d / 7d 真实到账数量（币本位） */
async function fetchEarnRewards() {
  const start = Date.now() - LOOKBACK_DAYS * 86400000;
  const cut3d = Date.now() - 3 * 86400000;
  const byAsset = new Map();

  for (const type of ["REALTIME", "BONUS"]) {
    let current = 1;
    for (;;) {
      const res = await sapiGet("/sapi/v1/simple-earn/flexible/history/rewardsRecord", {
        type, startTime: start, endTime: Date.now(), current, size: 100,
      });
      const rows = res?.rows || [];
      for (const r of rows) {
        const amt = parseFloat(r.rewards || "0");
        if (!amt) continue;
        const e = byAsset.get(r.asset) || { d3: 0, d7: 0 };
        e.d7 += amt;
        if (Number(r.time) >= cut3d) e.d3 += amt;
        byAsset.set(r.asset, e);
      }
      if (!rows.length || current * 100 >= Number(res.total || 0)) break;
      current++;
    }
  }
  return byAsset;
}

/** Binance 已实现资金费：按 symbol 聚合 3d / 7d（USDT） */
async function fetchBinanceFundingIncome() {
  const start = Date.now() - LOOKBACK_DAYS * 86400000;
  const cut3d = Date.now() - 3 * 86400000;
  const bySymbol = new Map();
  const seen = new Set();

  let cursor = start;
  for (let guard = 0; guard < 20; guard++) {
    const rows = await papiGet("/papi/v1/um/income", {
      incomeType: "FUNDING_FEE", startTime: cursor, endTime: Date.now(), limit: 1000,
    });
    if (!rows?.length) break;

    for (const r of rows) {
      // 同毫秒多条，靠 tranId 去重；翻页时 startTime 不 +1，否则会漏掉同毫秒的记录
      const id = `${r.tranId}-${r.symbol}-${r.time}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const inc = parseFloat(r.income || "0");
      const e = bySymbol.get(r.symbol) || { d3: 0, d7: 0 };
      e.d7 += inc;
      if (Number(r.time) >= cut3d) e.d3 += inc;
      bySymbol.set(r.symbol, e);
    }

    const last = rows[rows.length - 1].time;
    if (rows.length < 1000 || last <= cursor) break;
    cursor = last;
  }
  return bySymbol;
}

/** HL 已实现资金费：按 coin 聚合 3d / 7d（USDC） */
async function fetchHlFundingIncome() {
  const start = Date.now() - LOOKBACK_DAYS * 86400000;
  const cut3d = Date.now() - 3 * 86400000;
  const byCoin = new Map();
  const seen = new Set();

  let cursor = start;
  for (let guard = 0; guard < 20; guard++) {
    const rows = await hlInfo({ type: "userFunding", user: HL_ADDR, startTime: cursor });
    if (!rows?.length) break;

    for (const r of rows) {
      const d = r.delta || {};
      const id = `${r.time}-${d.coin}-${d.usdc}`;
      if (seen.has(id)) continue;
      seen.add(id);

      // HL 的 usdc 是"用户收到的钱"：空头收资金费时为正，与 Binance income 同号
      const inc = parseFloat(d.usdc || "0");
      const e = byCoin.get(d.coin) || { d3: 0, d7: 0 };
      e.d7 += inc;
      if (Number(r.time) >= cut3d) e.d3 += inc;
      byCoin.set(d.coin, e);
    }

    const last = rows[rows.length - 1].time;
    if (rows.length < 500 || last <= cursor) break;
    cursor = last; // 同上：不 +1，靠去重
  }
  return byCoin;
}

/* ── Lighter LIT 质押 ──
   收益是自动复投进 effective_lit_stakes 的，接口只给当前质押量、不给流水，
   所以自己按时间序列存快照，用「当前 − N 天前」的增量倒推真实收益。 */

const LIGHTER_BASE = "https://mainnet.zklighter.elliot.ai";
const LIGHTER_TOKEN = process.env.EB65_LIGHTER_TOKEN;
const LIGHTER_IDX = process.env.EB65_LIGHTER_ACCOUNT_INDEX;
const STAKE_FILE = path.join(__dirname, "..", "data", "lighter-stake-history.json");
const STAKE_KEEP_DAYS = 30;

/** token 形如 ro:<idx>:single:<exp>:<hash>，过期后接口直接 401，提前喊一声 */
function lighterTokenDaysLeft() {
  const p = String(LIGHTER_TOKEN || "").split(":");
  if (p.length < 5 || !/^\d+$/.test(p[3])) return null;
  return (Number(p[3]) * 1000 - Date.now()) / 86400000;
}

function readStakeHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(STAKE_FILE, "utf-8"));
    return Array.isArray(j.samples) ? j.samples : [];
  } catch (e) {
    return [];
  }
}

function writeStakeHistory(samples) {
  const cutoff = Date.now() - STAKE_KEEP_DAYS * 86400000;
  const kept = samples.filter(s => s.time >= cutoff);
  fs.mkdirSync(path.dirname(STAKE_FILE), { recursive: true });
  fs.writeFileSync(STAKE_FILE, JSON.stringify({ samples: kept }, null, 0));
  return kept;
}

/** 当前质押量 + 落一条快照，返回 { lit, samples } */
async function fetchLighterStake() {
  if (!LIGHTER_TOKEN || !LIGHTER_IDX) return null;

  const left = lighterTokenDaysLeft();
  if (left !== null && left < 0) {
    log("[lighter] token 已过期，LIT 质押跳过；到 AWS secret hlp-eb65 换 eb651_lighter_readonly");
    return null;
  }
  if (left !== null && left < 7) log(`[lighter] token 还剩 ${left.toFixed(1)} 天，记得轮换`);

  const res = await axios.get(`${LIGHTER_BASE}/api/v1/accountLimits`, {
    params: { account_index: LIGHTER_IDX },
    headers: { Accept: "application/json", Authorization: LIGHTER_TOKEN },
    timeout: 15000,
  });
  const lit = parseFloat(res.data?.effective_lit_stakes || "0");
  if (!Number.isFinite(lit) || lit <= 0) return null;

  const samples = readStakeHistory();
  const last = samples[samples.length - 1];
  // 同一个 10 分钟轮次里质押量没变就不重复落点，省得序列被无效点撑大
  if (!last || last.lit !== lit || Date.now() - last.time > 3600000) {
    samples.push({ time: Date.now(), lit });
  }
  return { lit, samples: writeStakeHistory(samples) };
}

/**
 * 质押增量 → 真实收益。
 * 快照攒不够窗口长度时不硬凑，返回 null 让前端显示 —，并带上实际覆盖天数。
 */
function stakeGain(samples, currentLit, days) {
  if (!samples?.length) return { gain: null, coveredDays: 0 };
  const cutoff = Date.now() - days * 86400000;
  const inWindow = samples.filter(s => s.time >= cutoff);
  const base = inWindow.length ? inWindow[0] : null;
  if (!base) return { gain: null, coveredDays: 0 };

  const coveredDays = (Date.now() - base.time) / 86400000;
  // 覆盖不足窗口一半就别给数了，否则"7d 收益"其实只是几小时
  if (coveredDays < days * 0.5) return { gain: null, coveredDays };
  return { gain: currentLit - base.lit, coveredDays };
}

let slowCache = { ts: 0, earnPos: new Map(), earnRewards: new Map(), bnFunding: new Map(), hlFunding: new Map(), lighter: null };

/** 收益流水 10 分钟拉一轮；任一路失败就沿用上一轮的值，不让整表塌掉 */
async function getRealizedData() {
  if (slowCache.ts && Date.now() - slowCache.ts < SLOW_INTERVAL_MS) return slowCache;

  const [earnPos, earnRewards, bnFunding, hlFunding, lighter] = await Promise.allSettled([
    KEY && SECRET ? fetchEarnPositions() : Promise.resolve(new Map()),
    KEY && SECRET ? fetchEarnRewards() : Promise.resolve(new Map()),
    KEY && SECRET ? fetchBinanceFundingIncome() : Promise.resolve(new Map()),
    HL_ADDR ? fetchHlFundingIncome() : Promise.resolve(new Map()),
    fetchLighterStake(),
  ]);

  const pick = (r, prev, label) => {
    if (r.status === "fulfilled") return r.value;
    log(`[realized] ${label} 失败，沿用上轮:`, r.reason?.response?.data?.msg || r.reason?.message);
    return prev;
  };

  slowCache = {
    ts: Date.now(),
    earnPos: pick(earnPos, slowCache.earnPos, "earn positions"),
    earnRewards: pick(earnRewards, slowCache.earnRewards, "earn rewards"),
    bnFunding: pick(bnFunding, slowCache.bnFunding, "binance funding income"),
    hlFunding: pick(hlFunding, slowCache.hlFunding, "hl funding"),
    lighter: pick(lighter, slowCache.lighter, "lighter LIT stake"),
  };
  return slowCache;
}

/** 1000RATS 这类乘数合约：markPrice 是 N 个币的价，换算现货单价要除掉倍数 */
function multiplierOf(base) {
  const m = base.match(/^(\d+)(.+)$/);
  if (m && parseInt(m[1], 10) >= 1000) return { mult: parseInt(m[1], 10), spot: m[2].toUpperCase() };
  return { mult: 1, spot: base.toUpperCase() };
}

/* ────────────── 组装 ────────────── */

/** 按当前名义价值折算的资金费收支：空头收正费率为正，多头相反 */
function dailyFunding(p) {
  if (p.fundingRate === null || p.fundingRate === undefined) return null;
  const cycles = p.fundingIntervalHours > 0 ? 24 / p.fundingIntervalHours : 3;
  const sign = p.side === "SHORT" ? 1 : -1;
  return sign * p.fundingRate * p.notional * cycles;
}

/** 站在持仓方向上的资金费年化：多头付费为负 */
function fundingApr(p) {
  if (p.fundingRate === null || p.fundingRate === undefined) return null;
  const cycles = p.fundingIntervalHours > 0 ? 24 / p.fundingIntervalHours : 3;
  const sign = p.side === "SHORT" ? 1 : -1;
  return sign * p.fundingRate * cycles * 365 * 100;
}

async function collect() {
  const started = Date.now();
  const [bn, hl, realized] = await Promise.all([
    fetchBinancePositions(),
    fetchHyperliquidPositions(),
    getRealizedData().catch(e => {
      log("[realized] 整体失败:", e.message);
      return slowCache;
    }),
  ]);

  const positions = [...bn.positions, ...hl.positions].map(p => {
    const { mult, spot } = multiplierOf(p.base);
    const spotPrice = mult > 1 && p.markPrice ? p.markPrice / mult : p.markPrice;

    // B 腿：真实到账的资金费
    const fundKey = p.exchange === "Hyperliquid" ? p.base : p.symbol;
    const fundSrc = p.exchange === "Hyperliquid" ? realized.hlFunding : realized.bnFunding;
    const fund = fundSrc.get(fundKey) || null;

    // A 腿：现货躺在活期理财里真实拿到的派息（币本位 × 现货单价）
    const rw = realized.earnRewards.get(spot) || null;
    const pos = realized.earnPos.get(spot) || null;

    // LIT 的 A 腿不在交易所理财，而是质押在 Lighter，收益复投进质押量里
    const lit = spot === "LIT" ? realized.lighter : null;
    const litG3 = lit ? stakeGain(lit.samples, lit.lit, 3) : null;
    const litG7 = lit ? stakeGain(lit.samples, lit.lit, 7) : null;

    return {
      ...p,
      id: `${p.exchange}-${p.account}-${p.symbol}`,
      dailyFunding: dailyFunding(p),
      fundingApr: fundingApr(p),
      // 已实现，非估算
      realizedFunding3d: fund ? fund.d3 : null,
      realizedFunding7d: fund ? fund.d7 : null,
      earnRewards3d: lit
        ? (litG3.gain !== null && spotPrice ? litG3.gain * spotPrice : null)
        : rw && spotPrice ? rw.d3 * spotPrice : null,
      earnRewards7d: lit
        ? (litG7.gain !== null && spotPrice ? litG7.gain * spotPrice : null)
        : rw && spotPrice ? rw.d7 * spotPrice : null,
      earnBalance: lit
        ? (spotPrice ? lit.lit * spotPrice : null)
        : pos && spotPrice ? pos.amount * spotPrice : null,
      earnAsset: lit ? spot : pos || rw ? spot : null,
      earnSource: lit ? "lighter stake" : pos || rw ? "binance earn" : null,
      // 快照攒够之前如实标出实际覆盖天数，别让人以为是完整 7 天
      earnCoveredDays3d: lit ? litG3.coveredDays : null,
      earnCoveredDays7d: lit ? litG7.coveredDays : null,
    };
  });

  positions.sort((a, b) => b.notional - a.notional);

  const sum = (f) => positions.reduce((s, p) => s + (f(p) || 0), 0);
  const payload = {
    updatedAt: Date.now(),
    errors: [bn.error && `Binance: ${bn.error}`, hl.error && `Hyperliquid: ${hl.error}`].filter(Boolean),
    summary: {
      count: positions.length,
      grossNotional: sum(p => p.notional),
      netNotional: sum(p => (p.side === "LONG" ? p.notional : -p.notional)),
      longNotional: sum(p => (p.side === "LONG" ? p.notional : 0)),
      shortNotional: sum(p => (p.side === "SHORT" ? p.notional : 0)),
      unrealizedPnl: sum(p => p.unrealizedPnl),
      dailyFunding: sum(p => p.dailyFunding),
      // 已实现口径：只统计仍有持仓的币，已平掉的历史收益不计入
      realizedFunding3d: sum(p => p.realizedFunding3d),
      realizedFunding7d: sum(p => p.realizedFunding7d),
      earnRewards3d: sum(p => p.earnRewards3d),
      earnRewards7d: sum(p => p.earnRewards7d),
      earnBalance: sum(p => p.earnBalance),
    },
    positions,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  log(
    `[positions] ${positions.length} 条 (binance ${bn.positions.length} / hl ${hl.positions.length})`,
    `gross ${payload.summary.grossNotional.toFixed(0)}`,
    `7d 实收 funding ${payload.summary.realizedFunding7d.toFixed(2)}`,
    `earn ${payload.summary.earnRewards7d.toFixed(2)}`,
    `${Date.now() - started}ms`
  );
}

async function loop() {
  try {
    await collect();
  } catch (e) {
    log("[positions] 采集异常:", e.message);
  }
  setTimeout(loop, INTERVAL_MS);
}

loop();
