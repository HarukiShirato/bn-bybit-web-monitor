import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const DATA_FILE = path.join(process.cwd(), 'data', 'funding-history.json');

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const asset = searchParams.get('asset');
  if (!asset) {
    return NextResponse.json({ error: 'Missing asset' }, { status: 400 });
  }

  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    const symbol = asset.toUpperCase() + 'USDT';
    const result: Record<string, { time: number; rate: number }[]> = {};

    for (const exch of ['binance', 'bybit', 'hyperliquid']) {
      const entry = raw[exch]?.[symbol];
      if (!entry) continue;

      let rates: { time: number; rate: number }[] = [];
      if (Array.isArray(entry)) {
        rates = entry;
      } else if (entry.rates && Array.isArray(entry.rates)) {
        rates = entry.rates;
      }

      // Sort by time desc, take latest 4
      rates.sort((a, b) => b.time - a.time);
      result[exch] = rates.slice(0, 4).reverse(); // chronological order
    }

    return NextResponse.json({ success: true, data: result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
