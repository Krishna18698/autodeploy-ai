import { publish } from '@autodeploy/events';
import type { Deps } from './deps.js';
import { metrics } from './metrics.js';

// Transactional outbox → Kafka. Rows are claimed with SKIP LOCKED so several
// workers can relay concurrently without double-publishing a row; publishing
// is at-least-once (a crash between send and mark republishes), which the
// consumers' processed_events dedupe absorbs.

export function startRelay(deps: Deps): { stop: () => Promise<void> } {
  let stopping = false;
  let wake: (() => void) | null = null;
  void deps.sql.listen('outbox', () => wake?.());

  const loop = (async () => {
    while (!stopping) {
      let published = 0;
      try {
        published = await deps.sql.begin(async (tx) => {
          const rows = await tx<
            { id: number; event_id: string; topic: string; key: string; payload: unknown }[]
          >`
            select id, event_id, topic, key, payload from outbox where published_at is null
            order by id limit 200 for update skip locked`;
          if (rows.length === 0) return 0;
          await publish(
            deps.producer,
            rows.map((r) => ({
              topic: r.topic,
              key: r.key,
              value: JSON.stringify(r.payload),
              headers: { 'event-id': r.event_id },
            })),
          );
          await tx`update outbox set published_at = now() where id = any(${rows.map((r) => String(r.id))}::bigint[])`;
          return rows.length;
        });
        if (published) metrics.outboxPublished.inc({}, published);
      } catch (err) {
        deps.log.warn({ err }, 'outbox relay failed; will retry');
        await new Promise((r) => setTimeout(r, 2_000));
      }
      if (published === 200) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3_000);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await loop;
    },
  };
}
