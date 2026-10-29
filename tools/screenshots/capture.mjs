/**
 * Captures the real product, in production, signed in with the smoke suite's API token:
 *   project/screens/raw/{desktop,mobile}/<id>.png    screen-sized (1440×900 @2x, 390×700 @3x)
 *   project/screens/full/{desktop,mobile}/<id>.png   whole pages, where a page is longer
 *   project/hover-video/.frames/                     the deploy, recorded for video.mjs
 *
 *   node capture.mjs            every page, without deploying anything
 *   node capture.mjs --deploy   also deploys DEPLOY_SLUG once, capturing each stage as it happens
 *                               and recording the hover video (it changes that live site)
 *   node capture.mjs --live     only DEPLOY_SLUG's live deployment page and timeline
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import {
  API,
  APP,
  DEPLOY_SLUG,
  FULL,
  LIVE_SITE,
  LOCALE,
  RAW,
  SSR_SLUG,
  TZ,
  token,
  VIDEO,
  VIEWPORTS,
} from './config.mjs';

const DEPLOY = process.argv.includes('--deploy');
const LIVE_ONLY = process.argv.includes('--live');
const TOKEN = token();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failed = [];

async function apiGet(p) {
  const r = await fetch(API + p, { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`GET ${p}: ${r.status}`);
  return r.json();
}

const browser = await chromium.launch({ args: ['--hide-scrollbars'] });

/** The token goes to the API only, never to the dashboard's host or a site. */
async function context(vp, { auth = true } = {}) {
  const ctx = await browser.newContext({
    ...VIEWPORTS[vp],
    timezoneId: TZ,
    locale: LOCALE,
    colorScheme: 'dark',
  });
  if (auth)
    await ctx.route(`${API}/**`, (route) =>
      route.continue({
        headers: { ...route.request().headers(), authorization: `Bearer ${TOKEN}` },
      }),
    );
  return ctx;
}

/** Loaded, fonts in, no "Loading" placeholders left, entrance animations finished. */
async function settle(page, ms = 1200) {
  await page.waitForLoadState('load');
  await page.evaluate(() => document.fonts.ready);
  await page
    .waitForFunction(
      () => ![...document.querySelectorAll('.sr-only')].some((e) => e.textContent === 'Loading'),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});
  // Deployment thumbnails load lazily: wait for the ones on screen.
  await page
    .waitForFunction(
      () =>
        [...document.images].every((i) => {
          const r = i.getBoundingClientRect();
          return i.complete || r.bottom < 0 || r.top > innerHeight;
        }),
      null,
      { timeout: 15_000 },
    )
    .catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page, vp, id, { full = false } = {}) {
  fs.mkdirSync(path.join(RAW, vp), { recursive: true });
  await page.screenshot({ path: path.join(RAW, vp, `${id}.png`) });
  if (full) {
    fs.mkdirSync(path.join(FULL, vp), { recursive: true });
    await page.screenshot({ path: path.join(FULL, vp, `${id}.png`), fullPage: true });
  }
  console.log(`  ✓ ${vp}/${id}`);
}

/** Runs one capture; a failure is reported at the end instead of stopping the run. */
async function step(id, fn) {
  try {
    await fn();
  } catch (e) {
    failed.push(`${id}: ${e.message.split('\n')[0]}`);
    console.log(`  ✗ ${id}: ${e.message.split('\n')[0]}`);
  }
}

// ---------- public pages ---------------------------------------------------------------------

const SECTIONS = [
  ['02-landing-features', '#features'],
  ['03-landing-logs', '#how'],
  ['04-landing-recovery', '#recovery'],
  ['05-landing-numbers', '#numbers'],
  ['06-landing-architecture', '#architecture'],
];

async function publicPages(vp) {
  const ctx = await context(vp, { auth: false });
  const page = await ctx.newPage();
  await step('01-landing', async () => {
    await page.goto(APP);
    await settle(page, 2500);
    await shot(page, vp, '01-landing', { full: true });
  });
  for (const [id, sel] of SECTIONS)
    await step(id, async () => {
      await page.locator(sel).evaluate((el) => el.scrollIntoView({ block: 'start' }));
      // Counters and fade-ins run once a section is on screen.
      await page.waitForTimeout(2600);
      await shot(page, vp, id);
    });
  await step('07-login', async () => {
    await page.goto(`${APP}/login`);
    await settle(page);
    await shot(page, vp, '07-login');
  });
  await step('99-site-live', async () => {
    await page.goto(LIVE_SITE);
    await settle(page, 3000);
    await shot(page, vp, '99-site-live');
  });
  await ctx.close();
}

// ---------- signed-in pages ------------------------------------------------------------------

