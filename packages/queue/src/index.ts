import type postgres from 'postgres';

// A Postgres-backed job queue. Jobs are rows; workers claim them with
// FOR UPDATE SKIP LOCKED, hold a time-bounded lease they must keep extending,
// and lose the job to the reaper if they die. Exactly-once *execution* is not
// possible over a network; this gives at-least-once with leases, and handlers
// are written to be idempotent.

type Db = postgres.Sql | postgres.TransactionSql;

export type JobStatus = 'queued' | 'running' | 'done' | 'dead' | 'canceled';

export type Job<P = Record<string, unknown>> = {
  id: number;
  type: string;
  payload: P;
  orgId: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  leaseUntil: Date;
};

export type EnqueueOptions = {
  orgId?: string | null;
  priority?: number;
  runAt?: Date;
  delayMs?: number;
  maxAttempts?: number;
  /** Duplicate enqueues with the same key are ignored. */
  idempotencyKey?: string;
};

export const NOTIFY_CHANNEL = 'jobs';

/** Enqueue inside the caller's transaction; NOTIFY fires on commit. */
export async function enqueue(
  db: Db,
  type: string,
  payload: object,
  opts: EnqueueOptions = {},
): Promise<number | null> {
  // The database clock is the only clock the queue trusts: claim() compares
  // run_at with now(), so stamping it with the app server's clock would let
  // skew between hosts delay (or prematurely release) work.
  const delayMs = opts.delayMs ?? 0;
  const rows = await db<{ id: number }[]>`
    insert into jobs (type, payload, org_id, priority, run_at, max_attempts, idempotency_key)
    values (${type}, ${db.json(payload as never)}, ${opts.orgId ?? null}, ${opts.priority ?? 0},
            coalesce(${opts.runAt ?? null}::timestamptz, now() + ${`${delayMs} milliseconds`}::interval),
            ${opts.maxAttempts ?? 5}, ${opts.idempotencyKey ?? null})
    on conflict (idempotency_key) do nothing
    returning id`;
  await db`select pg_notify(${NOTIFY_CHANNEL}, ${type})`;
  return rows[0]?.id ?? null;
}

export type ClaimOptions = {
  workerId: string;
  types: readonly string[];
  leaseMs: number;
  limit?: number;
  /** Soft per-org cap on concurrently running jobs of these types. */
  perOrgLimit?: number;
};

/**
 * Claim up to `limit` ready jobs. Orgs with fewer running jobs go first, so
 * one org queueing 50 deploys can't starve everyone else. The per-org cap is
 * soft: two workers claiming at the same instant can each see a count of N-1.
 */
export async function claim(sql: Db, o: ClaimOptions): Promise<Job[]> {
  const rows = await sql<
    {
      id: number;
      type: string;
      payload: Record<string, unknown>;
      org_id: string | null;
      priority: number;
      attempts: number;
      max_attempts: number;
      lease_until: Date;
    }[]
  >`
    with candidates as (
      select j.id
      from jobs j
      where j.status = 'queued'
        and j.run_at <= now()
        and j.type = any(${o.types as string[]})
        and (
          j.org_id is null or
          (select count(*) from jobs r
            where r.org_id = j.org_id and r.status = 'running' and r.type = any(${o.types as string[]})) < ${o.perOrgLimit ?? 1000}
        )
      order by
        (select count(*) from jobs r where r.org_id is not distinct from j.org_id and r.status = 'running'),
        j.priority desc, j.run_at, j.id
      limit ${o.limit ?? 1}
      for update skip locked
    )
    update jobs j
       set status = 'running',
           locked_by = ${o.workerId},
           lease_until = now() + ${`${o.leaseMs} milliseconds`}::interval,
           attempts = j.attempts + 1,
           updated_at = now()
      from candidates c
     where j.id = c.id
    returning j.id, j.type, j.payload, j.org_id, j.priority, j.attempts, j.max_attempts, j.lease_until`;
  return rows.map((r) => ({
    id: Number(r.id),
    type: r.type,
    payload: r.payload,
    orgId: r.org_id,
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseUntil: r.lease_until,
  }));
}

export type HeartbeatResult = { ok: true; cancelRequested: boolean } | { ok: false };

