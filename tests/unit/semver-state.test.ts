import {
  assertTransition,
  canTransition,
  DEPLOYMENT_STATUSES,
  IllegalTransitionError,
  pickMajor,
  satisfies,
  TRANSITIONS,
  transitionPairs,
} from '@autodeploy/core';
import { describe, expect, it } from 'vitest';

describe('semver', () => {
  it.each([
    [[20, 19, 0], '>=20.19', true],
    [[20, 18, 9], '>=20.19', false],
    [[22, 0, 0], '^20.0.0 || >=22', true],
    [[21, 5, 0], '^20.0.0 || >=22', false],
    [[18, 4, 0], '18.x', true],
    [[20, 1, 0], '~20.1.0', true],
    [[20, 2, 0], '~20.1.0', false],
    [[19, 0, 0], '18 - 20', true],
    [[24, 0, 0], '<24', false],
  ] as const)('%j satisfies %s → %s', (v, range, ok) => {
    expect(satisfies([...v] as [number, number, number], range)).toBe(ok);
  });

  it('picks the highest supported major for a range', () => {
    expect(pickMajor('>=18', [18, 20, 22, 24])).toBe(24);
    expect(pickMajor('^20', [18, 20, 22, 24])).toBe(20);
    expect(pickMajor('>=26', [18, 20, 22, 24])).toBeUndefined();
  });
});

describe('deployment state machine', () => {
  it('allows every listed transition and rejects every other pair', () => {
    for (const from of DEPLOYMENT_STATUSES) {
      for (const to of DEPLOYMENT_STATUSES) {
        const allowed = TRANSITIONS[from].includes(to);
        expect(canTransition(from, to)).toBe(allowed);
        if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
      }
    }
  });

  it('keeps terminal states terminal and every non-terminal state reachable', () => {
    expect(TRANSITIONS.FAILED).toEqual([]);
    expect(TRANSITIONS.CANCELED).toEqual([]);
    const reachable = new Set(transitionPairs().map(([, to]) => to));
    for (const s of DEPLOYMENT_STATUSES) if (s !== 'CREATED') expect(reachable.has(s)).toBe(true);
  });

  it('never lets a failed repair become success without validation', () => {
    expect(canTransition('RECOVERING', 'READY')).toBe(false);
    expect(canTransition('RECOVERING', 'ACTIVE')).toBe(false);
    expect(canTransition('BUILD_FAILED', 'READY')).toBe(false);
  });
});
