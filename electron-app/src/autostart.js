/**
 * autostart.js — OS login-item registration + agent auto-start preference.
 *
 * The "Start monitoring on launch" toggle does two jobs:
 *   1. Registers the Tally app as an OS Login Item (macOS / Windows) so the
 *      tray helper relaunches automatically after a reboot.
 *   2. Persists the preference in local config so the renderer knows whether
 *      to auto-start the church-client agent after sign-in.
 *
 * The OS Login Item state is the source of truth on macOS/Windows: a user
 * who removes Tally from System Settings → Login Items should see the toggle
 * reflect that on next launch. On Linux we fall back to config-only since
 * Electron's Login Item support there is best-effort via desktop entries.
 *
 * Dependencies (`app`, `loadConfig`, `saveConfig`, `platform`, `logger`) are
 * injected via init() so unit tests can drive the module with a fake
 * Electron `app` and an in-memory config store.
 */

'use strict';

// ─── Injected dependencies ──────────────────────────────────────────────────

let _app = null;
let _loadConfig = () => ({});
let _saveConfig = () => {};
let _platform = process.platform;
let _logger = () => {};

function init({ app, loadConfig, saveConfig, platform, logger } = {}) {
  if (app) _app = app;
  if (typeof loadConfig === 'function') _loadConfig = loadConfig;
  if (typeof saveConfig === 'function') _saveConfig = saveConfig;
  if (platform) _platform = platform;
  if (typeof logger === 'function') _logger = logger;
}

// ─── Platform support gate ──────────────────────────────────────────────────

/**
 * Returns true on platforms where Electron's Login Item API is reliable.
 * Linux Login Item support depends on the distro's desktop-entry handling
 * and is treated as config-only here.
 */
function supportsOsLoginItem() {
  return _platform === 'darwin' || _platform === 'win32';
}

// ─── OS Login Item read/write (defensive wrappers) ──────────────────────────

function readOsLoginItem() {
  if (!supportsOsLoginItem() || !_app || typeof _app.getLoginItemSettings !== 'function') {
    return null;
  }
  try {
    const s = _app.getLoginItemSettings();
    return !!(s && s.openAtLogin);
  } catch (e) {
    _logger(`autostart: getLoginItemSettings threw: ${e.message}`);
    return null;
  }
}

function writeOsLoginItem(enabled) {
  if (!supportsOsLoginItem() || !_app || typeof _app.setLoginItemSettings !== 'function') {
    return false;
  }
  try {
    _app.setLoginItemSettings({ openAtLogin: !!enabled });
    return true;
  } catch (e) {
    _logger(`autostart: setLoginItemSettings threw: ${e.message}`);
    return false;
  }
}

// ─── Public API (called by IPC handlers in main.js) ─────────────────────────

/**
 * Read the current auto-start state. Source of truth on macOS/Windows is
 * the OS Login Item; Linux falls back to config (default ON).
 */
function getAutoStart() {
  const osState = readOsLoginItem();
  if (osState !== null) return { enabled: osState };

  const config = _loadConfig() || {};
  const enabled = config.autoStartMonitoring !== undefined
    ? !!config.autoStartMonitoring
    : true;
  return { enabled };
}

/**
 * Toggle auto-start. Always writes config so proceedAfterRoomSelection() in
 * the renderer can read it; ALSO writes the OS Login Item on macOS/Windows.
 */
function setAutoStart(enabled) {
  const flag = !!enabled;
  _saveConfig({ autoStartMonitoring: flag ? 1 : 0 });
  const osWritten = writeOsLoginItem(flag);
  return { ok: true, osLoginItem: osWritten };
}

/**
 * Run once at app startup. On the very first launch (no config marker) we
 * default the toggle to ON and register the Login Item so the user gets the
 * "tray helper relaunches at login" behaviour out of the box.
 *
 * On subsequent launches, the OS Login Item is the source of truth — if the
 * user changed it via System Settings, this reconciles config to match.
 */
function applyDefaultOnFirstLaunch() {
  const config = _loadConfig() || {};
  const isFirstLaunch = config.autoStartMonitoring === undefined;

  if (isFirstLaunch) {
    writeOsLoginItem(true);
    _saveConfig({ autoStartMonitoring: 1 });
    _logger('autostart: first-launch default applied (openAtLogin=true)');
    return { firstLaunch: true, enabled: true };
  }

  // Reconcile: if OS state diverged from config (user toggled via System
  // Settings between sessions), trust the OS and update config.
  const osState = readOsLoginItem();
  if (osState !== null) {
    const configEnabled = !!config.autoStartMonitoring;
    if (osState !== configEnabled) {
      _saveConfig({ autoStartMonitoring: osState ? 1 : 0 });
      _logger(`autostart: reconciled config to OS state (openAtLogin=${osState})`);
    }
    return { firstLaunch: false, enabled: osState };
  }

  return { firstLaunch: false, enabled: !!config.autoStartMonitoring };
}

module.exports = {
  init,
  getAutoStart,
  setAutoStart,
  applyDefaultOnFirstLaunch,
  supportsOsLoginItem,
  // exposed for tests + diagnostics
  _readOsLoginItem: readOsLoginItem,
  _writeOsLoginItem: writeOsLoginItem,
};
