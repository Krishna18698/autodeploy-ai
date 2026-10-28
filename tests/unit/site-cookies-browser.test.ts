import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttp, request as httpRequest, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from '@autodeploy/db';
import { type Browser, type BrowserContext, chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SiteCookieMemory } from '../../apps/worker/src/gateway/cookies';
import { proxyToApp } from '../../apps/worker/src/gateway/proxy';

// Cookies between users' sites on one shared domain, in a real browser.
// evil.<domain> plays a hostile user's site, shop.<domain> a server-rendered
// site behind the gateway's proxy (the code production runs), and
// raw.<domain> the same app with nothing in between, to show each attack
// works without the protections. Chromium resolves every *.<domain> to the
// local servers, so nothing leaves this machine.

const DOMAIN = 'autodeploy.example.com';
const SHOP = `https://shop.${DOMAIN}`;
const EVIL = `https://evil.${DOMAIN}`;
const RAW = `https://raw.${DOMAIN}`;

const page = (body: string) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);

// The app: signs in and out, and shows the Cookie header it got.
const app = createHttp((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/login') {
    res.setHeader('set-cookie', [
      'sid=real; HttpOnly; Path=/; SameSite=Lax',
      'strict=1; HttpOnly; Path=/; SameSite=Strict',
      'open=1; HttpOnly; Path=/; SameSite=None; Secure',
      'theme=dark; Path=/',
      `wide=1; Domain=${DOMAIN}; Path=/`,
    ]);
  }
  // Like many apps' sign-out: no HttpOnly on the deletion.
  if (path === '/logout') res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page(`<pre id="seen">${esc(req.headers.cookie ?? '')}</pre>`));
});

// What a hostile site's scripts do with document.cookie.
const PLANT = [
  `sid=planted; domain=${DOMAIN}; path=/`,
  `sid=deeper; domain=${DOMAIN}; path=/echo`,
  `%73id=disguised; domain=${DOMAIN}; path=/`,
  `__Host-ad_sid=forged; domain=${DOMAIN}; path=/; secure`,
  `__host-ad_sid=forged; domain=${DOMAIN}; path=/; secure`,
  `theme=planted; domain=${DOMAIN}; path=/`,
];
const evil = (path: string) => {
  if (path === '/plant')
    return page(
      `<pre id="seen"></pre><script>${PLANT.map((c) => `document.cookie=${JSON.stringify(c)};`).join('')}document.getElementById('seen').textContent=document.cookie</script>`,
    );
  if (path === '/form')
    return page(
      `<form id="f" method="post" action="${SHOP}/echo"></form><script>document.getElementById('f').submit()</script>`,
    );
  return page(`<a id="go" href="${SHOP}/echo">shop</a>`);
};

let front: Server;
let browser: Browser;
let dir: string;
const memory = new SiteCookieMemory(
  // Nothing remembered yet, and writes go nowhere: the database side is
  // tested in tests/integration/site-cookies.test.ts.
  (() => Promise.resolve([])) as unknown as Sql,
  { warn() {} },
);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'site-cookies-'));
  const made = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=*.${DOMAIN}`],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, OPENSSL_CONF: '/dev/null' }, input: '' },
  );
  if (made.status !== 0) throw new Error(made.stderr);
  // openssl prints the key, then the certificate, when given no -keyout/-out.
  const key = made.stdout.slice(0, made.stdout.indexOf('-----BEGIN CERTIFICATE-----'));
  const cert = made.stdout.slice(key.length);
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const target = { host: '127.0.0.1', port: (app.address() as AddressInfo).port };
  front = createHttps({ key, cert }, async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === `evil.${DOMAIN}`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(evil((req.url ?? '/').split('?')[0] ?? '/'));
      return;
    }
    if (host === `raw.${DOMAIN}`) {
      const up = httpRequest(
        { ...target, method: req.method, path: req.url, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(up);
      return;
    }
    // As the edge Worker sends it to the gateway.
    req.headers['x-forwarded-host'] = host;
    const projectId = 'p-shop';
    const remembered = await memory.get(projectId);
    proxyToApp(
      req,
      res,
      target,
      { memory: remembered, learn: (l) => void memory.learn(projectId, 'o-1', l) },
      () => {},
    );
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const port = (front.address() as AddressInfo).port;
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1:${port}`],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  front?.close();
  app.close();
  rmSync(dir, { recursive: true, force: true });
});

