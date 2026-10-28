import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildApp } from '@autodeploy/api/app';
import { createDeps, type Deps } from '@autodeploy/api/deps';
import { loadEnv } from '@autodeploy/api/env';
import { ensurePersonalOrg } from '@autodeploy/api/routes/auth';
import { encrypt, hashPassword, sha256Hex } from '@autodeploy/crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

// Sign in with Google against a stand-in Google: our own signing key, and its
// token endpoint answered here (fetch is wrapped for oauth2.googleapis.com).
// GitHub's code exchange and /user are stood in for the same way, and emails
// are kept here instead of sent.

const CLIENT = 'test-client.apps.googleusercontent.com';
const APP = 'https://app.autodeploy.test';
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...google.publicKey.export({ format: 'jwk' }), kid: 'g-1' };
let app: FastifyInstance;
let deps: Deps;

// What the stand-in Google answers next, and what it was sent.
let answer: Record<string, unknown> = {};
let signer = google;
let tokenStatus = 200;
let lastTokenRequest = new URLSearchParams();
const realFetch = globalThis.fetch;
// What the stand-in GitHub says the person is.
let ghUser: { id: number; login: string; email: string | null } = { id: 0, login: '', email: null };
const mails: { to: string; subject: string; text: string }[] = [];

beforeAll(async () => {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PLATFORM_DOMAIN: 'autodeploy.test',
    API_PUBLIC_URL: 'https://api.autodeploy.test',
    APP_URL: APP,
    DATABASE_URL: inject('databaseUrl'),
    VALKEY_URL: inject('valkeyUrl'),
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY_ID: 'x',
    S3_SECRET_ACCESS_KEY: 'x',
    ENCRYPTION_KEYS: `1:${randomBytes(32).toString('base64')}`,
    INTERNAL_TOKEN: 'internal-token-for-tests-123456',
    DEV_LOGIN: 'true',
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: 'GOCSPX-test-secret',
    WORK_DIR: resolve('.dev/test-work'),
  });
  deps = createDeps(env);
  deps.sendEmail = async (m) => {
    mails.push(m);
  };
  app = await buildApp(deps, { googleKeys: async (kid) => (kid === 'g-1' ? jwk : null) });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token'))
      return Response.json({ access_token: 'gh-user-token' });
    if (url === 'https://api.github.com/user')
      return Response.json({ ...ghUser, name: null, avatar_url: null });
    if (!url.startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init);
    lastTokenRequest = new URLSearchParams(String(init?.body ?? ''));
    if (tokenStatus !== 200)
      return new Response('{"error":"invalid_grant"}', { status: tokenStatus });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64({ alg: 'RS256', kid: 'g-1' });
    const body = b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT,
      iat: now,
      exp: now + 3600,
      ...answer,
    });
    const sig = createSign('RSA-SHA256')
      .update(`${head}.${body}`)
      .sign(signer.privateKey)
      .toString('base64url');
    return new Response(
      JSON.stringify({ id_token: `${head}.${body}.${sig}`, access_token: 'unused' }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await deps.close();
});

let addr = 0;
const from = () => `198.18.4.${(addr++ % 250) + 1}`; // their own addresses: the 20-a-minute limit is per address
const cookieOf = (setCookie: unknown, name: string) =>
  ([] as string[])
    .concat((setCookie as string | string[]) ?? [])
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];

/** Starts at our API, "visits Google", and comes back with the answer set up. */
async function viaGoogle(
  claims: Record<string, unknown>,
  o: {
    start?: 'login' | 'connect';
    session?: string;
    state?: string;
    error?: string;
    nonce?: string;
  } = {},
) {
  const start = await app.inject({
    url: `/auth/google/${o.start ?? 'login'}`,
    remoteAddress: from(),
    headers: o.session ? { cookie: o.session } : {},
  });
  const to = new URL(String(start.headers.location));
  const flow = cookieOf(start.headers['set-cookie'], 'ad_google');
  const [, nonce, verifier] = (flow ?? '').split('=')[1]?.split('.') ?? [];
  answer = { nonce: o.nonce ?? nonce, ...claims };
  const back = await app.inject({
    url: `/auth/google/callback?${o.error ? `error=${o.error}` : 'code=one-time-code'}&state=${o.state ?? to.searchParams.get('state')}`,
    remoteAddress: from(),
    headers: { cookie: [flow, o.session].filter(Boolean).join('; ') },
  });
  return {
    start,
    to,
    verifier,
    back,
    location: String(back.headers.location),
    session: cookieOf(back.headers['set-cookie'], 'ad_session'),
  };
}
const sub = () => `google-${randomUUID()}`;
const userBySub = async (s: string) =>
  (
    await deps.sql<
      { id: string; email: string; login: string }[]
    >`select id, email, login from users where google_sub = ${s}`
  )[0];
