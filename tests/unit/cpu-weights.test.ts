import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildConfig } from '@autodeploy/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Env } from '../../apps/worker/src/env';
import { SandboxExecutor } from '../../apps/worker/src/executors/sandbox';
import type { LogSink } from '../../apps/worker/src/pipeline/logs';

// Who gets the VM's 2 CPUs when they're short (capacity test, 2026-10-24):
// the platform (Docker's default weight, 1024), then live sites (512), then
// builds and site checks (256). A stand-in `docker` records what it was asked.
const bin = await mkdtemp(join(tmpdir(), 'fake-docker-'));
const calls = join(bin, 'calls.log');
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = run ] && exit 1\nexit 0\n`,
);
await chmod(join(bin, 'docker'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath}`;
afterAll(() => {
  process.env.PATH = realPath;
});

describe('CPU when the VM is busy', () => {
  it('a build may use 1.5 CPUs when they are spare, but counts least when they are not', async () => {
    const executor = new SandboxExecutor({
      SANDBOX_RUNTIME: 'runc',
      SANDBOX_NETWORK: 'sandbox',
      SANDBOX_PROXY: 'http://egress:3128',
      SANDBOX_CPUS: '1.5',
      SANDBOX_CPU_SHARES: 256,
      SANDBOX_MEMORY: '3g',
      SANDBOX_IMAGE_PREFIX: 'autodeploy-build:node',
      BUILD_TIMEOUT_S: 60,
    } as unknown as Env);
    const result = await executor.execute({
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
    expect(result.ok).toBe(false); // the stand-in fails every build
    const run = (await readFile(calls, 'utf8')).split('\n').find((l) => l.startsWith('run '));
    expect(run).toContain('--cpus 1.5');
    expect(run).toContain('--cpu-shares 256');
  });
});
