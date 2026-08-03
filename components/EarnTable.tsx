'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';

export interface EarnRate {
  exchange: string;
  apr: number;
  apr3d?: number;  // 真实 3d 平均（如有）
  apr7d?: number;  // 真实 7d 平均（如有）
  quota?: number | null;
}

export interface FundingRate {
  exchange: string;
  apr3d: number;
  apr7d: number;
  apr30d: number;
}

export interface ArbitrageInfo {
  asset: string;
  investAmount: number;
  swapToken: string;
  swapAmount: number;
  redeemAmount: number;
  profit: number;
  apr: number;
  redeemDays: number;
  officialRate?: number;
  timestamp: string;
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

type SortKey = 'asset' | 'bestEarn3d' | 'bestEarn7d' | 'bestFunding3d' | 'bestFunding7d' | 'bestFunding30d' | 'combined3d' | 'combined7d' | 'marketCap' | 'bestVolume' | 'none';
type SortOrder = 'asc' | 'desc';

interface EarnTableProps {
  data: CombinedEarnRow[];
}

const exchangeColors: Record<string, string> = {
  Binance: 'bg-[#FCD535]/10 text-[#FCD535] border-[#FCD535]/20',
  Bybit: 'bg-brand-info/10 text-brand-info border-brand-info/20',
  OKX: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  Hyperliquid: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
  Aster: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  Navi: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20',
};

/* ── Recent Funding Bars Component ── */
interface RecentFundingEntry { time: number; rate: number }
interface RecentFundingData { [exchange: string]: RecentFundingEntry[] }

function RecentFundingBars({ asset }: { asset: string }) {
  const [data, setData] = useState<RecentFundingData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/recent-funding?asset=${asset}`)
      .then(r => r.json())
      .then(j => { if (!cancelled) setData(j.data || null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [asset]);

  if (loading) return <div className="text-xs text-brand-text-muted py-2">Loading...</div>;
  if (!data || Object.keys(data).length === 0) return <div className="text-xs text-brand-text-muted py-2">No funding data</div>;

  const exchNames: Record<string, string> = { binance: 'Binance', bybit: 'Bybit', hyperliquid: 'HL', aster: 'Aster' };
  const exchColors: Record<string, { pos: string; neg: string }> = {
    binance: { pos: '#22c55e', neg: '#ef4444' },
    bybit: { pos: '#3b82f6', neg: '#f97316' },
    hyperliquid: { pos: '#a78bfa', neg: '#f472b6' },
    aster: { pos: '#fb923c', neg: '#e879f9' },
  };

  // Format time to Beijing time (UTC+8)
  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    const bj = new Date(d.getTime() + 8 * 3600 * 1000);
    const mm = String(bj.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(bj.getUTCDate()).padStart(2, '0');
    const hh = String(bj.getUTCHours()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:00`;
  };

  // Find max absolute rate across all exchanges for scaling
  let maxAbs = 0;
  for (const rates of Object.values(data)) {
    for (const r of rates) {
      const abs = Math.abs(r.rate);
      if (abs > maxAbs) maxAbs = abs;
    }
  }
  if (maxAbs === 0) maxAbs = 0.0001;
  const barMaxH = 32; // max bar height in px

