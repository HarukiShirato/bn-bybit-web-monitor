/**
 * Staking Rewards Collector
 * Fetches native staking rates for SKY and HYPE every 8 hours
 * Writes to data/staking-rewards.json
 */
const axios = require("axios");
// Load .env file
const envFile = require("path").join(__dirname, "..", ".env");
try { require("fs").readFileSync(envFile, "utf-8").split("\n").forEach(line => {
  const [k, ...v] = line.split("="); if (k && !k.startsWith("#")) process.env[k.trim()] = v.join("=").trim();
}); } catch {}
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "staking-rewards.json");

async function fetchSkyStaking() {
  try {
    const res = await axios.get("https://info-sky.blockanalitica.com/api/v1/overall/", { timeout: 10000 });
    const overall = Array.isArray(res.data) ? res.data[0] : res.data;
    const apr = parseFloat(overall?.sky_sky_apy || "0");
    if (apr > 0) {
      console.log(`[staking] SKY native staking APY: ${(apr * 100).toFixed(2)}%`);
      return { asset: "SKY", apr, source: "sky-protocol", updatedAt: Date.now() };
    }
  } catch (e) {
    console.error(`[staking] SKY fetch failed: ${e.message}`);
  }
  return null;
}

async function fetchHypeStaking() {
  try {
    const res = await axios.post("https://api.hyperliquid.xyz/info", 
      { type: "validatorSummaries" },
      { headers: { "Content-Type": "application/json" }, timeout: 10000 }
    );
    if (Array.isArray(res.data) && res.data.length > 0) {
      // Get average APR across active validators (use "month" stats for stability)
      const activeValidators = res.data.filter(v => v.isActive && !v.isJailed);
      let totalApr = 0;
      let count = 0;
      for (const v of activeValidators) {
        const monthStats = v.stats?.find(s => s[0] === "month");
        if (monthStats) {
          const apr = parseFloat(monthStats[1].predictedApr || "0");
          if (apr > 0) {
            totalApr += apr;
            count++;
          }
        }
      }
      if (count > 0) {
        const avgApr = totalApr / count;
        console.log(`[staking] HYPE avg staking APR: ${(avgApr * 100).toFixed(2)}% (${count} active validators)`);
        return { asset: "HYPE", apr: avgApr, source: "hyperliquid-validators", updatedAt: Date.now() };
      }
    }
  } catch (e) {
    console.error(`[staking] HYPE fetch failed: ${e.message}`);
  }
  return null;
}

async function fetchLitStaking() {
  try {
    const res = await axios.get("https://mainnet.zklighter.elliot.ai/api/v1/account", {
      params: { by: "index", value: "281474976624800" },
      timeout: 10000,
    });
    const balance = parseFloat(res.data?.accounts?.[0]?.assets?.[0]?.balance || "0");
    if (balance > 0) {
      const apr = 1e7 / balance; // 10M annual reward / totalStaked
      console.log(`[staking] LIT staking APR: ${(apr * 100).toFixed(2)}% (staked: ${(balance / 1e6).toFixed(2)}M LIT)`);
      return { asset: "LIT", apr, source: "lighter-staking", updatedAt: Date.now(), meta: { totalStaked: balance } };
    }
  } catch (e) {
    console.error(`[staking] LIT fetch failed: ${e.message}`);
  }
  return null;
}

