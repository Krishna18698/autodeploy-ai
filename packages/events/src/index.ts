import { DomainEvent } from '@autodeploy/contracts';
import {
  Admin,
  Consumer,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka';
import type postgres from 'postgres';

// Kafka is the event backbone (fan-out + replay). Jobs stay in Postgres.
// Delivery is at-least-once end to end, so every consumer is idempotent:
// it records the event id in processed_events inside the same transaction
// as its side effects.

export const TOPICS = {
  deploymentEvents: { name: 'deployment.events', partitions: 3 },
  buildLogs: { name: 'build.logs', partitions: 3 },
} as const;

export const dlqTopic = (group: string) => `dlq.${group}`;

export type KafkaConfig = { brokers: string[]; clientId: string };

export function createProducer(cfg: KafkaConfig) {
  return new Producer({
    clientId: cfg.clientId,
    bootstrapBrokers: cfg.brokers,
    serializers: stringSerializers,
    // Idempotent producer + acks=all: retries can't duplicate or reorder
    // messages within a partition.
    idempotent: true,
    acks: -1,
    autocreateTopics: false,
  });
}
export type KafkaProducer = ReturnType<typeof createProducer>;

export async function ensureTopics(cfg: KafkaConfig, extra: string[] = []): Promise<void> {
  const admin = new Admin({ clientId: `${cfg.clientId}-admin`, bootstrapBrokers: cfg.brokers });
  try {
    const wanted = [
      ...Object.values(TOPICS).map((t) => ({ name: t.name, partitions: t.partitions })),
      ...extra.map((name) => ({ name, partitions: 1 })),
    ];
    const meta = await admin.metadata({ topics: [] });
    const existing = new Set(meta.topics.keys());
    for (const t of wanted) {
      if (existing.has(t.name)) continue;
      try {
        await admin.createTopics({ topics: [t.name], partitions: t.partitions, replicas: 1 });
      } catch (err) {
        // Another process created it between our check and create.
        if (!String((err as Error).message).includes('already exists')) throw err;
      }
    }
  } finally {
    await admin.close();
  }
}

export type PublishMessage = {
  topic: string;
  key: string;
  value: string;
  headers?: Record<string, string>;
};

export async function publish(producer: KafkaProducer, messages: PublishMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await producer.send({
    messages: messages.map((m) => ({
      topic: m.topic,
      key: m.key,
      value: m.value,
      ...(m.headers && { headers: m.headers }),
    })),
  });
}

export type Handler = (event: DomainEvent, tx: postgres.TransactionSql) => Promise<void>;

export type ConsumerOptions = {
  kafka: KafkaConfig;
  groupId: string;
  topics: string[];
  sql: postgres.Sql;
  handler: Handler;
  producer: KafkaProducer;
  maxAttempts?: number;
  log: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
  onProcessed?: (event: DomainEvent) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one consumer group member. Messages are processed in order per
 * partition; the offset is committed only after the side effects commit
 * (or the message has been dead-lettered), so a crash re-delivers rather
 * than loses.
 */
export async function runConsumer(
  o: ConsumerOptions,
): Promise<{ stop: () => Promise<void>; lag: () => Promise<number> }> {
  const consumer = new Consumer({
    groupId: o.groupId,
    clientId: `${o.kafka.clientId}-${o.groupId}`,
    bootstrapBrokers: o.kafka.brokers,
    deserializers: stringDeserializers,
    sessionTimeout: 15_000,
    heartbeatInterval: 1_000,
    rebalanceTimeout: 30_000,
  });
  const stream = await consumer.consume({
    topics: o.topics,
    autocommit: false,
    mode: 'committed',
    fallbackMode: 'earliest',
    maxWaitTime: 500,
  });
  const maxAttempts = o.maxAttempts ?? 3;
  let stopped = false;

  const loop = (async () => {
    for await (const msg of stream) {
      if (stopped) break;
      const raw = msg.value;
      let event: DomainEvent | undefined;
      try {
        event = DomainEvent.parse(JSON.parse(raw));
      } catch (err) {
        await deadLetter(o, msg.topic, undefined, raw, `unparseable: ${(err as Error).message}`, 1);
        await msg.commit();
        continue;
      }
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          const processed = await o.sql.begin(async (tx) => {
            const ins =
              await tx`insert into processed_events (consumer, event_id) values (${o.groupId}, ${event.id})
              on conflict do nothing returning event_id`;
            if (ins.length === 0) return false; // already handled: duplicate delivery
            await o.handler(event, tx);
            return true;
          });
          if (processed) o.onProcessed?.(event);
          break;
        } catch (err) {
          if (attempt >= maxAttempts) {
            o.log.error(
              { err, eventId: event.id, group: o.groupId },
              'event failed; dead-lettering',
            );
            await deadLetter(o, msg.topic, event.id, raw, (err as Error).message, attempt);
            break;
          }
          o.log.warn({ err, eventId: event.id, attempt }, 'event handler failed; retrying');
          await sleep(200 * 2 ** attempt);
        }
      }
      await msg.commit();
    }
  })().catch((err) => {
    if (!stopped) o.log.error({ err, group: o.groupId }, 'consumer loop crashed');
  });

  return {
    stop: async () => {
      stopped = true;
      await stream.close();
      await consumer.close(true);
      await loop;
    },
    lag: async () => {
      const lag = await consumer.getLag({ topics: o.topics });
      let total = 0n;
      for (const parts of lag.values()) for (const p of parts) if (p > 0n) total += p;
      return Number(total);
    },
  };
}

async function deadLetter(
  o: ConsumerOptions,
  topic: string,
  eventId: string | undefined,
  raw: string,
  error: string,
  attempts: number,
) {
  await o.sql`insert into dead_letters (consumer, topic, event_id, payload, error, attempts)
    values (${o.groupId}, ${topic}, ${eventId ?? null}, ${o.sql.json(safeJson(raw) as never)}, ${error.slice(0, 4000)}, ${attempts})`;
  await publish(o.producer, [
    {
      topic: dlqTopic(o.groupId),
      key: eventId ?? 'unknown',
      value: raw,
      headers: { error: error.slice(0, 500), source: topic },
    },
  ]).catch((err) =>
    o.log.error({ err }, 'failed to publish to DLQ topic (row kept in dead_letters)'),
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 10_000) };
  }
}

/** Replay support: forget a group's committed offsets so it restarts from the earliest message. */
export async function resetGroup(cfg: KafkaConfig, groupId: string): Promise<void> {
  const admin = new Admin({ clientId: `${cfg.clientId}-admin`, bootstrapBrokers: cfg.brokers });
  try {
    await admin.deleteGroups({ groups: [groupId] });
  } catch (err) {
    if (!/not found|GROUP_ID_NOT_FOUND|does not exist/i.test(String((err as Error).message)))
      throw err;
  } finally {
    await admin.close();
  }
}
