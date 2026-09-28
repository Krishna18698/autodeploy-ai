import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';

const CHECK_TIMEOUT_MS = 2000;

async function probe(check: () => Promise<unknown>): Promise<'ok' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'ok';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

export async function healthRoutes(app: FastifyInstance, deps: Deps) {
  // Liveness: the process is up and serving. Never touches dependencies,
  // so a database blip doesn't get the container restarted.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: safe to route traffic here. Used by Caddy during rolling deploys.
  app.get('/readyz', async (_req, reply) => {
    const [postgres, valkey] = await Promise.all([
      probe(() => deps.sql`select 1`),
      probe(() => deps.valkey.ping()),
    ]);
    const ready = postgres === 'ok' && valkey === 'ok';
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: { postgres, valkey },
    });
  });
}