async function fetchEthfiStaking() {
  try {
    // sETHFI contract: 0x86B5780b606940Eb59A062aA85a07959518c0161
    // ETHFI token: 0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb
    const RPC = 'https://eth.llamarpc.com';
    const headers = { 'Content-Type': 'application/json' };

    // Get ETHFI balance of sETHFI contract (totalAssets)
    const balRes = await axios.post(RPC, {
      jsonrpc: '2.0', method: 'eth_call', id: 1,
      params: [{ to: '0xfe0c30065b384f05761f15d0cc899d4f9f9cc0eb',
        data: '0x70a0823100000000000000000000000086B5780b606940Eb59A062aA85a07959518c0161' }, 'latest']
    }, { headers, timeout: 15000 });

    // Get sETHFI totalSupply
    const tsRes = await axios.post(RPC, {
      jsonrpc: '2.0', method: 'eth_call', id: 2,
      params: [{ to: '0x86B5780b606940Eb59A062aA85a07959518c0161',
        data: '0x18160ddd' }, 'latest']
    }, { headers, timeout: 15000 });

    const totalAssets = parseInt(balRes.data.result, 16) / 1e18;
    const totalSupply = parseInt(tsRes.data.result, 16) / 1e18;
    const rate = totalAssets / totalSupply;

    // Read previous rate to compute APR from rate change
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch {}
    const prev = existing.ETHFI_sethfi_rate;

  // Save sKAITO rate for APR tracking
  const kaitoResult = results.find(r => r && r.asset === "KAITO");
  if (kaitoResult && kaitoResult.meta) {
    existing.KAITO_skaito_rate = { rate: kaitoResult.meta.rate, time: Date.now() };
  }
    let apr = 0;

    if (prev && prev.rate > 0 && prev.time > 0) {
      const elapsed = (Date.now() - prev.time) / 1000; // seconds
      if (elapsed > 3600) { // need at least 1h of data
        const rateChange = rate / prev.rate - 1;
        apr = rateChange * (365.25 * 24 * 3600) / elapsed;
      }
    }

    // If no previous data or APR is unreasonable, estimate from launch (June 2024)
    if (apr <= 0 || apr > 1) {
      // Launched ~June 2024, rate started at 1.0
      const monthsSinceLaunch = (Date.now() - new Date('2024-06-01').getTime()) / (30.44 * 24 * 3600 * 1000);
      apr = (rate - 1) / monthsSinceLaunch * 12;
    }

    console.log(`[staking] ETHFI sETHFI rate: ${rate.toFixed(6)}, APR: ${(apr * 100).toFixed(2)}%, staked: ${(totalAssets / 1e6).toFixed(2)}M ETHFI`);

    return {
      asset: 'ETHFI',
      apr,
      source: 'sethfi-onchain',
      updatedAt: Date.now(),
      meta: { rate, totalStaked: totalAssets, unstakingDays: 10 },
    };
  } catch (e) {
    console.error('[staking] ETHFI fetch failed:', + e.message);
  }
  return null;
}

async function fetchAaveStaking() {
  const rpcs = ["https://rpc.ankr.com/eth", "https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"];
  const headers = { "Content-Type": "application/json" };
  const stkAAVE = "0x4da27a545c0c5B758a6BA100e3a049001de870f5";
  for (const RPC of rpcs) {
    try {
      const tsRes = await axios.post(RPC, {
        jsonrpc: "2.0", method: "eth_call", id: 1,
        params: [{ to: stkAAVE, data: "0x18160ddd" }, "latest"]
      }, { headers, timeout: 20000 });
      const assetData = "0xf11b8188000000000000000000000000" + stkAAVE.slice(2);
      const adRes = await axios.post(RPC, {
        jsonrpc: "2.0", method: "eth_call", id: 2,
        params: [{ to: stkAAVE, data: assetData }, "latest"]
      }, { headers, timeout: 20000 });
      if (!tsRes.data.result || !adRes.data.result || adRes.data.result === "0x") continue;
      const totalSupply = parseInt(tsRes.data.result, 16) / 1e18;
      const hex = adRes.data.result.slice(2);
      const emissionPerSecond = parseInt(hex.slice(0, 64), 16) / 1e18;
      if (totalSupply > 0 && emissionPerSecond > 0) {
        const apr = emissionPerSecond * 365.25 * 86400 / totalSupply;
        console.log(`[staking] AAVE Safety Module APR: ${(apr * 100).toFixed(2)}% (staked: ${(totalSupply / 1e6).toFixed(2)}M AAVE)`);
        return {
          asset: "AAVE", apr, source: "aave-safety-module", updatedAt: Date.now(),
          meta: { totalStaked: totalSupply, unstakingDays: 20 }
        };
      }
    } catch (e) {
      console.error(`[staking] AAVE fetch failed (${RPC}): ${e.message}`);
    }
  }
  return null;
}

