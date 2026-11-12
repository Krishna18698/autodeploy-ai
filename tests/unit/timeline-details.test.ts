import { describe, expect, it } from 'vitest';
import { eventDetails } from '../../apps/web/lib/timeline';

const text = (payload: Record<string, unknown>) =>
  eventDetails(payload).map((d) => `${d.key}: ${d.text}`);

describe('timeline event details', () => {
  it('names durations, sizes, hashes and commits the way a person reads them', () => {
    expect(
      text({
        buildMs: 105612,
        attemptNo: 1,
        commitSha: '54b2f7d515ed3cdb3594517bd91745007e5cb6b3',
        skipped: false,
      }),
    ).toEqual(['build: 1m 46s', 'attempt no: 1', 'commit: 54b2f7d…', 'skipped: no']);
  });

  it('lists what is in an array, and says how many more there are', () => {
    const missing = Array.from({ length: 11 }, (_, i) => `VAR_${i}`);
    expect(text({ missing })).toEqual([
      'missing: VAR_0, VAR_1, VAR_2, VAR_3, VAR_4, VAR_5, VAR_6, VAR_7 and 3 more',
    ]);
  });

  it('flattens a nested record instead of printing JSON', () => {
    const [runtime] = text({
      runtime: { bytes: 26802395, reused: false, sha256: 'b56ca5f6'.repeat(8) },
    });
    expect(runtime).toMatch(/^runtime: bytes .+, reused no, sha256 b56ca5f6…$/);
    expect(runtime).not.toContain('{');
  });

  it('leaves out what is empty', () => {
    expect(text({ note: '', actor: null, files: [], ref: 'main' })).toEqual(['ref: main']);
  });
});
