'use client';

import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/app/shell';
import { Empty, Panel, Skeleton } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status';
import { ago, shortSha } from '@/lib/format';
import { useDeployments } from '@/lib/queries';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'active', label: 'Live' },
  { id: 'awaiting_approval', label: 'Awaiting approval' },
  { id: 'failed', label: 'Failed' },
];

export default function DeploymentsPage() {
  const [status, setStatus] = useState('');
  const deps = useDeployments({ limit: 100, ...(status && { status }) }, 4_000);
  return (
    <>
      <PageHeader title="Deployments" />
      <fieldset className="mb-4 flex flex-wrap gap-1.5 m-0 border-0 p-0">
        <legend className="sr-only">Filter by status</legend>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={status === f.id}
            onClick={() => setStatus(f.id)}
            className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${status === f.id ? 'border-run/50 bg-run/10 text-fg' : 'border-line text-muted hover:text-fg'}`}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <Panel pad={false}>
        {!deps.data ? (
          <div className="p-4">
            <Skeleton className="h-24" />
          </div>
        ) : deps.data.items.length === 0 ? (
          <Empty title="Nothing here" />
        ) : (
          <ul
            className={`divide-y divide-line transition-opacity ${deps.isFetching ? 'opacity-90' : ''}`}
          >
            {deps.data.items.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/deployments/${d.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 hover:bg-raised/40 sm:grid-cols-[10rem_minmax(0,1fr)_auto_auto]"
                >
                  <span className="truncate text-[13px] font-medium">
                    {d.projectSlug} <span className="text-muted">#{d.number}</span>
                  </span>
                  <span className="hidden truncate text-[13px] text-muted sm:block">
                    <span className="font-mono text-[12px]">{shortSha(d.commitSha)}</span>{' '}
                    {d.commitMessage}
                  </span>
                  <span className="hidden font-mono text-[11px] text-muted sm:block">
                    {d.kind === 'preview' ? `PR #${d.prNumber}` : d.trigger} · {ago(d.createdAt)}
                  </span>
                  <StatusPill status={d.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
