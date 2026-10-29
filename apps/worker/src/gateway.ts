import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { parseKeyring } from '@autodeploy/crypto';
import { createSql } from '@autodeploy/db';
import { Storage } from '@autodeploy/storage';
import { createLogger, initErrorReporting, reportError } from '@autodeploy/telemetry';
import { loadEnv } from './env.js';
import { SiteCookieMemory } from './gateway/cookies.js';
import { page, proxyToApp, stopped } from './gateway/proxy.js';
import { RuntimeManager, RuntimeUnavailable } from './gateway/runtimes.js';

// The SSR runtime gateway (ADR 0008). The edge Worker sends every request for a
// server-rendered site here (through the tunnel) with the deployment id and the
// internal token; this starts the deployment's container if it's asleep and
// proxies the request to it, streaming both ways (gateway/proxy.ts, which
// also applies the rules for cookies on the sites' shared domain).

const env = loadEnv();
if (!env.INTERNAL_TOKEN) throw new Error('INTERNAL_TOKEN is required for the gateway');
const token = Buffer.from(env.INTERNAL_TOKEN);
const log = createLogger('gateway', env.LOG_LEVEL);
initErrorReporting('gateway', env.SENTRY_DSN);
const sql = createSql(env.DATABASE_URL, { max: 4, application: 'autodeploy-gateway' });
const storage = new Storage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  bucket: env.S3_BUCKET,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
});
const runtimes = new RuntimeManager({
  env,
  sql,
  storage,
  keyring: parseKeyring(env.ENCRYPTION_KEYS),
  log,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const siteCookies = new SiteCookieMemory(sql, log);

function authorized(h: IncomingHttpHeaders): boolean {
  const t = h['x-internal-token'];
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t);
  return b.length === token.length && timingSafeEqual(b, token);
}

const server = createServer(async (req, res) => {
  // Health is for the container's own check (loopback) and token holders; the
  // public run. hostname shouldn't reveal how many apps are awake.
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
    req.socket.remoteAddress ?? '',
  );
  if (req.url === '/__gateway/health' && (loopback || authorized(req.headers))) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', awake: runtimes.awake }));
    return;
  }
  const id = req.headers['x-autodeploy-deployment'];
  if (!authorized(req.headers) || typeof id !== 'string' || !UUID.test(id)) {
    res.writeHead(403).end();
    return;
  }
  await serve(req, res, id);
});

/** Errors that mean the server couldn't be reached at all: it may have died. */
const UNREACHABLE = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ECONNRESET',
  'ETIMEDOUT',
]);

async function serve(req: IncomingMessage, res: ServerResponse, id: string, retried = false) {
  let inst: Awaited<ReturnType<typeof runtimes.ensure>>;
  try {
    inst = await runtimes.ensure(id);
  } catch (err) {
    const status = err instanceof RuntimeUnavailable ? err.status : 502;
    if (!(err instanceof RuntimeUnavailable)) {
      log.error({ err, deploymentId: id }, 'runtime start failed');
      reportError(err, { tags: { deploymentId: id } });
    }
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(
      page(status, err instanceof RuntimeUnavailable ? err.message : 'This site failed to start.'),
    );
    return;
  }
  runtimes.touch(inst);
  inst.active++;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    inst.active--;
    runtimes.touch(inst);
  };
  res.on('close', done);
  // Counted as active first, so the instance isn't put to sleep meanwhile.
  const memory = await siteCookies.get(inst.projectId);
  proxyToApp(
    req,
    res,
    inst,
    { memory, learn: (learned) => void siteCookies.learn(inst.projectId, inst.orgId, learned) },
    (err) => {
      log.warn({ err, deploymentId: id }, 'upstream error');
      done();
      if (!UNREACHABLE.has((err as NodeJS.ErrnoException).code ?? '')) return;
      const dead = runtimes.dropIfDead(inst).catch(() => false);
      // A page load can go again, once, to a fresh start of a server that died.
      if (retried || res.headersSent || (req.method !== 'GET' && req.method !== 'HEAD')) return;
      void dead.then((gone) => (gone ? serve(req, res, id, true) : stopped(res)));
      return 'retry';
    },
  );
}

await mkdir(env.RUNTIME_BUNDLES_DIR, { recursive: true });
// The API applies migrations; wait for runtime_instances rather than racing it.
for (let i = 0; ; i++) {
  try {
    await runtimes.cleanupOrphans();
    break;
  } catch (err) {
    if ((err as { code?: string }).code !== '42P01' || i >= 60) throw err;
    if (i === 0) log.info('waiting for migrations (runtime_instances)');
    await new Promise((r) => setTimeout(r, 2000));
  }
}
let lastPrune = 0;
const reaper = setInterval(() => {
  runtimes.reapIdle().catch((err) => log.warn({ err }, 'reap failed'));
  runtimes.flush().catch((err) => log.warn({ err }, 'flush failed'));
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    runtimes.pruneBundles().catch((err) => log.warn({ err }, 'bundle prune failed'));
  }
}, 30_000);
server.listen(env.GATEWAY_PORT, () => log.info({ port: env.GATEWAY_PORT }, 'gateway listening'));

async function shutdown() {
  clearInterval(reaper);
  server.close();
  await runtimes.stopAll().catch(() => {});
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
