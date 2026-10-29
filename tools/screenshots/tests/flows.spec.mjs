/**
 * The main journeys through the real dashboard, in production, signed in with the smoke suite's
 * API token. Read-only: nothing is deployed, rolled back, saved or deleted (the rollback dialog
 * is opened and closed). The token is sent to the API's host only.
 */
import { test as base, expect } from '@playwright/test';
import { API, DEPLOY_SLUG, LIVE_SITE, token } from '../config.mjs';

const TOKEN = token();
const test = base.extend({
  signedIn: async ({ page }, use) => {
    await page.route(`${API}/**`, (route) =>
      route.continue({
        headers: { ...route.request().headers(), authorization: `Bearer ${TOKEN}` },
      }),
    );
    await use(page);
  },
});

/** On a phone the navigation sits behind the menu button. */
async function nav(page, name) {
  const menu = page.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
}

test('a visitor reads the landing page and reaches sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Deploys that fix');
  for (const id of ['features', 'how', 'recovery', 'numbers', 'architecture'])
    await expect(page.locator(`#${id}`)).toBeAttached();
  await page.goto('/login');
  await expect(page.getByText('Continue with GitHub')).toBeVisible();
});

test('signed in: overview → project → its live deployment, logs and timeline', async ({
  signedIn: page,
}) => {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await nav(page, 'Projects');
  await page
    .getByRole('link', { name: new RegExp(DEPLOY_SLUG) })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: DEPLOY_SLUG })).toBeVisible();
  // The live deployment's row, then its page.
  await page.getByRole('link', { name: /#\d+/ }).first().click();
  await expect(page.getByText(/\d+ lines/)).toBeVisible();
  await expect(page.getByText('Validated render')).toBeVisible();
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText(/→ ACTIVE/).first()).toBeVisible();
});

test('signed in: the rollback dialog opens and closes without rolling back', async ({
  signedIn: page,
}) => {
  await page.goto('/projects');
  await page
    .getByRole('link', { name: new RegExp(DEPLOY_SLUG) })
    .first()
    .click();
  await page.getByRole('button', { name: 'Roll back' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Roll back to #\d+\?/);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('signed in: importing a repository shows the analysis and its evidence', async ({
  signedIn: page,
}) => {
  await page.goto('/projects/new');
  await page
    .getByPlaceholder('https://github.com/owner/repo')
    .fill('https://github.com/Krishna18698/autodeploy-actions-test');
  await page.locator('button[type=submit]').first().click();
  for (const row of ['Framework', 'Package manager', 'Build', 'Output', 'Mode'])
    await expect(page.getByText(row, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('package-lock.json present').first()).toBeVisible();
});

test('signed in: deployments, recovery and analytics load', async ({ signedIn: page }) => {
  await page.goto('/overview');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  for (const [link, heading] of [
    ['Deployments', 'Deployments'],
    ['Recovery', 'Recovery center'],
    ['Analytics', 'Analytics'],
  ]) {
    await nav(page, link);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
});

test('a site AutoDeploy serves answers', async ({ page }) => {
  const res = await page.goto(LIVE_SITE);
  expect(res?.status()).toBe(200);
});
