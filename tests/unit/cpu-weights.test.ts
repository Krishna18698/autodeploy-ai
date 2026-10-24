import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildConfig } from '@autodeploy/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Deps } from '../../apps/worker/src/deps';
import type { Env } from '../../apps/worker/src/env';
import { SandboxExecutor } from '../../apps/worker/src/executors/sandbox';
import type { LogSink } from '../../apps/worker/src/pipeline/logs';
import { validateSite } from '../../apps/worker/src/pipeline/validate';

// Who gets the VM's 2 CPUs when they're short (capacity test, 2026-10-24):
// the platform (Docker's default weight, 1024), then live sites (512), then
// builds and site checks (256); and in production sites and builds run in CPU
// groups (ship.sh) capped at 75% and 90% of the VM. A stand-in `docker`
// records what it was asked; with `refuse-cgroup` present it refuses any
// --cgroup-parent the way Docker does (exit 125), and every build fails (1).
const bin = await mkdtemp(join(tmpdir(), 'fake-docker-'));
const calls = join(bin, 'calls.log');
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh
echo "$@" >> "${calls}"
case "$*" in *--cgroup-parent*) [ -f "${bin}/refuse-cgroup" ] && exit 125 ;; esac
[ "$1" = run ] && exit 1
exit 0
`,
);
await chmod(join(bin, 'docker'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath}`;
afterAll(() => {
  process.env.PATH = realPath;
});
beforeEach(async () => {
  await writeFile(calls, '');
  await rm(join(bin, 'refuse-cgroup'), { force: true });
});
const runs = async () =>
  (await readFile(calls, 'utf8')).split('\n').filter((l) => l.startsWith('run '));

const env = {
  SANDBOX_RUNTIME: 'runc',
  SANDBOX_NETWORK: 'sandbox',
  SANDBOX_PROXY: 'http://egress:3128',
  SANDBOX_CPUS: '1.5',
  SANDBOX_CPU_SHARES: 256,
  SANDBOX_CGROUP_PARENT: 'autodeploy-builds.slice',
  SANDBOX_MEMORY: '3g',
  SANDBOX_IMAGE_PREFIX: 'autodeploy-build:node',
  BUILD_TIMEOUT_S: 60,
  VALIDATOR: 'chromium',
  VALIDATOR_IMAGE: 'validator',
  VALIDATE_TIMEOUT_S: 30,
} as unknown as Env;

async function build(warnings: string[] = []) {
  const executor = new SandboxExecutor(env, (_f, msg) => warnings.push(msg));
  return executor.execute({
    attemptId: 'attempt-1',
    srcDir: await mkdtemp(join(tmpdir(), 'src-')),
    config: {
      nodeVersion: 22,
      mode: 'static',
      rootDir: '.',
      installCommand: 'npm ci',
      buildCommand: 'npm run build',
      outputDir: 'dist',
      env: {},
    } as unknown as BuildConfig,
    secrets: {},
    log: { write() {} } as unknown as LogSink,
    signal: new AbortController().signal,
  });
}

describe('CPU when the VM is busy', () => {
  it('a build may use 1.5 CPUs when they are spare, counts least when they are not, in the builds group', async () => {
    expect((await build()).ok).toBe(false); // the stand-in fails every build
    const [run] = await runs();
    expect(run).toContain('--cpus 1.5');
    expect(run).toContain('--cpu-shares 256');
    expect(run).toContain('--cgroup-parent autodeploy-builds.slice');
  });

  it('a build Docker will not start in its CPU group runs without it, and says so', async () => {
    await writeFile(join(bin, 'refuse-cgroup'), '');
    const warnings: string[] = [];
    const result = await build(warnings);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.exitCode).toBe(1); // the build itself ran, and failed as the stand-in does
    const [first, second] = await runs();
    expect(first).toContain('--cgroup-parent');
    expect(second).not.toContain('--cgroup-parent');
    expect(second).toContain('--cpu-shares 256');
    expect(warnings).toEqual(['could not start the build in its CPU group; starting it without']);
  });

  it('so does a site check', async () => {
    await writeFile(join(bin, 'refuse-cgroup'), '');
    const warnings: string[] = [];
    const deps = {
      env,
      log: { debug() {}, info() {}, warn: (_f: unknown, m: string) => warnings.push(m) },
    } as unknown as Deps;
    const site = await mkdtemp(join(tmpdir(), 'site-'));
    const out = await mkdtemp(join(tmpdir(), 'out-'));
    await validateSite(deps, site, out, new AbortController().signal);
    const [first, second] = await runs();
    expect(first).toContain('--cgroup-parent autodeploy-builds.slice');
    expect(second).not.toContain('--cgroup-parent');
    expect(warnings[0]).toBe(
      'could not start the site check in its CPU group; starting it without',
    );
  });
});
