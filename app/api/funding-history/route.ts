import { NextResponse } from 'next/server';
import axios from 'axios';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol');
  const exchange = searchParams.get('exchange');

  if (!symbol || !exchange) {
    return NextResponse.json({ error: 'Missing symbol or exchange' }, { status: 400 });
  }

  try {
    let historyData: { time: number; rate: number }[] = [];
    let constituents: { exchange: string; symbol: string; price: number; weight: number }[] = [];

    if (exchange === 'Binance') {
      // Binance API: GET /fapi/v1/fundingRate
      // Returns latest funding rate history
      const response = await axios.get('https://fapi.binance.com/fapi/v1/fundingRate', {
        params: {
          symbol: symbol,
          limit: 200 // 7d × 24h/1h = 168, 需要至少 168 条
        }
      });
      
      historyData = response.data.map((item: any) => ({
        time: item.fundingTime,
        rate: parseFloat(item.fundingRate)
      }));

      try {
        const constituentsRes = await axios.get('https://fapi.binance.com/fapi/v1/constituents', {
          params: { symbol }
        });
        if (constituentsRes.data?.constituents) {
          constituents = constituentsRes.data.constituents.map((entry: any) => ({
            exchange: entry.exchange,
            symbol: entry.symbol,
            price: parseFloat(entry.price || '0'),
            weight: parseFloat(entry.weight || '0')
          }));
        }
      } catch (err) {
        console.error('Failed to fetch Binance constituents:', err);
      }

    } else if (exchange === 'Bybit') {
      // Bybit API: GET /v5/market/funding/history
      const response = await axios.get('https://api.bybit.com/v5/market/funding/history', {
        params: {
          category: 'linear',
          symbol: symbol,
          limit: 200
        }
      });

      if (response.data.retCode === 0 && response.data.result.list) {
        // Bybit returns data in reverse chronological order
        historyData = response.data.result.list.map((item: any) => ({
          time: parseInt(item.fundingRateTimestamp),
          rate: parseFloat(item.fundingRate)
        })).reverse();
      }

    } else if (exchange === 'OKX') {
      // OKX API: GET /api/v5/public/funding-rate-history
      // OKX uses instId format: BTC-USDT-SWAP
      // Convert BTCUSDT -> BTC-USDT-SWAP
      const base = symbol.replace(/USDT$/, '');
      const instId = base + '-USDT-SWAP';
      
      const response = await axios.get('https://www.okx.com/api/v5/public/funding-rate-history', {
        params: {
          instId,
          limit: 200,
        },
        timeout: 10000,
      });

      if (response.data?.data) {
        // OKX returns data in reverse chronological order
        historyData = response.data.data.map((item: any) => ({
          time: parseInt(item.fundingTime || 0),
          rate: parseFloat(item.realizedRate || item.fundingRate || 0),
        })).reverse();
      }
    }

    return NextResponse.json({ success: true, data: historyData, constituents });
  } catch (error) {
    console.error('Failed to fetch funding history:', error);
    return NextResponse.json({ error: 'Failed to fetch history' }, { status: 500 });
  }
}

