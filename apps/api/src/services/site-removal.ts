import { routeKey } from '@autodeploy/core';
import type { Tx } from '@autodeploy/db';
import { enqueue } from '@autodeploy/queue';

/**
 * Queues the removal of every hostname a project ever had from the edge (the
 * edge keeps serving whatever KV points at). Call inside the transaction that
 * deletes the project. `orgId` null: the org is being deleted in the same
 * transaction, and jobs owned by it would be deleted with it.
 */
export async function queueSiteRemoval(tx: Tx, projectId: string, orgId: string | null) {
  const rows = await tx<{ slug: string; number: number | null; pr_number: number | null }[]>`
    select p.slug, d.number, d.pr_number from projects p
    left join deployments d on d.project_id = p.id where p.id = ${projectId}`;
  const slug = rows[0]?.slug;
  if (!slug) return;
  const keys = new Set([routeKey({ kind: 'production', slug })]);
  for (const r of rows) {
    if (r.number != null) keys.add(routeKey({ kind: 'deployment', slug, number: r.number }));
    if (r.pr_number != null) keys.add(routeKey({ kind: 'preview', slug, pr: r.pr_number }));
  }
  for (const key of keys) await enqueue(tx, 'routes.remove', { key }, orgId ? { orgId } : {});
}
