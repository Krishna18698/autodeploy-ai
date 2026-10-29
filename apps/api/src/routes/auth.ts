import { randomBytes } from 'node:crypto';
import { Me } from '@autodeploy/contracts';
import { randomToken, sha256Hex } from '@autodeploy/crypto';
import type { Sql, Tx } from '@autodeploy/db';
import { exchangeOAuthCode } from '@autodeploy/github';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { githubAppConfigured } from '../env.js';
import {
  CONFIRM_LINKS_PER_DAY,
  confirmAccountEmail,
  confirmedOwners,
  sendEmailConfirmation,
} from '../lib/account-email.js';
import { clientIp } from '../lib/client-ip.js';
import { AppError, badRequest, conflict, forbidden, unavailable } from '../lib/errors.js';
import { authOf, requireRecentMfa, requireRole, sessionCookie } from '../plugins/auth.js';
import { joinDemo } from '../services/portfolio.js';
import { queueSiteRemoval } from '../services/site-removal.js';
import { isPlatformAdmin } from './admin.js';

const SESSION_DAYS = 14;
const stateCookie = (env: { NODE_ENV: string }) =>
  env.NODE_ENV === 'production' ? '__Host-ad_oauth_state' : 'ad_oauth_state';
// Linking GitHub to a signed-in email account: "<state>.<user id>".
const linkCookie = (env: { NODE_ENV: string }) =>
  env.NODE_ENV === 'production' ? '__Host-ad_link_state' : 'ad_link_state';

type GitHubUser = {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

/**
 * Finds or creates the user and makes sure they have a personal org they own.
 * GitHub users are matched by their numeric id, never by login: logins can be
 * renamed and then claimed by someone else, who must not inherit the account.
 */
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
    let user: { id: string; created: boolean } | undefined;
    if (u.githubId !== null) {
      // Another account holding this login (its owner renamed on GitHub and
      // someone took the name) keeps its id and gives up the name; it gets
      // its current one back on its next sign-in.
      await tx`
        update users set login = login || '~' || substr(md5(random()::text), 1, 6)
        where lower(login) = lower(${u.login}) and github_id is distinct from ${u.githubId}`;
      [user] = await tx<{ id: string; created: boolean }[]>`
        insert into users (github_id, login, name, email, avatar_url)
        values (${u.githubId}, ${u.login}, ${u.name}, ${u.email}, ${u.avatarUrl})
        on conflict (github_id) do update set
          login = excluded.login, name = excluded.name,
          email = coalesce(users.email, excluded.email), avatar_url = excluded.avatar_url
        returning id, (xmax = 0) as created`;
    } else {
      // Local development sign-in only: no GitHub identity to match on.
      [user] = await tx<{ id: string; created: boolean }[]>`
        insert into users (login, name, email, avatar_url)
        values (${u.login}, ${u.name}, ${u.email}, ${u.avatarUrl})
        on conflict (login) do update set name = excluded.name
        returning id, (xmax = 0) as created`;
    }
    if (!user) throw new Error('user upsert failed');
    const orgId = await ensurePersonalOrg(tx, user.id, u.login, u.name);
    return { userId: user.id, orgId, created: user.created };
  });
}

/** The user's first org, or a new personal one they own. */
export async function ensurePersonalOrg(
  tx: Tx,
  userId: string,
  login: string,
  name: string | null,
): Promise<string> {
  const [existing] = await tx<
    { org_id: string }[]
  >`select org_id from memberships where user_id = ${userId} order by created_at limit 1`;
  if (existing) return existing.org_id;
  const base = login.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  // A taken slug gets a suffix on the NEW org. (It once renamed the existing
  // org and returned it, making the newcomer the owner of someone else's org.)
  let org: { id: string } | undefined;
  for (let i = 0; i < 5 && !org; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    [org] = await tx<{ id: string }[]>`
      insert into orgs (slug, name) values (${slug}, ${name ?? login})
      on conflict (slug) do nothing returning id`;
  }
  if (!org) throw new Error('org insert failed');
  await tx`insert into memberships (org_id, user_id, role) values (${org.id}, ${userId}, 'owner')`;
  return org.id;
}

