import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_OIDC_ISSUER,
  githubSigningKeys,
  verifyGitHubJobToken,
} from '../../apps/api/src/lib/github-oidc';

// GitHub Actions job tokens (ADR 0010), with keys of our own standing in for
// GitHub's.
const github = generateKeyPairSync('rsa', { modulusLength: 2048 });
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...github.publicKey.export({ format: 'jwk' }), kid: 'gh-1' };
const key = async (kid: string) => (kid === 'gh-1' ? jwk : null);
const AUD = 'https://api.autodeploy.fyi';
const now = 1_800_000_000;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; alg?: string; signer?: typeof github } = {},
) {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'gh-1', typ: 'JWT' });
  const body = b64({
    iss: GITHUB_OIDC_ISSUER,
    aud: AUD,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    repository: 'Krishna18698/site',
    repository_id: '42',
    workflow_ref: 'Krishna18698/site/.github/workflows/autodeploy.yml@refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '1001',
    ...claims,
  });
  const sig = createSign('RSA-SHA256')
    .update(`${head}.${body}`)
    .sign((opts.signer ?? github).privateKey)
    .toString('base64url');
  return `${head}.${body}.${sig}`;
}
const check = (t: string) => verifyGitHubJobToken(t, { audience: AUD, key, now });

describe('a GitHub Actions job token', () => {
  it("is accepted when GitHub signed it for us, and says which repository and run it's from", async () => {
    const c = await check(token());
    expect(c).toMatchObject({
      repository: 'Krishna18698/site',
      run_id: '1001',
      event_name: 'workflow_dispatch',
    });
  });

  it.each([
    ['signed by anyone else', () => token({}, { signer: stranger }), 'bad signature'],
    ['with a key GitHub does not publish', () => token({}, { kid: 'other' }), 'does not publish'],
    [
      'not RS256 (e.g. alg none)',
      () => token({}, { alg: 'none' }),
      'not signed the way GitHub signs',
    ],
    [
      'meant for another service',
      () => token({ aud: 'https://elsewhere.example' }),
      'another audience',
    ],
    [
      'issued by someone else',
      () => token({ iss: 'https://evil.example' }),
      'not issued by GitHub Actions',
    ],
    ['expired', () => token({ exp: now - 120 }), 'expired'],
    ['not valid yet', () => token({ nbf: now + 600, iat: now + 600 }), 'not valid yet'],
    ['without a repository', () => token({ repository: '' }), 'no repository'],
  ])('is refused when %s', async (_why, make, message) => {
    await expect(check(make())).rejects.toThrow(message);
  });

  it('is refused when tampered with after signing', async () => {
    const [h, , s] = token().split('.');
    const forged = b64({
      iss: GITHUB_OIDC_ISSUER,
      aud: AUD,
      exp: now + 300,
      iat: now,
      repository: 'victim/site',
      workflow_ref: 'x',
      event_name: 'workflow_dispatch',
      run_id: '1',
    });
    await expect(check(`${h}.${forged}.${s}`)).rejects.toThrow('bad signature');
  });

  it("GitHub's keys are fetched once, again for an unknown key at most once a minute, and hourly", async () => {
    const fetchJwks = vi.fn(async () => ({ keys: [jwk] }));
    vi.useFakeTimers();
    try {
      const lookup = githubSigningKeys(fetchJwks);
      expect(await lookup('gh-1')).toEqual(jwk);
      expect(await lookup('gh-1')).toEqual(jwk);
      expect(await lookup('unknown')).toBeNull(); // within the minute: not refetched
      expect(fetchJwks).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      expect(await lookup('unknown')).toBeNull(); // a minute on: refetched for it
      expect(fetchJwks).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(3_601_000);
      await lookup('gh-1'); // an hour on: refreshed anyway
      expect(fetchJwks).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
