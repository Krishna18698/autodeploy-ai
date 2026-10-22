import { sha256Hex } from '@autodeploy/crypto';
import { reportError } from '@autodeploy/telemetry';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { forbidden } from '../lib/errors.js';

// Crashes in the dashboard (a blank page is invisible to the server) are posted
// here and forwarded to Sentry. Anyone can call it, signed in or not, so it is
// small, rate limited per IP, same-origin only, and only ever records.
// Sentry's free plan holds 5,000 events a month: an hourly cap across all
// callers and one report per distinct crash an hour keep scripts spraying
// reports from many IPs from using it up (and hiding real errors).
const REPORTS_PER_HOUR = 60;

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
        const hour = Math.floor(Date.now() / 3_600_000);
        const fingerprint = sha256Hex(`${b.name}\n${b.message}\n${b.path.split('?')[0]}`).slice(
          0,
          32,
        );
        const fresh = await deps.valkey.set(`client-error:${fingerprint}`, '1', 'EX', 3600, 'NX');
        const count = fresh === 'OK' ? await deps.valkey.incr(`client-errors:${hour}`) : 0;
        if (count === 1) await deps.valkey.expire(`client-errors:${hour}`, 3600);
        // Logged above either way; only new crashes within the hourly budget reach Sentry.
        if (fresh !== 'OK' || count > REPORTS_PER_HOUR) return reply.code(204).send();
        reportError(err, {
          platform: 'javascript',
          tags: { source: 'web', kind: b.kind, path: b.path.split('?')[0] ?? b.path },
          extra: { digest: b.digest, user: req.auth?.login ?? null },
        });
        return reply.code(204).send();
      },
    );
  };
