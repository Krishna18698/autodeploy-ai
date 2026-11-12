'use client';

import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

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
  const ref = useRef<HTMLDivElement>(null);
  // On a narrow screen the row scrolls sideways: fade the edge that hides more
  // tabs, so a cut-off label reads as "there's more" and not as a glitch.
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setMore({
        left: el.scrollLeft > 4,
        right: el.scrollWidth - el.clientWidth - el.scrollLeft > 4,
      });
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, []);
  // The chosen tab is always in view (it may have been picked from a link).
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the tab changes
  useEffect(() => {
    ref.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [value]);
  const mask =
    more.left || more.right
      ? `linear-gradient(to right, ${more.left ? 'transparent, #000 32px' : '#000, #000'}, ${more.right ? '#000 calc(100% - 32px), transparent' : '#000'})`
      : undefined;
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={id}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-white/6 [scrollbar-width:none]"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative whitespace-nowrap px-3 py-2 text-[13px] transition-colors pointer-coarse:py-2.5 ${value === t.id ? 'text-fg' : 'text-muted hover:text-fg'}`}
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
              className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-fg"
            />
          )}
        </button>
      ))}
    </div>
  );
}
