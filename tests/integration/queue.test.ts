import { randomUUID } from 'node:crypto';
import { createSql, type Sql } from '@autodeploy/db';
import {
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  reapExpiredLeases,
  requestCancel,
} from '@autodeploy/queue';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { makeOrg } from './helpers';

let sql: Sql;
beforeAll(() => {
  sql = createSql(inject('databaseUrl'), { max: 20 });
});
afterAll(() => sql.end());
beforeEach(async () => {
  await sql`delete from jobs`;
});

const type = 'test.job';

describe('job queue', () => {
  it('never hands the same job to two workers (8 workers × 500 jobs)', async () => {
    const org = await makeOrg(sql);
    for (let i = 0; i < 500; i += 100) {
      await sql.begin(async (tx) => {
        for (let j = i; j < i + 100; j++) await enqueue(tx, type, { n: j }, { orgId: org });
      });
    }
    const seen: number[] = [];
    const worker = async (id: string) => {
      for (;;) {
        const jobs = await claim(sql, { workerId: id, types: [type], leaseMs: 30_000, limit: 5 });
        if (jobs.length === 0) return;
        for (const j of jobs) {
          seen.push(j.id);
          await complete(sql, j.id, id);
        }
      }
    };
    const started = performance.now();
    await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
    const ms = performance.now() - started;
    expect(seen.length).toBe(500);
    expect(new Set(seen).size).toBe(500); // zero duplicate claims
    const [left] = await sql<
      { n: number }[]
    >`select count(*)::int as n from jobs where status <> 'done'`;
    expect(left?.n).toBe(0);
    console.info(
      `[measure] 500 jobs, 8 concurrent workers: 0 duplicate claims, ${Math.round(ms)} ms`,
    );
  });

  it('serves the org with fewer running jobs first', async () => {
    const big = await makeOrg(sql);
    const small = await makeOrg(sql);
    for (let i = 0; i < 10; i++) await enqueue(sql, type, { i }, { orgId: big });
    await enqueue(sql, type, { s: 1 }, { orgId: small });
    const [first] = await claim(sql, { workerId: 'a', types: [type], leaseMs: 30_000 });
    expect(first?.orgId).toBe(big); // oldest work first while nobody is running
    const [second] = await claim(sql, { workerId: 'b', types: [type], leaseMs: 30_000 });
    expect(second?.orgId).toBe(small); // big already has one running
  });

  it('enforces a per-org running cap', async () => {
    const org = await makeOrg(sql);
    for (let i = 0; i < 3; i++) await enqueue(sql, type, { i }, { orgId: org });
    expect(
      await claim(sql, { workerId: 'a', types: [type], leaseMs: 30_000, perOrgLimit: 1 }),
    ).toHaveLength(1);
    expect(
      await claim(sql, { workerId: 'b', types: [type], leaseMs: 30_000, perOrgLimit: 1 }),
    ).toHaveLength(0);
  });

  it('requeues a job whose worker stopped heartbeating, and the old worker loses it', async () => {
    await enqueue(sql, type, {}, { maxAttempts: 3 });
    const [j] = await claim(sql, { workerId: 'crashed', types: [type], leaseMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    const reaped = await reapExpiredLeases(sql);
    expect(reaped.requeued).toContain(j!.id);
    expect(await heartbeat(sql, j!.id, 'crashed', 30_000)).toEqual({ ok: false });
    const [again] = await claim(sql, { workerId: 'healthy', types: [type], leaseMs: 30_000 });
    expect(again?.id).toBe(j!.id);
    expect(again?.attempts).toBe(2);
    expect(await complete(sql, j!.id, 'crashed')).toBe(false); // stale owner can't complete it
  });

  it('dead-letters after max attempts and backs off between retries', async () => {
    await enqueue(sql, type, {}, { maxAttempts: 2 });
    const [a] = await claim(sql, { workerId: 'w', types: [type], leaseMs: 30_000 });
    expect(await fail(sql, a!, 'w', 'boom')).toBe('retry');
    const [row] = await sql<
      { run_at: Date; status: string }[]
    >`select run_at, status from jobs where id = ${a!.id}`;
    expect(row?.status).toBe('queued');
    expect(row!.run_at.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
    await sql`update jobs set run_at = now() where id = ${a!.id}`;
    const [b] = await claim(sql, { workerId: 'w', types: [type], leaseMs: 30_000 });
    expect(await fail(sql, b!, 'w', 'boom again')).toBe('dead');
    const [dead] = await sql<
      { status: string; dead_at: Date | null }[]
    >`select status, dead_at from jobs where id = ${a!.id}`;
    expect(dead?.status).toBe('dead');
    expect(dead?.dead_at).not.toBeNull();
  });

  it('ignores duplicate enqueues with the same idempotency key, and cancels', async () => {
    const key = `k-${randomUUID()}`;
    const id1 = await enqueue(sql, type, {}, { idempotencyKey: key });
    const id2 = await enqueue(sql, type, {}, { idempotencyKey: key });
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();
    expect(await requestCancel(sql, { jobId: id1! })).toBe(1);
    expect(await claim(sql, { workerId: 'w', types: [type], leaseMs: 30_000 })).toHaveLength(0);
  });

  it('surfaces cancellation of a running job on the next heartbeat', async () => {
    await enqueue(sql, type, { deploymentId: 'd-1' });
    const [j] = await claim(sql, { workerId: 'w', types: [type], leaseMs: 30_000 });
    await requestCancel(sql, { deploymentId: 'd-1' });
    expect(await heartbeat(sql, j!.id, 'w', 30_000)).toEqual({ ok: true, cancelRequested: true });
  });
});
