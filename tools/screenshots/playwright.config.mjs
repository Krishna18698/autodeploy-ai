import { defineConfig } from '@playwright/test';
import { APP, LOCALE, TZ } from './config.mjs';

// The flows drive the real dashboard in production, read-only, one at a time.
export default defineConfig({
  testDir: 'tests',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL: APP,
    timezoneId: TZ,
    locale: LOCALE,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 700 }, isMobile: true, hasTouch: true },
    },
  ],
});
