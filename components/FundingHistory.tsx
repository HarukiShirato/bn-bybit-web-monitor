'use client';

import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

export interface FundingPoint { time: number; rate: number }

/* ── 历史资金费折线 ──
   手写 SVG：一条细线 + 零轴虚线，没有网格没有填充，和整体的终端风格一致。
   鼠标移上去出竖线和该结算点的读数（正绿负红）。 */
export function FundingLine({
  history,
  intervalHours,
}: {
  history: FundingPoint[];
  intervalHours: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null); // 点击钉住，移开鼠标也不消失

  const W = 800;
  const H = 140;
  const PAD = 10;
  const PAD_X = 16; // 横向留白：没有它首尾点落在 x=0 / x=W，圆点被裁掉一半
  const RIGHT_GUTTER = 24; // 右侧留白，配平左边的 Y 轴刻度列

  if (history.length < 2) return null;

  const rates = history.map(p => p.rate * 100);
  const max = Math.max(...rates, 0);
  const min = Math.min(...rates, 0);
  const span = max - min || 1;
  const cycles = intervalHours > 0 ? 24 / intervalHours : 3;

  const xAt = (i: number) => PAD_X + (i / (history.length - 1)) * (W - 2 * PAD_X);
  /** 覆盖层（tooltip、横坐标刻度）用百分比定位，必须和 xAt 同一套映射 */
  const xPctAt = (i: number) => (xAt(i) / W) * 100;
  const yAt = (v: number) => PAD + ((max - v) / span) * (H - 2 * PAD);
  const points = history.map((_, i) => `${xAt(i).toFixed(2)},${yAt(rates[i]).toFixed(2)}`).join(' ');

  // 纵坐标刻度：max→min 等分，并强制带上零轴
  const Y_TICKS = 5;
  const yTicks = Array.from(
    new Set([...Array.from({ length: Y_TICKS }, (_, i) => max - (span * i) / (Y_TICKS - 1)), 0])
  ).sort((a, b) => b - a);

  // 横坐标刻度：等距取样，点数不足时自动收敛
  const X_TICKS = Math.min(6, history.length);
  const xTickIdx = Array.from(
    new Set(Array.from({ length: X_TICKS }, (_, i) => Math.round((i * (history.length - 1)) / (X_TICKS - 1))))
  );

  const fmtTs = (ts: number) => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const idxFromEvent = (e: ReactMouseEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return null;
    const rel = (e.clientX - rect.left) / rect.width;
    const inner = (rel * W - PAD_X) / (W - 2 * PAD_X);
    return Math.min(history.length - 1, Math.max(0, Math.round(inner * (history.length - 1))));
  };

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => setHover(idxFromEvent(e));

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const i = idxFromEvent(e);
    setPinned(prev => (prev !== null && prev === i ? null : i));
  };

  // 钉住优先，其次才是当前悬停
  const active = pinned !== null ? pinned : hover;
  const hovered = active === null ? null : history[active];
  const hoveredRate = active === null ? 0 : rates[active];

  return (
    <div className="mt-3 pt-2 border-t border-brand-border">
      <div className="flex items-center justify-between text-brand-text-muted mb-1">
        <span>funding history · {history.length} pts</span>
        <span>
          {hovered ? (
            <>
              <span className="text-brand-text-secondary">{fmtTs(hovered.time)} </span>
              <span className={hoveredRate >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                {(hoveredRate >= 0 ? '+' : '') + hoveredRate.toFixed(4)}%
              </span>
              <span className="text-brand-text-muted"> · apr </span>
              <span className={hoveredRate >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                {(hoveredRate >= 0 ? '+' : '') + (hoveredRate * cycles * 365).toFixed(2)}%
              </span>
            </>
          ) : (
            <span>hover to read · click to pin</span>
          )}
        </span>
      </div>

      <div className="flex">
        {/* 纵坐标：刻度值贴着轴线，绝对定位对齐各自的 y */}
        <div className="relative shrink-0" style={{ height: H, width: 62 }}>
          {yTicks.map(v => (
            <span
              key={v}
              className={`absolute right-1.5 -translate-y-1/2 text-[10px] ${
                v === 0 ? 'text-brand-text-secondary' : 'text-brand-text-muted'
              }`}
              style={{ top: `${(yAt(v) / H) * 100}%` }}
            >
              {v.toFixed(4)}
            </span>
          ))}
          <div className="absolute right-0 top-0 bottom-0 w-px bg-brand-border" />
        </div>

        <div
          className="relative flex-1 select-none cursor-crosshair"
          style={{ height: H }}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onClick={onClick}
        >
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {/* 横向网格 */}
            {yTicks.map(v => (
              <line
                key={`h${v}`}
                x1={0}
                x2={W}
                y1={yAt(v)}
                y2={yAt(v)}
                stroke={v === 0 ? 'var(--chart-zero)' : 'var(--chart-grid)'}
                strokeDasharray={v === 0 ? '3 3' : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {/* 纵向网格（对应横坐标刻度） */}
            {xTickIdx.map(i => (
              <line
                key={`v${i}`}
                x1={xAt(i)}
                x2={xAt(i)}
                y1={0}
                y2={H}
                stroke="var(--chart-grid)"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              points={points}
              fill="none"
              stroke="var(--chart-line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            {active !== null && (
              <>
                <line
                  x1={xAt(active)}
                  x2={xAt(active)}
                  y1={0}
                  y2={H}
                  stroke="var(--chart-cross)"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={xAt(active)}
                  cy={yAt(hoveredRate)}
                  r={2.5}
                  fill={hoveredRate >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)'}
                  vectorEffect="non-scaling-stroke"
                />
              </>
            )}
          </svg>

          {/* 光标处的读数：时间 + 单期费率 + 年化 */}
          {active !== null && hovered && (() => {
            const xPct = xPctAt(active);
            const yPct = (yAt(hoveredRate) / H) * 100;
            const flip = xPct > 62;
            return (
              <div
                className="absolute z-10 pointer-events-none whitespace-nowrap border border-brand-border bg-brand-surface px-2 py-1 text-[10px] leading-4"
                style={{
                  left: `${xPct}%`,
                  top: `${yPct}%`,
                  transform: `translate(${flip ? '-100%' : '0'}, -115%) translateX(${flip ? '-6px' : '6px'})`,
                }}
              >
                <div className="text-brand-text-secondary">{fmtTs(hovered.time)}</div>
                <div className={hoveredRate >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                  {(hoveredRate >= 0 ? '+' : '') + hoveredRate.toFixed(4)}%
                  <span className="text-brand-text-muted"> · apr </span>
                  {(hoveredRate >= 0 ? '+' : '') + (hoveredRate * cycles * 365).toFixed(2)}%
                </div>
                {pinned !== null && <div className="text-brand-text-muted">pinned · click to release</div>}
              </div>
            );
          })()}

          <div className="absolute left-0 right-0 bottom-0 h-px bg-brand-border" />
        </div>

        {/* 右侧留白：左边 62px 是 Y 轴刻度区，不在这补一块折线就会整体偏右贴边 */}
        <div className="shrink-0" style={{ width: RIGHT_GUTTER }} />
      </div>

      {/* 横坐标：刻度对齐各自的 x，首尾贴边不出界 */}
      <div className="flex">
        <div className="shrink-0" style={{ width: 62 }} />
        <div className="relative flex-1 h-7">
          {xTickIdx.map((idx, k) => {
            const pct = xPctAt(idx);
            const align = k === 0 ? 'translateX(0)' : k === xTickIdx.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
            const d = new Date(history[idx].time);
            const pad = (n: number) => String(n).padStart(2, '0');
            return (
              <span
                key={idx}
                className="absolute top-0 text-[10px] text-brand-text-muted text-center leading-3"
                style={{ left: `${pct}%`, transform: align }}
              >
                {`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`}
                <br />
                {`${pad(d.getHours())}:${pad(d.getMinutes())}`}
              </span>
            );
          })}
        </div>
        <div className="shrink-0" style={{ width: RIGHT_GUTTER }} />
      </div>
    </div>
  );
}

/* ── 时点资金费网格 ──
   等宽字体下按结算时点横向铺开：上行时刻、下行费率，正绿负红。
   末尾给出按可用历史算出的年化，覆盖不足的窗口显示 —。 */

export function FundingGrid({
  symbol,
  exchange,
  intervalHours,
  history,
  constituents,
}: {
  symbol: string;
  exchange: string;
  intervalHours: number;
  history: FundingPoint[];
  constituents: any[];
}) {
  const POINTS = 24; // 展示最近 24 个结算时点

  const sorted = [...history].sort((a, b) => a.time - b.time);
  const recent = sorted.slice(-POINTS);
  const cycles = intervalHours > 0 ? 24 / intervalHours : 3;

  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = (ts: number) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const mmdd = (ts: number) => {
    const d = new Date(ts);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  // 覆盖不足的窗口不给数，避免用 8 天数据冒充 30 天年化
  const aprOver = (days: number): number | null => {
    const cutoff = Date.now() - days * 86400000;
    if (!sorted.length || sorted[0].time > cutoff) return null;
    const pts = sorted.filter(p => p.time >= cutoff);
    if (!pts.length) return null;
    const avg = pts.reduce((s, p) => s + p.rate, 0) / pts.length;
    return avg * cycles * 365 * 100;
  };

  const sumOver = (hours: number): number | null => {
    const cutoff = Date.now() - hours * 3600000;
    if (!sorted.length || sorted[0].time > cutoff) return null;
    return sorted.filter(p => p.time >= cutoff).reduce((s, p) => s + p.rate, 0) * 100;
  };

  const tone = (v: number) => (v >= 0 ? 'text-brand-success' : 'text-brand-danger');
  const signed = (v: number, digits: number) => (v >= 0 ? '+' : '') + v.toFixed(digits);

  const Stat = ({ label, value, digits = 2, suffix = '%' }: { label: string; value: number | null; digits?: number; suffix?: string }) => (
    <span className="whitespace-nowrap">
      <span className="text-brand-text-muted">{label} </span>
      {value === null
        ? <span className="text-brand-text-muted">—</span>
        : <span className={tone(value)}>{signed(value, digits)}{suffix}</span>}
    </span>
  );

  return (
    <div className="font-mono text-[11px]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-brand-text-muted">
        <span className="text-brand-text-primary">{symbol}</span>
        <span>{exchange}</span>
        <span>{intervalHours}h settle</span>
        <span>{sorted.length} pts</span>
      </div>

      <div className="overflow-x-auto">
        <div className="inline-flex gap-px border border-brand-border">
          {recent.map((p, i) => {
            const prev = recent[i - 1];
            const newDay = !prev || mmdd(prev.time) !== mmdd(p.time);
            return (
              <div key={p.time} className="px-2 py-1.5 text-center bg-brand-dark min-w-[68px]">
                <div className="text-brand-text-muted text-[10px] leading-4">
                  {newDay ? mmdd(p.time) : ' '}
                </div>
                <div className="text-brand-text-secondary text-[10px] leading-4">{hhmm(p.time)}</div>
                <div className={`leading-4 ${tone(p.rate)}`}>{signed(p.rate * 100, 4)}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-3 pt-2 border-t border-brand-border">
        <Stat label="24h" value={sumOver(24)} digits={4} />
        <Stat label="7d" value={sumOver(7 * 24)} digits={4} />
        <span className="text-brand-border">|</span>
        <span className="text-brand-text-muted">apr</span>
        <Stat label="3d" value={aprOver(3)} />
        <Stat label="7d" value={aprOver(7)} />
        <Stat label="30d" value={aprOver(30)} />
      </div>

      <FundingLine history={sorted} intervalHours={intervalHours} />

      {constituents.length > 0 && (
        <div className="mt-3 pt-2 border-t border-brand-border">
          <div className="text-brand-text-muted mb-1">index constituents</div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {constituents.map((c, i) => (
              <span key={`${c.exchange}-${c.symbol}-${i}`} className="whitespace-nowrap">
                <span className="text-brand-text-secondary">{c.exchange}</span>
                <span className="text-brand-text-muted"> {Number(c.price).toFixed(2)} </span>
                <span className="text-brand-text-muted">{(Number(c.weight) * 100).toFixed(1)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
