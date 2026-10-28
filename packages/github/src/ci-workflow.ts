import { CI_WORKFLOW_VERSION } from '@autodeploy/core';
import { CI_RUNNER_SOURCE } from './ci-runner-source.js';

/** The workflow file the GitHub App adds to the user's repository. */
export function ciWorkflowYaml(): string {
  // The runner's own text (ci-runner.cjs), indented into the run block.
  const indented = CI_RUNNER_SOURCE.trimEnd()
    .split('\n')
    .map((l) => (l ? `          ${l}` : ''))
    .join('\n');
  return `# AutoDeploy builds this repository's sites here (workflow v${CI_WORKFLOW_VERSION}).
# Added by the AutoDeploy GitHub App, which starts it for each deployment; it
# sends back only the build's log and output. Changes are replaced by updates.
name: AutoDeploy build
run-name: AutoDeploy \${{ fromJSON(inputs.job).label }}
on:
  workflow_dispatch:
    inputs:
      job:
        description: What to build (set by AutoDeploy)
        required: true
        type: string
permissions:
  contents: read
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ fromJSON(inputs.job).sha }}
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ fromJSON(inputs.job).node }}
      - name: Build and send to AutoDeploy
        env:
          AUTODEPLOY_JOB: \${{ inputs.job }}
        run: |
          cat > "$RUNNER_TEMP/autodeploy.cjs" <<'AUTODEPLOY_RUNNER'
${indented}
          AUTODEPLOY_RUNNER
          node "$RUNNER_TEMP/autodeploy.cjs"
`;
}

/** The workflow version a file declares (0 when it isn't ours). */
export function ciWorkflowVersion(text: string): number {
  return Number(/\(workflow v(\d+)\)/.exec(text)?.[1] ?? 0);
}
