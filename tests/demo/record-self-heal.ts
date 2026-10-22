// Records the landing page's "watch a self-heal" video: a real run on the live
// product, real AI included. The demo shop (tests/demo/acme-shop, a Vite +
// TypeScript app with a real type error) is imported from this repository on
// GitHub; the build fails, the production AI proposes a patch, it is rebuilt
// and checked in a browser, a person approves it, and the site goes live.
//
//   pnpm tsx tests/demo/record-self-heal.ts        (DEMO_URL, default production)
//
// Signs in with the smoke suite's API token (infra/deploy/.e2e-token). Writes
// tests/demo/out/<video>.webm and marks.json (when each phase happened, for the
// edit in tests/demo/README.md), then deletes the demo project.
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.DEMO_URL ?? 'https://app.autodeploy.fyi';
const repo = process.env.DEMO_REPO ?? 'https://github.com/Krishna18698/autodeploy-ai';
const slug = process.env.DEMO_SLUG ?? 'acme-shop';
const token = readFileSync(join(here, '../../infra/deploy/.e2e-token'), 'utf8').trim();
const out = join(here, 'out');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: base,
  viewport: { width: 1280, height: 760 },
  colorScheme: 'dark',
  extraHTTPHeaders: { authorization: `Bearer ${token}` },
  recordVideo: { dir: out, size: { width: 1280, height: 760 } },
});
const started = Date.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = (Date.now() - started) / 1000;
  console.log(`${marks[name].toFixed(1)}s  ${name}`);
};
const page = await context.newPage();
type Dep = { status: string; url: string | null; projectId: string };
const status = async (id: string) =>
  (await (await page.request.get(`/api/v1/deployments/${id}`)).json()) as Dep;
async function until(id: string, want: (s: string) => boolean, minutes: number) {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const d = await status(id);
    if (want(d.status)) return d;
    if (['FAILED', 'NEEDS_INPUT', 'CANCELED'].includes(d.status))
      throw new Error(`deployment ended ${d.status}`);
    if (Date.now() > end) throw new Error(`stuck in ${d.status}`);
    await pause(1500);
  }
}

let projectId = '';
try {
  await page.goto('/projects/new');
  mark('start');
  await pause(900);
  await page.getByLabel('Repository URL').pressSequentially(repo, { delay: 22 });
  // Select whatever is there and type over it, as a person would.
  await page.getByLabel('Root directory').click({ clickCount: 3 });
  await page.getByLabel('Root directory').pressSequentially('tests/demo/acme-shop', { delay: 22 });
  await pause(400);
  await page.getByRole('button', { name: 'Analyze' }).click();
  await page.getByText(/^Analysis @/).waitFor({ timeout: 90_000 });
  mark('analysis');
  await pause(3500); // the evidence column
  await page.getByLabel('Site address').fill(slug);
  await page.getByText('✓ available').waitFor();
  await pause(600);
  await page.getByRole('button', { name: /Deploy/ }).click();
  await page.waitForURL(/\/deployments\/[0-9a-f-]{36}/);
  const id = page.url().split('/deployments/')[1]?.split(/[?#]/)[0] ?? '';
  projectId = (await status(id)).projectId;
  mark('building');

  // Build 1 fails on the type error; rules don't cover it, so the AI steps in.
  await until(id, (s) => ['RECOVERING', 'BUILD_FAILED'].includes(s), 10);
  mark('failed');
  await until(id, (s) => s === 'AWAITING_APPROVAL', 15);
  mark('patched');
  await page.getByRole('tab', { name: /Recovery/ }).click();
  await pause(1500);
  const approve = page.getByRole('button', { name: 'Approve & deploy' });
  await approve.scrollIntoViewIfNeeded();
  await pause(6500); // diagnosis, the diff, the policy checks
  mark('approve');
  await approve.click();
  const live = await until(id, (s) => s === 'ACTIVE', 10);
  mark('live');
  await pause(2500);

  // The live site, at its own address.
  await page.goto(`https://${slug}.autodeploy.dpdns.org/`);
  await pause(4500);
  mark('end');
  console.log(`live at ${live.url}`);
} catch (err) {
  // What the screen showed when it went wrong.
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
  throw err;
} finally {
  await context.close();
  await browser.close();
  if (projectId) {
    const del = await fetch(`${base}/api/v1/projects/${projectId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    console.log(`demo project deleted: ${del.status}`);
  }
}
await writeFile(join(out, 'marks.json'), JSON.stringify(marks, null, 2));
console.log(`recorded: ${(await readdir(out)).join(', ')}`);
