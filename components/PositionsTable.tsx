'use client';

import { Fragment, useMemo, useState } from 'react';
import { FundingGrid } from '@/components/FundingHistory';

export interface PositionRow {
  id: string;
  exchange: 'Binance' | 'Hyperliquid';
  account: string;
  symbol: string;
  base: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  liquidationPrice: number | null;
  leverage: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number;
  nextFundingTime: number | null;
  cumFundingSinceOpen: number | null;
  fundingApr: number | null;
  fundingApr3d: number | null;
  fundingApr7d: number | null;
  dailyFunding: number | null;
  /* 以下都是已到账的真实金额（USD），不是按当前费率外推的估算 */
  realizedFunding3d: number | null;
  realizedFunding7d: number | null;
  earnRewards3d: number | null;
  earnRewards7d: number | null;
  earnBalance: number | null;
  earnAsset: string | null;
}

export interface PositionSummary {
  count: number;
  grossNotional: number;
  netNotional: number;
  longNotional: number;
  shortNotional: number;
  unrealizedPnl: number;
  dailyFunding: number;
  realizedFunding3d: number;
  realizedFunding7d: number;
  earnRewards3d: number;
  earnRewards7d: number;
  earnBalance: number;
}

type SortKey = keyof PositionRow;
type SortOrder = 'asc' | 'desc';

interface Props {
  data: PositionRow[];
  summary: PositionSummary | null;
}