async function fetchPendleStaking() {
  try {
    const res = await axios.get("https://api-v2.pendle.finance/bff/v1/spendle/data", {
      headers: {
        "Origin": "https://app.pendle.finance",
        "Referer": "https://app.pendle.finance/",
      },
      timeout: 15000,
    });
    const data = res.data;
    const apr = parseFloat(data.lastEpochApr || "0");
    if (apr > 0) {
      const totalStaked = parseFloat(data.totalPendleStaked || "0") / 1e18;
      console.log(`[staking] PENDLE sPENDLE APR: ${(apr * 100).toFixed(2)}% (staked: ${(totalStaked / 1e6).toFixed(2)}M PENDLE)`);
      return {
        asset: "PENDLE",
        apr,
        source: "spendle-native",
        updatedAt: Date.now(),
        meta: { totalStaked },
      };
    }
  } catch (e) {
    console.error("[staking] PENDLE fetch failed: " + e.message);
  }
  return null;
}

async function fetchSignStaking() {
  try {
    const RPC = "https://mainnet.base.org";
    const headers = { "Content-Type": "application/json" };
    const stakingContract = "0x7f3437aFb1934A823cF2EAe6279b669cf4f13711";
    const signToken = "0x868fced65edbf0056c4163515dd840e9f287a4c3";

    // getContractParameters() selector = 0xbfacd9ed
    // Returns: (bool paused, address signToken, address nftContract, uint256 aprPrecision, uint256 standardAPR, uint256 boostedAPR, uint256 cooldownPeriod, uint256 interestReserve)
    const [paramsRes, balRes] = await Promise.all([
      axios.post(RPC, {
        jsonrpc: "2.0", method: "eth_call", id: 1,
        params: [{ to: stakingContract, data: "0xbfacd9ed" }, "latest"]
      }, { headers, timeout: 15000 }),
      axios.post(RPC, {
        jsonrpc: "2.0", method: "eth_call", id: 2,
        params: [{ to: signToken, data: "0x70a08231000000000000000000000000" + stakingContract.slice(2) }, "latest"]
      }, { headers, timeout: 15000 }),
    ]);

    if (paramsRes.data.result && paramsRes.data.result.length > 10) {
      const hex = paramsRes.data.result.slice(2);
      const chunks = [];
      for (let i = 0; i < hex.length; i += 64) chunks.push(hex.slice(i, i + 64));

      if (chunks.length >= 8) {
        const aprPrecision = Number(BigInt("0x" + chunks[3]));
        const standardAPR = Number(BigInt("0x" + chunks[4]));
        const cooldownPeriod = Number(BigInt("0x" + chunks[6]));
        const totalStaked = Number(BigInt(balRes.data.result)) / 1e18;
        const apr = standardAPR / aprPrecision;
        const unstakingDays = Math.round(cooldownPeriod / 86400);

        console.log(`[staking] SIGN staking APR: ${(apr * 100).toFixed(2)}% (staked: ${(totalStaked / 1e6).toFixed(2)}M SIGN, cooldown: ${unstakingDays}d)`);
        return {
          asset: "SIGN",
          apr,
          source: "sign-staking-base",
          updatedAt: Date.now(),
          meta: { totalStaked, unstakingDays },
        };
      }
    }
  } catch (e) {
    console.error("[staking] SIGN fetch failed: " + e.message);
  }
  return null;
}

