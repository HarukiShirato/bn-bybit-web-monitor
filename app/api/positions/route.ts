import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getFundingWindowMap } from '@/lib/fundingWindows';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** positions-collector 每 60s 重写这个文件，这里只读不拉 */
const FILE = path.join(process.cwd(), 'data', 'positions-eb65.json');

export async function GET() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    const windows = getFundingWindowMap();

    // 3d/7d 是市场费率的年化，跟当期一样要按持仓方向取号：正数 = 这笔仓位在收费
    const positions = (raw.positions || []).map((p: any) => {
      const w = windows.get(`${p.exchange}:${p.symbol}`);
      const sign = p.side === 'SHORT' ? 1 : -1;
      return {
        ...p,
        fundingApr3d: w?.apr3d != null ? sign * w.apr3d : null,
        fundingApr7d: w?.apr7d != null ? sign * w.apr7d : null,
      };
    });

    return NextResponse.json({
      success: true,
      data: positions,
      summary: raw.summary || null,
      updatedAt: raw.updatedAt || null,
      errors: raw.errors || [],
    });
  } catch (e: any) {
    console.error('[positions] 读取失败:', e.message);
    return NextResponse.json(
      { success: false, error: 'positions cache unavailable — check positions-collector' },
      { status: 503 }
    );
  }
}
