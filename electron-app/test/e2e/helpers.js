/**
 * Shared test helpers for Tally Electron E2E tests.
 *
 * Provides utilities to launch and tear down the Electron app,
 * and optional config injection to bypass sign-in for dashboard tests.
 */
const path = require('path');
const { _electron: electron } = require('playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_ENTRY = path.join(PROJECT_ROOT, 'src', 'main.js');

/**
 * Launch the Tally Electron app and return { electronApp, page }.
 *
 * @param {object} [opts]
 * @param {string} [opts.colorScheme] - 'dark' or 'light'
 * @param {number} [opts.timeout]     - ms to wait for first window (default 15000)
 * @returns {Promise<{ electronApp: import('playwright').ElectronApplication, page: import('playwright').Page }>}
 */
async function launchApp(opts = {}) {
  const electronApp = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: PROJECT_ROOT,
    // Prevent the auto-updater from firing during tests
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });

  // Wait for the first BrowserWindow to appear
  const page = await electronApp.firstWindow();

  // Give the renderer a moment to execute its init() function
  await page.waitForLoadState('domcontentloaded');

  return { electronApp, page };
}

/**
 * Force-close the Electron app.
 *
 * The app intercepts the 'close' event on the main window (e.preventDefault()
 * + hide), so a normal close() would time out. We use app.exit() from the
 * main process to guarantee a clean shutdown.
 */
async function closeApp(electronApp) {
  if (!electronApp) return;
  try {
    await electronApp.evaluate(async ({ app }) => {
      app.exit(0);
    });
  } catch {
    // App may already be closed — swallow
  }
}

/**
 * List of all API method names exposed by preload.js.
 * Used to verify the electronAPI surface.
 */
const EXPECTED_API_METHODS = [
  'getPlatform',
  'getConfig',
  'saveConfig',
  'getStatus',
  'startAgent',
  'stopAgent',
  'isRunning',
  'testConnection',
  'churchAuthLogin',
  'exportTestLogs',
  'testEquipmentConnection',
  'scanNetwork',
  'getNetworkInterfaces',
  'saveEquipment',
  'getEquipment',
  'switchRoom',
  'validateToken',
  'signOut',
  'factoryReset',
  'copyToClipboard',
  'openExternal',
  'onStatus',
  'onAuthInvalid',
  'onSignedOut',
  'onLog',
  'onUpdateReady',
  'onScanProgress',
  'sendChat',
  'getChat',
  'onChatMessage',
  'pickFile',
  'uploadChatFile',
  'saveEngineerProfile',
  'oauthYouTubeConnect',
  'oauthFacebookConnect',
  'oauthFacebookSelectPage',
  'oauthFacebookListPages',
  'oauthYouTubeDisconnect',
  'oauthFacebookDisconnect',
  'oauthStatus',
  'oauthStreamKeys',
  'onOauthUpdate',
  'getPreServiceStatus',
  'getSessionLatest',
  'getAutoStart',
  'setAutoStart',
  'getPreServiceCheck',
  'runPreServiceCheck',
  'fixAllPreService',
  'getActiveRundown',
  'executeRundownStep',
  'advanceRundownStep',
  'jumpToRundownStep',
  'deactivateRundown',
  'pfAnalyze',
  'pfGoNoGo',
  'pfRunHistory',
  'pfFeedback',
  'pfGetConfig',
  'pfAvailable',
  'pfSetCamerasVerified',
  'pfGetCamerasVerified',
  'onPfUpdate',
  'getFailoverConfig',
  'saveFailoverConfig',
  'getFailoverState',
  'getFailoverSources',
  'onFailoverStateChange',
  'onWindowVisibility',
  'onboardingChat',
  'onboardingConfirm',
  'onboardingState',
  'sendCommand',
  'sendDiagnosticBundle',
  'exportPortableConfig',
  'importPortableConfig',
  'getLocaleData',
  'setLocale',
  'onUpdateNotAvailable',
  'onUpdateError',
  'onUpdateProgress',
  'onWhatsNew',
  'onConnectionQuality',
  'onConfigUpdated',
];

module.exports = {
  PROJECT_ROOT,
  MAIN_ENTRY,
  launchApp,
  closeApp,
  EXPECTED_API_METHODS,
};