  return (
    <div className="flex-1">
      <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-2">Recent Funding Rates</div>
      <div className="space-y-3">
        {Object.entries(data).filter(([, rates]) => rates.length > 0).map(([exch, rates]) => (
          <div key={exch}>
            <div className="text-[10px] text-brand-text-muted mb-1">{exchNames[exch] || exch}</div>
            <div className="flex items-end gap-1.5" style={{ height: barMaxH * 2 + 16 }}>
              {rates.map((r, i) => {
                const h = Math.max(2, Math.abs(r.rate) / maxAbs * barMaxH);
                const isNeg = r.rate < 0;
                const color = isNeg ? exchColors[exch]?.neg || '#ef4444' : exchColors[exch]?.pos || '#22c55e';
                const pct = (r.rate * 100).toFixed(4);
                return (
                  <div key={i} className="flex flex-col items-center" style={{ width: 48 }}>
                    {/* Positive area */}
                    <div className="flex items-end justify-center" style={{ height: barMaxH }}>
                      {!isNeg && (
                        <div
                          className="rounded-t-sm transition-all duration-300"
                          style={{ width: 20, height: h, backgroundColor: color }}
                          title={`${fmtTime(r.time)}: ${pct}%`}
                        />
                      )}
                    </div>
                    {/* Zero line */}
                    <div className="w-full border-t border-brand-border/40" style={{ height: 0 }} />
                    {/* Negative area */}
                    <div className="flex items-start justify-center" style={{ height: barMaxH }}>
                      {isNeg && (
                        <div
                          className="rounded-b-sm transition-all duration-300"
                          style={{ width: 20, height: h, backgroundColor: color }}
                          title={`${fmtTime(r.time)}: ${pct}%`}
                        />
                      )}
                    </div>
                    {/* Label */}
                    <div className="text-center mt-0.5">
                      <div className={`text-[10px] font-mono font-semibold ${isNeg ? 'text-brand-danger' : 'text-brand-success'}`}>{pct}%</div>
                      <div className="text-[8px] text-brand-text-muted">{fmtTime(r.time).split(' ')[1]}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ExchangeBadge = ({ name }: { name: string }) => (
  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border ${exchangeColors[name] || 'bg-brand-surface text-brand-text-muted border-brand-border'}`}>
    {name}
  </span>
);

const formatPct = (val: number) => {
  const pct = val * 100;
  if (pct === 0) return '\u2014';
  const sign = pct > 0 ? '' : '';
  return `${sign}${pct.toFixed(2)}%`;
};

const pctColor = (val: number) => {
  if (val > 0) return 'text-brand-success';
  if (val < 0) return 'text-brand-danger';
  return 'text-brand-text-muted';
};

export default function EarnTable({ data }: EarnTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('combined7d');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [expandedAsset, setExpandedAsset] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);

  const handleSort = (key: SortKey) => {
    if (key === 'none') return;
    if (sortKey === key) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const sortedData = useMemo(() => {
    const next = [...data];
    next.sort((a, b) => {
      if (sortKey === 'none') return 0;
      let aVal: any = a[sortKey as keyof CombinedEarnRow];
      let bVal: any = b[sortKey as keyof CombinedEarnRow];
      if (aVal === null || aVal === undefined) aVal = -Infinity;
      if (bVal === null || bVal === undefined) bVal = -Infinity;
      if (typeof aVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
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

  useEffect(() => { setPage(1); }, [pageSize, data, sortKey, sortOrder]);

  const formatNumber = (num: number | null, decimals: number = 2) => {
    if (num === null || num === undefined) return '\u2014';
    if (num >= 1e9) return (num / 1e9).toFixed(decimals) + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(decimals) + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(decimals) + 'K';
    return num.toFixed(decimals);
  };

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

  const Th = ({ id, children, align = 'left', className = '' }: { id: SortKey; children: React.ReactNode; align?: 'left' | 'center' | 'right'; className?: string }) => (
    <th
      className={`px-4 py-3 text-${align} text-xs font-semibold text-brand-text-secondary uppercase tracking-wider cursor-pointer transition-all duration-200 hover:text-brand-text-primary hover:bg-brand-surfaceHighlight/50 group select-none border-b border-brand-border ${className}`}
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
              <Th id="asset" className="pl-6">COIN</Th>
              <Th id="asset">ASSET</Th>
              <Th id="bestEarn7d" align="right">EARN</Th>
              <Th id="bestFunding3d" align="right">FUND 3D</Th>
              <Th id="bestFunding7d" align="right">FUND 7D</Th>
              <Th id="bestFunding30d" align="right">FUND 30D</Th>
              <Th id="marketCap" align="right">M-Cap</Th>
              <Th id="bestVolume" align="right" className="pr-6">VOL 24H</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-brand-border bg-brand-dark/50">
            {sortedData.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-6 py-24 text-center">
                  <div className="flex flex-col items-center justify-center text-brand-text-muted">
                    <svg className="w-12 h-12 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p>No earn products found</p>
                  </div>
                </td>
              </tr>
            ) : (
              pagedData.map((item) => {
                const isExpanded = expandedAsset === item.asset;
                // 判断该资产是否有真实 earn 数据（OKX real）
                const hasRealEarn = item.earnRates.some(er => er.apr3d !== undefined);

                return (
                  <>
                    <tr
                      key={item.asset}
                      className={`transition-colors duration-150 group hover:bg-brand-surfaceHighlight/30 ${isExpanded ? 'bg-brand-surfaceHighlight/20' : ''}`}
                    >
                      {/* COIN */}
                      <td className="px-4 py-3 whitespace-nowrap pl-6">
                        <div className="flex items-center" title={item.coinName || item.asset}>
                          {item.coinImage ? (
                            <img src={item.coinImage} alt={item.coinName || item.asset} className="w-6 h-6 rounded-full border border-brand-border/60" />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-brand-surface border border-brand-border flex items-center justify-center text-[10px] font-bold text-brand-text-secondary">
                              {item.asset.substring(0, 1)}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* ASSET */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary font-mono">
                        {item.asset}
                      </td>

                      {/* EARN - 点击展开明细 */}
                      <td
                        className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight cursor-pointer"
                        onClick={() => setExpandedAsset(isExpanded ? null : item.asset)}
                      >
                        <div className="flex items-center justify-end gap-1.5 hover:bg-brand-surfaceHighlight rounded px-1 py-0.5 transition-colors">
                          <span className="text-brand-success font-semibold">{formatPct(Math.max(item.bestEarn7d, item.stakingApr ?? 0, item.arbitrage?.apr ?? 0))}</span>
                          {hasRealEarn && <span className="text-[8px] text-brand-accent opacity-70">REAL</span>}
                          {(item.stakingApr ?? 0) > item.bestEarn7d && <span className="text-[8px] text-purple-400 opacity-70">SRR</span>}
                          {item.arbitrage && item.arbitrage.apr > 0 && <span className="text-[8px] text-cyan-400 opacity-70">ARB</span>}
                          <span className="text-[10px] opacity-50 text-brand-text-muted">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                        </div>
                      </td>


                      {/* FUND 3D */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        {item.bestFunding3d !== 0 ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className={pctColor(item.bestFunding3d)}>{formatPct(item.bestFunding3d)}</span>
                            {item.bestFundingExchange3d && <ExchangeBadge name={item.bestFundingExchange3d} />}
                          </div>
                        ) : (
                          <span className="text-brand-text-muted">{'\u2014'}</span>
                        )}
                      </td>

                      {/* FUND 7D */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        {item.bestFunding7d !== 0 ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className={pctColor(item.bestFunding7d)}>{formatPct(item.bestFunding7d)}</span>
                            {item.bestFundingExchange7d && <ExchangeBadge name={item.bestFundingExchange7d} />}
                          </div>
                        ) : (
                          <span className="text-brand-text-muted">{'\u2014'}</span>
                        )}
                      </td>

                      {/* FUND 30D */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                        {item.bestFunding30d !== 0 ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className={pctColor(item.bestFunding30d)}>{formatPct(item.bestFunding30d)}</span>
                            {item.bestFundingExchange30d && <ExchangeBadge name={item.bestFundingExchange30d} />}
                          </div>
                        ) : (
                          <span className="text-brand-text-muted">{'\u2014'}</span>
                        )}
                      </td>

                      {/* M-Cap */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary text-right font-mono tracking-tight">
                        {formatNumber(item.marketCap, 1)}
                      </td>

                      {/* VOL 24H */}
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-brand-text-secondary text-right font-mono tracking-tight pr-6">
                        {(() => {
                          const vols: { ex: string; vol: number }[] = [];
                          if (item.binanceVol && item.binanceVol > 0) vols.push({ ex: 'bn', vol: item.binanceVol });
                          if (item.bybitVol && item.bybitVol > 0) vols.push({ ex: 'by', vol: item.bybitVol });
                          if (item.hyperliquidVol && item.hyperliquidVol > 0) vols.push({ ex: 'hype', vol: item.hyperliquidVol });
                          if (item.okxVol && item.okxVol > 0) vols.push({ ex: 'okx', vol: item.okxVol });
                          if (item.asterVol && item.asterVol > 0) vols.push({ ex: 'ast', vol: item.asterVol });
                          if (vols.length === 0) return <span className="text-brand-text-muted">{'\u2014'}</span>;
                          vols.sort((a, b) => b.vol - a.vol);
                          const top = vols[0];
                          return <span>{top.ex}-{formatNumber(top.vol, 1)}</span>;
                        })()}
                      </td>
                    </tr>

                    {/* 展开：各交易所 Earn 明细 + Funding 明细 */}
                    {isExpanded && (
                      <tr key={`${item.asset}-detail`} className="bg-brand-surfaceHighlight/10 border-b border-brand-border">
                        <td colSpan={8} className="px-6 py-4">
                          <div className="flex flex-col lg:flex-row gap-6">
                            {/* Earn 明细 */}
                            <div className="flex-1">
                              <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-2">Earn Rates</div>
                              <div className="space-y-2">
                                {item.earnRates.map((er) => (
                                  <div key={er.exchange} className="flex items-center justify-between gap-3 text-sm">
                                    <ExchangeBadge name={er.exchange} />
                                    <div className="flex gap-4 font-mono items-center">
                                      {er.apr3d !== undefined ? (
                                        <>
                                          <span className="text-brand-text-secondary text-xs">APR:</span>
                                          <span className="text-brand-text-primary">{formatPct(er.apr)}</span>
                                          <span className="text-brand-text-secondary text-xs">3D:</span>
                                          <span className={`${pctColor(er.apr3d)} font-semibold`}>{formatPct(er.apr3d)}</span>
                                          <span className="text-brand-text-secondary text-xs">7D:</span>
                                          <span className={`${pctColor(er.apr7d ?? er.apr3d)} font-semibold`}>{formatPct(er.apr7d ?? er.apr3d)}</span>
                                        </>
                                      ) : (
                                        <span className={er.apr === item.bestEarnApr ? 'text-brand-accent font-semibold' : 'text-brand-text-primary'}>
                                          {formatPct(er.apr)}
                                        </span>
                                      )}
                                      {er.exchange === 'Binance' && er.quota != null && er.quota > 0 && (
                                        <span className="text-[9px] text-yellow-500/70 ml-1">Q:{er.quota >= 1e6 ? (er.quota/1e6).toFixed(1)+'M' : er.quota >= 1e3 ? (er.quota/1e3).toFixed(0)+'K' : er.quota.toFixed(0)}</span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Staking (SRR) */}
                            {item.stakingApr != null && item.stakingApr > 0 && (
                              <div className="flex-1 max-w-xs">
                                <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-2">Native Staking</div>
                                <div className="flex items-center justify-between gap-3 text-sm">
                                  <div className="flex items-center gap-1.5">
                                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border bg-purple-500/10 text-purple-400 border-purple-500/20">Staking</span>
                                    {item.stakingUnstakingDays != null && item.stakingUnstakingDays > 0 && (
                                      <span className="text-[9px] text-brand-text-muted opacity-70">{item.stakingUnstakingDays}d unstake</span>
                                    )}
                                  </div>
                                  <span className="text-brand-success font-semibold font-mono">{formatPct(item.stakingApr)}</span>
                                </div>
                              </div>
                            )}

                            {/* Arbitrage 套利 */}
                            {item.arbitrage && item.arbitrage.apr > 0 && (
                              <div className="flex-1 max-w-sm">
                                <div className="text-xs uppercase tracking-wider text-brand-text-secondary mb-2">Arbitrage</div>
                                <div className="space-y-1.5">
                                  <div className="flex items-center justify-between gap-3 text-sm">
                                    <div className="flex items-center gap-1.5">
                                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium border bg-cyan-500/10 text-cyan-400 border-cyan-500/20">{item.arbitrage.swapToken}</span>
                                      <span className="text-[9px] text-brand-text-muted opacity-70">{item.arbitrage.redeemDays}d unstake</span>
                                    </div>
                                    <span className="text-brand-success font-semibold font-mono">{(item.arbitrage.apr * 100).toFixed(2)}%</span>
                                  </div>
                                  <div className="text-[10px] text-brand-text-muted font-mono space-y-0.5">
                                    <div className="flex justify-between"><span>Invest</span><span>{item.arbitrage.investAmount.toLocaleString()} {item.asset}</span></div>
                                    <div className="flex justify-between"><span>Swap</span><span>{item.arbitrage.swapAmount.toLocaleString()} {item.arbitrage.swapToken}</span></div>
                                    <div className="flex justify-between"><span>Redeem</span><span>{item.arbitrage.redeemAmount.toLocaleString()} {item.asset}</span></div>
                                    <div className="flex justify-between"><span>Profit</span><span className="text-brand-success">+{item.arbitrage.profit.toLocaleString()} {item.asset}</span></div>
                                    {item.arbitrage.officialRate && <div className="flex justify-between"><span>Official Rate</span><span>{item.arbitrage.officialRate}</span></div>}
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* Funding 明细 */}
                            {item.funding.length > 0 && (
                              <div className="flex-1">
                                <div className="flex items-center gap-4 mb-2">
                                  <span className="text-xs uppercase tracking-wider text-brand-text-secondary">Funding Rates (Annualized)</span>
                                  {(item.binanceOI != null && item.binanceOI > 0) && (
                                    <span className="text-xs text-brand-text-muted font-mono">Binance OI: {formatNumber(item.binanceOI, 1)}</span>
                                  )}
                                  {(item.bybitOI != null && item.bybitOI > 0) && (
                                    <span className="text-xs text-brand-text-muted font-mono">Bybit OI: {formatNumber(item.bybitOI, 1)}</span>
                                  )}
                                  {(item.hyperliquidOI != null && item.hyperliquidOI > 0) && (
                                    <span className="text-xs text-brand-text-muted font-mono">HL OI: {formatNumber(item.hyperliquidOI, 1)}</span>
                                  )}
                                  {(item.okxOI != null && item.okxOI > 0) && (
                                    <span className="text-xs text-brand-text-muted font-mono">OKX OI: {formatNumber(item.okxOI, 1)}</span>
                                  )}
                                  {(item.asterOI != null && item.asterOI > 0) && (
                                    <span className="text-xs text-brand-text-muted font-mono">Aster OI: {formatNumber(item.asterOI, 1)}</span>
                                  )}
                                </div>
                                <div className="space-y-2">
                                  {item.funding.map((fr) => (
                                    <div key={fr.exchange} className="flex items-center justify-between gap-3 text-sm">
                                      <ExchangeBadge name={fr.exchange} />
                                      <div className="flex gap-4 font-mono">
                                        <span className="text-brand-text-secondary text-xs">3D:</span>
                                        <span className={pctColor(fr.apr3d)}>{formatPct(fr.apr3d)}</span>
                                        <span className="text-brand-text-secondary text-xs">7D:</span>
                                        <span className={pctColor(fr.apr7d)}>{formatPct(fr.apr7d)}</span>
                                        <span className="text-brand-text-secondary text-xs">30D:</span>
                                        <span className={pctColor(fr.apr30d)}>{formatPct(fr.apr30d)}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Recent Funding Bars */}
                            <RecentFundingBars asset={item.asset} />
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

      {/* Pagination */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-brand-border text-sm text-brand-text-secondary">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={e => setPageSize(Number(e.target.value))}
            className="bg-brand-surface border border-brand-border rounded px-2 py-1 text-brand-text-primary text-sm"
          >
            {[25, 50, 100, 200].map(size => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-brand-text-muted">
            {sortedData.length === 0
              ? '0 of 0'
              : `${(currentPage - 1) * pageSize + 1}\u2013${Math.min(currentPage * pageSize, sortedData.length)} of ${sortedData.length}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage === 1}
              className="px-2 py-1 border border-brand-border rounded text-xs disabled:opacity-50 hover:border-brand-accent/40 transition-colors"
            >
              Prev
            </button>
            <span className="text-xs text-brand-text-primary">{currentPage}/{pageCount}</span>
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
