import { reportError } from '@autodeploy/telemetry';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { forbidden } from '../lib/errors.js';

// Crashes in the dashboard (a blank page is invisible to the server) are posted
// here and forwarded to Sentry. Anyone can call it, signed in or not, so it is
// small, rate limited per IP, same-origin only, and only ever records.

const ClientError = z.object({
  kind: z.enum(['error', 'unhandledrejection', 'boundary']),
  name: z.string().max(200).default('Error'),
  message: z.string().max(1000),
  stack: z.string().max(8000).optional(),
  path: z.string().max(500),
  digest: z.string().max(100).optional(),
});

export const clientErrorRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/api/v1/client-errors',
      {
        bodyLimit: 16 * 1024,
        config: { rateLimit: { limit: 10, windowMs: 60_000, key: 'ip' }, csrf: false },
        schema: { hide: true, body: ClientError },
      },
      async (req, reply) => {
        const origin = req.headers.origin;
        if (origin && origin !== deps.env.APP_URL) throw forbidden('Cross-origin report rejected');
        const b = req.body;
        const err = Object.assign(new Error(b.message), { name: b.name, stack: b.stack });
        req.log.warn({ kind: b.kind, path: b.path, err }, 'dashboard error');
        reportError(err, {
          platform: 'javascript',
          tags: { source: 'web', kind: b.kind, path: b.path.split('?')[0] ?? b.path },
          extra: { digest: b.digest, user: req.auth?.login ?? null },
        });
        return reply.code(204).send();
      },
    );
  };
