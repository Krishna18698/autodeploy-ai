import { randomToken, sha256Hex } from '@autodeploy/crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { sessionCookie } from '../plugins/auth.js';
import { clearSessionCookie, setSessionCookie } from './auth.js';

// Moving signed-in browsers to the API's host without signing anyone out
// (2026-10-23). The dashboard used to reach the API through app.<domain>, so
// sessions sit in a cookie for that host; it now calls api.<domain> directly.
// On its first 401 there it asks the old host for a one-time pass (60 s,
// single use) and hands it to the API, which puts the same session, two-step
// state and all, in a cookie of its own.
//
// Remove after 2026-11-10: by then every cookie on the old host has gone
// 14 days without a visit, so its session has expired anyway.

const PASS_TTL_S = 60;
const passKey = (code: string) => `session-move:${sha256Hex(code)}`;

export const sessionMoveRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // Only the dashboard's own pages can ask (a browser always sends Origin on a POST).
    const fromDashboard = (origin: string | undefined) => {
      if (origin !== deps.env.APP_URL) throw forbidden('Cross-origin request rejected');
    };

    // On the old host: the cookie it holds becomes a pass.
    app.post(
      '/auth/session/handoff',
      {
        config: { csrf: false, rateLimit: { limit: 30, windowMs: 60_000 } },
        schema: { hide: true, response: { 200: z.object({ code: z.string() }) } },
      },
      async (req, reply) => {
        fromDashboard(req.headers.origin);
        const raw = req.cookies[sessionCookie(deps.env)];
        // The old cookie goes either way: it's moving, or it's no use any more.
        clearSessionCookie(deps, reply);
        if (!raw) throw unauthorized('Sign in first');
        const [live] = await deps.sql`
          select 1 from sessions where token_hash = ${sha256Hex(raw)} and expires_at > now()`;
        if (!live) throw unauthorized('Sign in first');
        const code = randomToken(32);
        await deps.valkey.set(passKey(code), raw, 'EX', PASS_TTL_S);
        return { code };
      },
    );

    // On the API's host: the pass becomes the same session's cookie here.
    app.post(
      '/auth/session/claim',
      {
        config: { csrf: false, rateLimit: { limit: 20, windowMs: 60_000, key: 'ip' } },
        schema: {
          hide: true,
          body: z.object({ code: z.string().min(20).max(100) }),
          response: { 204: z.null() },
        },
      },
      async (req, reply) => {
        fromDashboard(req.headers.origin);
        const raw = await deps.valkey.getdel(passKey(req.body.code));
        if (!raw) throw unauthorized('Sign in again');
        const [live] = await deps.sql`
          select 1 from sessions where token_hash = ${sha256Hex(raw)} and expires_at > now()`;
        if (!live) throw unauthorized('Sign in again');
        setSessionCookie(deps, reply, raw);
        return reply.code(204).send(null);
      },
    );
  };