async function devUser() {
  const login = `dev-${randomUUID().slice(0, 8)}`;
  const r = await app.inject({
    method: 'POST',
    url: '/auth/dev-login',
    payload: { login },
    remoteAddress: from(),
  });
  const [{ id } = { id: '' }] = await deps.sql<
    { id: string }[]
  >`select id from users where login = ${login}`;
  return {
    id,
    session: cookieOf(r.headers['set-cookie'], 'ad_session') ?? '',
    csrf: r.json().csrfToken as string,
  };
}

describe('sign in with Google', () => {
  it('goes to Google with state, nonce and a PKCE challenge, and proves the verifier when trading the code', async () => {
    const s = sub();
    const tag = randomUUID().slice(0, 6);
    const r = await viaGoogle({
      sub: s,
      email: `New.Person.${tag}@Example.com`,
      email_verified: true,
      name: 'New Person',
    });
    expect(`${r.to.origin}${r.to.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(r.to.searchParams.get('client_id')).toBe(CLIENT);
    expect(r.to.searchParams.get('redirect_uri')).toBe(
      'https://api.autodeploy.test/auth/google/callback',
    );
    expect(r.to.searchParams.get('scope')).toBe('openid email profile');
    expect(r.to.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.to.searchParams.get('code_challenge')).toBe(
      createHash('sha256')
        .update(r.verifier ?? '')
        .digest('base64url'),
    );
    expect(lastTokenRequest.get('code_verifier')).toBe(r.verifier);
    expect(lastTokenRequest.get('client_secret')).toBe('GOCSPX-test-secret');
    // A new account: signed in, its address lowercased, Google's ID kept.
    expect(r.location).toBe(`${APP}/overview`);
    expect(r.session).toBeTruthy();
    const u = await userBySub(s);
    expect(u?.email).toBe(`new.person.${tag}@example.com`);
    expect(u?.login).toMatch(new RegExp(`^new-person-${tag}_[0-9a-f]{6}$`));
    // Again: the same account.
    await viaGoogle({ sub: s, email: `new.person.${tag}@example.com`, email_verified: true });
    expect(await deps.sql`select 1 from users where google_sub = ${s}`).toHaveLength(1);
    const email = `new.person.${tag}@example.com`;
    expect(await deps.sql`select 1 from users where email = ${email}`).toHaveLength(1);
  });

  it('creates no account while sign-ups are closed', async () => {
    const allowed = deps.env.ALLOWED_GITHUB_LOGINS;
    (deps.env as { ALLOWED_GITHUB_LOGINS: string[] }).ALLOWED_GITHUB_LOGINS = ['someone'];
    try {
      const s = sub();
      const r = await viaGoogle({ sub: s, email: `closed-${s}@example.com`, email_verified: true });
      expect(r.location).toBe(`${APP}/login?error=closed`);
      expect(await userBySub(s)).toBeUndefined();
    } finally {
      (deps.env as { ALLOWED_GITHUB_LOGINS: string[] }).ALLOWED_GITHUB_LOGINS = allowed;
    }
  });

  it("links a confirmed email account to Google's verified address, and no other", async () => {
    const email = `owner-${randomUUID().slice(0, 6)}@example.com`;
    const [u] = await deps.sql<
      { id: string }[]
    >`insert into users (login, email) values (${`owner_${randomUUID().slice(0, 6)}`}, ${email}) returning id`;
    await deps.sql`insert into user_passwords (user_id, email, hash, verified_at) values (${u!.id}, ${email}, ${await hashPassword('a password 1')}, now())`;
    const s = sub();
    const r = await viaGoogle({ sub: s, email: email.toUpperCase(), email_verified: true });
    expect(r.location).toBe(`${APP}/overview`);
    expect((await userBySub(s))?.id).toBe(u!.id);
  });

  it.each([
    ['never confirmed with us', { confirmed: false, googleVerified: true }, 'google_unconfirmed'],
    [
      'that Google has not verified',
      { confirmed: true, googleVerified: false },
      'google_unverified',
    ],
  ])('does not link an address %s', async (_why, o, error) => {
    const email = `link-${randomUUID().slice(0, 6)}@example.com`;
    const [u] = await deps.sql<
      { id: string }[]
    >`insert into users (login, email) values (${`l_${randomUUID().slice(0, 6)}`}, ${email}) returning id`;
    await deps.sql`insert into user_passwords (user_id, email, hash, verified_at)
      values (${u!.id}, ${email}, ${await hashPassword('a password 1')}, ${o.confirmed ? new Date() : null})`;
    const s = sub();
    const r = await viaGoogle({ sub: s, email, email_verified: o.googleVerified });
    expect(r.location).toBe(`${APP}/login?error=${error}`);
    expect(await userBySub(s)).toBeUndefined();
  });

  it('matches no account on an email nobody confirmed (typed in, or GitHub’s public email)', async () => {
    const email = `gh-${randomUUID().slice(0, 6)}@example.com`;
    const [gh] = await deps.sql<{ id: string }[]>`
      insert into users (login, email, github_id) values (${`gh-${randomUUID().slice(0, 6)}`}, ${email}, ${Math.floor(Math.random() * 1e9)}) returning id`;
    const s = sub();
    await viaGoogle({ sub: s, email, email_verified: true });
    const created = await userBySub(s);
    expect(created).toBeDefined();
    expect(created?.id).not.toBe(gh!.id);
  });

  it.each([
    ['a forged state', { o: { state: 'forged' } }, 'expired'],
    ['a cancel at Google', { o: { error: 'access_denied' } }, 'cancelled'],
    ['a replayed answer (other nonce)', { o: { nonce: 'from-another-sign-in' } }, 'google'],
    [
      'an answer meant for another app',
      { claims: { aud: 'someone-else.apps.googleusercontent.com' } },
      'google',
    ],
    ['an answer from another issuer', { claims: { iss: 'https://evil.example' } }, 'google'],
    ['an answer not signed by Google', { signedBy: stranger }, 'google'],
    ['Google refusing the code', { status: 400 }, 'google'],
  ] as const)('refuses %s', async (_why, t, error) => {
    const s = sub();
    signer = 'signedBy' in t ? t.signedBy : google;
    tokenStatus = 'status' in t ? t.status : 200;
    try {
      const claims = {
        sub: s,
        email: `${s}@example.com`,
        email_verified: true,
        ...('claims' in t ? t.claims : {}),
      };
      const r = await viaGoogle(claims, 'o' in t ? t.o : {});
      expect(r.location).toBe(`${APP}/login?error=${error}`);
      expect(r.session).toBeUndefined();
      expect(await userBySub(s)).toBeUndefined();
    } finally {
      signer = google;
      tokenStatus = 200;
    }
  });

  it('still asks for the two-step code', async () => {
    const s = sub();
    await viaGoogle({ sub: s, email: `${s}@example.com`, email_verified: true });
    const u = await userBySub(s);
    const sealed = encrypt(deps.keyring, 'JBSWY3DPEHPK3PXP', `totp:${u!.id}`);
    await deps.sql`insert into user_totp (user_id, secret_ciphertext, secret_dek, key_version, confirmed_at)
      values (${u!.id}, ${sealed.ciphertext}, ${sealed.dekCiphertext}, ${sealed.keyVersion}, now())`;
    const r = await viaGoogle({ sub: s, email: `${s}@example.com`, email_verified: true });
    expect(r.location).toBe(`${APP}/login/2fa`);
  });
});

describe('connecting and disconnecting Google', () => {
  it('a signed-in person connects their Google account; one Google account, one AutoDeploy account', async () => {
    const me = await devUser();
    const s = sub();
    const r = await viaGoogle(
      { sub: s, email: `c-${s}@example.com` },
      { start: 'connect', session: me.session },
    );
    expect(r.location).toBe(`${APP}/settings?tab=account&google=connected`);
    expect((await userBySub(s))?.id).toBe(me.id);
    const meNow = await app.inject({ url: '/api/v1/me', headers: { cookie: me.session } });
    expect(meNow.json().user.googleConnected).toBe(true);

    const other = await devUser();
    const again = await viaGoogle(
      { sub: s, email: `c-${s}@example.com` },
      { start: 'connect', session: other.session },
    );
    expect(again.location).toBe(`${APP}/settings?tab=account&google=taken`);
    expect((await userBySub(s))?.id).toBe(me.id);
  });

  it('connecting needs a session; the callback must be the same person who started it', async () => {
    const nobody = await app.inject({ url: '/auth/google/connect', remoteAddress: from() });
    expect(nobody.headers.location).toBe(`${APP}/login`);
    const me = await devUser();
    const someoneElse = await devUser();
    const start = await app.inject({
      url: '/auth/google/connect',
      remoteAddress: from(),
      headers: { cookie: me.session },
    });
    const flow = cookieOf(start.headers['set-cookie'], 'ad_google');
    const state = new URL(String(start.headers.location)).searchParams.get('state');
    answer = { sub: sub(), nonce: flow?.split('=')[1]?.split('.')[1] };
    const back = await app.inject({
      url: `/auth/google/callback?code=c&state=${state}`,
      remoteAddress: from(),
      headers: { cookie: `${flow}; ${someoneElse.session}` },
    });
    expect(back.headers.location).toBe(`${APP}/login?error=relogin`);
  });

  it("disconnecting is refused when Google is the only way in, allowed when there's another", async () => {
    const s = sub();
    const only = await viaGoogle({ sub: s, email: `only-${s}@example.com`, email_verified: true });
    const csrf = (
      await app.inject({ url: '/api/v1/me', headers: { cookie: only.session ?? '' } })
    ).json().csrfToken;
    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me/google',
      headers: { cookie: only.session ?? '', 'x-csrf-token': csrf },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('last_sign_in');

    const me = await devUser();
    await deps.sql`update users set github_id = ${Math.floor(Math.random() * 1e9)} where id = ${me.id}`;
    const s2 = sub();
    await viaGoogle({ sub: s2 }, { start: 'connect', session: me.session });
    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me/google',
      headers: { cookie: me.session, 'x-csrf-token': me.csrf },
    });
    expect(ok.statusCode).toBe(204);
    expect(await userBySub(s2)).toBeUndefined();
  });

  it('the sign-in page can ask which methods this server offers', async () => {
    expect((await app.inject({ url: '/auth/providers' })).json()).toEqual({ google: true });
  });
});

// The account email counts for matching a sign-in only once it's confirmed.
const tag = () => randomUUID().slice(0, 8);
const ghId = () => Math.floor(Math.random() * 1e9);
const linkIn = (to: string, page: string) => {
  const m = mails.filter((x) => x.to === to).at(-1);
  return new RegExp(`/${page}\\?token=([\\w-]+)`).exec(m?.text ?? '')?.[1];
};
const asMe = (me: { session: string; csrf: string }) => ({
  cookie: me.session,
  'x-csrf-token': me.csrf,
});
const saveEmail = (me: { session: string; csrf: string }, email: string | null) =>
  app.inject({ method: 'PATCH', url: '/api/v1/me', headers: asMe(me), payload: { email } });
const confirm = (token: string | undefined) =>
  app.inject({
    method: 'POST',
    url: '/auth/email/confirm-address',
    remoteAddress: from(),
    payload: { token },
  });
const meOf = async (me: { session: string }) =>
  (await app.inject({ url: '/api/v1/me', headers: { cookie: me.session } })).json().user;
async function emailAccount(email: string, confirmed = true) {
  const login = `e_${tag()}`;
  const [u] = await deps.sql<{ id: string }[]>`
    insert into users (login, email) values (${login}, ${email}) returning id`;
  await deps.sql`insert into user_passwords (user_id, email, hash, verified_at)
    values (${u!.id}, ${email}, ${await hashPassword('a password 1')}, ${confirmed ? new Date() : null})`;
  await deps.sql.begin((tx) => ensurePersonalOrg(tx, u!.id, login, null));
  return u!.id;
}
/** GitHub sign-in, with the stand-in GitHub answering as `who`. */
async function viaGitHub(who: typeof ghUser) {
  ghUser = who;
  const r = await app.inject({
    url: '/auth/github/callback?code=c&state=s1',
    remoteAddress: from(),
    headers: { cookie: 'ad_oauth_state=s1' },
  });
  return String(r.headers.location);
}

describe('the confirmed account email', () => {
  it('a new email gets a link; once opened, Google finds the account (a GitHub account too)', async () => {
    const me = await devUser();
    await deps.sql`update users set github_id = ${ghId()} where id = ${me.id}`;
    const email = `confirm-${tag()}@example.com`;
    const saved = await saveEmail(me, email.toUpperCase());
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ emailConfirmed: false, linkSent: true });
    expect((await meOf(me)).emailConfirmed).toBe(false);

    const ok = await confirm(linkIn(email.toUpperCase(), 'confirm-email'));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe(email);
    expect((await meOf(me)).emailConfirmed).toBe(true);
    // A link works once.
    expect((await confirm(linkIn(email.toUpperCase(), 'confirm-email'))).statusCode).toBe(400);

    const s = sub();
    const r = await viaGoogle({ sub: s, email, email_verified: true });
    expect(r.location).toBe(`${APP}/overview`);
    expect((await userBySub(s))?.id).toBe(me.id);
  });

  it('a link stops counting once the email changes', async () => {
    const me = await devUser();
    const first = `first-${tag()}@example.com`;
    const second = `second-${tag()}@example.com`;
    await saveEmail(me, first);
    const old = linkIn(first, 'confirm-email');
    await saveEmail(me, second);
    expect((await confirm(old)).statusCode).toBe(400);
    expect((await meOf(me)).emailConfirmed).toBe(false);
    expect((await confirm(linkIn(second, 'confirm-email'))).statusCode).toBe(200);
    expect((await meOf(me)).emailConfirmed).toBe(true);
    // And a live link for an address the account no longer uses, however it changed.
    const third = `third-${tag()}@example.com`;
    await saveEmail(me, third);
    await deps.sql`update users set email = ${`fourth-${tag()}@example.com`} where id = ${me.id}`;
    const stale = await confirm(linkIn(third, 'confirm-email'));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('link_outdated');
    expect((await meOf(me)).emailConfirmed).toBe(false);
  });

  it('one address, one account: an address confirmed elsewhere is not confirmed again', async () => {
    const email = `taken-${tag()}@example.com`;
    const me = await devUser();
    await saveEmail(me, email);
    const link = linkIn(email, 'confirm-email');
    // Meanwhile someone signs up with Google on that address (Google verified it).
    await viaGoogle({ sub: sub(), email, email_verified: true });
    const r = await confirm(link);
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('email_taken');
    expect((await meOf(me)).emailConfirmed).toBe(false);
  });

  it('sends one link a minute per address and five a day per account', async () => {
    const me = await devUser();
    const email = `limit-${tag()}@example.com`;
    await saveEmail(me, email); // link 1
    const resend = () =>
      app.inject({ method: 'POST', url: '/api/v1/me/email/confirmation', headers: asMe(me) });
    const soon = await resend();
    expect(soon.statusCode).toBe(429);
    expect(soon.json().code).toBe('just_sent');
    for (let i = 2; i <= 5; i++) {
      await deps.valkey.del(`account-mail:${sha256Hex(email)}`); // a minute later
      expect((await resend()).statusCode).toBe(202);
    }
    await deps.valkey.del(`account-mail:${sha256Hex(email)}`);
    const sixth = await resend();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().code).toBe('too_many_links');
    expect(mails.filter((m) => m.to === email)).toHaveLength(5);
  });

  it('Google vouches: connecting a Google account with the same verified address confirms it', async () => {
    const me = await devUser();
    const email = `vouch-${tag()}@example.com`;
    await deps.sql`update users set email = ${email} where id = ${me.id}`;
    await viaGoogle(
      { sub: sub(), email, email_verified: true },
      { start: 'connect', session: me.session },
    );
    expect((await meOf(me)).emailConfirmed).toBe(true);
  });

  it('two accounts holding one address confirmed: Google links neither', async () => {
    const email = `both-${tag()}@example.com`;
    await emailAccount(email);
    await deps.sql`insert into users (login, email, email_verified_at, github_id)
      values (${`gh-${tag()}`}, ${email}, now(), ${ghId()})`;
    await deps.sql`update users set email = ${`other-${tag()}@example.com`}
      where id = (select user_id from user_passwords where email = ${email})`;
    const s = sub();
    const r = await viaGoogle({ sub: s, email, email_verified: true });
    expect(r.location).toBe(`${APP}/login?error=google_ambiguous`);
    expect(await userBySub(s)).toBeUndefined();
  });

  it('a new GitHub account with an email another account confirmed is refused; known ones sign in', async () => {
    const email = `ghtaken-${tag()}@example.com`;
    await emailAccount(email);
    const id = ghId();
    const login = `gh-${tag()}`;
    expect(await viaGitHub({ id, login, email })).toBe(`${APP}/login?error=github_email_taken`);
    expect(await deps.sql`select 1 from users where github_id = ${id}`).toHaveLength(0);

    const known = ghId();
    await deps.sql`insert into users (login, github_id) values (${`gh-${tag()}`}, ${known})`;
    expect(await viaGitHub({ id: known, login: `gh-${tag()}`, email })).toBe(`${APP}/overview`);
  });

  it("a new GitHub account gets a link for GitHub's email, unconfirmed until opened", async () => {
    const email = `ghnew-${tag()}@example.com`;
    const id = ghId();
    expect(await viaGitHub({ id, login: `gh-${tag()}`, email })).toBe(`${APP}/overview`);
    const [u] = await deps.sql<{ confirmed: boolean }[]>`
      select email_verified_at is not null as confirmed from users where github_id = ${id}`;
    expect(u?.confirmed).toBe(false);
    expect((await confirm(linkIn(email, 'confirm-email'))).statusCode).toBe(200);
  });

  it('email sign-up with an address another account confirmed says "you already have an account"', async () => {
    const email = `signup-${tag()}@example.com`;
    await deps.sql`insert into users (login, email, email_verified_at, github_id)
      values (${`gh-${tag()}`}, ${email}, now(), ${ghId()})`;
    const r = await app.inject({
      method: 'POST',
      url: '/auth/email/signup',
      remoteAddress: from(),
      payload: { email, password: 'a long password 1' },
    });
    expect(r.statusCode).toBe(202);
    expect(await deps.sql`select 1 from user_passwords where email = ${email}`).toHaveLength(0);
    expect(mails.filter((m) => m.to === email).at(-1)?.subject).toBe(
      'You already have an AutoDeploy account',
    );
  });

  it.each([
    ['confirming a new email account', 'verify'],
    ['resetting the password', 'reset'],
  ] as const)('%s confirms its account email too', async (_why, how) => {
    const email = `${how}-${tag()}@example.com`;
    if (how === 'verify') {
      await app.inject({
        method: 'POST',
        url: '/auth/email/signup',
        remoteAddress: from(),
        payload: { email, password: 'a long password 1' },
      });
      const token = linkIn(email, 'verify-email');
      const r = await app.inject({
        method: 'POST',
        url: '/auth/email/verify',
        remoteAddress: from(),
        payload: { token },
      });
      expect(r.statusCode).toBe(200);
    } else {
      await emailAccount(email, false);
      await app.inject({
        method: 'POST',
        url: '/auth/email/forgot',
        remoteAddress: from(),
        payload: { email },
      });
      const token = linkIn(email, 'reset-password');
      const r = await app.inject({
        method: 'POST',
        url: '/auth/email/reset',
        remoteAddress: from(),
        payload: { token, password: 'a new long password 2' },
      });
      expect(r.statusCode).toBe(200);
    }
    const [u] = await deps.sql<{ confirmed: boolean }[]>`
      select email_verified_at is not null as confirmed from users where email = ${email}`;
    expect(u?.confirmed).toBe(true);
  });
});
