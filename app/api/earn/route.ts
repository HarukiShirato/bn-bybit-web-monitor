import { NextResponse } from 'next/server';
import { getBinanceEarnProductsFromFile } from "@/lib/exchanges/binanceEarn";
import { getBybitEarnProducts } from '@/lib/exchanges/bybitEarn';
import { getOkxEarnProducts } from '@/lib/exchanges/okxEarn';
// Market cap now from file (Binance products, collected every 8h)
import { batchGetFundingStats, getOpenInterestMap, ExchangeOI, getVolumeMap, ExchangeVolume } from '@/lib/fundingAggregator';
import { getOkxRealEarnRates } from '@/lib/okxRealEarn';
import { getStakingRewardsMap, getStakingInfoMap, getMarketCapsFromFile, getBinanceQuotaFromFile, getNaviLendingRates } from "@/lib/stakingRewards";
import { getArbitrageMap, ArbitrageInfo } from "@/lib/arbitrageData";

// 跳过构建时预渲染，由进程级缓存 + funding 缓存 控制刷新
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export interface EarnRate {
  exchange: string;
  apr: number;
  apr3d?: number;  // 真实 3d 平均（如有）
  apr7d?: number;  // 真实 7d 平均（如有）
  quota?: number | null;  // 个人申购限额
}

export interface FundingRate {
  exchange: string;
  apr3d: number;
  apr7d: number;
  apr30d: number;
}

export interface CombinedEarnRow {
  asset: string;
  earnRates: EarnRate[];
  bestEarnApr: number;
  bestEarnExchange: string;
  bestEarn3d: number;
  bestEarn7d: number;
  funding: FundingRate[];
  bestFunding3d: number;
  bestFunding7d: number;
  bestFunding30d: number;
  bestFundingExchange3d: string;
  bestFundingExchange7d: string;
  bestFundingExchange30d: string;
  combined3d: number;
  combined7d: number;
  coinImage?: string;
  coinName?: string;
  binanceOI: number | null;
  bybitOI: number | null;
  hyperliquidOI: number | null;
  okxOI: number | null;
  asterOI: number | null;
  binanceVol: number | null;
  bybitVol: number | null;
  hyperliquidVol: number | null;
  okxVol: number | null;
  asterVol: number | null;
  bestVolume: number | null;
  marketCap: number | null;
  stakingApr: number | null;
  stakingUnstakingDays: number | null;
  arbitrage: ArbitrageInfo | null;
}

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const CACHE_TTL_MS = 120 * 1000;
let cachedEarn: { data: CombinedEarnRow[]; timestamp: number } | null = null;

