'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import ExchangeFilter from '@/components/ExchangeFilter';
import SearchBox from '@/components/SearchBox';
import FilterControls from '@/components/FilterControls';
import PerpTable, { PerpData } from '@/components/PerpTable';
import TabNav, { TabKey } from '@/components/TabNav';
import EarnTable, { CombinedEarnRow } from '@/components/EarnTable';
import EarnFilterControls from '@/components/EarnFilterControls';
import PositionsTable, { PositionRow, PositionSummary } from '@/components/PositionsTable';

const PERP_EXCHANGES = ['Binance', 'Bybit', 'Bitget', 'Gate', 'OKX', 'Hyperliquid', 'Aster'];
const EARN_EXCHANGES = ['Binance', 'Bybit', 'OKX'];

export default function Home() {
  // Tab 状态
  const [activeTab, setActiveTab] = useState<TabKey>('perps');

  // ========== 永续合约数据 ==========
  const [data, setData] = useState<PerpData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // 永续过滤状态
  const [selectedExchanges, setSelectedExchanges] = useState<Set<string>>(
    new Set(['Binance', 'Bybit'])
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [minOi, setMinOi] = useState(0);
  const [minFundOiRatio, setMinFundOiRatio] = useState(0);
  const [minMarketCap, setMinMarketCap] = useState(0);
  const [minFdv, setMinFdv] = useState(0);
  const [selectedIntervals, setSelectedIntervals] = useState<Set<number>>(new Set());

  // ========== 活期理财数据 ==========
  const [earnData, setEarnData] = useState<CombinedEarnRow[]>([]);
  const [earnLoading, setEarnLoading] = useState(false);
  const [earnError, setEarnError] = useState<string | null>(null);
  const [earnLastUpdate, setEarnLastUpdate] = useState<Date | null>(null);
  const [earnFetched, setEarnFetched] = useState(false);

  // 理财过滤状态
  const [earnSelectedExchanges, setEarnSelectedExchanges] = useState<Set<string>>(
    new Set(['Binance', 'Bybit', 'OKX'])
  );
  const [earnSearchQuery, setEarnSearchQuery] = useState('');
  const [earnMinCombinedApr, setEarnMinCombinedApr] = useState(0);
  const [earnMinOi, setEarnMinOi] = useState(0);
  const [earnMinVol, setEarnMinVol] = useState(0);

  // ========== eb65 持仓数据 ==========
  const [positionsData, setPositionsData] = useState<PositionRow[]>([]);
  const [positionsSummary, setPositionsSummary] = useState<PositionSummary | null>(null);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionsLastUpdate, setPositionsLastUpdate] = useState<Date | null>(null);
  const [positionsFetched, setPositionsFetched] = useState(false);

  // ========== 数据获取 ==========
  const fetchPerpData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch('/api/perps');
      const result = await response.json();

      if (result.success) {
        setData(result.data);
        setLastUpdate(new Date());
      } else {
        setError(result.error || 'Failed to fetch data');
      }
    } catch (err) {
      setError('Network request failed');
      console.error('Failed to fetch data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchEarnData = useCallback(async () => {
    try {
      setEarnLoading(true);
      setEarnError(null);
      const response = await fetch('/api/earn');
      const result = await response.json();

      if (result.success) {
        setEarnData(result.data);
        setEarnLastUpdate(new Date());
        setEarnFetched(true);
      } else {
        setEarnError(result.error || 'Failed to fetch earn data');
      }
    } catch (err) {
      setEarnError('Network request failed');
      console.error('Failed to fetch earn data:', err);
    } finally {
      setEarnLoading(false);
    }
  }, []);

  const fetchPositionsData = useCallback(async () => {
    try {
      setPositionsLoading(true);
      setPositionsError(null);
      const response = await fetch('/api/positions');
      const result = await response.json();

      if (result.success) {
        setPositionsData(result.data);
        setPositionsSummary(result.summary || null);
        // 用采集器落盘的时间，而不是页面请求时间，免得数据过期还显示"刚刚"
        setPositionsLastUpdate(result.updatedAt ? new Date(result.updatedAt) : new Date());
        setPositionsFetched(true);
        // 单边交易所挂了时仍展示另一边，只把错误挂出来
        setPositionsError(result.errors?.length ? result.errors.join(' · ') : null);
      } else {
        setPositionsError(result.error || 'Failed to fetch positions');
      }
    } catch (err) {
      setPositionsError('Network request failed');
      console.error('Failed to fetch positions:', err);
    } finally {
      setPositionsLoading(false);
    }
  }, []);

  // 初始加载永续数据
  useEffect(() => {
    fetchPerpData();
  }, [fetchPerpData]);

  // 切换到理财 tab 时懒加载
  useEffect(() => {
    if (activeTab === 'earn' && !earnFetched && !earnLoading) {
      fetchEarnData();
    }
  }, [activeTab, earnFetched, earnLoading, fetchEarnData]);

  // 切换到持仓 tab 时懒加载
  useEffect(() => {
    if (activeTab === 'positions' && !positionsFetched && !positionsLoading) {
      fetchPositionsData();
    }
  }, [activeTab, positionsFetched, positionsLoading, fetchPositionsData]);

  // 永续合约：每小时第 1 分钟自动刷新（资金费率整点结算）
  useEffect(() => {
    if (activeTab !== 'perps') return;

    const scheduleNextHourRefresh = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(now.getHours() + 1, 1, 0, 0); // 下一个整点 + 1 分钟
      const delay = next.getTime() - now.getTime();
      return setTimeout(() => {
        fetchPerpData();
        // 之后每小时刷新
        const interval = setInterval(fetchPerpData, 60 * 60 * 1000);
        timerRef.current = interval;
      }, delay);
    };

    const timerRef = { current: null as NodeJS.Timeout | null };
    const initialTimer = scheduleNextHourRefresh();

    return () => {
      clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeTab, fetchPerpData]);

  // 活期理财：每小时第 1 分钟自动刷新
  useEffect(() => {
    if (activeTab !== 'earn') return;

    const scheduleNextHourRefresh = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(now.getHours() + 1, 1, 0, 0);
      const delay = next.getTime() - now.getTime();
      return setTimeout(() => {
        fetchEarnData();
        const interval = setInterval(fetchEarnData, 60 * 60 * 1000);
        timerRef.current = interval;
      }, delay);
    };

    const timerRef = { current: null as NodeJS.Timeout | null };
    const initialTimer = scheduleNextHourRefresh();

    return () => {
      clearTimeout(initialTimer);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [activeTab, fetchEarnData]);

  // 持仓：每 30 秒拉一次本地缓存（采集器 60s 刷新，读文件没有交易所开销）
  useEffect(() => {
    if (activeTab !== 'positions') return;

    const interval = setInterval(fetchPositionsData, 30 * 1000);
    return () => clearInterval(interval);
  }, [activeTab, fetchPositionsData]);

  // ========== 永续过滤 ==========
  const filteredData = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return data.filter(item => {
      if (q) {
        // 搜索时无视交易所勾选，symbol 和交易所名都能命中
        if (!item.symbol.toLowerCase().includes(q) && !item.exchange.toLowerCase().includes(q)) return false;
      } else if (!selectedExchanges.has(item.exchange)) {
        return false;
      }
      if (item.openInterestValue < minOi) return false;
      if (item.fundOiRatio < minFundOiRatio) return false;
      const interval = item.fundingIntervalHours || 8;
      if (selectedIntervals.size > 0 && !selectedIntervals.has(interval)) return false;
      if (minMarketCap > 0 && (!item.marketCap || item.marketCap < minMarketCap)) return false;
      if (minFdv > 0 && (!item.fdv || item.fdv < minFdv)) return false;
      return true;
    });
  }, [data, selectedExchanges, searchQuery, minOi, minFundOiRatio, minMarketCap, minFdv, selectedIntervals]);

  // ========== 从永续数据中提取每个 asset 的最大 OI ==========
  const assetOiMap = useMemo(() => {
    const oiMap = new Map<string, number>();
    for (const item of data) {
      let base = item.symbol.replace(/USDT$/, '');
      const multiplierMatch = base.match(/^(\d+)(.+)$/);
      if (multiplierMatch) {
        const prefix = parseInt(multiplierMatch[1]);
        if (prefix >= 1000) {
          base = multiplierMatch[2];
        }
      }
      base = base.toUpperCase();
      const current = oiMap.get(base) || 0;
      if (item.openInterestValue > current) {
        oiMap.set(base, item.openInterestValue);
      }
    }
    return oiMap;
  }, [data]);

  // ========== 理财过滤 ==========
  const filteredEarnData = useMemo(() => {
    const recomputeBest = (item: CombinedEarnRow): CombinedEarnRow => {
      const earnCand = item.earnRates.filter(r => earnSelectedExchanges.has(r.exchange));

      let bestEarnApr = 0, bestEarnExchange = '', bestEarn3d = 0, bestEarn7d = 0;
      if (earnCand.length > 0) {
        const top = earnCand.reduce((a, b) => (b.apr > a.apr ? b : a));
        bestEarnApr = top.apr;
        bestEarnExchange = top.exchange;
        bestEarn3d = Math.max(...earnCand.map(c => c.apr3d ?? c.apr));
        bestEarn7d = Math.max(...earnCand.map(c => c.apr7d ?? c.apr));
      }

      return {
        ...item,
        bestEarnApr,
        bestEarnExchange,
        bestEarn3d,
        bestEarn7d,
      };
    };

    return earnData
      .filter(item => {
        if (item.earnRates.length > 0) {
          const hasSelectedExchange = item.earnRates.some(r => earnSelectedExchanges.has(r.exchange));
          if (!hasSelectedExchange) return false;
        }
        if (earnSearchQuery && !item.asset.toLowerCase().includes(earnSearchQuery.toLowerCase())) return false;
        if (earnMinOi > 0) {
          const oi = assetOiMap.get(item.asset.toUpperCase()) || 0;
          if (oi < earnMinOi) return false;
        }
        if (earnMinVol > 0 && (item.bestVolume ?? 0) < earnMinVol) return false;
        return true;
      })
      .map(recomputeBest)
      .filter(item => {
        if (earnMinCombinedApr > 0 && item.bestEarnApr * 100 < earnMinCombinedApr) return false;
        return true;
      });
  }, [earnData, earnSelectedExchanges, earnSearchQuery, earnMinCombinedApr, earnMinOi, earnMinVol, assetOiMap]);

  // ========== 辅助 ==========
  const maxOi = useMemo(() => {
    if (data.length === 0) return 0;
    return Math.max(...data.map(item => item.openInterestValue));
  }, [data]);

  const maxFundOiRatio = useMemo(() => {
    if (data.length === 0) return 0;
    return Math.max(...data.map(item => item.fundOiRatio));
  }, [data]);

  const toggleExchange = (exchange: string) => {
    setSelectedExchanges(prev => {
      const next = new Set(prev);
      if (next.has(exchange)) next.delete(exchange);
      else next.add(exchange);
      return next;
    });
  };

  const toggleEarnExchange = (exchange: string) => {
    setEarnSelectedExchanges(prev => {
      const next = new Set(prev);
      if (next.has(exchange)) next.delete(exchange);
      else next.add(exchange);
      return next;
    });
  };

  const toggleInterval = (hours: number) => {
    setSelectedIntervals(prev => {
      const next = new Set(prev);
      if (next.has(hours)) next.delete(hours);
      else next.add(hours);
      return next;
    });
  };

  const availableIntervals = useMemo(() => {
    const intervals = new Set<number>();
    data.forEach(item => intervals.add(item.fundingIntervalHours || 8));
    return Array.from(intervals).sort((a, b) => a - b);
  }, [data]);

  const formatTime = (date: Date | null) => {
    if (!date) return '';
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
  };

  const handleRefresh = () => {
    if (activeTab === 'perps') fetchPerpData();
    else if (activeTab === 'earn') fetchEarnData();
    else fetchPositionsData();
  };

  const isLoading = activeTab === 'perps' ? loading : activeTab === 'earn' ? earnLoading : positionsLoading;
  const currentError = activeTab === 'perps' ? error : activeTab === 'earn' ? earnError : positionsError;
  const currentLastUpdate = activeTab === 'perps' ? lastUpdate : activeTab === 'earn' ? earnLastUpdate : positionsLastUpdate;

  return (
    <div className="min-h-screen bg-brand-dark relative overflow-x-hidden selection:bg-brand-surfaceHighlight">
      {/* 极简风：不要装饰性光斑与渐变底 */}
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-5 relative z-10">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-6 pb-4 border-b border-brand-border">
           <div>
             <h1 className="text-base font-semibold text-brand-text-primary">
               perp analytics
             </h1>
             <p className="mt-1 text-brand-text-muted">
               real-time monitoring for perpetual contracts &amp; flexible earn rates
             </p>
           </div>

           <div className="flex items-center gap-4">
              <div className="text-right hidden md:block">
                 <div className="text-xs text-brand-text-secondary uppercase tracking-wider">Last Update</div>
                 <div className="text-brand-text-primary font-mono">{currentLastUpdate ? formatTime(currentLastUpdate) : '--:--:--'}</div>
              </div>
              <button
                onClick={handleRefresh}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 bg-brand-surface border border-brand-border rounded-lg text-brand-text-primary hover:bg-brand-surfaceHighlight hover:border-brand-accent/30 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed group shadow-sm"
              >
                <svg className={`w-4 h-4 text-brand-text-secondary group-hover:text-brand-accent transition-colors ${isLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <span>{isLoading ? 'Refreshing...' : 'Refresh'}</span>
              </button>
           </div>
        </div>

        {/* Tab Navigation */}
        <div className="mb-6">
          <TabNav activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        {/* ========== 永续合约 Tab ========== */}
        {activeTab === 'perps' && (
          <>
            {/* Controls */}
            <div className="space-y-4 mb-8">
              <div className="glass-panel rounded-xl p-5 flex flex-col lg:flex-row items-start lg:items-center gap-6 justify-between">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 w-full lg:w-auto">
                  <ExchangeFilter
                    exchanges={PERP_EXCHANGES}
                    selectedExchanges={selectedExchanges}
                    onToggle={toggleExchange}
                  />
                </div>
              </div>

              <div className="glass-panel rounded-xl p-5 flex flex-wrap items-center gap-6">
                <FilterControls
                  minOi={minOi}
                  maxOi={maxOi}
                  minFundOiRatio={minFundOiRatio}
                  maxFundOiRatio={maxFundOiRatio}
                  minMarketCap={minMarketCap}
                  minFdv={minFdv}
                  availableIntervals={availableIntervals}
                  selectedIntervals={selectedIntervals}
                  onMinOiChange={setMinOi}
                  onMinFundOiRatioChange={setMinFundOiRatio}
                  onMinMarketCapChange={setMinMarketCap}
                  onMinFdvChange={setMinFdv}
                  onToggleInterval={toggleInterval}
                />
                <div className="flex-1" />
                <div className="text-sm text-brand-text-secondary font-medium px-4 py-1.5 bg-brand-dark/50 rounded-md border border-brand-border/50">
                  Showing <span className="text-brand-text-primary">{filteredData.length}</span> / {data.length} pairs
                </div>
              </div>
            </div>

            {error && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 flex items-center gap-3">
                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </div>
            )}

            {loading && data.length === 0 ? (
              <div className="text-center py-24 text-brand-text-secondary">
                 <div className="animate-spin w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full mx-auto mb-4"></div>
                 Loading market data...
              </div>
            ) : (
              <PerpTable
                data={filteredData}
                search={searchQuery}
                onSearchChange={setSearchQuery}
                totalCount={data.length}
              />
            )}
          </>
        )}

        {/* ========== 活期理财 Tab ========== */}
        {activeTab === 'earn' && (
          <>
            {/* Controls */}
            <div className="space-y-4 mb-8">
              <div className="glass-panel rounded-xl p-5 flex flex-col lg:flex-row items-start lg:items-center gap-6 justify-between">
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6 w-full lg:w-auto">
                  <ExchangeFilter
                    exchanges={EARN_EXCHANGES}
                    selectedExchanges={earnSelectedExchanges}
                    onToggle={toggleEarnExchange}
                  />
                  <div className="hidden sm:block w-px h-8 bg-brand-border" />
                  <SearchBox
                    value={earnSearchQuery}
                    onChange={setEarnSearchQuery}
                    placeholder="search asset…"
                    hotkey={activeTab === 'earn'}
                  />
                </div>
              </div>

              <div className="glass-panel rounded-xl p-5 flex flex-wrap items-center gap-6">
                <EarnFilterControls
                  minCombinedApr={earnMinCombinedApr}
                  onMinCombinedAprChange={setEarnMinCombinedApr}
                  minOi={earnMinOi}
                  onMinOiChange={setEarnMinOi}
                  minVol={earnMinVol}
                  onMinVolChange={setEarnMinVol}
                />
                <div className="flex-1" />
                <div className="text-sm text-brand-text-secondary font-medium px-4 py-1.5 bg-brand-dark/50 rounded-md border border-brand-border/50">
                  Showing <span className="text-brand-text-primary">{filteredEarnData.length}</span> / {earnData.length} assets
                </div>
              </div>
            </div>

            {earnError && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 flex items-center gap-3">
                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {earnError}
              </div>
            )}

            {earnLoading && earnData.length === 0 ? (
              <div className="text-center py-24 text-brand-text-secondary">
                 <div className="animate-spin w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full mx-auto mb-4"></div>
                 Loading earn products...
              </div>
            ) : (
              <EarnTable data={filteredEarnData} />
            )}
          </>
        )}

        {/* ========== eb65 持仓 Tab ========== */}
        {activeTab === 'positions' && (
          <>
            {positionsError && (
              <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 flex items-center gap-3">
                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {positionsError}
              </div>
            )}

            {positionsLoading && positionsData.length === 0 ? (
              <div className="text-center py-24 text-brand-text-secondary">
                 <div className="animate-spin w-8 h-8 border-2 border-brand-accent border-t-transparent rounded-full mx-auto mb-4"></div>
                 Loading eb65 positions...
              </div>
            ) : (
              <PositionsTable data={positionsData} summary={positionsSummary} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
