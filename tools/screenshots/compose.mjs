/**
 * Turns the raw captures into deliverables:
 *   project/screens/framed/{desktop,mobile}/*.png   browser window / phone bezel with status bar
 *   project/contact-sheet.png                       every framed screen on one page, in deploy order
 *   project/covers/cover-{1,2,3}.png|jpg            4:3 portfolio covers (3200×2400 / 1600×1200)
 *   project/featured/autodeploy-featured.png|jpg    portfolio cover: headline, desktop + phone (4:3)
 *   project/featured/autodeploy-card.png|jpg        portfolio card image, built to read at ~300px wide
 *   project/featured/card-preview*.png              each inside a card like the portfolio's own
 *   docs/screenshots/*.jpg                          web-sized copies the README shows (committed)
 *
 * Every composition is an HTML page rendered by Chromium, so layout is plain CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { OUT, RAW, REPO } from './config.mjs';

const FRAMED = path.join(OUT, 'screens', 'framed');
const COVERS = path.join(OUT, 'covers');
const FEATURED = path.join(OUT, 'featured');
const APP_HOST = 'app.autodeploy.fyi';
const SITE_HOST = 'portfolio-ai.autodeploy.dpdns.org';

const img = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
const has = (vp, id) => fs.existsSync(path.join(RAW, vp, `${id}.png`));
const raw = (vp, id) => img(path.join(RAW, vp, `${id}.png`));
const host = (id) => (id.includes('site-live') ? SITE_HOST : APP_HOST);
/** The first capture that exists, so a run without the deploy still composes. */
const pick = (vp, ...ids) => ids.find((id) => has(vp, id)) ?? ids.at(-1);

