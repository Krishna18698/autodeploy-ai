import {
  parseSiteHost,
  RESERVED_LABELS,
  routeKey,
  type SiteRoute,
} from '@autodeploy/core/hostnames';
import { cookieFlood, ownClearSiteData } from '@autodeploy/core/site-cookies';
import { AwsClient } from 'aws4fetch';

// The edge router. Every request to <label>.<domain> lands here:
//   1. the label resolves to a route (production / PR preview / pinned deploy),
//   2. the route resolves to an immutable, content-addressed artifact,
//   3. the file is streamed from object storage and cached at the edge.
// Activation and rollback only change step 2's pointer, so they take effect
// without touching any files.

export interface Env {
  PLATFORM_DOMAIN: string;
  ROUTE_MODE: 'kv' | 'api';
  ROUTES?: KVNamespace;
  API_URL: string;
  INTERNAL_TOKEN: string;
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  /** Where the dashboard's pages are built and hosted (Vercel); served as app.<domain>. */
  APP_ORIGIN?: string;
  /** The SSR runtime gateway (ADR 0008), reached through the tunnel. */
  RUNTIME_URL?: string;
  /**
   * Where users' sites live: a separate registrable domain (on the Public
   * Suffix List), so a site can neither set cookies for the dashboard nor get
   * the dashboard's domain flagged. Unset: sites share PLATFORM_DOMAIN.
   */
  SITES_DOMAIN?: string;
}

const sitesOf = (env: Pick<Env, 'PLATFORM_DOMAIN' | 'SITES_DOMAIN'>) =>
  env.SITES_DOMAIN || env.PLATFORM_DOMAIN;

/**
 * Where an address lives now, for one on the wrong domain: a site address on
 * the dashboard's domain moves to the sites domain, and the dashboard's own
 * names on the sites domain (its earlier home) point back to the dashboard.
 */
export function movedHost(host: string, env: Pick<Env, 'PLATFORM_DOMAIN' | 'SITES_DOMAIN'>) {
  const app = env.PLATFORM_DOMAIN;
  const sites = sitesOf(env);
  if (sites === app) return null;
  if (host === sites || host === `app.${sites}` || host === `www.${sites}`) return `app.${app}`;
  if (host.endsWith(`.${app}`)) {
    const label = host.slice(0, -app.length - 1);
    if (!label.includes('.') && !RESERVED_LABELS.has(label)) return `${label}.${sites}`;
  }
  return null;
}

type RouteValue = {
  deploymentId: string;
  number: number;
  artifactSha: string;
  projectSlug: string;
  /** Server-rendered: anything not in the static artifact goes to the runtime gateway. */
  mode?: 'ssr';
};

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'SAMEORIGIN',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/** A site a platform admin took down: every address answers with a notice. */
type TakenDown = { takenDown: true };

type Route = RouteValue | TakenDown | null;
/** How long an address's answer is kept in the edge cache (and in KV's own). */
const ROUTE_CACHE_S = 30;

/**
 * Which deployment an address serves. Production reads KV, but each answer is
 * first kept in the edge cache for 30 s: the Cache API is free and unlimited,
 * KV reads are 100,000 a day on the free plan. On 2026-10-24 a load test sent
 * every visit to KV, used them all up, and every site answered 500 until
 * midnight UTC. Should KV fail anyway, the origin answers from the database.
 * A rollback or takedown is visible within about a minute (both caches).
 */
export async function resolveRoute(
  env: Env,
  host: string,
  route: SiteRoute,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  cache: Pick<Cache, 'match' | 'put'> = caches.default,
): Promise<Route> {
  if (env.ROUTE_MODE !== 'kv' || !env.ROUTES) return routeFromOrigin(env, host);
  const key = new Request(
    `https://edge-cache.internal/routes/${encodeURIComponent(routeKey(route))}`,
  );
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as Route;
  let value: Route;
  try {
    value = await env.ROUTES.get<RouteValue | TakenDown>(routeKey(route), {
      type: 'json',
      cacheTtl: ROUTE_CACHE_S,
    });
  } catch (err) {
    console.warn(`KV lookup failed (${String(err)}); asking the origin`);
    value = await routeFromOrigin(env, host);
  }
  ctx.waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(value), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `max-age=${ROUTE_CACHE_S}`,
        },
      }),
    ),
  );
  return value;
}