// ---- trusted browsers (migration 0015) ----
// After a code at sign-in, a browser can be remembered: signing in there skips
// the code until the trust runs out, unless the sign-in looks risky. Dangerous
// actions still ask (the session itself has shown no code).
const TRUST_DAYS = 30;
const TRUST_IDLE_DAYS = 14;
const trustCookie = (env: { NODE_ENV: string }) =>
  env.NODE_ENV === 'production' ? '__Host-ad_trust' : 'ad_trust';
/** Cloudflare's country for the visitor ("T1" is Tor; "XX" unknown). */
const countryOf = (req: FastifyRequest) => {
  const c = req.headers['cf-ipcountry'];
  return typeof c === 'string' && /^[A-Z][A-Z0-9]$/.test(c) ? c : null;
};

/** This browser was trusted by this user, recently, and from the same country. */
async function trustedBrowser(deps: Deps, req: FastifyRequest, userId: string) {
  const raw = req.cookies[trustCookie(deps.env)];
  if (!raw) return false;
  const country = countryOf(req);
  if (country === 'T1') return false; // Tor: always ask
  const [row] = await deps.sql<{ country: string | null }[]>`
    select country from trusted_browsers
    where token_hash = ${sha256Hex(raw)} and user_id = ${userId} and expires_at > now()
      and last_used_at > now() - ${`${TRUST_IDLE_DAYS} days`}::interval`;
  if (!row) return false;
  // Another country than where the code was last shown: ask again.
  if (row.country && country && country !== 'XX' && row.country !== country) return false;
  await deps.sql`update trusted_browsers set last_used_at = now() where token_hash = ${sha256Hex(raw)}`;
  return true;
}

/** Remember this browser for this user after they showed a code (replacing an older trust). */
export async function trustBrowser(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
) {
  const old = req.cookies[trustCookie(deps.env)];
  if (old) await deps.sql`delete from trusted_browsers where token_hash = ${sha256Hex(old)}`;
  const token = randomToken(32);
  await deps.sql`
    insert into trusted_browsers (token_hash, user_id, country, user_agent, expires_at)
    values (${sha256Hex(token)}, ${userId}, ${countryOf(req)}, ${req.headers['user-agent']?.slice(0, 300) ?? null},
            now() + ${`${TRUST_DAYS} days`}::interval)`;
  reply.setCookie(trustCookie(deps.env), token, {
    httpOnly: true,
    secure: deps.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: TRUST_DAYS * 86400,
  });
}

/**
 * Every sign-in ends here. An account with an authenticator gets a session
 * that can only take the code (twoFactor: true), unless this browser is
 * trusted and nothing looks risky; the dashboard asks for it.
 */
export async function startSession(
  deps: Deps,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  orgId: string,
  opts: { risky?: boolean } = {},
): Promise<{ csrfToken: string; twoFactor: boolean }> {
  const token = randomToken(32);
  const csrf = randomToken(24);
  // Everyone can look around the demo; someone who can't deploy yet starts there.
  const opensIn = await joinDemo(deps.sql, deps.env, userId, orgId);
  const [mfa] = await deps.sql<{ on: boolean }[]>`
    select true as on from user_totp where user_id = ${userId} and confirmed_at is not null`;
  const twoFactor =
    Boolean(mfa) && (opts.risky === true || !(await trustedBrowser(deps, req, userId)));
  await deps.sql`
    insert into sessions (token_hash, user_id, org_id, csrf_token, ip, user_agent, expires_at, mfa_pending)
    values (${sha256Hex(token)}, ${userId}, ${opensIn}, ${csrf}, ${clientIp(req)}, ${req.headers['user-agent']?.slice(0, 300) ?? null},
            now() + ${`${SESSION_DAYS} days`}::interval, ${twoFactor})`;
  setSessionCookie(deps, reply, token);
  return { csrfToken: csrf, twoFactor };
}

// A browser ignores a deletion that lacks the attributes the cookie was set
// with (a __Host- cookie needs Secure), so clearing repeats them.
const cleared = (deps: Deps) =>
  ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.env.NODE_ENV === 'production',
  }) as const;

