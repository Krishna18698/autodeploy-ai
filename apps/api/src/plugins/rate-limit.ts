import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { Valkey } from 'iovalkey';
import { clientIp } from '../lib/client-ip.js';
import { AppError } from '../lib/errors.js';

// Sliding-window rate limiter in one Lua round trip. It approximates a true
// sliding log with two fixed windows: count = current + previous * overlap.
// O(1) memory per key, and accurate to within a few percent at boundaries.
const SCRIPT = `
local cur = KEYS[1]
local prev = KEYS[2]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local c = tonumber(redis.call('GET', cur) or '0')
local p = tonumber(redis.call('GET', prev) or '0')
local weighted = c + p * ((window - elapsed) / window)
if weighted >= limit then
  return {0, math.floor(weighted)}
end
c = redis.call('INCR', cur)
if c == 1 then redis.call('PEXPIRE', cur, window * 2) end
return {1, math.floor(c + p * ((window - elapsed) / window))}
`;

export type RateLimitConfig = { limit: number; windowMs: number; key?: 'ip' | 'principal' };

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimit?: RateLimitConfig | false;
    audit?: string;
    idempotent?: boolean;
    /** false: a cookie-authenticated write that needs no CSRF token (it only records). */
    csrf?: false;
    /**
     * The route checks its own credentials (GitHub Actions job tokens, ADR
     * 0010): sessions and API tokens are not read, so its Bearer header isn't
     * taken for an API token.
     */
    ownAuth?: true;
  }
}

export async function hit(
  valkey: Valkey,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  const bucket = Math.floor(now / windowMs);
  const elapsed = now - bucket * windowMs;
  const [allowed, count] = (await valkey.eval(
    SCRIPT,
    2,
    `rl:${key}:${bucket}`,
    `rl:${key}:${bucket - 1}`,
    limit,
    windowMs,
    elapsed,
  )) as [number, number];
  return { allowed: allowed === 1, count, resetMs: windowMs - elapsed };
}

export const rateLimitPlugin = fp(
  async (app: FastifyInstance, o: { valkey: Valkey; defaultPerMinute: number }) => {
    app.addHook('onRequest', async (req, reply) => {
      const cfg = req.routeOptions.config.rateLimit;
      if (cfg === false) return;
      const limit = cfg?.limit ?? o.defaultPerMinute;
      const windowMs = cfg?.windowMs ?? 60_000;
      const byPrincipal = (cfg?.key ?? 'principal') === 'principal' && req.auth;
      const who = byPrincipal
        ? `${req.auth?.via}:${req.auth?.tokenId ?? req.auth?.userId}`
        : `ip:${clientIp(req)}`;
      const route = req.routeOptions.url ?? 'unknown';
      let r: Awaited<ReturnType<typeof hit>>;
      try {
        r = await hit(o.valkey, `${route}:${who}`, limit, windowMs);
      } catch (err) {
        // Fail open: a cache outage must not take the API down with it.
        req.log.warn({ err }, 'rate limiter unavailable; allowing request');
        return;
      }
      reply.header('RateLimit-Limit', String(limit));
      reply.header('RateLimit-Remaining', String(Math.max(0, limit - r.count)));
      reply.header('RateLimit-Reset', String(Math.ceil(r.resetMs / 1000)));
      if (!r.allowed) {
        throw new AppError(
          429,
          'rate_limited',
          `Too many requests. Try again in ${Math.ceil(r.resetMs / 1000)}s.`,
          {
            headers: { 'Retry-After': String(Math.ceil(r.resetMs / 1000)) },
          },
        );
      }
    });
  },
);
