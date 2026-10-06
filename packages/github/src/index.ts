import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { retry, TimeoutError, withTimeout } from '@autodeploy/resilience';
import * as tar from 'tar';

// Everything that talks to GitHub. Public repositories work with no
// credentials (REST + codeload tarballs); the GitHub App adds private repos,
// commit statuses, check runs and PRs once it is configured.

export type RepoRef = { owner: string; repo: string };

export function parseRepoUrl(url: string): RepoRef {
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  if (!m?.[1] || !m[2])
    throw new Error('expected a GitHub repository URL like https://github.com/owner/repo');
  return { owner: m[1], repo: m[2] };
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Minimal cache contract (Valkey in the apps) for ETag-conditional requests. */
export type EtagCache = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
};

export type GitHubClientOptions = {
  token?: string | (() => Promise<string>);
  cache?: EtagCache;
  baseUrl?: string;
  userAgent?: string;
};

export class GitHubClient {
  constructor(private readonly o: GitHubClientOptions = {}) {}

  private async headers(): Promise<Record<string, string>> {
    const token = typeof this.o.token === 'function' ? await this.o.token() : this.o.token;
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.o.userAgent ?? 'autodeploy',
      ...(token && { authorization: `Bearer ${token}` }),
    };
  }

  /**
   * GET with conditional requests: a 304 replays the cached body and does not
   * count against the rate limit, which matters at 60 req/h unauthenticated.
   */
  async get<T>(path: string): Promise<T> {
    const url = `${this.o.baseUrl ?? 'https://api.github.com'}${path}`;
    const cacheKey = `gh:etag:${path}`;
    const cached = this.o.cache ? await this.o.cache.get(cacheKey) : null;
    const prev = cached ? (JSON.parse(cached) as { etag: string; body: T }) : undefined;
    return retry(
      async () => {
        const res = await withTimeout(10_000, (signal) =>
          this.headers().then((h) =>
            fetch(url, { headers: { ...h, ...(prev && { 'if-none-match': prev.etag }) }, signal }),
          ),
        );
        if (res.status === 304 && prev) return prev.body;
        if (!res.ok) throw await toError(res);
        const body = (await res.json()) as T;
        const etag = res.headers.get('etag');
        if (etag && this.o.cache)
          await this.o.cache.set(cacheKey, JSON.stringify({ etag, body }), 3600);
        return body;
      },
      {
        attempts: 3,
        retryable: (e) =>
          e instanceof TimeoutError ||
          (e instanceof GitHubError && (e.status >= 500 || e.status === 429)),
        retryAfterMs: (e) => (e instanceof GitHubError ? e.retryAfterMs : undefined),
      },
    );
  }

  async send<T>(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await withTimeout(15_000, async (signal) =>
      fetch(`${this.o.baseUrl ?? 'https://api.github.com'}${path}`, {
        method,
        headers: { ...(await this.headers()), 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal,
      }),
    );
    if (!res.ok) throw await toError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async resolveCommit(
    r: RepoRef,
    ref?: string,
  ): Promise<{
    sha: string;
    branch: string | null;
    message: string;
    defaultBranch: string;
    private: boolean;
  }> {
    const repo = await this.get<{ default_branch: string; private: boolean }>(
      `/repos/${r.owner}/${r.repo}`,
    );
    const target = ref ?? repo.default_branch;
    const commit = await this.get<{ sha: string; commit: { message: string } }>(
      `/repos/${r.owner}/${r.repo}/commits/${encodeURIComponent(target)}`,
    );
    const isSha = /^[0-9a-f]{7,40}$/i.test(target);
    return {
      sha: commit.sha,
      branch: isSha ? null : target,
      message: commit.commit.message.split('\n')[0] ?? '',
      defaultBranch: repo.default_branch,
      private: repo.private,
    };
  }

  async createCommitStatus(
    r: RepoRef,
    sha: string,
    s: {
      state: 'pending' | 'success' | 'failure' | 'error';
      description: string;
      targetUrl?: string;
      context?: string;
    },
  ) {
    return this.send('POST', `/repos/${r.owner}/${r.repo}/statuses/${sha}`, {
      state: s.state,
      description: s.description.slice(0, 140),
      context: s.context ?? 'autodeploy',
      ...(s.targetUrl && { target_url: s.targetUrl }),
    });
  }

  /** Opens a PR containing one commit with the given file contents (Git Data API). */
  async openPullRequest(
    r: RepoRef,
    o: {
      base: string;
      baseSha: string;
      branch: string;
      title: string;
      body: string;
      files: Array<{ path: string; content: string }>;
    },
  ): Promise<string> {
    const tree = await this.send<{ sha: string }>('POST', `/repos/${r.owner}/${r.repo}/git/trees`, {
      base_tree: o.baseSha,
      tree: o.files.map((f) => ({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content,
      })),
    });
    const commit = await this.send<{ sha: string }>(
      'POST',
      `/repos/${r.owner}/${r.repo}/git/commits`,
      {
        message: o.title,
        tree: tree.sha,
        parents: [o.baseSha],
      },
    );
    await this.send('POST', `/repos/${r.owner}/${r.repo}/git/refs`, {
      ref: `refs/heads/${o.branch}`,
      sha: commit.sha,
    });
    const pr = await this.send<{ html_url: string }>('POST', `/repos/${r.owner}/${r.repo}/pulls`, {
      title: o.title,
      head: o.branch,
      base: o.base,
      body: o.body,
    });
    return pr.html_url;
  }
}

async function toError(res: Response): Promise<GitHubError> {
  const retryAfter = res.headers.get('retry-after');
  const reset = res.headers.get('x-ratelimit-reset');
  const remaining = res.headers.get('x-ratelimit-remaining');
  let retryAfterMs: number | undefined;
  if (retryAfter) retryAfterMs = Number(retryAfter) * 1000;
  else if (remaining === '0' && reset)
    retryAfterMs = Math.max(0, Number(reset) * 1000 - Date.now());
  const text = await res.text().catch(() => '');
  let message = text;
  try {
    message = (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {}
  if (res.status === 404)
    message = 'repository or ref not found (private repositories need the GitHub App)';
  if (res.status === 403 && remaining === '0')
    message = 'GitHub API rate limit reached; try again later';
  return new GitHubError(res.status, message.slice(0, 300), retryAfterMs);
}

// ------------------------------------------------------------------ sources

export type SourceLimits = { maxBytes: number; maxFiles: number };
export const DEFAULT_SOURCE_LIMITS: SourceLimits = {
  maxBytes: 300 * 1024 * 1024,
  maxFiles: 50_000,
};

/**
 * Downloads a commit tarball and extracts it into `dest`, refusing anything
 * that would escape the directory (absolute paths, `..`, links) and stopping
 * at size/file-count limits so a hostile repo can't fill the disk.
 */
export async function downloadTarball(
  r: RepoRef,
  sha: string,
  dest: string,
  token?: string,
  limits = DEFAULT_SOURCE_LIMITS,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const url = token
    ? `https://api.github.com/repos/${r.owner}/${r.repo}/tarball/${sha}`
    : `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${sha}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'autodeploy', ...(token && { authorization: `Bearer ${token}` }) },
    redirect: 'follow',
  });
  if (!res.ok || !res.body)
    throw new GitHubError(res.status, `tarball download failed (${res.status})`);
  let bytes = 0;
  let files = 0;
  const root = resolve(dest);
  await pipeline(
    Readable.fromWeb(res.body as never),
    tar.x({
      cwd: dest,
      strip: 1,
      filter: (path, entry) => {
        const type = (entry as { type?: string }).type;
        if (type === 'SymbolicLink' || type === 'Link') return false;
        const target = resolve(root, path.split('/').slice(1).join('/'));
        if (target !== root && !target.startsWith(root + sep)) return false;
        bytes += (entry as { size?: number }).size ?? 0;
        files++;
        if (bytes > limits.maxBytes)
          throw new Error(`repository exceeds ${limits.maxBytes / 1024 / 1024} MB`);
        if (files > limits.maxFiles) throw new Error(`repository exceeds ${limits.maxFiles} files`);
        return true;
      },
    }),
  );
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'out',
  'build',
  '.turbo',
  'coverage',
]);
const MAX_READ_BYTES = 256 * 1024;

/** Dev/test source: copy a local directory (used by the failure corpus). */
export async function copyLocalSource(from: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await cp(from, dest, {
    recursive: true,
    filter: (src) =>
      !relative(from, src)
        .split(sep)
        .some((seg) => SKIP_DIRS.has(seg)),
  });
}

/** Builds the analyzer's FileTree from a directory on disk. */
export async function readTree(
  dir: string,
): Promise<{ files: string[]; read(path: string): string | undefined }> {
  const files: string[] = [];
  const contents = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(join(d, e.name));
      } else if (e.isFile()) {
        files.push(relative(dir, join(d, e.name)).split(sep).join('/'));
      }
    }
  };
  await walk(dir);
  files.sort();
  // Pre-read the small text files the analyzer may ask for.
  for (const f of files) {
    if (
      !/\.(json|ya?ml|m?[jt]sx?|cjs|vue|svelte|astro|html|nvmrc|node-version|toml|diff)$|(^|\/)\.(nvmrc|node-version)$/.test(
        f,
      )
    )
      continue;
    const p = join(dir, f);
    const s = await stat(p);
    if (s.size <= MAX_READ_BYTES) contents.set(f, await readFile(p, 'utf8'));
  }
  return { files, read: (path) => contents.get(path) };
}

// ----------------------------------------------------------------- webhooks

/** Verifies X-Hub-Signature-256 over the raw request body in constant time. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --------------------------------------------------------------- GitHub App

export type GitHubAppConfig = {
  appId: string;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  slug: string;
};

/** RS256 JWT identifying the App itself (valid 10 minutes, backdated 60 s for clock skew). */
export function createAppJwt(
  appId: string,
  privateKeyPem: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem).toString('base64url');
  return `${unsigned}.${sig}`;
}

export type RepoInstallation = { id: number; account: string };

/** Caches installation tokens until 5 minutes before they expire. */
export class InstallationTokens {
  private readonly cache = new Map<number, { token: string; expiresAt: number }>();
  private readonly repos = new Map<string, { hit: RepoInstallation | null; at: number }>();
  constructor(private readonly app: Pick<GitHubAppConfig, 'appId' | 'privateKey'>) {}

  /**
   * The installation that covers a repository, or null if the App isn't
   * installed on it. Asked of GitHub directly (cached 10 minutes), so it does
   * not depend on an "installation" webhook ever having been delivered.
   */
  async forRepo(r: RepoRef): Promise<RepoInstallation | null> {
    const key = `${r.owner}/${r.repo}`.toLowerCase();
    const cached = this.repos.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hit;
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/installation`, {
      headers: {
        authorization: `Bearer ${createAppJwt(this.app.appId, this.app.privateKey)}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'autodeploy',
      },
    });
    if (res.status === 404) {
      this.repos.set(key, { hit: null, at: Date.now() });
      return null;
    }
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as { id: number; account: { login: string } };
    const hit = { id: body.id, account: body.account.login };
    this.repos.set(key, { hit, at: Date.now() });
    return hit;
  }

  async get(installationId: number): Promise<string> {
    const hit = this.cache.get(installationId);
    if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;
    const jwt = createAppJwt(this.app.appId, this.app.privateKey);
    const res = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'autodeploy',
        },
      },
    );
    if (!res.ok) throw await toError(res);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.cache.set(installationId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }
}

/** OAuth user-to-server exchange used for "Sign in with GitHub". */
export async function exchangeOAuthCode(
  app: Pick<GitHubAppConfig, 'clientId' | 'clientSecret'>,
  code: string,
): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token)
    throw new GitHubError(401, body.error_description ?? 'OAuth exchange failed');
  return body.access_token;
}

export async function writeStream(path: string, body: ReadableStream<Uint8Array>): Promise<void> {
  await pipeline(Readable.fromWeb(body as never), createWriteStream(path));
}
