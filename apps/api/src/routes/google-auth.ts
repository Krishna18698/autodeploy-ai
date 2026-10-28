import { createHash } from 'node:crypto';
import { randomToken, safeEqual } from '@autodeploy/crypto';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { googleConfigured } from '../env.js';
import { AppError, unavailable } from '../lib/errors.js';
import { JwtError, type KeyLookup, publishedKeys, verifyJwt } from '../lib/jwt.js';
import { authOf, requireRecentMfa, requireRole } from '../plugins/auth.js';
import { ensurePersonalOrg, startSession } from './auth.js';
import { loginFor } from './email-auth.js';

// Sign in with Google (OpenID Connect, authorization code flow with PKCE).
// Google's answer is an ID token we verify ourselves; we keep no Google tokens.
// Accounts are found by Google's permanent ID ("sub"); the first time, a
// confirmed email-and-password account with Google's *verified* address is
// linked; GitHub accounts never are (we never confirmed GitHub's address) and
// connect Google from Settings instead. While sign-ups are closed, Google
// can't create accounts. Two-step sign-in applies as to every sign-in.

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const googleSigningKeys = () => publishedKeys('https://www.googleapis.com/oauth2/v3/certs');

type GoogleClaims = {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  nonce?: string;
};

const cookieName = (env: { NODE_ENV: string }) =>
  env.NODE_ENV === 'production' ? '__Host-ad_google' : 'ad_google';