async function projectBySlug(slug) {
  const { items } = await apiGet('/api/v1/projects?limit=100');
  const p = items.find((x) => x.slug === slug);
  if (!p) throw new Error(`no project ${slug}`);
  return p;
}

async function importPage(page, vp, repoUrl) {
  await page.goto(`${APP}/projects/new`);
  await settle(page);
  await page.getByPlaceholder('https://github.com/owner/repo').fill(repoUrl);
  await page.locator('button[type=submit]').first().click();
  await page.getByText('Package manager').first().waitFor({ timeout: 60_000 });
  await settle(page);
  await shot(page, vp, '10-import-analysis', { full: true });
}

async function beforeDeploy(vp, ctx, project) {
  const page = await ctx.newPage();
  await step('10-import-analysis', () => importPage(page, vp, project.repoUrl));
  await step('11-project', async () => {
    await page.goto(`${APP}/projects/${project.id}`);
    await settle(page);
    await shot(page, vp, '11-project', { full: true });
  });
  await step('12-project-build-settings', async () => {
    await page.getByRole('tab', { name: 'Build settings' }).click();
    await settle(page);
    await shot(page, vp, '12-project-build-settings', { full: true });
  });
  await page.close();
}

async function afterDeploy(vp, ctx, project) {
  const page = await ctx.newPage();
  const go = async (id, url, opts) => {
    await step(id, async () => {
      await page.goto(APP + url);
      await settle(page);
      await shot(page, vp, id, opts);
    });
  };
  await go('08-overview', '/overview', { full: true });
  await go('09-projects', '/projects');
  await step('18-rollback-dialog', async () => {
    await page.goto(`${APP}/projects/${project.id}`);
    await settle(page);
    await page.getByRole('button', { name: 'Roll back' }).first().click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(600);
    await shot(page, vp, '18-rollback-dialog');
    // Look only: the dialog is closed without rolling anything back.
    await page.keyboard.press('Escape');
  });
  await go('19-deployments', '/deployments', { full: true });
  await go('20-recovery', '/recovery', { full: true });
  await go('21-analytics', '/analytics', { full: true });
  await step('22-ssr-runtime', async () => {
    const ssr = await projectBySlug(SSR_SLUG);
    await page.goto(`${APP}/deployments/${ssr.activeDeploymentId}`);
    await settle(page, 2000);
    await shot(page, vp, '22-ssr-runtime', { full: true });
  });
  if (vp === 'desktop')
    await step('23-command-palette', async () => {
      await page.goto(`${APP}/overview`);
      await settle(page);
      await page.keyboard.press('Meta+k');
      await page.getByRole('dialog').waitFor();
      await page.keyboard.type('dep');
      await page.waitForTimeout(700);
      await shot(page, vp, '23-command-palette');
    });
  await page.close();
}

// ---------- the deploy, as it happens --------------------------------------------------------

/** Records a page with Chrome's screencast: every frame it paints, with its timestamp. */
async function recorder(ctx, url) {
  const page = await ctx.newPage();
  await page.goto(url);
  await settle(page);
  const dir = path.join(VIDEO, '.frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await ctx.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    const file = `${String(frames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const { width, height } = VIEWPORTS.video.viewport;
  const scale = VIEWPORTS.video.deviceScaleFactor;
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: width * scale,
    maxHeight: height * scale,
  });
  return async (marks) => {
    await cdp.send('Page.stopScreencast').catch(() => {});
    await sleep(300);
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify({ frames, marks }, null, 1));
    console.log(`  ✓ recorded ${frames.length} frames`);
    await page.close();
  };
}

