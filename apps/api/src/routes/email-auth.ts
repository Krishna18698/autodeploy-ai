import { randomBytes } from 'node:crypto';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  randomToken,
  sha256Hex,
  verifyPassword,
} from '@autodeploy/crypto';
import type { Tx } from '@autodeploy/db';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError, badRequest, forbidden } from '../lib/errors.js';
import { ensurePersonalOrg, startSession } from './auth.js';

// Email + password accounts: sign up → confirm the address from an emailed
// link → sign in; forgotten passwords are reset from an emailed link.
// Answers never reveal whether an address has an account: sign-up and
// "forgot password" always say "check your email", and a wrong address takes
// as long to refuse as a wrong password.

const VERIFY_TTL = '24 hours';
const RESET_TTL = '1 hour';
// Wrong passwords per address before password sign-in pauses for it, from any
// IP (the per-IP limit alone lets a botnet guess one account). "Forgot
// password" still works during a pause, so an attacker can't lock the owner out.
const FAILS_ALLOWED = 10;
const FAIL_WINDOW_S = 15 * 60;

const Email = z
  .email()
  .max(254)
  .transform((e) => e.trim().toLowerCase());
const Password = z.string().min(10, 'Use at least 10 characters.').max(200);
const Credentials = z.object({ email: Email, password: Password });
const TokenBody = z.object({ token: z.string().min(20).max(100) });

/** "krishna_3fa9c1": never a valid GitHub login, so never matched to a GitHub account. */
function loginFor(email: string) {
  const local = email.split('@')[0] ?? '';
  const base =
    local
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'user';
  return `${base}_${randomBytes(3).toString('hex')}`;
}

/** A one-time link token; issuing one retires the user's earlier links of that kind. */
async function issueToken(tx: Tx, userId: string, kind: 'verify' | 'reset', ttl: string) {
  const token = randomToken(32);
  await tx`update email_tokens set used_at = now()
    where user_id = ${userId} and kind = ${kind} and used_at is null`;
  await tx`insert into email_tokens (token_hash, user_id, kind, expires_at)
    values (${sha256Hex(token)}, ${userId}, ${kind}, now() + ${ttl}::interval)`;
  return token;
}

/** Marks a valid, unused link as used and returns its user. */
async function useToken(tx: Tx, token: string, kind: 'verify' | 'reset') {
  const [row] = await tx<{ user_id: string }[]>`
    update email_tokens set used_at = now()
    where token_hash = ${sha256Hex(token)} and kind = ${kind}
      and used_at is null and expires_at > now()
    returning user_id`;
  if (!row) throw badRequest('link_invalid', 'This link has expired or was already used.');
  return row.user_id;
}

async function orgOf(tx: Tx, userId: string) {
  const [m] = await tx<
    { org_id: string }[]
  >`select org_id from memberships where user_id = ${userId} order by created_at limit 1`;
  return m?.org_id ?? null;
}

