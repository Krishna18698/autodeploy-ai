import type { Deployment } from '@autodeploy/contracts';
import { Panel } from '@/components/ui/panel';
import { ago } from '@/lib/format';

const STATE: Record<string, { label: string; dot: string }> = {
  running: { label: 'awake', dot: 'bg-ok' },
  starting: { label: 'waking up', dot: 'bg-run animate-pulse' },
  stopped: { label: 'asleep', dot: 'bg-muted/60' },
  failed: { label: 'failed to start', dot: 'bg-fail' },
};

/** SSR deployments: the server process behind the site (ADR 0008). */
export function RuntimePanel({ d }: { d: Deployment }) {
  if (d.mode !== 'ssr') return null;
  const r = d.runtime;
  const s = STATE[r?.status ?? 'stopped'] ?? STATE.stopped;
  return (
    <Panel title="Server">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[12px]">
        <dt className="text-muted">state</dt>
        <dd className="flex items-center gap-1.5">
          <span aria-hidden className={`size-1.5 rounded-full ${s?.dot}`} />
          {r ? s?.label : 'not started yet'}
        </dd>
        <dt className="text-muted">last visit</dt>
        <dd>{r?.lastRequestAt ? ago(r.lastRequestAt) : '—'}</dd>
        <dt className="text-muted">cold start</dt>
        <dd>{r?.coldStartMs != null ? `${(r.coldStartMs / 1000).toFixed(1)} s` : '—'}</dd>
        <dt className="text-muted">requests</dt>
        <dd>{r?.requests ?? 0}</dd>
      </dl>
      {r?.error && (
        <p className="mt-2 break-words font-mono text-[11px] text-fail">{r.error.slice(0, 300)}</p>
      )}
      <p className="mt-2 text-[11px] text-muted">
        Sleeps after 15 min without visitors; the next request wakes it.
      </p>
    </Panel>
  );
}
