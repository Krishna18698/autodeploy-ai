import { analyze, buildConfigFrom } from '@autodeploy/core';
import { describe, expect, it } from 'vitest';
import { tree } from './tree';

const pkg = (deps: Record<string, string>, scripts: Record<string, string> = { build: 'x' }) => ({
  'package.json': { scripts, dependencies: deps },
  'package-lock.json': '{}',
});

describe('server-rendered frameworks beyond Next.js', () => {
  it.each([
    [
      'Nuxt',
      pkg({ nuxt: '^4.0.0' }, { build: 'nuxt build' }),
      {
        framework: 'nuxt',
        bundle: 'output-dir',
        dir: '.output',
        start: 'node server/index.mjs',
        assets: '.output/public',
      },
    ],
    [
      'SolidStart',
      pkg({ '@solidjs/start': '^1.0.0', vinxi: '^0.5.0' }, { build: 'vinxi build' }),
      { framework: 'solid-start', bundle: 'output-dir', start: 'node server/index.mjs' },
    ],
    [
      'SvelteKit with adapter-node',
      {
        ...pkg({ '@sveltejs/kit': '^2.0.0', vite: '^7.0.0' }),
        'svelte.config.js': "import adapter from '@sveltejs/adapter-node';",
      },
      { framework: 'sveltekit', bundle: 'project', start: 'node build', assets: 'build/client' },
    ],
    [
      'SvelteKit 3 (adapter in vite.config)',
      {
        ...pkg({ '@sveltejs/kit': '^3.0.0', vite: '^8.0.0' }),
        'vite.config.js':
          "import adapter from '@sveltejs/adapter-node'; export default { plugins: [sveltekit({ adapter: adapter() })] }",
      },
      { framework: 'sveltekit', bundle: 'project', start: 'node build' },
    ],
    [
      'Remix (its start script)',
      pkg(
        { '@remix-run/node': '^2.0.0', '@remix-run/dev': '^2.0.0', vite: '^5.0.0' },
        { build: 'remix vite:build', start: 'remix-serve ./build/server/index.js' },
      ),
      {
        framework: 'remix',
        bundle: 'project',
        start: 'remix-serve ./build/server/index.js',
        assets: 'build/client',
      },
    ],
    [
      'React Router (default server)',
      pkg(
        { '@react-router/dev': '^7.0.0', '@react-router/serve': '^7.0.0' },
        { build: 'react-router build' },
      ),
      {
        framework: 'react-router',
        bundle: 'project',
        start: 'react-router-serve ./build/server/index.js',
      },
    ],
    [
      'Astro with @astrojs/node',
      {
        ...pkg({ astro: '^5.0.0', '@astrojs/node': '^9.0.0' }),
        'astro.config.mjs': "export default { output: 'server' }",
      },
      {
        framework: 'astro',
        bundle: 'project',
        start: 'node ./dist/server/entry.mjs',
        assets: 'dist/client',
      },
    ],
    [
      'Express with a build step',
      pkg({ express: '^5.0.0' }, { build: 'tsc', start: 'node dist/server.js' }),
      { framework: 'node', bundle: 'project', start: 'node dist/server.js' },
    ],
    [
      'any Node server with only a start script',
      pkg({}, { start: 'node index.js' }),
      { framework: 'node', bundle: 'project', start: 'node index.js' },
    ],
    [
      'Vite SSR with a start script',
      {
        ...pkg(
          { vite: '^7.0.0', vike: '^0.4.0' },
          { build: 'vite build', start: 'node server.js' },
        ),
        'vite.config.ts':
          "import vike from 'vike/plugin'; export default { ssr: {}, plugins: [vike()] }",
      },
      { framework: 'vite', bundle: 'project', start: 'node server.js' },
    ],
  ])('%s runs as a server', (_name, files, want) => {
    const a = analyze(tree(files));
    expect(a.supported, a.unsupportedReason).toBe(true);
    expect(a.framework.value).toBe(want.framework);
    expect(a.mode.value).toBe('ssr');
    expect(a.server?.value).toMatchObject(
      Object.fromEntries(Object.entries(want).filter(([k]) => k !== 'framework')),
    );
    expect(buildConfigFrom(a)).toMatchObject({ mode: 'ssr', server: { start: want.start } });
  });

  it.each([
    ['Nuxt generate', pkg({ nuxt: '^4.0.0' }, { build: 'nuxt generate' }), '.output/public'],
    [
      'SvelteKit with adapter-static',
      {
        ...pkg({ '@sveltejs/kit': '^2.0.0' }),
        'svelte.config.js':
          "import adapter from '@sveltejs/adapter-static'; export default { kit: { adapter: adapter({ pages: 'public' }) } }",
      },
      'public',
    ],
    [
      'React Router in SPA mode',
      {
        ...pkg({ '@react-router/dev': '^7.0.0' }),
        'react-router.config.ts': 'export default { ssr: false }',
      },
      'build/client',
    ],
  ])('%s is a static site', (_name, files, outputDir) => {
    const a = analyze(tree(files));
    expect(a.mode.value).toBe('static');
    expect(a.outputDir.value).toBe(outputDir);
    expect(a.server).toBeUndefined();
  });

  it.each([
    [
      'SvelteKit with adapter-auto',
      {
        ...pkg({ '@sveltejs/kit': '^2.0.0' }),
        'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';",
      },
      /adapter-node/,
    ],
    [
      'Astro server without an adapter',
      { ...pkg({ astro: '^5.0.0' }), 'astro.config.mjs': "export default { output: 'server' }" },
      /@astrojs\/node/,
    ],
    [
      'Vite SSR without a start script',
      {
        ...pkg({ vite: '^7.0.0', vike: '^0.4.0' }),
        'vite.config.ts': 'export default { ssr: {}, plugins: [vike()] }',
      },
      /start/,
    ],
  ])('%s explains what to change', (_name, files, reason) => {
    const a = analyze(tree(files));
    expect(a.supported).toBe(false);
    expect(a.unsupportedReason).toMatch(reason);
  });

  it('Next.js keeps its standalone server', () => {
    const a = analyze(tree(pkg({ next: '^16.0.0' }, { build: 'next build' })));
    expect(a.server?.value).toEqual({ bundle: 'next-standalone', start: 'node server.js' });
  });

  it('a plain Vite app is still a static site (not mistaken for a server)', () => {
    const a = analyze(tree(pkg({ vite: '^7.0.0' }, { build: 'vite build', dev: 'vite' })));
    expect(a.mode.value).toBe('static');
    expect(a.framework.value).toBe('vite');
  });
});
