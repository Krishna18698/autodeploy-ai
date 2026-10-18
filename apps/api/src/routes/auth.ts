import { Me } from '@autodeploy/contracts';
import { randomToken, sha256Hex } from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';
import { exchangeOAuthCode } from '@autodeploy/github';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { githubAppConfigured } from '../env.js';
import { AppError, badRequest, conflict, forbidden, unavailable } from '../lib/errors.js';
import { authOf, requireRole, SESSION_COOKIE } from '../plugins/auth.js';
import { queueSiteRemoval } from '../services/site-removal.js';

const SESSION_DAYS = 14;
const STATE_COOKIE = 'ad_oauth_state';

type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

/** Upserts the user and makes sure they have a personal org they own. */
export async function upsertUserWithOrg(
  sql: Sql,
  u: {
    githubId: number | null;
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  },
) {
  return sql.begin(async (tx) => {
    const [user] = await tx<{ id: string }[]>`
      insert into users (github_id, login, name, email, avatar_url)
      values (${u.githubId}, ${u.login}, ${u.name}, ${u.email}, ${u.avatarUrl})
      on conflict (login) do update set
        github_id = coalesce(excluded.github_id, users.github_id),
        name = excluded.name, email = coalesce(users.email, excluded.email), avatar_url = excluded.avatar_url
      returning id`;
    if (!user) throw new Error('user upsert failed');
    const [existing] = await tx<
      { org_id: string }[]
    >`select org_id from memberships where user_id = ${user.id} limit 1`;
    if (existing) return { userId: user.id, orgId: existing.org_id };
    const slug = u.login.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const [org] = await tx<{ id: string }[]>`
      insert into orgs (slug, name) values (${slug}, ${u.name ?? u.login})
      on conflict (slug) do update set slug = orgs.slug || '-' || substr(md5(random()::text), 1, 4)
      returning id`;
    if (!org) throw new Error('org insert failed');
    await tx`insert into memberships (org_id, user_id, role) values (${org.id}, ${user.id}, 'owner')`;
    return { userId: user.id, orgId: org.id };
  });
}

async function startSession(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  orgId: string,
) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  await deps.sql`
    insert into sessions (token_hash, user_id, org_id, csrf_token, ip, user_agent, expires_at)
    values (${sha256Hex(token)}, ${userId}, ${orgId}, ${csrf}, ${req.ip}, ${req.headers['user-agent']?.slice(0, 300) ?? null},
            now() + ${`${SESSION_DAYS} days`}::interval)`;
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: deps.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
    ...(deps.env.SESSION_COOKIE_DOMAIN && { domain: deps.env.SESSION_COOKIE_DOMAIN }),
  });
  return csrf;
}

