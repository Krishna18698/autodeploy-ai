import { generateKeyPairSync } from 'node:crypto';
import { InstallationTokens } from '@autodeploy/github';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Deps } from '../../apps/api/src/deps';
import { resolveSource } from '../../apps/api/src/services/sources';

const commit = {
  sha: 'a'.repeat(40),
  branch: 'main',
  message: 'm',
  defaultBranch: 'main',
  private: false,
};

function fakeDeps(o: { account: string; claimedByOrg: boolean }) {
  const publicClient = { resolveCommit: vi.fn(async () => ({ ...commit, sha: 'p'.repeat(40) })) };
  const tokenFor = vi.fn(async () => 'inst-token');
  const sql = vi.fn(async () => (o.claimedByOrg ? [{ id: '7' }] : []));
  const deps = {
    env: { ALLOW_LOCAL_SOURCES: false },
    installations: { forRepo: vi.fn(async () => ({ id: 7, account: o.account })), get: tokenFor },
    sql,
    github: publicClient,
  } as unknown as Deps;
  return { deps, publicClient, tokenFor };
}

describe('private repos: which App installation a user may use', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGitHub() {
    const auth: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        auth.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(
          JSON.stringify(
            String(url).includes('/commits/')
              ? { sha: 'b'.repeat(40), commit: { message: 'private commit' } }
              : { default_branch: 'main', private: true },
          ),
        );
      }),
    );
    return auth;
  }

  it("uses the installation on the user's own account", async () => {
    const auth = stubGitHub();
    const { deps, publicClient } = fakeDeps({ account: 'Krishna18698', claimedByOrg: false });
    const src = await resolveSource(
      deps,
      'https://github.com/krishna18698/portfolio-ai',
      undefined,
      {
        login: 'krishna18698',
        orgId: 'org-1',
      },
    );
    expect(src.installationId).toBe(7);
    expect(src.commitSha).toBe('b'.repeat(40));
    expect(auth.every((h) => h === 'Bearer inst-token')).toBe(true);
    expect(publicClient.resolveCommit).not.toHaveBeenCalled();
  });

  it("never uses another account's installation (cross-tenant)", async () => {
    stubGitHub();
    const { deps, publicClient, tokenFor } = fakeDeps({ account: 'victim', claimedByOrg: false });
    const src = await resolveSource(deps, 'https://github.com/victim/secret', undefined, {
      login: 'intruder',
      orgId: 'org-2',
    });
    expect(src.installationId).toBeNull();
    expect(tokenFor).not.toHaveBeenCalled();
    expect(publicClient.resolveCommit).toHaveBeenCalled(); // anonymous: private repos 404
  });

  it('allows an installation the org has claimed (e.g. a GitHub organisation)', async () => {
    stubGitHub();
    const { deps } = fakeDeps({ account: 'acme-inc', claimedByOrg: true });
    const src = await resolveSource(deps, 'https://github.com/acme-inc/site', undefined, {
      login: 'someone',
      orgId: 'org-1',
    });
    expect(src.installationId).toBe(7);
  });
});

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

describe('InstallationTokens.forRepo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks GitHub directly, returns the account, and caches the answer', async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: 42, account: { login: 'me' } })),
    );
    vi.stubGlobal('fetch', fetch);
    const t = new InstallationTokens({ appId: '1', privateKey });
    expect(await t.forRepo({ owner: 'me', repo: 'site' })).toEqual({ id: 42, account: 'me' });
    expect(await t.forRepo({ owner: 'ME', repo: 'Site' })).toEqual({ id: 42, account: 'me' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      'https://api.github.com/repos/me/site/installation',
    );
  });

  it('returns null when the App is not installed on the repo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );
    const t = new InstallationTokens({ appId: '1', privateKey });
    expect(await t.forRepo({ owner: 'me', repo: 'other' })).toBeNull();
  });
});
