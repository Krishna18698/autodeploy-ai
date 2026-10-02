import type { DomainEvent } from '@autodeploy/contracts';
import { TOPICS } from '@autodeploy/db';
import { runConsumer } from '@autodeploy/events';
import { enqueue } from '@autodeploy/queue';
import type postgres from 'postgres';
import type { Deps } from '../deps.js';
import { sendEmail } from '../email.js';
import { metrics } from '../metrics.js';

// Three independent consumer groups read the same deployment events — the
// reason Kafka is here at all. Each keeps its own offsets, can lag or be
// replayed without affecting the others, and dedupes on event id.

export const GROUPS = {
  realtime: 'realtime',
  notifier: 'notifier',
  analytics: 'analytics',
} as const;

const STREAM_MAXLEN = 5000;
const streamKey = (deploymentId: string) => `deploy:${deploymentId}`;

/** realtime: Kafka → capped Valkey Stream per deployment → SSE clients. */
async function realtime(deps: Deps, e: DomainEvent) {
  if (!e.deploymentId) return;
  const key = streamKey(e.deploymentId);
  const kind = e.type === 'build.log' ? 'log' : 'status';
  const body =
    e.type === 'build.log' ? e.data : { type: e.type, occurredAt: e.occurredAt, ...e.data };
  await deps.valkey
    .multi()
    .xadd(key, 'MAXLEN', '~', STREAM_MAXLEN, '*', 'kind', kind, 'data', JSON.stringify(body))
    .expire(key, 86_400)
    .exec();
}

const WEBHOOK_EVENT: Record<string, string> = {
  'deployment.created': 'deployment.created',
  'deployment.activated': 'deployment.activated',
  'deployment.rolled_back': 'deployment.rolled_back',
};

function webhookTypeFor(e: DomainEvent): string | null {
  if (WEBHOOK_EVENT[e.type]) return WEBHOOK_EVENT[e.type] ?? null;
  if (e.type !== 'deployment.status_changed') return null;
  const to = e.data.to;
  if (to === 'READY' || to === 'ACTIVE') return 'deployment.succeeded';
  if (to === 'FAILED' || to === 'NEEDS_INPUT') return 'deployment.failed';
  if (to === 'AWAITING_APPROVAL') return 'repair.awaiting_approval';
  return null;
}

/** notifier: outbound webhooks, email, GitHub commit statuses. */
async function notifier(deps: Deps, e: DomainEvent, tx: postgres.TransactionSql) {
  const type = webhookTypeFor(e);
  if (type) {
    const endpoints = await tx<{ id: string }[]>`
      select id from webhook_endpoints where org_id = ${e.orgId} and active and ${type} = any(events)`;
    for (const ep of endpoints) {
      const [d] = await tx<{ id: string }[]>`
        insert into webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload)
        values (${ep.id}, ${e.orgId}, ${e.id}, ${type}, ${tx.json({ id: e.id, type, occurredAt: e.occurredAt, deploymentId: e.deploymentId, projectId: e.projectId, data: e.data } as never)})
        on conflict (endpoint_id, event_id) do nothing returning id`;
      if (d)
        await enqueue(
          tx,
          'webhook.deliver',
          { deliveryId: d.id },
          { orgId: e.orgId, maxAttempts: 6 },
        );
    }
  }
  if (e.type === 'deployment.status_changed' && e.deploymentId) {
    const to = String(e.data.to);
    const state =
      to === 'BUILDING'
        ? 'pending'
        : to === 'READY' || to === 'ACTIVE'
          ? 'success'
          : to === 'FAILED' || to === 'NEEDS_INPUT'
            ? 'failure'
            : null;
    if (state && deps.installations) {
      await enqueue(
        tx,
        'github.status',
        {
          deploymentId: e.deploymentId,
          state,
          description: `AutoDeploy #${e.data.number}: ${to.toLowerCase()}`,
        },
        { orgId: e.orgId, maxAttempts: 3 },
      );
    }
    if (to === 'FAILED' || to === 'NEEDS_INPUT' || to === 'AWAITING_APPROVAL') {
      const admins = await tx<{ email: string | null }[]>`
        select u.email from memberships m join users u on u.id = m.user_id where m.org_id = ${e.orgId} and m.role in ('owner', 'admin')`;
      const [p] = await tx<{ slug: string }[]>`select slug from projects where id = ${e.projectId}`;
      const subject =
        to === 'AWAITING_APPROVAL'
          ? `${p?.slug}: a repair is waiting for your approval`
          : `${p?.slug}: deployment #${e.data.number} ${to === 'FAILED' ? 'failed' : 'needs input'}`;
      for (const a of admins) {
        if (a.email)
          await sendEmail(deps, {
            to: a.email,
            subject,
            text: `${subject}.\n\n${deps.env.APP_URL}/deployments/${e.deploymentId}`,
          });
      }
    }
  }
}