// The dashboard's own tokens (apps/web/app/globals.css).
const C = {
  bg: '#08090a',
  panel: '#0f1012',
  line: '#222327',
  fg: '#f2f3f5',
  muted: '#8b8f98',
  run: '#7aa2ff',
  ok: '#4cc38a',
  ai: '#c084fc',
};
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=block" rel="stylesheet">`;
const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0} body{font-family:Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:${C.fg}}
  .mono{font-family:'Geist Mono',ui-monospace,monospace}
  .grad{background:linear-gradient(90deg,${C.ok},${C.run});-webkit-background-clip:text;background-clip:text;color:transparent}`;

const LOGO = (size) => `<svg viewBox="4 3 24 26" width="${size}" height="${size}" style="flex:none">
  <polygon points="16,4 27,9.5 16,15 5,9.5" fill="#4cc38a"/>
  <polygon points="5,13.5 16,19 27,13.5 27,16.5 16,22 5,16.5" fill="#698bda"/>
  <polygon points="5,19.5 16,25 27,19.5 27,22.5 16,28 5,22.5" fill="#3b4e78"/></svg>`;

// ---------- frames -------------------------------------------------------------------------

/** A dark macOS-style browser window around a 1440×900 capture. */
function desktopFrame(src, { url = APP_HOST, shadow = true } = {}) {
  return `<div style="width:1440px;border-radius:12px;overflow:hidden;background:${C.bg};
      box-shadow:${shadow ? '0 40px 90px -20px rgba(0,0,0,.7),' : ''}0 0 0 1px rgba(255,255,255,.1)">
    <div style="height:52px;background:#16171a;border-bottom:1px solid #26272b;display:flex;align-items:center;padding:0 18px;gap:18px">
      <div style="display:flex;gap:8px">${['#ff5f57', '#febc2e', '#28c840'].map((c) => `<span style="width:12px;height:12px;border-radius:50%;background:${c}"></span>`).join('')}</div>
      <div style="display:flex;gap:14px;color:#5d6068;font-size:18px">‹ ›</div>
      <div style="flex:1;display:flex;justify-content:center">
        <div style="width:520px;height:32px;border-radius:8px;background:#222327;display:flex;align-items:center;justify-content:center;gap:8px;font-size:13.5px;color:#c4c7ce">
          <svg width="11" height="13" viewBox="0 0 11 13"><rect x="1" y="5.5" width="9" height="7" rx="1.5" fill="#8b8f98"/><path d="M3 5.5V4a2.5 2.5 0 015 0v1.5" stroke="#8b8f98" stroke-width="1.4" fill="none"/></svg>
          ${url}
        </div>
      </div>
      <div style="width:92px"></div>
    </div>
    <img src="${src}" style="display:block;width:1440px;height:900px">
  </div>`;
}

/** iPhone-style bezel: status bar above the page, Safari's bottom bar below, nothing under either. */
function phoneFrame(src, { url = APP_HOST, shadow = true } = {}) {
  const icons = `<svg width="18" height="12" viewBox="0 0 18 12">${[0, 1, 2, 3].map((i) => `<rect x="${i * 4.6}" y="${9 - i * 3}" width="3.2" height="${3 + i * 3}" rx="1" fill="#fff"/>`).join('')}</svg>
    <svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 11.2 10.3 8.9a3.3 3.3 0 00-4.6 0z M8 2a9 9 0 016.3 2.6l1.3-1.3A10.9 10.9 0 008 0 10.9 10.9 0 00.4 3.3l1.3 1.3A9 9 0 018 2zm0 3.5a5.6 5.6 0 013.9 1.6l1.3-1.3a7.4 7.4 0 00-10.4 0l1.3 1.3A5.6 5.6 0 018 5.5z" fill="#fff"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" stroke="#fff" opacity=".4" fill="none"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#fff"/><path d="M25 4.5v4a2 2 0 000-4z" fill="#fff" opacity=".4"/></svg>`;
  return `<div style="width:430px;height:884px;border-radius:68px;background:#1a1b1f;padding:20px;position:relative;
      box-shadow:${shadow ? '0 50px 90px -25px rgba(0,0,0,.75),' : ''}inset 0 0 0 2px #2e2f35,0 0 0 1px #3a3b42">
    <div style="width:390px;height:844px;border-radius:50px;overflow:hidden;background:${C.bg};display:flex;flex-direction:column;position:relative">
      <div style="height:54px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:6px 30px 0 44px;font-weight:600;font-size:16px;letter-spacing:-.2px;color:#fff;background:${C.bg}">
        <span>9:41</span><span style="display:flex;gap:6px;align-items:center">${icons}</span>
      </div>
      <div style="position:absolute;top:11px;left:50%;transform:translateX(-50%);width:124px;height:36px;border-radius:20px;background:#000"></div>
      <img src="${src}" style="display:block;width:390px;height:700px;flex:none">
      <div style="height:90px;flex:none;background:rgba(22,23,26,.97);border-top:.5px solid rgba(255,255,255,.1);display:flex;flex-direction:column;align-items:center;padding-top:10px">
        <div style="width:360px;height:44px;border-radius:13px;background:#2a2b30;display:flex;align-items:center;justify-content:center;font-size:15px;color:#f2f3f5;gap:6px;padding:0 14px">
          <span style="font-size:13px;color:#8b8f98">AA</span><span style="flex:1;text-align:center">${url}</span><span style="font-size:15px;color:#8b8f98">↻</span>
        </div>
        <div style="margin-top:auto;margin-bottom:8px;width:134px;height:5px;border-radius:3px;background:#fff"></div>
      </div>
    </div>
  </div>`;
}

// ---------- rendering ----------------------------------------------------------------------

let browser;
async function render(html, file, { width, height, scale = 2, transparent = false, jpg = null }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  const doc = `<!doctype html><html><head>${FONTS}<style>${BASE_CSS}</style></head><body style="width:${width}px;height:${height}px;${transparent ? 'background:transparent' : ''}">${html}</body></html>`;
  await page.setContent(doc, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
  if (jpg) {
    const p2 = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: jpg.scale });
    await p2.setContent(doc, { waitUntil: 'networkidle' });
    await p2.evaluate(() => document.fonts.ready);
    await p2.screenshot({ path: jpg.file, type: 'jpeg', quality: 90 });
    await p2.close();
  }
}

