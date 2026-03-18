// Arbitrage data fetcher – mirrors Python scripts on EC2-2
// Supports: sENA/ENA, stATOM/ATOM, stTIA/TIA

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
  timestamp: string;
}

const ARB_CACHE_TTL = 120_000; // 2 min
let arbCache: { data: Map<string, ArbitrageInfo>; ts: number } | null = null;

// Longer cache for Etherscan official rate (expensive to fetch)
let enaOfficialRateCache: { rate: number; ts: number } | null = null;
const OFFICIAL_RATE_TTL = 30 * 60 * 1000; // 30 min

// ── Token addresses ──
const ENA_ADDRESS = "0x57e114B691Db790C35207b2e685D4a43181e6061";
const SENA_ADDRESS = "0x8bE3460A480c80728a8C4D7a5D5303c85ba7B3b9";
const ETHERSCAN_API_KEY = "CD4HDMV928HCRFBU7FZ3X5JVVFP4EVUG9B";
const COOLDOWN_RECEIVER = "0x4655b6a10c83d6beff1dc7116436cfd8b4f8d48a";

// ── ENA: KyberSwap + Etherscan ──
async function fetchEnaOfficialRate(): Promise<number | null> {
  if (enaOfficialRateCache && Date.now() - enaOfficialRateCache.ts < OFFICIAL_RATE_TTL) {
    return enaOfficialRateCache.rate;
  }
  try {
    const txResp = await fetch(
      `https://api.etherscan.io/v2/api?module=account&action=txlist&chainid=1&address=${SENA_ADDRESS}&page=1&offset=50&sort=desc&apikey=${ETHERSCAN_API_KEY}`,
      { signal: AbortSignal.timeout(10000) }
    );
    const txData = await txResp.json();
    if (txData.status !== "1" || !Array.isArray(txData.result)) return null;

    for (const tx of txData.result) {
      const rResp = await fetch(
        `https://api.etherscan.io/v2/api?module=proxy&action=eth_getTransactionReceipt&chainid=1&txhash=${tx.hash}&apikey=${ETHERSCAN_API_KEY}`,
        { signal: AbortSignal.timeout(10000) }
      );
      const rData = await rResp.json();
      const receipt = rData?.result;
      if (!receipt?.logs) continue;

      let senaBurn = 0;
      let enaIn = 0;
      const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      for (const log of receipt.logs) {
        const topics: string[] = log.topics || [];
        if (topics.length !== 3 || topics[0] !== TRANSFER) continue;
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
        const rate = senaBurn / enaIn; // sENA per ENA (< 1)
        enaOfficialRateCache = { rate, ts: Date.now() };
        console.log(`[arbitrage] ENA official rate: ${rate.toFixed(6)}`);
        return rate;
      }
    }
  } catch (e) {
    console.error("[arbitrage] ENA official rate fetch failed:", e);
  }
  return enaOfficialRateCache?.rate ?? null;
}

