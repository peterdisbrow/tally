// @ts-check
require('dotenv').config({ path: require('path').join(__dirname, 'portal-e2e/.env'), quiet: true });

const { defineConfig, devices } = require('@playwright/test');

const PORTAL_BASE_URL = process.env.PORTAL_BASE_URL || 'https://api.tallyconnect.app';

module.exports = defineConfig({
  testDir: './portal-e2e/tests',
  outputDir: './portal-e2e/test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'portal-e2e/playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: PORTAL_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: false,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
