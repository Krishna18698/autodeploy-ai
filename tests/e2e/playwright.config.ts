import { defineConfig, devices } from '@playwright/test';

// Runs against the real stack: ./scripts/dev.sh start api worker, infra up.
// The dashboard is built and served in production mode by webServer below.
export default defineConfig({
  testDir: '.',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: {
    command: 'pnpm --filter @autodeploy/web build && pnpm --filter @autodeploy/web start',
    url: 'http://localhost:3000/login',
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
