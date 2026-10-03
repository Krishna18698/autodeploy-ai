import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const repo = (name: string) => `file://${resolve(import.meta.dirname, '../corpus/repos', name)}`;

// A fresh user per run keeps the suite repeatable (repos can only be imported once per org).
const RUN_USER = `e2e-${Date.now().toString(36)}`;

async function signIn(page: Page) {
  const r = await page.request.post('/auth/dev-login', { data: { login: RUN_USER } });
  expect(r.ok()).toBe(true);
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

async function importAndDeploy(page: Page, name: string) {
  await page.goto('/projects/new');
  await page.getByLabel('Repository URL').fill(repo(name));
  await page.getByRole('button', { name: 'Analyze' }).click();
  await expect(page.getByText(/^Analysis @/)).toBeVisible();
  await expect(page.getByText('✓ available')).toBeVisible();
  await page.getByRole('button', { name: /Deploy/ }).click();
  await expect(page).toHaveURL(/\/deployments\//);
}

test.describe.configure({ mode: 'serial' });

// The project created by the first test, reused by the rollback test.
let firstProjectPath = '';

test('the sign-in button signs you in', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Developer sign-in/ }).click();
  await expect(page).toHaveURL(/\/overview/);
});

test('sign in, import a repo, watch it build and go live', async ({ page }) => {
  await signIn(page);
  await importAndDeploy(page, 'ok-node22');
  await expect(page.getByText('Live', { exact: true }).first()).toBeVisible({ timeout: 180_000 });
  await expect(page.getByRole('log')).toContainText('build');
  await expect(page.getByAltText(/Headless Chromium screenshot/)).toBeVisible();
  firstProjectPath =
    (await page.locator('h1 a[href^="/projects/"]').first().getAttribute('href')) ?? '';
  expect(firstProjectPath).toMatch(/^\/projects\//);
});

test('a failing build is fixed by a rule and the fix is explained', async ({ page }) => {
  await signIn(page);
  await importAndDeploy(page, 'r005-output-www');
  await expect(page.getByText(/recovered automatically \(deterministic rule\)/)).toBeVisible({
    timeout: 180_000,
  });
  await page.getByRole('tab', { name: /Recovery/ }).click();
  await expect(page.getByText('R-005')).toBeVisible();
  await expect(page.getByText(/outputDir/)).toBeVisible();
});

test('an AI repair waits for approval, then ships', async ({ page }) => {
  await signIn(page);
  await importAndDeploy(page, 'ai-ts-type');
  await expect(page.getByRole('button', { name: 'Approve & deploy' })).toBeVisible({
    timeout: 180_000,
  });
  await expect(page.getByText(/within patch policy/)).toBeVisible();
  await expect(page.getByText("+export const port: string = '3000';")).toBeVisible();
  await page.getByRole('button', { name: 'Approve & deploy' }).click();
  await expect(page.getByText(/recovered automatically \(AI patch, approved\)/)).toBeVisible({
    timeout: 60_000,
  });
});

test('roll back to a previous deployment from the history', async ({ page }) => {
  await signIn(page);
  await page.goto(firstProjectPath);
  await page.getByRole('button', { name: 'Deploy latest' }).click();
  await expect(page.getByText(/Deployment #\d+ queued/)).toBeVisible();
  const rollback = page.getByRole('button', { name: 'Roll back' }).first();
  await expect(rollback).toBeVisible({ timeout: 180_000 });
  await rollback.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Roll back' }).click();
  await expect(page.getByText(/Rolled back to #\d+ in \d+ ms — no rebuild/)).toBeVisible();
});

test('dashboard pages have no serious accessibility violations', async ({ page }) => {
  await signIn(page);
  for (const path of [
    '/overview',
    '/projects',
    '/deployments',
    '/recovery',
    '/analytics',
    '/settings',
    '/projects/new',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${path}: ${v.id} (${v.nodes.length})`)).toEqual([]);
  }
});

test('no page scrolls sideways on a phone', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await signIn(page);
  for (const path of [
    '/',
    '/overview',
    '/projects',
    '/deployments',
    '/analytics',
    '/settings',
    '/recovery',
  ]) {
    await page.goto(path);
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  await ctx.close();
});

test('landing respects reduced motion and works without WebGL', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    // Simulate a browser without WebGL2.
    HTMLCanvasElement.prototype.getContext = function (type: string, ...rest: unknown[]) {
      return type === 'webgl2'
        ? null
        : (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
    } as typeof orig;
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Deploys that fix');
  // No SplitText wrappers: the headline renders as plain text.
  expect(await page.locator('h1 [data-split] div').count()).toBe(0);
  // The static gradient fallback replaces the canvas.
  await expect(page.locator('canvas')).toBeHidden();
  // Count-ups show their final values immediately.
  await expect(page.getByText('82', { exact: true }).first()).toBeAttached();
  await ctx.close();
});
