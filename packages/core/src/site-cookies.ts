// Users' sites share one registrable domain (autodeploy.dpdns.org) until a
// sites domain can go on the Public Suffix List, so to browsers they are one
// site: any of them can set a cookie for all of them (Domain=<that domain>),
// and a request from one to another counts as same-site, so SameSite doesn't
// stop a sibling's forged form. The SSR gateway applies these rules, which
// close what the server side can (GitHub's 2013 defence, plus __Host-):
//   1. Domain= is stripped from cookies a site's server sets, so they stay its own.
//   2. Cookies scripts can't read (HttpOnly) are stored as __Host-ad_<name>,
//      which browsers never accept from another host. The app still sees
//      <name>; a plain <name> arriving was planted (or predates this), so it
//      is dropped. The names are remembered per project, so this holds even
//      for a visitor who hasn't got the real cookie yet.
//   3. A request from a sibling site is treated as cross-site: cookies a
//      browser would withhold if the sites were separate (SameSite=Strict, and
//      Lax outside a top-level link) are withheld here.
//   4. Planted copies of the site's own cookie names are deleted from the
//      browser, on every path a planted one could hide on.
// What stays open (docs/issues-to-fix.md): a sibling can evict or flood
// cookies, and plant the ones a site's scripts set for themselves.

export const OWN_COOKIE_PREFIX = '__Host-ad_';

export type SameSite = 'strict' | 'lax' | 'none';
/** What a site's server is known to do with a cookie name. */
export type CookieFacts = { protect: boolean; sameSite: SameSite | null };
export type CookieMemory = ReadonlyMap<string, CookieFacts>;

type Attr = { key: string; value: string | null };
type SetCookie = { name: string; value: string; attrs: Attr[] };

const lower = (s: string) => s.toLowerCase();
/** Already unplantable: browsers only take a __Host- cookie from its own host. */
const hostPrefixed = (name: string) => lower(name).startsWith('__host-');
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function parseSetCookie(header: string): SetCookie {
  const [pair = '', ...rest] = header.split(';');
  const eq = pair.indexOf('=');
  const attrs: Attr[] = [];
  for (const a of rest) {
    const i = a.indexOf('=');
    const key = (i === -1 ? a : a.slice(0, i)).trim();
    if (key) attrs.push({ key, value: i === -1 ? null : a.slice(i + 1).trim() });
  }
  // A nameless cookie ("value" alone) keeps its text as the value.
  if (eq === -1) return { name: '', value: pair.trim(), attrs };
  return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), attrs };
}

function serialize(c: SetCookie): string {
  const head = c.name ? `${c.name}=${c.value}` : c.value;
  return [head, ...c.attrs.map((a) => (a.value === null ? a.key : `${a.key}=${a.value}`))].join(
    '; ',
  );
}

function attr(attrs: Attr[], key: string): Attr | undefined {
  let found: Attr | undefined;
  for (const a of attrs) if (lower(a.key) === key) found = a;
  return found;
}

/** Max-Age wins over Expires (RFC 6265 §5.3); the last of each counts. */
function expired(attrs: Attr[], now: number): boolean {
  const maxAge = attr(attrs, 'max-age')?.value;
  if (maxAge && /^-?\d+$/.test(maxAge)) return Number(maxAge) <= 0;
  const expires = attr(attrs, 'expires')?.value;
  if (!expires) return false;
  const t = Date.parse(expires);
  return !Number.isNaN(t) && t <= now;
}

function sameSiteOf(attrs: Attr[]): SameSite | null {
  const v = lower(attr(attrs, 'samesite')?.value ?? '');
  return v === 'strict' || v === 'lax' || v === 'none' ? v : null;
}

const retire = (name: string) => `${OWN_COOKIE_PREFIX}${name}=; Path=/; Secure; Max-Age=0`;

/**
 * The app's Set-Cookie headers as the browser gets them (rules 1 and 2), and
 * what they teach about its cookie names (deletions teach nothing).
 */
export function rewriteSetCookies(
  headers: readonly string[],
  memory: CookieMemory,
  now = Date.now(),
): { headers: string[]; learned: Map<string, CookieFacts> } {
  const out: string[] = [];
  const learned = new Map<string, CookieFacts>();
  for (const header of headers) {
    const c = parseSetCookie(header);
    c.attrs = c.attrs.filter((a) => lower(a.key) !== 'domain');
    if (!c.name || hostPrefixed(c.name)) {
      if (c.name && !expired(c.attrs, now))
        learned.set(c.name, { protect: false, sameSite: sameSiteOf(c.attrs) });
      out.push(serialize(c));
      continue;
    }
    const httpOnly = attr(c.attrs, 'httponly') !== undefined;
    if (expired(c.attrs, now)) {
      // A deletion often leaves HttpOnly out: delete both forms, so signing
      // out works whatever the memory says.
      out.push(serialize(c), retire(c.name));
      continue;
    }
    learned.set(c.name, { protect: httpOnly, sameSite: sameSiteOf(c.attrs) });
    if (httpOnly) {
      // __Host- requires Secure and Path=/, and allows no Domain.
      const attrs = c.attrs.filter((a) => !['path', 'secure'].includes(lower(a.key)));
      out.push(
        serialize({
          name: `${OWN_COOKIE_PREFIX}${c.name}`,
          value: c.value,
          attrs: [...attrs, { key: 'Path', value: '/' }, { key: 'Secure', value: null }],
        }),
      );
      continue;
    }
    out.push(serialize(c));
    // Scripts may read this name now: retire the copy kept from them.
    if (memory.get(c.name)?.protect) out.push(retire(c.name));
  }
  return { headers: out, learned };
}

