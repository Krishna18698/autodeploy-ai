import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The smoke suite runs the real product end to end against a running stack:
//
//   local (default):  E2E_BASE_URL=http://localhost:3100, dev sign-in, file:// fixtures,
//                     sites reached through the local edge (E2E_EDGE_URL, default :8787)
//   production:       E2E_BASE_URL=https://app.autodeploy.dpdns.org pnpm test:smoke
//                     signs in with an API token read from infra/deploy/.e2e-token
//                     (git-ignored; create one in Settings → API tokens) and imports
//                     the fixtures from this repository on GitHub.
//
// Everything it creates is named e2e-* and deleted at the end.

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
export const REMOTE = !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(`${BASE_URL}/`);

const tokenFile = resolve(import.meta.dirname, '../../infra/deploy/.e2e-token');
const token = REMOTE && existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
if (REMOTE && !token) throw new Error(`No API token: save one to ${tokenFile}`);

export default defineConfig({
  testDir: '.',
  testMatch: 'smoke.spec.ts',
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Sent with every dashboard request (pages, /api, live logs). Sites under
    // test are fetched through a separate client that never carries it.
    ...(token && { extraHTTPHeaders: { authorization: `Bearer ${token}` } }),
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});
