// Writes src/ci-runner-source.ts: the text of src/ci-runner.cjs, which the
// workflow file embeds as it is. Run after editing the runner:
//   pnpm --filter @autodeploy/github gen:ci-runner
import { readFileSync, writeFileSync } from 'node:fs';

const runner = readFileSync(new URL('../src/ci-runner.cjs', import.meta.url), 'utf8');
writeFileSync(
  new URL('../src/ci-runner-source.ts', import.meta.url),
  `// Generated from ci-runner.cjs by scripts/embed-ci-runner.mjs; do not edit.\nexport const CI_RUNNER_SOURCE =\n  // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source, kept as text\n  ${JSON.stringify(runner)};\n`,
);