async function fetchEnaArbitrage(): Promise<ArbitrageInfo | null> {
  try {
    const investAmount = 200000;
    const amountInWei = (BigInt(investAmount) * 10n ** 18n).toString();

    // 1. Market rate from KyberSwap
    const routeResp = await fetch(
      `https://aggregator-api.kyberswap.com/ethereum/api/v1/routes?tokenIn=${ENA_ADDRESS}&tokenOut=${SENA_ADDRESS}&amountIn=${amountInWei}&gasInclude=true`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
    );
    const routeData = await routeResp.json();
    if (!routeData?.data?.routeSummary) {
      console.error("[arbitrage] ENA KyberSwap no route");
      return null;
    }
    const senaReceived = Number(BigInt(routeData.data.routeSummary.amountOut)) / 1e18;

    // 2. Official rate from Etherscan
    const officialRate = await fetchEnaOfficialRate();
    if (!officialRate) return null;

    const redeemAmount = senaReceived / officialRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 7;
    const apr = (profit / investAmount) * (365 / redeemDays);

    return {
      asset: "ENA",
      investAmount,
      swapToken: "SENA",
      swapAmount: Math.round(senaReceived * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr,
      redeemDays,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[arbitrage] ENA fetch failed:", e);
    return null;
  }
}

// ── ATOM: Osmosis + Stride ──
async function fetchAtomArbitrage(): Promise<ArbitrageInfo | null> {
  try {
    const investAmount = 3000;

    const [strideResp, osmosisResp] = await Promise.all([
      fetch(
        "https://stride-strd-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone/cosmoshub-4",
        { signal: AbortSignal.timeout(10000) }
      ),
      fetch(
        `https://sqsprod.osmosis.zone/router/quote?tokenIn=${investAmount * 1e6}ibc%2F27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2&tokenOutDenom=ibc%2FC140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
      ),
    ]);

    const strideData = await strideResp.json();
    const redemptionRate = parseFloat(strideData?.host_zone?.redemption_rate);
    if (!redemptionRate || isNaN(redemptionRate)) return null;

    const osmosisData = await osmosisResp.json();
    const statomAmount = parseInt(osmosisData.amount_out) / 1e6;
    if (!statomAmount || isNaN(statomAmount)) return null;

    const redeemAmount = statomAmount * redemptionRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 24;
    const apr = (profit / investAmount) * (365 / redeemDays);

    return {
      asset: "ATOM",
      investAmount,
      swapToken: "STATOM",
      swapAmount: Math.round(statomAmount * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr,
      redeemDays,
      officialRate: Math.round(redemptionRate * 10000) / 10000,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[arbitrage] ATOM fetch failed:", e);
    return null;
  }
}

// ── TIA: Osmosis + Stride ──
async function fetchTiaArbitrage(): Promise<ArbitrageInfo | null> {
  try {
    const investAmount = 1000;

    const [strideResp, osmosisResp] = await Promise.all([
      fetch(
        "https://stride-strd-api.polkachu.com/Stride-Labs/stride/stakeibc/host_zone/celestia",
        { signal: AbortSignal.timeout(10000) }
      ),
      fetch(
        `https://sqsprod.osmosis.zone/router/quote?tokenIn=${investAmount * 1e6}ibc%2FD79E7D83AB399BFFF93433E54FAA480C191248FC556924A2A8351AE2638B3877&tokenOutDenom=ibc%2F698350B8A61D575025F3ED13E9AC9C0F45C89DEFE92F76D5838F1D3C1A7FF7C9`,
        { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10000) }
      ),
    ]);

    const strideData = await strideResp.json();
    const officialRate = parseFloat(strideData?.host_zone?.last_redemption_rate);
    if (!officialRate || isNaN(officialRate)) return null;

    const osmosisData = await osmosisResp.json();
    const sttiaAmount = parseInt(osmosisData.amount_out) / 1e6;
    if (!sttiaAmount || isNaN(sttiaAmount)) return null;

    const redeemAmount = sttiaAmount * officialRate;
    const profit = redeemAmount - investAmount;
    const redeemDays = 24;
    const apr = (profit / investAmount) * (365 / redeemDays);

    return {
      asset: "TIA",
      investAmount,
      swapToken: "STTIA",
      swapAmount: Math.round(sttiaAmount * 100) / 100,
      redeemAmount: Math.round(redeemAmount * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      apr,
      redeemDays,
      officialRate: Math.round(officialRate * 10000) / 10000,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    console.error("[arbitrage] TIA fetch failed:", e);
    return null;
  }
}

/**
 * Returns Map<asset, ArbitrageInfo> for all arbitrage opportunities
 * Cached for 2 minutes (ENA official rate cached 30 min separately)
 */
export async function getArbitrageMap(): Promise<Map<string, ArbitrageInfo>> {
  if (arbCache && Date.now() - arbCache.ts < ARB_CACHE_TTL) return arbCache.data;

  const results = await Promise.all([
    fetchEnaArbitrage().catch(() => null),
    fetchAtomArbitrage().catch(() => null),
    fetchTiaArbitrage().catch(() => null),
  ]);

  const map = new Map<string, ArbitrageInfo>();
  for (const r of results) {
    if (r) map.set(r.asset, r);
  }

  console.log(`[arbitrage] Loaded ${map.size} arbitrage rates: ${Array.from(map.keys()).join(", ")}`);
  arbCache = { data: map, ts: Date.now() };
  return map;
}
