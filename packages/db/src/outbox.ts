import { monotonicFactory } from 'ulid';
import type { Db } from './client.js';

const ulid = monotonicFactory();

export const TOPICS = {
  deploymentEvents: 'deployment.events',
  buildLogs: 'build.logs',
} as const;

export type OutboxEvent = {
  type: string;
  orgId: string;
  projectId?: string | null;
  deploymentId?: string | null;
  data: Record<string, unknown>;
  traceparent?: string | undefined;
};

/**
 * Writes a domain event in the caller's transaction. It is published to Kafka
 * only after commit (by the relay), so an event exists iff the state change
 * it describes was committed.
 */
export async function appendOutbox(
  db: Db,
  ev: OutboxEvent,
  topic: string = TOPICS.deploymentEvents,
): Promise<string> {
  const id = ulid();
  const payload = {
    id,
    type: ev.type,
    occurredAt: new Date().toISOString(),
    orgId: ev.orgId,
    projectId: ev.projectId ?? null,
    deploymentId: ev.deploymentId ?? null,
    data: ev.data,
    ...(ev.traceparent && { traceparent: ev.traceparent }),
  };
  // Partition by project so each project's events stay in order.
  const key = ev.projectId ?? ev.orgId;
  await db`insert into outbox (event_id, topic, key, payload) values (${id}, ${topic}, ${key}, ${db.json(payload as never)})`;
  await db`select pg_notify('outbox', '')`;
  return id;
}