async function fetchKaitoStaking() {
  try {
    // sKAITO contract on Base: 0x548d3b444da39686d1a6f1544781d154e7cd1ef7
    // KAITO token on Base: 0x98d0baa52b2d063e780de12f615f963fe8537553
    const RPC = "https://mainnet.base.org";
    const headers = { "Content-Type": "application/json" };
    const sKAITO = "0x548d3b444da39686d1a6f1544781d154e7cd1ef7";
    const KAITO_TOKEN = "0x98d0baa52b2d063e780de12f615f963fe8537553";

    // Get KAITO balance of sKAITO contract (totalAssets)
    const balRes = await axios.post(RPC, {
      jsonrpc: "2.0", method: "eth_call", id: 1,
      params: [{ to: KAITO_TOKEN,
        data: "0x70a08231000000000000000000000000" + sKAITO.slice(2) }, "latest"]
    }, { headers, timeout: 15000 });

    // Get sKAITO totalSupply
    const tsRes = await axios.post(RPC, {
      jsonrpc: "2.0", method: "eth_call", id: 2,
      params: [{ to: sKAITO,
        data: "0x18160ddd" }, "latest"]
    }, { headers, timeout: 15000 });

    const totalAssets = parseInt(balRes.data.result, 16) / 1e18;
    const totalSupply = parseInt(tsRes.data.result, 16) / 1e18;
    const rate = totalAssets / totalSupply;

    // Read previous rate to compute APR from rate change
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch {}
    const prev = existing.KAITO_skaito_rate;
    let apr = 0;

    if (prev && prev.rate > 0 && prev.time > 0) {
      const elapsed = (Date.now() - prev.time) / 1000;
      if (elapsed > 3600) {
        const rateChange = rate / prev.rate - 1;
        apr = rateChange * (365.25 * 24 * 3600) / elapsed;
      }
    }

    // Fallback: estimate from launch (Feb 2025, rate started at 1.0)
    if (apr <= 0 || apr > 1) {
      const monthsSinceLaunch = (Date.now() - new Date("2025-02-01").getTime()) / (30.44 * 24 * 3600 * 1000);
      if (monthsSinceLaunch > 0) {
        apr = (rate - 1) / monthsSinceLaunch * 12;
      }
    }

    console.log(`[staking] KAITO sKAITO rate: ${rate.toFixed(6)}, APR: ${(apr * 100).toFixed(2)}%, staked: ${(totalAssets / 1e6).toFixed(2)}M KAITO`);

    return {
      asset: "KAITO",
      apr,
      source: "skaito-base-onchain",
      updatedAt: Date.now(),
      meta: { rate, totalStaked: totalAssets, unstakingDays: 7 },
    };
  } catch (e) {
    console.error("[staking] KAITO fetch failed: " + e.message);
  }
  return null;
}

