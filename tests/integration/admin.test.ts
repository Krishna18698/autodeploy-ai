import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import {
  activate,
  isTakenDown,
  type RouteStore,
  reconcileRoutes,
  restoreRoutes,
  takeDownRoutes,
} from '@autodeploy/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeDeployment, makeOrg, makeProject } from './helpers';

const ADMIN_GITHUB_ID = 4242424;
let app: FastifyInstance;
let deps: Deps;
const sent: { to: string; subject: string; text: string }[] = [];

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
    RATE_LIMIT_PER_MINUTE: '10000',
    PLATFORM_ADMIN_GITHUB_IDS: String(ADMIN_GITHUB_ID),
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  deps.sendEmail = async (m) => {
    sent.push(m);
  };
  app = await buildApp(deps);
});
afterAll(async () => {
  await app.close();
  await deps.close();
});

type Session = { cookie: string; csrf: string };
async function login(name: string, githubId: number | null = null): Promise<Session> {
  const r = await app.inject({ method: 'POST', url: '/auth/dev-login', payload: { login: name } });
  expect(r.statusCode).toBe(200);
  if (githubId !== null)
    await deps.sql`update users set github_id = ${githubId} where login = ${name}`;
  return { cookie: String(r.headers['set-cookie']).split(';')[0] ?? '', csrf: r.json().csrfToken };
}
const as = (s: Session) => ({ cookie: s.cookie, 'x-csrf-token': s.csrf });
// One admin account (GitHub ids are unique), signed in once.
let adminLogin: Promise<Session> | undefined;
const adminSession = () => {
  adminLogin ??= login(`admin-${randomUUID().slice(0, 6)}`, ADMIN_GITHUB_ID);
  return adminLogin;
};

/** The edge's KV, as the worker's routes.refresh job writes it. */
function memoryRoutes() {
  const kv = new Map<string, unknown>();
  const store: RouteStore = {
    name: 'memory',
    put: async (k, v) => void kv.set(k, v),
    delete: async (k) => void kv.delete(k),
  };
  return { kv, store };
}
/** What the worker does with a routes.refresh job. */
async function refresh(store: RouteStore, projectId: string) {
  return (await isTakenDown(deps.sql, projectId))
    ? takeDownRoutes(deps.sql, store, projectId)
    : restoreRoutes(deps.sql, store, projectId);
}

/** An account with a live site (two builds, the second live) and an owner with an email. */
async function liveSite() {
  const tag = randomUUID().slice(0, 8);
  const org = await makeOrg(deps.sql);
  const owner = await login(`owner-${tag}`);
  const [u] = await deps.sql<{ id: string }[]>`
    update users set email = ${`owner-${tag}@example.test`} where login = ${`owner-${tag}`} returning id`;
  await deps.sql`insert into memberships (org_id, user_id, role) values (${org}, ${u!.id}, 'owner')`;
  const sw = await app.inject({
    method: 'POST',
    url: '/api/v1/session/org',
    headers: as(owner),
    payload: { orgId: org },
  });
  expect(sw.statusCode).toBe(204);
  const project = await makeProject(deps.sql, org, {
    slug: `site-${tag}`,
    repoUrl: `file://${resolve('tests/fixtures/vite-ok')}`,
  });
  const ids: string[] = [];
  for (const n of [1, 2]) {
    const d = await makeDeployment(deps.sql, org, project.id, n === 2 ? 'ACTIVE' : 'SUPERSEDED', n);
    const [a] = await deps.sql<{ id: string }[]>`
      insert into artifacts (sha256, storage_prefix, file_count, bytes)
      values (${`sha-${tag}-${n}`}, 'x', 1, 1) returning id`;
    await deps.sql`update deployments set artifact_id = ${a!.id} where id = ${d}`;
    ids.push(d);
  }
  await deps.sql`update projects set active_deployment_id = ${ids[1]!} where id = ${project.id}`;
  return { org, owner, project, deployments: ids, tag };
}

