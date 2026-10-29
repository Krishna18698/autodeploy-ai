import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API_URL, REMOTE } from './smoke.config';

// What a user does, against a real running stack (see smoke.config.ts): every
// dashboard page renders with real data, three real apps are imported through
// the UI and checked live, a failed build is recovered by setting its env var
// and pressing "Deploy again", and everything created is deleted afterwards.

const RUN = Date.now().toString(36).slice(-5);
const REPO = process.env.E2E_REPO ?? 'https://github.com/Krishna18698/autodeploy-ai';
const FIXTURES = resolve(import.meta.dirname, 'fixtures');
const EDGE_URL = process.env.E2E_EDGE_URL ?? 'http://localhost:8787';

/** Remote: this repo on GitHub plus a root directory. Local: the fixture directory itself. */
function source(fixture: string) {
  return REMOTE
    ? { url: REPO, root: `tests/e2e/fixtures/${fixture}` }
    : { url: `file://${FIXTURES}/${fixture}`, root: '.' };
}

type Deployment = {
  id: string;
  errorCode?: string | null;
  number: number;
  status: string;
  url: string | null;
  projectId: string;
};
// READY is the brief step before a production deploy is activated, not an end.
const SETTLED = new Set(['ACTIVE', 'FAILED', 'NEEDS_INPUT', 'AWAITING_APPROVAL', 'CANCELED']);

/** An API path at the API's address (see smoke.config.ts). */
const A = (path: string) => `${API_URL}${path}`;

// ---- page health: any uncaught error or failed page fails the test ----------

const IGNORED = [/cloudflareinsights/, /status of 401/];
function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORED.some((r) => r.test(m.text())))
      problems.push(`${page.url()}: console: ${m.text().slice(0, 200)}`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    const ours = [new URL(page.url()).origin, API_URL && new URL(API_URL).origin];
    if (r.status() >= 500 && ours.includes(u.origin)) problems.push(`${r.status()} ${u.pathname}`);
  });
  return problems;
}

async function expectRendered(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const main = page.locator('main');
  await expect(main, `${path} rendered nothing`).not.toBeEmpty();
  await expect(page.getByText("This page couldn't load")).toHaveCount(0);
  await expect(page.getByText('Application error')).toHaveCount(0);
}

// ---- API helpers (same auth as the browser) --------------------------------

async function api<T>(req: APIRequestContext, path: string): Promise<T> {
  const r = await req.get(path);
  expect(r.ok(), `GET ${path} → ${r.status()}`).toBe(true);
  return r.json() as Promise<T>;
}

