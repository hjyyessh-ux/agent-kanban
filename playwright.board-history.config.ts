import { defineConfig, devices } from '@playwright/test';

/**
 * Card/Works History status panel only. No webServer: the spec spawns its own
 * isolated daemon (throwaway HOME/data, free loopback port, synthetic token).
 * Build the SPA first: `bun run build:web`.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/board-history-status.bh.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  outputDir: 'e2e/results/board-history',
});
