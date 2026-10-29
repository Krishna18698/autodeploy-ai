import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { type Env, loadEnv } from '@autodeploy/api/env';
import { ensureDemoOrg } from '@autodeploy/api/services/portfolio';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

// Portfolio mode (migration 0020): anyone signs in and looks around the demo
// org, read-only; their own account deploys once a platform admin approves it.

const ADMIN_GITHUB_ID = 5151515;
let app: FastifyInstance;
let deps: Deps;
let env: Env;
let demoId: string;
const sent: { to: string; subject: string; text: string }[] = [];

type Session = { cookie: string; csrf: string; login: string };
let signIns = 0;
async function login(name: string, githubId: number | null = null): Promise<Session> {
  signIns = (signIns % 250) + 1;
  const r = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { login: name },
    remoteAddress: `198.51.100.${signIns}`,
  });
  expect(r.statusCode).toBe(200);
  if (githubId !== null) {
    // An earlier run's admin gives the GitHub id up (they're unique).
    await deps.sql`update users set github_id = null where github_id = ${githubId}`;
    await deps.sql`update users set github_id = ${githubId} where login = ${name}`;
  }
  return {
    cookie: String(r.headers['set-cookie']).split(';')[0] ?? '',
    csrf: r.json().csrfToken,
    login: name,
  };
}
const as = (s: Session) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
const me = async (s: Session) =>
  (await app.inject({ method: 'GET', url: '/api/v1/me', headers: as(s) })).json();
const visitor = async () => {
  const name = `visitor-${randomUUID().slice(0, 6)}`;
  const s = await login(name);
  await deps.sql`update users set email = ${`${name}@example.test`} where login = ${name}`;
  return s;
};

let admin: Session;
beforeAll(async () => {
  env = loadEnv({
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
    RATE_LIMIT_PER_MINUTE: '10000',
    PLATFORM_ADMIN_GITHUB_IDS: String(ADMIN_GITHUB_ID),
    DEPLOY_APPROVAL: 'approval',
    DEMO_ORG_NAME: 'AutoDeploy demo',
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  deps.sendEmail = async (m) => {
    sent.push(m);
  };
  app = await buildApp(deps);
  admin = await login(`admin-${randomUUID().slice(0, 6)}`, ADMIN_GITHUB_ID);
  await deps.sql`update users set email = 'admin@example.test' where github_id = ${ADMIN_GITHUB_ID}`;
  // What the API does when it starts.
  demoId = (await ensureDemoOrg(deps.sql, env)) ?? '';
});
afterAll(async () => {
  // The other suites run without a demo org.
  await deps.sql`delete from orgs where is_demo`;
  await app.close();
  await deps.close();
});

describe('portfolio mode', () => {
  it('creates the demo org once, owned by the platform admins, and is the same on every start', async () => {
    expect(demoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await ensureDemoOrg(deps.sql, env)).toBe(demoId);
    const [m] = await deps.sql<{ role: string }[]>`
      select m.role from memberships m join users u on u.id = m.user_id
      where m.org_id = ${demoId} and u.github_id = ${ADMIN_GITHUB_ID}`;
    expect(m?.role).toBe('owner');
  });

  it('anyone signs in and opens in the demo, read-only; their own account is there, not yet deploying', async () => {
    const v = await visitor();
    const m = await me(v);
    expect(m.org).toMatchObject({ id: demoId, demo: true, role: 'viewer', canDeploy: false });
    const own = m.orgs.find((o: { demo: boolean }) => !o.demo);
    expect(own).toMatchObject({ role: 'owner', canDeploy: false, accessRequestedAt: null });
    // Nothing in the demo can be changed by a visitor.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(v),
      payload: { repoUrl: 'https://github.com/someone/site' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('their own account cannot create a project until approved', async () => {
    const v = await visitor();
    const own = (await me(v)).orgs.find((o: { demo: boolean }) => !o.demo);
    const sw = await app.inject({
      method: 'POST',
      url: '/api/v1/session/org',
      headers: as(v),
      payload: { orgId: own.id },
    });
    expect(sw.statusCode).toBe(204);
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(v),
      payload: { repoUrl: 'https://github.com/someone/site' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe('approval_required');
  });

  it('asking emails the admins once a day; approving lets the account deploy and tells its owner', async () => {
    const v = await visitor();
    const before = sent.length;
    const ask = () =>
      app.inject({
        method: 'POST',
        url: '/api/v1/access-requests',
        headers: as(v),
        payload: { note: 'My portfolio site' },
      });
    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const toAdmins = sent.slice(before).filter((m) => m.to === 'admin@example.test');
    expect(toAdmins).toHaveLength(1);
    expect(toAdmins[0]?.text).toContain('My portfolio site');

    const own = (await me(v)).orgs.find((o: { demo: boolean }) => !o.demo);
    expect(own.accessRequestedAt).not.toBeNull();
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/access-requests',
      headers: as(admin),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(
      expect.objectContaining({ orgId: own.id, note: 'My portfolio site' }),
    );
    // Only platform admins see or decide them.
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/admin/access-requests', headers: as(v) }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/admin/orgs/${own.id}/approve`,
          headers: as(v),
        })
      ).statusCode,
    ).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orgs/${own.id}/approve`,
      headers: as(admin),
    });
    expect(ok.statusCode).toBe(200);
    expect(sent.at(-1)).toMatchObject({
      to: `${v.login}@example.test`,
      subject: 'You can deploy on AutoDeploy now',
    });
    const after = (await me(v)).orgs.find((o: { id: string }) => o.id === own.id);
    expect(after).toMatchObject({ canDeploy: true, accessRequestedAt: null });
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/access-requests',
      headers: as(admin),
    });
    expect(listed.json().map((r: { orgId: string }) => r.orgId)).not.toContain(own.id);
    // And asking again isn't needed.
    expect((await ask()).statusCode).toBe(409);
  });

  it('a dismissed request leaves the account as it was, and it can ask again', async () => {
    const v = await visitor();
    await app.inject({
      method: 'POST',
      url: '/api/v1/access-requests',
      headers: as(v),
      payload: {},
    });
    const own = (await me(v)).orgs.find((o: { demo: boolean }) => !o.demo);
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orgs/${own.id}/dismiss-request`,
      headers: as(admin),
    });
    expect(r.statusCode).toBe(200);
    expect((await me(v)).orgs.find((o: { id: string }) => o.id === own.id)).toMatchObject({
      canDeploy: false,
      accessRequestedAt: null,
    });
  });

  it('in the demo, visitors see who runs it and themselves, never each other', async () => {
    const a = await visitor();
    const b = await visitor();
    const members = await app.inject({ method: 'GET', url: '/api/v1/members', headers: as(a) });
    expect(members.statusCode).toBe(200);
    const logins = members.json().map((m: { login: string }) => m.login);
    expect(logins).toContain(admin.login);
    expect(logins).toContain(a.login);
    expect(logins).not.toContain(b.login);
  });
});
