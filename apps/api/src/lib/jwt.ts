import { createPublicKey, verify, type webcrypto } from 'node:crypto';

// RS256 JSON Web Tokens from a party that publishes its signing keys: GitHub
// Actions job tokens (ADR 0010) and Google's sign-in answers.

export type JsonWebKey = webcrypto.JsonWebKey;
/** A signing key by id; null when the issuer doesn't publish it. */
export type KeyLookup = (kid: string) => Promise<JsonWebKey | null>;

export class JwtError extends Error {}

/**
 * An issuer's signing keys, fetched when first needed and again when a token
 * names one we don't have (at most once a minute), else kept for an hour.
 * Fetch failures are plain errors (a 500, retried), not JwtErrors.
 */
export function publishedKeys(
  url: string,
  fetchJwks: () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }> = async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`signing keys at ${url}: ${r.status}`);
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
  if (!s) throw new JwtError('not a JWT');
  return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
};

/**
 * The claims of a token once its signature (RS256, by a key the issuer
 * publishes), issuer, audience and lifetime check out (60 s of clock skew).
 */
export async function verifyJwt(
  token: string,
  opts: { issuers: readonly string[]; audience: string; key: KeyLookup; now?: number },
): Promise<Record<string, unknown>> {
  const [h, p, s, extra] = token.split('.');
  if (extra !== undefined || !s) throw new JwtError('not a JWT');
  const header = part(h);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new JwtError('not signed the way its issuer signs');
  const jwk = await opts.key(header.kid);
  if (!jwk) throw new JwtError('signed with a key its issuer does not publish');
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(`${h}.${p}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(s, 'base64url'),
  );
  if (!ok) throw new JwtError('bad signature');
  const c = part(p);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof c.iss !== 'string' || !opts.issuers.includes(c.iss))
    throw new JwtError('not from the expected issuer');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.audience)) throw new JwtError('meant for another audience');
  if (typeof c.exp !== 'number' || c.exp < now - skew) throw new JwtError('expired');
  const from = (c.nbf ?? c.iat) as number | undefined;
  if (typeof from === 'number' && from > now + skew) throw new JwtError('not valid yet');
  return c;
}
