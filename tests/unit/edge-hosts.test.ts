import { describe, expect, it } from 'vitest';
import { decodePath, movedHost } from '../../apps/edge/src/index';

const env = { PLATFORM_DOMAIN: 'autodeploy.fyi', SITES_DOMAIN: 'autodeploy.dpdns.org' };

describe('which domain an address belongs on', () => {
  it.each([
    // Site addresses on the dashboard's domain move to the sites domain.
    ['shop.autodeploy.fyi', 'shop.autodeploy.dpdns.org'],
    ['pr-4--shop.autodeploy.fyi', 'pr-4--shop.autodeploy.dpdns.org'],
    ['d12--shop.autodeploy.fyi', 'd12--shop.autodeploy.dpdns.org'],
    // The dashboard's earlier names on the sites domain point back to it.
    ['app.autodeploy.dpdns.org', 'app.autodeploy.fyi'],
    ['www.autodeploy.dpdns.org', 'app.autodeploy.fyi'],
    ['autodeploy.dpdns.org', 'app.autodeploy.fyi'],
    // Already in the right place, or not ours to move.
    ['shop.autodeploy.dpdns.org', null],
    ['app.autodeploy.fyi', null],
    ['api.autodeploy.fyi', null],
    ['www.autodeploy.fyi', null],
    ['autodeploy.fyi', null],
    ['a.b.autodeploy.fyi', null],
    ['evilautodeploy.fyi', null],
  ])('%s → %s', (host, to) => {
    expect(movedHost(host, env)).toBe(to);
  });

  it('moves nothing when sites share the dashboard domain (local development)', () => {
    expect(
      movedHost('shop.autodeploy.localhost', { PLATFORM_DOMAIN: 'autodeploy.localhost' }),
    ).toBeNull();
  });
});

describe('turning a URL path into a storage key', () => {
  it('decodes, and answers null (not a crash) for malformed encoding', () => {
    expect(decodePath('/assets/a%20b.css')).toBe('assets/a b.css');
    expect(decodePath('/%')).toBeNull();
    expect(decodePath('/%E0%A4%A')).toBeNull();
  });
});
