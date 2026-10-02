'use client';

import { motion } from 'motion/react';

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  id,
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>;
  value: T;
  onChange: (t: T) => void;
  id: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={id}
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line [scrollbar-width:none]"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative whitespace-nowrap px-3 py-2 text-[13px] transition-colors ${value === t.id ? 'text-fg' : 'text-muted hover:text-fg'}`}
        >
          {t.label}
          {t.badge ? (
            <span className="ml-1.5 rounded-full bg-ai/20 px-1.5 font-mono text-[10px] text-ai">
              {t.badge}
            </span>
          ) : null}
          {value === t.id && (
            <motion.span
              layoutId={`tab-${id}`}
              className="absolute inset-x-2 bottom-0 h-px bg-run"
            />
          )}
        </button>
      ))}
    </div>
  );
}
