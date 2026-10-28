import { CI_WORKFLOW_PATH, CI_WORKFLOW_VERSION } from '@autodeploy/core';
import { withOrg } from '@autodeploy/db';
import { ciWorkflowVersion, ciWorkflowYaml, GitHubClient, parseRepoUrl } from '@autodeploy/github';
import type { Deps } from '../deps.js';
import { notFound } from '../lib/errors.js';

// Building a project in the user's own GitHub Actions (ADR 0010) needs
// AutoDeploy's workflow on the project's branch. The GitHub App adds it as a
// pull request the owner merges; until then the project can't switch.

export type ActionsSetup = {
  /**
   * unavailable: no GitHub App installation on the repository; missing or
   * outdated: no (current) workflow on the branch; pr_open: a setup pull
   * request waits to be merged; ready: projects can build there.
   */
  state: 'unavailable' | 'missing' | 'outdated' | 'pr_open' | 'ready';
  branch: string;
  prUrl?: string;
};

const SETUP_BRANCH = 'autodeploy/github-actions';

type ProjectRow = { repo_url: string; default_branch: string; installation_id: number | null };

async function project(deps: Deps, orgId: string, id: string): Promise<ProjectRow> {
  const [p] = await withOrg(
    deps.sql,
    orgId,
    (tx) =>
      tx<
        ProjectRow[]
      >`select repo_url, default_branch, installation_id from projects where id = ${id}`,
  );
  if (!p) throw notFound('Project');
  return p;
}

function client(deps: Deps, p: ProjectRow): GitHubClient | null {
  const installations = deps.installations;
  const id = p.installation_id;
  return installations && id ? new GitHubClient({ token: () => installations.get(id) }) : null;
}

/** Where a project stands: can it build on GitHub Actions yet? */
export async function actionsSetup(deps: Deps, orgId: string, id: string): Promise<ActionsSetup> {
  const p = await project(deps, orgId, id);
  const branch = p.default_branch;
  const gh = client(deps, p);
  if (!gh) return { state: 'unavailable', branch };
  const r = parseRepoUrl(p.repo_url);
  const text = await gh.fileText(r, CI_WORKFLOW_PATH, branch);
  const version = text ? ciWorkflowVersion(text) : 0;
  if (version >= CI_WORKFLOW_VERSION) return { state: 'ready', branch };
  const open = await gh.get<{ html_url: string; head: { ref: string } }[]>(
    `/repos/${r.owner}/${r.repo}/pulls?state=open&per_page=50`,
  );
  const pr = open.find((x) => x.head.ref.startsWith(SETUP_BRANCH));
  if (pr) return { state: 'pr_open', branch, prUrl: pr.html_url };
  return { state: version ? 'outdated' : 'missing', branch };
}

/** Opens the setup pull request (unless one is open, or it isn't needed). */
export async function openActionsSetup(
  deps: Deps,
  orgId: string,
  id: string,
): Promise<ActionsSetup> {
  const now = await actionsSetup(deps, orgId, id);
  if (now.state !== 'missing' && now.state !== 'outdated') return now;
  const p = await project(deps, orgId, id);
  const gh = client(deps, p);
  if (!gh) return { state: 'unavailable', branch: now.branch };
  const r = parseRepoUrl(p.repo_url);
  const head = await gh.get<{ object: { sha: string } }>(
    `/repos/${r.owner}/${r.repo}/git/ref/heads/${encodeURIComponent(now.branch)}`,
  );
  const prUrl = await gh.openPullRequest(r, {
    base: now.branch,
    baseSha: head.object.sha,
    // Unique: an earlier, closed setup PR may have left its branch behind.
    branch: `${SETUP_BRANCH}-v${CI_WORKFLOW_VERSION}-${Date.now().toString(36)}`,
    title:
      now.state === 'outdated'
        ? 'Update the AutoDeploy build workflow'
        : 'Build with AutoDeploy on GitHub Actions',
    body: [
      `Adds \`${CI_WORKFLOW_PATH}\`, so AutoDeploy can build this repository's sites on GitHub Actions instead of on its own servers.`,
      '',
      '- It runs only when AutoDeploy starts it, for a deployment of this repository.',
      "- It needs no secrets in this repository: it proves itself to AutoDeploy with the job's own GitHub token, and receives the project's environment variables for that build only (masked in the log).",
      '- It sends back only the build log and the built files.',
      "- Builds use this repository's Actions minutes (unlimited on public repositories).",
      '',
      "Merge this, then choose **Build on: GitHub Actions** in the project's settings on AutoDeploy.",
    ].join('\n'),
    files: [{ path: CI_WORKFLOW_PATH, content: ciWorkflowYaml() }],
  });
  return { state: 'pr_open', branch: now.branch, prUrl };
}