// Contact sheet order = the order of a deploy; anything unlisted goes last.
const LABELS = {
  '01-landing': 'Landing',
  '02-landing-features': 'Landing · features',
  '03-landing-logs': 'Landing · live logs',
  '04-landing-recovery': 'Landing · self-healing',
  '05-landing-numbers': 'Landing · measured numbers',
  '06-landing-architecture': 'Landing · architecture',
  '07-login': 'Sign in',
  '10-import-analysis': 'Import · repo analysis with evidence',
  '11-project': 'Project · deployments',
  '12-project-build-settings': 'Project · build on GitHub Actions',
  '13-deploy-started': 'Deploy started',
  '14-deploy-queued': 'Deploy · queued',
  '15-deploy-building': 'Deploy · building, logs live',
  '16-deploy-validating': 'Deploy · validating in Chromium',
  '17-deploy-live': 'Deploy · live, with its validated render',
  '17-deploy-ended': 'Deploy · ended',
  '17-deploy-timeline': 'Deploy · event timeline',
  '18-rollback-dialog': 'Rollback · one pointer flip',
  '08-overview': 'Overview',
  '09-projects': 'Projects',
  '19-deployments': 'All deployments',
  '20-recovery': 'Recovery center',
  '21-analytics': 'Analytics',
  '22-ssr-runtime': 'Server-rendered app · runtime',
  '23-command-palette': 'Command palette (⌘K)',
  '99-site-live': 'A site AutoDeploy serves',
};
const rank = (id) => (id in LABELS ? Object.keys(LABELS).indexOf(id) : 999);
const list = (vp) =>
  fs.existsSync(path.join(RAW, vp))
    ? fs
        .readdirSync(path.join(RAW, vp))
        .filter((f) => f.endsWith('.png'))
        .map((f) => f.slice(0, -4))
        .sort((a, b) => rank(a) - rank(b))
    : [];

async function frames() {
  fs.rmSync(FRAMED, { recursive: true, force: true });
  for (const id of list('desktop'))
    await render(
      `<div style="padding:40px 60px 90px">${desktopFrame(raw('desktop', id), { url: host(id) })}</div>`,
      path.join(FRAMED, 'desktop', `${id}.png`),
      { width: 1560, height: 1082, transparent: true },
    );
  for (const id of list('mobile'))
    await render(
      `<div style="padding:30px 40px 70px">${phoneFrame(raw('mobile', id), { url: host(id) })}</div>`,
      path.join(FRAMED, 'mobile', `${id}.png`),
      { width: 510, height: 984, transparent: true },
    );
}

async function contactSheet() {
  const tile = (vp, id) =>
    `<figure style="display:flex;flex-direction:column;align-items:center;gap:10px"><img src="${img(path.join(FRAMED, vp, `${id}.png`))}" style="${vp === 'desktop' ? 'width:560px' : 'width:190px'}"><figcaption style="font-size:15px;color:${C.muted};font-weight:500;text-align:center">${LABELS[id] ?? id}</figcaption></figure>`;
  const d = list('desktop');
  const m = list('mobile');
  const html = `<div style="background:${C.bg};width:1900px;padding:70px 80px">
    <header style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid ${C.line};padding-bottom:22px;margin-bottom:36px">
      <div style="display:flex;align-items:center;gap:16px">${LOGO(46)}<h1 style="font-size:46px;font-weight:600;letter-spacing:-.03em">AutoDeploy <span style="color:${C.muted};font-weight:500">· every screen</span></h1></div>
      <span class="mono" style="font-size:14px;color:${C.muted}">real production data · in the order of a deploy</span>
    </header>
    <h2 style="font-size:26px;font-weight:600;margin:0 0 18px">Desktop</h2>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:28px 20px">${d.map((id) => tile('desktop', id)).join('')}</div>
    <h2 style="font-size:26px;font-weight:600;margin:44px 0 18px">Mobile</h2>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:28px 12px">${m.map((id) => tile('mobile', id)).join('')}</div>
  </div>`;
  const page = await browser.newPage({
    viewport: { width: 1900, height: 1000 },
    deviceScaleFactor: 1.5,
  });
  await page.setContent(
    `<!doctype html><html><head>${FONTS}<style>${BASE_CSS}</style></head><body style="background:${C.bg}">${html}</body></html>`,
    { waitUntil: 'networkidle' },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(OUT, 'contact-sheet.png'), fullPage: true });
  await page.close();
}

