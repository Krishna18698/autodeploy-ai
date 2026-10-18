import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerArgs } from '../../apps/worker/src/gateway/runtimes';
import {
  assembleServer,
  BUNDLE_EXCLUDES,
  packRuntimeBundle,
} from '../../apps/worker/src/pipeline/runtime-bundle';

const envCfg = {
  SANDBOX_RUNTIME: 'runsc',
  RUNTIME_REACH: 'network',
  RUNTIME_NETWORK: 'autodeploy-runtime',
  RUNTIME_MEMORY: '256m',
  RUNTIME_CPUS: '0.5',
} as const;
const base = {
  container: 'c',
  deploymentId: 'd',
  bundle: '/b',
  image: 'img:22',
  env: { PORT: '3000' },
  env_: envCfg,
};

describe('starting a server container', () => {
  it('keeps Next.js deployments exactly as before (server.js, .next/cache tmpfs)', () => {
    const a = containerArgs({ ...base, command: 'node server.js', workdir: '.' });
    expect(a.slice(-3)).toEqual(['sh', '-c', 'exec node server.js']);
    expect(a.join(' ')).toContain('/app/.next/cache:rw');
    expect(a[a.indexOf('-w') + 1]).toBe('/app');
  });

  it('runs any start command in the project directory with its binaries on PATH', () => {
    const a = containerArgs({
      ...base,
      command: 'react-router-serve ./build/server/index.js',
      workdir: 'apps/web',
    });
    expect(a[a.indexOf('-w') + 1]).toBe('/app/apps/web');
    expect(a.join(' ')).not.toContain('.next/cache');
    expect(a).toContain(
      'PATH=/app/apps/web/node_modules/.bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin',
    );
    expect(a.at(-1)).toBe('exec react-router-serve ./build/server/index.js');
    expect(a).toContain('--read-only');
    expect(a).toContain('--runtime=runsc');
  });

  it('leaves compound commands to the shell, and never leaves the bundle', () => {
    expect(
      containerArgs({ ...base, command: 'npm run migrate && node app.js', workdir: '.' }).at(-1),
    ).toBe('npm run migrate && node app.js');
    const a = containerArgs({ ...base, command: 'node x', workdir: '../../etc' });
    expect(a[a.indexOf('-w') + 1]).toBe('/app/etc');
  });
});

describe('bundling a server', () => {
  it('uses the checkout as it is, copies the static files out, and leaves caches behind', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'bundle-'));
    for (const [p, c] of Object.entries({
      'apps/web/build/index.js': 'server',
      'apps/web/build/client/_app/a.js': 'asset',
      'apps/web/node_modules/dep/index.js': 'dep',
      'apps/web/node_modules/.cache/big': 'cache',
      'node_modules/hoisted/index.js': 'hoisted',
      '.git/HEAD': 'ref',
    })) {
      await mkdir(join(repo, p, '..'), { recursive: true });
      await writeFile(join(repo, p), c);
    }
    const out = await mkdtemp(join(tmpdir(), 'bundle-out-'));
    const r = await assembleServer(
      { bundle: 'project', start: 'node build', assets: 'build/client' },
      join(repo, 'apps/web'),
      repo,
      'apps/web',
      out,
    );
    expect(r.workdir).toBe('apps/web');
    expect(r.bundleDir).toBe(repo);
    const packed = await packRuntimeBundle(r.bundleDir, {
      file: join(out, 'b.tgz'),
      excludes: BUNDLE_EXCLUDES,
    });
    const files = execFileSync('tar', ['-tzf', packed.file], { encoding: 'utf8' });
    expect(files).toContain('apps/web/build/index.js');
    expect(files).toContain('node_modules/hoisted/index.js');
    expect(files).not.toContain('.git/');
    expect(files).not.toContain('.cache/');
    expect(execFileSync('ls', [join(r.assetsDir, '_app')], { encoding: 'utf8' })).toContain('a.js');
  });
});
