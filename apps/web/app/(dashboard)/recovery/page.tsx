'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app/shell';
import { Empty, Panel, Skeleton, Stat } from '@/components/ui/panel';
import { ago } from '@/lib/format';
import { useAllRepairs, useAnalytics } from '@/lib/queries';

const STATUS_TONE: Record<string, string> = {
  awaiting_approval: 'text-ai',
  validated: 'text-ok',
  approved: 'text-ok',
  applied: 'text-run',
  proposed: 'text-run',
  failed: 'text-fail',
  rejected: 'text-muted',
};

export default function RecoveryPage() {
  const all = useAllRepairs('all');
  const a = useAnalytics(30);
  const awaiting = all.data?.filter((r) => r.status === 'awaiting_approval') ?? [];
  const rest = all.data?.filter((r) => r.status !== 'awaiting_approval') ?? [];
  const t = a.data?.totals;
  return (
    <>
      <PageHeader
        title="Recovery center"
        sub="Rules fix what they understand. AI proposes the rest. You approve source changes."
      />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Fixed by rules · 30d" value={t?.recoveredByRule ?? '—'} />
        <Stat label="Fixed by AI · 30d" value={t?.recoveredByAi ?? '—'} />
        <Stat label="Handed to a human · 30d" value={t?.escalated ?? '—'} />
        <Stat
          label="Waiting on you"
          value={awaiting.length}
          tone={awaiting.length ? 'warn' : undefined}
        />
      </div>
      {!all.data ? (
        <Skeleton className="h-40" />
      ) : all.data.length === 0 ? (
        <Empty
          title="No repairs yet"
          hint="When a build fails, its diagnosis and any fix show up here."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {awaiting.length > 0 && (
            <Panel title="Awaiting approval" pad={false}>
              <RepairList items={awaiting} />
            </Panel>
          )}
          <Panel title="History" pad={false}>
            <RepairList items={rest} />
          </Panel>
        </div>
      )}
    </>
  );
}

function RepairList({ items }: { items: NonNullable<ReturnType<typeof useAllRepairs>['data']> }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.id}>
          <Link
            href={`/deployments/${r.deploymentId}`}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 hover:bg-raised/40"
          >
            <span
              className={`w-14 rounded-full px-2 py-0.5 text-center font-mono text-[11px] ${r.strategy === 'ai' ? 'bg-ai/15 text-ai' : 'bg-run/10 text-run'}`}
            >
              {r.strategy === 'ai' ? 'AI' : r.ruleId}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px]">{r.title}</span>
              <span className="block truncate font-mono text-[11px] text-muted">
                {r.projectSlug} #{r.deploymentNumber} · {r.errorCode} · {ago(r.createdAt)}
              </span>
            </span>
            <span className={`font-mono text-[11px] ${STATUS_TONE[r.status] ?? 'text-muted'}`}>
              {r.status.replace('_', ' ')}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