// ---------- shared backgrounds ---------------------------------------------------------------

const GRID = `background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:56px 56px`;
const glow = (x, y, r, color) =>
  `<div style="position:absolute;left:0;top:0;width:100%;height:100%;background:radial-gradient(${r}px ${r}px at ${x}px ${y}px,${color},transparent 70%)"></div>`;
const ribbons = (top) => `
  <div style="position:absolute;left:-200px;top:${top}px;width:2400px;height:78px;background:linear-gradient(90deg,${C.ok},${C.run});transform:rotate(-16deg);opacity:.75"></div>
  <div style="position:absolute;left:-200px;top:${top + 126}px;width:2400px;height:24px;background:linear-gradient(90deg,${C.ok},${C.run});transform:rotate(-16deg);opacity:.35"></div>`;
const eyebrow = (t) =>
  `<span style="letter-spacing:.3em;text-transform:uppercase;font-size:21px;font-weight:600;color:rgba(242,243,245,.6)">${t}</span>`;
const chip = (t, color = C.ok) =>
  `<span class="mono" style="display:inline-flex;align-items:center;gap:10px;border:1.5px solid ${color}80;background:${color}1f;color:${color};border-radius:999px;padding:8px 18px;font-size:19px;font-weight:500;letter-spacing:.04em">
    <span style="width:10px;height:10px;border-radius:50%;background:${color};box-shadow:0 0 0 4px ${color}40"></span>${t}</span>`;
const dark = (inner) =>
  `<div style="width:1600px;height:1200px;background:${C.bg};position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;${GRID};-webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 0%,#000,transparent)"></div>${inner}</div>`;

// ---------- covers (4:3) -------------------------------------------------------------------

function cover1() {
  // The product: a deploy in a desktop window, the phone over its corner.
  const live = pick('desktop', '17-deploy-live', '11-project');
  return dark(`${glow(1150, 300, 900, 'rgba(122,162,255,.22)')}
    <div style="position:absolute;left:100px;top:92px">
      <div style="display:flex;align-items:center;gap:16px">${LOGO(40)}${eyebrow('AutoDeploy · self-healing deploys')}</div>
      <div style="margin-top:26px;font-size:84px;font-weight:600;line-height:1;letter-spacing:-.04em">Deploys that fix <span class="grad">themselves.</span></div>
      <p style="margin-top:24px;font-size:26px;color:${C.muted};max-width:900px;line-height:1.45">Import a GitHub repo. It builds in a sandbox, streams its logs live, repairs failed builds and goes live at the edge — with one-click rollback.</p>
    </div>
    <div style="position:absolute;left:100px;top:470px;transform:scale(.82);transform-origin:top left">${desktopFrame(raw('desktop', live))}</div>
    <div style="position:absolute;right:80px;top:500px;transform:scale(.78);transform-origin:top right">${phoneFrame(raw('mobile', pick('mobile', '15-deploy-building', '08-overview')))}</div>`);
}

