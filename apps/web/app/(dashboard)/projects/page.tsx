'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app/shell';
import { LinkButton } from '@/components/ui/button';
import { LoadError, MorePages, StaleNotice } from '@/components/ui/load-error';
import { Empty, Panel, Shim } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status';
import { ago } from '@/lib/format';
import { useLastCount } from '@/lib/last-count';
import { type ProjectT, useProjectPages } from '@/lib/queries';

export default function ProjectsPage() {
  const projects = useProjectPages();
  const items = projects.data?.pages.flatMap((p) => p.items);
  // Placeholders as many rows as last time, so the table doesn't change height.
  const rows = useLastCount('projects', items?.length, 1, 10);
  const retry = () => projects.refetch();
  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <LinkButton variant="primary" href="/projects/new">
            New project
          </LinkButton>
        }
      />
      <Panel pad={false}>
        {projects.isError && items && <StaleNotice error={projects.error} onRetry={retry} />}
        {projects.isError && !items ? (
          <LoadError what="projects" error={projects.error} onRetry={retry} />
        ) : items && items.length === 0 ? (
          <Empty
            title="No projects yet"
            hint="Import a public GitHub repository to get started."
            action={
              <LinkButton variant="primary" href="/projects/new">
                Import a repository
              </LinkButton>
            }
          />
        ) : (
          <>
            {/* Phones: one card per project, everything visible without scrolling sideways. */}
            <ul className="divide-y divide-line sm:hidden">
              {!items &&
                Array.from({ length: rows }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                  <li key={i} className="px-4 py-3">
                    <div className="font-medium">
                      <Shim>project-name</Shim>
                    </div>
                    <div className="mt-1 font-mono text-[11px]">
                      <Shim>owner/repository · vite</Shim>
                    </div>
                    <div className="mt-2">
                      <Shim>
                        <StatusPill status="ACTIVE" />
                      </Shim>
                    </div>
                  </li>
                ))}
              {items?.map((p) => (
                <li key={p.id} className="px-4 py-3">
                  <Link href={`/projects/${p.id}`} className="block min-w-0">
                    <span className="block truncate font-medium">{p.slug}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {p.repoFullName} · {p.framework}
                    </span>
                  </Link>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <Latest p={p} />
                    <LiveLink p={p} />
                  </div>
                </li>
              ))}
            </ul>
            {/* Wider screens: a table for scanning. Fixed column widths: placeholders and
                real rows line up, so the headers don't move when the names arrive. */}
            <table className="hidden w-full table-fixed text-left text-[13px] sm:table">
              <colgroup>
                <col />
                <col className="w-28" />
                <col className="w-56" />
                <col />
              </colgroup>
              <thead className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">Project</th>
                  <th className="px-4 py-2 font-normal">Framework</th>
                  <th className="px-4 py-2 font-normal">Latest</th>
                  <th className="px-4 py-2 font-normal">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {!items &&
                  Array.from({ length: rows }, (_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
                    <tr key={i}>
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          <Shim>project-name</Shim>
                        </div>
                        <div className="font-mono text-[11px]">
                          <Shim>owner/repository</Shim>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px]">
                        <Shim>vite</Shim>
                      </td>
                      <td className="px-4 py-3">
                        <span className="flex items-center gap-2">
                          <Shim>
                            <StatusPill status="ACTIVE" />
                          </Shim>
                          <span className="font-mono text-[11px]">
                            <Shim>2m ago</Shim>
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[12px]">
                        <Shim>project.autodeploy.dpdns.org</Shim>
                      </td>
                    </tr>
                  ))}
                {items?.map((p) => (
                  <tr key={p.id} className="hover:bg-raised/40">
                    <td className="px-4 py-3">
                      <Link
                        href={`/projects/${p.id}`}
                        title={p.slug}
                        className="block truncate font-medium hover:underline"
                      >
                        {p.slug}
                      </Link>
                      <div
                        title={p.repoFullName}
                        className="truncate font-mono text-[11px] text-muted"
                      >
                        {p.repoFullName}
                      </div>
                    </td>
                    <td className="truncate px-4 py-3 font-mono text-[12px] text-muted">
                      {p.framework}
                    </td>
                    <td className="px-4 py-3">
                      <Latest p={p} />
                    </td>
                    <td className="truncate px-4 py-3">
                      <LiveLink p={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <MorePages
          shown={items?.length ?? 0}
          hasMore={projects.hasNextPage}
          loading={projects.isFetchingNextPage}
          onMore={() => projects.fetchNextPage()}
        />
      </Panel>
    </>
  );
}

function Latest({ p }: { p: ProjectT }) {
  if (!p.latestDeployment) return <span className="text-muted">No deploys yet</span>;
  return (
    <Link href={`/deployments/${p.latestDeployment.id}`} className="flex items-center gap-2">
      <StatusPill status={p.latestDeployment.status} />
      <span className="font-mono text-[11px] text-muted">
        #{p.latestDeployment.number} · {ago(p.latestDeployment.createdAt)}
      </span>
    </Link>
  );
}

function LiveLink({ p }: { p: ProjectT }) {
  if (!p.activeDeploymentId)
    return <span className="font-mono text-[12px] text-muted">not live</span>;
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noreferrer"
      title={p.url}
      className="block min-w-0 truncate font-mono text-[12px] text-run/90 hover:underline"
    >
      {p.url.replace('https://', '')} <span aria-hidden>↗</span>
      <span className="sr-only"> (opens the live site)</span>
    </a>
  );
}
