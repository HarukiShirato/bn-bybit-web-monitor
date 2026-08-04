'use client';

import { useState, useEffect } from 'react';

/**
 * 币种图标。图挂了（外链被墙、上游 404）就退回首字母圆圈，
 * 别把浏览器的裂图标丢给用户。
 */
export function CoinIcon({ src, label, blank }: { src?: string; label: string; blank?: boolean }) {
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

export default CoinIcon;
