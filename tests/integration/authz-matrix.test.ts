import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeDeployment, makeOrg, makeProject } from './helpers';

// The authorization matrix, generated from the API itself: every operation in
// the OpenAPI document (plus the hidden routes that take an ID) is called
//   - signed out (401 unless public),
//   - as each role in an org that owns the resources (403 below the role in
//     POLICY, never 401/403 at or above it),
//   - as the owner of another org, with the first org's IDs (never succeeds,
//     never echoes the other org's data, changes nothing).
// A route with no POLICY entry fails the test, so new routes can't skip it.

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

type Role = 'viewer' | 'member' | 'admin' | 'owner';
/** staff: platform admins only, so no role in any org is enough. */
type Need = 'public' | Role | 'staff';
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** One org's worth of every kind of resource a route can name. */
type Fixtures = Awaited<ReturnType<typeof seed>>;
/** The resources a call names, and who is calling. */
type Ctx = { f: Fixtures; self: string; orgId: string };
type Rule = {
  need: Need;
  body?: (c: Ctx) => object;
  /** Server-sent events: only the refusals are checked (the stream never ends). */
  live?: true;
  /** Names something public by design (a site's address), so any org may ask about it. */
  global?: true;
};

const localRepo = `file://${resolve('tests/fixtures/vite-ok')}`;

/** Who may call what. Paths as in the OpenAPI document. */
const POLICY: Record<string, Rule> = {
  'GET /healthz': { need: 'public' },
  'GET /readyz': { need: 'public' },

  'GET /api/v1/me': { need: 'viewer' },
  'PATCH /api/v1/me': { need: 'viewer', body: () => ({ email: null }) },
  'DELETE /api/v1/me': { need: 'viewer', body: (c) => ({ confirm: c.self }) },
  'POST /api/v1/session/org': { need: 'viewer', body: (c) => ({ orgId: c.orgId }) },

  'GET /api/v1/me/2fa': { need: 'viewer' },
  'POST /api/v1/me/2fa/setup': { need: 'viewer' },
  'POST /api/v1/me/2fa/enable': { need: 'viewer', body: () => ({ code: '000000' }) },
  'POST /api/v1/me/2fa/verify': { need: 'viewer', body: () => ({ code: '000000' }) },
  'POST /api/v1/me/2fa/recovery-codes': { need: 'viewer' },
  'DELETE /api/v1/me/2fa': { need: 'viewer', body: () => ({ code: '000000' }) },

  'GET /api/v1/projects': { need: 'viewer' },
  'POST /api/v1/projects': {
    need: 'member',
    body: () => ({ repoUrl: localRepo, slug: `m-${randomUUID().slice(0, 8)}`, deploy: false }),
  },
  'GET /api/v1/projects/{id}': { need: 'viewer' },
  'PATCH /api/v1/projects/{id}': { need: 'admin', body: () => ({ name: 'renamed' }) },
  'DELETE /api/v1/projects/{id}': { need: 'admin' },
  'GET /api/v1/projects/{id}/env': { need: 'member' },
  'POST /api/v1/projects/{id}/env/import': {
    need: 'admin',
    body: () => ({ vars: [{ key: 'IMPORTED', value: 'v' }] }),
  },
  'PUT /api/v1/projects/{id}/env/{key}': { need: 'admin', body: () => ({ value: 'v' }) },
  'DELETE /api/v1/projects/{id}/env/{key}': { need: 'admin' },
  'POST /api/v1/projects/{id}/deployments': { need: 'member', body: () => ({}) },
  'POST /api/v1/projects/{id}/rollback': {
    need: 'member',
    body: (c) => ({ deploymentId: c.f.older }),
  },
  'GET /api/v1/slugs/{slug}': { need: 'viewer', global: true },
  'GET /api/v1/github/repos': { need: 'member' },
  'POST /api/v1/analyze': { need: 'member', body: () => ({ repoUrl: localRepo }) },

  'GET /api/v1/deployments': { need: 'viewer' },
  'GET /api/v1/deployments/{id}': { need: 'viewer' },
  'POST /api/v1/deployments/{id}/cancel': { need: 'member' },
  'GET /api/v1/deployments/{id}/events': { need: 'viewer' },
  'GET /api/v1/deployments/{id}/logs': { need: 'viewer' },
  'GET /api/v1/deployments/{id}/stream': { need: 'viewer', live: true },
  'GET /api/v1/deployments/{id}/screenshot': { need: 'viewer' },
  'GET /api/v1/deployments/{id}/repairs': { need: 'viewer' },
  'GET /api/v1/repairs': { need: 'viewer' },
  'POST /api/v1/repairs/{id}/approve': { need: 'admin' },
  'POST /api/v1/repairs/{id}/reject': { need: 'member' },
  'POST /api/v1/repairs/{id}/pull-request': { need: 'member' },

  'GET /api/v1/members': { need: 'viewer' },
  'POST /api/v1/members': {
    need: 'admin',
    body: () => ({ login: `nobody-${randomUUID().slice(0, 8)}`, role: 'viewer' }),
  },
  'PATCH /api/v1/members/{id}': { need: 'admin', body: () => ({ role: 'viewer' }) },
  'DELETE /api/v1/members/{id}': { need: 'admin' },
  'GET /api/v1/members/invitations': { need: 'admin' },
  'DELETE /api/v1/members/invitations/{id}': { need: 'admin' },
  'GET /api/v1/invitations': { need: 'viewer' },
  'POST /api/v1/invitations/{id}/accept': { need: 'viewer' },
  'POST /api/v1/invitations/{id}/decline': { need: 'viewer' },

  'GET /api/v1/tokens': { need: 'viewer' },
  'POST /api/v1/tokens': { need: 'viewer', body: () => ({ name: 't', scopes: ['read'] }) },
  'DELETE /api/v1/tokens/{id}': { need: 'viewer' },

  'GET /api/v1/webhooks': { need: 'admin' },
  'POST /api/v1/webhooks': {
    need: 'admin',
    body: () => ({ url: 'https://example.invalid/hook', events: ['deployment.succeeded'] }),
  },
  'DELETE /api/v1/webhooks/{id}': { need: 'admin' },
  'GET /api/v1/webhooks/{id}/deliveries': { need: 'admin' },
  'POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver': { need: 'admin' },
  'POST /api/v1/webhooks/{id}/test': { need: 'admin' },

  'GET /api/v1/audit': { need: 'admin' },

  'GET /api/v1/admin/sites': { need: 'staff' },
  'POST /api/v1/admin/sites/{id}/takedown': { need: 'staff', body: () => ({ reason: 'abuse' }) },
  'POST /api/v1/admin/sites/{id}/restore': { need: 'staff' },
  'POST /api/v1/admin/orgs/{id}/suspend': { need: 'staff', body: () => ({ reason: 'abuse' }) },
  'POST /api/v1/admin/orgs/{id}/unsuspend': { need: 'staff' },
  'GET /api/v1/quota': { need: 'viewer' },
  'GET /api/v1/analytics': { need: 'viewer' },
};