const visitor = () => browser.newContext({ ignoreHTTPSErrors: true });
async function seen(ctx: BrowserContext, url: string) {
  const p = await ctx.newPage();
  await p.goto(url);
  const text = (await p.locator('#seen').textContent()) ?? '';
  await p.close();
  return text;
}
/** What a visit to `url` makes the page do; returns what the app got in the end. */
async function via(
  ctx: BrowserContext,
  url: string,
  act?: (p: import('@playwright/test').Page) => Promise<void>,
) {
  const p = await ctx.newPage();
  await p.goto(url);
  if (act) await act(p);
  await p.waitForURL(`${SHOP}/echo`);
  const text = (await p.locator('#seen').textContent()) ?? '';
  await p.close();
  return text;
}
const parentCookies = async (ctx: BrowserContext) =>
  (await ctx.cookies()).filter((c) => c.domain === `.${DOMAIN}`).map((c) => `${c.name}@${c.path}`);

describe('cookies between users’ sites on a shared domain, in a real browser', () => {
  it('without the gateway, a sibling site plants a session the app takes as real (the attack)', async () => {
    const ctx = await visitor();
    await seen(ctx, `${EVIL}/plant`);
    expect(await seen(ctx, `${RAW}/echo`)).toContain('sid=planted');
    await ctx.close();
  });

  it('keeps the app’s cookies its own, and drops and deletes every planted copy', async () => {
    const ctx = await visitor();
    await seen(ctx, `${SHOP}/login`);
    const jar = await ctx.cookies();
    const sid = jar.find((c) => c.name === '__Host-ad_sid');
    expect(sid).toMatchObject({
      domain: `shop.${DOMAIN}`,
      path: '/',
      httpOnly: true,
      secure: true,
    });
    expect(jar.map((c) => c.name)).not.toContain('sid');
    // Domain= stripped: the app's "wide" cookie stays on its own host.
    expect(jar.find((c) => c.name === 'wide')?.domain).toBe(`shop.${DOMAIN}`);

    const onEvil = await seen(ctx, `${EVIL}/plant`);
    expect(onEvil).not.toContain('wide');
    expect(onEvil).not.toContain('real');
    // Browsers refuse the __Host- form from another host, so it can't be forged.
    expect(await parentCookies(ctx)).not.toContain('__Host-ad_sid@/');

    const got = await seen(ctx, `${SHOP}/echo`);
    expect(got).toContain('sid=real');
    expect(got).not.toMatch(/sid=planted|deeper|disguised|forged/);
    expect(got).toContain('theme=dark');
    // A cookie scripts may read can't be told from a planted copy on the way in…
    expect(got).toContain('theme=planted');
    // …but the page load deleted every planted copy, on each path it could
    // hide on, before the page's scripts ran.
    const left = await parentCookies(ctx);
    for (const name of ['sid@/', 'sid@/echo', '%73id@/', 'theme@/'])
      expect(left).not.toContain(name);
    expect(await seen(ctx, `${SHOP}/echo`)).not.toContain('planted');
    await ctx.close();
  });

  it('a visitor who never signed in can’t be slipped the attacker’s session either', async () => {
    const ctx = await visitor();
    await seen(ctx, `${EVIL}/plant`);
    expect(await seen(ctx, `${SHOP}/echo`)).not.toMatch(/sid=/);
    await ctx.close();
  });

  it('treats a sibling’s form and links as cross-site, the way separate sites would be', async () => {
    const ctx = await visitor();
    await seen(ctx, `${SHOP}/login`);
    // A form posted from the sibling: no Lax or Strict cookies, SameSite=None ones still go.
    const posted = await via(ctx, `${EVIL}/form`);
    expect(posted).not.toMatch(/(^|; )(sid|strict)=/);
    expect(posted).toContain('open=1');
    // A link followed from the sibling: Lax goes, Strict doesn't.
    const linked = await via(ctx, `${EVIL}/link`, (p) => p.click('#go'));
    expect(linked).toContain('sid=real');
    expect(linked).not.toContain('strict=1');
    // Typed into the address bar: everything.
    expect(await seen(ctx, `${SHOP}/echo`)).toContain('strict=1');
    await ctx.close();
  });

  it('signs out even when the app’s deletion leaves HttpOnly out', async () => {
    const ctx = await visitor();
    await seen(ctx, `${SHOP}/login`);
    await seen(ctx, `${SHOP}/logout`);
    expect((await ctx.cookies()).map((c) => c.name)).not.toContain('__Host-ad_sid');
    expect(await seen(ctx, `${SHOP}/echo`)).not.toContain('sid=');
    await ctx.close();
  });
});
