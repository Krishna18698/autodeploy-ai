import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Deps } from '../../apps/worker/src/deps';
import { validateSite } from '../../apps/worker/src/pipeline/validate';

// A fake `docker` on PATH: `run` hangs like the validator that once waited
// forever on an orphaned server; `rm` is recorded.
const bin = await mkdtemp(join(tmpdir(), 'fake-docker-'));
const calls = join(bin, 'calls.log');
await writeFile(
  join(bin, 'docker'),
  `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = run ] && exec sleep 30\nexit 0\n`,
);
await chmod(join(bin, 'docker'), 0o755);
const realPath = process.env.PATH;
process.env.PATH = `${bin}:${realPath}`;
afterAll(() => {
  process.env.PATH = realPath;
});

describe('validation has a hard time limit', () => {
  it('fails (not skips) a validator that never finishes, and removes its container', async () => {
    const deps = {
      env: {
        VALIDATOR: 'chromium',
        VALIDATOR_IMAGE: 'validator',
        VALIDATE_TIMEOUT_S: 1,
        SANDBOX_CPU_SHARES: 256,
      },
      log: { debug() {}, warn() {}, info() {} },
    } as unknown as Deps;
    const site = await mkdtemp(join(tmpdir(), 'site-'));
    const out = await mkdtemp(join(tmpdir(), 'out-'));
    const t0 = Date.now();
    const r = await validateSite(deps, site, out, new AbortController().signal);
    const took = Date.now() - t0;
    // It once failed under a full parallel run and not since: every check
    // says what it saw, so a failure explains itself.
    const seen = async () =>
      `took ${took} ms; result ${JSON.stringify(r)}; docker calls:\n${await readFile(calls, 'utf8').catch(() => '(none yet)')}`;
    expect(took, await seen()).toBeLessThan(10_000);
    expect(r.ok, await seen()).toBe(false);
    expect(r.skipped, await seen()).toBe(false);
    expect(r.pageErrors[0], await seen()).toMatch(/did not finish within 1 s/);
    // Both stand-in docker calls run in the background: wait for the run and
    // the rm to be logged (up to 5 s). On a busy machine the run can start
    // after the 1 s limit has already removed the container.
    let log = '';
    const both = () => /--name ad-validate-/.test(log) && /(^|\n)rm -f /.test(log);
    for (let i = 0; i < 50 && !both(); i++) {
      await new Promise((res) => setTimeout(res, 100));
      log = await readFile(calls, 'utf8').catch(() => ''); // not written yet
    }
    const name = /--name (ad-validate-[0-9a-f]+)/.exec(log)?.[1];
    expect(name, await seen()).toBeDefined();
    expect(log, await seen()).toContain(`rm -f ${name}`);
    // Like a build, the site check counts least when CPU is short.
    expect(log, await seen()).toContain('--cpu-shares 256');
  });
});
