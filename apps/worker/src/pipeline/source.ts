import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyLocalSource, downloadTarball, parseRepoUrl } from '@autodeploy/github';
import type { Deps } from '../deps.js';
import { PermanentError } from '../runner.js';

export function workspaceFor(deps: Deps, attemptId: string) {
  const root = join(deps.env.WORK_DIR, 'attempts', attemptId);
  return { root, src: join(root, 'src'), out: join(root, 'out') };
}

/** Puts the exact commit into a fresh workspace directory. */
export async function fetchSource(
  deps: Deps,
  repoUrl: string,
  commitSha: string,
  dest: string,
  installationId: number | null,
): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  if (repoUrl.startsWith('file://')) {
    if (!deps.env.ALLOW_LOCAL_SOURCES) throw new PermanentError('local sources are disabled');
    await copyLocalSource(fileURLToPath(repoUrl), dest);
    return;
  }
  const token =
    installationId && deps.installations
      ? await deps.installations.get(installationId)
      : deps.env.GITHUB_TOKEN;
  await downloadTarball(parseRepoUrl(repoUrl), commitSha, dest, token);
}

export async function cleanupWorkspace(root: string) {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
