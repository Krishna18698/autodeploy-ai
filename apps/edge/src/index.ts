import { parseSiteHost, routeKey, type SiteRoute } from '@autodeploy/core/hostnames';
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
}

type RouteValue = {
  deploymentId: string;
  number: number;
  artifactSha: string;
  projectSlug: string;
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
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.host).toLowerCase();
    const route = parseSiteHost(host, env.PLATFORM_DOMAIN);
    // app/api/www and unknown hosts are not ours to serve: pass through to origin.
    if (!route) return fetch(request);

    const target = await resolveRoute(env, host, route);
    if (!target) return notFound('No deployment is live at this address.');

    const s3 = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      service: 's3',
      region: env.S3_REGION,
    });
    const cache = caches.default;
    const prefix = `sites/${target.artifactSha}`;

    const tryKey = async (key: string): Promise<Response | null> => {
      // Artifact paths are immutable (content-addressed), so they cache forever.
      const cacheKey = new Request(`https://edge-cache.internal/${prefix}/${key}`);
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const res = await s3.fetch(`${env.S3_ENDPOINT}/${env.S3_BUCKET}/${prefix}/${key}`);
      if (res.status === 404 || res.status === 403) return null;
      if (!res.ok) throw new Error(`storage ${res.status}`);
      const out = new Response(res.body, {
        status: 200,
        headers: {
          'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
          'cache-control': res.headers.get('cache-control') ?? 'public, max-age=0, must-revalidate',
          etag: res.headers.get('etag') ?? `"${target.artifactSha.slice(0, 16)}"`,
          ...SECURITY_HEADERS,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    };

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
