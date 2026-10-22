import { describe, expect, it } from 'vitest';
import { safeNext } from '../../apps/web/lib/safe-next';

describe('where sign-in may send you next', () => {
  it.each([
    ['/settings?tab=account', '/settings?tab=account'],
    ['/projects/123', '/projects/123'],
    ['/%2F%2Fevil.com', '/%2F%2Fevil.com'], // stays a path on this site
    // Another host in disguise, or not a path at all.
    ['//evil.com', '/overview'],
    ['/\\evil.com', '/overview'],
    ['/\t/evil.com', '/overview'], // browsers drop tabs: it would become //evil.com
    ['https://evil.com', '/overview'],
    ['javascript:alert(1)', '/overview'],
    ['', '/overview'],
    [null, '/overview'],
  ])('%j → %s', (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});
