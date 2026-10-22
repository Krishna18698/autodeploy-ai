import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { base32Decode, totpAt, totpStep } from '@autodeploy/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

let app: FastifyInstance;
let deps: Deps;

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_DOMAIN: 'autodeploy.test',
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

type Session = { cookie: string; csrf: string; twoFactor: boolean };
let signIns = 0;
async function signIn(login: string): Promise<Session> {
  signIns = (signIns % 250) + 1;
  // Each sign-in from its own test address: sign-in is rate-limited per address,
  // and the suites before this one have used up 127.0.0.1's minute.
  const r = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { login },
    remoteAddress: `198.51.100.${signIns}`,
  });
  expect(r.statusCode).toBe(200);
  return {
    cookie: String(r.headers['set-cookie']).split(';')[0] ?? '',
    csrf: r.json().csrfToken,
    twoFactor: r.json().twoFactor,
  };
}
const as = (s: Session) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
const call = (s: Session, method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'POST',
    url,
    headers: as(s),
    ...(payload && { payload }),
  });
/** The code an authenticator app would show for `secret`, `ahead` steps from now. */
const codeFor = (secret: string, ahead = 0) => totpAt(base32Decode(secret), totpStep() + ahead);

describe('Two-step sign-in with an authenticator app', () => {
  it('sets up, then every sign-in waits for a code; a used code never works twice', async () => {
    const login = `mfa-${randomUUID().slice(0, 8)}`;
    const s = await signIn(login);
    expect(s.twoFactor).toBe(false);

    const setup = await call(s, 'POST', '/api/v1/me/2fa/setup');
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl, qrSvg } = setup.json();
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(qrSvg).toMatch(/^data:image\/svg\+xml;base64,/);

    expect((await call(s, 'POST', '/api/v1/me/2fa/enable', { code: '000000' })).json().code).toBe(
      'invalid_code',
    );
    const on = await call(s, 'POST', '/api/v1/me/2fa/enable', { code: codeFor(secret) });
    expect(on.statusCode).toBe(200);
    const codes: string[] = on.json().recoveryCodes;
    expect(codes).toHaveLength(10);
    expect((await call(s, 'GET', '/api/v1/me/2fa')).json()).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });

    // A new sign-in can do nothing until the code arrives.
    const next = await signIn(login);
    expect(next.twoFactor).toBe(true);
    expect((await call(next, 'GET', '/api/v1/me')).statusCode).toBe(401);
    // The code just used to switch it on (same time step) is refused; the next one works.
    expect(
      (await call(next, 'POST', '/auth/2fa/verify', { code: codeFor(secret) })).statusCode,
    ).toBe(400);
    const ok = await call(next, 'POST', '/auth/2fa/verify', { code: codeFor(secret, 1) });
    expect(ok.statusCode).toBe(200);
    expect((await call(next, 'GET', '/api/v1/me')).statusCode).toBe(200);

    // A recovery code also signs in, once.
    const third = await signIn(login);
    expect(
      (await call(third, 'POST', '/auth/2fa/verify', { code: codes[0]?.toUpperCase() ?? '' }))
        .statusCode,
    ).toBe(200);
    const fourth = await signIn(login);
    expect(
      (await call(fourth, 'POST', '/auth/2fa/verify', { code: codes[0] ?? '' })).statusCode,
    ).toBe(400);
  });

  it('asks again before dangerous actions once 10 minutes have passed', async () => {
    const login = `mfa-${randomUUID().slice(0, 8)}`;
    const s = await signIn(login);
    const { secret } = (await call(s, 'POST', '/api/v1/me/2fa/setup')).json();
    const codes: string[] = (
      await call(s, 'POST', '/api/v1/me/2fa/enable', { code: codeFor(secret) })
    ).json().recoveryCodes;

    // Just showed a code: new credentials are fine.
    const token = { name: 't', scopes: ['read'] };
    expect((await call(s, 'POST', '/api/v1/tokens', token)).statusCode).toBe(201);
    // Eleven minutes later they aren't, until a code is shown again.
    await deps.sql`update sessions set mfa_verified_at = now() - interval '11 minutes'
      where user_id = (select id from users where login = ${login})`;
    const asked = await call(s, 'POST', '/api/v1/tokens', token);
    expect(asked.statusCode).toBe(403);
    expect(asked.json().code).toBe('mfa_required');
    expect((await call(s, 'DELETE', '/api/v1/me', { confirm: login })).json().code).toBe(
      'mfa_required',
    );
    expect(
      (await call(s, 'POST', '/api/v1/me/2fa/verify', { code: codes[1] ?? '' })).statusCode,
    ).toBe(204);
    expect((await call(s, 'POST', '/api/v1/tokens', token)).statusCode).toBe(201);
    // Reading and ordinary work never ask.
    expect((await call(s, 'GET', '/api/v1/projects')).statusCode).toBe(200);
  });

  it('pauses codes after ten wrong ones, and turning it off needs a code', async () => {
    const login = `mfa-${randomUUID().slice(0, 8)}`;
    const s = await signIn(login);
    const { secret } = (await call(s, 'POST', '/api/v1/me/2fa/setup')).json();
    const codes: string[] = (
      await call(s, 'POST', '/api/v1/me/2fa/enable', { code: codeFor(secret) })
    ).json().recoveryCodes;
    const [u] = await deps.sql<{ id: string }[]>`select id from users where login = ${login}`;

    await deps.valkey.set(`mfa-fails:${u?.id}`, '10', 'EX', 900);
    const paused = await call(s, 'POST', '/api/v1/me/2fa/verify', { code: codes[2] ?? '' });
    expect(paused.statusCode).toBe(429);
    expect(paused.json().code).toBe('too_many_codes');
    await deps.valkey.del(`mfa-fails:${u?.id}`);

    expect((await call(s, 'DELETE', '/api/v1/me/2fa', { code: '123456' })).statusCode).toBe(400);
    expect((await call(s, 'DELETE', '/api/v1/me/2fa', { code: codes[2] ?? '' })).statusCode).toBe(
      204,
    );
    expect((await signIn(login)).twoFactor).toBe(false);
  });
});
