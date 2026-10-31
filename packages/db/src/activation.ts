import { routeKey } from '@autodeploy/core';
import type { Sql, Tx } from './client.js';
import { transition } from './deployments.js';
import { appendOutbox } from './outbox.js';
import { type RouteStore, type RouteValue, routeValue } from './routes.js';
import { isTakenDown } from './takedown.js';

export type ActivationResult = { activatedId: string; previousId: string | null; ms: number };

/**
 * Makes `deploymentId` the live production deployment of its project.
 *
 * Under a per-project advisory lock (so two activations can't interleave):
 *   1. status transitions (READY→ACTIVE, old ACTIVE→SUPERSEDED) — or for a
 *      rollback, ACTIVE→ROLLED_BACK and SUPERSEDED→ACTIVE;
 *   2. the edge route is written *before* commit; if the commit then fails,
 *      the previous route is restored. A reconcile job repairs any drift;
 *   3. projects.active_deployment_id flips. The row is locked from the read,
 *      so nothing can change in between; `version` is left alone, as it
 *      guards the project's settings, and going live changes none of them.
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
          mode: 'static' | 'ssr';
        }[]
      >`
        select id, project_id, org_id, status, kind, number, artifact_id, mode from deployments where id = ${deploymentId}`;
      if (!dep) throw new Error('deployment not found');
      if (dep.kind !== 'production')
        throw new Error('only production deployments can be activated');
      await tx`select pg_advisory_xact_lock(hashtext(${`activate:${dep.project_id}`}))`;

      const [project] = await tx<
        { id: string; slug: string; active_deployment_id: string | null }[]
      >`
        select id, slug, active_deployment_id from projects where id = ${dep.project_id} for update`;
      if (!project) throw new Error('project not found');
      // A taken-down site stays down whatever finishes building.
      if (await isTakenDown(tx, project.id)) throw new Error('site is taken down');
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
      await routes.put(
        key,
        routeValue({
          deploymentId: dep.id,
          number: dep.number,
          artifactSha: artifact.sha256,
          projectSlug: project.slug,
          mode: dep.mode,
        }),
      );

      await tx`update projects set active_deployment_id = ${dep.id}, updated_at = now()
        where id = ${project.id}`;

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

/** What reconcileRoutes last wrote through each store, and when it last wrote them all. */
const reconciled = new WeakMap<RouteStore, { since: number; values: Map<string, string> }>();
const REWRITE_ALL_EVERY_MS = 24 * 60 * 60_000;

/**
 * Brings every project's production route in line with the database, the source
 * of truth (a KV write can fail after a commit, or be edited by hand). A route is
 * written only when it differs from what this last wrote, and all of them once a
 * day: Workers KV allows 1,000 writes a day, and rewriting every route every 10
 * minutes spent 144 a day per live site. Taken-down sites are left alone (their
 * addresses hold the notice). Returns how many routes were written.
 */
export async function reconcileRoutes(
  sql: Sql,
  routes: RouteStore,
  now = Date.now(),
): Promise<number> {
  let memo = reconciled.get(routes);
  if (!memo || now - memo.since >= REWRITE_ALL_EVERY_MS) {
    memo = { since: now, values: new Map() };
    reconciled.set(routes, memo);
  }
  const rows = await sql<
    { slug: string; id: string; number: number; sha256: string; mode: 'static' | 'ssr' }[]
  >`
    select p.slug, d.id, d.number, a.sha256, d.mode from projects p
    join orgs o on o.id = p.org_id
    join deployments d on d.id = p.active_deployment_id join artifacts a on a.id = d.artifact_id
    where p.taken_down_at is null and o.suspended_at is null`;
  let written = 0;
  for (const r of rows) {
    const key = routeKey({ kind: 'production', slug: r.slug });
    const value = routeValue({
      deploymentId: r.id,
      number: r.number,
      artifactSha: r.sha256,
      projectSlug: r.slug,
      mode: r.mode,
    });
    const json = JSON.stringify(value);
    if (memo.values.get(key) === json) continue;
    // Remembered only once written: a failed write is tried again next time.
    await routes.put(key, value);
    memo.values.set(key, json);
    written++;
  }
  return written;
}

async function currentRoute(
  tx: Tx,
  deploymentId: string,
  slug: string,
): Promise<RouteValue | null> {
  const [r] = await tx<{ number: number; sha256: string; mode: 'static' | 'ssr' }[]>`
    select d.number, a.sha256, d.mode from deployments d join artifacts a on a.id = d.artifact_id where d.id = ${deploymentId}`;
  return r
    ? routeValue({
        deploymentId,
        number: r.number,
        artifactSha: r.sha256,
        projectSlug: slug,
        mode: r.mode,
      })
    : null;
}