export const googleAuthRoutes =
  (deps: Deps, key: KeyLookup = googleSigningKeys()): FastifyPluginAsyncZod =>
  async (app) => {
    const strict = { rateLimit: { limit: 20, windowMs: 60_000, key: 'ip' as const } };
    const redirectUri = () => `${deps.env.API_PUBLIC_URL}/auth/google/callback`;
    const cookie = {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure: deps.env.NODE_ENV === 'production',
    };

    /**
     * To Google. Three one-time values ride in a 10-minute host-only cookie:
     * state (the answer is for a sign-in this browser started), nonce (written
     * into Google's signed answer, so an old one can't be replayed) and the
     * PKCE verifier (a captured code is useless without it).
     */
    function begin(reply: FastifyReply, mode: 'signin' | 'connect', userId = '') {
      if (!googleConfigured(deps.env))
        throw unavailable(
          'google_not_configured',
          'Google sign-in is not configured on this server yet.',
        );
      const state = randomToken(18);
      const nonce = randomToken(18);
      const verifier = randomToken(48);
      reply.setCookie(cookieName(deps.env), [state, nonce, verifier, mode, userId].join('.'), {
        ...cookie,
        maxAge: 600,
      });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', deps.env.GOOGLE_CLIENT_ID ?? '');
      url.searchParams.set('redirect_uri', redirectUri());
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'openid email profile');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('prompt', 'select_account');
      return reply.redirect(url.toString());
    }

    /** A new account for a verified Google address (sign-ups open). */
    async function createAccount(email: string, c: GoogleClaims): Promise<string> {
      return deps.sql.begin(async (tx) => {
        for (let i = 0; i < 5; i++) {
          const login = loginFor(email);
          const [u] = await tx<{ id: string }[]>`
            insert into users (login, name, email, avatar_url, google_sub)
            values (${login}, ${c.name ?? null}, ${email}, ${c.picture ?? null}, ${c.sub})
            on conflict (login) do nothing returning id`;
          if (u) {
            await ensurePersonalOrg(tx, u.id, login, c.name ?? null);
            return u.id;
          }
        }
        throw new Error('could not pick a login');
      });
    }

    // Which sign-in methods this server offers (the sign-in page asks).
    app.get('/auth/providers', { schema: { hide: true } }, async () => ({
      google: googleConfigured(deps.env),
    }));

    app.get('/auth/google/login', { config: strict, schema: { hide: true } }, async (_req, reply) =>
      begin(reply, 'signin'),
    );

    // A signed-in person links their Google account (any account kind).
    app.get(
      '/auth/google/connect',
      { config: strict, schema: { hide: true } },
      async (req, reply) => {
        const a = req.auth;
        if (a?.via !== 'session') return reply.redirect(`${deps.env.APP_URL}/login`);
        return begin(reply, 'connect', a.userId);
      },
    );

    app.get(
      '/auth/google/callback',
      {
        config: strict,
        schema: {
          hide: true,
          // Google sends `error` instead of `code` when the person cancels.
          querystring: z.object({
            code: z.string().optional(),
            state: z.string().optional(),
            error: z.string().optional(),
          }),
        },
      },
      async (req, reply) => {
        // Failures go back with a code the page turns into a fixed message.
        type Why =
          | 'expired'
          | 'cancelled'
          | 'google'
          | 'closed'
          | 'relogin'
          | 'google_unverified'
          | 'google_unconfirmed'
          | 'google_other';
        const toLogin = (why: Why) => reply.redirect(`${deps.env.APP_URL}/login?error=${why}`);
        const toSettings = (google?: 'connected' | 'taken') =>
          reply.redirect(
            `${deps.env.APP_URL}/settings?tab=account${google ? `&google=${google}` : ''}`,
          );
        const [state, nonce, verifier, mode, cookieUser] = (
          req.cookies[cookieName(deps.env)] ?? ''
        ).split('.');
        reply.clearCookie(cookieName(deps.env), cookie);
        if (!state || !req.query.state || !safeEqual(state, req.query.state))
          return toLogin(req.query.error ? 'cancelled' : 'expired');
        if (req.query.error || !req.query.code)
          return mode === 'connect' ? toSettings() : toLogin('cancelled');

        let c: GoogleClaims;
        try {
          // Server to server, with the client secret and the PKCE verifier.
          const r = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code: req.query.code,
              client_id: deps.env.GOOGLE_CLIENT_ID ?? '',
              client_secret: deps.env.GOOGLE_CLIENT_SECRET ?? '',
              redirect_uri: redirectUri(),
              grant_type: 'authorization_code',
              code_verifier: verifier ?? '',
            }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!r.ok) throw new Error(`Google token endpoint: ${r.status}`);
          const { id_token } = (await r.json()) as { id_token?: string };
          if (!id_token) throw new Error('Google sent no ID token');
          c = (await verifyJwt(id_token, {
            issuers: GOOGLE_ISSUERS,
            audience: deps.env.GOOGLE_CLIENT_ID ?? '',
            key,
          })) as unknown as GoogleClaims;
          if (typeof c.sub !== 'string' || !c.sub) throw new JwtError('no sub');
          if (!nonce || c.nonce !== nonce) throw new JwtError('nonce does not match');
        } catch (err) {
          req.log.warn({ err }, 'Google sign-in failed');
          return toLogin('google');
        }
        const email = typeof c.email === 'string' ? c.email.toLowerCase() : null;
        const verified = c.email_verified === true || c.email_verified === 'true';

        if (mode === 'connect') {
          // Still the same signed-in person who started it.
          const a = req.auth;
          if (a?.via !== 'session' || a.userId !== cookieUser) return toLogin('relogin');
          const linked = await deps.sql`
            update users set google_sub = ${c.sub}, avatar_url = coalesce(avatar_url, ${c.picture ?? null})
            where id = ${a.userId} and google_sub is null
              and not exists (select 1 from users where google_sub = ${c.sub})
            returning id`.catch((err: { code?: string }) => {
            if (err.code === '23505') return [];
            throw err;
          });
          // One Google account, one AutoDeploy account.
          return toSettings(linked.length ? 'connected' : 'taken');
        }

        let userId: string;
        const [known] = await deps.sql<
          { id: string }[]
        >`select id from users where google_sub = ${c.sub}`;
        if (known) userId = known.id;
        else {
          if (!email || !verified) return toLogin('google_unverified');
          const [pw] = await deps.sql<{ user_id: string; verified_at: Date | null }[]>`
            select user_id, verified_at from user_passwords where email = ${email}`;
          // Someone signed up with this address but never confirmed it: not linked.
          if (pw && !pw.verified_at) return toLogin('google_unconfirmed');
          if (pw) {
            const linked = await deps.sql`
              update users set google_sub = ${c.sub} where id = ${pw.user_id} and google_sub is null
              returning id`.catch((err: { code?: string }) => {
              if (err.code === '23505') return [];
              throw err;
            });
            // That account is linked to another Google account already.
            if (!linked.length) return toLogin('google_other');
            userId = pw.user_id;
          } else {
            if (deps.env.ALLOWED_GITHUB_LOGINS.length > 0) return toLogin('closed');
            userId = await createAccount(email, c);
          }
        }
        const [u] = await deps.sql<{ login: string; name: string | null }[]>`
          select login, name from users where id = ${userId}`;
        const orgId = await deps.sql.begin((tx) =>
          ensurePersonalOrg(tx, userId, u?.login ?? 'user', u?.name ?? null),
        );
        const { twoFactor } = await startSession(deps, req, reply, userId, orgId);
        return reply.redirect(`${deps.env.APP_URL}${twoFactor ? '/login/2fa' : '/overview'}`);
      },
    );

    // Unlink Google, unless it's the only way this person can sign in.
    app.delete(
      '/api/v1/me/google',
      {
        preHandler: [requireRole(), requireRecentMfa],
        config: { audit: 'user.google_disconnect' },
        schema: { tags: ['auth'], response: { 204: z.null() } },
      },
      async (req, reply) => {
        const a = authOf(req);
        const [u] = await deps.sql<
          { google_sub: string | null; github_id: string | null; password: boolean }[]
        >`
          select google_sub, github_id,
            exists (select 1 from user_passwords p where p.user_id = u.id and p.verified_at is not null) as password
          from users u where id = ${a.userId}`;
        if (u?.google_sub) {
          if (u.github_id === null && !u.password)
            throw new AppError(
              409,
              'last_sign_in',
              'Google is the only way you sign in. Connect GitHub first, so you can still get in.',
            );
          await deps.sql`update users set google_sub = null where id = ${a.userId}`;
        }
        return reply.code(204).send(null);
      },
    );
  };