describe('Platform admin: taking sites down', () => {
  it('is only for platform admins, signed in with a browser session', async () => {
    const admin = await adminSession();
    const someone = await login(`someone-${randomUUID().slice(0, 6)}`, 777);
    const me = (s: Session) => app.inject({ url: '/api/v1/me', headers: as(s) });
    expect((await me(admin)).json().user.platformAdmin).toBe(true);
    expect((await me(someone)).json().user.platformAdmin).toBe(false);
    expect(
      (await app.inject({ url: '/api/v1/admin/sites?state=down', headers: as(someone) }))
        .statusCode,
    ).toBe(403);
    // An admin's API token can't act as an admin.
    const tok = await app.inject({
      method: 'POST',
      url: '/api/v1/tokens',
      headers: as(admin),
      payload: { name: 't', scopes: ['read', 'deploy'] },
    });
    const bearer = { authorization: `Bearer ${tok.json().token}` };
    expect(
      (await app.inject({ url: '/api/v1/admin/sites?state=down', headers: bearer })).statusCode,
    ).toBe(403);
  });

  it('takes a site down everywhere, refuses its deploys, tells its owner, and restores it', async () => {
    const admin = await adminSession();
    const s = await liveSite();
    const { kv, store } = memoryRoutes();
    await restoreRoutes(deps.sql, store, s.project.id);
    expect(kv.get(`route:${s.project.slug}`)).toMatchObject({ number: 2 });

    // Found by any of its addresses.
    const found = await app.inject({
      url: `/api/v1/admin/sites?q=${encodeURIComponent(`https://d1--${s.project.slug}.autodeploy.test/x`)}`,
      headers: as(admin),
    });
    expect(found.json()[0]).toMatchObject({
      projectId: s.project.id,
      live: true,
      takenDownAt: null,
    });

    const down = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/sites/${s.project.id}/takedown`,
      headers: as(admin),
      payload: { reason: 'Phishing page imitating a bank' },
    });
    expect(down.statusCode).toBe(202);
    const [job] = await deps.sql<{ n: number }[]>`
      select count(*)::int as n from jobs where type = 'routes.refresh' and payload->>'projectId' = ${s.project.id}`;
    expect(job!.n).toBe(1);
    await refresh(store, s.project.id);
    for (const key of [
      `route:${s.project.slug}`,
      `route:d1--${s.project.slug}`,
      `route:d2--${s.project.slug}`,
    ])
      expect(kv.get(key), key).toEqual({ takenDown: true });

    // Its owner can't deploy or roll back, and finds out why by email.
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${s.project.id}/deployments`,
      headers: as(s.owner),
      payload: {},
    });
    expect(deploy.statusCode).toBe(403);
    expect(deploy.json().code).toBe('site_taken_down');
    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${s.project.id}/rollback`,
      headers: as(s.owner),
      payload: { deploymentId: s.deployments[0] },
    });
    expect(rollback.statusCode).toBe(403);
    expect(sent.at(-1)).toMatchObject({
      to: `owner-${s.tag}@example.test`,
      text: expect.stringContaining('Phishing page imitating a bank'),
    });
    // The account's own audit log records it.
    const audit = await app.inject({ url: '/api/v1/audit', headers: as(s.owner) });
    expect(JSON.stringify(audit.json())).toContain('admin.site_takedown');

    // Nothing puts it back by itself: not the route reconcile, not an activation.
    await reconcileRoutes(deps.sql, store);
    expect(kv.get(`route:${s.project.slug}`)).toEqual({ takenDown: true });
    await expect(activate(deps.sql, store, s.deployments[0]!, 'rollback', 'test')).rejects.toThrow(
      'taken down',
    );

    // Listed until restored; restoring puts every address back as it was.
    const list = await app.inject({ url: '/api/v1/admin/sites?state=down', headers: as(admin) });
    expect(list.json().some((x: { projectId: string }) => x.projectId === s.project.id)).toBe(true);
    const restore = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/sites/${s.project.id}/restore`,
      headers: as(admin),
    });
    expect(restore.statusCode).toBe(202);
    await refresh(store, s.project.id);
    expect(kv.get(`route:${s.project.slug}`)).toMatchObject({ number: 2 });
    expect(kv.get(`route:d1--${s.project.slug}`)).toMatchObject({ number: 1 });
  });

  it('suspends an account: every site down, no new projects or deploys; lifting it keeps a site taken down on its own down', async () => {
    const admin = await adminSession();
    const s = await liveSite();
    const other = await makeProject(deps.sql, s.org);
    const { kv, store } = memoryRoutes();

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/sites/${other.id}/takedown`,
      headers: as(admin),
      payload: { reason: 'Malware download' },
    });
    const sus = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orgs/${s.org}/suspend`,
      headers: as(admin),
      payload: { reason: 'Repeated abuse' },
    });
    expect(sus.statusCode).toBe(202);
    await refresh(store, s.project.id);
    expect(kv.get(`route:${s.project.slug}`)).toEqual({ takenDown: true });

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: as(s.owner),
      payload: { repoUrl: `file://${resolve('tests/fixtures/vite-ok')}`, deploy: false },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().code).toBe('account_suspended');
    // A site can't be restored on its own while its account is suspended.
    const early = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/sites/${s.project.id}/restore`,
      headers: as(admin),
    });
    expect(early.statusCode).toBe(409);

    await app.inject({
      method: 'POST',
      url: `/api/v1/admin/orgs/${s.org}/unsuspend`,
      headers: as(admin),
    });
    expect(await isTakenDown(deps.sql, s.project.id)).toBe(false);
    expect(await isTakenDown(deps.sql, other.id)).toBe(true);
    await refresh(store, s.project.id);
    expect(kv.get(`route:${s.project.slug}`)).toMatchObject({ number: 2 });
  });
});
