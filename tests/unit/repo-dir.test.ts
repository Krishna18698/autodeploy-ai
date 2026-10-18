import { describe, expect, it } from 'vitest';
import { RepoDir } from '../../packages/contracts/src/index';

describe('root and output directories stay inside the repository', () => {
  it.each([
    '.',
    'dist',
    '.next',
    'apps/web',
    'apps/web/',
    './apps/web',
    'tests/e2e/fixtures/ai-ts-error',
    'build/client',
  ])('accepts %s', (dir) => expect(RepoDir.safeParse(dir).success).toBe(true));
  it.each([
    '..',
    '../x',
    'a/../b',
    'a/..',
    '/etc',
    '/',
    'a//b',
    'a\\\\b',
    '~/x',
    '',
    'a/./b',
    '.. ',
  ])('refuses %s', (dir) => expect(RepoDir.safeParse(dir).success).toBe(false));
});

describe('host paths are checked again where they are used', async () => {
  const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { inside, PathEscapeError } = await import('../../apps/worker/src/executors/paths');
  const base = await mkdtemp(join(tmpdir(), 'inside-'));
  await mkdir(join(base, 'apps/web/dist'), { recursive: true });
  await symlink('/etc', join(base, 'apps/web/out'));

  it('resolves directories inside the checkout', async () => {
    expect(await inside(base, 'apps/web')).toMatch(/apps\/web$/);
    expect(await inside(base, '.')).toBe(await inside(base, undefined));
    expect(await inside(base, 'apps/web/not-built-yet')).toMatch(/not-built-yet$/);
  });
  it.each(['../', '/etc', 'apps/../../x', 'apps/web/out'])('refuses %s', async (rel) => {
    await expect(inside(base, rel)).rejects.toBeInstanceOf(PathEscapeError);
  });
});
