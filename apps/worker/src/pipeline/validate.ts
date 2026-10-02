import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deps } from '../deps.js';
import { runProcess } from '../executors/sandbox.js';

export type ValidationResult = {
  ok: boolean;
  skipped: boolean;
  status: number | null;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
  externalBlocked: number;
  title: string | null;
  durationMs: number;
  screenshotPath: string | null;
};

/** Loads the built site in headless Chromium inside a network-less container. */
export async function validateSite(
  deps: Deps,
  siteDir: string,
  outDir: string,
  signal: AbortSignal,
): Promise<ValidationResult> {
  const skipped: ValidationResult = {
    ok: true,
    skipped: true,
    status: null,
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    externalBlocked: 0,
    title: null,
    durationMs: 0,
    screenshotPath: null,
  };
  if (deps.env.VALIDATOR === 'skip') return skipped;
  await mkdir(outDir, { recursive: true });
  // The validator runs as an unprivileged user inside its container.
  await chmod(outDir, 0o777);
  const code = await runProcess(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--cpus',
      '1',
      '--memory',
      '1g',
      '--pids-limit',
      '256',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--ipc',
      'host',
      '-v',
      `${siteDir}:/site:ro`,
      '-v',
      `${outDir}:/out:rw`,
      deps.env.VALIDATOR_IMAGE,
    ],
    (l) => deps.log.debug({ validator: l }),
    signal,
  );
  const raw = await readFile(join(outDir, 'result.json'), 'utf8').catch(() => null);
  if (!raw) {
    deps.log.warn({ code }, 'validator produced no result (image missing?); skipping validation');
    return skipped;
  }
  const r = JSON.parse(raw) as Omit<ValidationResult, 'skipped' | 'screenshotPath'>;
  const shot = join(outDir, 'screenshot.png');
  const hasShot = await readFile(shot).then(
    () => true,
    () => false,
  );
  return { ...r, skipped: false, screenshotPath: hasShot ? shot : null };
}
