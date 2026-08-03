'use client';

interface FilterControlsProps {
  minOi: number;
  maxOi: number;
  minFundOiRatio: number;
  maxFundOiRatio: number;
  minMarketCap: number;
  minFdv: number;
  availableIntervals: number[];
  selectedIntervals: Set<number>;
  onMinOiChange: (value: number) => void;
  onMinFundOiRatioChange: (value: number) => void;
  onMinMarketCapChange: (value: number) => void;
  onMinFdvChange: (value: number) => void;
  onToggleInterval: (hours: number) => void;
}

export default function FilterControls({
  minOi,
  maxOi,
  minFundOiRatio,
  maxFundOiRatio,
  minMarketCap,
  minFdv,
  availableIntervals,
  selectedIntervals,
  onMinOiChange,
  onMinFundOiRatioChange,
  onMinMarketCapChange,
  onMinFdvChange,
  onToggleInterval,
}: FilterControlsProps) {
  const MILLION = 1_000_000;
  const SLIDER_MAX = 100 * MILLION; // 0 - 100M for quick adjustments

  const percentage = Math.min(100, (minOi / SLIDER_MAX) * 100);
  const displayOiMillions = minOi / MILLION;
  const formatMillions = (value: number) => {
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  };

  return (
    <div className="flex flex-wrap items-center gap-6 text-sm">
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min OI
        </label>
        <div className="flex items-center gap-2">
           {/* 输入框：允许用户手动输入任意数值 */}
           <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
                <span className="text-brand-text-muted text-xs">$</span>
              </div>
              <input
                type="number"
                min="0"
                step="0.1"
                value={Number.isFinite(displayOiMillions) ? Number(displayOiMillions.toFixed(3)) : 0}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (Number.isNaN(parsed)) {
                    onMinOiChange(0);
                  } else {
                    onMinOiChange(Math.max(0, parsed) * MILLION);
                  }
                }}
                className="w-24 pl-4 pr-2 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
              />
           </div>
           
          {/* 滑块：仅用于 0-100M 的快速调节 */}
          <div className="relative w-32 h-6 flex items-center group">
              <input
                type="range"
                min="0"
                max={SLIDER_MAX}
                step={MILLION}
                value={Math.min(minOi, SLIDER_MAX)}
                onChange={(e) => onMinOiChange(Number(e.target.value))}
                className="w-full absolute h-1.5 rounded-full appearance-none cursor-pointer bg-brand-border z-10"
                style={{
                  background: `linear-gradient(to right, #18181B ${percentage}%, #E4E4E7 ${percentage}%)`
                }}
              />
              {/* 悬停提示：告知用户滑块最大范围 */}
              <div className="absolute -top-6 left-1/2 transform -translate-x-1/2 bg-brand-surface border border-brand-border text-brand-text-secondary text-[10px] px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                 Max Slider: 100M
              </div>
              <style jsx>{`
                input[type=range]::-webkit-slider-thumb {
                  -webkit-appearance: none;
                  height: 14px;
                  width: 14px;
                  border-radius: 50%;
                  background: #18181B;
                  cursor: pointer;
                  margin-top: 0px;
                  border: 2px solid #fff;
                  box-shadow: 0 0 0 2px rgba(11, 153, 255, 0.2);
                }
                input[type=range]::-moz-range-thumb {
                  height: 14px;
                  width: 14px;
                  border: 2px solid #fff;
                  border-radius: 50%;
                  background: #18181B;
                  cursor: pointer;
                }
              `}</style>
           </div>
          <span className="text-brand-text-secondary text-xs font-mono whitespace-nowrap">
            ≥ ${formatMillions(displayOiMillions)}M
          </span>
        </div>
      </div>
      
      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Funding Interval
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          {(availableIntervals.length > 0 ? availableIntervals : [1, 4, 8]).map(interval => {
            const active = selectedIntervals.has(interval);
            return (
              <button
                key={interval}
                type="button"
                onClick={() => onToggleInterval(interval)}
                className={`px-3 py-1 rounded-full text-xs font-semibold border transition-all duration-200 ${
                  active
                    ? 'bg-brand-accent/10 text-brand-accent border-brand-accent/40 shadow-[0_0_10px_rgba(240,185,11,0.2)]'
                    : 'bg-brand-surface border-brand-border text-brand-text-secondary hover:text-brand-text-primary'
                }`}
              >
                {interval}H
              </button>
            );
          })}
        </div>
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Fund/OI Ratio
        </label>
        <div className="relative group">
          <input
            type="number"
            min="0"
            max={maxFundOiRatio}
            step="0.1"
            value={minFundOiRatio}
            onChange={(e) => onMinFundOiRatioChange(Number(e.target.value))}
            className="w-16 pl-2 pr-6 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
          />
          <div className="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none">
             <span className="text-brand-text-muted text-xs">%</span>
          </div>
        </div>
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min M.Cap
        </label>
        <div className="relative group">
          <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
             <span className="text-brand-text-muted text-xs">$</span>
          </div>
          <input
            type="number"
            min="0"
            step="1000000"
            value={minMarketCap}
            onChange={(e) => onMinMarketCapChange(Number(e.target.value))}
            className="w-24 pl-4 pr-2 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
          />
        </div>
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min FDV
        </label>
        <div className="relative group">
          <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
             <span className="text-brand-text-muted text-xs">$</span>
          </div>
          <input
            type="number"
            min="0"
            step="1000000"
            value={minFdv}
            onChange={(e) => onMinFdvChange(Number(e.target.value))}
            className="w-24 pl-4 pr-2 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
          />
        </div>
      </div>
    </div>
  );
}
