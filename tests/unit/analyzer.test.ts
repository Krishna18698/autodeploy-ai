import { analyze, buildConfigFrom } from '@autodeploy/core';
import { describe, expect, it } from 'vitest';
import { tree } from './tree';

describe('analyzer', () => {
  it('detects a Vite app with pnpm and resolves Node from the framework floor', () => {
    const a = analyze(
      tree({
        'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '^7.1.0' } },
        'pnpm-lock.yaml': 'lockfileVersion: 9',
        'index.html': '<html></html>',
        'src/main.ts': 'console.log(import.meta.env.VITE_API_URL)',
      }),
    );
    expect(a.framework.value).toBe('vite');
    expect(a.packageManager.value).toBe('pnpm');
    expect(a.installCommand.value).toBe('pnpm install --frozen-lockfile');
    expect(a.buildCommand.value).toBe('pnpm run build');
    expect(a.outputDir.value).toBe('dist');
    expect(a.mode.value).toBe('static');
    expect(a.node.value).toBe(22); // vite 7 needs >=20.19; 22 is the platform default and satisfies it
    expect(a.envVars.value).toEqual(['VITE_API_URL']);
    expect(a.supported).toBe(true);
    expect(a.framework.evidence[0]?.detail).toContain('vite');
  });

  it('honours .nvmrc over engines and the framework floor', () => {
    const a = analyze(
      tree({
        'package.json': {
          engines: { node: '>=18' },
          scripts: { build: 'x' },
          dependencies: { vite: '7.0.0' },
        },
        '.nvmrc': 'v20.11.0',
      }),
    );
    expect(a.node.value).toBe(20);
    expect(a.node.evidence[0]?.source).toBe('.nvmrc');
    // We build on the latest 20.x, which satisfies vite 7's >=20.19: no warning.
    expect(a.warnings.some((w) => w.includes('vite@7 requires'))).toBe(false);
    const old = analyze(
      tree({
        'package.json': { scripts: { build: 'x' }, dependencies: { vite: '7.0.0' } },
        '.nvmrc': '18',
      }),
    );
    expect(old.node.value).toBe(18);
    expect(old.warnings.some((w) => w.includes('vite@7 requires Node >=20.19'))).toBe(true);
  });

  it('reads a custom Vite outDir and base path', () => {
    const a = analyze(
      tree({
        'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '^6.0.0' } },
        'vite.config.ts': "export default { base: '/app/', build: { outDir: 'public_out' } }",
      }),
    );
    expect(a.outputDir.value).toBe('public_out');
    expect(a.basePath).toBe('/app/');
    expect(a.warnings.some((w) => w.includes('base path'))).toBe(true);
  });

  it('accepts a statically exported Next.js app and rejects an SSR one', () => {
    const exported = analyze(
      tree({
        'package.json': { dependencies: { next: '16.2.0' }, scripts: { build: 'next build' } },
        'next.config.mjs': "export default { output: 'export' }",
      }),
    );
    expect(exported.mode.value).toBe('static');
    expect(exported.outputDir.value).toBe('out');
    expect(exported.supported).toBe(true);
    const ssr = analyze(
      tree({
        'package.json': { dependencies: { next: '16.2.0' }, scripts: { build: 'next build' } },
        'next.config.mjs': 'export default {}',
      }),
    );
    expect(ssr.mode.value).toBe('ssr');
    expect(ssr.supported).toBe(false);
  });

  it('treats a repo with only index.html as a static site with no build', () => {
    const a = analyze(tree({ 'index.html': '<h1>hi</h1>', 'style.css': '' }));
    expect(a.framework.value).toBe('static');
    expect(a.buildCommand.value).toBeNull();
    expect(a.installCommand.value).toBeNull();
    expect(a.outputDir.value).toBe('.');
  });

  it('prefers packageManager from package.json and warns about multiple lockfiles', () => {
    const a = analyze(
      tree({
        'package.json': { packageManager: 'yarn@4.5.0', scripts: { build: 'x' } },
        'yarn.lock': '',
        'package-lock.json': '{}',
      }),
    );
    expect(a.packageManager.value).toBe('yarn');
    expect(a.packageManager.version).toBe('4.5.0');
    expect(a.warnings.some((w) => w.startsWith('Multiple lockfiles'))).toBe(true);
  });

  it('flags monorepos and unknown setups', () => {
    expect(
      analyze(tree({ 'package.json': { workspaces: ['apps/*'] }, 'pnpm-workspace.yaml': '' }))
        .monorepo,
    ).toBe(true);
    const none = analyze(tree({ 'README.md': 'hi' }));
    expect(none.supported).toBe(false);
  });

  it('builds a config where project overrides win', () => {
    const a = analyze(
      tree({
        'package.json': { scripts: { build: 'vite build' }, devDependencies: { vite: '7.0.0' } },
      }),
    );
    const c = buildConfigFrom(a, { outputDir: 'build', nodeVersion: 24 });
    expect(c).toMatchObject({
      outputDir: 'build',
      nodeVersion: 24,
      buildCommand: 'npm run build',
      installCommand: 'npm install',
    });
  });
});
