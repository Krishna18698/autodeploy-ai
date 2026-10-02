import { routeKey } from '@autodeploy/core';
import type { Sql, Tx } from './client.js';
import { transition } from './deployments.js';
import { appendOutbox } from './outbox.js';
import type { RouteStore, RouteValue } from './routes.js';

export type ActivationResult = { activatedId: string; previousId: string | null; ms: number };

/**
 * Makes `deploymentId` the live production deployment of its project.
 *
 * Under a per-project advisory lock (so two activations can't interleave):
 *   1. status transitions (READY→ACTIVE, old ACTIVE→SUPERSEDED) — or for a
 *      rollback, ACTIVE→ROLLED_BACK and SUPERSEDED→ACTIVE;
 *   2. the edge route is written *before* commit; if the commit then fails,
 *      the previous route is restored. A reconcile job repairs any drift;
 *   3. projects.active_deployment_id flips, with an optimistic version bump.
 * No rebuild happens: a rollback is a pointer flip.
 */
export async function activate(
  sql: Sql,
  routes: RouteStore,
  deploymentId: string,
  mode: 'promote' | 'rollback',
  actor?: string,
): Promise<ActivationResult> {
  const started = performance.now();
  let previousRoute: RouteValue | null = null;
  let key = '';
  try {
    return await sql.begin(async (tx) => {
      const [dep] = await tx<
        {
          id: string;
          project_id: string;
          org_id: string;
          status: string;
          kind: string;
          number: number;
          artifact_id: string | null;
        }[]
      >`
        select id, project_id, org_id, status, kind, number, artifact_id from deployments where id = ${deploymentId}`;
      if (!dep) throw new Error('deployment not found');
      if (dep.kind !== 'production')
        throw new Error('only production deployments can be activated');
      await tx`select pg_advisory_xact_lock(hashtext(${`activate:${dep.project_id}`}))`;

      const [project] = await tx<
        { id: string; slug: string; active_deployment_id: string | null; version: number }[]
      >`
        select id, slug, active_deployment_id, version from projects where id = ${dep.project_id} for update`;
      if (!project) throw new Error('project not found');
      if (project.active_deployment_id === dep.id) {
        return { activatedId: dep.id, previousId: dep.id, ms: performance.now() - started };
      }
      const [artifact] = await tx<
        { sha256: string }[]
      >`select sha256 from artifacts where id = ${dep.artifact_id}`;
      if (!artifact) throw new Error('deployment has no artifact to serve');

      const previousId = project.active_deployment_id;
      if (previousId) {
        await transition(tx, {
          deploymentId: previousId,
          to: mode === 'rollback' ? 'ROLLED_BACK' : 'SUPERSEDED',
          payload: { replacedBy: dep.number, actor },
        });
        previousRoute = await currentRoute(tx, previousId, project.slug);
      }
      await transition(tx, { deploymentId: dep.id, to: 'ACTIVE', payload: { mode, actor } });

      key = routeKey({ kind: 'production', slug: project.slug });
      await routes.put(key, {
        deploymentId: dep.id,
        number: dep.number,
        artifactSha: artifact.sha256,
        projectSlug: project.slug,
      });

      const updated =
        await tx`update projects set active_deployment_id = ${dep.id}, version = version + 1, updated_at = now()
        where id = ${project.id} and version = ${project.version} returning id`;
      if (updated.length !== 1) throw new Error('project changed concurrently; retry');

      await appendOutbox(tx, {
        type: mode === 'rollback' ? 'deployment.rolled_back' : 'deployment.activated',
        orgId: dep.org_id,
        projectId: dep.project_id,
        deploymentId: dep.id,
        data: { number: dep.number, previousId, actor: actor ?? null },
      });
      return { activatedId: dep.id, previousId, ms: performance.now() - started };
    });
  } catch (err) {
    // Commit failed after the route moved: point the edge back.
    if (key && previousRoute) await routes.put(key, previousRoute).catch(() => {});
    throw err;
  }
}

async function currentRoute(
  tx: Tx,
  deploymentId: string,
  slug: string,
): Promise<RouteValue | null> {
  const [r] = await tx<{ number: number; sha256: string }[]>`
    select d.number, a.sha256 from deployments d join artifacts a on a.id = d.artifact_id where d.id = ${deploymentId}`;
  return r ? { deploymentId, number: r.number, artifactSha: r.sha256, projectSlug: slug } : null;
}
