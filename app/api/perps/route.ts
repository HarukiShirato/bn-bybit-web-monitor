import { NextResponse } from 'next/server';
import { getBinancePerps } from '@/lib/exchanges/binance';
import { getBybitPerps } from '@/lib/exchanges/bybit';
import { getOkxPerps } from '@/lib/exchanges/okx';
import { getHyperliquidPerps } from '@/lib/exchanges/hyperliquid';
import { getAsterPerps } from '@/lib/exchanges/aster';
import { getBatchMarketDataForSymbols } from '@/lib/marketData';

// ISR: 每 120 秒后台自动重新验证
export const revalidate = 120;
export const maxDuration = 60;

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

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
  exchange: 'Binance' | 'Bybit' | 'OKX' | 'Hyperliquid' | 'Aster'; // 交易所
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
      return NextResponse.json({
        success: true,
        data: cachedPerps.data,
        timestamp: cachedPerps.timestamp,
        cached: true,
      });
    }

    // 并行获取各交易所数据（带超时保护，单个交易所超时不阻塞整体）
    const [binanceData, bybitData, okxData, hlData, asterData] = await Promise.all([
      withTimeout(getBinancePerps(), 25000, []),
      withTimeout(getBybitPerps(), 25000, []),
      withTimeout(getOkxPerps(), 25000, []),
      withTimeout(getHyperliquidPerps(), 25000, []),
      withTimeout(getAsterPerps(), 25000, []),
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


    // 处理 OKX 数据
    okxData.forEach(item => {
      allSymbols.push(item.symbol);
      const fundOiRatio = item.openInterestValue > 0
        ? (item.insuranceFund / item.openInterestValue) * 100
        : 0;

      perpsMap.set(`${item.symbol}-OKX`, {
        symbol: item.symbol,
        exchange: 'OKX',
        price: item.markPrice || item.lastPrice,
        openInterest: item.openInterest,
        openInterestValue: item.openInterestValue,
        insuranceFund: item.insuranceFund,
        fundOiRatio,
        marketCap: null,
        fdv: null,
        volume24h: item.volume24h,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        fundingIntervalHours: item.fundingIntervalHours,
        hasFundingData: item.hasFundingData ?? true,
        hasOpenInterestData: item.hasOpenInterestData ?? true,
      });
    });

    // 处理 Hyperliquid 数据（HL 不公开保险基金，该列恒为 0）
    hlData.forEach(item => {
      allSymbols.push(item.symbol);
      perpsMap.set(`${item.symbol}-Hyperliquid`, {
        symbol: item.symbol,
        exchange: 'Hyperliquid',
        price: item.markPrice || item.lastPrice,
        openInterest: item.openInterest,
        openInterestValue: item.openInterestValue,
        insuranceFund: 0,
        fundOiRatio: 0,
        marketCap: null,
        fdv: null,
        volume24h: item.volume24h,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        fundingIntervalHours: item.fundingIntervalHours,
        hasFundingData: item.hasFundingData ?? true,
        hasOpenInterestData: item.hasOpenInterestData ?? false,
      });
    });

    // 处理 Aster 数据（Aster 不公开保险基金，该列恒为 0；OI 来自采集器文件）
    asterData.forEach(item => {
      allSymbols.push(item.symbol);
      perpsMap.set(`${item.symbol}-Aster`, {
        symbol: item.symbol,
        exchange: 'Aster',
        price: item.markPrice || item.lastPrice,
        openInterest: item.openInterest,
        openInterestValue: item.openInterestValue,
        insuranceFund: 0,
        fundOiRatio: 0,
        marketCap: null,
        fdv: null,
        volume24h: item.volume24h,
        fundingRate: item.fundingRate,
        nextFundingTime: item.nextFundingTime,
        fundingIntervalHours: item.fundingIntervalHours,
        hasFundingData: item.hasFundingData ?? true,
        hasOpenInterestData: item.hasOpenInterestData ?? false,
      });
    });

    // 批量获取市值数据（只获取唯一币种，带超时保护）
    const uniqueSymbols = [...new Set(allSymbols)];
    const marketDataMap = await withTimeout(
      getBatchMarketDataForSymbols(uniqueSymbols),
      15000,
      new Map()
    );

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
