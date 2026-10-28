import { type JsonWebKey, JwtError, type KeyLookup, publishedKeys, verifyJwt } from './jwt.js';

// GitHub Actions jobs prove who they are with a short-lived OIDC token: a JWT
// signed by GitHub, naming the repository, workflow and run (ADR 0010).

export type { KeyLookup } from './jwt.js';
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

/** GitHub's signing keys (cached; see publishedKeys). */
export function githubSigningKeys(
  fetchJwks?: () => Promise<{ keys: (JsonWebKey & { kid?: string })[] }>,
): KeyLookup {
  return publishedKeys(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`, fetchJwks);
}

/**
 * The claims of a GitHub Actions job token, once its signature (RS256, by a
 * key GitHub publishes), issuer, audience and lifetime check out. What the
 * claims must say about the repository and run is the caller's to check.
 */
export async function verifyGitHubJobToken(
  token: string,
  opts: { audience: string; key: KeyLookup; now?: number },
): Promise<GitHubJobClaims> {
  let c: Record<string, unknown>;
  try {
    c = await verifyJwt(token, { ...opts, issuers: [GITHUB_OIDC_ISSUER] });
  } catch (err) {
    if (!(err instanceof JwtError)) throw err;
    throw new OidcError(
      err.message
        .replace('its issuer does not publish', 'GitHub does not publish')
        .replace('the way its issuer signs', 'the way GitHub signs')
        .replace('not from the expected issuer', 'not issued by GitHub Actions'),
    );
  }
  for (const k of ['repository', 'workflow_ref', 'event_name', 'run_id'] as const)
    if (typeof c[k] !== 'string' || !c[k]) throw new OidcError(`no ${k}`);
  return c as unknown as GitHubJobClaims;
}
