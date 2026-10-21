'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';

export type LogLine = { seq: number; attemptNo: number; text: string };

// Minimal ANSI SGR colour support (what build tools actually emit).
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC
const ANSI_RE = /\u001b\[([0-9;]*)m/g;
const FG: Record<string, string> = {
  '30': 'text-muted',
  '31': 'text-fail',
  '32': 'text-ok',
  '33': 'text-warn',
  '34': 'text-run',
  '35': 'text-ai',
  '36': 'text-run',
  '37': 'text-fg',
  '90': 'text-muted',
  '91': 'text-fail',
  '92': 'text-ok',
  '93': 'text-warn',
  '94': 'text-run',
  '95': 'text-ai',
  '96': 'text-run',
  '97': 'text-fg',
};

function renderAnsi(text: string) {
  const parts: Array<{ text: string; cls: string }> = [];
  let cls = '';
  let last = 0;
  for (const m of text.matchAll(ANSI_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), cls });
    const codes = (m[1] ?? '').split(';');
    for (const c of codes) {
      if (c === '0' || c === '') cls = '';
      else if (c === '1') cls = `${cls} font-semibold`;
      else if (FG[c]) cls = `${cls.replace(/text-\S+/g, '')} ${FG[c]}`;
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), cls });
  return parts;
}

function lineTone(text: string): string {
  if (/^autodeploy:|^▸/.test(text.replace(ANSI_RE, ''))) return 'text-run';
  if (/\b(error|ERR!|failed|✗)\b/i.test(text)) return 'text-fail/90';
  if (/\bwarn(ing)?\b/i.test(text)) return 'text-warn/90';
  return 'text-fg/85';
}

export function LogViewer({ lines, live }: { lines: LogLine[]; live: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  // Phones wrap long lines by default; scrolling a log sideways there is painful.
  useEffect(() => {
    if (window.matchMedia('(max-width: 639px)').matches) setWrap(true);
  }, []);

  const filtered = useMemo(
    () => (query ? lines.filter((l) => l.text.toLowerCase().includes(query.toLowerCase())) : lines),
    [lines, query],
  );
  // Line numbers restart with each attempt, so each attempt gets a divider
  // once a deployment has more than one.
  const rows = useMemo(() => {
    const multi = new Set(lines.map((l) => l.attemptNo)).size > 1;
    const out: Array<{ kind: 'attempt'; attemptNo: number } | { kind: 'line'; line: LogLine }> = [];
    let prev: number | undefined;
    for (const line of filtered) {
      if (multi && line.attemptNo !== prev)
        out.push({ kind: 'attempt', attemptNo: line.attemptNo });
      prev = line.attemptNo;
      out.push({ kind: 'line', line });
    }
    return out;
  }, [filtered, lines]);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 20,
    overscan: 30,
  });

  useEffect(() => {
    if (follow && rows.length) v.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, follow, v]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search logs"
          aria-label="Search logs"
          className="h-7 w-44 rounded border border-line bg-bg px-2 font-mono text-[12px] text-fg outline-none placeholder:text-muted/60 focus:border-run/60"
        />
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
          <input
            type="checkbox"
            checked={wrap}
            onChange={(e) => setWrap(e.target.checked)}
            className="accent-[var(--color-run)]"
          />{' '}
          wrap
        </label>
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
            className="accent-[var(--color-run)]"
          />{' '}
          follow
        </label>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted">
          {live && <span className="size-1.5 animate-pulse rounded-full bg-run" />}
          {filtered.length.toLocaleString()} {query ? 'matches' : 'lines'}
        </span>
      </div>
      <div
        ref={parentRef}
        onWheel={(e) => e.deltaY < 0 && setFollow(false)}
        className="min-h-0 flex-1 overflow-auto bg-bg py-1 font-mono text-[12px] leading-5"
        role="log"
        aria-live="off"
      >
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-muted">{live ? 'Waiting for output…' : 'No log lines.'}</p>
        ) : (
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              if (row.kind === 'attempt')
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={v.measureElement}
                    className="absolute inset-x-0 flex items-center gap-3 px-3 pb-1 pt-2 text-[11px] uppercase tracking-[0.1em] text-muted"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <span className="w-10 shrink-0" />
                    <span>attempt {row.attemptNo}</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                );
              const l = row.line;
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={v.measureElement}
                  className="absolute inset-x-0 flex gap-3 px-3 hover:bg-raised/60"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className="w-10 shrink-0 select-none text-right text-muted/50">
                    {l.seq + 1}
                  </span>
                  <span
                    className={`${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} ${lineTone(l.text)}`}
                  >
                    {renderAnsi(l.text).map((p, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
                      <span key={i} className={p.cls}>
                        {p.text}
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
