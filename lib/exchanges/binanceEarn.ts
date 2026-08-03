import axios from 'axios';
import crypto from 'crypto';

export interface BinanceEarnProduct {
  asset: string;
  apr: number;
  minPurchaseAmount: number;
  maxPurchaseAmount: number | null;
  canPurchase: boolean;
}

const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';

function signQuery(queryString: string): string {
  return crypto
    .createHmac('sha256', BINANCE_API_SECRET)
    .update(queryString)
    .digest('hex');
}

/**
 * 获取 Binance Simple Earn 活期产品列表
 * 优先使用官方签名 API，无 Key 时回退到 bapi
 */
export async function getBinanceEarnProducts(): Promise<BinanceEarnProduct[]> {
  if (BINANCE_API_KEY && BINANCE_API_SECRET) {
    try {
      return await getBinanceEarnFromSapi();
    } catch (err: any) {
      console.error('Binance SAPI 失败:', err?.message);
    }
  }

  // 回退到 bapi（网站接口，可能被 WAF 拦截）
  try {
    return await getBinanceEarnFromBapi();
  } catch (err: any) {
    console.error('Binance bapi 失败:', err?.message);
  }

  return [];
}

/**
 * 官方签名 API: GET /sapi/v1/simple-earn/flexible/list
 * 需要 BINANCE_API_KEY + BINANCE_API_SECRET
 */
async function getBinanceEarnFromSapi(): Promise<BinanceEarnProduct[]> {
  const results: BinanceEarnProduct[] = [];
  let current = 1;
  const size = 100; // SAPI 最大 100

  while (true) {
    const timestamp = Date.now();
    const queryString = `current=${current}&size=${size}&timestamp=${timestamp}`;
    const signature = signQuery(queryString);

    const response = await axios.get(
      `https://api.binance.com/sapi/v1/simple-earn/flexible/list?${queryString}&signature=${signature}`,
      {
        headers: { 'X-MBX-APIKEY': BINANCE_API_KEY },
        timeout: 15000,
      }
    );

    const rows = response.data?.rows;
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const item of rows) {
      const apr = parseFloat(item.latestAnnualPercentageRate || '0');
      if (apr <= 0) continue;

      results.push({
        asset: item.asset || '',
        apr,
        minPurchaseAmount: parseFloat(item.minPurchaseAmount || '0'),
        maxPurchaseAmount: item.maxPurchaseAmountPerUser
          ? parseFloat(item.maxPurchaseAmountPerUser)
          : null,
        canPurchase: item.canPurchase !== false,
      });
    }

    const total = response.data?.total || 0;
    if (current * size >= total) break;
    current++;

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
}

/**
 * 回退方案：Binance 网站公开 bapi（可能被 AWS IP 拦截）
 */
async function getBinanceEarnFromBapi(): Promise<BinanceEarnProduct[]> {
  const results: BinanceEarnProduct[] = [];
  let current = 1;
  const pageSize = 200;

  while (true) {
    const response = await axios.post(
      'https://www.binance.com/bapi/earn/v2/friendly/finance/product/list',
      {
        asset: '',
        current,
        size: pageSize,
        type: 'ACTIVITY',
        status: 'SUBSCRIBABLE',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/simple-earn',
        },
        timeout: 15000,
      }
    );

    const rows = response.data?.data?.list;
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const item of rows) {
      const apr = parseFloat(
        item.latestAnnualPercentageRate ||
        item.avgAnnualPercentageRate ||
        item.annualPercentageRate ||
        '0'
      );
      if (apr <= 0) continue;

      results.push({
        asset: item.asset || item.productName || '',
        apr,
        minPurchaseAmount: parseFloat(item.minPurchaseAmount || '0'),
        maxPurchaseAmount: item.maxPurchaseAmountPerUser
          ? parseFloat(item.maxPurchaseAmountPerUser)
          : null,
        canPurchase: item.canPurchase !== false,
      });
    }

    const total = response.data?.data?.total || 0;
    if (current * pageSize >= total) break;
    current++;

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return results;
}


/**
 * 从 staking-collector 保存的文件中读取 Binance earn 产品
 * 避免每次 API 请求都调用 SAPI，防止 rate limit
 */
const FILE_CACHE_TTL = 60 * 1000;
let fileCache: { data: BinanceEarnProduct[]; ts: number } | null = null;

export async function getBinanceEarnProductsFromFile(): Promise<BinanceEarnProduct[]> {
  if (fileCache && Date.now() - fileCache.ts < FILE_CACHE_TTL) return fileCache.data;
  try {
    const path = require("path");
    const fs = require("fs");
    const filePath = path.join(process.cwd(), "data", "staking-rewards.json");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const products: BinanceEarnProduct[] = [];
    if (raw.binanceEarnProducts && Array.isArray(raw.binanceEarnProducts)) {
      for (const p of raw.binanceEarnProducts) {
        products.push({
          asset: p.asset || "",
          apr: p.apr || 0,
          minPurchaseAmount: p.minPurchaseAmount || 0,
          maxPurchaseAmount: null,
          canPurchase: p.canPurchase !== false,
        });
      }
    }
    fileCache = { data: products, ts: Date.now() };
    return products;
  } catch (e: any) {
    console.error("[binanceEarn] Failed to read from file:", e?.message);
    // Fallback to live API
    return getBinanceEarnProducts();
  }
}