export function clearSessionCookie(deps: Deps, reply: FastifyReply) {
  reply.clearCookie(sessionCookie(deps.env), cleared(deps));
}

/** The session cookie: host-only on whichever host answered (the API's, for the dashboard). */
export function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookie(deps.env), token, {
    httpOnly: true,
    secure: deps.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
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
        // Sign-in starts and ends on the API's host, where the dashboard sends
        // its requests, so this cookie and the session cookie stay host-only there.
        reply.setCookie(stateCookie(deps.env), state, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 600,
          secure: deps.env.NODE_ENV === 'production',
        });
        const url = new URL('https://github.com/login/oauth/authorize');
        url.searchParams.set('client_id', deps.env.GITHUB_APP_CLIENT_ID ?? '');
        url.searchParams.set('state', state);
        url.searchParams.set('redirect_uri', `${deps.env.API_PUBLIC_URL}/auth/github/callback`);
        return reply.redirect(url.toString());
      },
    );

    // An email account links its GitHub account: needed to see private repos
    // through the App, and lets "Continue with GitHub" sign in to it later.
    app.get(
      '/auth/github/connect',
      { config: strict, schema: { hide: true } },
      async (req, reply) => {
        if (!githubAppConfigured(deps.env)) {
          throw unavailable(
            'github_not_configured',
            'GitHub is not configured on this server yet.',
          );
        }
        const a = req.auth;
        if (a?.via !== 'session') return reply.redirect(`${deps.env.APP_URL}/login`);
        if (a.githubId !== null) return reply.redirect(`${deps.env.APP_URL}/settings?tab=account`);
        const state = randomToken(18);
        reply.setCookie(linkCookie(deps.env), `${state}.${a.userId}`, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 600,
          secure: deps.env.NODE_ENV === 'production',
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
        schema: {
          hide: true,
          // GitHub sends `error` instead of `code` when the person cancels.
          querystring: z.object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional(),
          }),
        },
      },
      async (req, reply) => {
        // A person lands here in a browser: failures go back to the sign-in
        // page with a code it turns into a fixed message (never text from the URL).
        const toLogin = (
          error: 'expired' | 'cancelled' | 'github' | 'closed' | 'relogin' | 'github_email_taken',
        ) => reply.redirect(`${deps.env.APP_URL}/login?error=${error}`);
        const [linkState, linkUser] = (req.cookies[linkCookie(deps.env)] ?? '').split('.');
        const linking = Boolean(linkState) && linkState === req.query.state;
        if (linking) reply.clearCookie(linkCookie(deps.env), cleared(deps));
        else {
          const expected = req.cookies[stateCookie(deps.env)];
          reply.clearCookie(stateCookie(deps.env), cleared(deps));
          if (req.query.error) return toLogin('cancelled');
          if (!expected || expected !== req.query.state) return toLogin('expired');
        }
        if (req.query.error || !req.query.code)
          return linking
            ? reply.redirect(`${deps.env.APP_URL}/settings?tab=account`)
            : toLogin('cancelled');
        let gh: GitHubUser;
        try {
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
          if (!res.ok) throw new Error(`GitHub /user ${res.status}`);
          gh = (await res.json()) as GitHubUser;
        } catch (err) {
          req.log.warn({ err }, 'GitHub sign-in failed');
          return toLogin('github');
        }
        if (linking) {
          // Still the same signed-in person who started it.
          const a = req.auth;
          if (a?.via !== 'session' || a.userId !== linkUser) return toLogin('relogin');
          const settings = `${deps.env.APP_URL}/settings?tab=account&github=`;
          const linked = await deps.sql`
            update users set github_id = ${gh.id}, name = coalesce(name, ${gh.name}),
              avatar_url = coalesce(avatar_url, ${gh.avatar_url})
            where id = ${a.userId} and github_id is null
              and not exists (select 1 from users where github_id = ${gh.id})
            returning id`.catch((err: { code?: string }) => {
            if (err.code === '23505') return [];
            throw err;
          });
          // Already linked to another AutoDeploy account (one GitHub account, one AutoDeploy account).
          return reply.redirect(`${settings}${linked.length ? 'connected' : 'taken'}`);
        }
        const allow = deps.env.ALLOWED_GITHUB_LOGINS;
        if (allow.length > 0 && !allow.includes(gh.login.toLowerCase())) return toLogin('closed');
        // A GitHub account new to us whose email another account holds
        // confirmed: that person signs in there and connects GitHub, instead
        // of getting a second account.
        const [known] = await deps.sql`select 1 from users where github_id = ${gh.id}`;
        if (!known && gh.email && (await confirmedOwners(deps.sql, gh.email.toLowerCase())).length)
          return toLogin('github_email_taken');
        const { userId, orgId, created } = await upsertUserWithOrg(deps.sql, {
          githubId: gh.id,
          login: gh.login,
          name: gh.name,
          email: gh.email,
          avatarUrl: gh.avatar_url,
        });
        // A new account's email came from GitHub, unconfirmed: send the link.
        if (created && gh.email)
          await sendEmailConfirmation(deps, { id: userId, login: gh.login }, gh.email).catch(
            (err) => req.log.warn({ err }, 'email confirmation not sent'),
          );
        const { twoFactor } = await startSession(deps, req, reply, userId, orgId);
        return reply.redirect(`${deps.env.APP_URL}${twoFactor ? '/login/2fa' : '/overview'}`);
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
        return { ok: true, ...(await startSession(deps, req, reply, userId, orgId)) };
      },
    );

    app.post('/auth/logout', { schema: { hide: true } }, async (req, reply) => {
      const hash = req.auth?.sessionHash ?? req.pendingMfa?.sessionHash;
      if (hash) await deps.sql`delete from sessions where token_hash = ${hash}`;
      clearSessionCookie(deps, reply);
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
            email_confirmed: boolean;
            google: boolean;
          }[]
        >`
        select id, login, name, avatar_url, email, email_verified_at is not null as email_confirmed,
          google_sub is not null as google
        from users where id = ${a.userId}`;
        const orgs = (
          await deps.sql<
            {
              id: string;
              slug: string;
              name: string;
              role: 'owner' | 'admin' | 'member' | 'viewer';
              demo: boolean;
              approved: boolean;
              suspended: boolean;
              access_requested_at: Date | null;
            }[]
          >`
          select o.id, o.slug, o.name, m.role, o.is_demo as demo,
            o.deploys_approved_at is not null as approved, o.suspended_at is not null as suspended,
            o.access_requested_at
          from memberships m join orgs o on o.id = m.org_id
          where m.user_id = ${a.userId} order by o.is_demo, o.name`
        ).map((o) => ({
          id: o.id,
          slug: o.slug,
          name: o.name,
          role: o.role,
          demo: o.demo,
          canDeploy:
            !o.suspended &&
            (o.approved || deps.env.DEPLOY_APPROVAL === 'open') &&
            o.role !== 'viewer',
          accessRequestedAt: o.access_requested_at?.toISOString() ?? null,
        }));
        const org = orgs.find((o) => o.id === a.orgId) ?? orgs[0];
        if (!user || !org) throw forbidden();
        return {
          user: {
            id: user.id,
            login: user.login,
            name: user.name,
            avatarUrl: user.avatar_url,
            email: user.email,
            emailConfirmed: user.email_confirmed,
            githubConnected: a.githubId !== null,
            googleConnected: user.google,
            platformAdmin: isPlatformAdmin(deps.env, a),
          },
          org,
          orgs,
          csrfToken: a.csrfToken ?? null,
        };
      },
    );

    // The account email: where notifications go and, once confirmed, what a
    // Google sign-in or a new GitHub account is matched on. GitHub only shares
    // public emails, so people set it here; sign-in never overwrites it. A new
    // address starts unconfirmed and gets a link.
    app.patch(
      '/api/v1/me',
      {
        preHandler: [requireRole(), requireRecentMfa],
        config: { audit: 'user.update' },
        schema: {
          tags: ['auth'],
          body: z.object({ email: z.email().max(254).nullable() }),
          response: {
            200: z.object({
              emailConfirmed: z.boolean(),
              linkSent: z.boolean().describe('A confirmation link was emailed'),
            }),
          },
        },
      },
      async (req) => {
        const a = authOf(req);
        const email = req.body.email?.trim() || null;
        const address = email?.toLowerCase() ?? null;
        const r = await deps.sql.begin(async (tx) => {
          const [u] = await tx<{ login: string; email: string | null; confirmed: boolean }[]>`
            select login, email, email_verified_at is not null as confirmed
            from users where id = ${a.userId} for update`;
          if (!u) throw forbidden();
          // The same address (perhaps in other letter case) stays as it was.
          if ((u.email?.toLowerCase() ?? null) === address) {
            await tx`update users set email = ${email} where id = ${a.userId}`;
            return { login: u.login, confirmed: u.confirmed, changed: false };
          }
          await tx`update users set email = ${email}, email_verified_at = null where id = ${a.userId}`;
          // Links sent earlier were for the old address.
          await tx`update email_tokens set used_at = now()
            where user_id = ${a.userId} and kind = 'email' and used_at is null`;
          // Their own confirmed sign-in address needs no new proof.
          const [own] = address
            ? await tx`select 1 from user_passwords
                where user_id = ${a.userId} and email = ${address} and verified_at is not null`
            : [];
          const confirmed =
            address !== null &&
            own !== undefined &&
            (await confirmAccountEmail(tx, a.userId, address)) === 'confirmed';
          return { login: u.login, confirmed, changed: true };
        });
        req.auditTarget = { type: 'user', id: a.userId };
        let linkSent = false;
        if (email && r.changed && !r.confirmed) {
          const sent = await sendEmailConfirmation(
            deps,
            { id: a.userId, login: r.login },
            email,
          ).catch((err) => {
            req.log.warn({ err }, 'email confirmation not sent');
            return 'failed' as const;
          });
          linkSent = sent === 'sent';
        }
        return { emailConfirmed: r.confirmed, linkSent };
      },
    );

    // Another link for an unconfirmed account email.
    app.post(
      '/api/v1/me/email/confirmation',
      {
        preHandler: requireRole(),
        // The real limits are in sendEmailConfirmation (per address, per day).
        config: { rateLimit: { limit: 10, windowMs: 60_000 } },
        schema: { tags: ['auth'], response: { 202: z.object({ ok: z.literal(true) }) } },
      },
      async (req, reply) => {
        const a = authOf(req);
        const [u] = await deps.sql<{ login: string; email: string | null; confirmed: boolean }[]>`
          select login, email, email_verified_at is not null as confirmed
          from users where id = ${a.userId}`;
        if (!u?.email) throw badRequest('no_email', 'Add an email first.');
        if (u.confirmed) throw conflict('already_confirmed', 'This email is already confirmed.');
        const sent = await sendEmailConfirmation(
          deps,
          { id: a.userId, login: u.login },
          u.email,
        ).catch((err) => {
          req.log.warn({ err }, 'email confirmation not sent');
          throw unavailable('email_failed', 'Could not send the email just now. Try again later.');
        });
        if (sent === 'wait')
          throw new AppError(
            429,
            'just_sent',
            'We sent a link a moment ago. Check your inbox (and spam), or try again in a minute.',
            { headers: { 'retry-after': '60' } },
          );
        if (sent === 'limited')
          throw new AppError(
            429,
            'too_many_links',
            `That's ${CONFIRM_LINKS_PER_DAY} links today. Use the latest one, or try again tomorrow.`,
          );
        return reply.code(202).send({ ok: true as const });
      },
    );

    // Deletes the account and every org it alone owns (projects, sites, env vars,
    // tokens, history). Sessions only, never an API token, and the login typed
    // back as confirmation. Stored files are removed by the storage sweep.
    app.delete(
      '/api/v1/me',
      {
        preHandler: [requireRole(), requireRecentMfa],
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
        clearSessionCookie(deps, reply);
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
