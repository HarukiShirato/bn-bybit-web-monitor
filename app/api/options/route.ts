import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const revalidate = 30;

const CACHE_FILE = path.join(process.cwd(), 'data', 'options-cache.json');

/**
 * GET /api/options
 * 读取本地缓存的期权数据（由 options-collector.js 每 5 分钟更新）
 */
export async function GET() {
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return NextResponse.json({
        success: false,
        error: '期权数据尚未采集，请稍候...',
        data: [],
      });
    }

    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cacheData = JSON.parse(raw);

    // 检查数据新鲜度（超过 10 分钟视为过期，但仍返回）
    const age = Date.now() - cacheData.timestamp;
    const stale = age > 10 * 60 * 1000;

    return NextResponse.json({
      success: true,
      data: cacheData.data,
      timestamp: cacheData.timestamp,
      count: cacheData.count,
      stale,
      ageSeconds: Math.round(age / 1000),
    });
  } catch (error) {
    console.error('读取期权缓存失败:', error);
    return NextResponse.json(
      { success: false, error: '读取期权数据失败', data: [] },
      { status: 500 }
    );
  }
}