/** A request from a sibling site, and whether SameSite=Lax cookies may go with it. */
export type SiblingRequest = { laxAllowed: boolean } | null;

/** The sites' shared domain, from one site's host: shop.<domain> → <domain>. */
export function parentDomain(host: string): string | null {
  const parent = host.slice(host.indexOf('.') + 1);
  return host.includes('.') && parent.includes('.') ? parent : null;
}

/**
 * Whether a request comes from another of the sites (rule 3). Browsers say so
 * in Sec-Fetch-Site; older ones (Safari before 16.4) at least send Origin on a
 * form post or a script's request, which is never a top-level link.
 */
export function siblingRequest(h: {
  method: string;
  host: string;
  site?: string | undefined;
  mode?: string | undefined;
  dest?: string | undefined;
  origin?: string | undefined;
}): SiblingRequest {
  const safe = h.method === 'GET' || h.method === 'HEAD';
  if (h.site) {
    if (h.site !== 'same-site') return null;
    return { laxAllowed: safe && h.mode === 'navigate' && h.dest === 'document' };
  }
  if (!h.origin || h.origin === 'null') return null;
  let from: string;
  try {
    from = new URL(h.origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const parent = parentDomain(h.host);
  if (!parent || from === h.host || (from !== parent && !from.endsWith(`.${parent}`))) return null;
  return { laxAllowed: false };
}

function sentCrossSite(sameSite: SameSite | null, laxAllowed: boolean): boolean {
  if (sameSite === 'none') return true;
  if (sameSite === 'strict') return false;
  // No SameSite: browsers that default it treat it as Lax; so do we.
  return laxAllowed;
}

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * The Cookie header the app gets (rules 2 and 3). `planted` lists names that
 * arrived plain although only the __Host-ad_ form can be real, as the browser
 * sent them; `plain` lists the other names passed on as they came.
 */
export function forwardCookies(
  header: string | undefined,
  memory: CookieMemory,
  sibling: SiblingRequest,
): { header: string | null; planted: string[]; plain: string[] } {
  const pairs: { name: string; value: string }[] = [];
  for (const part of (header ?? '').split(';')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    pairs.push(
      eq === -1
        ? { name: '', value: p }
        : { name: p.slice(0, eq).trim(), value: p.slice(eq + 1).trim() },
    );
  }
  // Case-sensitive on purpose: a browser that matches prefixes exactly would
  // take "__host-ad_x" with a Domain, so only the exact form counts as ours.
  const own = new Set(
    pairs
      .filter((p) => p.name.startsWith(OWN_COOKIE_PREFIX))
      .map((p) => p.name.slice(OWN_COOKIE_PREFIX.length)),
  );
  // Some servers decode cookie names (GitHub was hit with "_%73ession").
  const isProtected = (name: string) =>
    [name, decodedName(name)].some((n) => own.has(n) || memory.get(n)?.protect === true);

  const kept: string[] = [];
  const planted = new Set<string>();
  const plain = new Set<string>();
  for (const p of pairs) {
    let name = p.name;
    if (name.startsWith(OWN_COOKIE_PREFIX) && name.length > OWN_COOKIE_PREFIX.length)
      name = name.slice(OWN_COOKIE_PREFIX.length);
    else if (name && isProtected(name)) {
      planted.add(name);
      continue;
    } else if (name) plain.add(name);
    if (sibling && !sentCrossSite(memory.get(name)?.sameSite ?? null, sibling.laxAllowed)) continue;
    kept.push(name ? `${name}=${p.value}` : p.value);
  }
  return { header: kept.length ? kept.join('; ') : null, planted: [...planted], plain: [...plain] };
}

export const MAX_DELETED_NAMES = 8;
export const MAX_PATH_DEPTH = 3;
const PATH_SEGMENT = /^[A-Za-z0-9\-._~%!$&'()*+=:@]+$/;

/** Every cookie path a cookie sent to this path could have (up to a depth). */
export function cookiePaths(pathname: string): string[] {
  const out = ['/'];
  let acc = '';
  for (const seg of pathname.split('/').slice(1, 1 + MAX_PATH_DEPTH)) {
    if (!seg || !PATH_SEGMENT.test(seg)) break;
    acc += `/${seg}`;
    out.push(acc);
    if (pathname.startsWith(`${acc}/`)) out.push(`${acc}/`);
  }
  return out;
}

/**
 * Set-Cookie headers deleting copies of these names (rule 4): the ones set
 * for the shared domain, and with `hostOnly` this host's own plain ones too.
 * A deletion only matches a cookie of the same path, hence one per path.
 */
export function deleteCookies(
  names: Iterable<string>,
  pathname: string,
  parent: string | null,
  hostOnly: boolean,
): string[] {
  const out: string[] = [];
  const paths = cookiePaths(pathname);
  let n = 0;
  for (const name of new Set(names)) {
    if (!TOKEN.test(name)) continue;
    if (n++ >= MAX_DELETED_NAMES) break;
    for (const path of paths) {
      if (parent) out.push(`${name}=; Domain=${parent}; Path=${path}; Max-Age=0; Secure`);
      if (hostOnly) out.push(`${name}=; Path=${path}; Max-Age=0; Secure`);
    }
  }
  return out;
}