export const emailAuthRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const app_ = deps.env.APP_URL;
    // Before sign-in there is no session, so no CSRF token: the Origin check
    // stands in for it (browsers always send Origin on a fetch POST).
    const fromApp = async (req: FastifyRequest) => {
      const origin = req.headers.origin;
      if (origin && origin !== app_ && origin !== deps.env.API_PUBLIC_URL)
        throw forbidden('Cross-origin request rejected');
    };
    const limited = (limit: number) => ({
      csrf: false as const,
      rateLimit: { limit, windowMs: 60_000, key: 'ip' as const },
    });
    const accepted = { ok: true as const };
    const Accepted = z.object({ ok: z.literal(true) });
    const SignedIn = z.object({ ok: z.literal(true), csrfToken: z.string() });

    // At most one account email per address a minute, so nobody can flood a
    // stranger's inbox by signing up with their address. A throttled request
    // changes nothing: the link sent a moment ago still works.
    const mayEmail = async (to: string) =>
      (await deps.valkey.set(`account-mail:${sha256Hex(to)}`, '1', 'EX', 60, 'NX')) === 'OK';

    const sendVerify = async (to: string, token: string) =>
      deps.sendEmail({
        to,
        subject: 'Confirm your email for AutoDeploy',
        text: `Open this link to confirm ${to} and finish creating your AutoDeploy account:\n\n${app_}/verify-email?token=${token}\n\nThe link works for 24 hours. If you didn't sign up, ignore this email.`,
      });

    app.post(
      '/auth/email/signup',
      {
        config: limited(5),
        preHandler: fromApp,
        schema: { hide: true, body: Credentials, response: { 202: Accepted } },
      },
      async (req, reply) => {
        if (deps.env.ALLOWED_GITHUB_LOGINS.length > 0)
          throw forbidden('Sign-ups are not open yet.');
        const { email, password } = req.body;
        if (!(await mayEmail(email))) return reply.code(202).send(accepted);
        const hash = await hashPassword(password);
        const outcome = await deps.sql
          .begin(async (tx) => {
            const [existing] = await tx<{ user_id: string; verified_at: Date | null }[]>`
            select user_id, verified_at from user_passwords where email = ${email} for update`;
            if (existing?.verified_at) return { kind: 'exists' as const };
            if (existing) {
              // Signed up before but never confirmed: the latest password counts.
              await tx`update user_passwords set hash = ${hash}, updated_at = now() where user_id = ${existing.user_id}`;
              return {
                kind: 'verify' as const,
                token: await issueToken(tx, existing.user_id, 'verify', VERIFY_TTL),
              };
            }
            let userId: string | undefined;
            for (let i = 0; i < 5 && !userId; i++) {
              const login = loginFor(email);
              [{ id: userId } = { id: undefined }] = await tx<{ id: string }[]>`
              insert into users (login, email) values (${login}, ${email})
              on conflict (login) do nothing returning id`;
              if (userId) await ensurePersonalOrg(tx, userId, login, null);
            }
            if (!userId) throw new Error('could not pick a login');
            await tx`insert into user_passwords (user_id, email, hash) values (${userId}, ${email}, ${hash})`;
            return {
              kind: 'verify' as const,
              token: await issueToken(tx, userId, 'verify', VERIFY_TTL),
            };
          })
          .catch((err: { code?: string }) => {
            // The same address signed up twice at once: the other request won.
            if (err.code === '23505') return { kind: 'raced' as const };
            throw err;
          });
        if (outcome.kind === 'raced') return reply.code(202).send(accepted);
        if (outcome.kind === 'verify') await sendVerify(email, outcome.token);
        else
          await deps.sendEmail({
            to: email,
            subject: 'You already have an AutoDeploy account',
            text: `Someone tried to sign up with ${email}, which already has an account.\n\nSign in: ${app_}/login\nForgot your password? ${app_}/forgot-password\n\nIf this wasn't you, you can ignore this email.`,
          });
        return reply.code(202).send(accepted);
      },
    );

    app.post(
      '/auth/email/verify',
      {
        config: limited(20),
        preHandler: fromApp,
        schema: { hide: true, body: TokenBody, response: { 200: SignedIn } },
      },
      async (req, reply) => {
        const { userId, orgId } = await deps.sql.begin(async (tx) => {
          const userId = await useToken(tx, req.body.token, 'verify');
          await tx`update user_passwords set verified_at = coalesce(verified_at, now()) where user_id = ${userId}`;
          return { userId, orgId: await orgOf(tx, userId) };
        });
        if (!orgId) throw forbidden('This account has no organisation.');
        const csrfToken = await startSession(deps, req, reply, userId, orgId);
        return { ok: true as const, csrfToken };
      },
    );

    app.post(
      '/auth/email/login',
      {
        config: limited(10),
        preHandler: fromApp,
        schema: {
          hide: true,
          body: z.object({ email: Email, password: z.string().max(200) }),
          response: { 200: SignedIn },
        },
      },
      async (req, reply) => {
        const { email, password } = req.body;
        // Checked before the (deliberately slow) password hash, and for every
        // address alike, so it says nothing about which ones have accounts.
        const failKey = `login-fails:${sha256Hex(email)}`;
        const fails = Number((await deps.valkey.get(failKey)) ?? 0);
        if (fails >= FAILS_ALLOWED) {
          const wait = Math.max(60, await deps.valkey.ttl(failKey));
          throw new AppError(
            429,
            'too_many_attempts',
            `Too many wrong passwords for this email. Try again in ${Math.ceil(wait / 60)} minutes, or reset your password.`,
            { headers: { 'retry-after': String(wait) } },
          );
        }
        const [row] = await deps.sql<{ user_id: string; hash: string; verified_at: Date | null }[]>`
          select user_id, hash, verified_at from user_passwords where email = ${email}`;
        const ok = await verifyPassword(password, row?.hash ?? DUMMY_PASSWORD_HASH);
        if (!row || !ok) {
          // The window starts at the first failure and isn't extended by later ones.
          const n = await deps.valkey.incr(failKey);
          if (n === 1) await deps.valkey.expire(failKey, FAIL_WINDOW_S);
          throw new AppError(401, 'bad_credentials', 'Wrong email or password.');
        }
        await deps.valkey.del(failKey);
        if (!row.verified_at) {
          if (await mayEmail(email)) {
            const token = await deps.sql.begin((tx) =>
              issueToken(tx, row.user_id, 'verify', VERIFY_TTL),
            );
            await sendVerify(email, token);
          }
          throw new AppError(
            403,
            'email_unverified',
            'Confirm your email first: open the link we emailed you (we just sent a fresh one).',
          );
        }
        const orgId = await deps.sql.begin((tx) => orgOf(tx, row.user_id));
        if (!orgId) throw forbidden('This account has no organisation.');
        const csrfToken = await startSession(deps, req, reply, row.user_id, orgId);
        return { ok: true as const, csrfToken };
      },
    );

    app.post(
      '/auth/email/forgot',
      {
        config: limited(5),
        preHandler: fromApp,
        schema: { hide: true, body: z.object({ email: Email }), response: { 202: Accepted } },
      },
      async (req, reply) => {
        const { email } = req.body;
        if (!(await mayEmail(email))) return reply.code(202).send(accepted);
        const token = await deps.sql.begin(async (tx) => {
          const [row] = await tx<
            { user_id: string }[]
          >`select user_id from user_passwords where email = ${email}`;
          return row ? issueToken(tx, row.user_id, 'reset', RESET_TTL) : null;
        });
        if (token)
          await deps.sendEmail({
            to: email,
            subject: 'Reset your AutoDeploy password',
            text: `Someone (hopefully you) asked to reset the password for ${email}. Open this link to choose a new one:\n\n${app_}/reset-password?token=${token}\n\nThe link works for 1 hour, once. If you didn't ask, ignore this email; your password stays the same.`,
          });
        return reply.code(202).send(accepted);
      },
    );

    app.post(
      '/auth/email/reset',
      {
        config: limited(10),
        preHandler: fromApp,
        schema: {
          hide: true,
          body: TokenBody.extend({ password: Password }),
          response: { 200: SignedIn },
        },
      },
      async (req, reply) => {
        const hash = await hashPassword(req.body.password);
        const { userId, email, orgId } = await deps.sql.begin(async (tx) => {
          const userId = await useToken(tx, req.body.token, 'reset');
          // The link proved they own the address, so it counts as confirmed;
          // every other session ends (whoever knew the old password is out).
          const [pw] = await tx<{ email: string }[]>`
            update user_passwords set hash = ${hash}, updated_at = now(),
              verified_at = coalesce(verified_at, now()) where user_id = ${userId}
            returning email`;
          await tx`delete from sessions where user_id = ${userId}`;
          return { userId, email: pw?.email, orgId: await orgOf(tx, userId) };
        });
        // They proved they own the address: a pause from wrong guesses ends.
        if (email) await deps.valkey.del(`login-fails:${sha256Hex(email)}`);
        if (!orgId) throw forbidden('This account has no organisation.');
        const csrfToken = await startSession(deps, req, reply, userId, orgId);
        return { ok: true as const, csrfToken };
      },
    );
  };
