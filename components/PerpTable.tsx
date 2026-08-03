'use client';

import { useMemo, useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Cell } from 'recharts';

export interface PerpData {
  symbol: string;
  exchange: 'Binance' | 'Bybit' | 'OKX' | 'Hyperliquid' | 'Aster';
  price: number;
  openInterest: number;
  openInterestValue: number;
  insuranceFund: number;
  fundOiRatio: number;
  marketCap: number | null;
  fdv: number | null;
  volume24h: number;
  fundingRate: number;
  nextFundingTime: number;
  fundingIntervalHours: number;
  coinName?: string;
  coinImage?: string;
  hasFundingData?: boolean;
  hasOpenInterestData?: boolean;
}

type SortKey = keyof PerpData | 'apr' | 'none';
type SortOrder = 'asc' | 'desc';

interface PerpTableProps {
  data: PerpData[];
}

// 按需加载图表组件，避免首屏加载 Recharts 体积
const ResponsiveContainer = dynamic(() => import('recharts').then(mod => mod.ResponsiveContainer), { ssr: false });
const BarChart = dynamic(() => import('recharts').then(mod => mod.BarChart), { ssr: false });
const Bar = dynamic(() => import('recharts').then(mod => mod.Bar), { ssr: false });
const XAxis = dynamic(() => import('recharts').then(mod => mod.XAxis), { ssr: false });
const YAxis = dynamic(() => import('recharts').then(mod => mod.YAxis), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(mod => mod.Tooltip), { ssr: false });
const ReferenceLine = dynamic(() => import('recharts').then(mod => mod.ReferenceLine), { ssr: false });

const Countdown = ({ targetTime }: { targetTime: number }) => {
  const [timeLeft, setTimeLeft] = useState('');

  useEffect(() => {
    const calculateTimeLeft = () => {
      const now = Date.now();
      const diff = targetTime - now;

      if (diff <= 0) {
        return '00m00s';
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
          return `${hours}h${minutes}m`;
      }
      return `${minutes}m${seconds}s`;
    };

    setTimeLeft(calculateTimeLeft());
    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft());
    }, 1000);

    return () => clearInterval(timer);
  }, [targetTime]);

  return <span>{timeLeft}</span>;
};

