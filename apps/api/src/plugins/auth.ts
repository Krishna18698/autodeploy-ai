import { safeEqual, sha256Hex } from '@autodeploy/crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Deps } from '../deps.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export type Scope = 'read' | 'deploy' | 'admin';

export type Auth = {
  userId: string;
  login: string;
  orgId: string;
  role: Role;
  via: 'session' | 'token';
  sessionHash?: string;
  csrfToken?: string;
  tokenId?: string;
  scopes?: Scope[];
};

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth | null;
  }
}

export const SESSION_COOKIE = 'ad_session';
const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
// What each token scope can do, expressed as the highest role it acts as.
const SCOPE_ROLE: Record<Scope, Role> = { read: 'viewer', deploy: 'member', admin: 'admin' };
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function resolveToken(deps: Deps, raw: string): Promise<Auth | null> {
  const [row] = await deps.sql<
    { id: string; org_id: string; user_id: string; scopes: Scope[]; login: string; role: Role }[]
  >`
    select t.id, t.org_id, t.user_id, t.scopes, u.login, m.role
    from api_tokens t
    join users u on u.id = t.user_id
    join memberships m on m.org_id = t.org_id and m.user_id = t.user_id
    where t.token_hash = ${sha256Hex(raw)} and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())`;
  if (!row) return null;
  // Best-effort usage stamp; never blocks the request.
  void deps.sql`update api_tokens set last_used_at = now() where id = ${row.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`.catch(
    () => {},
  );
  // A token can never exceed the role of the user who created it.
  const maxScopeRole = row.scopes.reduce<Role>(
    (acc, s) => (RANK[SCOPE_ROLE[s]] > RANK[acc] ? SCOPE_ROLE[s] : acc),
    'viewer',
  );
  const role = RANK[maxScopeRole] < RANK[row.role] ? maxScopeRole : row.role;
  return {
    userId: row.user_id,
    login: row.login,
    orgId: row.org_id,
    role,
    via: 'token',
    tokenId: row.id,
    scopes: row.scopes,
  };
}

async function resolveSession(deps: Deps, raw: string): Promise<Auth | null> {
  const hash = sha256Hex(raw);
  const [row] = await deps.sql<
    {
      user_id: string;
      org_id: string | null;
      csrf_token: string;
      login: string;
      last_seen_at: Date;
    }[]
  >`
    select s.user_id, s.org_id, s.csrf_token, u.login, s.last_seen_at
    from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${hash} and s.expires_at > now()`;
  if (!row) return null;
  // Active org: the session's choice if still a member, else the first membership.
  const [m] = await deps.sql<{ org_id: string; role: Role }[]>`
    select org_id, role from memberships where user_id = ${row.user_id}
    order by (org_id = ${row.org_id}) desc nulls last, created_at limit 1`;
  if (!m) return null;
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    // Sliding expiry, written at most every 5 minutes per session.
    void deps.sql`update sessions set last_seen_at = now(), expires_at = now() + interval '14 days' where token_hash = ${hash}`.catch(
      () => {},
    );
  }
  return {
    userId: row.user_id,
    login: row.login,
    orgId: m.org_id,
    role: m.role,
    via: 'session',
    sessionHash: hash,
    csrfToken: row.csrf_token,
  };
}

export const authPlugin = fp(async (app: FastifyInstance, deps: Deps) => {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.auth = await resolveToken(deps, header.slice(7).trim());
      if (!req.auth) throw unauthorized('Invalid or expired API token');
      return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie) req.auth = await resolveSession(deps, cookie);

    // CSRF: cookie-authenticated writes must carry the session's token and,
    // when the browser sends one, an Origin we serve.
    if (
      req.auth?.via === 'session' &&
      UNSAFE.has(req.method) &&
      req.routeOptions.config?.csrf !== false
    ) {
      const origin = req.headers.origin;
      if (origin && origin !== deps.env.APP_URL && origin !== deps.env.API_PUBLIC_URL) {
        throw forbidden('Cross-origin request rejected');
      }
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !req.auth.csrfToken || !safeEqual(sent, req.auth.csrfToken)) {
        throw forbidden('Missing or invalid CSRF token');
      }
    }
  });
});

/** preHandler guard: signed in, with at least `role` in the active org. */
export function requireRole(role: Role = 'viewer') {
  return async (req: FastifyRequest) => {
    const a = req.auth;
    if (!a) throw unauthorized();
    if (RANK[a.role] < RANK[role]) throw forbidden(`Requires the ${role} role`);
  };
}

/** The authenticated principal; use after a requireRole() guard. */
export function authOf(req: FastifyRequest): Auth {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function rankOf(role: Role) {
  return RANK[role];
}