/** Hidden from the API description but named by ID, so checked all the same. */
const HIDDEN = ['GET /api/v1/deployments/{id}/stream', 'GET /api/v1/deployments/{id}/screenshot'];

async function seed(orgId: string) {
  const sql = deps.sql;
  const tag = randomUUID().slice(0, 8);
  const project = await makeProject(deps.sql, orgId, { slug: `fx-${tag}` });
  const older = await makeDeployment(sql, orgId, project.id, 'SUPERSEDED', 1);
  const deployment = await makeDeployment(sql, orgId, project.id, 'BUILDING', 2);
  const [repair] = await sql<{ id: string }[]>`
    insert into repair_attempts (deployment_id, org_id, attempt_no, error_code, error_signature,
      strategy, title, explanation, diff, status, needs_approval)
    values (${deployment}, ${orgId}, 1, 'TS_COMPILE', ${`sig-${tag}`}, 'ai', 'Fix', 'Because',
      'diff --git a/x b/x', 'awaiting_approval', true)
    returning id`;
  const envKey = `SECRET_${tag.toUpperCase()}`;
  await sql`insert into env_vars (project_id, org_id, key, ciphertext, dek_ciphertext, key_version, preview)
    values (${project.id}, ${orgId}, ${envKey}, '\\x00', '\\x00', 1, 'xx…xx')`;
  const hookUrl = `https://hooks.example.invalid/${tag}`;
  const [webhook] = await sql<{ id: string }[]>`
    insert into webhook_endpoints (org_id, url, secret_ciphertext, secret_dek, key_version, events)
    values (${orgId}, ${hookUrl}, '\\x00', '\\x00', 1, ${['deployment.succeeded']}) returning id`;
  const [delivery] = await sql<{ id: string }[]>`
    insert into webhook_deliveries (endpoint_id, org_id, event_id, event_type, payload, status)
    values (${webhook!.id}, ${orgId}, ${`ev-${tag}`}, 'deployment.succeeded', '{}', 'failed') returning id`;
  const memberLogin = `mate-${tag}`;
  const [member] = await sql<
    { id: string }[]
  >`insert into users (login) values (${memberLogin}) returning id`;
  await sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${member!.id}, 'member')`;
  const [token] = await sql<{ id: string }[]>`
    insert into api_tokens (org_id, user_id, name, token_hash, prefix, scopes)
    values (${orgId}, ${member!.id}, ${`tok-${tag}`}, ${`hash-${tag}`}, 'ad_x', ${['read']}) returning id`;
  const inviteeLogin = `invitee-${tag}`;
  const [invitee] = await sql<
    { id: string }[]
  >`insert into users (login) values (${inviteeLogin}) returning id`;
  const [invitation] = await sql<{ id: string }[]>`
    insert into invitations (org_id, user_id, role, invited_by)
    values (${orgId}, ${invitee!.id}, 'member', ${member!.id}) returning id`;
  return {
    orgId,
    project,
    older,
    deployment,
    repair: repair!.id,
    envKey,
    hookUrl,
    webhook: webhook!.id,
    delivery: delivery!.id,
    member: member!.id,
    memberLogin,
    token: token!.id,
    invitation: invitation!.id,
    inviteeLogin,
  };
}

/** Every string that would show one org's data leaking to another. */
const secretsOf = (f: Fixtures) => [
  f.project.id,
  f.project.slug,
  f.older,
  f.deployment,
  f.repair,
  f.envKey,
  f.hookUrl,
  f.webhook,
  f.delivery,
  f.member,
  f.memberLogin,
  f.token,
  f.invitation,
  f.inviteeLogin,
];

/** Fills `{id}`-style parameters with the fixture each path segment names. */
function fill(path: string, f: Fixtures) {
  return path.replace(/\/([a-z-]+)\/\{(\w+)\}/g, (_m, seg: string, name: string) => {
    const pick: Record<string, string> = {
      projects: f.project.id,
      deployments: f.deployment,
      repairs: f.repair,
      webhooks: f.webhook,
      members: f.member,
      invitations: f.invitation,
      tokens: f.token,
      env: f.envKey,
      slugs: f.project.slug,
      deliveries: f.delivery,
      sites: f.project.id,
      orgs: f.orgId,
    };
    const v = name === 'deliveryId' ? f.delivery : pick[seg];
    if (!v) throw new Error(`No fixture for {${name}} after /${seg} in ${path}`);
    return `/${seg}/${v}`;
  });
}

type Session = { cookie: string; csrf: string; login: string };

/** Signs a fresh user in, gives them `role` in `orgId`, and makes it their session's org. */
// Sign-in is rate-limited per address, and the suites share one limiter:
// each sign-in here comes from its own test address (198.18.1.0/24).
let signIns = 0;
async function signIn(orgId: string, role: Role): Promise<Session> {
  const login = `${role}-${randomUUID().slice(0, 8)}`;
  signIns = (signIns % 250) + 1;
  const r = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { login },
    remoteAddress: `198.18.1.${signIns}`,
  });
  expect(r.statusCode).toBe(200);
  const s = {
    cookie: String(r.headers['set-cookie']).split(';')[0] ?? '',
    csrf: r.json().csrfToken as string,
    login,
  };
  const [u] = await deps.sql<{ id: string }[]>`select id from users where login = ${login}`;
  await deps.sql`insert into memberships (org_id, user_id, role) values (${orgId}, ${u!.id}, ${role})`;
  const sw = await app.inject({
    method: 'POST',
    url: '/api/v1/session/org',
    headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
    payload: { orgId },
  });
  expect(sw.statusCode).toBe(204);
  return s;
}

async function call(op: string, s: Session | null, c: Ctx) {
  const [method, path] = op.split(' ') as [string, string];
  const rule = POLICY[op]!;
  const url = fill(path, c.f);
  const payload = rule.body?.(c);
  const r = await app.inject({
    method: method as 'GET',
    url,
    headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {},
    ...(payload && { payload }),
  });
  /** What the caller sent: an error that repeats it back leaks nothing. */
  const sent = url + JSON.stringify(payload ?? {});
  return Object.assign(r, { sent });
}

/** Deletes last, children before parents, and the caller's own account at the very end. */
function ordered(ops: string[]) {
  const weight = (op: string) =>
    op === 'DELETE /api/v1/me' ? 1e6 : op.startsWith('DELETE ') ? 1e3 - op.length : 0;
  return [...ops].sort((a, b) => weight(a) - weight(b));
}

/** Everything of one org's that a route could change. */
async function snapshot(orgId: string) {
  const sql = deps.sql;
  return {
    projects:
      await sql`select id, slug, name, updated_at from projects where org_id = ${orgId} order by id`,
    deployments: await sql`select id, status from deployments where org_id = ${orgId} order by id`,
    repairs:
      await sql`select id, status, pr_url from repair_attempts where org_id = ${orgId} order by id`,
    env: await sql`select key, updated_at from env_vars where org_id = ${orgId} order by key`,
    webhooks:
      await sql`select id, url, active from webhook_endpoints where org_id = ${orgId} order by id`,
    deliveries:
      await sql`select id, status, attempts from webhook_deliveries where org_id = ${orgId} order by id`,
    members:
      await sql`select user_id, role from memberships where org_id = ${orgId} order by user_id`,
    invitations: await sql`select id from invitations where org_id = ${orgId} order by id`,
    tokens: await sql`select id, revoked_at from api_tokens where org_id = ${orgId} order by id`,
    jobs: await sql`select count(*)::int as n from jobs where org_id = ${orgId}`,
  };
}

describe('Authorization matrix (every route in the API description)', () => {
  let ops: string[] = [];
  beforeAll(async () => {
    const r = await app.inject({ url: '/openapi.json' });
    const doc = r.json() as { paths: Record<string, Record<string, unknown>> };
    ops = Object.entries(doc.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`))
      .concat(HIDDEN);
  });

  it('has a policy for every route, and no policy for a route that no longer exists', () => {
    for (const op of HIDDEN) {
      const [method, path] = op.split(' ') as [string, string];
      expect(app.hasRoute({ method, url: path.replace(/\{(\w+)\}/g, ':$1') }), op).toBe(true);
    }
    expect([...ops].sort()).toEqual(Object.keys(POLICY).sort());
  });

  it('refuses every non-public route without a session', async () => {
    const f = await seed(await makeOrg(deps.sql));
    for (const op of ops) {
      const r = await call(op, null, { f, self: 'nobody', orgId: f.orgId });
      if (POLICY[op]!.need === 'public') expect(r.statusCode, op).not.toBe(401);
      else expect(r.statusCode, `${op} → ${r.statusCode}`).toBe(401);
    }
  });

  it.each(['viewer', 'member', 'admin', 'owner'] as const)(
    'gives a %s exactly the routes their role allows',
    async (role) => {
      const f = await seed(await makeOrg(deps.sql));
      const s = await signIn(f.orgId, role);
      const wrong: string[] = [];
      for (const op of ordered(ops)) {
        const rule = POLICY[op]!;
        if (rule.need === 'public') continue;
        const allowed = rule.need !== 'staff' && RANK[role] >= RANK[rule.need];
        if (allowed && rule.live) continue;
        const r = await call(op, s, { f, self: s.login, orgId: f.orgId });
        const ok = allowed ? r.statusCode !== 401 && r.statusCode !== 403 : r.statusCode === 403;
        if (!ok) wrong.push(`${op} → ${r.statusCode} (${allowed ? 'allowed' : 'refused'})`);
      }
      expect(wrong).toEqual([]);
    },
  );

  it("never lets another org's owner read, change or even confirm the first org's resources", async () => {
    const victim = await seed(await makeOrg(deps.sql));
    const before = await snapshot(victim.orgId);
    const home = await seed(await makeOrg(deps.sql));
    const s = await signIn(home.orgId, 'owner');
    const secrets = secretsOf(victim);
    const wrong: string[] = [];
    for (const op of ordered(ops)) {
      const rule = POLICY[op]!;
      if (rule.need === 'public') continue;
      const [, path] = op.split(' ') as [string, string];
      const named = path.includes('{');
      // Routes that name a resource get the victim's; the rest act on the caller's own org,
      // except that switching org is asked for the victim's.
      const r = await call(op, s, {
        f: named ? victim : home,
        self: s.login,
        orgId: victim.orgId,
      });
      if (named && !rule.global && r.statusCode < 400) wrong.push(`${op} → ${r.statusCode}`);
      const leaked = secrets.filter((x) => r.body.includes(x) && !r.sent.includes(x));
      if (leaked.length) wrong.push(`${op} → ${r.statusCode} echoed ${leaked.join(', ')}`);
    }
    // A resource of its own in the path, someone else's in the body.
    const mixed = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${home.project.id}/rollback`,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
      payload: { deploymentId: victim.older },
    });
    if (mixed.statusCode < 400)
      wrong.push(`rollback to another org's deployment → ${mixed.statusCode}`);
    expect(wrong).toEqual([]);
    expect(await snapshot(victim.orgId)).toEqual(before);
  });
});