const fmtUsd = (v: number | null, decimals = 2) => {
  if (v === null || v === undefined) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(decimals)}K`;
  return `${sign}$${abs.toFixed(decimals)}`;
};

/** 价格位数随量级自适应，别把 0.00007 显示成 0.00 */
const fmtPx = (v: number) => {
  if (!v) return '—';
  if (v >= 1000) return v.toFixed(1);
  if (v >= 1) return v.toFixed(4);
  return v.toPrecision(5);
};

/** 表格里 venue 用短名，完整名留在 title 里 */
const shortVenue = (account: string) =>
  account
    .replace('PM · USDⓈ-M', 'BN PM')
    .replace('PM · COIN-M', 'BN PM-C')
    .replace('HL · main', 'HL')
    .replace('HL · ', 'HL ');

const signed = (v: number, digits = 2) => (v >= 0 ? '+' : '') + v.toFixed(digits);

const tone = (v: number | null) =>
  v === null || v === undefined
    ? 'text-brand-text-muted'
    : v > 0
    ? 'text-brand-success'
    : v < 0
    ? 'text-brand-danger'
    : 'text-brand-text-secondary';

/** 实收金额单元格：7d 为主行，3d 与备注为次行；没有流水就留 — */
function RealizedCell({ d3, d7, sub }: { d3: number | null; d7: number | null; sub?: string }) {
  if (d7 === null && d3 === null) return <span className="text-brand-text-muted">—</span>;
  return (
    <>
      <div className={tone(d7)}>{d7 === null ? '—' : (d7 >= 0 ? '+' : '') + fmtUsd(d7)}</div>
      <div className="text-[10px] text-brand-text-muted">
        3d <span className={d3 === null ? '' : tone(d3)}>{d3 === null ? '—' : (d3 >= 0 ? '+' : '') + fmtUsd(d3)}</span>
        {sub ? ` · ${sub}` : ''}
      </div>
    </>
  );
}

export default function PositionsTable({ data, summary }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('notional');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ time: number; rate: number }[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  /* 展开行拉该币对在该所的历史费率；symbol 由采集器写成 funding-history 认的格式 */
  const toggleRow = async (row: PositionRow) => {
    if (expandedId === row.id) {
      setExpandedId(null);
      setHistory([]);
      return;
    }

    setExpandedId(row.id);
    setLoadingHistory(true);
    setHistory([]);

    try {
      const res = await fetch(
        `/api/funding-history?symbol=${encodeURIComponent(row.symbol)}&exchange=${encodeURIComponent(row.exchange)}`
      );
      const result = await res.json();
      if (result.success) setHistory(result.data || []);
    } catch (e) {
      console.error('Failed to fetch funding history:', e);
    } finally {
      setLoadingHistory(false);
    }
  };

  const sorted = useMemo(() => {
    const next = [...data];
    next.sort((a, b) => {
      let av: any = a[sortKey];
      let bv: any = b[sortKey];
      if (av === null || av === undefined) av = -Infinity;
      if (bv === null || bv === undefined) bv = -Infinity;
      if (typeof av === 'string') return sortOrder === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortOrder === 'asc' ? av - bv : bv - av;
    });
    return next;
  }, [data, sortKey, sortOrder]);

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

  const Th = ({ id, children, align = 'left', className = '' }: { id: SortKey; children: React.ReactNode; align?: 'left' | 'right'; className?: string }) => (
    <th
      className={`
        px-3 py-3 text-${align} text-xs font-semibold text-brand-text-secondary uppercase tracking-wider cursor-pointer
        transition-all duration-200 hover:text-brand-text-primary hover:bg-brand-surfaceHighlight/50 group select-none border-b border-brand-border ${className}
      `}
      onClick={() => handleSort(id)}
    >
      <div className={`flex items-center ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
        {children}
        <SortIcon columnKey={id} />
      </div>
    </th>
  );

  const Stat = ({ label, value, valueTone, note }: { label: string; value: string; valueTone?: string; note?: string }) => (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-brand-text-muted">{label}</div>
      <div className={`font-mono text-sm mt-0.5 ${valueTone || 'text-brand-text-primary'}`}>{value}</div>
      {note && <div className="font-mono text-[10px] text-brand-text-muted">{note}</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      {summary && (
        <div className="glass-panel rounded-xl p-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
          <Stat label="positions" value={String(summary.count)} />
          <Stat label="gross notional" value={fmtUsd(summary.grossNotional, 1)} />
          <Stat
            label="net (long−short)"
            value={fmtUsd(summary.netNotional, 1)}
            valueTone={tone(summary.netNotional)}
          />
          <Stat label="unrealized pnl" value={fmtUsd(summary.unrealizedPnl)} valueTone={tone(summary.unrealizedPnl)} />
          {/* 以下两格是真实到账，口径见表头；3d 放在副标里 */}
          <Stat
            label="funding 实收 7d"
            value={fmtUsd(summary.realizedFunding7d)}
            valueTone={tone(summary.realizedFunding7d)}
            note={`3d ${fmtUsd(summary.realizedFunding3d)}`}
          />
          <Stat
            label="A-leg earn 实收 7d"
            value={fmtUsd(summary.earnRewards7d)}
            valueTone={tone(summary.earnRewards7d)}
            note={`3d ${fmtUsd(summary.earnRewards3d)} · bal ${fmtUsd(summary.earnBalance, 1)}`}
          />
        </div>
      )}

      <div className="w-full overflow-hidden bg-brand-surface rounded-xl border border-brand-border shadow-xl">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-brand-border">
            <thead>
              <tr className="bg-brand-surface">
                <Th id="symbol" className="pl-6">Symbol</Th>
                <Th id="account">Venue</Th>
                <Th id="side">Side</Th>
                <Th id="notional" align="right">Notional</Th>
                <Th id="entryPrice" align="right" className="hidden xl:table-cell">Entry</Th>
                <Th id="markPrice" align="right" className="hidden xl:table-cell">Mark</Th>
                <Th id="unrealizedPnl" align="right">uPnL</Th>
                <Th id="liquidationPrice" align="right" className="hidden xl:table-cell">Liq.</Th>
                <Th id="fundingRate" align="right">Funding</Th>
                <Th id="fundingApr" align="right">Fund APR</Th>
                <Th id="realizedFunding7d" align="right">Funding 实收</Th>
                <Th id="earnRewards7d" align="right">A-leg Earn 实收</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-brand-border bg-brand-dark/50">
              {sorted.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-6 py-24 text-center text-brand-text-muted">
                    No open positions
                  </td>
                </tr>
              ) : (
                sorted.map(row => {
                  const isExpanded = expandedId === row.id;
                  // builder dex 的 xyz: 前缀只是路由信息，展示时去掉
                  const displaySymbol = row.symbol.replace(/^[a-z]+:/i, '').replace(/USDT$/, '');

                  return (
                    <Fragment key={row.id}>
                      <tr
                        className={`transition-colors duration-150 group cursor-pointer ${isExpanded ? 'bg-brand-surfaceHighlight/30' : 'hover:bg-brand-surfaceHighlight/30'}`}
                        onClick={() => toggleRow(row)}
                      >
                        <td className="px-3 py-3 whitespace-nowrap pl-6 text-sm font-mono text-brand-text-primary">
                          <div className="flex items-center gap-2">
                            <span>{displaySymbol}</span>
                            <span className="text-[10px] opacity-50 text-brand-text-muted">{isExpanded ? '▲' : '▼'}</span>
                          </div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          <span
                            className="inline-flex items-center px-2 py-0.5 text-[10px] font-normal border border-brand-border text-brand-text-secondary whitespace-nowrap"
                            title={row.account}
                          >
                            {shortVenue(row.account)}
                          </span>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-sm font-mono">
                          <span className={row.side === 'LONG' ? 'text-brand-success' : 'text-brand-danger'}>
                            {row.side}
                          </span>
                          {row.leverage ? <span className="text-brand-text-muted"> {row.leverage}x</span> : null}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-sm text-right font-mono text-brand-text-primary tracking-tight">
                          {fmtUsd(row.notional, 1)}
                        </td>
                        <td className="hidden xl:table-cell px-3 py-3 whitespace-nowrap text-sm text-right font-mono text-brand-text-secondary tracking-tight">
                          {fmtPx(row.entryPrice)}
                        </td>
                        <td className="hidden xl:table-cell px-3 py-3 whitespace-nowrap text-sm text-right font-mono text-brand-text-secondary tracking-tight">
                          {fmtPx(row.markPrice)}
                        </td>
                        <td className={`px-3 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight ${tone(row.unrealizedPnl)}`}>
                          {fmtUsd(row.unrealizedPnl)}
                        </td>
                        <td className="hidden xl:table-cell px-3 py-3 whitespace-nowrap text-sm text-right font-mono text-brand-text-muted tracking-tight">
                          {row.liquidationPrice ? fmtPx(row.liquidationPrice) : '—'}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                          {row.fundingRate === null ? (
                            <span className="text-brand-text-muted">—</span>
                          ) : (
                            <span className={tone(row.fundingRate)}>{signed(row.fundingRate * 100, 4)}%</span>
                          )}
                          <div className="text-[10px] text-brand-text-muted">{row.fundingIntervalHours}h</div>
                        </td>
                        {/* APR / Fund per day 已按持仓方向取过号：正数=这笔仓位在收资金费 */}
                        <td className="px-3 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                          <div className={tone(row.fundingApr)}>
                            {row.fundingApr === null ? '—' : signed(row.fundingApr, 1) + '%'}
                          </div>
                          {/* 3d / 7d 回看，来自采集器落盘的历史费率；覆盖不足的窗口给 — */}
                          <div className="text-[10px] text-brand-text-muted">
                            3d <span className={row.fundingApr3d === null ? '' : tone(row.fundingApr3d)}>
                              {row.fundingApr3d === null ? '—' : signed(row.fundingApr3d, 1)}
                            </span>
                            {' · '}7d <span className={row.fundingApr7d === null ? '' : tone(row.fundingApr7d)}>
                              {row.fundingApr7d === null ? '—' : signed(row.fundingApr7d, 1)}
                            </span>
                          </div>
                        </td>
                        {/* B 腿真实到账的资金费（Binance um/income、HL userFunding），非估算 */}
                        <td className="px-3 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight">
                          <RealizedCell d3={row.realizedFunding3d} d7={row.realizedFunding7d} />
                        </td>
                        {/* A 腿现货躺在活期理财里真实拿到的派息，换算成 USD */}
                        <td className="px-3 py-3 whitespace-nowrap text-sm text-right font-mono tracking-tight pr-6">
                          <RealizedCell d3={row.earnRewards3d} d7={row.earnRewards7d} sub={row.earnBalance ? `bal ${fmtUsd(row.earnBalance, 1)}` : undefined} />
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="border-b border-brand-border">
                          <td colSpan={12} className="px-6 py-4">
                            {loadingHistory ? (
                              <div className="font-mono text-[11px] text-brand-text-muted">loading funding history…</div>
                            ) : history.length > 0 ? (
                              <FundingGrid
                                symbol={displaySymbol}
                                exchange={row.exchange}
                                intervalHours={row.fundingIntervalHours || 8}
                                history={history}
                                constituents={[]}
                              />
                            ) : (
                              <div className="font-mono text-[11px] text-brand-text-muted">no funding history available</div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
