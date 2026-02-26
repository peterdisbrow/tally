// @ts-check

/** @type {import('playwright').PlaywrightTestConfig} */
module.exports = {
  testDir: './test/e2e',
  timeout: 30000,
  retries: 0,
  // Run tests serially — only one Electron instance at a time
  workers: 1,
  reporter: 'list',
  use: {
    // Trace on first retry only (useful for debugging)
    trace: 'on-first-retry',
  },
};
