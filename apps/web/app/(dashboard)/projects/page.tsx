'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/app/shell';
import { LinkButton } from '@/components/ui/button';
import { Empty, Panel, Shim } from '@/components/ui/panel';
import { StatusPill } from '@/components/ui/status';
import { ago } from '@/lib/format';
import { useLastCount } from '@/lib/last-count';
import { useProjects } from '@/lib/queries';

export default function ProjectsPage() {
  const projects = useProjects();
  // Placeholders as many rows as last time, so the table doesn't change height.
  const rows = useLastCount('projects', projects.data?.items.length, 1, 10);
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
        {!projects.isLoading && !projects.data?.items.length ? (
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line font-mono text-[11px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-2 font-normal">Project</th>
                  <th className="px-4 py-2 font-normal">Framework</th>
                  <th className="px-4 py-2 font-normal">Latest</th>
                  <th className="px-4 py-2 font-normal">URL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {projects.isLoading &&
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
                {projects.data?.items.map((p) => (
                  <tr key={p.id} className="hover:bg-raised/40">
                    <td className="px-4 py-3">
                      <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.slug}
                      </Link>
                      <div className="font-mono text-[11px] text-muted">{p.repoFullName}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-muted">{p.framework}</td>
                    <td className="px-4 py-3">
                      {p.latestDeployment ? (
                        <span className="flex items-center gap-2">
                          <StatusPill status={p.latestDeployment.status} />
                          <span className="font-mono text-[11px] text-muted">
                            {ago(p.latestDeployment.createdAt)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-[12px] text-run/90">
                      {p.activeDeploymentId ? (
                        p.url.replace('https://', '')
                      ) : (
                        <span className="text-muted">not live</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
