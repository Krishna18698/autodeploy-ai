import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetGroup } from '@autodeploy/events';
import type { RunningConsumer } from './consumers/index.js';
import type { Deps } from './deps.js';

// Rebuilding a projection from the event log — the "replay" half of why
// Kafka is here. The analytics consumer is stopped, its offsets and output
// are wiped, and it re-reads the topic from the beginning.

export async function replayAnalytics(deps: Deps) {
  const started = performance.now();
  await resetGroup(deps.kafka, 'analytics');
  await deps.sql.begin(async (tx) => {
    await tx`delete from processed_events where consumer = 'analytics'`;
    await tx`truncate analytics_builds`;
  });
  return {
    waitForCatchUp: async (c: RunningConsumer) => {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if ((await c.lag().catch(() => 1)) === 0) break;
      }
      const [n] = await deps.sql<{ events: number; rows: number }[]>`
        select (select count(*)::int from processed_events where consumer = 'analytics') as events,
               (select count(*)::int from analytics_builds) as rows`;
      return {
        events: n?.events ?? 0,
        rows: n?.rows ?? 0,
        ms: Math.round(performance.now() - started),
      };
    },
  };
}

// CLI: ask the running worker to replay and print the measured result.
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain && process.argv[2] === 'analytics') {
  const { Valkey } = await import('iovalkey');
  const url = process.env.VALKEY_URL;
  if (!url) throw new Error('VALKEY_URL is required');
  const pub = new Valkey(url);
  const sub = new Valkey(url);
  const replyTo = `worker:replay:${Date.now()}`;
  await sub.subscribe(replyTo);
  const done = new Promise<string>((resolve) => sub.on('message', (_c, m) => resolve(m)));
  await pub.publish(
    'worker:control',
    JSON.stringify({ cmd: 'replay', group: 'analytics', replyTo }),
  );
  console.log('replaying analytics from the beginning of deployment.events…');
  const r = JSON.parse(await done) as { events: number; rows: number; ms: number };
  console.log(`rebuilt analytics: ${r.events} events → ${r.rows} rows in ${r.ms} ms`);
  pub.disconnect();
  sub.disconnect();
}
