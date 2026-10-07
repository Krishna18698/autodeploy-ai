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
import { badRequest } from '../lib/errors.js';

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
export type SourceActor = { login: string; orgId: string };

/**
 * The App installation this actor may use for the repo. Another account's
 * installation is never used, so one tenant can't read another's private repo
 * just because the App can.
 */
async function usableInstallation(deps: Deps, repo: RepoRef, actor: SourceActor) {
  const inst = deps.installations ? await deps.installations.forRepo(repo) : null;
  if (!inst) return null;
  if (inst.account.toLowerCase() === actor.login.toLowerCase()) return inst;
  const [claimed] = await deps.sql<{ id: string }[]>`
    select id from github_installations where id = ${inst.id} and org_id = ${actor.orgId}`;
  return claimed ? inst : null;
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

export async function analyzeSource(
  deps: Deps,
  src: ResolvedSource,
  rootDir = '.',
): Promise<Analysis> {
  const cacheKey = `analysis:v${ANALYSIS_VERSION}:${src.fullName}:${src.commitSha}:${rootDir}`;
  const cached = src.kind === 'github' ? await deps.valkey.get(cacheKey) : null;
  if (cached) return JSON.parse(cached) as Analysis;

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
      );
    const tree = await readTree(dir);
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
