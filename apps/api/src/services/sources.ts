import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYSIS_VERSION, type Analysis, analyze, slugify } from '@autodeploy/core';
import {
  copyLocalSource,
  downloadTarball,
  GitHubClient,
  parseRepoUrl,
  type RepoRef,
  readTree,
} from '@autodeploy/github';
import type { Deps } from '../deps.js';
import { AppError, badRequest } from '../lib/errors.js';

// Resolves "what code is this?" for a repo URL + ref, and analyzes it.
// Analysis is a pure function of (repo, commit, root dir), so it's cached
// by commit SHA and never recomputed for the same commit.

export type ResolvedSource = {
  kind: 'github' | 'local';
  repo: RepoRef;
  fullName: string;
  repoUrl: string;
  ref: string;
  commitSha: string;
  branch: string | null;
  commitMessage: string | null;
  defaultBranch: string;
  /** GitHub App installation covering the repo (private repos need one). */
  installationId: number | null;
  installationAccount?: string | null;
  localPath?: string;
};

/** A token for reading the repo: its App installation's, else the optional PAT. */
async function readToken(deps: Deps, installationId: number | null) {
  return installationId && deps.installations
    ? deps.installations.get(installationId)
    : deps.env.GITHUB_TOKEN;
}

/** Who is asking: an installation may only be used by its own account or org. */
export type SourceActor = { githubId: number | null; orgId: string };

/**
 * The App installation this actor may use for the repo. Another account's
 * installation is never used, so one tenant can't read another's private repo
 * just because the App can.
 */
async function usableInstallation(deps: Deps, repo: RepoRef, actor: SourceActor) {
  const inst = deps.installations ? await deps.installations.forRepo(repo) : null;
  if (!inst) return null;
  // By GitHub's numeric id: a login can be renamed and then taken by someone else.
  if (actor.githubId !== null && inst.accountId === actor.githubId) return inst;
  const [row] = await deps.sql<{ org_id: string | null; installed_by: string | null }[]>`
    select org_id, installed_by from github_installations where id = ${inst.id}`;
  if (row?.org_id === actor.orgId) return inst;
  // An organisation installation nobody has claimed yet: usable by whoever
  // installed it (only the organisation's owners can); importing claims it.
  const installer = row?.installed_by == null ? null : Number(row.installed_by);
  if (row && row.org_id === null && actor.githubId !== null && installer === actor.githubId)
    return inst;
  return null;
}

export async function resolveSource(
  deps: Deps,
  repoUrl: string,
  ref: string | undefined,
  actor: SourceActor,
): Promise<ResolvedSource> {
  if (repoUrl.startsWith('file://')) {
    if (!deps.env.ALLOW_LOCAL_SOURCES)
      throw badRequest(
        'local_sources_disabled',
        'Local file:// sources are only allowed in development.',
      );
    const path = resolve(fileURLToPath(repoUrl));
    const s = await stat(path).catch(() => null);
    if (!s?.isDirectory()) throw badRequest('source_not_found', `No directory at ${path}`);
    const name = basename(path);
    // Local sources have no commits; fingerprint the directory's mtime instead.
    const sha = createHash('sha1').update(`${path}:${s.mtimeMs}`).digest('hex');
    return {
      kind: 'local',
      repo: { owner: 'local', repo: name },
      fullName: `local/${name}`,
      repoUrl,
      ref: ref ?? 'local',
      commitSha: sha,
      branch: 'local',
      commitMessage: `local directory ${name}`,
      defaultBranch: 'local',
      installationId: null,
      localPath: path,
    };
  }
  let repo: RepoRef;
  try {
    repo = parseRepoUrl(repoUrl);
  } catch (err) {
    throw badRequest('invalid_repo_url', (err as Error).message);
  }
  const installation = await usableInstallation(deps, repo, actor);
  const installationId = installation?.id ?? null;
  // Installation-scoped requests skip the shared ETag cache, so one org's
  // private-repo metadata is never served to another.
  const github = installationId
    ? new GitHubClient({ token: () => readToken(deps, installationId) as Promise<string> })
    : deps.github;
  const c = await github.resolveCommit(repo, ref);
  return {
    kind: 'github',
    repo,
    fullName: `${repo.owner}/${repo.repo}`,
    repoUrl: `https://github.com/${repo.owner}/${repo.repo}`,
    ref: ref ?? c.defaultBranch,
    commitSha: c.sha,
    branch: c.branch,
    commitMessage: c.message,
    defaultBranch: c.defaultBranch,
    installationId,
    installationAccount: installation?.account ?? null,
  };
}

// Analysis runs inside the API (512 MB): a smaller download cap than builds
// get, and one uncached analysis per account at a time, so a burst of large
// repositories can't fill its disk or memory.
const ANALYSIS_LIMITS = { maxBytes: 100 * 1024 * 1024, maxFiles: 20_000 };
const ANALYSIS_LOCK_S = 120;

export async function analyzeSource(
  deps: Deps,
  src: ResolvedSource,
  rootDir = '.',
  orgId?: string,
): Promise<Analysis> {
  const cacheKey = `analysis:v${ANALYSIS_VERSION}:${src.fullName}:${src.commitSha}:${rootDir}`;
  const cached = src.kind === 'github' ? await deps.valkey.get(cacheKey) : null;
  if (cached) return JSON.parse(cached) as Analysis;

  const lock = orgId ? `analysis-running:${orgId}` : null;
  if (lock && (await deps.valkey.set(lock, '1', 'EX', ANALYSIS_LOCK_S, 'NX')) !== 'OK')
    throw new AppError(
      429,
      'analysis_busy',
      'Another analysis is running for this account. Try again in a moment.',
      { headers: { 'retry-after': '10' } },
    );
  try {
    return await analyzeUncached(deps, src, rootDir, cacheKey);
  } finally {
    if (lock) await deps.valkey.del(lock);
  }
}

async function analyzeUncached(
  deps: Deps,
  src: ResolvedSource,
  rootDir: string,
  cacheKey: string,
): Promise<Analysis> {
  await mkdir(deps.env.WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(deps.env.WORK_DIR, 'analyze-'));
  try {
    if (src.kind === 'local' && src.localPath) await copyLocalSource(src.localPath, dir);
    else
      await downloadTarball(
        src.repo,
        src.commitSha,
        dir,
        await readToken(deps, src.installationId),
        ANALYSIS_LIMITS,
      );
    const tree = await readTree(dir);
    // A folder that isn't there is an answer, not a reason to analyze the top level.
    const sub = rootDir.replace(/^\.(\/|$)/, '').replace(/\/$/, '');
    if (sub && !tree.files.some((f) => f.startsWith(`${sub}/`)))
      throw badRequest('root_dir_not_found', `There's no folder ${sub} in this repository.`);
    const analysis = analyze(tree, rootDir);
    if (src.kind === 'github')
      await deps.valkey.set(cacheKey, JSON.stringify(analysis), 'EX', 7 * 24 * 3600);
    return analysis;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function suggestSlug(fullName: string): string {
  const repo = fullName.split('/')[1] ?? fullName;
  return slugify(repo) || 'site';
}
