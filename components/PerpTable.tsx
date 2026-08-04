'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { FundingGrid } from '@/components/FundingHistory';

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
  apr3d?: number | null;
  apr7d?: number | null;
}

type SortKey = keyof PerpData | 'apr' | 'none';
type SortOrder = 'asc' | 'desc';

interface PerpTableProps {
  data: PerpData[];
  /** 搜索词由页面持有（过滤在页面层做），表头只负责就地编辑 */
  search?: string;
  onSearchChange?: (value: string) => void;
  totalCount?: number;
}

/* ── 币种图标 ──
   图标源是多层兜底的（CoinGecko → 交易所资产表 → CoinCap 静态地址），
   最后一层可能 404，这里 onError 就降级成首字母方块，不留破图。 */
function CoinIcon({ src, label, blank }: { src?: string; label: string; blank?: boolean }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => { setFailed(false); }, [src]);

  // HL（尤其 builder dex 的 RWA）不显示图标，留空位保持列宽
  if (blank) return <div className="w-6 h-6" />;

  if (!src || failed) {
    return (
      <div className="w-6 h-6 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center text-[10px] font-bold text-brand-text-secondary group-hover:border-brand-accent/30 group-hover:text-brand-accent transition-colors">
        {label.substring(0, 1)}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={label}
      loading="lazy"
      onError={() => setFailed(true)}
      className="w-6 h-6 rounded-full border border-brand-border/60"
    />
  );
}

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

export default function PerpTable({ data, search = '', onSearchChange, totalCount }: PerpTableProps) {
  // SYMBOL 表头就地搜索：ctrl/cmd+F 激活，esc 退出
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!onSearchChange) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        // 等表头切换成 input 之后再聚焦
        requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
        return;
      }
      if (e.key === 'Escape' && searchOpen) {
        onSearchChange('');
        setSearchOpen(false);
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onSearchChange, searchOpen]);

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
      const response = await fetch(
        `/api/funding-history?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}`
      );
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
              {searchOpen && onSearchChange ? (
                <th className="px-4 py-3 text-left border-b border-brand-border">
                  <div className="flex items-center gap-2">
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      spellCheck={false}
                      placeholder="search symbol or exchange…"
                      onChange={e => onSearchChange(e.target.value)}
                      onBlur={() => { if (!search) setSearchOpen(false); }}
                      className="w-52 px-2 py-1 bg-brand-surface border border-brand-border text-brand-text-primary placeholder-brand-text-muted text-xs font-normal normal-case tracking-normal focus:outline-none focus:border-brand-text-secondary"
                    />
                    <span className="text-[10px] font-normal normal-case tracking-normal text-brand-text-muted whitespace-nowrap">
                      {search ? `${data.length}${totalCount ? '/' + totalCount : ''} · all exch` : 'esc'}
                    </span>
                    <button
                      type="button"
                      onClick={() => { onSearchChange(''); setSearchOpen(false); }}
                      className="text-brand-text-muted hover:text-brand-text-primary text-xs font-normal"
                      title="close (esc)"
                    >
                      ×
                    </button>
                  </div>
                </th>
              ) : (
                <Th id="symbol">
                  <span className="flex items-center gap-1.5">
                    SYMBOL
                    <span
                      role="button"
                      title="search (ctrl/cmd+F)"
                      onClick={e => {
                        e.stopPropagation();
                        setSearchOpen(true);
                        requestAnimationFrame(() => searchRef.current?.focus());
                      }}
                      className="text-brand-text-muted hover:text-brand-text-primary font-normal normal-case"
                    >
                      ⌕
                    </span>
                  </span>
                </Th>
              )}
              <Th id="exchange">Exchange</Th>
              <Th id="openInterestValue" align="right">OI</Th>
              <Th id="marketCap" align="right">M-Cap</Th>
              <Th id="apr" align="right">APR</Th>
              <Th id="fundingRate" align="right">Funding</Th>
              <Th id="nextFundingTime" align="right">Next Time</Th>
              <Th id="volume24h" align="right">24H Vol</Th>
              <Th id="apr3d" align="right">3D APR</Th>
              <Th id="apr7d" align="right">7D APR</Th>
              <Th id="insuranceFund" align="right">Ins. Fund</Th>
              <Th id="fundOiRatio" align="right" className="pr-6">Fund/OI</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border bg-brand-dark/50">
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={13} className="px-6 py-24 text-center">
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
                        <CoinIcon src={item.coinImage} label={displaySymbol} />
                      </div>
                    </td>
                      <td
                        className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary font-mono cursor-pointer hover:text-brand-text-primary"
                        onClick={() => handleFundingClick(item.symbol, item.exchange)}
                        title="show funding by settlement time"
                      >
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
                        {/* 极简风：交易所标签中性，颜色只留给有正负语义的数值 */}
                        <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-normal border border-brand-border text-brand-text-secondary">
                          {item.exchange}
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
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        {item.apr3d === null || item.apr3d === undefined ? (
                          <span className="text-brand-text-muted">-</span>
                        ) : (
                          <span className={item.apr3d >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                            {(item.apr3d >= 0 ? '+' : '') + item.apr3d.toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        {item.apr7d === null || item.apr7d === undefined ? (
                          <span className="text-brand-text-muted">-</span>
                        ) : (
                          <span className={item.apr7d >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                            {(item.apr7d >= 0 ? '+' : '') + item.apr7d.toFixed(2)}%
                          </span>
                        )}
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
                    
                    {/* 展开：时点资金费网格 */}
                    {isExpanded && (
                      <tr className="border-b border-brand-border">
                        <td colSpan={13} className="px-6 py-4">
                          {loadingHistory ? (
                            <div className="font-mono text-[11px] text-brand-text-muted">loading funding history…</div>
                          ) : historyData.length > 0 ? (
                            <FundingGrid
                              symbol={displaySymbol}
                              exchange={item.exchange}
                              intervalHours={item.fundingIntervalHours || 8}
                              history={historyData}
                              constituents={constituents}
                            />
                          ) : (
                            <div className="font-mono text-[11px] text-brand-text-muted">no funding history available</div>
                          )}
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
