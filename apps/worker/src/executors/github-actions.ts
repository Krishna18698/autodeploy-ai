import type { ExecuteInput, ExecuteResult, Executor } from './types.js';

// Second executor: builds run as a workflow in the *user's own* repository
// (the use GitHub's Actions terms allow), dispatched by the GitHub App. The
// workflow streams logs back to the API (authenticated with the job's OIDC
// token) and uploads its output for us to store. It needs the GitHub App, so
// until the App exists this executor reports itself unavailable.

export class GitHubActionsExecutor implements Executor {
  readonly name = 'github_actions' as const;
  constructor(private readonly configured: boolean) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    input.log.write(
      'autodeploy: the GitHub Actions executor needs the GitHub App, which is not configured on this server',
    );
    input.log.write(
      'autodeploy: switch the project executor to "sandbox", or configure the GitHub App',
    );
    return { ok: false, exitCode: null, reason: 'failed', durationMs: 0, indexDirs: [] };
  }

  get available() {
    return this.configured;
  }
}
