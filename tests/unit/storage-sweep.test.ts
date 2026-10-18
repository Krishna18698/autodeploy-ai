import { describe, expect, it } from 'vitest';
import { SWEPT, unreferenced } from '../../apps/worker/src/storage-sweep';

const now = Date.parse('2026-10-19T12:00:00Z');
const old = new Date(now - 3 * 86_400_000);
const fresh = new Date(now - 60_000);
const [logs, shots, runtimes] = SWEPT;
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

describe('sweeping storage nothing refers to', () => {
  it('deletes logs of attempts that no longer exist, once past the grace period', () => {
    const objects = [
      { key: `logs/${a}/00000.log`, modified: old },
      { key: `logs/${b}/00000.log`, modified: old },
      { key: `logs/${b}/00001.log`, modified: fresh },
    ];
    expect(unreferenced(objects, logs.owner, new Set([a]), now, 86_400_000)).toEqual([
      `logs/${b}/00000.log`,
    ]);
  });

  it('matches screenshots and server bundles to their deployments', () => {
    const sha = 'f'.repeat(64);
    expect(shots.owner(`screenshots/${a}.png`)).toBe(a);
    expect(runtimes.owner(`runtimes/${sha}.tar.gz`)).toBe(sha);
    expect(
      unreferenced(
        [{ key: `runtimes/${sha}.tar.gz`, modified: old }],
        runtimes.owner,
        new Set(),
        now,
        0,
      ),
    ).toEqual([`runtimes/${sha}.tar.gz`]);
  });

  it('never touches keys it cannot attribute', () => {
    const objects = [
      { key: 'logs/readme.txt', modified: old },
      { key: 'screenshots/not-a-uuid.png', modified: old },
      { key: 'runtimes/short.tar.gz', modified: old },
    ];
    for (const kind of SWEPT)
      expect(unreferenced(objects, kind.owner, new Set(), now, 0)).toEqual([]);
  });
});