// 格式化日期
const formatDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:00`;
};

interface FundingTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: number;
  intervalHours: number;
}

const FundingTooltip = ({ active, payload, label, intervalHours }: FundingTooltipProps) => {
  if (active && payload && payload.length) {
    const rate = payload[0].value || 0;
    const hours = intervalHours || 8;
    const cyclesPerDay = hours > 0 ? 24 / hours : 3;
    const apr = rate * cyclesPerDay * 365 * 100;
    
    return (
      <div className="bg-brand-surface border border-brand-border p-3 rounded shadow-lg text-xs z-50 relative">
        <p className="text-brand-text-primary font-bold mb-2 text-sm">{formatDate(label || 0)}</p>
        <div className="space-y-1">
          <p className="flex justify-between gap-4">
            <span className="text-brand-text-secondary">Funding:</span>
            <span className={`font-mono ${rate >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
              {(rate * 100).toFixed(4)}%
            </span>
          </p>
          <p className="flex justify-between gap-4">
            <span className="text-brand-text-secondary">APR ({hours}H):</span>
            <span className={`font-mono ${apr >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
              {apr.toFixed(2)}%
            </span>
          </p>
        </div>
      </div>
    );
  }
  return null;
};

export default function PerpTable({ data }: PerpTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('apr');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  
  // 展开行状态
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<any[]>([]);
  const [constituents, setConstituents] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);

  const handleSort = (key: SortKey) => {
    if (key === 'none') {
      setSortKey('none');
      return;
    }

    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const handleFundingClick = async (symbol: string, exchange: string) => {
    const rowId = `${symbol}-${exchange}`;
    
    // 如果点击的是当前展开的行，则关闭
    if (expandedRow === rowId) {
      setExpandedRow(null);
      setHistoryData([]);
      return;
    }

    setExpandedRow(rowId);
    setLoadingHistory(true);
    setHistoryData([]);
    setConstituents([]);

    try {
      const response = await fetch(`/api/funding-history?symbol=${symbol}&exchange=${exchange}`);
      const result = await response.json();
      
      if (result.success) {
        setHistoryData(result.data || []);
        setConstituents(result.constituents || []);
      }
    } catch (error) {
      console.error('Failed to fetch funding history:', error);
    } finally {
      setLoadingHistory(false);
    }
  };

  const calculateApr = (fundingRate: number, intervalHours: number = 8) => {
    const hours = intervalHours || 8;
    const cyclesPerDay = hours > 0 ? 24 / hours : 3;
    return fundingRate * cyclesPerDay * 365 * 100;
  };

  const sortedData = useMemo(() => {
    const next = [...data];

    next.sort((a, b) => {
      if (sortKey === 'none') return 0;

      let aVal: any;
      let bVal: any;

      if (sortKey === 'apr') {
        aVal = calculateApr(a.fundingRate, a.fundingIntervalHours);
        bVal = calculateApr(b.fundingRate, b.fundingIntervalHours);
      } else {
        aVal = a[sortKey as keyof PerpData];
        bVal = b[sortKey as keyof PerpData];
      }

      if (aVal === null || aVal === undefined) aVal = -Infinity;
      if (bVal === null || bVal === undefined) bVal = -Infinity;

      if (typeof aVal === 'string') {
        return sortOrder === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return next;
  }, [data, sortKey, sortOrder]);

  const pageCount = Math.max(1, Math.ceil(sortedData.length / pageSize));
  const currentPage = Math.min(page, pageCount);

  const pagedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, pageSize, currentPage]);

  useEffect(() => {
    setPage(1);
  }, [pageSize, data, sortKey, sortOrder]);

  const formatNumber = (num: number | null, prefix: string = '', suffix: string = '', decimals: number = 2) => {
     if (num === null || num === undefined) return '—';
     
     if (num >= 1e9) return prefix + (num / 1e9).toFixed(decimals) + 'B' + suffix;
     if (num >= 1e6) return prefix + (num / 1e6).toFixed(decimals) + 'M' + suffix;
     if (num >= 1e3) return prefix + (num / 1e3).toFixed(decimals) + 'K' + suffix;
     return prefix + num.toFixed(decimals) + suffix;
  };

  const formatPercent = (val: number) => {
      return `${(val * 100).toFixed(4)}%`;
  }

  const SortIcon = ({ columnKey }: { columnKey: SortKey }) => {
    const isActive = sortKey === columnKey;
    return (
      <span className={`ml-1 flex flex-col space-y-[2px] ${isActive ? 'opacity-100' : 'opacity-30 group-hover:opacity-60'}`}>
        <svg className={`w-1.5 h-1 ${isActive && sortOrder === 'asc' ? 'text-brand-accent' : 'text-current'}`} fill="currentColor" viewBox="0 0 10 6">
           <path d="M5 0L10 6H0L5 0Z" />
        </svg>
        <svg className={`w-1.5 h-1 ${isActive && sortOrder === 'desc' ? 'text-brand-accent' : 'text-current'}`} fill="currentColor" viewBox="0 0 10 6">
           <path d="M5 6L0 0H10L5 6Z" />
        </svg>
      </span>
    );
  };

  const Th = ({ id, children, align = 'left', className = '' }: { id: SortKey, children: React.ReactNode, align?: 'left' | 'center' | 'right', className?: string }) => (
      <th
        className={`
          px-4 py-3 text-${align} text-xs font-semibold text-brand-text-secondary uppercase tracking-wider cursor-pointer 
          transition-all duration-200 hover:text-brand-text-primary hover:bg-brand-surfaceHighlight/50 group select-none border-b border-brand-border ${className}
        `}
        onClick={() => handleSort(id)}
      >
        <div className={`flex items-center ${align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start'}`}>
          {children}
          <SortIcon columnKey={id} />
        </div>
      </th>
  );

  return (
    <div className="w-full overflow-hidden bg-brand-surface rounded-xl border border-brand-border shadow-xl">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-brand-border">
          <thead>
            <tr className="bg-brand-surface">
              <Th id="symbol" className="pl-6">COIN</Th>
              <Th id="symbol">SYMBOL</Th>
              <Th id="exchange">Exchange</Th>
              <Th id="fundingIntervalHours" align="center">Inter</Th>
              <Th id="openInterestValue" align="right">OI</Th>
              <Th id="marketCap" align="right">M-Cap</Th>
              <Th id="apr" align="right">APR</Th>
              <Th id="fundingRate" align="right">Funding</Th>
              <Th id="nextFundingTime" align="right">Next Time</Th>
              <Th id="volume24h" align="right">24H Vol</Th>
              <Th id="insuranceFund" align="right">Ins. Fund</Th>
              <Th id="fundOiRatio" align="right" className="pr-6">Fund/OI</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border bg-brand-dark/50">
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-6 py-24 text-center">
                   <div className="flex flex-col items-center justify-center text-brand-text-muted">
                      <svg className="w-12 h-12 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <p>No data found</p>
                   </div>
                </td>
              </tr>
            ) : (
              pagedData.map((item) => {
                const apr = calculateApr(item.fundingRate, item.fundingIntervalHours);
                const isExpanded = expandedRow === `${item.symbol}-${item.exchange}`;
                const isPartial = item.hasFundingData === false || item.hasOpenInterestData === false;
                // HL 的 RWA 合约在 xyz builder dex 上，展示时去掉 dex 前缀（数据层仍用完整 symbol 做 key / 查历史）
                const displaySymbol = item.symbol.replace(/^xyz:/i, '');

                return (
                  <>
                    <tr 
                      key={`${item.symbol}-${item.exchange}`} 
                      className={`transition-colors duration-150 group ${isExpanded ? 'bg-brand-surfaceHighlight/30' : 'hover:bg-brand-surfaceHighlight/30'}`}
                    >
                    <td className="px-4 py-3 whitespace-nowrap pl-6">
                      <div
                        className="flex items-center"
                        title={item.coinName || displaySymbol.replace('USDT', '')}
                      >
                        {item.coinImage ? (
                          <img
                            src={item.coinImage}
                            alt={item.coinName || item.symbol}
                            className="w-6 h-6 rounded-full border border-brand-border/60"
                          />
                        ) : (
                          <div className="w-6 h-6 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center text-[10px] font-bold text-brand-text-secondary group-hover:border-brand-accent/30 group-hover:text-brand-accent transition-colors">
                            {displaySymbol.substring(0, 1)}
                          </div>
                        )}
                      </div>
                    </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary font-mono">
                        <div className="flex items-center gap-2">
                          <span>{displaySymbol}</span>
                          {isPartial && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border border-brand-border text-brand-text-muted bg-brand-surfaceHighlight/60"
                              title="Missing funding or open interest data from exchange; showing partial defaults."
                            >
                              partial
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`
                          inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border
                          ${item.exchange === 'Binance'
                            ? 'bg-[#FCD535]/10 text-[#FCD535] border-[#FCD535]/20'
                            : item.exchange === 'OKX'
                            ? 'bg-[#FFFFFF]/10 text-[#FFFFFF] border-[#FFFFFF]/20'
                            : item.exchange === 'Hyperliquid'
                            ? 'bg-violet-500/10 text-violet-400 border-violet-500/20'
                            : item.exchange === 'Aster'
                            ? 'bg-orange-500/10 text-orange-400 border-orange-500/20'
                            : 'bg-brand-info/10 text-brand-info border-brand-info/20'}
                        `}>
                          {item.exchange}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-center">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-brand-surfaceHighlight/40 text-brand-text-secondary border border-brand-border/60">
                          {(item.fundingIntervalHours || 8)}H
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-primary text-right font-mono tracking-tight">
                        {formatNumber(item.openInterestValue, '', '', 1)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary text-right font-mono tracking-tight">
                        {formatNumber(item.marketCap, '', '', 1)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        <span className={`${apr > 0 ? 'text-brand-success' : apr < 0 ? 'text-brand-danger' : 'text-brand-text-secondary'}`}>
                            {apr.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight cursor-pointer" onClick={() => handleFundingClick(item.symbol, item.exchange)}>
                        <div className="flex items-center justify-end gap-1 hover:bg-brand-surfaceHighlight rounded px-1 py-0.5 transition-colors">
                          <span className={`${item.fundingRate > 0 ? 'text-brand-success' : item.fundingRate < 0 ? 'text-brand-danger' : 'text-brand-text-secondary'}`}>
                              {formatPercent(item.fundingRate)}
                          </span>
                          <span className="text-[10px] opacity-50 text-brand-text-muted">
                            {isExpanded ? '▲' : '▼'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary text-right font-mono tracking-tight">
                          <Countdown targetTime={item.nextFundingTime} />
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-primary text-right font-mono tracking-tight">
                        {formatNumber(item.volume24h, '', '', 1)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary text-right font-mono tracking-tight">
                        {formatNumber(item.insuranceFund, '', '', 1)}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right font-mono text-sm pr-6">
                      <div className="flex items-center justify-end gap-2">
                          <div className="w-16 h-2 bg-brand-surfaceHighlight rounded-full overflow-hidden hidden lg:block ring-1 ring-brand-border/60">
                            <div
                                className={`h-full rounded-full ${item.fundOiRatio > 50 ? 'bg-brand-success' : item.fundOiRatio > 20 ? 'bg-brand-accent' : 'bg-brand-info'}`}
                                style={{ width: `${Math.min(item.fundOiRatio, 100)}%` }}
                            />
                          </div>
                          <span className={`${item.fundOiRatio > 50 ? 'text-brand-success' : 'text-brand-text-secondary'}`}>
                              {item.fundOiRatio > 0 ? `${item.fundOiRatio.toFixed(1)}%` : '—'}
                          </span>
                      </div>
                      </td>
                    </tr>
                    
                    {/* Expanded Funding History Chart */}
                    {isExpanded && (
                      <tr className="bg-brand-surfaceHighlight/10 border-b border-brand-border">
                        <td colSpan={12} className="px-6 py-4">
                          <div className="flex flex-col lg:flex-row gap-6">
                            <div className="flex-1 h-[180px]">
                              {loadingHistory ? (
                                <div className="h-full flex items-center justify-center text-brand-text-secondary text-sm">
                                  <div className="animate-spin w-4 h-4 border-2 border-brand-accent border-t-transparent rounded-full mr-2"></div>
                                  Loading funding history...
                                </div>
                              ) : historyData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                  <BarChart data={historyData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                                    <XAxis 
                                      dataKey="time" 
                                      hide 
                                    />
                                    <YAxis 
                                      hide 
                                      domain={['auto', 'auto']} 
                                    />
                                    <Tooltip content={<FundingTooltip intervalHours={item.fundingIntervalHours || 8} />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />
                                    <ReferenceLine y={0} stroke="#2B3139" strokeDasharray="3 3" />
                                    <Bar dataKey="rate" maxBarSize={10}>
                                      {historyData.map((entry, index) => (
                                        <Cell
                                          key={`cell-${index}`}
                                          fill={entry.rate >= 0 ? '#0ECB81' : '#F6465D'}
                                          fillOpacity={0.9}
                                        />
                                      ))}
                                    </Bar>
                                  </BarChart>
                                </ResponsiveContainer>
                              ) : (
                                <div className="h-full flex items-center justify-center text-brand-text-secondary text-sm">
                                  No history data available
                                </div>
                              )}
                            </div>

                            {/* INDEX CONSTITUENTS + 24H/7D Rate 合并面板 */}
                            <div className="w-full lg:w-80 bg-brand-dark/40 border border-brand-border/60 rounded-xl p-4">
                              {constituents.length > 0 && (
                                <>
                                  <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-3">
                                    Index Constituents
                                  </div>
                                  <div className="space-y-3 max-h-[120px] overflow-auto pr-1">
                                    {constituents.map((entry, idx) => (
                                      <div key={`${entry.exchange}-${entry.symbol}-${idx}`} className="flex justify-between items-start gap-3">
                                        <div>
                                          <div className="text-brand-text-primary text-sm font-semibold">{entry.exchange}</div>
                                          <div className="text-[10px] text-brand-text-secondary uppercase">{entry.symbol}</div>
                                        </div>
                                        <div className="text-right text-xs font-mono">
                                          <div className="text-brand-text-primary">${Number(entry.price).toFixed(2)}</div>
                                          <div className="text-brand-text-secondary text-[10px]">{(Number(entry.weight) * 100).toFixed(2)}%</div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </>
                              )}
                              {historyData.length > 0 && (() => {
                                const now = Date.now();
                                const ms24h = 24 * 60 * 60 * 1000;
                                const ms7d = 7 * 24 * 60 * 60 * 1000;
                                const sum24h = historyData
                                  .filter(d => now - d.time < ms24h)
                                  .reduce((s, d) => s + d.rate, 0);
                                const sum7d = historyData
                                  .filter(d => now - d.time < ms7d)
                                  .reduce((s, d) => s + d.rate, 0);
                                return (
                                  <div className={`flex gap-6 ${constituents.length > 0 ? 'mt-4 pt-3 border-t border-brand-border/40' : ''}`}>
                                    <div>
                                      <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-1">24H Rate</div>
                                      <div className={`text-base font-mono font-semibold ${sum24h >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                                        {(sum24h * 100).toFixed(4)}%
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-1">7D Rate</div>
                                      <div className={`text-base font-mono font-semibold ${sum7d >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                                        {(sum7d * 100).toFixed(4)}%
                                      </div>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-brand-border text-sm text-brand-text-secondary">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            className="bg-brand-surface border border-brand-border rounded px-2 py-1 text-brand-text-primary text-sm"
          >
            {[25, 50, 100, 200].map(size => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-brand-text-muted">
            {sortedData.length === 0
              ? '0 of 0'
              : `${(currentPage - 1) * pageSize + 1}–${Math.min(
                  currentPage * pageSize,
                  sortedData.length
                )} of ${sortedData.length}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="px-2 py-1 border border-brand-border rounded text-xs disabled:opacity-50 hover:border-brand-accent/40 transition-colors"
            >
              Prev
            </button>
            <span className="text-xs text-brand-text-primary">
              {currentPage}/{pageCount}
            </span>
            <button
              onClick={() => setPage(prev => Math.min(pageCount, prev + 1))}
              disabled={currentPage === pageCount || sortedData.length === 0}
              className="px-2 py-1 border border-brand-border rounded text-xs disabled:opacity-50 hover:border-brand-accent/40 transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
