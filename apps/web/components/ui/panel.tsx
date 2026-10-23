import type { ReactNode } from 'react';

export function Panel({
  title,
  action,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  pad?: boolean;
}) {
  return (
    <section className={`glass min-w-0 rounded-xl ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-white/6 px-4 py-3">
          <h2 className="text-[13px] font-medium text-fg">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

/**
 * Shimmer over real content made invisible: the placeholder takes exactly the
 * space the loaded content will, so nothing moves when the data arrives. Give
 * it stand-in text or a real component with stand-in data; `block` for
 * block content (several lines, a stepper).
 */
export function Shim({ children, block = false }: { children: ReactNode; block?: boolean }) {
  if (block)
    return (
      <div aria-hidden className="relative">
        <div className="invisible">{children}</div>
        <span className="shimmer absolute inset-0 rounded-md" />
      </div>
    );
  // Text: an inline wrapper adds nothing to the line's height. A component
  // (a status pill, a sparkline): an inline-flex box the size of it, which in
  // a flex row behaves like the component itself.
  const text = typeof children === 'string' || typeof children === 'number';
  return (
    <span aria-hidden className={text ? 'relative' : 'relative inline-flex align-top'}>
      <span className={text ? 'invisible' : 'invisible inline-flex'}>{children}</span>
      <span
        className={`shimmer absolute inset-x-0 ${text ? 'top-[12%] bottom-[12%] rounded' : 'inset-y-0 rounded-full'}`}
      />
    </span>
  );
}

/** A shimmering placeholder in the shape of what's loading (see loaders.tsx). */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`shimmer rounded ${className}`} />;
}

// Varied widths, so a list of placeholders reads as rows of text, not bars.
const ROW_WIDTHS = ['w-full', 'w-11/12', 'w-4/5', 'w-full', 'w-3/4', 'w-11/12'];

/** Placeholder rows for a list or panel while it loads; announced once to screen readers. */
export function SkeletonRows({
  rows = 3,
  className = 'h-9',
  pad = true,
}: {
  rows?: number;
  className?: string;
  pad?: boolean;
}) {
  return (
    <div role="status" className={`flex flex-col gap-2.5 ${pad ? 'p-4' : ''}`}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <Skeleton key={i} className={`${className} ${ROW_WIDTHS[i % ROW_WIDTHS.length]}`} />
      ))}
    </div>
  );
}

/** The same, as items of an existing list (<ul>). */
export function SkeletonItems({
  rows = 3,
  className = 'h-6',
}: {
  rows?: number;
  className?: string;
}) {
  return Array.from({ length: rows }, (_, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
    <li key={i} aria-hidden className="px-4 py-3">
      <Skeleton className={`${className} ${ROW_WIDTHS[i % ROW_WIDTHS.length]}`} />
    </li>
  ));
}

/** A page's outline while its first data loads: a header line, then panels. */
export function SkeletonPage({ panels = ['h-40', 'h-64'] }: { panels?: string[] }) {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      {panels.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
        <Skeleton key={i} className={`${h} w-full rounded-xl`} />
      ))}
    </div>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-2 px-6 py-14 text-center">
      <div
        aria-hidden
        className="mb-1 grid size-10 place-items-center rounded-full border border-dashed border-line font-mono text-muted"
      >
        ∅
      </div>
      <p className="text-sm text-fg">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
  loading = false,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'fail' | 'warn' | 'run';
  /** Shimmer in place of the number until it arrives. */
  loading?: boolean;
}) {
  const color = tone
    ? { ok: 'text-ok', fail: 'text-fail', warn: 'text-warn', run: 'text-run' }[tone]
    : 'text-fg';
  return (
    <div className="glass rounded-xl px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      {loading ? (
        // The same lines as the loaded tile, so it keeps its height.
        <>
          <div className="mt-1 text-[26px] font-semibold tabular-nums tracking-tight">
            <Shim>000</Shim>
          </div>
          {sub !== undefined && (
            <div className="mt-0.5 text-[12px]">
              <Shim>000 in 30 days</Shim>
            </div>
          )}
        </>
      ) : (
        <>
          <div className={`mt-1 text-[26px] font-semibold tabular-nums tracking-tight ${color}`}>
            {value}
          </div>
          {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
        </>
      )}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}
