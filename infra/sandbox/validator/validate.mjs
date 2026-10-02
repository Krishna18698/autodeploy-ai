// Serves /site on localhost, loads it in Chromium, and reports whether it
// actually works: HTTP 200 for "/", every same-origin asset loads, no
// uncaught exceptions. Writes /out/result.json and /out/screenshot.png.
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

const SITE = '/site';
const OUT = '/out';
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.wasm': 'application/wasm',
};

async function resolveFile(urlPath) {
  const safe = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidates = [join(SITE, safe), join(SITE, safe, 'index.html'), join(SITE, `${safe}.html`)];
  for (const c of candidates) {
    const s = await stat(c).catch(() => null);
    if (s?.isFile()) return c;
  }
  // SPA fallback only for route-like paths (no file extension).
  return extname(safe) ? null : join(SITE, 'index.html');
}

const server = createServer(async (req, res) => {
  const file = await resolveFile(req.url ?? '/');
  if (!file) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4173, '127.0.0.1', r));

const started = Date.now();
const result = {
  ok: false,
  status: null,
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  externalBlocked: 0,
  title: null,
  durationMs: 0,
};
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => result.pageErrors.push(String(e.message).slice(0, 300)));
  page.on(
    'console',
    (m) => m.type() === 'error' && result.consoleErrors.push(m.text().slice(0, 300)),
  );
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1')
      result.failedRequests.push(`${u.pathname} (${r.failure()?.errorText ?? 'failed'})`);
    else result.externalBlocked++;
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1' && r.status() >= 400)
      result.failedRequests.push(`${u.pathname} (${r.status()})`);
  });
  const resp = await page
    .goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle', timeout: 20000 })
    .catch((e) => {
      result.pageErrors.push(`navigation: ${e.message.slice(0, 200)}`);
      return null;
    });
  result.status = resp?.status() ?? null;
  result.title = await page.title().catch(() => null);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'screenshot.png') }).catch(() => {});
  result.ok =
    result.status === 200 && result.pageErrors.length === 0 && result.failedRequests.length === 0;
} finally {
  await browser.close();
  server.close();
  result.durationMs = Date.now() - started;
  await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}