const OUTCOME: Record<string, 'succeeded' | 'failed' | 'canceled' | 'needs_input'> = {
  READY: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  NEEDS_INPUT: 'needs_input',
};

/** analytics: a projection rebuilt purely from events (so replay is exact). */
async function analytics(_deps: Deps, e: DomainEvent, tx: postgres.TransactionSql) {
  if (e.type !== 'deployment.status_changed' || !e.deploymentId || !e.projectId) return;
  const outcome = OUTCOME[String(e.data.to)];
  if (!outcome) return;
  const d = e.data as {
    startedAt?: string | null;
    finishedAt?: string | null;
    queuedAt?: string | null;
    createdAt?: string;
    recoveredBy?: string | null;
    errorCode?: string | null;
    attempts?: number;
    attemptNo?: number;
  };
  const finished = new Date(d.finishedAt ?? e.occurredAt);
  const started = d.startedAt ? new Date(d.startedAt) : null;
  const queued = d.queuedAt ? new Date(d.queuedAt) : d.createdAt ? new Date(d.createdAt) : null;
  await tx`
    insert into analytics_builds (deployment_id, org_id, project_id, outcome, recovered_by, error_code, attempts, build_ms, queue_wait_ms, finished_at, source_event_id)
    values (${e.deploymentId}, ${e.orgId}, ${e.projectId}, ${outcome}, ${d.recoveredBy ?? null}, ${d.errorCode ?? null},
            ${d.attempts ?? d.attemptNo ?? 1}, ${started ? finished.getTime() - started.getTime() : null},
            ${started && queued ? Math.max(0, started.getTime() - queued.getTime()) : null}, ${finished}, ${e.id})
    on conflict (deployment_id) do update set outcome = excluded.outcome, recovered_by = excluded.recovered_by,
      error_code = excluded.error_code, attempts = excluded.attempts, build_ms = excluded.build_ms,
      queue_wait_ms = excluded.queue_wait_ms, finished_at = excluded.finished_at, source_event_id = excluded.source_event_id`;
}

export type RunningConsumer = {
  group: string;
  stop: () => Promise<void>;
  lag: () => Promise<number>;
};

export async function startConsumer(
  deps: Deps,
  group: keyof typeof GROUPS,
): Promise<RunningConsumer> {
  const topics =
    group === 'realtime' ? [TOPICS.deploymentEvents, TOPICS.buildLogs] : [TOPICS.deploymentEvents];
  const handler =
    group === 'realtime'
      ? (e: DomainEvent) => realtime(deps, e)
      : group === 'notifier'
        ? (e: DomainEvent, tx: postgres.TransactionSql) => notifier(deps, e, tx)
        : (e: DomainEvent, tx: postgres.TransactionSql) => analytics(deps, e, tx);
  const c = await runConsumer({
    kafka: deps.kafka,
    groupId: GROUPS[group],
    topics,
    sql: deps.sql,
    producer: deps.producer,
    handler,
    log: deps.log,
    // Live view tolerates the rare duplicate line; it isn't worth a DB write per log batch.
    dedupe: group !== 'realtime',
    onProcessed: () => metrics.consumed.inc({ group }),
  });
  return { group, ...c };
}