function cover2() {
  // The flow: four stages of one real deploy, numbered.
  const steps = [
    ['Analyze', 'Reads the repo; shows its evidence', '10-import-analysis'],
    ['Build', 'Logs stream live as it builds', pick('desktop', '15-deploy-building', '11-project')],
    [
      'Validate & go live',
      'Checked in headless Chromium',
      pick('desktop', '17-deploy-live', '22-ssr-runtime'),
    ],
    ['Roll back', 'A pointer flip — nothing rebuilt', '18-rollback-dialog'],
  ];
  return dark(`${glow(800, 0, 1000, 'rgba(76,195,138,.14)')}
    <div style="position:absolute;left:100px;top:84px;right:100px;display:flex;justify-content:space-between;align-items:flex-end">
      <div style="font-size:66px;font-weight:600;letter-spacing:-.035em;line-height:1">One deploy, <span class="grad">start to finish.</span></div>
      <div style="display:flex;align-items:center;gap:14px">${LOGO(36)}<span style="font-size:26px;font-weight:600">AutoDeploy</span></div>
    </div>
    <div style="position:absolute;left:100px;top:230px;display:grid;grid-template-columns:repeat(2,680px);gap:46px 40px">
      ${steps
        .map(
          ([t, sub, id], i) => `<div>
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:16px">
          <span class="mono" style="font-size:22px;color:${C.ok}">0${i + 1}</span>
          <span style="font-size:30px;font-weight:600;letter-spacing:-.02em">${t}</span>
          <span style="font-size:20px;color:${C.muted}">${sub}</span>
        </div>
        <div style="width:680px;height:425px;border-radius:14px;overflow:hidden;box-shadow:0 30px 60px -20px rgba(0,0,0,.8),0 0 0 1px rgba(255,255,255,.1)">
          <img src="${raw('desktop', id)}" style="width:680px;height:425px;display:block">
        </div></div>`,
        )
        .join('')}
    </div>`);
}

function cover3() {
  // Phones: the same deploy on a phone, on the brand gradient.
  const phones = [
    pick('mobile', '15-deploy-building', '11-project'),
    pick('mobile', '17-deploy-live', '08-overview'),
    '08-overview',
  ];
  return `<div style="width:1600px;height:1200px;background:linear-gradient(135deg,#0f3d2b,#1b2c5c 60%,#0d1630);position:relative;overflow:hidden">
    <div style="position:absolute;inset:0;background:repeating-linear-gradient(-60deg,rgba(255,255,255,.03) 0 60px,transparent 60px 140px)"></div>
    <div style="position:absolute;left:0;right:0;top:78px;text-align:center">
      ${eyebrow('Every deploy, in your pocket')}
      <div style="margin-top:20px;font-size:68px;font-weight:600;letter-spacing:-.035em;line-height:1">Watch it build. <span class="grad">Watch it go live.</span></div>
    </div>
    <div style="position:absolute;left:0;right:0;top:300px;display:flex;justify-content:center;gap:70px">
      ${phones.map((id, i) => `<div style="transform:translateY(${i === 1 ? -30 : 20}px)">${phoneFrame(raw('mobile', id))}</div>`).join('')}
    </div>
  </div>`;
}

// ---------- featured -------------------------------------------------------------------------

/**
 * The portfolio cover, like Pit Wall's: name and a live chip, the headline, the desktop deploy
 * tilted behind the phone. The portfolio shows the top 16:9 of it, so everything that matters
 * sits in the top 900px.
 */
function featured() {
  const desk = pick('desktop', '15-deploy-building', '11-project');
  const phone = pick('mobile', '17-deploy-live', '08-overview');
  return dark(`${glow(1180, 620, 640, 'rgba(122,162,255,.42)')}${glow(400, 1000, 700, 'rgba(76,195,138,.18)')}
    ${ribbons(1030)}
    <div style="position:absolute;left:84px;top:66px;display:flex;align-items:center;gap:22px">
      ${LOGO(34)}${eyebrow('AutoDeploy · self-healing deploy platform')}${chip('LIVE · BUILT, CHECKED, SERVED')}
    </div>
    <div style="position:absolute;left:80px;top:124px;font-size:104px;font-weight:600;line-height:1;letter-spacing:-.045em">Deploys that fix <span class="grad">themselves.</span></div>
    <div style="position:absolute;left:30px;top:300px;perspective:2600px">
      <div style="transform:rotateY(22deg) rotateX(5deg) scale(.8);transform-origin:left center;filter:brightness(.8)">${desktopFrame(raw('desktop', desk))}</div>
    </div>
    <div style="position:absolute;left:0;top:300px;width:1000px;height:900px;background:linear-gradient(90deg,transparent 55%,rgba(8,9,10,.55))"></div>
    <div style="position:absolute;left:880px;top:268px;transform:scale(1.1);transform-origin:top left;filter:drop-shadow(0 50px 70px rgba(0,0,0,.7))">${phoneFrame(raw('mobile', phone))}</div>`);
}

