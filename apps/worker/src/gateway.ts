import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { parseKeyring } from '@autodeploy/crypto';
import { createSql } from '@autodeploy/db';
import { Storage } from '@autodeploy/storage';
import { createLogger, initErrorReporting, reportError } from '@autodeploy/telemetry';
import { loadEnv } from './env.js';
import { RuntimeManager, RuntimeUnavailable } from './gateway/runtimes.js';

// The SSR runtime gateway (ADR 0008). The edge Worker sends every request for a
// server-rendered site here (through the tunnel) with the deployment id and the
// internal token; this starts the deployment's container if it's asleep and
// proxies the request to it, streaming both ways.

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
// Hop-by-hop and our own control headers never reach the app.
const STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'x-internal-token',
  'x-autodeploy-deployment',
]);

function authorized(h: IncomingHttpHeaders): boolean {
  const t = h['x-internal-token'];
  if (typeof t !== 'string') return false;
  const b = Buffer.from(t);
  return b.length === token.length && timingSafeEqual(b, token);
}

function page(status: number, message: string) {
  return `<!doctype html><meta charset="utf-8"><title>${status}</title><style>body{background:#0a0c0f;color:#e8ebf0;font:15px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0}p{color:#8a93a3}</style><div><h1>${status}</h1><p>${message}</p></div>`;
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
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined && !STRIP.has(k)) headers[k] = v;
  const fwdHost = req.headers['x-forwarded-host'];
  if (typeof fwdHost === 'string') headers.host = fwdHost;
  const up = httpRequest(
    { host: inst.host, port: inst.port, method: req.method, path: req.url, headers },
    (r) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers))
        if (v !== undefined && !STRIP.has(k)) out[k] = v;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    },
  );
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    inst.active--;
    runtimes.touch(inst);
  };
  res.on('close', done);
  up.on('error', (err) => {
    log.warn({ err, deploymentId: id }, 'upstream error');
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(res.headersSent ? undefined : page(502, 'This site stopped responding.'));
    done();
  });
  req.pipe(up);
});

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
