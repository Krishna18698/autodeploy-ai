import { routeKey } from '@autodeploy/core';
import type { Sql, Tx } from './client.js';
import { type RouteStore, routeValue, TAKEN_DOWN } from './routes.js';

/** Whether a project may serve or deploy: not taken down, and its account not suspended. */
export async function isTakenDown(sql: Sql | Tx, projectId: string): Promise<boolean> {
  const [r] = await sql<{ down: boolean }[]>`
    select (p.taken_down_at is not null or o.suspended_at is not null) as down
    from projects p join orgs o on o.id = p.org_id where p.id = ${projectId}`;
  return r?.down ?? false;
}

type Deployed = {
  id: string;
  number: number;
  pr_number: number | null;
  sha256: string;
  mode: 'static' | 'ssr';
};

async function routesOf(sql: Sql, projectId: string) {
  const [p] = await sql<{ slug: string; active_deployment_id: string | null }[]>`
    select slug, active_deployment_id from projects where id = ${projectId}`;
  if (!p) return null;
  // Everything that ever got an address: deployments with a built artifact.
  const deployed = await sql<Deployed[]>`
    select d.id, d.number, d.pr_number, a.sha256, d.mode from deployments d
    join artifacts a on a.id = d.artifact_id where d.project_id = ${projectId} order by d.number`;
  return { slug: p.slug, activeId: p.active_deployment_id, deployed };
}

/**
 * Every address of the project answers "taken down" at the edge: production,
 * each deployment's own address and each preview. Idempotent.
 */
export async function takeDownRoutes(sql: Sql, routes: RouteStore, projectId: string) {
  const r = await routesOf(sql, projectId);
  if (!r) return 0;
  const keys = new Set([routeKey({ kind: 'production', slug: r.slug })]);
  for (const d of r.deployed) {
    keys.add(routeKey({ kind: 'deployment', slug: r.slug, number: d.number }));
    if (d.pr_number !== null)
      keys.add(routeKey({ kind: 'preview', slug: r.slug, pr: d.pr_number }));
  }
  for (const key of keys) await routes.put(key, TAKEN_DOWN);
  return keys.size;
}

/** Puts back what the database says is live (after a restore or an unsuspend). */
export async function restoreRoutes(sql: Sql, routes: RouteStore, projectId: string) {
  const r = await routesOf(sql, projectId);
  if (!r) return 0;
  const value = (d: Deployed) =>
    routeValue({
      deploymentId: d.id,
      number: d.number,
      artifactSha: d.sha256,
      projectSlug: r.slug,
      mode: d.mode,
    });
  const production = routeKey({ kind: 'production', slug: r.slug });
  const active = r.deployed.find((d) => d.id === r.activeId);
  if (active) await routes.put(production, value(active));
  else await routes.delete(production);
  // Each preview shows its latest build (deployed is in number order).
  const previews = new Map<number, Deployed>();
  for (const d of r.deployed) {
    await routes.put(routeKey({ kind: 'deployment', slug: r.slug, number: d.number }), value(d));
    if (d.pr_number !== null) previews.set(d.pr_number, d);
  }
  for (const [pr, d] of previews)
    await routes.put(routeKey({ kind: 'preview', slug: r.slug, pr }), value(d));
  return 1 + r.deployed.length + previews.size;
}