/** Built for ~300px wide: two big product shots, one short line. */
function card() {
  const desk = pick('desktop', '15-deploy-building', '11-project');
  const phone = pick('mobile', '17-deploy-live', '08-overview');
  return dark(`${glow(700, 700, 900, 'rgba(122,162,255,.3)')}${ribbons(880)}
    <div style="position:absolute;left:96px;top:92px;font-size:118px;font-weight:600;line-height:1;letter-spacing:-.045em">Push. <span class="grad">It ships.</span></div>
    <div style="position:absolute;left:96px;top:280px;width:1040px;height:650px;border-radius:24px;overflow:hidden;box-shadow:0 40px 80px -20px rgba(0,0,0,.85),0 0 0 2px rgba(255,255,255,.1)">
      <img src="${raw('desktop', desk)}" style="width:1440px;height:900px;display:block;transform:scale(.7222);transform-origin:top left">
    </div>
    <div style="position:absolute;left:1080px;top:250px;transform:scale(1.06);transform-origin:top left;filter:drop-shadow(0 40px 60px rgba(0,0,0,.7))">${phoneFrame(raw('mobile', phone))}</div>`);
}

/** The image inside a card like the portfolio's own project cards. */
function cardPreview(image) {
  const metrics = ['0 duplicate job claims', '82% auto-recovered'];
  const tech = [
    'TypeScript',
    'Fastify',
    'Postgres',
    'Kafka',
    'Valkey',
    'Next.js',
    'Cloudflare Workers',
    'gVisor',
    'Docker',
  ];
  const icon = (d) =>
    `<span style="width:44px;height:44px;border-radius:10px;border:1px solid #2c2c30;background:#151517;display:grid;place-items:center"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#e8e8ea" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
  return `<div style="width:520px;height:640px;background:#0b0b0c;padding:16px">
    <article style="width:488px;background:#141416;border:1px solid #2a2a2e;border-radius:18px;padding:20px">
      <img src="${img(path.join(FEATURED, image))}" style="display:block;width:446px;height:251px;border-radius:12px;object-fit:cover;object-position:top;border:1px solid #232326">
      <div style="margin-top:18px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
        <h3 style="font-size:19px;font-weight:600;line-height:1.3;color:#f2f2f3">AutoDeploy — Self-Healing Deploy Platform</h3>
        <span class="mono" style="flex:none;font-size:11px;letter-spacing:.06em;color:#c4b5fd;border:1px solid #6d5bd0;background:#2a2346;border-radius:999px;padding:4px 10px">PERSONAL</span>
      </div>
      <p style="margin-top:6px;font-size:14px;color:#a78bfa">Deploys that fix themselves</p>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${metrics.map((m) => `<span class="mono" style="font-size:12.5px;font-weight:500;color:#c4b5fd;background:#2a2346;border:1px solid #3d3368;border-radius:999px;padding:5px 11px">${m}</span>`).join('')}</div>
      <p style="margin-top:12px;font-size:14px;line-height:1.55;color:#c9c9cf">A GitHub repo goes live from a sandboxed build, with logs streamed live, failed builds repaired by rules or AI, and instant rollback.</p>
      <div style="margin-top:12px;display:flex;gap:7px;flex-wrap:wrap">${tech.map((t) => `<span style="font-size:12px;color:#a1a1aa;background:#1e1e21;border:1px solid #2a2a2e;border-radius:6px;padding:3px 8px">${t}</span>`).join('')}</div>
      <div style="margin-top:16px;display:flex;gap:10px">
        ${icon('<path d="M2 4h6a4 4 0 014 4v12a3 3 0 00-3-3H2zM22 4h-6a4 4 0 00-4 4v12a3 3 0 013-3h7z"/>')}
        ${icon('<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 00-.9-2.6c3.1-.4 6.4-1.5 6.4-6.9a5.4 5.4 0 00-1.5-3.7 5 5 0 00-.1-3.8s-1.2-.4-3.9 1.5a13.4 13.4 0 00-7 0C6.3 1.6 5.1 2 5.1 2a5 5 0 00-.1 3.8A5.4 5.4 0 003.5 9.5c0 5.4 3.3 6.5 6.4 6.9a3.4 3.4 0 00-.9 2.6V22"/>')}
        ${icon('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>')}
      </div>
    </article>
  </div>`;
}

// ---------- README images ------------------------------------------------------------------

/**
 * Web-sized copies for the README, in the repo because project/ is gitignored and GitHub only
 * shows committed files. Rebuilt from scratch, so the README never shows a screen that's gone.
 */
const README_SHOTS = {
  desktop: [
    '10-import-analysis',
    '15-deploy-building',
    '17-deploy-live',
    '18-rollback-dialog',
    '08-overview',
  ],
  mobile: ['15-deploy-building', '17-deploy-live'],
};
async function readmeAssets() {
  const docs = path.join(REPO, 'docs', 'screenshots');
  fs.rmSync(docs, { recursive: true, force: true });
  fs.mkdirSync(docs, { recursive: true });
  const jpg = async (src, out, width, height, scale, quality) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    await page.setContent(
      `<body style="margin:0"><img src="${img(src)}" style="display:block;width:${width}px;height:${height}px"></body>`,
      { waitUntil: 'load' },
    );
    await page.screenshot({ path: out, type: 'jpeg', quality });
    await page.close();
  };
  for (const id of README_SHOTS.desktop.filter((i) => has('desktop', i)))
    await jpg(
      path.join(RAW, 'desktop', `${id}.png`),
      path.join(docs, `${id}.jpg`),
      1440,
      900,
      1,
      82,
    );
  for (const id of README_SHOTS.mobile.filter((i) => has('mobile', i)))
    await jpg(
      path.join(RAW, 'mobile', `${id}.png`),
      path.join(docs, `${id}-phone.jpg`),
      390,
      700,
      2,
      75,
    );
  fs.copyFileSync(path.join(FEATURED, 'autodeploy-featured.jpg'), path.join(docs, 'featured.jpg'));
}

// ---------- main ---------------------------------------------------------------------------

browser = await chromium.launch();
try {
  await frames();
  console.log('✓ frames');
  await contactSheet();
  console.log('✓ contact sheet');
  for (const [i, c] of [cover1, cover2, cover3].entries()) {
    const n = i + 1;
    await render(c(), path.join(COVERS, `cover-${n}.png`), {
      width: 1600,
      height: 1200,
      jpg: { file: path.join(COVERS, `cover-${n}.jpg`), scale: 1 },
    });
  }
  console.log('✓ covers');
  await render(featured(), path.join(FEATURED, 'autodeploy-featured.png'), {
    width: 1600,
    height: 1200,
    jpg: { file: path.join(FEATURED, 'autodeploy-featured.jpg'), scale: 1 },
  });
  await render(card(), path.join(FEATURED, 'autodeploy-card.png'), {
    width: 1600,
    height: 1200,
    jpg: { file: path.join(FEATURED, 'autodeploy-card.jpg'), scale: 1 },
  });
  await render(
    cardPreview('autodeploy-featured.png'),
    path.join(FEATURED, 'card-preview-featured.png'),
    { width: 520, height: 640 },
  );
  await render(cardPreview('autodeploy-card.png'), path.join(FEATURED, 'card-preview-card.png'), {
    width: 520,
    height: 640,
  });
  console.log('✓ featured');
  await readmeAssets();
  console.log('✓ README images (docs/screenshots)');
} finally {
  await browser.close();
}
