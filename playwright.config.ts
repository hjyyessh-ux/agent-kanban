import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const e2eHome = resolve(process.cwd(), '.e2e-home');
const e2eData = resolve(process.cwd(), '.e2e-data');

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  testIgnore: ['**/photo-compare.e2e.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 20_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:24681',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'bun scripts/test-server.ts',
    port: 24681,
    reuseExistingServer: true,
    env: { E2E_PORT: '24681', HOME: e2eHome, E2E_HOME: e2eHome, KANBAN_DATA_DIR: e2eData },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  outputDir: 'e2e/results',
});
