// Serves /site on localhost, loads it in Chromium, and reports whether it
// actually works: HTTP 200 for "/", every same-origin asset loads, no
// uncaught exceptions. Writes /out/result.json and /out/screenshot.png.
// MODE=ssr: /site is a server bundle; START_COMMAND is run in /site/WORKDIR
// (default `node server.js`, a Next.js standalone server) and has to listen on
// $PORT, still with no network: the container runs with --network none.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

// Overridable so the validator can be exercised outside its container.
const SITE = process.env.VALIDATOR_SITE ?? '/site';
const OUT = process.env.VALIDATOR_OUT ?? '/out';
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
const SSR = process.env.MODE === 'ssr';
// Vercel's Analytics / Speed Insights scripts only exist on Vercel's platform;
// elsewhere they 404 harmlessly. Not the site being broken.
const PLATFORM_ONLY = /^\/_vercel\//;
let child = null;
const serverLog = [];
if (SSR) {
  const cwd = join(SITE, normalize(process.env.WORKDIR ?? '.').replace(/^(\.\.(\/|$))+/, ''));
  const command = process.env.START_COMMAND || 'node server.js';
  // exec a simple command so the server is the shell's replacement, and give it
  // its own process group: stopping must reach the server, not just a shell
  // (an orphaned server once kept this process, and the deploy, waiting forever).
  child = spawn('sh', ['-c', /[;&|]/.test(command) ? command : `exec ${command}`], {
    detached: true,
    cwd,
    env: {
      ...process.env,
      // Frameworks read different names: PORT/HOST (most), HOSTNAME (Next).
      PORT: '4173',
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
      PATH: `${join(cwd, 'node_modules/.bin')}:${join(SITE, 'node_modules/.bin')}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const s of [child.stdout, child.stderr])
    s.on('data', (d) => serverLog.push(...String(d).split('\n').filter(Boolean)));
  // Wait for the server to answer (cold start of a Next.js server: ~1-5 s).
  const deadline = Date.now() + 30_000;
  for (;;) {
    const up = await fetch('http://127.0.0.1:4173/', { redirect: 'manual' }).then(
      () => true,
      () => false,
    );
    if (up || child.exitCode !== null || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
} else {
  await new Promise((r) => server.listen(4173, '127.0.0.1', r));
}

const started = Date.now();
const result = {
  ok: false,
  status: null,
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  externalBlocked: 0,
  platformSkipped: 0,
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
    if (u.hostname === '127.0.0.1' && PLATFORM_ONLY.test(u.pathname)) result.platformSkipped++;
    else if (u.hostname === '127.0.0.1')
      result.failedRequests.push(`${u.pathname} (${r.failure()?.errorText ?? 'failed'})`);
    else result.externalBlocked++;
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.hostname === '127.0.0.1' && PLATFORM_ONLY.test(u.pathname)) result.platformSkipped++;
    else if (u.hostname === '127.0.0.1' && r.status() >= 400)
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
  if (child) {
    if (child.exitCode !== null)
      result.pageErrors.push(
        `server exited (${child.exitCode}): ${serverLog.slice(-3).join(' | ').slice(0, 300)}`,
      );
    try {
      process.kill(-child.pid, 'SIGTERM'); // the whole group: shell, server, its children
    } catch {}
  } else server.close();
  if (SSR) result.serverLog = serverLog.slice(-20);
  result.durationMs = Date.now() - started;
  await writeFile(join(OUT, 'result.json'), JSON.stringify(result, null, 2));
}
// The result is written: nothing left behind (a server ignoring SIGTERM, its
// open pipes) may keep the validator, and so the deployment, waiting.
process.exit(0);
