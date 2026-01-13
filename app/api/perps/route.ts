import { NextResponse } from 'next/server';
import { getBinancePerps } from '@/lib/exchanges/binance';
import { getBybitPerps } from '@/lib/exchanges/bybit';
import { getBatchMarketDataForSymbols } from '@/lib/marketData';

// 简单的进程级缓存，降低对上游 API 的压力
const CACHE_TTL_MS = 60 * 1000; // 60s
let cachedPerps: { data: PerpData[]; timestamp: number } | null = null;
let cachedPerpsDateKey: string | null = null;

const getDateKey = (timestamp: number) => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * 统一的永续合约数据接口
 * 聚合 Binance、Bybit 和市值数据
 */
export interface PerpData {
  symbol: string; // 合约符号
  exchange: 'Binance' | 'Bybit'; // 交易所
  price: number; // 合约价格（优先使用标记价格）
  openInterest: number; // 未平仓量（张数）
  openInterestValue: number; // 未平仓名义价值（USDT）
  insuranceFund: number; // 保险基金余额（USDT）
  fundOiRatio: number; // 保险基金/OI 比例（百分比）
  marketCap: number | null; // 市值（USD）
  fdv: number | null; // 完全稀释估值（USD）
  volume24h: number; // 24小时成交额 (USDT)
  fundingRate: number; // 资金费率
  nextFundingTime: number; // 下次资金费率结算时间 (timestamp)
  fundingIntervalHours: number; // 资金费率结算间隔（小时）
  coinName?: string; // 币种名称
  coinImage?: string; // 币种图标
  hasFundingData?: boolean; // 是否拿到 funding/premium 数据
  hasOpenInterestData?: boolean; // 是否拿到 OI 数据
}

/**
 * GET /api/perps
 * 获取所有永续合约数据
 */
export async function GET() {
  try {
    const now = Date.now();
    const todayKey = getDateKey(now);
    if (cachedPerpsDateKey && cachedPerpsDateKey !== todayKey) {
      cachedPerps = null;
      cachedPerpsDateKey = null;
    }
    if (cachedPerps && now - cachedPerps.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(
        {
          success: true,
          data: cachedPerps.data,
          timestamp: cachedPerps.timestamp,
          cached: true,
        },
        {
          headers: {
            'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
          },
        }
      );
    }

    // 并行获取各交易所数据
    const [binanceData, bybitData] = await Promise.all([
      getBinancePerps(),
      getBybitPerps(),
    ]);

    // 合并数据并转换为统一格式
    const allSymbols: string[] = [];
    const perpsMap = new Map<string, PerpData>();

    // 处理 Binance 数据
    binanceData.forEach(item => {
      allSymbols.push(item.symbol);
      const fundOiRatio = item.openInterestValue > 0
        ? (item.insuranceFund / item.openInterestValue) * 100
        : 0;

      perpsMap.set(`${item.symbol}-Binance`, {
        symbol: item.symbol,
        exchange: 'Binance',
        price: item.markPrice || item.lastPrice,
        openInterest: item.openInterest,
        openInterestValue: item.openInterestValue,
        insuranceFund: item.insuranceFund,
        fundOiRatio,
        marketCap: null, // 异步填充
        fdv: null, // 异步填充
        volume24h: item.volume24h,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        fundingIntervalHours: item.fundingIntervalHours,
        hasFundingData: item.hasFundingData ?? true,
        hasOpenInterestData: item.hasOpenInterestData ?? true,
      });
    });

    // 处理 Bybit 数据
    bybitData.forEach(item => {
      allSymbols.push(item.symbol);
      const fundOiRatio = item.openInterestValue > 0
        ? (item.insuranceFund / item.openInterestValue) * 100
        : 0;

      perpsMap.set(`${item.symbol}-Bybit`, {
        symbol: item.symbol,
        exchange: 'Bybit',
        price: item.markPrice || item.lastPrice,
        openInterest: item.openInterest,
        openInterestValue: item.openInterestValue,
        insuranceFund: item.insuranceFund,
        fundOiRatio,
        marketCap: null, // 异步填充
        fdv: null, // 异步填充
        volume24h: item.volume24h,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        fundingIntervalHours: item.fundingIntervalHours,
        hasFundingData: item.hasFundingData ?? true,
        hasOpenInterestData: item.hasOpenInterestData ?? true,
      });
    });

    // 批量获取市值数据（只获取唯一币种）
    const uniqueSymbols = [...new Set(allSymbols)];
    const marketDataMap = await getBatchMarketDataForSymbols(uniqueSymbols);

    // 填充市值数据
    perpsMap.forEach((perp, key) => {
      const marketData = marketDataMap.get(perp.symbol);
      if (marketData) {
        perp.marketCap = marketData.marketCap;
        perp.fdv = marketData.fdv;
        perp.coinName = marketData.name;
        perp.coinImage = marketData.image;
      }
    });

    // 转换为数组
    const result = Array.from(perpsMap.values());

    // 写入缓存
    cachedPerps = { data: result, timestamp: now };
    cachedPerpsDateKey = todayKey;

    return NextResponse.json({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('获取永续合约数据失败:', error);
    return NextResponse.json(
      {
        success: false,
        error: '获取数据失败',
        data: [],
      },
      { status: 500 }
    );
  }
}
