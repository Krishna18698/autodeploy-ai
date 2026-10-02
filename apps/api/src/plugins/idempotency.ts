import { sha256Hex } from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';

// Stripe-style idempotency keys for unsafe requests. The first request with a
// key does the work and its response is stored; retries with the same key and
// body get the stored response back instead of doing the work twice.

const KEY_RE = /^[\w.:-]{8,128}$/;
const LOCK_MS = 60_000;

declare module 'fastify' {
  interface FastifyRequest {
    idempotency?: { scope: string; key: string };
  }
}

export const idempotencyPlugin = fp(async (app: FastifyInstance, o: { sql: Sql }) => {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.routeOptions.config.idempotent) return;
    const key = req.headers['idempotency-key'];
    if (key === undefined) return;
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      throw new AppError(
        400,
        'invalid_idempotency_key',
        'Idempotency-Key must be 8–128 characters of [A-Za-z0-9_.:-].',
      );
    }
    const auth = req.auth;
    if (!auth) return;
    const scope = `${auth.orgId}:${auth.tokenId ?? auth.userId}`;
    const requestHash = sha256Hex(
      `${req.method} ${req.routeOptions.url} ${JSON.stringify(req.params)} ${JSON.stringify(req.body ?? null)}`,
    );

    const inserted = await o.sql`
      insert into idempotency_keys (scope, key, request_hash, locked_until)
      values (${scope}, ${key}, ${requestHash}, now() + ${`${LOCK_MS} milliseconds`}::interval)
      on conflict do nothing returning key`;
    if (inserted.length === 1) {
      req.idempotency = { scope, key };
      return;
    }
    const [existing] = await o.sql<
      { request_hash: string; status_code: number | null; response: unknown; locked_until: Date }[]
    >`
      select request_hash, status_code, response, locked_until from idempotency_keys where scope = ${scope} and key = ${key}`;
    if (!existing) return;
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        422,
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request.',
      );
    }
    if (existing.status_code === null) {
      if (existing.locked_until > new Date()) {
        throw new AppError(
          409,
          'request_in_progress',
          'A request with this Idempotency-Key is still being processed.',
        );
      }
      // The first attempt died mid-flight: take over the key.
      await o.sql`update idempotency_keys set locked_until = now() + ${`${LOCK_MS} milliseconds`}::interval where scope = ${scope} and key = ${key}`;
      req.idempotency = { scope, key };
      return;
    }
    reply.header('Idempotent-Replayed', 'true');
    return reply.code(existing.status_code).send(existing.response);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = req.idempotency;
    if (!idem) return payload;
    if (reply.statusCode >= 500) {
      // Server errors are retryable: release the key instead of caching the failure.
      await o.sql`delete from idempotency_keys where scope = ${idem.scope} and key = ${idem.key}`;
      return payload;
    }
    let body: unknown = null;
    try {
      body = typeof payload === 'string' ? JSON.parse(payload) : null;
    } catch {}
    await o.sql`update idempotency_keys set status_code = ${reply.statusCode}, response = ${o.sql.json(body as never)}
      where scope = ${idem.scope} and key = ${idem.key}`;
    return payload;
  });
});
