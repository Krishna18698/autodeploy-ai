import { randomToken, sha256Hex } from '@autodeploy/crypto';
import type { Sql, Tx } from '@autodeploy/db';
import type { Deps } from '../deps.js';
import { badRequest } from './errors.js';

// Emailed one-time links, and the confirmed account email: the address a
// sign-in with Google (or a new GitHub account) is matched on. An address
// counts only once its owner proved they read it, and then for one account.

export type LinkKind = 'verify' | 'reset' | 'email';

/** A one-time link token; issuing one retires the user's earlier links of that kind. */
export async function issueToken(
  tx: Tx,
  userId: string,
  kind: LinkKind,
  ttl: string,
  email: string | null = null,
) {
  const token = randomToken(32);
  await tx`update email_tokens set used_at = now()
    where user_id = ${userId} and kind = ${kind} and used_at is null`;
  await tx`insert into email_tokens (token_hash, user_id, kind, expires_at, email)
    values (${sha256Hex(token)}, ${userId}, ${kind}, now() + ${ttl}::interval, ${email})`;
  return token;
}

/** Marks a valid, unused link as used and returns its user (and address, if it carries one). */
export async function useToken(tx: Tx, token: string, kind: LinkKind) {
  const [row] = await tx<{ user_id: string; email: string | null }[]>`
    update email_tokens set used_at = now()
    where token_hash = ${sha256Hex(token)} and kind = ${kind}
      and used_at is null and expires_at > now()
    returning user_id, email`;
  if (!row) throw badRequest('link_invalid', 'This link has expired or was already used.');
  return { userId: row.user_id, email: row.email };
}

/**
 * At most one account email per address a minute, so nobody can flood a
 * stranger's inbox. A throttled request changes nothing: the link sent a
 * moment ago still works.
 */
export const mayEmail = async (deps: Pick<Deps, 'valkey'>, to: string) =>
  (await deps.valkey.set(`account-mail:${sha256Hex(to)}`, '1', 'EX', 60, 'NX')) === 'OK';

/** The accounts that hold `email` (lower-cased) confirmed: a sign-in address or an account email. */
export async function confirmedOwners(sql: Sql | Tx, email: string): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select user_id as id from user_passwords where email = ${email} and verified_at is not null
    union
    select id from users where lower(email) = ${email} and email_verified_at is not null`;
  return rows.map((r) => r.id);
}

/**
 * The owner proved they read `email` (lower-cased): it becomes the account's
 * confirmed email if it still is the account email and no other account
 * holds it confirmed.
 */
export async function confirmAccountEmail(
  tx: Tx,
  userId: string,
  email: string,
): Promise<'confirmed' | 'taken' | 'changed'> {
  const done = await tx
    .savepoint(
      (sp) => sp`
      update users set email_verified_at = coalesce(email_verified_at, now())
      where id = ${userId} and lower(email) = ${email}
        and not exists (select 1 from user_passwords p
          where p.email = ${email} and p.verified_at is not null and p.user_id <> ${userId})
      returning id`,
    )
    .catch((err: { code?: string }) => {
      // Another account confirmed this address first (one address, one account).
      if (err.code === '23505') return null;
      throw err;
    });
  if (done?.length) return 'confirmed';
  const [u] = await tx<{ same: boolean }[]>`
    select coalesce(lower(email) = ${email}, false) as same from users where id = ${userId}`;
  return u?.same ? 'taken' : 'changed';
}

// Confirmation links per account a day: an account can't be used to mail
// strangers (or use up the day's email allowance) by changing its address.
export const CONFIRM_LINKS_PER_DAY = 5;

/** Emails a link that confirms the account email. */
export async function sendEmailConfirmation(
  deps: Pick<Deps, 'sql' | 'valkey' | 'sendEmail' | 'env'>,
  user: { id: string; login: string },
  to: string,
): Promise<'sent' | 'wait' | 'limited'> {
  const address = to.trim().toLowerCase();
  if (!(await mayEmail(deps, address))) return 'wait';
  const count = `email-confirm:${user.id}`;
  const n = await deps.valkey.incr(count);
  if (n === 1) await deps.valkey.expire(count, 24 * 3600);
  if (n > CONFIRM_LINKS_PER_DAY) return 'limited';
  const token = await deps.sql.begin((tx) => issueToken(tx, user.id, 'email', '24 hours', address));
  await deps.sendEmail({
    to,
    subject: 'Confirm your email for AutoDeploy',
    text: `Open this link to confirm ${to} as the email of your AutoDeploy account ${user.login}:\n\n${deps.env.APP_URL}/confirm-email?token=${token}\n\nOnce it's confirmed, you can also sign in with a Google account that uses this address. The link works for 24 hours. If you didn't ask for this, ignore this email.`,
  });
  return 'sent';
}
