import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildConfig } from '@autodeploy/core';
import { describe, expect, it } from 'vitest';
import { inspectBuild } from '../../apps/worker/src/executors/inspect';

// What a finished build produced, wherever it ran (the sandbox, or GitHub
// Actions with its output unpacked into the checkout).
const checkout = async (files: Record<string, string>) => {
  // Real path: inside() resolves links (on a Mac, /var is /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'built-')));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
};
const inspect = async (srcDir: string, config: Partial<BuildConfig>) => {
  const lines: string[] = [];
  const r = await inspectBuild(
    {
      srcDir,
      config: { rootDir: '.', outputDir: 'dist', mode: 'static', ...config } as BuildConfig,
      log: { write: (l: string) => void lines.push(l) },
    },
    0,
    1234,
  );
  return { r, lines };
};

describe('finding what a build produced', () => {
  it('a static site: its output folder, with an index.html', async () => {
    const src = await checkout({ 'dist/index.html': '<h1>hi</h1>' });
    const { r } = await inspect(src, {});
    expect(r).toEqual({ ok: true, outputDir: join(src, 'dist'), durationMs: 1234 });
  });

  it('no index.html where expected: says so, and lists where index.html files are', async () => {
    const src = await checkout({ 'build/index.html': 'x', 'dist/app.js': 'x' });
    const { r, lines } = await inspect(src, {});
    expect(r).toMatchObject({ ok: false, reason: 'output_missing', indexDirs: ['build'] });
    expect(lines[0]).toContain('has no index.html');
  });

  it('a Next.js server: the standalone server, even nested in a monorepo', async () => {
    const src = await checkout({ '.next/standalone/apps/web/server.js': '' });
    const { r } = await inspect(src, {
      mode: 'ssr',
      outputDir: '.next',
      server: { bundle: 'next-standalone' } as BuildConfig['server'],
    });
    expect(r).toMatchObject({ ok: true, serverDir: join(src, '.next/standalone/apps/web') });
  });

  it('refuses a root folder outside the checkout', async () => {
    const src = await checkout({ 'dist/index.html': 'x' });
    const { r, lines } = await inspect(src, { rootDir: '../elsewhere' });
    expect(r).toMatchObject({ ok: false, reason: 'failed' });
    expect(lines[0]).toContain('nothing was published');
  });
});
