import {
  activate,
  createSql,
  type RouteStore,
  type RouteValue,
  reconcileRoutes,
  type Sql,
  transition,
  withOrg,
} from '@autodeploy/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeDeployment, makeOrg, makeProject } from './helpers';

let sql: Sql;
beforeAll(() => {
  sql = createSql(inject('databaseUrl'), { max: 10 });
});
afterAll(() => sql.end());

class MemoryRoutes implements RouteStore {
  readonly name = 'memory';
  readonly map = new Map<string, RouteValue>();
  async put(k: string, v: RouteValue) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
}

describe('database guarantees', () => {
  it('the trigger rejects illegal transitions even from raw SQL', async () => {
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const d = await makeDeployment(sql, org, p.id, 'CREATED');
    await expect(sql`update deployments set status = 'ACTIVE' where id = ${d}`).rejects.toThrow(
      /illegal deployment transition CREATED -> ACTIVE/,
    );
    await sql`update deployments set status = 'ANALYZING' where id = ${d}`;
  });

  it('a transition writes status, timeline and outbox atomically', async () => {
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const d = await makeDeployment(sql, org, p.id, 'CREATED');
    await expect(
      sql.begin(async (tx) => {
        await transition(tx, { deploymentId: d, to: 'ANALYZING' });
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash');
    const [s] = await sql<{ status: string }[]>`select status from deployments where id = ${d}`;
    expect(s?.status).toBe('CREATED');
    const [counts] = await sql<{ ev: number; ob: number }[]>`
      select (select count(*)::int from deployment_events where deployment_id = ${d}) as ev,
             (select count(*)::int from outbox where payload->>'deploymentId' = ${d}) as ob`;
    expect(counts).toEqual({ ev: 0, ob: 0 });
    await sql.begin((tx) => transition(tx, { deploymentId: d, to: 'ANALYZING' }));
    const [after] = await sql<{ ev: number; ob: number }[]>`
      select (select count(*)::int from deployment_events where deployment_id = ${d}) as ev,
             (select count(*)::int from outbox where payload->>'deploymentId' = ${d}) as ob`;
    expect(after).toEqual({ ev: 1, ob: 1 });
  });

  it('deployment events are append-only', async () => {
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const d = await makeDeployment(sql, org, p.id, 'CREATED');
    await sql.begin((tx) => transition(tx, { deploymentId: d, to: 'ANALYZING' }));
    await expect(
      sql`update deployment_events set type = 'x' where deployment_id = ${d}`,
    ).rejects.toThrow(/append-only/);
    await expect(sql`delete from deployment_events where deployment_id = ${d}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('row-level security hides other tenants even when the query forgets to filter', async () => {
    const a = await makeOrg(sql);
    const b = await makeOrg(sql);
    const pa = await makeProject(sql, a);
    const pb = await makeProject(sql, b);
    const seen = await withOrg(sql, a, (tx) => tx<{ id: string }[]>`select id from projects`);
    expect(seen.map((r) => r.id)).toContain(pa.id);
    expect(seen.map((r) => r.id)).not.toContain(pb.id);
    const byId = await withOrg(sql, a, (tx) => tx`select id from projects where id = ${pb.id}`);
    expect(byId).toHaveLength(0);
    await expect(
      withOrg(
        sql,
        a,
        (tx) =>
          tx`insert into projects (org_id, slug, name, repo_full_name, repo_url) values (${b}, 'sneaky', 's', 'x/y', 'u')`,
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await withOrg(
      sql,
      a,
      (tx) => tx`update projects set name = 'pwned' where id = ${pb.id} returning id`,
    );
    expect(updated).toHaveLength(0);
  });

  it('every route writer keeps a server-rendered deployment server-rendered', async () => {
    // The periodic KV re-sync once rewrote production routes without the mode,
    // so server-rendered sites turned into 404s within 10 minutes of going live.
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const routes = new MemoryRoutes();
    const d = await makeDeployment(sql, org, p.id, 'CREATED', 1);
    const [a] = await sql<
      { id: string }[]
    >`insert into artifacts (sha256, storage_prefix, file_count, bytes) values (${`sha-${d}`}, 'x', 1, 1) returning id`;
    await sql`update deployments set artifact_id = ${a!.id}, mode = 'ssr' where id = ${d}`;
    for (const s of ['ANALYZING', 'QUEUED', 'BUILDING', 'VALIDATING', 'READY'])
      await sql`update deployments set status = ${s} where id = ${d}`;

    await activate(sql, routes, d, 'promote');
    expect(routes.map.get(`route:${p.slug}`)?.mode).toBe('ssr');
    routes.map.clear();
    expect(await reconcileRoutes(sql, routes)).toBeGreaterThan(0);
    expect(routes.map.get(`route:${p.slug}`)).toMatchObject({ deploymentId: d, mode: 'ssr' });
  });

  it('activation and rollback flip one pointer; concurrent activations serialize', async () => {
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const routes = new MemoryRoutes();
    const mk = async (n: number) => {
      const d = await makeDeployment(sql, org, p.id, 'CREATED', n);
      const [a] = await sql<
        { id: string }[]
      >`insert into artifacts (sha256, storage_prefix, file_count, bytes) values (${`sha-${d}`}, 'x', 1, 1) returning id`;
      await sql`update deployments set artifact_id = ${a!.id} where id = ${d}`;
      for (const s of ['ANALYZING', 'QUEUED', 'BUILDING', 'VALIDATING', 'READY'])
        await sql`update deployments set status = ${s} where id = ${d}`;
      return d;
    };
    const d1 = await mk(1);
    const d2 = await mk(2);
    await activate(sql, routes, d1, 'promote');
    // Two concurrent activations: the advisory lock makes them take turns.
    const d3 = await mk(3);
    await Promise.all([activate(sql, routes, d2, 'promote'), activate(sql, routes, d3, 'promote')]);
    const statuses = await sql<
      { number: number; status: string }[]
    >`select number, status from deployments where project_id = ${p.id} order by number`;
    expect(statuses.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
    const [proj] = await sql<
      { active_deployment_id: string; version: number }[]
    >`select active_deployment_id, version from projects where id = ${p.id}`;
    expect([d2, d3]).toContain(proj?.active_deployment_id);
    expect(routes.map.get(`route:${p.slug}`)?.deploymentId).toBe(proj?.active_deployment_id);

    const t0 = performance.now();
    await activate(sql, routes, d1, 'rollback');
    const ms = performance.now() - t0;
    expect(routes.map.get(`route:${p.slug}`)?.deploymentId).toBe(d1);
    const after = await sql<
      { number: number; status: string }[]
    >`select number, status from deployments where project_id = ${p.id} order by number`;
    expect(after.find((s) => s.number === 1)?.status).toBe('ACTIVE');
    expect(after.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
    expect(after.some((s) => s.status === 'ROLLED_BACK')).toBe(true);
    console.info(`[measure] rollback pointer flip: ${ms.toFixed(1)} ms`);
  });
});
