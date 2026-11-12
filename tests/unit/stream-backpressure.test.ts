import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { admitStream, caughtUp } from '../../apps/api/src/services/stream';

/** A reader that takes each write at once, a moment later, or never. */
const reader = (pace: 'now' | 'later' | 'never') =>
  new Writable({
    highWaterMark: 16,
    write(_chunk, _enc, done) {
      if (pace === 'now') done();
      else if (pace === 'later') setTimeout(done, 20);
    },
  });
const limits = { maxBufferedBytes: 1_000, stallMs: 1_000 };

describe('the live stream and a slow reader', () => {
  it('goes on at once when nothing is waiting', async () => {
    const r = reader('now');
    r.write('x');
    expect(await caughtUp(r, limits)).toBe(true);
  });

  it('waits for a reader that catches up', async () => {
    const r = reader('later');
    r.write('x'.repeat(100));
    expect(r.writableNeedDrain).toBe(true);
    expect(await caughtUp(r, limits)).toBe(true);
  });

  it('lets go of a reader that stalls', async () => {
    const r = reader('never');
    r.write('x'.repeat(100));
    const started = Date.now();
    expect(await caughtUp(r, { ...limits, stallMs: 50 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('lets go at once of a reader too far behind', async () => {
    const r = reader('never');
    r.write('x'.repeat(2_000));
    expect(await caughtUp(r, limits)).toBe(false);
  });

  it('stops waiting when the reader goes away', async () => {
    const r = reader('never');
    r.write('x'.repeat(100));
    const waiting = caughtUp(r, { ...limits, stallMs: 5_000 });
    r.destroy();
    expect(await waiting).toBe(false);
  });
});

describe('how many live streams may be open', () => {
  const limits = { perUser: 2, total: 3 };
  it('caps one person, frees a place when a stream ends, and caps everyone together', () => {
    const a1 = admitStream('a', limits);
    const a2 = admitStream('a', limits);
    expect(a1 && a2).toBeTruthy();
    expect(admitStream('a', limits)).toBeNull(); // this person's limit
    const b1 = admitStream('b', limits);
    expect(b1).toBeTruthy();
    expect(admitStream('c', limits)).toBeNull(); // everyone's limit
    a1?.();
    a1?.(); // ending twice frees one place, not two
    const c1 = admitStream('c', limits);
    expect(c1).toBeTruthy();
    expect(admitStream('b', limits)).toBeNull();
    for (const release of [a2, b1, c1]) release?.();
    expect(admitStream('a', limits)).toBeTruthy();
  });
});
