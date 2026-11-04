import { describe, expect, it } from 'vitest';
import type { LogLine } from '../../apps/web/components/ui/log-viewer';
import { mergeLogLines } from '../../apps/web/lib/logs';

const lines = (attemptNo: number, from: number, to: number): LogLine[] =>
  Array.from({ length: to - from }, (_, i) => ({ attemptNo, seq: from + i, text: `${from + i}` }));
const keys = (ls: LogLine[]) => ls.map((l) => `${l.attemptNo}:${l.seq}`);

describe('merging log lines', () => {
  it('appends history pages and live batches in order, keeping the same array growing', () => {
    const seen = new Set<string>();
    let log = mergeLogLines([], lines(1, 0, 2000), seen);
    log = mergeLogLines(log, lines(1, 2000, 4000), seen);
    log = mergeLogLines(log, [...lines(1, 4000, 4100), ...lines(2, 0, 900)], seen);
    expect(log).toHaveLength(5000);
    expect(log.at(-1)).toMatchObject({ attemptNo: 2, seq: 899 });
    expect(keys(log)).toEqual([...keys(lines(1, 0, 4100)), ...keys(lines(2, 0, 900))]);
  });

  it('skips lines it has seen (a reconnect replays some) and returns the same log when nothing is new', () => {
    const seen = new Set<string>();
    const log = mergeLogLines([], lines(1, 0, 10), seen);
    const again = mergeLogLines(log, lines(1, 5, 10), seen);
    expect(again).toBe(log);
    expect(mergeLogLines(log, lines(1, 8, 12), seen)).toHaveLength(12);
  });

  it('merges a batch that arrives before earlier lines (the stream ahead of the history) into order', () => {
    const seen = new Set<string>();
    let log = mergeLogLines([], lines(1, 100, 110), seen); // live lines first
    log = mergeLogLines(log, lines(1, 0, 100), seen); // then the history page
    expect(keys(log)).toEqual(keys(lines(1, 0, 110)));
    // An unordered batch is sorted too.
    log = mergeLogLines(log, [...lines(2, 3, 5), ...lines(2, 0, 3)], seen);
    expect(keys(log.slice(-5))).toEqual(keys(lines(2, 0, 5)));
  });
});
