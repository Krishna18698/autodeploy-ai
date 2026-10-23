import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The deploy's connection to the VM drops now and then (2026-10-23: three
// times in an afternoon). infra/deploy/lib/remote.sh must ride through it;
// tests/deploy/remote.test.sh drops the line on purpose against a stand-in VM.
describe('deploys survive a dropped connection to the VM', () => {
  it('retries drops, resends input, runs a long step once and streams its log whole', () => {
    const out = execFileSync('bash', [resolve('tests/deploy/remote.test.sh')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out).toContain('all passed');
  }, 90_000);
});
