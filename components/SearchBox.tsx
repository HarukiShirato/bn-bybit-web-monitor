'use client';

import { useEffect, useRef, useState } from 'react';

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** 是否接管 Ctrl/Cmd+F。同屏有多个搜索框时只让当前 tab 的那个接管 */
  hotkey?: boolean;
}

export default function SearchBox({
  value,
  onChange,
  placeholder = 'search symbol or exchange…',
  hotkey = false,
}: SearchBoxProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  useEffect(() => {
    if (!hotkey) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd+F 接管成表内搜索
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      // Esc 清空并退出
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        onChange('');
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hotkey, onChange]);

  return (
    <div className="relative w-full sm:w-96">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full pl-3 pr-16 py-1.5 bg-brand-surface border border-brand-border text-brand-text-primary placeholder-brand-text-muted focus:outline-none focus:border-brand-text-secondary"
      />
      <div className="absolute inset-y-0 right-2 flex items-center gap-2">
        {value ? (
          <button
            type="button"
            onClick={() => onChange('')}
            className="text-brand-text-muted hover:text-brand-text-primary px-1"
            title="clear (esc)"
          >
            ×
          </button>
        ) : hotkey ? (
          <span className="text-[10px] text-brand-text-muted border border-brand-border px-1 py-0.5 pointer-events-none">
            {isMac ? '⌘F' : 'ctrl F'}
          </span>
        ) : null}
      </div>
    </div>
  );
}
