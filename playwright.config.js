// @ts-check
const path = require('path');

// Load env files in priority order: .env.provisioned > .env. The provisioned
// file is auto-written by global-setup.js after creating a fresh test church
// so its credentials always win for the current run.
require('dotenv').config({ path: path.join(__dirname, 'portal-e2e/.env'), quiet: true });
require('dotenv').config({ path: path.join(__dirname, 'portal-e2e/.env.provisioned'), override: true, quiet: true });

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
  globalSetup: require.resolve('./portal-e2e/global-setup.js'),
  globalTeardown: require.resolve('./portal-e2e/global-teardown.js'),
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