/** The origin's answer (from the database): null when nothing lives there. */
async function routeFromOrigin(env: Env, host: string): Promise<Route> {
  const res = await fetch(`${env.API_URL}/internal/routes/${encodeURIComponent(host)}`, {
    headers: { 'x-internal-token': env.INTERNAL_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`origin route lookup failed: ${res.status}`);
  return (await res.json()) as RouteValue | TakenDown;
}

/** The path as a storage key, or null when its %-encoding is malformed (e.g. "/%"). */
export function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function candidates(p: string): string[] {
  if (p.split('/').some((seg) => seg === '..')) return [];
  if (p === '' || p.endsWith('/')) return [`${p}index.html`];
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(p);
  return hasExt ? [p] : [p, `${p}/index.html`, `${p}.html`];
}

const MANIFEST = '.autodeploy-manifest.tsv';
const EDGE_CACHE = 'public, max-age=31536000, immutable';

// Backblaze sometimes answers "busy" (503) and expects a retry. aws4fetch
// retries 10 times by default with growing waits (up to ~50 s), long enough to
// leave a visitor on a hung page; here a read gets 2 retries within 10 s, and
// then the page says the site is temporarily unavailable.
export const STORAGE_RETRIES = 2;
export const STORAGE_TIMEOUT_MS = 10_000;

/** Reads files of one artifact from storage, each read bounded in time. */
export function storageReader(
  env: Pick<
    Env,
    'S3_ACCESS_KEY_ID' | 'S3_SECRET_ACCESS_KEY' | 'S3_REGION' | 'S3_ENDPOINT' | 'S3_BUCKET'
  >,
  prefix: string,
  timeoutMs = STORAGE_TIMEOUT_MS,
) {
  const s3 = new AwsClient({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.S3_REGION,
    retries: STORAGE_RETRIES,
  });
  return (key: string) =>
    s3.fetch(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${prefix}/${key}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
}
const BROWSER_CC = 'x-browser-cache-control';
// Per-isolate memo of artifact file lists; artifacts never change, so no expiry.
const manifests = new Map<string, Set<string>>();

/** File list of an artifact, or null to fall back to probing storage. */
async function loadManifest(
  sha: string,
  cache: Cache,
  ctx: ExecutionContext,
  fromStorage: (key: string) => Promise<Response>,
): Promise<Set<string> | null> {
  const memo = manifests.get(sha);
  if (memo) return memo;
  const cacheKey = new Request(`https://edge-cache.internal/sites/${sha}/${MANIFEST}`);
  let text: string;
  const hit = await cache.match(cacheKey);
  if (hit) text = await hit.text();
  else {
    const res = await fromStorage(MANIFEST);
    if (!res.ok) return null;
    text = await res.text();
    ctx.waitUntil(
      cache.put(cacheKey, new Response(text, { headers: { 'cache-control': EDGE_CACHE } })),
    );
  }
  const files = new Set(
    text
      .split('\n')
      .map((line) => line.split('\t')[0] ?? '')
      .filter(Boolean),
  );
  if (manifests.size >= 500) manifests.clear();
  manifests.set(sha, files);
  return files;
}

/** Swaps the edge-cache lifetime for the file's own browser cache policy. */
function forBrowser(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('cache-control', headers.get(BROWSER_CC) ?? 'public, max-age=0, must-revalidate');
  headers.delete(BROWSER_CC);
  return new Response(res.body, { status: res.status, headers });
}

/**
 * app.<domain>: the dashboard, as one site: API and sign-in calls go straight
 * to the API, pages come from Vercel, so cookies and the API's origin check
 * work as if it were one. Caddy on the VM does this now (a Worker bypass route
 * keeps the dashboard off the daily request quota users' sites share); this
 * stays as the fallback if that route is removed.
 */
async function serveApp(request: Request, env: Env & { APP_ORIGIN: string }, host: string) {
  const url = new URL(request.url);
  const toApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');
  const origin = toApi ? env.API_URL : env.APP_ORIGIN;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('x-forwarded-host', host);
  // Tells the dashboard this came through us, so it doesn't redirect here.
  headers.set('x-autodeploy-edge', '1');
  // Cloudflare sets CF-Connecting-IP on a same-zone subrequest (app. → api.)
  // from X-Real-IP, which a visitor could send themselves: set it to the
  // address Cloudflare saw, which the API's per-visitor rate limits key on.
  const client = request.headers.get('cf-connecting-ip');
  headers.delete('x-real-ip');
  if (client) {
    headers.set('x-forwarded-for', client);
    headers.set('x-real-ip', client);
  }
  const res = await fetch(new URL(url.pathname + url.search, origin), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    redirect: 'manual',
  });
  const location = res.headers.get('location');
  if (!location?.startsWith(env.APP_ORIGIN)) return res;
  const out = new Response(res.body, res);
  out.headers.set('location', `https://${host}${location.slice(env.APP_ORIGIN.length)}`);
  return out;
}

function withDeployment(res: Response, target: RouteValue, method: string): Response {
  const headers = new Headers(res.headers);
  headers.set('x-autodeploy-deployment', `${target.projectSlug}#${target.number}`);
  return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

/**
 * Server-rendered request → the gateway, which wakes the deployment's container
 * if needed and streams the response back (SSE and streamed AI replies work).
 */
async function proxyRuntime(
  request: Request,
  env: Env,
  host: string,
  target: RouteValue,
  url: URL,
  cookie: string | null | undefined,
): Promise<Response> {
  if (!env.RUNTIME_URL) return notFound('Server-rendered sites are not enabled here.', 502);
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (cookie !== undefined) {
    if (cookie) headers.set('cookie', cookie);
    else headers.delete('cookie');
  }
  headers.set('x-forwarded-host', host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
  headers.set('x-autodeploy-deployment', target.deploymentId);
  headers.set('x-internal-token', env.INTERNAL_TOKEN);
  try {
    const res = await fetch(new URL(url.pathname + url.search, env.RUNTIME_URL), {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      redirect: 'manual',
    });
    const out = new Response(res.body, res);
    out.headers.set('x-autodeploy-deployment', `${target.projectSlug}#${target.number}`);
    return out;
  } catch {
    return notFound('The site is temporarily unavailable.', 502);
  }
}

function notFound(message: string, status = 404) {
  const html = `<!doctype html><meta charset="utf-8"><title>${status}</title><style>body{background:#0a0c0f;color:#e8ebf0;font:15px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0}p{color:#8a93a3}</style><div><h1>${status}</h1><p>${message}</p></div>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

/**
 * Every site's answer, for the domain the sites share (ADR 0011): no
 * Clear-Site-Data "cookies" (it clears every site's), a flood's clean-up, and
 * Origin-Agent-Cluster, so a browser that still lets document.domain join
 * pages of one site (Chrome no longer does by default) keeps siblings apart.
 */
export function forSite(res: Response, deletions: string[]): Response {
  const out = new Response(res.body, res);
  out.headers.set('origin-agent-cluster', '?1');
  const clear = ownClearSiteData(out.headers.get('clear-site-data'));
  if (clear) out.headers.set('clear-site-data', clear);
  else out.headers.delete('clear-site-data');
  for (const d of deletions) out.headers.append('set-cookie', d);
  return out;
}

/** A request to a site: its deployment's files, or its server. */
async function serveSite(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  reqHost: string,
  route: SiteRoute,
  /** The Cookie header for a server-rendered site, when a flood's was cut. */
  cookie: string | null | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  const target = await resolveRoute(env, reqHost, route, ctx);
  if (!target) return notFound('No deployment is live at this address.');
  // 451: unavailable for legal reasons (an abuse report, or the terms of service).
  if ('takenDown' in target)
    return notFound('This site has been taken down for breaking the terms of service.', 451);
  // Static sites are read-only; a server-rendered one takes any method (forms, API routes).
  if (target.mode !== 'ssr' && !isRead) {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const cache = caches.default;
  const prefix = `sites/${target.artifactSha}`;
  const fromStorage = storageReader(env, prefix);
  // The manifest says which files exist, so misses (SPA routes, /about →
  // about.html probing) never reach storage. Free B2 allows 2,500 reads a day.
  // Storage not answering: probe the files themselves (and fail there).
  const files = await loadManifest(target.artifactSha, cache, ctx, fromStorage).catch(() => null);

  const tryKey = async (key: string): Promise<Response | null> => {
    if (key === MANIFEST || (files && !files.has(key))) return null;
    // Every path under sites/<sha>/ is immutable, so the edge keeps it for a
    // year, even index.html; browsers still get the file's own cache policy.
    const cacheKey = new Request(`https://edge-cache.internal/${prefix}/${key}`);
    const hit = await cache.match(cacheKey);
    if (hit) return forBrowser(hit);
    const res = await fromStorage(key);
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`storage ${res.status}`);
    const stored = new Response(res.body, {
      status: 200,
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': EDGE_CACHE,
        [BROWSER_CC]: res.headers.get('cache-control') ?? 'public, max-age=0, must-revalidate',
        etag: res.headers.get('etag') ?? `"${target.artifactSha.slice(0, 16)}"`,
        ...SECURITY_HEADERS,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, stored.clone()));
    return forBrowser(stored);
  };

  if (target.mode === 'ssr') {
    // Build assets and public/ files come straight from storage (cached at
    // the edge, no container woken); pages and API routes go to the server.
    // An undecodable path is the app's to answer, not a storage key.
    const key = decodePath(url.pathname);
    if (isRead && key && files?.has(key)) {
      const asset = await tryKey(key).catch(() => null);
      if (asset) return withDeployment(asset, target, request.method);
    }
    return proxyRuntime(request, env, reqHost, target, url, cookie);
  }

  const staticPath = decodePath(url.pathname);
  if (staticPath === null) return notFound('This address is not valid.', 400);
  try {
    let res: Response | null = null;
    for (const key of candidates(staticPath)) {
      res = await tryKey(key);
      if (res) break;
    }
    // Single-page apps: unknown routes without a file extension get index.html.
    if (!res && !/\.[a-z0-9]{1,8}$/i.test(url.pathname)) res = await tryKey('index.html');
    if (!res) {
      const custom = await tryKey('404.html');
      return custom
        ? new Response(custom.body, { status: 404, headers: custom.headers })
        : notFound('This page does not exist.');
    }
    const headers = new Headers(res.headers);
    headers.set('x-autodeploy-deployment', `${target.projectSlug}#${target.number}`);
    if (
      request.headers.get('if-none-match') &&
      request.headers.get('if-none-match') === headers.get('etag')
    ) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(request.method === 'HEAD' ? null : res.body, {
      status: res.status,
      headers,
    });
  } catch {
    return notFound('The site is temporarily unavailable.', 502);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const appHost = `app.${env.PLATFORM_DOMAIN}`;
    const reqHost = (request.headers.get('host') ?? new URL(request.url).host)
      .toLowerCase()
      .replace(/:\d+$/, '');
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    const url = new URL(request.url);
    // Old links keep working: permanent redirects (308 keeps a POST a POST).
    const moved = movedHost(reqHost, env);
    if (moved)
      return Response.redirect(`https://${moved}${url.pathname}${url.search}`, isRead ? 301 : 308);
    // The bare domain and www have no pages of their own; the landing page lives
    // with the dashboard. Temporary, so the apex can get its own page later.
    // HSTS here, on the bare domain, covers every subdomain (all HTTPS already)
    // and makes the domain eligible for browsers' preload list.
    if (reqHost === env.PLATFORM_DOMAIN || reqHost === `www.${env.PLATFORM_DOMAIN}`)
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://${appHost}${url.pathname}${url.search}`,
          'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
        },
      });
    if (env.APP_ORIGIN && reqHost === appHost)
      return serveApp(request, env as Env & { APP_ORIGIN: string }, appHost);
    const route = parseSiteHost(reqHost, sitesOf(env));
    if (!route) {
      // api/run/ssh have origins of their own: pass through. Anything else
      // under the sites domain is a mistyped site address; answer it here
      // instead of passing it on to an origin that doesn't exist (a 522).
      const suffix = `.${sitesOf(env)}`;
      const label = reqHost.endsWith(suffix) ? reqHost.slice(0, -suffix.length) : '';
      if (!label || RESERVED_LABELS.has(label)) return fetch(request);
      return notFound('No site lives at this address.');
    }
    // The shared domain's clean-up, on every site's answer (see forSite).
    const flood = cookieFlood(request.headers.get('cookie'), url.pathname, sitesOf(env));
    const res = await serveSite(request, env, ctx, reqHost, route, flood?.header);
    return forSite(res, flood?.deletions ?? []);
  },
} satisfies ExportedHandler<Env>;
