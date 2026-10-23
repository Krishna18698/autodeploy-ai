import { rewrap } from '@autodeploy/crypto';
import { reconcileRoutes, transition } from '@autodeploy/db';
import { reapExpiredLeases, stats } from '@autodeploy/queue';
import { reportError } from '@autodeploy/telemetry';
import type { Deps } from './deps.js';
import { catchUpWebhooks } from './github-catchup.js';
import { metrics } from './metrics.js';
import { sweepStorage } from './storage-sweep.js';

// Periodic maintenance. Only one worker runs it: the one holding a session-
// level advisory lock. If that process dies its connection closes, the lock
// is released, and another worker takes over on its next tick.

const LEADER_LOCK = 727_002;

type Task = { name: string; everyMs: number; run: (deps: Deps) => Promise<void>; last?: number };

const TASKS: Task[] = [
  {
    name: 'reap-leases',
    everyMs: 15_000,
    run: async (deps) => {
      const r = await reapExpiredLeases(deps.sql);
      const n = r.requeued.length + r.dead.length;
      if (n) {
        metrics.leasesReaped.inc({}, n);
        deps.log.warn({ requeued: r.requeued, dead: r.dead }, 'reaped expired job leases');
      }
      // A deployment whose job died for good must not sit in a running state forever.
      if (r.dead.length) await failOrphanedDeployments(deps, r.dead);
    },
  },
  {
    name: 'queue-metrics',
    everyMs: 10_000,
    run: async (deps) => {
      for (const s of await stats(deps.sql)) {
        metrics.queueDepth.set({ type: s.type, status: s.status }, s.count);
        if (s.status === 'queued')
          metrics.oldestQueuedMs.set({ type: s.type }, s.oldestQueuedMs ?? 0);
      }
      const [o] = await deps.sql<
        { n: number }[]
      >`select count(*)::int as n from outbox where published_at is null`;
      metrics.outboxBacklog.set({}, o?.n ?? 0);
    },
  },
  {
    name: 'housekeeping',
    everyMs: 60 * 60_000,
    run: async (deps) => {
      await deps.sql`delete from sessions where expires_at < now()`;
      await deps.sql`delete from email_tokens where expires_at < now() - interval '1 day'`;
      await deps.sql`delete from idempotency_keys where created_at < now() - interval '24 hours'`;
      await deps.sql`delete from github_deliveries where received_at < now() - interval '7 days'`;
      await deps.sql`delete from processed_events where processed_at < now() - interval '14 days'`;
      await deps.sql`delete from jobs where status in ('done', 'canceled') and updated_at < now() - interval '7 days'`;
      await deps.sql`delete from outbox where published_at < now() - interval '3 days'`;
    },
  },
  {
    // Pushes made while AutoDeploy was down (runs first when the worker starts).
    name: 'github-catchup',
    everyMs: 5 * 60_000,
    run: async (deps) => catchUpWebhooks(deps),
  },
  {
    name: 'artifact-retention',
    everyMs: 6 * 60 * 60_000,
    run: async (deps) => pruneArtifacts(deps),
  },
  {
    name: 'storage-sweep',
    everyMs: 24 * 60 * 60_000,
    run: async (deps) => sweepStorage(deps),
  },
  {
    name: 'key-rotation',
    everyMs: 60 * 60_000,
    run: async (deps) => rotateKeys(deps),
  },
  {
    name: 'route-reconcile',
    everyMs: 10 * 60_000,
    run: async (deps) => {
      if (deps.routes.name === 'postgres') return; // DB is the route table already
      await reconcileRoutes(deps.sql, deps.routes);
    },
  },
];

async function failOrphanedDeployments(deps: Deps, deadJobIds: number[]) {
  const rows = await deps.sql<{ deployment_id: string }[]>`
    select payload->>'deploymentId' as deployment_id from jobs where id = any(${deadJobIds}) and type like 'deployment.%'`;
  for (const { deployment_id } of rows) {
    await deps.sql
      .begin((tx) =>
        transition(tx, {
          deploymentId: deployment_id,
          to: 'FAILED',
          set: { error_summary: 'The build worker was lost repeatedly; giving up.' },
        }),
      )
      .catch(() => {}); // already terminal
  }
}

/**
 * Keeps the active deployment and the newest N per project; older artifacts
 * that nothing references are deleted from storage. Their deployments stay in
 * history but can no longer be rolled back to.
 */
