import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { sha256Hex } from '@autodeploy/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeDeployment, makeProject } from './helpers';

// The dashboard calls the API on its own host now. People signed in through
// the old host move over without signing in again, and the browser may make
// every kind of call it needs from the dashboard's address (and nobody else's).

const APP = 'https://app.autodeploy.test';
let app: FastifyInstance;
let deps: Deps;

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_DOMAIN: 'autodeploy.test',
    APP_URL: APP,
    API_PUBLIC_URL: 'https://api.autodeploy.test',
    DATABASE_URL: inject('databaseUrl'),
    VALKEY_URL: inject('valkeyUrl'),
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
    INTERNAL_TOKEN: 'internal-token-for-tests-123456',
    DEV_LOGIN: 'true',
    RATE_LIMIT_PER_MINUTE: '10000',
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  app = await buildApp(deps);
});
afterAll(async () => {
  await app.close();
  await deps.close();
});

let signIns = 0;
async function signIn(login: string) {
  signIns += 1;
  const r = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { login },
    remoteAddress: `198.51.100.${100 + signIns}`,
  });
  expect(r.statusCode).toBe(200);
  return String(r.headers['set-cookie']).split(';')[0] ?? '';
}
const cookieOf = (setCookie: unknown) =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ?? '';

describe('Moving a session to the API host', () => {
  it('hands the same session over once, signing nobody out', async () => {
    const login = `move-${randomUUID().slice(0, 8)}`;
    const old = await signIn(login);

    const handoff = await app.inject({
      method: 'POST',
      url: '/auth/session/handoff',
      headers: { cookie: old, origin: APP },
    });
    expect(handoff.statusCode).toBe(200);
    const { code } = handoff.json();
    // The old host's cookie is deleted with the same attributes it was set with.
    expect(String(handoff.headers['set-cookie'])).toMatch(/ad_session=;.*HttpOnly/);

    const claim = await app.inject({
      method: 'POST',
      url: '/auth/session/claim',
      headers: { origin: APP },
      payload: { code },
    });
    expect(claim.statusCode).toBe(204);
    const moved = cookieOf(claim.headers['set-cookie']);
    expect(moved).toBe(old); // the very same session
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: moved } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.login).toBe(login);

    // A pass works once.
    const again = await app.inject({
      method: 'POST',
      url: '/auth/session/claim',
      headers: { origin: APP },
      payload: { code },
    });
    expect(again.statusCode).toBe(401);
  });

  it('only the dashboard can ask, and a signed-out cookie gets nothing', async () => {
    const old = await signIn(`move-${randomUUID().slice(0, 8)}`);
    for (const origin of [undefined, 'https://evil.example', 'https://api.autodeploy.test']) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/session/handoff',
        headers: { cookie: old, ...(origin && { origin }) },
      });
      expect(r.statusCode).toBe(403);
    }
    const stolen = await app.inject({
      method: 'POST',
      url: '/auth/session/claim',
      headers: { origin: 'https://evil.example' },
      payload: { code: 'x'.repeat(43) },
    });
    expect(stolen.statusCode).toBe(403);

    // Signed out (or expired) since: the old cookie is worth nothing.
    await deps.sql`delete from sessions where token_hash = ${sha256Hex(old.slice(old.indexOf('=') + 1))}`;
    const dead = await app.inject({
      method: 'POST',
      url: '/auth/session/handoff',
      headers: { cookie: old, origin: APP },
    });
    expect(dead.statusCode).toBe(401);
    const none = await app.inject({
      method: 'POST',
      url: '/auth/session/handoff',
      headers: { origin: APP },
    });
    expect(none.statusCode).toBe(401);
  });

  it('a session still waiting for its two-step code moves too', async () => {
    const login = `move-${randomUUID().slice(0, 8)}`;
    const old = await signIn(login);
    await deps.sql`update sessions set mfa_pending = true
      where user_id = (select id from users where login = ${login})`;
    const { code } = (
      await app.inject({
        method: 'POST',
        url: '/auth/session/handoff',
        headers: { cookie: old, origin: APP },
      })
    ).json();
    const claim = await app.inject({
      method: 'POST',
      url: '/auth/session/claim',
      headers: { origin: APP },
      payload: { code },
    });
    expect(claim.statusCode).toBe(204);
    // Still waiting for the code: moving it is not a way around the second step.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieOf(claim.headers['set-cookie']) },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe('Calls from the dashboard host', () => {
  it('allows every method the dashboard uses, from its address only', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const r = await app.inject({
        method: 'OPTIONS',
        url: '/api/v1/me',
        headers: {
          origin: APP,
          'access-control-request-method': method,
          'access-control-request-headers': 'content-type,x-csrf-token',
        },
      });
      expect(r.statusCode).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(APP);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
      expect(String(r.headers['access-control-allow-methods'])).toContain(method);
      expect(r.headers['access-control-max-age']).toBe('7200');
    }
    const other = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'DELETE' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('live logs carry the same permission (the stream writes its own headers)', async () => {
    const login = `move-${randomUUID().slice(0, 8)}`;
    const cookie = await signIn(login);
    const [m] = await deps.sql<{ org_id: string }[]>`
      select org_id from memberships where user_id = (select id from users where login = ${login})`;
    const p = await makeProject(deps.sql, m?.org_id ?? '');
    const id = await makeDeployment(deps.sql, m?.org_id ?? '', p.id, 'BUILDING');
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const stop = new AbortController();
    try {
      const r = await fetch(`${url}/api/v1/deployments/${id}/stream`, {
        headers: { cookie, origin: APP },
        signal: stop.signal,
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');
      expect(r.headers.get('access-control-allow-origin')).toBe(APP);
      expect(r.headers.get('access-control-allow-credentials')).toBe('true');
    } finally {
      stop.abort();
    }
  });

  it('health checks answer the dashboard, so it can tell when the API is back', async () => {
    const r = await app.inject({ method: 'GET', url: '/readyz', headers: { origin: APP } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(APP);
  });
});
