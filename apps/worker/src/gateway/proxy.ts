import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type CookieFacts,
  type CookieMemory,
  deleteCookies,
  forwardCookies,
  parentDomain,
  rewriteSetCookies,
  siblingRequest,
} from '@autodeploy/core';

// One request to a server-rendered app, streamed both ways, with the rules for
// cookies on the sites' shared domain (packages/core/src/site-cookies.ts)
// applied on the way in and on the way out.

// Hop-by-hop and our own control headers never reach the app.
export const STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'x-internal-token',
  'x-autodeploy-deployment',
]);

export function page(status: number, message: string) {
  return `<!doctype html><meta charset="utf-8"><title>${status}</title><style>body{background:#0a0c0f;color:#e8ebf0;font:15px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0}p{color:#8a93a3}</style><div><h1>${status}</h1><p>${message}</p></div>`;
}

export type SiteCookies = {
  memory: CookieMemory;
  learn(learned: ReadonlyMap<string, CookieFacts>): void;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Proxies the request to the app at `app`; `onError` hears when it couldn't be
 * reached, and answering 'retry' (only before anything was sent back) leaves
 * the response to it.
 */
export function proxyToApp(
  req: IncomingMessage,
  res: ServerResponse,
  app: { host: string; port: number },
  cookies: SiteCookies,
  onError: (err: Error) => 'retry' | undefined,
): void {
  // The site's own address, as the edge Worker saw it.
  const host = (one(req.headers['x-forwarded-host']) ?? '').toLowerCase();
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers))
    if (v !== undefined && !STRIP.has(k)) headers[k] = v;
  if (host) headers.host = host;
  const mode = one(req.headers['sec-fetch-mode']);
  const sent = forwardCookies(
    req.headers.cookie,
    cookies.memory,
    siblingRequest({
      method: req.method ?? 'GET',
      host,
      site: one(req.headers['sec-fetch-site']),
      mode,
      dest: one(req.headers['sec-fetch-dest']),
      origin: one(req.headers.origin),
    }),
  );
  if (sent.header) headers.cookie = sent.header;
  else delete headers.cookie;

  const up = httpRequest(
    { host: app.host, port: app.port, method: req.method, path: req.url, headers },
    (r) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(r.headers))
        if (v !== undefined && !STRIP.has(k) && k !== 'set-cookie') out[k] = v;
      const fromApp = rewriteSetCookies(r.headers['set-cookie'] ?? [], cookies.memory);
      cookies.learn(fromApp.learned);
      const pathname = (req.url ?? '/').split('?')[0] || '/';
      const parent = parentDomain(host);
      // A page load (browsers without Fetch Metadata: an HTML answer): its
      // scripts haven't run yet, so planted copies go before they can read them.
      const pageLoad =
        mode === 'navigate' || (!mode && /^text\/html/i.test(one(r.headers['content-type']) ?? ''));
      const others = sent.plain.filter((n) => cookies.memory.has(n) && !/^__host-/i.test(n));
      const setCookie = [
        ...fromApp.headers,
        ...deleteCookies(sent.planted, pathname, parent, true),
        ...(pageLoad ? deleteCookies(others, pathname, parent, false) : []),
      ];
      if (setCookie.length) out['set-cookie'] = setCookie;
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    },
  );
  up.on('error', (err) => {
    if (onError(err) === 'retry' && !res.headersSent) return;
    stopped(res);
  });
  // A page load has no body to send: ending it here, instead of piping, lets
  // the same request be sent again if this server turns out to be dead.
  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    up.end();
  } else req.pipe(up);
}

/** The answer when the app stopped responding, or a cut-off end to one already begun. */
export function stopped(res: ServerResponse) {
  // Asked once: writeHead itself counts as sent, and the page would go out empty.
  if (res.headersSent) return void res.end();
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page(502, 'This site stopped responding.'));
}
