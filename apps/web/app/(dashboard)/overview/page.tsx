'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app/shell';
import { TiltCard } from '@/components/app/tilt-card';
import { LinkButton } from '@/components/ui/button';
import { Empty, Panel, Skeleton, SkeletonItems, SkeletonRows, Stat } from '@/components/ui/panel';
import { Sparkline } from '@/components/ui/sparkline';
import { StatusPill } from '@/components/ui/status';
import { Stepper } from '@/components/ui/stepper';
import { ago, duration, shortSha } from '@/lib/format';
import { useAllRepairs, useAnalytics, useDeployments, useProjects } from '@/lib/queries';
import { STATUS } from '@/lib/status';

export default function OverviewPage() {
  const projects = useProjects();
  const recent = useDeployments({ limit: 30 }, 4_000);
  const today = useAnalytics(1);
  const month = useAnalytics(30);
  const awaiting = useAllRepairs('awaiting_approval');

  const items = recent.data?.items ?? [];
  const live = items.find((d) => STATUS[d.status].live);
  const t = month.data?.totals;
  const successRate = t?.deployments ? Math.round((t.succeeded / t.deployments) * 100) : null;

  return (
    <>
      <PageHeader
        title="Overview"
        sub="Everything deploying across your projects, live."
        actions={
          <LinkButton variant="primary" href="/projects/new">
            New project
          </LinkButton>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Deploys today"
          loading={!today.data}
          value={today.data ? today.data.totals.deployments : '—'}
          sub={month.data ? `${month.data.totals.deployments} in 30 days` : ' '}
        />
        <Stat
          label="Success rate · 30d"
          loading={!month.data}
          value={successRate === null ? '—' : `${successRate}%`}
          sub={t ? `${t.failed} failed` : ' '}
        />
        <Stat
          label="Auto-recovered · 30d"
          loading={!month.data}
          value={t ? t.recoveredByRule + t.recoveredByAi : '—'}
          sub={t ? `${t.recoveredByRule} by rules · ${t.recoveredByAi} by AI` : ' '}
        />
        <Stat
          label="Build p95 · 30d"
          loading={!month.data}
          value={duration(month.data?.buildMs.p95)}
          sub={month.data ? `p50 ${duration(month.data.buildMs.p50)}` : ' '}
        />
      </div>

      {awaiting.data && awaiting.data.length > 0 && (
        <Link
          href="/recovery"
          className="mt-4 flex items-center justify-between rounded-[8px] border border-ai/40 bg-ai/10 px-4 py-3 text-[13px] transition-colors hover:bg-ai/15"
        >
          <span>
            <span className="mr-2 font-mono text-ai">⟲</span>
            {awaiting.data.length} AI {awaiting.data.length === 1 ? 'repair is' : 'repairs are'}{' '}
            waiting for your approval
          </span>
          <span className="font-mono text-ai">Review →</span>
        </Link>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <Panel title="Projects" pad={false}>
          {projects.isLoading ? (
            <SkeletonRows rows={3} className="h-10" />
          ) : !projects.data?.items.length ? (
            <Empty
              title="No projects yet"
              hint="Import a repository and AutoDeploy works out how to build it."
              action={
                <LinkButton variant="primary" href="/projects/new">
                  Import a repository
                </LinkButton>
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {projects.data.items.map((p) => {
                const history = items
                  .filter((d) => d.projectId === p.id)
                  .slice(0, 12)
                  .reverse();
                return (
                  <li key={p.id}>
                    <Link
                      href={`/projects/${p.id}`}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-raised/50 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium">{p.slug}</div>
                        <div className="truncate font-mono text-[11px] text-muted">
                          {p.framework} · {p.repoFullName}
                        </div>
                      </div>
                      <span className="hidden sm:block">
                        <Sparkline
                          values={history.map(
                            (d) =>
                              (d.finishedAt
                                ? new Date(d.finishedAt).getTime() - new Date(d.createdAt).getTime()
                                : 0) / 1000,
                          )}
                          label={`${p.slug} recent build times`}
                        />
                      </span>
                      {p.latestDeployment ? (
                        <StatusPill status={p.latestDeployment.status} />
                      ) : (
                        <span className="font-mono text-[11px] text-muted">no deploys</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-6">
          <TiltCard>
            <Panel title={live ? 'Live deploy' : 'Latest deploy'}>
              {!recent.data ? (
                <div role="status" className="flex flex-col gap-3">
                  <span className="sr-only">Loading</span>
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              ) : items[0] ? (
                (() => {
                  const d = live ?? items[0];
                  return (
                    <Link href={`/deployments/${d.id}`} className="block">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[12px] text-muted">
                          {d.projectSlug} ▸ #{d.number} ▸ {d.branch ?? 'main'} @{' '}
                          {shortSha(d.commitSha)}
                        </span>
                        <StatusPill status={d.status} />
                      </div>
                      <Stepper status={d.status} />
                      <p className="mt-3 truncate text-[13px] text-muted">
                        {d.commitMessage ?? '—'}
                      </p>
                    </Link>
                  );
                })()
              ) : (
                <p className="text-[13px] text-muted">No deployments yet.</p>
              )}
            </Panel>
          </TiltCard>

          <Panel title="Activity" pad={false}>
            <ul className="divide-y divide-line">
              {items.slice(0, 8).map((d) => (
                <li key={d.id}>
                  <Link
                    href={`/deployments/${d.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-raised/50"
                  >
                    <span className="w-14 shrink-0 font-mono text-[11px] text-muted">
                      {ago(d.updatedAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="text-fg">{d.projectSlug}</span>{' '}
                      <span className="text-muted">#{d.number}</span>{' '}
                      {d.recoveredBy && (
                        <span className="font-mono text-[11px] text-ai">
                          auto-fixed by {d.recoveredBy}
                        </span>
                      )}
                    </span>
                    <StatusPill status={d.status} />
                  </Link>
                </li>
              ))}
              {!recent.data && <SkeletonItems rows={5} className="h-5" />}
              {recent.data && items.length === 0 && (
                <li className="px-4 py-6 text-center text-[13px] text-muted">Quiet so far.</li>
              )}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
