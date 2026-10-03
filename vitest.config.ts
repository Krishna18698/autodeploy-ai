import { defineConfig } from 'vitest/config';

// Two suites: fast unit tests (pure code) and integration tests against real
// Postgres / Valkey / Kafka containers (Testcontainers).
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 240_000,
          fileParallelism: false,
          globalSetup: ['tests/integration/global-setup.ts'],
        },
      },
    ],
  },
});
