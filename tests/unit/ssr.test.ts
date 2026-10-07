import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findStandaloneServer } from '../../apps/worker/src/executors/sandbox';

// The runtime egress proxy is a plain .mjs server; import its classifier without listening.
process.env.EGRESS_NO_LISTEN = '1';
const { isPrivateAddress } = (await import('../../infra/sandbox/egress/proxy.mjs')) as {
  isPrivateAddress: (ip: string) => boolean;
};

describe('SSR runtime egress: SSRF guard', () => {
  it.each([
    ['169.254.169.254', true], // cloud metadata
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT
    ['224.0.0.1', true], // multicast
    ['::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:10.0.0.1', true], // IPv4-mapped private
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['2606:4700::1111', false],
  ])('%s is private: %s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('finding the Next.js standalone server', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));
  const make = async (files: string[]) => {
    const root = await mkdtemp(join(tmpdir(), 'standalone-'));
    dirs.push(root);
    for (const f of files) {
      await mkdir(join(root, f, '..'), { recursive: true });
      await writeFile(join(root, f), '');
    }
    return root;
  };

  it('finds server.js at the top of .next/standalone', async () => {
    const root = await make(['server.js', 'node_modules/next/package.json']);
    expect(await findStandaloneServer(root)).toBe(root);
  });

  it('finds it mirrored under the app path in a monorepo, skipping node_modules', async () => {
    const root = await make(['node_modules/x/server.js', 'apps/site/server.js']);
    expect(await findStandaloneServer(root)).toBe(join(root, 'apps/site'));
  });

  it('reports a missing server', async () => {
    const root = await make(['package.json']);
    expect(await findStandaloneServer(root)).toBeNull();
  });
});