async function waitSettled(req: APIRequestContext, id: string, minutes = 10): Promise<Deployment> {
  const until = Date.now() + minutes * 60_000;
  let last = '';
  for (;;) {
    const d = await api<Deployment>(req, A(`/api/v1/deployments/${id}`));
    if (d.status !== last) console.log(`  #${d.number} ${d.status}`);
    last = d.status;
    if (SETTLED.has(d.status)) {
      if (d.status !== 'ACTIVE') await printLogTail(req, d);
      return d;
    }
    if (Date.now() > until) throw new Error(`deployment ${id} stuck in ${d.status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** On a failed deployment, show why (the project is deleted at the end, logs with it). */
async function printLogTail(req: APIRequestContext, d: Deployment) {
  const r = await req.get(A(`/api/v1/deployments/${d.id}/logs`));
  const lines = r.ok() ? ((await r.json()) as { lines: { text: string }[] }).lines : [];
  console.log(
    `  #${d.number} ended ${d.status} (${d.errorCode ?? 'no error code'}); last log lines:`,
  );
  for (const l of lines.slice(-40)) console.log(`    | ${l.text}`);
}

/** Fetches a deployed site with no dashboard credentials (locally via the edge, by Host). */
async function site(
  url: string,
  path = '/',
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<{
  status: number;
  body: string;
  setCookie: string[];
  headers: Record<string, string>;
}> {
  const target = new URL(path, url);
  if (REMOTE) {
    // 2026-10-23: a just-deployed site once took over 60 s to answer this
    // machine. A read is asked again (up to 3 times, 20 s each), and every miss
    // is logged with its cause: this machine's network (DNS, connecting) or a
    // slow answer. A POST is sent once: it may have done its work.
    const read = init.method === undefined || init.method === 'GET' || init.method === 'HEAD';
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(target, {
          method: init.method ?? 'GET',
          body: init.body,
          headers: { ...(init.body && { 'content-type': 'application/json' }), ...init.headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(read ? 20_000 : 60_000),
        });
        return {
          status: r.status,
          body: await r.text(),
          setCookie: r.headers.getSetCookie(),
          headers: Object.fromEntries(r.headers),
        };
      } catch (err) {
        const e = err as Error & { cause?: { code?: string } };
        console.warn(`site ${target.href}: attempt ${attempt} failed (${e.cause?.code ?? e.name})`);
        if (!read || attempt === 3) throw err;
      }
    }
  }
  const edge = new URL(EDGE_URL);
  return new Promise((resolveP, reject) => {
    const req = httpRequest(
      {
        host: edge.hostname,
        port: edge.port,
        path: target.pathname + target.search,
        method: init.method ?? 'GET',
        headers: {
          host: target.host,
          'accept-encoding': 'identity',
          ...(init.body && { 'content-type': 'application/json' }),
          ...init.headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolveP({
            status: res.statusCode ?? 0,
            body,
            setCookie: res.headers['set-cookie'] ?? [],
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
            ),
          }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`site ${target.host} timed out`)));
    req.end(init.body);
  });
}

// ---- the flows -------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

const created: string[] = [];
let staticSite = { projectId: '', url: '' };

test.beforeEach(async ({ page }) => {
  if (REMOTE) return;
  const r = await page.request.post('/auth/dev-login', { data: { login: `e2e-smoke-${RUN}` } });
  expect(r.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  // Cookie sessions must send their CSRF token on writes; API tokens don't.
  let headers: Record<string, string> = {};
  if (!REMOTE) {
    const r = await request.post('/auth/dev-login', { data: { login: `e2e-smoke-${RUN}` } });
    headers = { 'x-csrf-token': (await r.json()).csrfToken };
  }
  for (const id of created) {
    const r = await request.delete(A(`/api/v1/projects/${id}`), { headers });
    console.log(`  cleanup ${id}: ${r.status()}`);
  }
});

/** Imports a fixture through the UI and returns the first deployment's id. */
async function importFixture(page: Page, fixture: string, slug: string): Promise<string> {
  const src = source(fixture);
  await page.goto('/projects/new');
  await page.getByLabel('Repository URL').fill(src.url);
  await page.getByLabel('Root directory').fill(src.root);
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(/^Analysis @/)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Site address').fill(slug);
  await expect(page.getByText('✓ available')).toBeVisible();
  await page.getByRole('button', { name: /Deploy/ }).click();
  await expect(page).toHaveURL(/\/deployments\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const id = page.url().split('/deployments/')[1]?.split(/[?#]/)[0] ?? '';
  const d = await api<Deployment>(page.request, A(`/api/v1/deployments/${id}`));
  created.push(d.projectId);
  return id;
}

test('signed in', async ({ page }) => {
  const me = await api<{ user: { login: string }; org: { slug: string } }>(
    page.request,
    A('/api/v1/me'),
  );
  console.log(`  as ${me.user.login} (${me.org.slug}) on ${REMOTE ? 'production' : 'local'}`);
});

test('every dashboard page renders, including each project and its latest deployment', async ({
  page,
}) => {
  const problems = watch(page);
  for (const path of [
    '/overview',
    '/projects',
    '/deployments',
    '/recovery',
    '/analytics',
    '/settings',
    '/projects/new',
  ])
    await expectRendered(page, path);
  const { items } = await api<{ items: { id: string; slug: string }[] }>(
    page.request,
    A('/api/v1/projects?limit=20'),
  );
  for (const p of items) {
    await expectRendered(page, `/projects/${p.id}`);
    const deps = await api<{ items: { id: string }[] }>(
      page.request,
      A(`/api/v1/deployments?projectId=${p.id}&limit=1`),
    );
    if (deps.items[0]) await expectRendered(page, `/deployments/${deps.items[0].id}`);
  }
  expect(problems).toEqual([]);
});

test("every live site answers at its address as it does at its deployment's own address", async ({
  page,
}) => {
  // Both hostnames resolve through different edge routes. If they disagree, the
  // production route has drifted from the deployment (a server-rendered site
  // once became a static one, and every page 404'd).
  const { items } = await api<{
    items: { slug: string; url: string; activeDeploymentId: string | null }[];
  }>(page.request, A('/api/v1/projects?limit=50'));
  const live = items.filter((p) => p.activeDeploymentId);
  for (const p of live) {
    const d = await api<Deployment>(page.request, A(`/api/v1/deployments/${p.activeDeploymentId}`));
    const pinned = p.url.replace(`://${p.slug}.`, `://d${d.number}--${p.slug}.`);
    const [main, own] = [await site(p.url), await site(pinned)];
    console.log(`  ${p.slug}: ${main.status} (pinned #${d.number}: ${own.status})`);
    expect(main.status, `${p.url} vs ${pinned}`).toBe(own.status);
    expect(main.status, p.url).toBeLessThan(500);
  }
});

test('a static site builds, goes live and is served by the edge', async ({ page }) => {
  const problems = watch(page);
  const id = await importFixture(page, 'static-vite', `e2e-static-${RUN}`);
  // Watching the deploy go live, the log panel never blanks (it did when the
  // live stream closed, until 2026-10-29).
  await page.evaluate(() => {
    const w = window as unknown as { blanked?: boolean };
    new MutationObserver(() => {
      if (document.body.textContent?.includes('No log lines.')) w.blanked = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  const d = await waitSettled(page.request, id);
  expect(d.status).toBe('ACTIVE');
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const blanked = await page.evaluate(() => (window as unknown as { blanked?: boolean }).blanked);
  expect(blanked, 'the log panel blanked as the deploy went live').toBeFalsy();
  await expectRendered(page, `/deployments/${id}`);
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible();
  const home = await site(d.url ?? '');
  expect(home.status).toBe(200);
  const js = home.body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect(js, 'built script referenced').toBeTruthy();
  expect((await site(d.url ?? '', js)).body).toContain('e2e static ok');
  staticSite = { projectId: d.projectId, url: d.url ?? '' };
  expect(problems).toEqual([]);
});

test('a pnpm project pinned to a version the build image lacks still builds', async ({ page }) => {
  const id = await importFixture(page, 'static-pnpm', `e2e-pnpm-${RUN}`);
  const d = await waitSettled(page.request, id);
  expect(d.status).toBe('ACTIVE');
  const home = await site(d.url ?? '');
  const js = home.body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  expect((await site(d.url ?? '', js)).body).toContain('e2e pnpm ok');
});

test('a server-rendered app runs on demand: pages, POST, guarded egress', async ({ page }) => {
  const problems = watch(page);
  const id = await importFixture(page, 'ssr-next', `e2e-ssr-${RUN}`);
  const d = await waitSettled(page.request, id, 15);
  expect(d.status).toBe('ACTIVE');
  await expectRendered(page, `/deployments/${id}`);
  const url = d.url ?? '';

  const first = await site(url);
  expect(first.status).toBe(200);
  expect(first.body).toContain('e2e ssr ok at');
  const again = await site(url);
  expect(again.body, 'rendered per request').not.toBe(first.body);

  const echo = await site(url, '/api/echo', {
    method: 'POST',
    body: JSON.stringify({ message: RUN }),
  });
  expect(JSON.parse(echo.body)).toEqual({ echo: RUN, method: 'POST' });

  if (REMOTE) {
    // Only production runs the real egress proxy and SSRF guard.
    const out = JSON.parse((await site(url, '/api/egress?to=public')).body);
    expect(out, 'public internet reachable').toMatchObject({ reached: true, status: 200 });
    const meta = JSON.parse((await site(url, '/api/egress?to=metadata')).body);
    expect(meta.reached, 'cloud metadata refused').toBe(false);
  }

  await page.goto(`/deployments/${id}`);
  await expect(page.getByText(/Server/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

// Server-rendered apps beyond Next.js: each runs from its own start command.
// Production allows 3 server projects per org, so each test deletes its own.
const SERVER_APPS: { fixture: string; marker: string; always?: boolean }[] = [
  { fixture: 'ssr-node', marker: 'e2e node ok at', always: true },
  { fixture: 'ssr-sveltekit', marker: 'e2e sveltekit ok at' },
  { fixture: 'ssr-astro', marker: 'e2e astro ok at' },
  { fixture: 'ssr-nuxt', marker: 'e2e nuxt ok at' },
];
for (const app of SERVER_APPS) {
  test(`a server-rendered ${app.fixture.replace('ssr-', '')} app runs from its own start command`, async ({
    page,
  }) => {
    test.skip(
      !app.always && !process.env.E2E_FRAMEWORKS,
      'set E2E_FRAMEWORKS=1 for every framework',
    );
    const id = await importFixture(
      page,
      app.fixture,
      `e2e-${app.fixture.replace('ssr-', '')}-${RUN}`,
    );
    try {
      const d = await waitSettled(page.request, id, 15);
      expect(d.status).toBe('ACTIVE');
      const first = await site(d.url ?? '');
      expect(first.status).toBe(200);
      expect(first.body).toContain(app.marker);
      const again = await site(d.url ?? '');
      expect(again.body, 'rendered per request').not.toBe(first.body);
      if (app.fixture === 'ssr-node') {
        const echo = await site(d.url ?? '', '/echo', {
          method: 'POST',
          body: JSON.stringify({ message: RUN }),
        });
        expect(JSON.parse(echo.body)).toEqual({ echo: RUN });

        // Cookies on the sites' shared domain (packages/core/src/site-cookies.ts),
        // through the real edge, tunnel and gateway: the app's are kept its own,
        // planted copies dropped and deleted, a sibling's form sent none.
        const url = d.url ?? '';
        const parent = new URL(url).hostname.split('.').slice(1).join('.');
        const login = (await site(url, '/login')).setCookie.join('\n');
        expect(login).toMatch(/^__Host-ad_sid=e2e; .*Path=\/; Secure$/m);
        expect(login).not.toMatch(/domain=/i);
        const jar = await site(url, '/cookies', {
          headers: { cookie: 'sid=planted; __Host-ad_sid=e2e' },
        });
        expect(JSON.parse(jar.body)).toEqual({ cookie: 'sid=e2e' });
        expect(jar.setCookie).toContain(`sid=; Domain=${parent}; Path=/; Max-Age=0; Secure`);
        const forged = await site(url, '/cookies', {
          method: 'POST',
          headers: {
            cookie: '__Host-ad_sid=e2e',
            'sec-fetch-site': 'same-site',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-dest': 'document',
          },
        });
        expect(JSON.parse(forged.body)).toEqual({ cookie: null });
        // The edge's part, for every site: a flood is cleaned up (and cut to
        // what the gateway takes), a site can't clear every site's cookies.
        const flood = Array.from({ length: 60 }, (_, i) => `f${i}=1`).join('; ');
        const flooded = await site(url, '/cookies', {
          headers: { cookie: `${flood}; __Host-ad_sid=e2e; pad=${'x'.repeat(14_000)}` },
        });
        expect(JSON.parse(flooded.body).cookie).toMatch(/^sid=e2e; f0=1; /);
        expect(flooded.setCookie).toContain(`f0=; Domain=${parent}; Path=/; Max-Age=0; Secure`);
        const cleared = await site(url, '/clear');
        expect(cleared.status).toBe(200);
        expect(cleared.headers['clear-site-data']).toBe('"cache"');
        expect(cleared.headers['origin-agent-cluster']).toBe('?1');
      }
    } finally {
      const dep = await api<Deployment>(page.request, A(`/api/v1/deployments/${id}`));
      const { csrfToken } = await api<{ csrfToken: string | null }>(page.request, A('/api/v1/me'));
      await page.request.delete(A(`/api/v1/projects/${dep.projectId}`), {
        headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
      });
      created.splice(created.indexOf(dep.projectId), 1);
    }
  });
}

test('a type error is repaired by AI, approved by a person, and goes live', async ({ page }) => {
  // Needs real AI providers; production has them once the keys are in.
  test.skip(!process.env.E2E_AI, 'set E2E_AI=1 when AI providers are configured');
  const id = await importFixture(page, 'ai-ts-error', `e2e-ai-${RUN}`);
  const waiting = await waitSettled(page.request, id, 15);
  expect(waiting.status, 'the AI patch waits for approval').toBe('AWAITING_APPROVAL');

  await expectRendered(page, `/deployments/${id}`);
  await page.getByRole('tab', { name: /Recovery/ }).click();
  await expect(page.getByText(/within patch policy/)).toBeVisible();
  await expect(page.getByText('src/config.ts').first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve & deploy' }).click();
  // AWAITING_APPROVAL counts as settled, so first wait for the approval to land.
  await expect
    .poll(
      async () => (await api<Deployment>(page.request, A(`/api/v1/deployments/${id}`))).status,
      {
        timeout: 60_000,
      },
    )
    .not.toBe('AWAITING_APPROVAL');

  const live = await waitSettled(page.request, id);
  expect(live.status).toBe('ACTIVE');
  expect((await site(live.url ?? '')).body).toContain('e2e ai ok');
});

test('a failed build is never a dead end: set the env var, deploy again, live', async ({
  page,
}) => {
  const problems = watch(page);
  const id = await importFixture(page, 'needs-env', `e2e-env-${RUN}`);
  const failed = await waitSettled(page.request, id);
  expect(['FAILED', 'NEEDS_INPUT']).toContain(failed.status);

  // The deployment page offers a way forward.
  await expectRendered(page, `/deployments/${id}`);
  await expect(page.getByRole('button', { name: 'Deploy again' })).toBeVisible();

  // Fix it the way a user would: project → Environment. One variable by hand,
  // the one the build needs from a pasted .env (with a line that must be skipped).
  await expectRendered(page, `/projects/${failed.projectId}`);
  await page.getByRole('tab', { name: 'Environment' }).click();
  await page.getByLabel('Name').fill('E2E_UNUSED');
  await page.getByLabel('Value').fill('by hand');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('E2E_UNUSED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Import .env' }).click();
  await page
    .getByLabel('.env contents')
    .fill(`# from my laptop\nE2E_GREETING="hi-${RUN}"\nnot valid line\n`);
  await expect(page.getByLabel('Variables to import')).toContainText('E2E_GREETING');
  await expect(page.getByText('line 3 skipped: not KEY=value')).toBeVisible();
  await page.getByRole('button', { name: 'Import 1 variable' }).click();
  await expect(page.getByText('E2E_GREETING', { exact: true })).toBeVisible();

  await page.goto(`/deployments/${id}`);
  await page.getByRole('button', { name: 'Deploy again' }).click();
  await expect(page).not.toHaveURL(new RegExp(id), { timeout: 30_000 });
  const nextId = page.url().split('/deployments/')[1]?.split(/[?#]/)[0] ?? '';
  const live = await waitSettled(page.request, nextId);
  expect(live.status).toBe('ACTIVE');
  expect((await site(live.url ?? '')).body).toContain(`e2e env ok: hi-${RUN}`);
  expect(problems).toEqual([]);
});

test('re-importing an existing project is refused with a way out', async ({ page }) => {
  const src = source('static-vite');
  await page.goto('/projects/new');
  await page.getByLabel('Repository URL').fill(src.url);
  await page.getByLabel('Root directory').fill(src.root);
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(/^Analysis @/)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel('Site address').fill(`e2e-dupe-${RUN}`);
  await expect(page.getByText('✓ available')).toBeVisible();
  await page.getByRole('button', { name: /Deploy/ }).click();
  await expect(page.getByText(/already a project/)).toBeVisible();
});

// Form controls shorter than this on a phone are a layout bug (a flex-1 input
// in a stacked form once collapsed to ~18px); small row actions are size="sm" (28px).
const squashed = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main input, main select, main textarea')]
      .filter(
        (el) =>
          el.offsetParent !== null &&
          !['checkbox', 'radio'].includes(el.getAttribute('type') ?? ''),
      )
      .map((el) => ({
        control: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName,
        height: Math.round(el.getBoundingClientRect().height),
      }))
      .filter((c) => c.height < 32),
  );

test('no dashboard page scrolls sideways or squashes a form on a phone', async ({ browser }) => {
  const ctx = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: test.info().project.use.extraHTTPHeaders,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  if (!REMOTE) await page.request.post('/auth/dev-login', { data: { login: `e2e-smoke-${RUN}` } });
  const problems = watch(page);
  for (const path of [
    '/overview',
    '/projects',
    '/deployments',
    '/analytics',
    '/settings',
    '/projects/new',
    '/terms',
    '/privacy',
    '/acceptable-use',
    '/security',
    '/login',
    '/forgot-password',
  ]) {
    await expectRendered(page, path);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
    expect(await squashed(page), path).toEqual([]);
  }
  await page.goto('/settings');
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    expect(await squashed(page), `settings: ${await tab.textContent()}`).toEqual([]);
  }
  expect(problems).toEqual([]);
  await ctx.close();
});

test('deleting a project takes its site off the edge', async ({ page }) => {
  test.skip(!staticSite.url, 'static site test did not run');
  // Cookie sessions send their CSRF token on writes (the token session needs none).
  const { csrfToken } = await api<{ csrfToken: string | null }>(page.request, A('/api/v1/me'));
  const csrf: Record<string, string> = csrfToken ? { 'x-csrf-token': csrfToken } : {};
  const r = await page.request.delete(A(`/api/v1/projects/${staticSite.projectId}`), {
    headers: csrf,
  });
  expect(r.status(), await r.text()).toBe(204);
  created.splice(created.indexOf(staticSite.projectId), 1);
  // The edge caches routes briefly (KV is eventually consistent), so allow a few minutes.
  const until = Date.now() + 4 * 60_000;
  let status = 0;
  while (Date.now() < until) {
    status = (await site(staticSite.url)).status;
    if (status === 404) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  expect(status, 'site still served after delete').toBe(404);
});

// Navigating by clicking (client-side), not by loading URLs: the page
// transition once stalled here and left pages invisible.
for (const width of [977, 390]) {
  test(`clicking through the sidebar never leaves a blank page (${width}px)`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: test.info().project.use.extraHTTPHeaders,
      viewport: { width, height: 800 },
    });
    const page = await ctx.newPage();
    if (!REMOTE)
      await page.request.post('/auth/dev-login', { data: { login: `e2e-smoke-${RUN}` } });
    const problems = watch(page);
    await page.goto('/overview', { waitUntil: 'networkidle' });
    // The dashboard draws once the account has loaded; before that there is no
    // menu button to find (the network can go quiet before it does).
    await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main' });
    const menu = page.getByRole('button', { name: /^(Open|Close) menu$/ });
    const route = ['Settings', 'Projects', 'Overview', 'Settings', 'Analytics', 'Deployments'];
    for (const name of [...route, ...route]) {
      const link = nav.getByRole('link', { name, exact: true });
      if (await menu.isVisible())
        await expect(async () => {
          if (!(await link.isVisible())) await menu.click();
          await expect(link).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 15_000 });
      await link.click();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
      // Fully visible soon after: a page stuck faded out (the bug this guards
      // against) never gets there; a fade-in that restarts late still does.
      await expect
        .poll(() => page.locator('main').evaluate((m) => getComputedStyle(m).opacity), {
          message: `${name} faded in`,
          timeout: 2_000,
        })
        .toBe('1');
    }
    expect(problems).toEqual([]);
    await ctx.close();
  });
}

test('a hostile build stays in its sandbox, and its secret stays out of the log', async ({
  page,
}) => {
  // Created through the API so the secret is set before the only build.
  const req = page.request;
  let headers: Record<string, string> = {};
  if (!REMOTE) {
    const r = await req.post('/auth/dev-login', { data: { login: `e2e-smoke-${RUN}` } });
    headers = { 'x-csrf-token': (await r.json()).csrfToken };
  }
  const src = source('hostile-build');
  const made = await req.post(A('/api/v1/projects'), {
    headers,
    data: { repoUrl: src.url, rootDir: src.root, slug: `e2e-hostile-${RUN}`, deploy: false },
  });
  expect(made.ok(), await made.text()).toBe(true);
  const { project } = (await made.json()) as { project: { id: string } };
  created.push(project.id);
  const secret = `e2e-s3cret-${RUN}-${Math.random().toString(36).slice(2, 10)}`;
  const put = await req.put(A(`/api/v1/projects/${project.id}/env/E2E_SECRET`), {
    headers,
    data: { value: secret },
  });
  expect(put.ok(), await put.text()).toBe(true);
  const dep = await req.post(A(`/api/v1/projects/${project.id}/deployments`), {
    headers,
    data: {},
  });
  expect(dep.ok(), await dep.text()).toBe(true);
  const d = await waitSettled(req, ((await dep.json()) as { id: string }).id);
  expect(d.status).toBe('ACTIVE');

  const { lines } = await api<{ lines: { text: string }[] }>(
    req,
    A(`/api/v1/deployments/${d.id}/logs`),
  );
  const text = lines.map((l) => l.text).join('\n');
  const got = Object.fromEntries(
    [...text.matchAll(/escape: ([\w-]+): (.*)$/gm)].map((m) => [m[1], m[2]?.trim()]),
  );
  console.log('  sandbox:', got);
  for (const way of ['internet', 'metadata', 'api', 'postgres', 'valkey', 'gateway', 'host-ssh'])
    expect(got[way], way).toMatch(/^blocked/);
  expect(got['write-outside']).toMatch(/^denied/);
  expect(got['host-files']).toBe('[]');
  expect(got.secret).toBe('the token is [redacted]');
  expect(text).not.toContain(secret);
});

test('a dashboard crash can be reported, and only from the dashboard', async ({ page }) => {
  const report = {
    kind: 'error',
    name: 'SmokeTest',
    message: '[smoke] synthetic dashboard error, ignore',
    path: '/smoke',
  };
  const ok = await page.request.post(A('/api/v1/client-errors'), { data: report });
  expect(ok.status()).toBe(204);
  const foreign = await page.request.post(A('/api/v1/client-errors'), {
    data: report,
    headers: { origin: 'https://evil.example' },
  });
  expect(foreign.status()).toBe(403);
});

test('the notification email can be read and saved', async ({ page }) => {
  const me = await api<{ user: { email: string | null } }>(page.request, A('/api/v1/me'));
  expect(me.user).toHaveProperty('email');
  // Saving the same value proves the endpoint without changing anything.
  const { csrfToken } = await api<{ csrfToken: string | null }>(page.request, A('/api/v1/me'));
  const r = await page.request.patch(A('/api/v1/me'), {
    data: { email: me.user.email },
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
  });
  expect(r.status()).toBe(204);
  await expectRendered(page, '/settings');
  await page.getByRole('tab', { name: 'Account' }).click();
  await expect(page.getByLabel('Notification email')).toHaveValue(me.user.email ?? '');
});

test('email sign-in never reveals who has an account', async ({ browser }) => {
  // A fresh browser: no session, no API token (contexts made here inherit the
  // suite's token header unless told otherwise, and the sign-in page sends
  // anyone signed in straight to the dashboard). Only made-up addresses that
  // have no account are used, so no email is ever sent to them.
  const ctx = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    extraHTTPHeaders: {},
  });
  const page = await ctx.newPage();
  const nobody = `nobody-${RUN}@example.com`;
  await page.goto('/login');
  await page.getByLabel('Email').fill(nobody);
  await page.getByLabel('Password').fill('not the password 1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('main [role=alert]')).toHaveText('Wrong email or password.');

  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(nobody);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByText(`If ${nobody} has an AutoDeploy account`)).toBeVisible();

  await ctx.close();
});

test('a repository AutoDeploy cannot see gets a clear way forward, not a 500', async ({ page }) => {
  await page.goto('/projects/new');
  await page.getByLabel('Repository URL').fill('https://github.com/Krishna18698/no-such-repo-e2e');
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(/can't see this repository/)).toBeVisible();
  await expect(page.getByText(/Something went wrong/)).toHaveCount(0);
});
