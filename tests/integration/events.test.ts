import { randomUUID } from 'node:crypto';
import { createSql, type Sql } from '@autodeploy/db';
import {
  createProducer,
  dlqTopic,
  ensureTopics,
  type KafkaConfig,
  publish,
  resetGroup,
  runConsumer,
  TOPICS,
} from '@autodeploy/events';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeOrg } from './helpers';

let sql: Sql;
let kafka: KafkaConfig;
let producer: ReturnType<typeof createProducer>;
const log = { info: () => {}, warn: () => {}, error: () => {} };
const topic = TOPICS.deploymentEvents.name;

beforeAll(async () => {
  sql = createSql(inject('databaseUrl'), { max: 10 });
  kafka = { brokers: [inject('kafkaBrokers')], clientId: 'it' };
  await ensureTopics(kafka, [dlqTopic('it-effects')]);
  producer = createProducer(kafka);
  await sql`create table if not exists it_effects (event_id text, group_id text)`;
});
afterAll(async () => {
  await producer.close();
  await sql.end();
});

const event = (orgId: string, type = 'deployment.status_changed', id = randomUUID()) =>
  JSON.stringify({
    id,
    type,
    occurredAt: new Date().toISOString(),
    orgId,
    projectId: null,
    deploymentId: null,
    data: {},
  });

async function until(fn: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting');
}

describe('Kafka consumers', () => {
  it('turn duplicate deliveries into one side effect, dead-letter poison messages, and keep going', async () => {
    const group = `it-effects`;
    const org = await makeOrg(sql);
    const dupId = randomUUID();
    const after = randomUUID();
    const consumer = await runConsumer({
      kafka,
      groupId: group,
      topics: [topic],
      sql,
      producer,
      maxAttempts: 2,
      log,
      handler: async (e, tx) => {
        if (e.orgId !== org) return;
        if (e.type === 'poison') throw new Error('cannot handle this');
        await tx`insert into it_effects (event_id, group_id) values (${e.id}, ${group})`;
      },
    });
    await publish(producer, [
      { topic, key: org, value: event(org, 'deployment.status_changed', dupId) },
      { topic, key: org, value: event(org, 'deployment.status_changed', dupId) }, // redelivery
      { topic, key: org, value: event(org, 'poison') },
      { topic, key: org, value: 'not json' },
      { topic, key: org, value: event(org, 'deployment.status_changed', after) },
    ]);
    await until(
      async () => (await sql`select 1 from it_effects where event_id = ${after}`).length === 1,
    );
    const [dup] = await sql<
      { n: number }[]
    >`select count(*)::int as n from it_effects where event_id = ${dupId}`;
    expect(dup?.n).toBe(1);
    const dl = await sql<
      { error: string }[]
    >`select error from dead_letters where consumer = ${group}`;
    expect(dl.length).toBeGreaterThanOrEqual(2);
    expect(dl.some((d) => d.error.includes('cannot handle'))).toBe(true);
    expect(dl.some((d) => d.error.startsWith('unparseable'))).toBe(true);
    await consumer.stop();
  });

  it('replays the whole topic into a projection after a reset', async () => {
    const group = `it-replay-${randomUUID().slice(0, 6)}`;
    const org = await makeOrg(sql);
    const ids = Array.from({ length: 50 }, () => randomUUID());
    await publish(
      producer,
      ids.map((id) => ({ topic, key: org, value: event(org, 'deployment.status_changed', id) })),
    );
    const handler = async (e: { id: string; orgId: string }, tx: Sql) => {
      if (e.orgId === org)
        await tx`insert into it_effects (event_id, group_id) values (${e.id}, ${group})`;
    };
    const count = async () =>
      (
        await sql<
          { n: number }[]
        >`select count(*)::int as n from it_effects where group_id = ${group}`
      )[0]?.n ?? 0;
    let c = await runConsumer({
      kafka,
      groupId: group,
      topics: [topic],
      sql,
      producer,
      log,
      handler: handler as never,
    });
    await until(async () => (await count()) === 50).catch(async (e) => {
      throw new Error(`first read: ${await count()}/50 (${e.message})`);
    });
    await c.stop();

    // Replay: wipe the projection and its dedupe state, reset offsets, read again.
    const t0 = performance.now();
    await sql`delete from it_effects where group_id = ${group}`;
    await sql`delete from processed_events where consumer = ${group}`;
    await resetGroup(kafka, group);
    c = await runConsumer({
      kafka,
      groupId: group,
      topics: [topic],
      sql,
      producer,
      log,
      handler: handler as never,
    });
    await until(async () => (await count()) === 50).catch(async (e) => {
      throw new Error(`replay: ${await count()}/50 (${e.message})`);
    });
    const ms = performance.now() - t0;
    await c.stop();
    expect(await count()).toBe(50);
    console.info(
      `[measure] replayed topic into projection: 50 events rebuilt in ${Math.round(ms)} ms`,
    );
  });
});