async function pruneArtifacts(deps: Deps) {
  const keep = deps.env.RETENTION_KEEP_PER_PROJECT;
  const victims = await deps.sql<{ id: string; storage_prefix: string }[]>`
    with ranked as (
      select d.id, d.artifact_id, d.status, row_number() over (partition by d.project_id order by d.created_at desc) as rn
      from deployments d where d.artifact_id is not null
    ),
    keepers as (
      select artifact_id from ranked where rn <= ${keep} or status in ('ACTIVE', 'READY', 'AWAITING_APPROVAL')
    )
    select a.id, a.storage_prefix from artifacts a
    where a.created_at < now() - interval '7 days' and a.id not in (select artifact_id from keepers)
    limit 200`;
  for (const v of victims) {
    await deps.storage.deletePrefix(`${v.storage_prefix}/`);
    await deps.sql.begin(async (tx) => {
      // A pruned deployment can't be served, so it lets go of its server bundle
      // too; the storage sweep then deletes bundles nothing refers to.
      await tx`update deployments set artifact_id = null, runtime_sha = null where artifact_id = ${v.id}`;
      await tx`delete from artifacts where id = ${v.id}`;
    });
  }
  if (victims.length) deps.log.info({ pruned: victims.length }, 'pruned old artifacts');
}

/** Re-wraps data keys still under an old master key version (no value is re-encrypted). */
async function rotateKeys(deps: Deps) {
  const current = deps.keyring.current;
  const envs = await deps.sql<
    {
      project_id: string;
      key: string;
      ciphertext: Buffer;
      dek_ciphertext: Buffer;
      key_version: number;
    }[]
  >`
    select project_id, key, ciphertext, dek_ciphertext, key_version from env_vars where key_version < ${current} limit 500`;
  for (const e of envs) {
    const ctx = `env:${e.project_id}:${e.key}`;
    const next = rewrap(
      deps.keyring,
      { ciphertext: e.ciphertext, dekCiphertext: e.dek_ciphertext, keyVersion: e.key_version },
      ctx,
    );
    await deps.sql`update env_vars set dek_ciphertext = ${next.dekCiphertext}, key_version = ${next.keyVersion}
      where project_id = ${e.project_id} and key = ${e.key} and key_version = ${e.key_version}`;
  }
  const hooks = await deps.sql<
    { id: string; secret_ciphertext: Buffer; secret_dek: Buffer; key_version: number }[]
  >`
    select id, secret_ciphertext, secret_dek, key_version from webhook_endpoints where key_version < ${current} limit 500`;
  for (const h of hooks) {
    const ctx = `webhook:${h.id}`;
    const next = rewrap(
      deps.keyring,
      { ciphertext: h.secret_ciphertext, dekCiphertext: h.secret_dek, keyVersion: h.key_version },
      ctx,
    );
    await deps.sql`update webhook_endpoints set secret_dek = ${next.dekCiphertext}, key_version = ${next.keyVersion} where id = ${h.id}`;
  }
  if (envs.length + hooks.length)
    deps.log.info(
      { envs: envs.length, webhooks: hooks.length, to: current },
      'rewrapped data keys',
    );
}

export function startCron(deps: Deps): { stop: () => Promise<void> } {
  let stopping = false;
  let leader = false;
  // A reserved connection holds the session lock for as long as we're leader.
  const lockConn = deps.sql.reserve();

  const loop = (async () => {
    const conn = await lockConn;
    while (!stopping) {
      try {
        if (!leader) {
          const [r] = await conn<
            { ok: boolean }[]
          >`select pg_try_advisory_lock(${LEADER_LOCK}) as ok`;
          leader = r?.ok ?? false;
          if (leader) deps.log.info('this worker is now the maintenance leader');
        }
        if (leader) {
          const now = Date.now();
          for (const t of TASKS) {
            if (t.last && now - t.last < t.everyMs) continue;
            t.last = now;
            await t.run(deps).catch((err) => {
              deps.log.error({ err, task: t.name }, 'maintenance task failed');
              reportError(err, { tags: { task: t.name } });
            });
          }
        }
      } catch (err) {
        deps.log.error({ err }, 'cron loop error');
        leader = false;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (leader) await conn`select pg_advisory_unlock(${LEADER_LOCK})`.catch(() => {});
    conn.release();
  })();

  return {
    stop: async () => {
      stopping = true;
      await loop;
    },
  };
}
