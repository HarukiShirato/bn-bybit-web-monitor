'use client';

export type TabKey = 'perps' | 'earn' | 'positions';

interface TabNavProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: 'perps', label: 'Perpetual Contracts' },
  { key: 'earn', label: 'Flexible Earn' },
  { key: 'positions', label: 'Positions (eb65)' },
];

export default function TabNav({ activeTab, onTabChange }: TabNavProps) {
  return (
    <div className="flex gap-1 bg-brand-surface border border-brand-border rounded-lg p-1">
      {TABS.map(tab => {
        const isActive = activeTab === tab.key;
        return (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`
              px-4 py-2 rounded-md text-sm font-medium transition-all duration-200 select-none
              ${isActive
                ? 'bg-brand-accent/15 text-brand-accent shadow-sm border border-brand-accent/30'
                : 'text-brand-text-secondary hover:text-brand-text-primary hover:bg-brand-surfaceHighlight/50 border border-transparent'}
            `}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