export const authRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const strict = { rateLimit: { limit: 20, windowMs: 60_000, key: 'ip' as const } };

    app.get(
      '/auth/github/login',
      {
        config: strict,
        schema: { hide: true },
      },
      async (_req, reply) => {
        if (!githubAppConfigured(deps.env)) {
          throw unavailable(
            'github_not_configured',
            'GitHub sign-in is not configured on this server yet (missing GitHub App credentials).',
          );
        }
        const state = randomToken(18);
        // Sign-in starts on the app's host but GitHub returns to the API's
        // host, so the state cookie must be shared like the session cookie.
        reply.setCookie(STATE_COOKIE, state, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/auth',
          maxAge: 600,
          secure: deps.env.NODE_ENV === 'production',
          ...(deps.env.SESSION_COOKIE_DOMAIN && { domain: deps.env.SESSION_COOKIE_DOMAIN }),
        });
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', deps.env.GITHUB_APP_CLIENT_ID ?? '');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', `${deps.env.API_PUBLIC_URL}/auth/github/callback`);
        return reply.redirect(url.toString());
      },
    );

    app.get(
      '/auth/github/callback',
      {
        config: strict,
        schema: { hide: true, querystring: z.object({ code: z.string(), state: z.string() }) },
      },
      async (req, reply) => {
        const expected = req.cookies[STATE_COOKIE];
        reply.clearCookie(STATE_COOKIE, {
          path: '/auth',
          ...(deps.env.SESSION_COOKIE_DOMAIN && { domain: deps.env.SESSION_COOKIE_DOMAIN }),
        });
        if (!expected || expected !== req.query.state)
          throw forbidden('OAuth state mismatch; start sign-in again');
        const token = await exchangeOAuthCode(
          {
            clientId: deps.env.GITHUB_APP_CLIENT_ID ?? '',
            clientSecret: deps.env.GITHUB_APP_CLIENT_SECRET ?? '',
          },
          req.query.code,
        );
        const res = await fetch('https://api.github.com/user', {
          headers: { authorization: `Bearer ${token}`, 'user-agent': 'autodeploy' },
        });
        if (!res.ok) throw new AppError(502, 'github_error', 'Could not read your GitHub profile');
        const gh = (await res.json()) as GitHubUser;
        const allow = deps.env.ALLOWED_GITHUB_LOGINS;
        if (allow.length > 0 && !allow.includes(gh.login.toLowerCase())) {
          throw forbidden('AutoDeploy is invite-only during the beta.');
        }
        const { userId, orgId } = await upsertUserWithOrg(deps.sql, {
          githubId: gh.id,
          login: gh.login,
          name: gh.name,
          email: gh.email,
          avatarUrl: gh.avatar_url,
        });
        await startSession(deps, req, reply, userId, orgId);
        return reply.redirect(`${deps.env.APP_URL}/overview`);
      },
    );

    // Local development only: the env schema refuses DEV_LOGIN in production.
    app.post(
      '/auth/dev-login',
      {
        config: strict,
        schema: {
          hide: true,
          body: z
            .object({
              login: z
                .string()
                .regex(/^[\w-]{1,39}$/)
                .default('dev'),
            })
            .default({ login: 'dev' }),
        },
      },
      async (req, reply) => {
        if (!deps.env.DEV_LOGIN) throw forbidden('Dev login is disabled');
        const { userId, orgId } = await upsertUserWithOrg(deps.sql, {
          githubId: null,
          login: req.body.login,
          name: req.body.login === 'dev' ? 'Local Developer' : req.body.login,
          email: null,
          avatarUrl: null,
        });
        const csrfToken = await startSession(deps, req, reply, userId, orgId);
        return { ok: true, csrfToken };
      },
    );

    app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
      if (req.auth?.sessionHash)
        await deps.sql`delete from sessions where token_hash = ${req.auth.sessionHash}`;
      reply.clearCookie(SESSION_COOKIE, {
        path: '/',
        ...(deps.env.SESSION_COOKIE_DOMAIN && { domain: deps.env.SESSION_COOKIE_DOMAIN }),
      });
      return reply.code(204).send();
    });

    app.get(
      '/api/v1/me',
      { preHandler: requireRole(), schema: { tags: ['auth'], response: { 200: Me } } },
      async (req) => {
        const a = authOf(req);
        const [user] = await deps.sql<
          {
            id: string;
            login: string;
            name: string | null;
            avatar_url: string | null;
            email: string | null;
          }[]
        >`
        select id, login, name, avatar_url, email from users where id = ${a.userId}`;
        const orgs = await deps.sql<
          {
            id: string;
            slug: string;
            name: string;
            role: 'owner' | 'admin' | 'member' | 'viewer';
          }[]
        >`
        select o.id, o.slug, o.name, m.role from memberships m join orgs o on o.id = m.org_id
        where m.user_id = ${a.userId} order by o.name`;
        const org = orgs.find((o) => o.id === a.orgId) ?? orgs[0];
        if (!user || !org) throw forbidden();
        return {
          user: {
            id: user.id,
            login: user.login,
            name: user.name,
            avatarUrl: user.avatar_url,
            email: user.email,
          },
          org,
          orgs,
          csrfToken: a.csrfToken ?? null,
        };
      },
    );

    // GitHub only shares public emails, so people set where notifications go.
    // Sign-in never overwrites it (a missing GitHub email keeps this one).
    app.patch(
      '/api/v1/me',
      {
        preHandler: requireRole(),
        config: { audit: 'user.update' },
        schema: {
          tags: ['auth'],
          body: z.object({ email: z.email().max(254).nullable() }),
          response: { 204: z.null().describe('Saved') },
        },
      },
      async (req, reply) => {
        const a = authOf(req);
        await deps.sql`update users set email = ${req.body.email} where id = ${a.userId}`;
        req.auditTarget = { type: 'user', id: a.userId };
        return reply.code(204).send(null);
      },
    );

    // Deletes the account and every org it alone owns (projects, sites, env vars,
    // tokens, history). Sessions only, never an API token, and the login typed
    // back as confirmation. Stored files are removed by the storage sweep.
    app.delete(
      '/api/v1/me',
      {
        preHandler: requireRole(),
        config: { rateLimit: { limit: 5, windowMs: 60_000, key: 'principal' } },
        schema: { tags: ['auth'], body: z.object({ confirm: z.string().max(100) }) },
      },
      async (req, reply) => {
        const a = authOf(req);
        if (a.via !== 'session')
          throw forbidden('Sign in to delete your account; API tokens cannot.');
        const [user] = await deps.sql<
          { login: string }[]
        >`select login from users where id = ${a.userId}`;
        if (!user || req.body.confirm.trim().toLowerCase() !== user.login.toLowerCase())
          throw badRequest('confirm_mismatch', `Type ${user?.login ?? 'your login'} to confirm.`);
        await deps.sql.begin(async (tx) => {
          await tx`select set_config('app.allow_event_delete', 'on', true)`;
          const owned = await tx<{ org_id: string; others: number }[]>`
            select m.org_id, (select count(*)::int from memberships x
              where x.org_id = m.org_id and x.user_id <> ${a.userId}) as others
            from memberships m where m.user_id = ${a.userId} and m.role = 'owner'`;
          if (owned.some((o) => o.others > 0))
            throw conflict(
              'org_has_members',
              'You own an organisation with other members. Transfer ownership or remove them first.',
            );
          for (const o of owned) {
            const projects = await tx<
              { id: string }[]
            >`select id from projects where org_id = ${o.org_id}`;
            for (const p of projects) await queueSiteRemoval(tx, p.id, null);
            await tx`delete from orgs where id = ${o.org_id}`;
          }
          await tx`delete from users where id = ${a.userId}`;
        });
        req.log.info({ orgs: 'deleted' }, 'account deleted');
        reply.clearCookie(SESSION_COOKIE, {
          path: '/',
          ...(deps.env.SESSION_COOKIE_DOMAIN && { domain: deps.env.SESSION_COOKIE_DOMAIN }),
        });
        return reply.code(204).send();
      },
    );

    app.post(
      '/api/v1/session/org',
      {
        preHandler: requireRole(),
        schema: { tags: ['auth'], body: z.object({ orgId: z.uuid() }) },
      },
      async (req, reply) => {
        const a = authOf(req);
        if (a.via !== 'session' || !a.sessionHash)
          throw forbidden('API tokens are bound to one org');
        const [m] =
          await deps.sql`select 1 from memberships where org_id = ${req.body.orgId} and user_id = ${a.userId}`;
        if (!m) throw forbidden('Not a member of that org');
        await deps.sql`update sessions set org_id = ${req.body.orgId} where token_hash = ${a.sessionHash}`;
        return reply.code(204).send();
      },
    );
  };
