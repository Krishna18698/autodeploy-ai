import {
  decrypt,
  encrypt,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  sha256Hex,
  verifyTotp,
} from '@autodeploy/crypto';
import type { Sql } from '@autodeploy/db';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { renderSVG } from 'uqr';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { AppError, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { authOf, requireRecentMfa, requireRole } from '../plugins/auth.js';

// Two-step sign-in with an authenticator app. Set up (a QR code drawn here, so
// the secret never goes to another service), confirm with a first code (that
// also hands out ten one-time recovery codes), then every sign-in waits for a
// code, and dangerous actions ask again after 10 minutes.

const Code = z.object({
  code: z.string().trim().min(6).max(20).describe('Six digits from the app, or a recovery code'),
});
const RecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) });
const context = (userId: string) => `totp:${userId}`;

export const twoFactorRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // Six digits are a million guesses: ten wrong codes in 15 minutes pause an account's codes.
    async function guardGuesses(userId: string) {
      const n = Number((await deps.valkey.get(`mfa-fails:${userId}`)) ?? 0);
      if (n >= 10)
        throw new AppError(429, 'too_many_codes', 'Too many wrong codes. Try again in 15 minutes.');
    }
    async function wrongCode(userId: string): Promise<never> {
      const key = `mfa-fails:${userId}`;
      await deps.valkey
        .multi()
        .incr(key)
        .expire(key, 15 * 60)
        .exec();
      throw new AppError(
        400,
        'invalid_code',
        'That code didn’t work. Check the app and try again.',
      );
    }

    async function secretOf(sql: Sql, userId: string) {
      const [row] = await sql<
        {
          secret_ciphertext: Buffer;
          secret_dek: Buffer;
          key_version: number;
          confirmed_at: Date | null;
          last_step: string;
        }[]
      >`select secret_ciphertext, secret_dek, key_version, confirmed_at, last_step from user_totp where user_id = ${userId}`;
      if (!row) return null;
      const secret = decrypt(
        deps.keyring,
        {
          ciphertext: row.secret_ciphertext,
          dekCiphertext: row.secret_dek,
          keyVersion: row.key_version,
        },
        context(userId),
      );
      return { secret, confirmed: row.confirmed_at !== null, lastStep: Number(row.last_step) };
    }

    /** True if `code` is a valid authenticator code (each step once) or an unused recovery code. */
    async function useCode(userId: string, code: string, opts: { recovery: boolean }) {
      await guardGuesses(userId);
      const t = await secretOf(deps.sql, userId);
      if (!t?.confirmed)
        throw conflict('not_enabled', 'Two-step sign-in is not on for this account.');
      const step = verifyTotp(t.secret, code, { lastStep: t.lastStep });
      if (step !== null) {
        const moved = await deps.sql`
          update user_totp set last_step = ${step} where user_id = ${userId} and last_step < ${step} returning 1`;
        if (moved.length) return;
      }
      if (opts.recovery) {
        const used = await deps.sql`
          update user_recovery_codes set used_at = now()
          where user_id = ${userId} and used_at is null
            and code_hash = ${sha256Hex(normalizeRecoveryCode(code))}
          returning 1`;
        if (used.length) return;
      }
      await wrongCode(userId);
    }

    async function freshRecoveryCodes(userId: string) {
      const codes = newRecoveryCodes();
      await deps.sql.begin(async (tx) => {
        await tx`delete from user_recovery_codes where user_id = ${userId}`;
        for (const c of codes)
          await tx`insert into user_recovery_codes (user_id, code_hash) values (${userId}, ${sha256Hex(normalizeRecoveryCode(c))})`;
      });
      return codes;
    }

    const sessionOnly = (req: { auth: { via: string } | null }) => {
      if (req.auth?.via !== 'session')
        throw forbidden('Sign in to manage two-step sign-in; API tokens cannot.');
    };
    const markVerified = (hash: string) =>
      deps.sql`update sessions set mfa_pending = false, mfa_verified_at = now() where token_hash = ${hash}`;

    // The second step of signing in: the session waits here until a code arrives.
    app.post(
      '/auth/2fa/verify',
      {
        config: { csrf: false, rateLimit: { limit: 10, windowMs: 60_000, key: 'ip' } },
        schema: { hide: true, body: Code, response: { 200: z.object({ ok: z.literal(true) }) } },
      },
      async (req) => {
        const origin = req.headers.origin;
        if (origin && origin !== deps.env.APP_URL && origin !== deps.env.API_PUBLIC_URL)
          throw forbidden('Cross-origin request rejected');
        const p = req.pendingMfa;
        if (!p) throw unauthorized('Sign in first');
        await useCode(p.userId, req.body.code, { recovery: true });
        await markVerified(p.sessionHash);
        return { ok: true as const };
      },
    );

    app.get(
      '/api/v1/me/2fa',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['auth'],
          response: { 200: z.object({ enabled: z.boolean(), recoveryCodesLeft: z.number() }) },
        },
      },
      async (req) => {
        const a = authOf(req);
        const [r] = await deps.sql<{ enabled: boolean; left: number }[]>`
          select exists (select 1 from user_totp where user_id = ${a.userId} and confirmed_at is not null) as enabled,
                 (select count(*)::int from user_recovery_codes where user_id = ${a.userId} and used_at is null) as left`;
        return { enabled: r?.enabled ?? false, recoveryCodesLeft: r?.left ?? 0 };
      },
    );

    app.post(
      '/api/v1/me/2fa/setup',
      {
        preHandler: requireRole(),
        schema: {
          tags: ['auth'],
          response: {
            200: z.object({
              secret: z.string().describe('For typing into the app by hand'),
              otpauthUrl: z.string(),
              qrSvg: z.string().describe('The QR code to scan, as an SVG data URL'),
            }),
          },
        },
      },
      async (req) => {
        sessionOnly(req);
        const a = authOf(req);
        const existing = await secretOf(deps.sql, a.userId);
        if (existing?.confirmed)
          throw conflict('already_enabled', 'Two-step sign-in is already on. Turn it off first.');
        const secret = newTotpSecret();
        const e = encrypt(deps.keyring, secret, context(a.userId));
        await deps.sql`
          insert into user_totp (user_id, secret_ciphertext, secret_dek, key_version)
          values (${a.userId}, ${e.ciphertext}, ${e.dekCiphertext}, ${e.keyVersion})
          on conflict (user_id) do update set secret_ciphertext = excluded.secret_ciphertext,
            secret_dek = excluded.secret_dek, key_version = excluded.key_version, last_step = 0, created_at = now()`;
        const [u] = await deps.sql<
          { email: string | null }[]
        >`select email from users where id = ${a.userId}`;
        const url = otpauthUrl(secret, u?.email ?? a.login, 'AutoDeploy');
        const svg = renderSVG(url, { border: 2, whiteColor: '#ffffff', blackColor: '#000000' });
        return {
          secret,
          otpauthUrl: url,
          qrSvg: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
        };
      },
    );

    app.post(
      '/api/v1/me/2fa/enable',
      {
        preHandler: requireRole(),
        config: { rateLimit: { limit: 10, windowMs: 60_000 } },
        schema: { tags: ['auth'], body: Code, response: { 200: RecoveryCodes } },
      },
      async (req) => {
        sessionOnly(req);
        const a = authOf(req);
        await guardGuesses(a.userId);
        const t = await secretOf(deps.sql, a.userId);
        if (!t) throw conflict('not_set_up', 'Start the setup first.');
        if (t.confirmed) throw conflict('already_enabled', 'Two-step sign-in is already on.');
        const step = verifyTotp(t.secret, req.body.code);
        if (step === null) await wrongCode(a.userId);
        await deps.sql`update user_totp set confirmed_at = now(), last_step = ${step} where user_id = ${a.userId}`;
        if (a.sessionHash) await markVerified(a.sessionHash);
        // Other sessions signed in without a code: they sign in again, with one.
        await deps.sql`delete from sessions where user_id = ${a.userId} and token_hash <> ${a.sessionHash ?? ''}`;
        return { recoveryCodes: await freshRecoveryCodes(a.userId) };
      },
    );

    // Step-up: a code shown here covers dangerous actions for the next 10 minutes.
    app.post(
      '/api/v1/me/2fa/verify',
      {
        preHandler: requireRole(),
        config: { rateLimit: { limit: 10, windowMs: 60_000 } },
        schema: { tags: ['auth'], body: Code, response: { 204: z.null() } },
      },
      async (req, reply) => {
        sessionOnly(req);
        const a = authOf(req);
        await useCode(a.userId, req.body.code, { recovery: true });
        if (a.sessionHash) await markVerified(a.sessionHash);
        return reply.code(204).send(null);
      },
    );

    app.post(
      '/api/v1/me/2fa/recovery-codes',
      {
        preHandler: [requireRole(), requireRecentMfa],
        schema: { tags: ['auth'], response: { 200: RecoveryCodes } },
      },
      async (req) => {
        sessionOnly(req);
        const a = authOf(req);
        const t = await secretOf(deps.sql, a.userId);
        if (!t?.confirmed)
          throw conflict('not_enabled', 'Two-step sign-in is not on for this account.');
        return { recoveryCodes: await freshRecoveryCodes(a.userId) };
      },
    );

    app.delete(
      '/api/v1/me/2fa',
      {
        preHandler: requireRole(),
        config: { rateLimit: { limit: 10, windowMs: 60_000 } },
        schema: { tags: ['auth'], body: Code, response: { 204: z.null() } },
      },
      async (req, reply) => {
        sessionOnly(req);
        const a = authOf(req);
        await useCode(a.userId, req.body.code, { recovery: true });
        await deps.sql.begin(async (tx) => {
          await tx`delete from user_recovery_codes where user_id = ${a.userId}`;
          await tx`delete from user_totp where user_id = ${a.userId}`;
        });
        return reply.code(204).send(null);
      },
    );
  };
