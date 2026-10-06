// Records the landing page's "watch a self-heal" video against the local stack
// (AI_PROVIDERS=mock): import a repo with a TypeScript error → build fails →
// AI patch → rebuilt and validated → approved → live site.
//   web on http://localhost:3100 (next start), api with APP_URL=http://localhost:3100,
//   worker + edge running; then: pnpm tsx tests/demo/record-self-heal.ts /tmp/acme-shop
// Output: tests/demo/out/*.webm (convert with ffmpeg, see tests/demo/README.md).
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repoDir = process.argv[2] ?? '/tmp/acme-shop';
const base = process.env.DEMO_URL ?? 'http://localhost:3100';
const out = join(dirname(fileURLToPath(import.meta.url)), 'out');
await mkdir(out, { recursive: true });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: base,
  viewport: { width: 1280, height: 760 },
  deviceScaleFactor: 1,
  colorScheme: 'dark',
  recordVideo: { dir: out, size: { width: 1280, height: 760 } },
});
const page = await context.newPage();
const login = await page.request.post('/auth/dev-login', {
  data: { login: `demo-${Date.now().toString(36)}` },
});
if (!login.ok()) throw new Error(`dev login failed: ${login.status()}`);

await page.goto('/projects/new');
await pause(800);
await page.getByLabel('Repository URL').pressSequentially(`file://${repoDir}`, { delay: 25 });
await pause(400);
await page.getByRole('button', { name: 'Analyze' }).click();
await page.getByText(/^Analysis @/).waitFor();
await pause(4000); // let the evidence column be read
await page.getByRole('button', { name: /Deploy/ }).click();
await page.waitForURL(/\/deployments\//);

// Build 1 fails, rules don't apply, the AI patch is rebuilt and validated.
const approve = page.getByRole('button', { name: 'Approve & deploy' });
await approve.waitFor({ timeout: 240_000 });
await pause(1200);
await approve.scrollIntoViewIfNeeded();
await pause(5000); // the diff and the policy checks
await approve.click();
await page.getByText(/recovered automatically \(AI patch, approved\)/).waitFor({ timeout: 120_000 });
await page.getByRole('tab', { name: /Logs/ }).click();
await pause(3500);

// The live site, served by the edge Worker from the content-addressed artifact.
const projectHref = await page.locator('h1 a[href^="/projects/"]').first().getAttribute('href');
const slug = projectHref?.split('/').pop();
const projects = (await (await page.request.get('/api/v1/projects')).json()) as {
  items?: Array<{ id: string; slug: string }>;
};
const live = projects.items?.find((p) => p.id === slug)?.slug ?? slug;
await page.goto(`http://${live}.autodeploy.localhost:8787/`);
await pause(4500);

await context.close();
await browser.close();
console.log(`recorded to ${out}`);
