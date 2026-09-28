import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Deps } from './deps.js';
import type { Env } from './env.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(env: Env, deps: Deps) {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    },
    // Honour an upstream request id (Cloudflare / Caddy) so one id follows the
    // request across hops; otherwise mint one.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: true,
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(async (scope) => healthRoutes(scope, deps));

  return app;
}
