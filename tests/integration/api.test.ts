import { createHmac, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { upsertUserWithOrg } from '@autodeploy/api/routes/auth';
import { sha256Hex } from '@autodeploy/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeDeployment, makeOrg, makeProject } from './helpers';

const WEBHOOK_SECRET = 'whsec-test-secret';
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
    ALLOW_LOCAL_SOURCES: 'true',
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
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

type Session = { cookie: string; csrf: string };

async function login(login: string): Promise<Session> {
  const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { login } });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
  return { cookie, csrf: r.json().csrfToken };
}

/** Puts an existing user into another org with a role, and makes that the session's org. */
async function joinAs(
  s: Session,
  orgId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  login: string,
) {
  const [u] = await deps.sql<{ id: string }[]>`select id from users where login = ${login}`;
  await deps.sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role}) on conflict (org_id, user_id) do update set role = excluded.role`;
  const r = await app.inject({
    method: 'POST',
    url: '/api/v1/session/org',
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    payload: { orgId },
  });
  expect(r.statusCode).toBe(204);
}

describe('API security', () => {
  it('requires a session or token, and rejects cookie writes without CSRF or from foreign origins', async () => {
    expect((await app.inject({ url: '/api/v1/projects' })).statusCode).toBe(401);
    const s = await login('csrf-user');
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).statusCode,
    ).toBe(200);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie: s.cookie },
      payload: { name: 't', scopes: ['read'] },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.headers['content-type']).toContain('application/problem+json');
    const evil = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'https://evil.example' },
      payload: { name: 't', scopes: ['read'] },
    });
    expect(evil.statusCode).toBe(403);
  });

  it('enforces roles per endpoint (authorization matrix)', async () => {
    const org = await makeOrg(deps.sql);
    const project = await makeProject(deps.sql, org);
    const matrix: Array<{
      method: 'GET' | 'POST' | 'PUT' | 'PATCH';
      url: string;
      payload?: object;
      min: 'viewer' | 'member' | 'admin';
    }> = [
      { method: 'GET', url: '/api/v1/projects', min: 'viewer' },
      { method: 'GET', url: `/api/v1/projects/${project.id}`, min: 'viewer' },
      { method: 'GET', url: '/api/v1/deployments', min: 'viewer' },
      { method: 'GET', url: `/api/v1/projects/${project.id}/env`, min: 'member' },
      {
        method: 'PUT',
        url: `/api/v1/projects/${project.id}/env/SECRET_KEY`,
        payload: { value: 'v' },
        min: 'admin',
      },
      {
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        payload: { name: 'renamed' },
        min: 'admin',
      },
      { method: 'GET', url: '/api/v1/webhooks', min: 'admin' },
      { method: 'GET', url: '/api/v1/audit', min: 'admin' },
    ];
    const rank = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
    for (const role of ['viewer', 'member', 'admin'] as const) {
      const name = `matrix-${role}-${org.slice(0, 6)}`;
      const s = await login(name);
      await joinAs(s, org, role, name);
      for (const e of matrix) {
        const r = await app.inject({
          method: e.method,
          url: e.url,
          headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
          ...(e.payload && { payload: e.payload }),
        });
        const allowed = rank[role] >= rank[e.min];
        expect(
          allowed ? r.statusCode < 400 : r.statusCode === 403,
          `${role} ${e.method} ${e.url} → ${r.statusCode}`,
        ).toBe(true);
      }
    }
  });

  it('never exposes another org’s resources (404, not 403)', async () => {
    const victim = await makeOrg(deps.sql);
    const p = await makeProject(deps.sql, victim);
    const d = await makeDeployment(deps.sql, victim, p.id);
    const s = await login('intruder');
    for (const url of [
      `/api/v1/projects/${p.id}`,
      `/api/v1/deployments/${d}`,
      `/api/v1/deployments/${d}/events`,
      `/api/v1/deployments/${d}/repairs`,
    ]) {
      const r = await app.inject({ url, headers: { cookie: s.cookie } });
      expect(
        [404, 200].includes(r.statusCode) &&
          (r.statusCode === 404 || (Array.isArray(r.json()) && r.json().length === 0)),
        `${url} → ${r.statusCode}`,
      ).toBe(true);
    }
    const list = await app.inject({ url: '/api/v1/projects', headers: { cookie: s.cookie } });
    expect(list.json().items.some((x: { id: string }) => x.id === p.id)).toBe(false);
  });

  it('scopes API tokens: read tokens cannot deploy; revoked tokens stop working', async () => {
    const s = await login('token-user');
    const mk = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { name: 'ro', scopes: ['read'] },
    });
    expect(mk.statusCode).toBe(201);
    const { token, id } = mk.json();
    const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ url: '/api/v1/projects', headers: auth })).statusCode).toBe(200);
    const me = await app.inject({ url: '/api/v1/me', headers: auth });
    const org = me.json().org.id;
    const p = await makeProject(deps.sql, org, {
      repoUrl: `file://${resolve('tests/fixtures/vite-ok')}`,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${p.id}/deployments`,
          headers: auth,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/tokens/${id}`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    });
    expect((await app.inject({ url: '/api/v1/projects', headers: auth })).statusCode).toBe(401);
  });

  it('replays idempotent requests and rejects key reuse with a different body', async () => {
    const s = await login('idem-user');
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf, 'idempotency-key': 'idem-key-0001' };
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
    const p = await makeProject(deps.sql, me.json().org.id, {
      repoUrl: `file://${resolve('tests/fixtures/vite-ok')}`,
    });
    const a = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/deployments`,
      headers: h,
      payload: {},
    });
    const b = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/deployments`,
      headers: h,
      payload: {},
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const [n] = await deps.sql<
      { n: number }[]
    >`select count(*)::int as n from deployments where project_id = ${p.id}`;
    expect(n?.n).toBe(1);
    const c = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/deployments`,
      headers: h,
      payload: { kind: 'preview' },
    });
    expect(c.statusCode).toBe(422);
  });

  it('enforces the daily deploy quota', async () => {
    const s = await login('quota-user');
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } });
    await deps.sql`update orgs set daily_deploy_quota = 1 where id = ${me.json().org.id}`;
    const p = await makeProject(deps.sql, me.json().org.id, {
      repoUrl: `file://${resolve('tests/fixtures/vite-ok')}`,
    });
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${p.id}/deployments`,
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(201);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${p.id}/deployments`,
      headers: h,
      payload: {},
    });
    expect(r.statusCode).toBe(429);
    expect(r.json().code).toBe('quota_exceeded');
  });

  it('rate-limits auth endpoints per IP with Retry-After', async () => {
    let last = 0;
    let retryAfter: string | undefined;
    for (let i = 0; i < 25; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/auth/dev-login',
        payload: { login: 'rl' },
        remoteAddress: '203.0.113.9',
      });
      last = r.statusCode;
      retryAfter = r.headers['retry-after'] as string | undefined;
      if (last === 429) break;
    }
    expect(last).toBe(429);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe('GitHub webhooks', () => {
  const sign = (body: string) =>
    `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;

  it('rejects bad signatures and processes each delivery exactly once (100 redeliveries → 1 deployment)', async () => {
    const org = await makeOrg(deps.sql);
    const p = await makeProject(deps.sql, org, { repo: 'acme/webhook-target' });
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      head_commit: { message: 'fix: x' },
      repository: { full_name: 'acme/webhook-target', default_branch: 'main' },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=00',
        'x-github-delivery': 'd-bad',
        'x-github-event': 'push',
      },
      payload: body,
    });
    expect(bad.statusCode).toBe(403);
    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(body),
      'x-github-delivery': `delivery-${p.id}`,
      'x-github-event': 'push',
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        app.inject({ method: 'POST', url: '/api/v1/webhooks/github', headers, payload: body }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 200 && r.json().duplicate)).toHaveLength(99);
    const [n] = await deps.sql<
      { n: number }[]
    >`select count(*)::int as n from deployments where project_id = ${p.id}`;
    expect(n?.n).toBe(1);
    console.info('[measure] 100 concurrent redeliveries of one webhook → 1 deployment');
  });

  it('ignores pushes to non-default branches', async () => {
    const org = await makeOrg(deps.sql);
    const p = await makeProject(deps.sql, org, { repo: 'acme/branchy' });
    const body = JSON.stringify({
      ref: 'refs/heads/feature',
      after: 'b'.repeat(40),
      repository: { full_name: 'acme/branchy', default_branch: 'main' },
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body),
        'x-github-delivery': `d-${p.id}`,
        'x-github-event': 'push',
      },
      payload: body,
    });
    expect(r.json().deployments).toBe(0);
  });
});

describe('API contract', () => {
  it('publishes an OpenAPI document where every public route declares a response schema', async () => {
    const r = await app.inject({ url: '/openapi.json' });
    expect(r.statusCode).toBe(200);
    const doc = r.json() as {
      openapi: string;
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
    };
    expect(doc.openapi).toMatch(/^3\./);
    const ops = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([m, op]) => ({ path, m, op })),
    );
    expect(ops.length).toBeGreaterThan(30);
    const missing = ops
      .filter(({ op }) => !op.responses || Object.keys(op.responses).length === 0)
      .map(({ m, path }) => `${m} ${path}`);
    // Routes that return 204 / stream have no body schema by design.
    const allowed =
      /(DELETE|delete)|\/session\/org|\/members|\/logout|\/env\/|\/stream|\/screenshot/;
    expect(missing.filter((x) => !allowed.test(x))).toEqual([]);
  });
});

describe('Deleting an account', () => {
  it('needs a session and the login typed back, refuses while others share an owned org, then removes everything', async () => {
    const s = await login('del-owner');
    const [me] = await deps.sql<{ id: string; org_id: string }[]>`
      select u.id, m.org_id from users u join memberships m on m.user_id = u.id where u.login = 'del-owner'`;
    const p = await makeProject(deps.sql, me!.org_id);
    await makeDeployment(deps.sql, me!.org_id, p.id, 'CREATED', 1);
    const del = (headers: Record<string, string>, confirm: string) =>
      app.inject({ method: 'DELETE', url: '/api/v1/me', headers, payload: { confirm } });
    const cookie = { cookie: s.cookie, 'x-csrf-token': s.csrf };

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: cookie,
      payload: { name: 't', scopes: ['admin'] },
    });
    const token = tokenRes.json().token as string;
    expect((await del({ authorization: `Bearer ${token}` }, 'del-owner')).statusCode).toBe(403);
    expect((await del(cookie, 'someone-else')).statusCode).toBe(400);

    await login('del-member');
    const [other] = await deps.sql<
      { id: string }[]
    >`select id from users where login = 'del-member'`;
    await deps.sql`insert into memberships (org_id, user_id, role) values (${me!.org_id}, ${other!.id}, 'member')`;
    expect((await del(cookie, 'del-owner')).statusCode).toBe(409);
    await deps.sql`delete from memberships where org_id = ${me!.org_id} and user_id = ${other!.id}`;

    expect((await del(cookie, 'DEL-OWNER')).statusCode).toBe(204);
    expect(await deps.sql`select 1 from users where id = ${me!.id}`).toHaveLength(0);
    expect(await deps.sql`select 1 from orgs where id = ${me!.org_id}`).toHaveLength(0);
    expect(await deps.sql`select 1 from projects where id = ${p.id}`).toHaveLength(0);
    // The site comes off the edge even though its org is gone.
    const jobs = await deps.sql<{ org_id: string | null }[]>`
      select org_id from jobs where type = 'routes.remove' and payload->>'key' like ${`%${p.slug}%`}`;
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((j) => j.org_id === null)).toBe(true);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: s.cookie } })).statusCode,
    ).toBe(401);
  });
});

describe('Per-account limits', () => {
  const env = {
    MAX_PROJECTS_PER_ORG: 2,
    SSR_PROJECTS_PER_ORG: 1,
    BUILD_MINUTES_PER_MONTH: 5,
    STORAGE_MB_PER_ORG: 1,
  };

  it('counts usage and refuses new projects and deployments past each limit', async () => {
    const { usageFor, enforceDeployLimits, enforceProjectLimit } = await import(
      '../../apps/api/src/services/limits'
    );
    const sql = deps.sql;
    // Projects, and this month's build minutes.
    const org = await makeOrg(sql);
    const p = await makeProject(sql, org);
    const d = await makeDeployment(sql, org, p.id, 'CREATED', 1);
    expect(await usageFor(sql, org, env)).toMatchObject({
      projects: 1,
      deploysToday: 1,
      deploysPerDay: 20,
    });
    await makeProject(sql, org);
    await expect(sql.begin((tx) => enforceProjectLimit(tx, org, env))).rejects.toMatchObject({
      code: 'project_limit',
    });
    await sql`insert into deployment_attempts (deployment_id, org_id, attempt_no, executor, build_config, duration_ms)
      values (${d}, ${org}, 1, 'sandbox', '{}', 360000)`;
    expect((await usageFor(sql, org, env)).buildMinutesThisMonth).toBe(6);
    await expect(sql.begin((tx) => enforceDeployLimits(tx, org, env))).rejects.toMatchObject({
      code: 'build_minutes_exceeded',
    });

    // Storage: the org's artifacts count against it.
    const org2 = await makeOrg(sql);
    const p2 = await makeProject(sql, org2);
    const d2 = await makeDeployment(sql, org2, p2.id, 'CREATED', 1);
    const [a] = await sql<{ id: string }[]>`
      insert into artifacts (sha256, storage_prefix, file_count, bytes)
      values (${`limits-${d2}`}, 'x', 1, ${2 * 1024 * 1024}) returning id`;
    await sql`update deployments set artifact_id = ${a!.id} where id = ${d2}`;
    await expect(sql.begin((tx) => enforceDeployLimits(tx, org2, env))).rejects.toMatchObject({
      code: 'storage_exceeded',
    });
  });
});

describe('Email sign-in', () => {
  const mails: { to: string; subject: string; text: string }[] = [];
  const realSend = () => deps.sendEmail;
  let restore: Deps['sendEmail'];
  beforeAll(() => {
    restore = realSend();
    deps.sendEmail = async (m) => {
      mails.push(m);
    };
  });
  afterAll(() => {
    deps.sendEmail = restore;
  });
  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });
  const linkToken = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';
  const lastMailTo = (to: string) => mails.filter((m) => m.to === to).at(-1);
  // One account email per address a minute: tests that send twice reset it.
  const unthrottle = (email: string) => deps.valkey.del(`account-mail:${sha256Hex(email)}`);
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers['set-cookie']).split(';')[0] ?? '';

  it('signs up, confirms the address from the emailed link, then signs in', async () => {
    const email = `new-${randomBytes(3).toString('hex')}@example.com`;
    const password = 'correct horse battery';
    expect(
      (await post('/auth/email/signup', { email: email.toUpperCase(), password })).statusCode,
    ).toBe(202);
    const verify = lastMailTo(email);
    expect(verify?.subject).toBe('Confirm your email for AutoDeploy');

    // Not confirmed yet: no session, and no second email within the minute.
    const early = await post('/auth/email/login', { email, password });
    expect(early.statusCode).toBe(403);
    expect(early.json().code).toBe('email_unverified');

    const ok = await post('/auth/email/verify', { token: linkToken(verify!.text) });
    expect(ok.statusCode).toBe(200);
    const me = await app.inject({ url: '/api/v1/me', headers: { cookie: cookieOf(ok) } });
    expect(me.statusCode).toBe(200);
    // Never a valid GitHub login, so never matched to someone's GitHub App installation.
    expect(me.json().user.login).toMatch(/^new-[0-9a-f]{6}_[0-9a-f]{6}$/);
    expect(me.json().user.email).toBe(email);

    expect((await post('/auth/email/verify', { token: linkToken(verify!.text) })).statusCode).toBe(
      400,
    );
    expect(
      (await post('/auth/email/login', { email, password: 'wrong password!' })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/email/login', { email: 'nobody@example.com', password })).statusCode,
    ).toBe(401);
    expect((await post('/auth/email/login', { email, password })).statusCode).toBe(200);

    // Signing up again says the same thing, and only tells the owner.
    await unthrottle(email);
    expect(
      (await post('/auth/email/signup', { email, password: 'another password' })).statusCode,
    ).toBe(202);
    expect(lastMailTo(email)?.subject).toBe('You already have an AutoDeploy account');
    expect(await deps.sql`select 1 from user_passwords where email = ${email}`).toHaveLength(1);
  });

  it('resets a forgotten password once, signing out every other session', async () => {
    const email = `reset-${randomBytes(3).toString('hex')}@example.com`;
    await post('/auth/email/signup', { email, password: 'first password 1' });
    const signedIn = await post('/auth/email/verify', {
      token: linkToken(lastMailTo(email)!.text),
    });
    const oldCookie = cookieOf(signedIn);

    const before = mails.length;
    expect((await post('/auth/email/forgot', { email: 'nobody@example.com' })).statusCode).toBe(
      202,
    );
    expect(mails.length).toBe(before);

    await unthrottle(email);
    expect((await post('/auth/email/forgot', { email })).statusCode).toBe(202);
    const reset = lastMailTo(email)!;
    expect(reset.subject).toBe('Reset your AutoDeploy password');
    // A second request within the minute sends nothing and keeps the first link valid.
    await post('/auth/email/forgot', { email });
    expect(lastMailTo(email)).toBe(reset);

    const token = linkToken(reset.text);
    expect((await post('/auth/email/reset', { token, password: 'short' })).statusCode).toBe(400);
    const done = await post('/auth/email/reset', { token, password: 'second password 2' });
    expect(done.statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: oldCookie } })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: '/api/v1/me', headers: { cookie: cookieOf(done) } })).statusCode,
    ).toBe(200);
    expect(
      (await post('/auth/email/reset', { token, password: 'third password 3' })).statusCode,
    ).toBe(400);
    expect(
      (await post('/auth/email/login', { email, password: 'first password 1' })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/email/login', { email, password: 'second password 2' })).statusCode,
    ).toBe(200);
  });

  it('refuses sign-ups while they are closed, and requests from other sites', async () => {
    const email = `closed-${randomBytes(3).toString('hex')}@example.com`;
    const allow = deps.env.ALLOWED_GITHUB_LOGINS;
    deps.env.ALLOWED_GITHUB_LOGINS = ['someone'];
    try {
      const r = await post('/auth/email/signup', { email, password: 'long enough pw' });
      expect(r.statusCode).toBe(403);
      expect(r.json().detail ?? r.json().message).toContain('not open yet');
    } finally {
      deps.env.ALLOWED_GITHUB_LOGINS = allow;
    }
    const foreign = await post(
      '/auth/email/login',
      { email, password: 'long enough pw' },
      { origin: 'https://evil.example' },
    );
    expect(foreign.statusCode).toBe(403);
  });

  it('matches GitHub users by id: a reused login never inherits the old account', async () => {
    const name = `gh-${randomBytes(3).toString('hex')}`;
    const alice = await upsertUserWithOrg(deps.sql, {
      githubId: 900_000_001,
      login: name,
      name: 'Alice',
      email: null,
      avatarUrl: null,
    });
    // Alice renamed on GitHub; Bob took her old name.
    const bob = await upsertUserWithOrg(deps.sql, {
      githubId: 900_000_002,
      login: name,
      name: 'Bob',
      email: null,
      avatarUrl: null,
    });
    expect(bob.userId).not.toBe(alice.userId);
    expect(bob.orgId).not.toBe(alice.orgId);
    const again = await upsertUserWithOrg(deps.sql, {
      githubId: 900_000_001,
      login: `${name}-renamed`,
      name: 'Alice',
      email: null,
      avatarUrl: null,
    });
    expect(again).toEqual(alice);
    const [row] = await deps.sql<
      { login: string }[]
    >`select login from users where id = ${alice.userId}`;
    expect(row?.login).toBe(`${name}-renamed`);
  });
});
