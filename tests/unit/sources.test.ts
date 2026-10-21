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

type InstallRow = { org_id: string | null; installed_by: string | null } | null;
function fakeDeps(o: { account: string; accountId: number; row: InstallRow }) {
  const publicClient = { resolveCommit: vi.fn(async () => ({ ...commit, sha: 'p'.repeat(40) })) };
  const tokenFor = vi.fn(async () => 'inst-token');
  const sql = vi.fn(async () => (o.row ? [o.row] : []));
  const deps = {
    env: { ALLOW_LOCAL_SOURCES: false },
    installations: {
      forRepo: vi.fn(async () => ({ id: 7, account: o.account, accountId: o.accountId })),
      get: tokenFor,
    },
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
    const { deps, publicClient } = fakeDeps({
      account: 'Krishna18698',
      accountId: 1001,
      row: { org_id: null, installed_by: null },
    });
    const src = await resolveSource(
      deps,
      'https://github.com/krishna18698/portfolio-ai',
      undefined,
      { githubId: 1001, orgId: 'org-1' },
    );
    expect(src.installationId).toBe(7);
    expect(src.commitSha).toBe('b'.repeat(40));
    expect(auth.every((h) => h === 'Bearer inst-token')).toBe(true);
    expect(publicClient.resolveCommit).not.toHaveBeenCalled();
  });

  it("never uses another account's installation (cross-tenant)", async () => {
    stubGitHub();
    const { deps, publicClient, tokenFor } = fakeDeps({
      account: 'victim',
      accountId: 2002,
      row: { org_id: null, installed_by: null },
    });
    const src = await resolveSource(deps, 'https://github.com/victim/secret', undefined, {
      githubId: 3003,
      orgId: 'org-2',
    });
    expect(src.installationId).toBeNull();
    expect(tokenFor).not.toHaveBeenCalled();
    expect(publicClient.resolveCommit).toHaveBeenCalled(); // anonymous: private repos 404
  });

  it('matches by GitHub id, never by login: a reused login or an unlinked account gets nothing', async () => {
    stubGitHub();
    // "victim" renamed on GitHub and someone took the name: same login, different account.
    for (const githubId of [4004, null]) {
      const { deps, tokenFor } = fakeDeps({
        account: 'victim',
        accountId: 2002,
        row: { org_id: null, installed_by: null },
      });
      const src = await resolveSource(deps, 'https://github.com/victim/secret', undefined, {
        githubId,
        orgId: 'org-3',
      });
      expect(src.installationId).toBeNull();
      expect(tokenFor).not.toHaveBeenCalled();
    }
  });

  it('allows an installation the org has claimed (e.g. a GitHub organisation)', async () => {
    stubGitHub();
    const { deps } = fakeDeps({
      account: 'acme-inc',
      accountId: 5005,
      row: { org_id: 'org-1', installed_by: null },
    });
    const src = await resolveSource(deps, 'https://github.com/acme-inc/site', undefined, {
      githubId: 1001,
      orgId: 'org-1',
    });
    expect(src.installationId).toBe(7);
  });

  it("an organisation's installer may use its unclaimed installation; nobody else, and not once claimed elsewhere", async () => {
    stubGitHub();
    const use = (row: InstallRow, githubId: number) =>
      resolveSource(
        fakeDeps({ account: 'acme-inc', accountId: 5005, row }).deps,
        'https://github.com/acme-inc/site',
        undefined,
        { githubId, orgId: 'org-1' },
      );
    expect((await use({ org_id: null, installed_by: '6006' }, 6006)).installationId).toBe(7);
    expect((await use({ org_id: null, installed_by: '6006' }, 7007)).installationId).toBeNull();
    expect((await use({ org_id: 'org-9', installed_by: '6006' }, 6006)).installationId).toBeNull();
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
