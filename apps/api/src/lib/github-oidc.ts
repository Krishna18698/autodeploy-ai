import { createPublicKey, verify, type webcrypto } from 'node:crypto';

type JsonWebKey = webcrypto.JsonWebKey;

// GitHub Actions jobs prove who they are with a short-lived OIDC token: a JWT
// signed by GitHub, naming the repository, workflow and run (ADR 0010).

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export type GitHubJobClaims = {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  /** owner/name */
  repository: string;
  repository_id: string;
  /** owner/name/.github/workflows/<file>@<ref> */
  workflow_ref: string;
  event_name: string;
  run_id: string;
  run_attempt?: string;
  sha?: string;
};

export class OidcError extends Error {}

/** A signing key by id; null when GitHub doesn't publish it. */
export type KeyLookup = (kid: string) => Promise<JsonWebKey | null>;

/**
 * GitHub's signing keys, fetched when first needed and again when a token
 * names one we don't have (at most once a minute), else kept for an hour.
 */
export function githubSigningKeys(
  fetchJwks: () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }> = async () => {
    const r = await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Not an OidcError: a 500, which the runner retries.
    if (!r.ok) throw new Error(`GitHub's signing keys: ${r.status}`);
    return r.json() as Promise<{ keys: (JsonWebKey & { kid?: string })[] }>;
  },
): KeyLookup {
  let keys = new Map<string, JsonWebKey>();
  let fetchedAt = 0;
  return async (kid) => {
    const age = Date.now() - fetchedAt;
    if (age > 3_600_000 || (!keys.has(kid) && age > 60_000)) {
      const { keys: list } = await fetchJwks();
      keys = new Map(list.filter((k) => k.kid).map((k) => [k.kid as string, k]));
      fetchedAt = Date.now();
    }
    return keys.get(kid) ?? null;
  };
}

const part = (s: string | undefined) => {
  if (!s) throw new OidcError('not a JWT');
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
};

/**
 * The claims of a GitHub Actions job token, once its signature (RS256, by a
 * key GitHub publishes), issuer, audience and lifetime check out. What the
 * claims must say about the repository and run is the caller's to check.
 */
export async function verifyGitHubJobToken(
  token: string,
  opts: { audience: string; key: KeyLookup; now?: number },
): Promise<GitHubJobClaims> {
  const [h, p, s, extra] = token.split('.');
  if (extra !== undefined || !s) throw new OidcError('not a JWT');
  const header = part(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new OidcError('not signed the way GitHub signs');
  const jwk = await opts.key(header.kid);
  if (!jwk) throw new OidcError('signed with a key GitHub does not publish');
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new OidcError('bad signature');
  const c = part(p) as unknown as GitHubJobClaims;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = 60;
  if (c.iss !== GITHUB_OIDC_ISSUER) throw new OidcError('not issued by GitHub Actions');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.audience)) throw new OidcError('meant for another audience');
  if (typeof c.exp !== 'number' || c.exp < now - skew) throw new OidcError('expired');
  if ((c.nbf ?? c.iat) > now + skew) throw new OidcError('not valid yet');
  for (const k of ['repository', 'workflow_ref', 'event_name', 'run_id'] as const)
    if (typeof c[k] !== 'string' || !c[k]) throw new OidcError(`no ${k}`);
  return c;
}
