'use client';

interface EarnFilterControlsProps {
  minCombinedApr: number;
  onMinCombinedAprChange: (value: number) => void;
  minOi: number;
  onMinOiChange: (value: number) => void;
  minFunding3d: number;
  onMinFunding3dChange: (value: number) => void;
  minFunding7d: number;
  onMinFunding7dChange: (value: number) => void;
  minFunding30d: number;
  onMinFunding30dChange: (value: number) => void;
  minVol: number;
  onMinVolChange: (value: number) => void;
}

export default function EarnFilterControls({
  minCombinedApr,
  onMinCombinedAprChange,
  minOi,
  onMinOiChange,
  minFunding3d,
  onMinFunding3dChange,
  minFunding7d,
  onMinFunding7dChange,
  minFunding30d,
  onMinFunding30dChange,
  minVol,
  onMinVolChange,
}: EarnFilterControlsProps) {
  const MILLION = 1_000_000;
  const SLIDER_MAX = 100 * MILLION;
  const displayOiMillions = minOi / MILLION;
  const percentage = Math.min(100, (minOi / SLIDER_MAX) * 100);

  const formatMillions = (value: number) => {
    if (value >= 100) return value.toFixed(0);
    if (value >= 10) return value.toFixed(1);
    return value.toFixed(2);
  };

  const FundingInput = ({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) => (
    <div className="flex items-center gap-2">
      <label className="text-brand-text-secondary whitespace-nowrap font-medium text-xs">{label}</label>
      <div className="relative group">
        <input
          type="number"
          step="1"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-16 pl-2 pr-5 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
        />
        <div className="absolute inset-y-0 right-0 pr-1.5 flex items-center pointer-events-none">
          <span className="text-brand-text-muted text-[10px]">%</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-wrap items-center gap-6 text-sm">
      <div className="flex items-center gap-3">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min Earn APR
        </label>
        <div className="relative group">
          <input
            type="number"
            min="0"
            max="500"
            step="1"
            value={minCombinedApr}
            onChange={(e) => onMinCombinedAprChange(Number(e.target.value))}
            className="w-20 pl-2 pr-6 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
          />
          <div className="absolute inset-y-0 right-0 pr-2 flex items-center pointer-events-none">
            <span className="text-brand-text-muted text-xs">%</span>
          </div>
        </div>
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min OI
        </label>
        <div className="flex items-center gap-2">
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
                background: `linear-gradient(to right, #0B99FF ${percentage}%, #2B3139 ${percentage}%)`
              }}
            />
          </div>
          <span className="text-brand-text-secondary text-xs font-mono whitespace-nowrap">
            ≥ ${formatMillions(displayOiMillions)}M
          </span>
        </div>
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">Min Funding</label>
        <FundingInput label="3D" value={minFunding3d} onChange={onMinFunding3dChange} />
        <FundingInput label="7D" value={minFunding7d} onChange={onMinFunding7dChange} />
        <FundingInput label="30D" value={minFunding30d} onChange={onMinFunding30dChange} />
      </div>

      <div className="w-px h-8 bg-brand-border hidden sm:block" />

      <div className="flex items-center gap-3">
        <label className="text-brand-text-secondary whitespace-nowrap font-medium">
          Min Vol
        </label>
        <div className="flex items-center gap-2">
          <div className="relative group">
            <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none">
              <span className="text-brand-text-muted text-xs">$</span>
            </div>
            <input
              type="number"
              min="0"
              step="0.1"
              value={Number.isFinite(minVol / 1_000_000) ? Number((minVol / 1_000_000).toFixed(3)) : 0}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                if (Number.isNaN(parsed)) {
                  onMinVolChange(0);
                } else {
                  onMinVolChange(Math.max(0, parsed) * 1_000_000);
                }
              }}
              className="w-24 pl-4 pr-2 py-1 bg-brand-surface border border-brand-border rounded text-brand-text-primary focus:outline-none focus:border-brand-accent text-xs font-mono"
            />
          </div>
          <span className="text-brand-text-secondary text-xs font-mono whitespace-nowrap">M</span>
        </div>
      </div>
    </div>
  );
}
