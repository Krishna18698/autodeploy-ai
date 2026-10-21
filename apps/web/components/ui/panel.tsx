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

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded bg-raised ${className}`} />;
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
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'fail' | 'warn' | 'run';
}) {
  const color = tone
    ? { ok: 'text-ok', fail: 'text-fail', warn: 'text-warn', run: 'text-run' }[tone]
    : 'text-fg';
  return (
    <div className="glass rounded-xl px-4 py-3.5">
      <div className="text-[12px] text-muted">{label}</div>
      <div className={`mt-1 text-[26px] font-semibold tabular-nums tracking-tight ${color}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[12px] text-muted">{sub}</div>}
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
