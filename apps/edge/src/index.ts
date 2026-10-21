import {
  parseSiteHost,
  RESERVED_LABELS,
  routeKey,
  type SiteRoute,
} from '@autodeploy/core/hostnames';
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
  /** Earlier platform domains, comma-separated: their addresses redirect to PLATFORM_DOMAIN. */
  LEGACY_DOMAINS?: string;
}

/** The same address under the current platform domain, for a host under an earlier one. */
export function movedHost(host: string, env: Pick<Env, 'PLATFORM_DOMAIN' | 'LEGACY_DOMAINS'>) {
  for (const old of (env.LEGACY_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean)) {
    if (host === old) return `app.${env.PLATFORM_DOMAIN}`;
    if (host.endsWith(`.${old}`)) return `${host.slice(0, -old.length)}${env.PLATFORM_DOMAIN}`;
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

async function resolveRoute(env: Env, host: string, route: SiteRoute): Promise<RouteValue | null> {
  if (env.ROUTE_MODE === 'kv' && env.ROUTES) {
    // KV reads are edge-cached for 30 s: a rollback is visible within that.
    return env.ROUTES.get<RouteValue>(routeKey(route), { type: 'json', cacheTtl: 30 });
  }
  const res = await fetch(`${env.API_URL}/internal/routes/${encodeURIComponent(host)}`, {
    headers: { 'x-internal-token': env.INTERNAL_TOKEN },
  });
  return res.ok ? ((await res.json()) as RouteValue) : null;
}

function candidates(pathname: string): string[] {
  const p = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (p.split('/').some((seg) => seg === '..')) return [];
  if (p === '' || p.endsWith('/')) return [`${p}index.html`];
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(p);
  return hasExt ? [p] : [p, `${p}/index.html`, `${p}.html`];
}

const MANIFEST = '.autodeploy-manifest.tsv';
const EDGE_CACHE = 'public, max-age=31536000, immutable';
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
 * app.<domain>: the dashboard. The edge serves it rather than attaching the
 * domain to Vercel: API and sign-in calls go straight to the API (no extra hop,
 * SSE streams untouched),
 * pages come from Vercel. The browser only ever sees app.<domain>, so cookies
 * and the API's origin check work as if it were one site.
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
  const client = request.headers.get('cf-connecting-ip');
  if (client) headers.set('x-forwarded-for', client);
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
): Promise<Response> {
  if (!env.RUNTIME_URL) return notFound('Server-rendered sites are not enabled here.', 502);
  const headers = new Headers(request.headers);
  headers.delete('host');
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
    if (reqHost === env.PLATFORM_DOMAIN || reqHost === `www.${env.PLATFORM_DOMAIN}`)
      return Response.redirect(`https://${appHost}${url.pathname}${url.search}`, 302);
    if (env.APP_ORIGIN && reqHost === appHost)
      return serveApp(request, env as Env & { APP_ORIGIN: string }, appHost);
    const route = parseSiteHost(reqHost, env.PLATFORM_DOMAIN);
    if (!route) {
      // app/api/www and the bare domain have origins of their own: pass through.
      // Anything else under the domain is a mistyped site address; answer it
      // here instead of passing it on to an origin that doesn't exist (a 522).
      const suffix = `.${env.PLATFORM_DOMAIN}`;
      const label = reqHost.endsWith(suffix) ? reqHost.slice(0, -suffix.length) : '';
      if (!label || RESERVED_LABELS.has(label)) return fetch(request);
      return notFound('No site lives at this address.');
    }
    const target = await resolveRoute(env, reqHost, route);
    if (!target) return notFound('No deployment is live at this address.');
    // Static sites are read-only; a server-rendered one takes any method (forms, API routes).
    if (target.mode !== 'ssr' && !isRead) {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const s3 = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      service: 's3',
      region: env.S3_REGION,
    });
    const cache = caches.default;
    const prefix = `sites/${target.artifactSha}`;
    const fromStorage = (key: string) =>
      s3.fetch(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${prefix}/${key}`);
    // The manifest says which files exist, so misses (SPA routes, /about →
    // about.html probing) never reach storage. Free B2 allows 2,500 reads a day.
    const files = await loadManifest(target.artifactSha, cache, ctx, fromStorage);

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
      const key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (isRead && key && files?.has(key)) {
        const asset = await tryKey(key).catch(() => null);
        if (asset) return withDeployment(asset, target, request.method);
      }
      return proxyRuntime(request, env, reqHost, target, url);
    }

    try {
      let res: Response | null = null;
      for (const key of candidates(url.pathname)) {
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
  },
} satisfies ExportedHandler<Env>;
