import { migrate } from '@autodeploy/db';
import { dlqTopic, ensureTopics } from '@autodeploy/events';
import { initErrorReporting } from '@autodeploy/telemetry';
import { GROUPS, type RunningConsumer, startConsumer } from './consumers/index.js';
import { startCron } from './cron.js';
import { createDeps } from './deps.js';
import { loadEnv } from './env.js';
import {
  activateDeployment,
  buildDeployment,
  prepareDeployment,
  removeRoute,
} from './jobs/deployment.js';
import { commitStatus, deliverWebhook, openRepairPr } from './jobs/integrations.js';
import { recoverDeployment } from './jobs/recover.js';
import { metrics, startMetricsServer } from './metrics.js';
import { startRelay } from './relay.js';
import { Runner } from './runner.js';

const env = loadEnv();
initErrorReporting('worker', env.SENTRY_DSN);
const deps = createDeps(env);
const { log } = deps;

await migrate(deps.sql);
await deps.storage
  .ensureBucket()
  .catch((err) => log.warn({ err }, 'object storage not reachable yet'));

// A worker that was killed (OOM, kill -9, host reboot) can leave its build
// containers running. This host runs one worker, so anything left is orphaned:
// stop it before claiming new work. Its job comes back via the lease reaper.
{
  const { execFile } = await import('node:child_process');
  const ids = await new Promise<string[]>((resolve) =>
    execFile('docker', ['ps', '-q', '--filter', 'name=^ad-build-'], (err, out) =>
      resolve(err ? [] : out.split('\n').filter(Boolean)),
    ),
  );
  if (ids.length) {
    await new Promise((r) => execFile('docker', ['kill', ...ids], r));
    log.warn({ count: ids.length }, 'killed orphaned build containers from a previous worker');
  }
}

// Every supported Node major needs its sandbox image; say so loudly at boot.
{
  const { SUPPORTED_NODE_MAJORS } = await import('@autodeploy/core');
  const { runProcess } = await import('./executors/sandbox.js');
  const missing: string[] = [];
  for (const m of SUPPORTED_NODE_MAJORS) {
    const img = `${env.SANDBOX_IMAGE_PREFIX}${m}`;
    if ((await runProcess('docker', ['image', 'inspect', img])) !== 0) missing.push(img);
  }
  if (missing.length)
    log.error(
      { missing },
      'sandbox images missing: builds for these Node versions will fail (run infra/sandbox/build-images.sh)',
    );
}

// Heavy and light work get separate slot pools: a long build never blocks
// a webhook delivery or an activation.
const heavy = new Runner(deps, {
  name: 'builds',
  concurrency: env.BUILD_CONCURRENCY,
  perOrgLimit: env.PER_ORG_BUILD_LIMIT,
  handlers: { 'deployment.build': (c) => buildDeployment(deps, c) },
});
const light = new Runner(deps, {
  name: 'light',
  concurrency: env.LIGHT_CONCURRENCY,
  handlers: {
    'deployment.prepare': (c) => prepareDeployment(deps, c),
    'deployment.recover': (c) => recoverDeployment(deps, c),
    'deployment.activate': (c) => activateDeployment(deps, c),
    'routes.remove': (c) => removeRoute(deps, c),
    'webhook.deliver': (c) => deliverWebhook(deps, c),
    'github.status': (c) => commitStatus(deps, c),
    'repair.open_pr': (c) => openRepairPr(deps, c),
  },
});
await heavy.start();
await light.start();
const relay = startRelay(deps);
const cron = startCron(deps);

// Kafka is needed for live logs and the event consumers, not for building:
// the worker runs jobs immediately and attaches consumers once the broker is
// reachable (the outbox holds events until then).
const consumers: RunningConsumer[] = [];
void (async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureTopics(deps.kafka, Object.values(GROUPS).map(dlqTopic));
      for (const g of Object.keys(GROUPS) as Array<keyof typeof GROUPS>)
        consumers.push(await startConsumer(deps, g));
      log.info('event consumers attached');
      return;
    } catch (err) {
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      log.warn(
        { err: (err as Error).message, retryInMs: delay },
        'Kafka unavailable; consumers will attach when it is back',
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
})();

// Consumer lag → Prometheus gauge + a hash the API's analytics endpoint reads.
const lagTimer = setInterval(async () => {
  for (const c of consumers) {
    const lag = await c.lag().catch(() => null);
    if (lag === null) continue;
    metrics.consumerLag.set({ group: c.group }, lag);
    await deps.valkey.hset('metrics:consumer_lag', c.group, String(lag)).catch(() => {});
  }
}, 10_000);

// Replay control: `pnpm replay:analytics` asks the running worker to rebuild.
const control = deps.valkey.duplicate();
await control.subscribe('worker:control');
control.on('message', async (_ch, raw) => {
  const msg = JSON.parse(raw) as { cmd: string; group?: string; replyTo?: string };
  if (msg.cmd !== 'replay' || msg.group !== 'analytics') return;
  const { replayAnalytics } = await import('./replay.js');
  const idx = consumers.findIndex((c) => c.group === 'analytics');
  const old = consumers[idx];
  if (old) await old.stop();
  const result = await replayAnalytics(deps);
  consumers[idx] = await startConsumer(deps, 'analytics');
  const done = await result.waitForCatchUp(consumers[idx] as RunningConsumer);
  if (msg.replyTo) await deps.valkey.publish(msg.replyTo, JSON.stringify(done));
});

const metricsServer = startMetricsServer(env.METRICS_PORT, async () => {
  await deps.sql`select 1`;
  return true;
});
log.info(
  {
    workerId: env.WORKER_ID,
    builds: env.BUILD_CONCURRENCY,
    ai: deps.ai.available,
    routes: deps.routes.name,
  },
  'worker started',
);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(
      { signal },
      'draining: no new jobs; in-flight builds get 20 s, then release their leases',
    );
    clearInterval(lagTimer);
    await Promise.allSettled([
      heavy.stop(),
      light.stop(),
      relay.stop(),
      cron.stop(),
      ...consumers.map((c) => c.stop()),
    ]);
    control.disconnect();
    metricsServer.close();
    await deps.close();
    process.exit(0);
  });
}
