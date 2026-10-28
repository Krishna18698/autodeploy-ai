import {
  type CookieFacts,
  cookiePaths,
  deleteCookies,
  forwardCookies,
  MAX_DELETED_NAMES,
  parentDomain,
  rewriteSetCookies,
  siblingRequest,
} from '@autodeploy/core';
import type { Sql } from '@autodeploy/db';
import { describe, expect, it } from 'vitest';
import { MAX_COOKIE_NAMES, SiteCookieMemory } from '../../apps/worker/src/gateway/cookies';

// The rules for cookies on the sites' shared domain, case by case. The same
// rules in a real browser: site-cookies-browser.test.ts.

const facts = (protect: boolean, sameSite: CookieFacts['sameSite'] = null): CookieFacts => ({
  protect,
  sameSite,
});
const none = new Map<string, CookieFacts>();
const NOW = Date.parse('2026-10-29T00:00:00Z');

describe('what the browser gets from the app (Set-Cookie)', () => {
  it('strips Domain= in any spelling, and keeps everything else as it was', () => {
    const { headers } = rewriteSetCookies(
      [
        'theme=dark; Domain=.autodeploy.dpdns.org; Path=/; Expires=Wed, 21 Oct 2027 07:28:00 GMT',
        'a=1; domain=autodeploy.dpdns.org; DOMAIN=x; SameSite=Lax',
      ],
      none,
      NOW,
    );
    expect(headers).toEqual([
      'theme=dark; Path=/; Expires=Wed, 21 Oct 2027 07:28:00 GMT',
      'a=1; SameSite=Lax',
    ]);
  });

  it('stores a cookie scripts can’t read as __Host-ad_<name>: Path=/, Secure, attributes kept', () => {
    const { headers, learned } = rewriteSetCookies(
      ['sid=abc; Path=/account; HttpOnly; SameSite=Strict; Max-Age=3600; Partitioned; Secure'],
      none,
      NOW,
    );
    expect(headers).toEqual([
      '__Host-ad_sid=abc; HttpOnly; SameSite=Strict; Max-Age=3600; Partitioned; Path=/; Secure',
    ]);
    expect(learned.get('sid')).toEqual(facts(true, 'strict'));
  });

  it('leaves the app’s own __Host- cookies alone (they can’t be planted), and renames __Secure- ones', () => {
    const { headers, learned } = rewriteSetCookies(
      ['__Host-x=1; Path=/; Secure; HttpOnly; SameSite=None', '__Secure-y=2; Secure; HttpOnly'],
      none,
      NOW,
    );
    expect(headers).toEqual([
      '__Host-x=1; Path=/; Secure; HttpOnly; SameSite=None',
      '__Host-ad___Secure-y=2; HttpOnly; Path=/; Secure',
    ]);
    expect(learned.get('__Host-x')).toEqual(facts(false, 'none'));
  });

  it('a deletion removes both forms, so signing out works without HttpOnly or a memory', () => {
    for (const deletion of [
      'sid=; Path=/; Max-Age=0',
      'sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      // Max-Age wins over Expires.
      'sid=; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=0',
    ]) {
      const { headers, learned } = rewriteSetCookies([deletion], none, NOW);
      expect(headers).toEqual([deletion, '__Host-ad_sid=; Path=/; Secure; Max-Age=0']);
      expect(learned.size).toBe(0);
    }
    const kept = rewriteSetCookies(
      ['sid=1; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
      none,
      NOW,
    );
    expect(kept.learned.get('sid')).toEqual(facts(false));
  });

  it('when the app lets scripts read a name it used to protect, the stored copy is retired', () => {
    const { headers, learned } = rewriteSetCookies(
      ['sid=abc; Path=/'],
      new Map([['sid', facts(true)]]),
      NOW,
    );
    expect(headers).toEqual(['sid=abc; Path=/', '__Host-ad_sid=; Path=/; Secure; Max-Age=0']);
    expect(learned.get('sid')).toEqual(facts(false));
  });

  it('passes a nameless cookie through', () => {
    expect(rewriteSetCookies(['justvalue; Domain=x; Path=/'], none, NOW).headers).toEqual([
      'justvalue; Path=/',
    ]);
  });
});

describe('what the app gets from the browser (Cookie)', () => {
  const memory = new Map([
    ['sid', facts(true, 'lax')],
    ['theme', facts(false, null)],
    ['open', facts(true, 'none')],
  ]);

  it('hands __Host-ad_<name> to the app as <name>, and drops plain copies as planted', () => {
    const r = forwardCookies('sid=planted; __Host-ad_sid=real; theme=dark; x=1', memory, null);
    expect(r).toEqual({
      header: 'sid=real; theme=dark; x=1',
      planted: ['sid'],
      plain: ['theme', 'x'],
    });
  });

  it('drops a remembered name even with no real copy (a visitor who never signed in)', () => {
    expect(forwardCookies('sid=attacker', memory, null)).toEqual({
      header: null,
      planted: ['sid'],
      plain: [],
    });
  });

  it('drops disguised names, and never takes a case variant of the prefix as ours', () => {
    const r = forwardCookies('%73id=x; __host-ad_sid=forged; __Host-ad_sid=real', memory, null);
    expect(r.header).toBe('__host-ad_sid=forged; sid=real');
    expect(r.planted).toEqual(['%73id']);
  });

  it('a plain copy next to a stored one is dropped even for a name it hasn’t learned', () => {
    expect(forwardCookies('new=planted; __Host-ad_new=real', none, null).header).toBe('new=real');
  });

  it('from a sibling site: SameSite=None goes, Strict never, Lax and unset only on a top-level link', () => {
    const jar = '__Host-ad_sid=real; __Host-ad_open=1; theme=dark; strict=1; js=1';
    const mem = new Map([...memory, ['strict', facts(false, 'strict')]]);
    expect(forwardCookies(jar, mem, { laxAllowed: false }).header).toBe('open=1');
    expect(forwardCookies(jar, mem, { laxAllowed: true }).header).toBe(
      'sid=real; open=1; theme=dark; js=1',
    );
  });

  it('keeps nameless pairs and empty headers sensible', () => {
    expect(forwardCookies('lonely; a=1', none, null).header).toBe('lonely; a=1');
    expect(forwardCookies(undefined, none, null).header).toBeNull();
    expect(forwardCookies(' ; ', none, null).header).toBeNull();
  });
});

describe('which requests come from a sibling site', () => {
  const host = 'shop.autodeploy.dpdns.org';
  it('trusts Fetch Metadata where the browser sends it', () => {
    const form = { method: 'POST', host, site: 'same-site', mode: 'navigate', dest: 'document' };
    expect(siblingRequest(form)).toEqual({ laxAllowed: false });
    expect(siblingRequest({ ...form, method: 'GET' })).toEqual({ laxAllowed: true });
    expect(siblingRequest({ ...form, method: 'GET', dest: 'iframe' })).toEqual({
      laxAllowed: false,
    });
    expect(siblingRequest({ ...form, method: 'GET', mode: 'cors', dest: 'empty' })).toEqual({
      laxAllowed: false,
    });
    for (const site of ['same-origin', 'none', 'cross-site'])
      expect(siblingRequest({ ...form, site })).toBeNull();
  });

  it('falls back on Origin for browsers without it', () => {
    const post = (origin?: string) => siblingRequest({ method: 'POST', host, origin });
    expect(post('https://evil.autodeploy.dpdns.org')).toEqual({ laxAllowed: false });
    expect(post('https://autodeploy.dpdns.org')).toEqual({ laxAllowed: false });
    expect(post('https://shop.autodeploy.dpdns.org')).toBeNull();
    expect(post('https://elsewhere.example')).toBeNull();
    expect(post('null')).toBeNull();
    expect(post('not a url')).toBeNull();
    expect(post()).toBeNull();
  });

  it('knows the shared domain from a site’s host', () => {
    expect(parentDomain(host)).toBe('autodeploy.dpdns.org');
    expect(parentDomain('d12--shop.autodeploy.localhost')).toBe('autodeploy.localhost');
    expect(parentDomain('localhost')).toBeNull();
    expect(parentDomain('shop.localhost')).toBeNull();
    expect(parentDomain('')).toBeNull();
  });
});

describe('deleting planted copies', () => {
  it('covers each path a cookie sent here could have, a few levels deep', () => {
    expect(cookiePaths('/')).toEqual(['/']);
    expect(cookiePaths('/a')).toEqual(['/', '/a']);
    expect(cookiePaths('/a/')).toEqual(['/', '/a', '/a/']);
    expect(cookiePaths('/a/b/c/d/e')).toEqual([
      '/',
      '/a',
      '/a/',
      '/a/b',
      '/a/b/',
      '/a/b/c',
      '/a/b/c/',
    ]);
    // Nothing that could break out of the header.
    expect(cookiePaths('/a;b/c')).toEqual(['/']);
  });

  it('deletes the shared-domain copy, and the host’s own plain one when asked', () => {
    expect(deleteCookies(['sid'], '/a', 'autodeploy.dpdns.org', true)).toEqual([
      'sid=; Domain=autodeploy.dpdns.org; Path=/; Max-Age=0; Secure',
      'sid=; Path=/; Max-Age=0; Secure',
      'sid=; Domain=autodeploy.dpdns.org; Path=/a; Max-Age=0; Secure',
      'sid=; Path=/a; Max-Age=0; Secure',
    ]);
    expect(deleteCookies(['sid'], '/', null, false)).toEqual([]);
  });

  it('is bounded, and skips names that aren’t valid cookie names', () => {
    const names = ['bad name', 'a;b', ...Array.from({ length: 20 }, (_, i) => `n${i}`)];
    const out = deleteCookies(names, '/', 'd.example', false);
    expect(out).toHaveLength(MAX_DELETED_NAMES);
    expect(out.join('\n')).not.toMatch(/bad name|a;b/);
  });
});

describe('the memory of each project’s cookie names', () => {
  function fakeSql(rows: object[] = [], fail = false) {
    const writes: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (fail) return Promise.reject(new Error('database down'));
      if (strings[0]?.includes('insert')) {
        writes.push(values);
        return Promise.resolve([]);
      }
      return Promise.resolve(rows);
    }) as unknown as Sql;
    return { sql, writes };
  }
  const log = { warn() {} };

  it('loads once, writes only what changed, in order', async () => {
    const { sql, writes } = fakeSql([{ name: 'sid', protect: true, same_site: 'lax' }]);
    const m = new SiteCookieMemory(sql, log);
    expect((await m.get('p')).get('sid')).toEqual(facts(true, 'lax'));
    await m.learn('p', 'o', new Map([['sid', facts(true, 'lax')]]));
    expect(writes).toHaveLength(0);
    await m.learn(
      'p',
      'o',
      new Map([
        ['sid', facts(false, 'lax')],
        ['theme', facts(false)],
      ]),
    );
    expect(writes).toEqual([
      ['p', 'o', 'sid', false, 'lax'],
      ['p', 'o', 'theme', false, null],
    ]);
  });

  it(`keeps at most ${MAX_COOKIE_NAMES} names, so an app minting names can’t grow it`, async () => {
    const { sql, writes } = fakeSql();
    const m = new SiteCookieMemory(sql, log);
    await m.get('p');
    const many = new Map(Array.from({ length: 50 }, (_, i) => [`n${i}`, facts(true)] as const));
    await m.learn('p', 'o', many);
    expect(writes).toHaveLength(MAX_COOKIE_NAMES);
    expect((await m.get('p')).size).toBe(MAX_COOKIE_NAMES);
  });

  it('with the database down the site still works, it just remembers nothing', async () => {
    const { sql } = fakeSql([], true);
    const m = new SiteCookieMemory(sql, log);
    expect((await m.get('p')).size).toBe(0);
    await expect(m.learn('p', 'o', new Map([['sid', facts(true)]]))).resolves.toBeUndefined();
  });
});