/** Extend the lease. `ok: false` means the lease was lost: stop work now. */
export async function heartbeat(
  sql: Db,
  jobId: number,
  workerId: string,
  leaseMs: number,
): Promise<HeartbeatResult> {
  const rows = await sql<{ cancel_requested: boolean }[]>`
    update jobs set lease_until = now() + ${`${leaseMs} milliseconds`}::interval, updated_at = now()
    where id = ${jobId} and locked_by = ${workerId} and status = 'running'
    returning cancel_requested`;
  const row = rows[0];
  return row ? { ok: true, cancelRequested: row.cancel_requested } : { ok: false };
}

export async function complete(sql: Db, jobId: number, workerId: string): Promise<boolean> {
  const rows = await sql`
    update jobs set status = 'done', lease_until = null, updated_at = now()
    where id = ${jobId} and locked_by = ${workerId} and status = 'running'
    returning id`;
  return rows.length === 1;
}

/** Exponential backoff with full jitter: random(0, min(cap, base * 2^attempt)). */
export function backoffMs(
  attempt: number,
  baseMs = 2_000,
  capMs = 5 * 60_000,
  rand: () => number = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(rand() * ceiling);
}

export type FailOptions = { retryable?: boolean; delayMs?: number };

/** Record a failure; requeue with backoff or move to the dead-letter state. */
export async function fail(
  sql: Db,
  job: Pick<Job, 'id' | 'attempts' | 'maxAttempts'>,
  workerId: string,
  error: string,
  o: FailOptions = {},
): Promise<'retry' | 'dead'> {
  const retry = (o.retryable ?? true) && job.attempts < job.maxAttempts;
  if (retry) {
    const delay = o.delayMs ?? backoffMs(job.attempts);
    await sql`
      update jobs set status = 'queued', locked_by = null, lease_until = null, last_error = ${error.slice(0, 4000)},
        run_at = now() + ${`${delay} milliseconds`}::interval, updated_at = now()
      where id = ${job.id} and locked_by = ${workerId}`;
    return 'retry';
  }
  await sql`
    update jobs set status = 'dead', dead_at = now(), locked_by = null, lease_until = null,
      last_error = ${error.slice(0, 4000)}, updated_at = now()
    where id = ${job.id} and locked_by = ${workerId}`;
  return 'dead';
}

/** Mark canceled (queued jobs stop immediately; running ones see it on heartbeat). */
export async function requestCancel(
  sql: Db,
  predicate: { jobId?: number; deploymentId?: string },
): Promise<number> {
  const rows = predicate.jobId
    ? await sql`
        update jobs set cancel_requested = true,
          status = case when status = 'queued' then 'canceled' else status end, updated_at = now()
        where id = ${predicate.jobId} and status in ('queued', 'running') returning id`
    : await sql`
        update jobs set cancel_requested = true,
          status = case when status = 'queued' then 'canceled' else status end, updated_at = now()
        where payload->>'deploymentId' = ${predicate.deploymentId ?? ''} and status in ('queued', 'running') returning id`;
  return rows.length;
}

/**
 * Requeue jobs whose lease expired (worker crashed or hung). Jobs that have
 * used their attempts go to the dead-letter state instead.
 */
export async function reapExpiredLeases(sql: Db): Promise<{ requeued: number[]; dead: number[] }> {
  const rows = await sql<{ id: number; status: JobStatus }[]>`
    update jobs set
      status = case when attempts >= max_attempts then 'dead' else 'queued' end,
      dead_at = case when attempts >= max_attempts then now() else null end,
      locked_by = null, lease_until = null,
      last_error = 'lease expired (worker lost)', updated_at = now()
    where status = 'running' and lease_until < now()
    returning id, status`;
  return {
    requeued: rows.filter((r) => r.status === 'queued').map((r) => Number(r.id)),
    dead: rows.filter((r) => r.status === 'dead').map((r) => Number(r.id)),
  };
}

export type QueueStats = {
  type: string;
  status: JobStatus;
  count: number;
  oldestQueuedMs: number | null;
}[];

export async function stats(sql: Db): Promise<QueueStats> {
  const rows = await sql<
    { type: string; status: JobStatus; count: number; oldest: number | null }[]
  >`
    select type, status, count(*)::int as count,
      (extract(epoch from now() - min(run_at) filter (where status = 'queued')) * 1000)::int as oldest
    from jobs where status in ('queued', 'running', 'dead') group by type, status`;
  return rows.map((r) => ({
    type: r.type,
    status: r.status,
    count: r.count,
    oldestQueuedMs: r.oldest,
  }));
}