export async function GET() {
  try {
    const now = Date.now();
    if (cachedEarn && now - cachedEarn.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(
        { success: true, data: cachedEarn.data, timestamp: cachedEarn.timestamp, cached: true },
      );
    }

    const [binanceProducts, bybitProducts, okxProducts] = await Promise.all([
      withTimeout(getBinanceEarnProductsFromFile(), 5000, []),
      withTimeout(getBybitEarnProducts(), 25000, []),
      withTimeout(getOkxEarnProducts(), 25000, []),
    ]);

    console.log(`[earn] Binance: ${binanceProducts.length}, Bybit: ${bybitProducts.length}, OKX: ${okxProducts.length}`);

    const EXCLUDED_ASSETS = new Set([
      'BETH',
      'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDP', 'USDD',
      'PYUSD', 'GUSD', 'FRAX', 'LUSD', 'SUSD', 'CUSD', 'EURC', 'EURI',
      'AEUR', 'UST', 'USTC', 'USDE', 'USDJ', 'DOLA', 'GHO', 'CRVUSD',
      'MKUSD', 'USD0',
      'CMETH', 'METH', 'BNSOL', 'RLUSD', 'WBETH', 'WBTC', 'WETH', 'STETH', 'WSTETH', 'CBETH', 'RETH', 'MSOL', 'JITOSOL',
      'U', 'XUSD', 'BBSOL', 'BTTC', 'NEIROCTO', 'USD1',
      'PI', 'IQ', 'ALCX', 'WAN', 'CITY', 'PSG', 'LAZIO', 'BIFI', 'SANTOS', 'OSMO', 'ADX', 'FTT',
    ]);
    const assetMap = new Map<string, Map<string, number>>();

    const addEarn = (asset: string, exchange: string, apr: number) => {
      const key = asset.toUpperCase();
      if (EXCLUDED_ASSETS.has(key)) return;
      if (!assetMap.has(key)) assetMap.set(key, new Map());
      const exchMap = assetMap.get(key)!;
      const existing = exchMap.get(exchange) ?? 0;
      if (apr > existing) {
        exchMap.set(exchange, apr);
      }
    };

    for (const p of binanceProducts) addEarn(p.asset, 'Binance', p.apr);
    for (const p of bybitProducts) addEarn(p.asset, 'Bybit', p.apr);
    for (const p of okxProducts) addEarn(p.asset, 'OKX', p.apr);

    // Navi Lending (DeFiLlama) - Sui 链借贷收益率
    const naviRates = await withTimeout(getNaviLendingRates(), 10000, new Map());
    for (const [symbol, data] of naviRates) {
      addEarn(symbol, 'Navi', data.apr);
    }

    // 有原生质押但没有交易所 earn 的代币也加入列表（确保它们能显示）
    const earlyStakingMap = await withTimeout(getStakingRewardsMap(), 10000, new Map());
    for (const [asset] of earlyStakingMap) {
      if (!EXCLUDED_ASSETS.has(asset) && !assetMap.has(asset)) {
        assetMap.set(asset, new Map());
      }
    }

    const allAssets = Array.from(assetMap.keys());
    const symbols = allAssets.map(a => a + 'USDT');

    // 并行获取：资金费率 + OI + 市值数据 + OKX 真实收益率
    const [fundingMap, oiMap, volMap, marketDataMap, okxRealMap, stakingMap, stakingInfoMap, arbitrageMap, binanceQuotaMap] = await Promise.all([
      withTimeout(batchGetFundingStats(allAssets), 55000, new Map()),
      withTimeout(getOpenInterestMap(allAssets), 55000, new Map()),
      withTimeout(getVolumeMap(allAssets), 55000, new Map()),
      withTimeout(getMarketCapsFromFile(), 10000, new Map()),
      withTimeout(getOkxRealEarnRates(), 15000, new Map()),
      withTimeout(getStakingRewardsMap(), 10000, new Map()),
      withTimeout(getStakingInfoMap(), 10000, new Map()),
      withTimeout(getArbitrageMap(), 25000, new Map()),
      withTimeout(getBinanceQuotaFromFile(), 5000, new Map()),
    ]);

    const rows: CombinedEarnRow[] = [];

    for (const [asset, exchMap] of assetMap.entries()) {
      // 构建 earnRates，OKX 附带真实 3d/7d
      const okxReal = okxRealMap.get(asset);

      const earnRates: EarnRate[] = Array.from(exchMap.entries())
        .map(([exchange, apr]) => {
          const rate: EarnRate = { exchange, apr };
          if (exchange === "Binance") rate.quota = binanceQuotaMap.get(asset) ?? null;
          if (exchange === 'OKX' && okxReal) {
            rate.apr3d = okxReal.apr3d;
            rate.apr7d = okxReal.apr7d;
          }
          return rate;
        })
        .sort((a, b) => b.apr - a.apr);

      const bestEarnApr = earnRates[0]?.apr || 0;
      const bestEarnExchange = earnRates[0]?.exchange || '';

      const fs = fundingMap.get(asset);
      const funding: FundingRate[] = [];
      if (fs) {
        if (fs.binance3d != null || fs.binance7d != null) {
          funding.push({ exchange: 'Binance', apr3d: fs.binance3d ?? 0, apr7d: fs.binance7d ?? 0, apr30d: fs.binance30d ?? 0 });
        }
        if (fs.bybit3d != null || fs.bybit7d != null) {
          funding.push({ exchange: 'Bybit', apr3d: fs.bybit3d ?? 0, apr7d: fs.bybit7d ?? 0, apr30d: fs.bybit30d ?? 0 });
        }
        if (fs.hyperliquid3d != null || fs.hyperliquid7d != null) {
          funding.push({ exchange: 'Hyperliquid', apr3d: fs.hyperliquid3d ?? 0, apr7d: fs.hyperliquid7d ?? 0, apr30d: fs.hyperliquid30d ?? 0 });
        }
        if (fs.okx3d != null || fs.okx7d != null) {
          funding.push({ exchange: 'OKX', apr3d: fs.okx3d ?? 0, apr7d: fs.okx7d ?? 0, apr30d: fs.okx30d ?? 0 });
        }
        if (fs.aster3d != null || fs.aster7d != null) {
          funding.push({ exchange: 'Aster', apr3d: fs.aster3d ?? 0, apr7d: fs.aster7d ?? 0, apr30d: fs.aster30d ?? 0 });
        }
      }

      let bestFunding3d = 0, bestFunding7d = 0, bestFunding30d = 0;
      let bestFundingExchange3d = '', bestFundingExchange7d = '', bestFundingExchange30d = '';
      if (funding.length > 0) {
        bestFunding3d = funding[0].apr3d;
        bestFundingExchange3d = funding[0].exchange;
        bestFunding7d = funding[0].apr7d;
        bestFundingExchange7d = funding[0].exchange;
        bestFunding30d = funding[0].apr30d;
        bestFundingExchange30d = funding[0].exchange;
        for (let i = 1; i < funding.length; i++) {
          if (funding[i].apr3d > bestFunding3d) {
            bestFunding3d = funding[i].apr3d;
            bestFundingExchange3d = funding[i].exchange;
          }
          if (funding[i].apr7d > bestFunding7d) {
            bestFunding7d = funding[i].apr7d;
            bestFundingExchange7d = funding[i].exchange;
          }
          if (funding[i].apr30d > bestFunding30d) {
            bestFunding30d = funding[i].apr30d;
            bestFundingExchange30d = funding[i].exchange;
          }
        }
      }

      // bestEarn3d/7d: 如果有 OKX 真实数据，用真实值参与比较
      // 对于没有真实数据的交易所，3d/7d = 广告 APR
      let bestEarn3d = 0;
      let bestEarn7d = 0;
      for (const er of earnRates) {
        const e3d = er.apr3d ?? er.apr;
        const e7d = er.apr7d ?? er.apr;
        if (e3d > bestEarn3d) bestEarn3d = e3d;
        if (e7d > bestEarn7d) bestEarn7d = e7d;
      }

      const md = marketDataMap.get(asset);

      rows.push({
        asset,
        earnRates,
        bestEarnApr,
        bestEarnExchange,
        bestEarn3d,
        bestEarn7d,
        funding,
        bestFunding3d,
        bestFunding7d,
        bestFunding30d,
        bestFundingExchange3d,
        bestFundingExchange7d,
        bestFundingExchange30d,
        combined3d: Math.max(bestEarn3d, stakingMap.get(asset) ?? 0, arbitrageMap.get(asset)?.apr ?? 0) + bestFunding3d,
        combined7d: Math.max(bestEarn7d, stakingMap.get(asset) ?? 0, arbitrageMap.get(asset)?.apr ?? 0) + bestFunding7d,
        coinImage: undefined,
        coinName: md?.name || undefined,
        binanceOI: oiMap.get(asset)?.binance ?? null,
        bybitOI: oiMap.get(asset)?.bybit ?? null,
        hyperliquidOI: oiMap.get(asset)?.hyperliquid ?? null,
        okxOI: oiMap.get(asset)?.okx ?? null,
        asterOI: oiMap.get(asset)?.aster ?? null,
        binanceVol: volMap.get(asset)?.binance ?? null,
        bybitVol: volMap.get(asset)?.bybit ?? null,
        hyperliquidVol: volMap.get(asset)?.hyperliquid ?? null,
        okxVol: volMap.get(asset)?.okx ?? null,
        asterVol: volMap.get(asset)?.aster ?? null,
        bestVolume: Math.max(
          volMap.get(asset)?.binance ?? 0,
          volMap.get(asset)?.bybit ?? 0,
          volMap.get(asset)?.hyperliquid ?? 0,
          volMap.get(asset)?.okx ?? 0,
          volMap.get(asset)?.aster ?? 0
        ) || null,
        stakingApr: stakingMap.get(asset) ?? null,
        stakingUnstakingDays: stakingInfoMap.get(asset)?.unstakingDays ?? null,
        arbitrage: arbitrageMap.get(asset) ?? null,
        marketCap: md?.mcap ?? null,
      });
    }

    const withFunding = rows.filter(r => r.funding.length > 0).length;
    const withRealEarn = rows.filter(r => r.earnRates.some(e => e.apr3d !== undefined)).length;
    const fundingRatio = rows.length > 0 ? withFunding / rows.length : 1;
    if (fundingRatio > 0.80) {
      cachedEarn = { data: rows, timestamp: now };
      console.log(`[earn] cached (${withFunding}/${rows.length} funding, ${withRealEarn} with real OKX earn)`);
    } else {
      console.log(`[earn] NOT caching (${withFunding}/${rows.length} funding, ${withRealEarn} with real OKX earn)`);
    }

    return NextResponse.json({
      success: true,
      data: rows,
      timestamp: now,
      debug: {
        binance: binanceProducts.length,
        bybit: bybitProducts.length,
        okx: okxProducts.length,
        okxRealAssets: okxRealMap.size,
      },
    });
  } catch (error) {
    console.error('获取活期理财数据失败:', error);
    return NextResponse.json(
      { success: false, error: '获取数据失败', data: [] },
      { status: 500 }
    );
  }
}
