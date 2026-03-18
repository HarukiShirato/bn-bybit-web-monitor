/**
 * Arbitrage Data Collector
 * Fetches DEX arbitrage rates for sENA/ENA, stATOM/ATOM, stTIA/TIA
 * Writes to data/arbitrage-data.json
 * Runs on start, then every 8 hours
 */
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "..", "data", "arbitrage-data.json");

// ── ENA: KyberSwap + Etherscan ──
const ENA_ADDRESS = "0x57e114B691Db790C35207b2e685D4a43181e6061";
const SENA_ADDRESS = "0x8bE3460A480c80728a8C4D7a5D5303c85ba7B3b9";
const ETHERSCAN_API_KEY = "CD4HDMV928HCRFBU7FZ3X5JVVFP4EVUG9B";
const COOLDOWN_RECEIVER = "0x4655b6a10c83d6beff1dc7116436cfd8b4f8d48a";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function fetchEnaArbitrage() {
  try {
    const investAmount = 200000;
    const amountInWei = BigInt(investAmount) * 10n ** 18n;
    // 1. Market rate from KyberSwap
    const routeResp = await axios.get(
      "https://aggregator-api.kyberswap.com/ethereum/api/v1/routes",
      {
        params: {
          tokenIn: ENA_ADDRESS,
          tokenOut: SENA_ADDRESS,
          amountIn: amountInWei.toString(),
          gasInclude: "true",
        },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 15000,
      }
    );
    const summary = routeResp.data?.data?.routeSummary;
    if (!summary) { console.error("[arb] ENA: no KyberSwap route"); return null; }
    const senaReceived = Number(BigInt(summary.amountOut)) / 1e18;
    // 2. Official rate from Etherscan tx logs
    const txResp = await axios.get("https://api.etherscan.io/v2/api", {
      params: {
        module: "account", action: "txlist", chainid: 1,
        address: SENA_ADDRESS, page: 1, offset: 50, sort: "desc",
        apikey: ETHERSCAN_API_KEY,
      },
      timeout: 15000,
    });
    if (txResp.data.status !== "1" || !Array.isArray(txResp.data.result)) {
      console.error("[arb] ENA: Etherscan txlist failed");
      return null;
    }

    let officialRate = null;
    for (const tx of txResp.data.result) {
      try {
        const rResp = await axios.get("https://api.etherscan.io/v2/api", {
          params: {
            module: "proxy", action: "eth_getTransactionReceipt", chainid: 1,
            txhash: tx.hash, apikey: ETHERSCAN_API_KEY,
          },
          timeout: 10000,
        });
        const logs = rResp.data?.result?.logs;
        if (!logs) continue;

        let senaBurn = 0, enaIn = 0;
        for (const log of logs) {
          const topics = log.topics || [];
          if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC) continue;
          const contract = (log.address || "").toLowerCase();
          const to = "0x" + topics[2].slice(-40);
          const value = parseInt(log.data, 16) / 1e18;
          if (contract === SENA_ADDRESS.toLowerCase() && to === "0x0000000000000000000000000000000000000000") {
            senaBurn += value;
          }
          if (contract === ENA_ADDRESS.toLowerCase() && to.toLowerCase() === COOLDOWN_RECEIVER.toLowerCase()) {
            enaIn += value;
          }
        }
        if (senaBurn > 0 && enaIn > 0) {
          officialRate = senaBurn / enaIn;
          break;
        }
      } catch (e) {
        // skip this tx, try next
      }
    }

    if (!officialRate) { console.error("[arb] ENA: could not find official rate"); return null; }

    const redeemAmount = senaReceived / officialRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 7;
    const apr = (profit / investAmount) * (365 / redeemDays);

    console.log(`[arb] ENA: swap=${senaReceived.toFixed(2)} SENA, redeem=${redeemAmount.toFixed(2)}, profit=${profit.toFixed(2)}, APR=${(apr * 100).toFixed(2)}%`);
    return {
      asset: "ENA", investAmount,
      swapToken: "SENA",
      swapAmount: Math.round(senaReceived * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr, redeemDays,
      officialRate: Math.round(officialRate * 1000000) / 1000000,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error("[arb] ENA fetch failed:", e.message);
    return null;
  }
}

// ── ATOM: Osmosis + Stride ──
async function fetchAtomArbitrage() {
  try {
    const investAmount = 3000;
    const [strideResp, osmosisResp] = await Promise.all([
      axios.get("https://stride-strd-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone/cosmoshub-4", { timeout: 10000 }),
      axios.get(`https://sqsprod.osmosis.zone/router/quote?tokenIn=${investAmount * 1e6}ibc%2F27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2&tokenOutDenom=ibc%2FC140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901`, {
        headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000,
      }),
    ]);

    const redemptionRate = parseFloat(strideResp.data?.host_zone?.redemption_rate);
    if (!redemptionRate || isNaN(redemptionRate)) { console.error("[arb] ATOM: bad redemption rate"); return null; }

    const statomAmount = parseInt(osmosisResp.data.amount_out) / 1e6;
    if (!statomAmount || isNaN(statomAmount)) { console.error("[arb] ATOM: bad osmosis quote"); return null; }

    const redeemAmount = statomAmount * redemptionRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 24;
    const apr = (profit / investAmount) * (365 / redeemDays);

    console.log(`[arb] ATOM: swap=${statomAmount.toFixed(2)} STATOM, redeem=${redeemAmount.toFixed(2)}, profit=${profit.toFixed(2)}, APR=${(apr * 100).toFixed(2)}%, rate=${redemptionRate.toFixed(4)}`);
    return {
      asset: "ATOM", investAmount,
      swapToken: "STATOM",
      swapAmount: Math.round(statomAmount * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr, redeemDays,
      officialRate: Math.round(redemptionRate * 10000) / 10000,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error("[arb] ATOM fetch failed:", e.message);
    return null;
  }
}

// ── TIA: Osmosis + Stride ──
async function fetchTiaArbitrage() {
  try {
    const investAmount = 1000;
    const [strideResp, osmosisResp] = await Promise.all([
      axios.get("https://stride-strd-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone/celestia", { timeout: 10000 }),
      axios.get(`https://sqsprod.osmosis.zone/router/quote?tokenIn=${investAmount * 1e6}ibc%2FD79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877&tokenOutDenom=ibc%2F698350B8A61D575025F3ED13E9AC9C0F45C89DEFE92F76D5838F1D3C1A7FF7C9`, {
        headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000,
      }),
    ]);

    const officialRate = parseFloat(strideResp.data?.host_zone?.last_redemption_rate);
    if (!officialRate || isNaN(officialRate)) { console.error("[arb] TIA: bad redemption rate"); return null; }

    const sttiaAmount = parseInt(osmosisResp.data.amount_out) / 1e6;
    if (!sttiaAmount || isNaN(sttiaAmount)) { console.error("[arb] TIA: bad osmosis quote"); return null; }

    const redeemAmount = sttiaAmount * officialRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 24;
    const apr = (profit / investAmount) * (365 / redeemDays);

    console.log(`[arb] TIA: swap=${sttiaAmount.toFixed(2)} STTIA, redeem=${redeemAmount.toFixed(2)}, profit=${profit.toFixed(2)}, APR=${(apr * 100).toFixed(2)}%, rate=${officialRate.toFixed(4)}`);
    return {
      asset: "TIA", investAmount,
      swapToken: "STTIA",
      swapAmount: Math.round(sttiaAmount * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr, redeemDays,
      officialRate: Math.round(officialRate * 10000) / 10000,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error("[arb] TIA fetch failed:", e.message);
    return null;
  }
}


// ── APT: amAPT via Thala (Aptos) ──
async function fetchAptArbitrage() {
  try {
    const investAmount = 5000;
    const redeemDays = 14;
    const unstakeRate = 1.0; // 1 amAPT = 1 APT on unstake

    const resp = await axios.get(
      "https://app.thala.fi/api/panora", {
        params: {
          fromTokenAddress: "0x1::aptos_coin::AptosCoin",
          toTokenAddress: "0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::amapt_token::AmnisApt",
          toWalletAddress: "",
          slippagePercentage: "0.5",
          fromTokenAmount: String(investAmount),
        },
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 15000,
      }
    );

    const quotes = resp.data?.data?.quotes;
    if (!quotes || quotes.length === 0) { console.error("[arb] APT: no Thala quotes"); return null; }
    const amaptReceived = parseFloat(quotes[0].toTokenAmount);
    if (!amaptReceived || amaptReceived <= 0) return null;

    const exchangeRate = investAmount / amaptReceived; // APT per amAPT (< 1 means discount)
    const redeemAmount = amaptReceived * unstakeRate;
    const profit = redeemAmount - investAmount;
    const apr = (profit / investAmount) * (365 / redeemDays);

    console.log(`[arb] APT: swap=${amaptReceived.toFixed(2)} AMAPT, redeem=${redeemAmount.toFixed(2)}, profit=${profit.toFixed(2)}, APR=${(apr * 100).toFixed(2)}%, rate=${exchangeRate.toFixed(4)}`);

    return {
      asset: "APT",
      investAmount,
      swapToken: "AMAPT",
      swapAmount: Math.round(amaptReceived * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr,
      redeemDays,
      officialRate: Math.round(exchangeRate * 10000) / 10000,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error("[arb] APT fetch failed:", e.message);
  }
  return null;
}
async function collect() {
  console.log(`[arb] Starting collection at ${new Date().toISOString()}`);

  let existing = {};
  try {
    if (fs.existsSync(DATA_FILE)) {
      existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("[arb] Failed to read existing data:", e.message);
  }

  const results = await Promise.all([
    fetchEnaArbitrage(),
    fetchAtomArbitrage(),
    fetchTiaArbitrage(),
    fetchAptArbitrage(),
  ]);

  for (const r of results) {
    if (r) {
      existing[r.asset] = r;
    }
  }

  existing.collectedAt = Date.now();

  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(DATA_FILE, JSON.stringify(existing, null, 2));
  const count = results.filter(Boolean).length;
  console.log(`[arb] Saved ${count} arbitrage rates to ${DATA_FILE}`);
}

// Run immediately
collect().then(() => {
  console.log("[arb] Initial collection done");
});

// Then every 8 hours
setInterval(() => {
  collect().catch((e) => console.error("[arb] Collection error:", e.message));
}, 1 * 60 * 60 * 1000);

console.log("[arb] Arbitrage collector started, interval: 1 hour");