async function deployFlow(ctxs, project) {
  const latest = async () =>
    (await apiGet(`/api/v1/deployments?projectId=${project.id}&limit=1`)).items[0];
  const before = await latest();
  const desk = await ctxs.desktop.newPage();
  await desk.goto(`${APP}/projects/${project.id}`);
  await settle(desk);
  await desk.getByRole('button', { name: 'Deploy latest' }).click();
  let dep;
  for (let i = 0; i < 40 && !dep; i++) {
    const top = await latest();
    if (top && top.id !== before?.id) dep = top;
    else await sleep(500);
  }
  if (!dep) throw new Error('the new deployment never appeared');
  console.log(`  deploying #${dep.number} (${dep.id})`);
  await desk.waitForTimeout(400);
  await shot(desk, 'desktop', '13-deploy-started');

  const url = `${APP}/deployments/${dep.id}`;
  const mob = await ctxs.mobile.newPage();
  const videoCtx = await context('video');
  const [stop] = await Promise.all([
    recorder(videoCtx, url),
    desk.goto(url).then(() => settle(desk, 400)),
    mob.goto(url).then(() => settle(mob, 400)),
  ]);
  const both = (id) => Promise.all([shot(desk, 'desktop', id), shot(mob, 'mobile', id)]);

  const marks = [];
  const started = Date.now();
  let status = '';
  let buildingSince = 0;
  let lastBuildingShot = 0;
  while (Date.now() - started < 12 * 60_000) {
    const cur = await apiGet(`/api/v1/deployments/${dep.id}`);
    if (cur.status !== status) {
      status = cur.status;
      marks.push({ status, t: Date.now() / 1000 });
      console.log(`  → ${status}`);
      if (status === 'QUEUED' || status === 'ANALYZING') {
        await sleep(600);
        await both('14-deploy-queued');
      }
      if (status === 'BUILDING') buildingSince = Date.now();
      if (status === 'VALIDATING') {
        await sleep(700);
        await both('16-deploy-validating');
      }
    }
    // Overwritten while it builds, so what's kept is the last moment before validation: the most log.
    if (
      status === 'BUILDING' &&
      Date.now() - buildingSince > 5000 &&
      Date.now() - lastBuildingShot > 3000
    ) {
      lastBuildingShot = Date.now();
      await both('15-deploy-building');
    }
    if (status === 'ACTIVE') break;
    if (['FAILED', 'CANCELED', 'NEEDS_INPUT', 'AWAITING_APPROVAL'].includes(status)) {
      failed.push(`deploy ended ${status}`);
      await both('17-deploy-ended');
      break;
    }
    await sleep(700);
  }
  await sleep(1500);
  await stop(marks);
  await videoCtx.close();
  if (status === 'ACTIVE') await liveShots({ desktop: desk, mobile: mob }, url);
  await desk.close();
  await mob.close();
}

/**
 * A live deployment's page, freshly loaded (an open page used to stay on "Ready" after the
 * deploy went live), with its validated render, then its timeline.
 */
/** The stored log arrives after the page: wait until its line count isn't 0. */
const logLoaded = (p) => p.getByText(/^[1-9]\d* lines$/).waitFor({ timeout: 20_000 });

async function liveShots(pages, url) {
  for (const [vp, p] of Object.entries(pages)) {
    await step(`${vp}/17-deploy-live`, async () => {
      await p.goto(url);
      await settle(p);
      await p
        .getByAltText('Headless Chromium screenshot of the deployed site')
        .waitFor({ timeout: 20_000 });
      await logLoaded(p);
      await p.waitForTimeout(1500);
      await shot(p, vp, '17-deploy-live');
    });
    await step(`${vp}/17-deploy-timeline`, async () => {
      await p.getByRole('tab', { name: 'Timeline' }).click();
      await settle(p);
      await shot(p, vp, '17-deploy-timeline', { full: true });
    });
  }
  // The hover video's last frame: the same page, live, at the video's size.
  await step('video end frame', async () => {
    const ctx = await context('video');
    const p = await ctx.newPage();
    await p.goto(url);
    await settle(p);
    await p
      .getByAltText('Headless Chromium screenshot of the deployed site')
      .waitFor({ timeout: 20_000 });
    await logLoaded(p);
    await p.waitForTimeout(1500);
    fs.mkdirSync(path.join(VIDEO, '.frames'), { recursive: true });
    await p.screenshot({ path: path.join(VIDEO, '.frames', 'live.jpg'), type: 'jpeg', quality: 95 });
    await ctx.close();
  });
}

// ---------- main -----------------------------------------------------------------------------

try {
  const project = await projectBySlug(DEPLOY_SLUG);
  if (LIVE_ONLY) {
    const ctxs = { desktop: await context('desktop'), mobile: await context('mobile') };
    const pages = { desktop: await ctxs.desktop.newPage(), mobile: await ctxs.mobile.newPage() };
    await liveShots(pages, `${APP}/deployments/${project.activeDeploymentId}`);
    process.exit(failed.length ? 1 : 0);
  }
  console.log('public pages');
  for (const vp of ['desktop', 'mobile']) await publicPages(vp);
  const ctxs = { desktop: await context('desktop'), mobile: await context('mobile') };
  console.log('before the deploy');
  for (const vp of ['desktop', 'mobile']) await beforeDeploy(vp, ctxs[vp], project);
  if (DEPLOY) {
    console.log('the deploy');
    await step('deploy', () => deployFlow(ctxs, project));
  } else console.log('the deploy: skipped (pass --deploy to deploy once and record it)');
  console.log('after the deploy');
  for (const vp of ['desktop', 'mobile']) await afterDeploy(vp, ctxs[vp], project);
} finally {
  await browser.close();
}
if (failed.length) {
  console.log(`\n${failed.length} capture(s) failed:\n  ${failed.join('\n  ')}`);
  process.exitCode = 1;
}