async function fetchSkrStaking() {
  try {
    // SKR (Solana Mobile Seeker) staking on Solana
    // Inflation Program: SKRiHLtLyB8bbhcJ5HBPYMiLh9GcFLdPaSwozqLteha
    // Staking Program: SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ
    // Token Mint: SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3
    // Inflation: 10% Year 1, decays 25%/year, terminal 2%. Epoch: 48h. Unstake cooldown: 48h.
    // APY depends on inflation rate and total staked ratio.
    // Fetch current APY from the staking page's server function
    const res = await axios.get("https://stake.solanamobile.com/assets/Skeleton-BbLBe1yz.js", { timeout: 15000 });
    const js = res.data;

    // Extract guardian APY from JS: apy:0.265 pattern
    const apyMatch = js.match(/apy:\s*([\d.]+)/);
    // Extract total supply info from the inflation page data
    // Fallback: compute from known inflation params
    // Year 1 inflation = 10%, staking ratio ~38% => APY ≈ 10% / 38% ≈ 26.3%
    let apr = 0.258; // default from page stats
    if (apyMatch) {
      apr = parseFloat(apyMatch[1]);
    }

    if (apr > 0) {
      console.log(`[staking] SKR staking APY: ${(apr * 100).toFixed(2)}%`);
      return {
        asset: "SKR",
        apr,
        source: "skr-solana-mobile",
        updatedAt: Date.now(),
        meta: { unstakingDays: 2 },
      };
    }
  } catch (e) {
    console.error("[staking] SKR fetch failed: " + e.message);
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }


async function fetchMarketCaps() {
  const result = {};
  try {
    const res = await axios.get("https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products", {
      params: { includeEtf: true },
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity", "Accept": "application/json" },
      timeout: 15000,
    });
    const items = res.data?.data || [];
    let count = 0;
    for (const item of items) {
      if (!item.s || !item.s.endsWith("USDT")) continue;
      const cs = parseFloat(item.cs || "0");
      const price = parseFloat(item.c || "0");
      if (cs > 0 && price > 0) {
        const base = item.b || item.s.replace("USDT", "");
        result[base] = { mcap: cs * price, price, cs, name: item.an || "" };
        count++;
      }
    }
    console.log("[staking] Market caps: " + count + " tokens from Binance");
  } catch (e) {
    console.error("[staking] Market caps fetch failed: " + e.message);
  }
  return result;
}

async function fetchMcapFallback(existingMcaps) {
  // For tokens not in Binance products, use CryptoCompare as fallback
  // CryptoCompare /data/pricemultifull supports up to ~50 symbols per call
  const allMissing = [];
  // We'll discover missing tokens later when the earn table requests them
  // For now, try a predefined list of commonly missing tokens
  const knownMissing = [
    'SKY','HYPE','SONIC','AERO','ATH','BLAST','BRETT','BTT','BTTC',
    'CORE','CRO','DEEP','DRIFT','ETHW','FLR','GOAT','GRASS','H','HNT',
    'IP','KAS','LIT','MERL','MEW','MNT','MOG','MON','MOODENG','NEIROCTO',
    'NIGHT','OKB','POPCAT','SAFE','SATS','SPX','STRAX','TAIKO',
    'TOMO','TOSHI','XAUT','XDC','ZETA','ZORA','BBSOL'
  ].filter(s => !existingMcaps[s]);

  if (knownMissing.length === 0) return existingMcaps;

  try {
    // CryptoCompare allows ~50 symbols per request
    const batchSize = 50;
    let filled = 0;
    for (let i = 0; i < knownMissing.length; i += batchSize) {
      const batch = knownMissing.slice(i, i + batchSize);
      const res = await axios.get("https://min-api.cryptocompare.com/data/pricemultifull", {
        params: { fsyms: batch.join(","), tsyms: "USD" },
        timeout: 15000,
      });
      const raw = res.data?.RAW || {};
      for (const [sym, currencies] of Object.entries(raw)) {
        const info = currencies.USD || {};
        const mcap = info.MKTCAP || 0;
        const price = info.PRICE || 0;
        const cs = info.CIRCULATINGSUPPLY || 0;
        if (mcap > 0) {
          existingMcaps[sym] = { mcap, price, cs, name: "" };
          filled++;
        }
      }
      if (i + batchSize < knownMissing.length) await sleep(500);
    }
    console.log("[staking] CryptoCompare fallback: filled " + filled + "/" + knownMissing.length + " missing tokens");
  } catch (e) {
    console.error("[staking] CryptoCompare fallback failed: " + e.message);
  }
  return existingMcaps;
}

async function fetchBinanceOI() {
  const result = {};
  try {
    // Get all symbols + prices from premiumIndex
    const res = await axios.get("https://www.binance.com/fapi/v1/premiumIndex", { timeout: 15000 });
    const symbols = res.data.filter(i => i.symbol.endsWith("USDT"));
    const priceMap = {};
    for (const s of symbols) priceMap[s.symbol] = parseFloat(s.markPrice || "0");

    let ok = 0;
    for (const s of symbols) {
      try {
        const oiRes = await axios.get("https://www.binance.com/fapi/v1/openInterest", {
          params: { symbol: s.symbol }, timeout: 5000,
        });
        const qty = parseFloat(oiRes.data?.openInterest || "0");
        const price = priceMap[s.symbol] || 0;
        if (qty > 0 && price > 0) {
          result[s.symbol] = qty * price;
          ok++;
        }
      } catch {}
      await sleep(200);
    }
    console.log("[staking] Binance OI: " + ok + " symbols collected");
  } catch (e) {
    console.error("[staking] Binance OI fetch failed: " + e.message);
  }
  return result;
}


async function fetchBinanceQuota() {
  const result = {};
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) return result;
  const KEY = process.env.BINANCE_API_KEY;
  const SECRET = process.env.BINANCE_API_SECRET;
  const sign = (qs) => require("crypto").createHmac("sha256", SECRET).update(qs).digest("hex");
  try {
    const products = [];
    let page = 1;
    while (true) {
      const ts = Date.now();
      const qs = "current=" + page + "&size=100&timestamp=" + ts;
      const res = await axios.get("https://api.binance.com/sapi/v1/simple-earn/flexible/list?" + qs + "&signature=" + sign(qs),
        { headers: { "X-MBX-APIKEY": KEY }, timeout: 15000 });
      const rows = res.data.rows || [];
      if (rows.length === 0) break;
      for (const r of rows) { if (r.productId && r.asset && r.canPurchase) products.push({ id: r.productId, asset: r.asset }); }
      if (page * 100 >= (res.data.total || 0)) break;
      page++;
      await sleep(300);
    }
    console.log("[staking] Binance products: " + products.length);
    let ok = 0;
    for (let i = 0; i < products.length; i += 5) {
      const batch = products.slice(i, i + 5);
      await Promise.all(batch.map(async (p) => {
        try {
          const ts = Date.now();
          const qs = "productId=" + p.id + "&timestamp=" + ts;
          const res = await axios.get("https://api.binance.com/sapi/v1/simple-earn/flexible/personalLeftQuota?" + qs + "&signature=" + sign(qs),
            { headers: { "X-MBX-APIKEY": KEY }, timeout: 5000 });
          const quota = parseFloat(res.data.leftPersonalQuota || "0");
          if (quota > 0) { result[p.asset] = quota; ok++; }
        } catch {}
      }));
      if (i + 5 < products.length) await sleep(300);
    }
    console.log("[staking] Binance quota: " + ok + "/" + products.length + " with quota");
  } catch (e) { console.error("[staking] Binance quota fetch failed: " + e.message); }
  return result;
}
async function collect() {
  console.log(`[staking] Starting collection at ${new Date().toISOString()}`);
  
  // Read existing data
  let existing = {};
  try {
    if (fs.existsSync(DATA_FILE)) {
      existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }
  } catch (e) {
    console.error(`[staking] Failed to read existing data: ${e.message}`);
  }

  const results = await Promise.all([fetchSkyStaking(), fetchHypeStaking(), fetchLitStaking(), fetchEthfiStaking(), fetchAaveStaking(), fetchPendleStaking(), fetchSignStaking(), fetchSkrStaking(), fetchKaitoStaking()]);
  
  for (const r of results) {
    if (r) {
      const entry = { apr: r.apr, source: r.source, updatedAt: r.updatedAt };
      if (r.meta) entry.meta = r.meta;
      existing[r.asset] = entry;
    }
  }
  

  // Save sETHFI rate for APR tracking
  const ethfiResult = results.find(r => r && r.asset === 'ETHFI');
  if (ethfiResult && ethfiResult.meta) {
    existing.ETHFI_sethfi_rate = { rate: ethfiResult.meta.rate, time: Date.now() };

  // Save sKAITO rate for APR tracking
  const kaitoResult = results.find(r => r && r.asset === "KAITO");
  if (kaitoResult && kaitoResult.meta) {
    existing.KAITO_skaito_rate = { rate: kaitoResult.meta.rate, time: Date.now() };
  }
  }

  // Fetch Market Caps
  const marketCaps = await fetchMarketCaps();
  const mcapsWithFallback = await fetchMcapFallback(marketCaps);
  if (Object.keys(mcapsWithFallback).length > 0) {
    existing.marketCaps = mcapsWithFallback;
  }

  // Fetch Binance OI
  const binanceOI = await fetchBinanceOI();
  if (Object.keys(binanceOI).length > 0) {
    existing.binanceOI = binanceOI;
  }


  const binanceQuota = await fetchBinanceQuota();
  if (Object.keys(binanceQuota).length > 0) existing.binanceQuota = binanceQuota;
  existing.collectedAt = Date.now();
  
  // Ensure data dir exists
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
  console.log(`[staking] Saved to ${DATA_FILE}`);
}

// Run immediately on start
collect().then(() => {
  console.log("[staking] Initial collection done");
});

// Then every 8 hours
setInterval(() => {
  collect().catch(e => console.error("[staking] Collection error:", e.message));
}, 8 * 60 * 60 * 1000);

console.log("[staking] Collector started, interval: 8 hours");
