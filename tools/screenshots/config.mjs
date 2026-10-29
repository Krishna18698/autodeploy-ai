import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '../..');
/** Everything this harness produces (gitignored). */
export const OUT = path.join(REPO, 'project');
export const RAW = path.join(OUT, 'screens', 'raw');
export const FULL = path.join(OUT, 'screens', 'full');
export const VIDEO = path.join(OUT, 'hover-video');

/** The real product, in production. */
export const APP = 'https://app.autodeploy.fyi';
export const API = 'https://api.autodeploy.fyi';
/**
 * The project the capture deploys once: the owner's portfolio (Next.js, server-rendered). It
 * builds on AutoDeploy's own sandbox, so its log streams line by line, and its validated render
 * is a real site. (autodeploy-actions-test builds on GitHub Actions: its log lands in one batch.)
 */
export const DEPLOY_SLUG = 'portfolio-ai';
/** A live site AutoDeploy serves, shown at the end of the flow. */
export const LIVE_SITE = 'https://portfolio-ai.autodeploy.dpdns.org/';
/** The project whose server-rendered runtime panel is shown. */
export const SSR_SLUG = 'portfolio-ai';

export const TZ = 'Asia/Kolkata';
export const LOCALE = 'en-IN';

export const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  // The phone frame shows 390×700 between the status bar and Safari's bottom bar.
  mobile: {
    viewport: { width: 390, height: 700 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  // The hover video: 1024×576 is a 1280-wide window at 125%, recorded at 2x.
  video: { viewport: { width: 1024, height: 576 }, deviceScaleFactor: 2 },
};

/** The API token the production smoke suite uses (git-ignored). */
export function token() {
  const file = path.join(REPO, 'infra/deploy/.e2e-token');
  if (!fs.existsSync(file)) throw new Error(`No API token: save one to ${file}`);
  return fs.readFileSync(file, 'utf8').trim();
}
