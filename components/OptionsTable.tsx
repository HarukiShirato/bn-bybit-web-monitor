'use client';

import { useMemo, useState } from 'react';

export interface OptionRow {
  instrument: string;
  type: 'C' | 'P';
  strike: number;
  expiry: string;
  expiryTs: number;
  dte: number;
  underlying: string;
  underlyingPrice: number;
  markPrice: number;
  markPriceUsd: number;
  bidPrice: number;
  askPrice: number;
  bidPriceUsd: number;
  askPriceUsd: number;
  volume24h: number;
  openInterest: number;
  iv: number;
  bidIv: number;
  askIv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  last: number;
  lastUsd: number;
  change24h: number;
  otmPct: number;
}

type SortKey = keyof OptionRow | 'none';
type SortOrder = 'asc' | 'desc';

interface OptionsTableProps {
  data: OptionRow[];
}

const fmtUsd = (v: number) => {
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (Math.abs(v) >= 1) return `$${v.toFixed(0)}`;
  return `$${v.toFixed(2)}`;
};

const fmtOi = (v: number) => {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

const fmtGreek = (v: number, decimals: number = 4) => {
  if (v === 0) return '—';
  return v.toFixed(decimals);
};

export default function OptionsTable({ data }: OptionsTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('openInterest');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [filterType, setFilterType] = useState<'all' | 'C' | 'P'>('all');
  const [filterExpiry, setFilterExpiry] = useState<string>('all');
  const [minOi, setMinOi] = useState(0);
  const [searchStrike, setSearchStrike] = useState('');

  const expiries = useMemo(() => {
    const set = new Set<string>();
    data.forEach(d => set.add(d.expiry));
    return Array.from(set).sort((a, b) => {
      const rowA = data.find(d => d.expiry === a);
      const rowB = data.find(d => d.expiry === b);
      return (rowA?.expiryTs || 0) - (rowB?.expiryTs || 0);
    });
  }, [data]);

  const filtered = useMemo(() => {
    let result = data.filter(row => {
      if (filterType !== 'all' && row.type !== filterType) return false;
      if (filterExpiry !== 'all' && row.expiry !== filterExpiry) return false;
      if (row.openInterest < minOi) return false;
      if (searchStrike && !row.strike.toString().includes(searchStrike)) return false;
      return true;
    });

    if (sortKey !== 'none') {
      result = [...result].sort((a, b) => {
        const va = a[sortKey as keyof OptionRow];
        const vb = b[sortKey as keyof OptionRow];
        if (typeof va === 'string' && typeof vb === 'string') {
          return sortOrder === 'desc' ? vb.localeCompare(va) : va.localeCompare(vb);
        }
        return sortOrder === 'desc' ? (vb as number) - (va as number) : (va as number) - (vb as number);
      });
    }

    return result;
  }, [data, filterType, filterExpiry, minOi, searchStrike, sortKey, sortOrder]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortOrder('desc');
    }
  };

  const SortIcon = ({ columnKey }: { columnKey: SortKey }) => {
    if (sortKey !== columnKey) return <span className="text-brand-text-secondary/30 ml-0.5">↕</span>;
    return <span className="text-brand-accent ml-0.5">{sortOrder === 'desc' ? '↓' : '↑'}</span>;
  };

  const underlyingPrice = data[0]?.underlyingPrice || 0;

  const columns: { key: SortKey; label: string; align: string }[] = [
    { key: 'instrument', label: 'INSTRUMENT', align: 'left' },
    { key: 'type', label: 'TYPE', align: 'center' },
    { key: 'strike', label: 'STRIKE', align: 'right' },
    { key: 'expiry', label: 'EXPIRY', align: 'center' },
    { key: 'dte', label: 'DTE', align: 'right' },
    { key: 'otmPct', label: 'OTM%', align: 'right' },
    { key: 'markPriceUsd', label: 'MARK $', align: 'right' },
    { key: 'bidPriceUsd', label: 'BID $', align: 'right' },
    { key: 'askPriceUsd', label: 'ASK $', align: 'right' },
    { key: 'iv', label: 'IV %', align: 'right' },
    { key: 'delta', label: 'DELTA (Δ)', align: 'right' },
    { key: 'gamma', label: 'GAMMA (γ)', align: 'right' },
    { key: 'theta', label: 'THETA (θ)', align: 'right' },
    { key: 'vega', label: 'VEGA (ν)', align: 'right' },
    { key: 'openInterest', label: 'OI', align: 'right' },
    { key: 'volume24h', label: '24H VOL', align: 'right' },
    { key: 'change24h', label: '24H %', align: 'right' },
  ];

  return (
    <div>
      {/* 过滤控件 */}
      <div className="glass-panel rounded-xl p-5 mb-6 flex flex-wrap items-center gap-4">
        {/* 标的价格 */}
        <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-dark/50 rounded-md border border-brand-border/50">
          <span className="text-brand-text-secondary text-sm">BTC</span>
          <span className="text-brand-accent font-mono font-bold text-lg">
            {'$' + underlyingPrice.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
        </div>

        <div className="w-px h-8 bg-brand-border" />

        {/* Call / Put 筛选 */}
        <div className="flex gap-1 bg-brand-dark/30 rounded-lg p-0.5">
          {(['all', 'C', 'P'] as const).map(t => {
            const isActive = filterType === t;
            let activeClass = 'bg-brand-accent/15 text-brand-accent border border-brand-accent/30';
            if (t === 'C' && isActive) activeClass = 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
            if (t === 'P' && isActive) activeClass = 'bg-red-500/20 text-red-400 border border-red-500/30';

            return (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                  isActive ? activeClass : 'text-brand-text-secondary hover:text-brand-text-primary border border-transparent'
                }`}
              >
                {t === 'all' ? 'All' : t === 'C' ? 'CALL' : 'PUT'}
              </button>
            );
          })}
        </div>

        <div className="w-px h-8 bg-brand-border" />

        {/* 到期日筛选 */}
        <div className="flex items-center gap-2">
          <span className="text-brand-text-secondary text-sm">Expiry</span>
          <select
            value={filterExpiry}
            onChange={e => setFilterExpiry(e.target.value)}
            className="bg-brand-dark/50 border border-brand-border rounded-md px-3 py-1.5 text-sm text-brand-text-primary focus:border-brand-accent/50 outline-none"
          >
            <option value="all">All</option>
            {expiries.map(exp => (
              <option key={exp} value={exp}>{exp}</option>
            ))}
          </select>
        </div>

        <div className="w-px h-8 bg-brand-border" />

        {/* Min OI */}
        <div className="flex items-center gap-2">
          <span className="text-brand-text-secondary text-sm">Min OI</span>
          <input
            type="number"
            value={minOi || ''}
            onChange={e => setMinOi(Number(e.target.value) || 0)}
            placeholder="0"
            className="w-20 bg-brand-dark/50 border border-brand-border rounded-md px-2 py-1.5 text-sm text-brand-text-primary focus:border-brand-accent/50 outline-none font-mono"
          />
        </div>

        <div className="w-px h-8 bg-brand-border" />

        {/* Strike 搜索 */}
        <div className="flex items-center gap-2">
          <span className="text-brand-text-secondary text-sm">Strike</span>
          <input
            type="text"
            value={searchStrike}
            onChange={e => setSearchStrike(e.target.value)}
            placeholder="e.g. 100000"
            className="w-28 bg-brand-dark/50 border border-brand-border rounded-md px-2 py-1.5 text-sm text-brand-text-primary focus:border-brand-accent/50 outline-none font-mono"
          />
        </div>

        <div className="flex-1" />
        <div className="text-sm text-brand-text-secondary font-medium px-4 py-1.5 bg-brand-dark/50 rounded-md border border-brand-border/50">
          Showing <span className="text-brand-text-primary">{filtered.length}</span> / {data.length} options
        </div>
      </div>

      {/* 表格 */}
      <div className="glass-panel rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-brand-border">
                {columns.map(col => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-3 py-3 text-xs font-semibold text-brand-text-secondary uppercase tracking-wider cursor-pointer hover:text-brand-text-primary transition-colors select-none whitespace-nowrap ${
                      col.align === 'left' ? 'text-left' : col.align === 'center' ? 'text-center' : 'text-right'
                    }`}
                  >
                    {col.label}<SortIcon columnKey={col.key} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(row => {
                const isCall = row.type === 'C';
                const typeColor = isCall ? 'text-emerald-400' : 'text-red-400';
                const typeBg = isCall ? 'bg-emerald-500/10' : 'bg-red-500/10';
                const ivColor = row.iv >= 60 ? 'text-brand-accent' : row.iv >= 45 ? 'text-yellow-400' : 'text-brand-text-primary';
                const changeColor = row.change24h > 0 ? 'text-emerald-400' : row.change24h < 0 ? 'text-red-400' : 'text-brand-text-secondary';
                const thetaColor = row.theta < -0.001 ? 'text-red-400' : 'text-brand-text-secondary';
                const gammaColor = row.gamma > 0.00001 ? 'text-emerald-400' : 'text-brand-text-secondary';

                return (
                  <tr
                    key={row.instrument}
                    className="border-b border-brand-border/50 hover:bg-brand-surfaceHighlight/30 transition-colors"
                  >
                    <td className="px-3 py-3 text-left">
                      <span className="text-brand-text-primary font-mono text-xs">{row.instrument}</span>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <span className={`${typeColor} ${typeBg} px-2 py-0.5 rounded text-xs font-bold`}>
                        {row.type === 'C' ? 'CALL' : 'PUT'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-primary">
                      {'$' + row.strike.toLocaleString()}
                    </td>
                    <td className="px-3 py-3 text-center text-brand-text-secondary text-xs">
                      {row.expiry}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-secondary">
                      {row.dte.toFixed(0)}d
                    </td>
                    <td className="px-3 py-3 text-right font-mono">
                      <span className={row.otmPct > 0 ? 'text-brand-text-secondary' : 'text-red-400'}>
                        {row.otmPct > 0 ? '+' : ''}{row.otmPct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-primary font-medium">
                      {fmtUsd(row.markPriceUsd)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-emerald-400/80">
                      {fmtUsd(row.bidPriceUsd)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-red-400/80">
                      {fmtUsd(row.askPriceUsd)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono font-bold ${ivColor}`}>
                      {row.iv.toFixed(1)}%
                    </td>
                    <td className={`px-3 py-3 text-right font-mono ${row.delta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {row.delta > 0 ? '+' : ''}{fmtGreek(row.delta)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono ${gammaColor}`}>
                      {row.gamma === 0 ? '—' : row.gamma.toExponential(2)}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono ${thetaColor}`}>
                      {row.theta === 0 ? '—' : fmtGreek(row.theta)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-secondary">
                      {fmtGreek(row.vega)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-primary font-medium">
                      {fmtOi(row.openInterest)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-brand-text-secondary">
                      {row.volume24h > 0 ? fmtOi(row.volume24h) : '—'}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono ${changeColor}`}>
                      {row.change24h > 0 ? '+' : ''}{row.change24h.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
