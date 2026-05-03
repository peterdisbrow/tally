/**
 * autostart.test.js — OS login-item registration + agent auto-start preference.
 *
 * Drives src/autostart.js with a fake Electron `app` and an in-memory config
 * store so the full read/write/reconcile cycle can be tested without booting
 * Electron. Both supported platforms (macOS, Windows) are exercised; Linux is
 * also covered to confirm the config-only fallback path.
 *
 * The IPC bridge in main.js is a thin delegate to this module — testing the
 * module behaviourally is more durable than asserting on regex matches over
 * main.js source.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const autostart = require('../src/autostart');

// ─── Test harness ───────────────────────────────────────────────────────────

/**
 * Build a fresh test bed: in-memory config + spy/fake Electron `app` whose
 * Login Item state is mutable. Records every getLoginItemSettings /
 * setLoginItemSettings call so tests can assert on them.
 */
function makeBed({ platform = 'darwin', initialConfig = {}, initialOsLoginItem = false } = {}) {
  const calls = { getLoginItemSettings: 0, setLoginItemSettings: [] };
  const store = { config: { ...initialConfig }, osOpenAtLogin: !!initialOsLoginItem, logs: [] };

  const fakeApp = {
    getLoginItemSettings: () => {
      calls.getLoginItemSettings++;
      return { openAtLogin: store.osOpenAtLogin };
    },
    setLoginItemSettings: (opts) => {
      calls.setLoginItemSettings.push({ ...opts });
      store.osOpenAtLogin = !!opts.openAtLogin;
    },
  };

  autostart.init({
    app: fakeApp,
    loadConfig: () => ({ ...store.config }),
    saveConfig: (patch) => { Object.assign(store.config, patch); },
    platform,
    logger: (msg) => store.logs.push(msg),
  });

  return { calls, store, fakeApp };
}

// ─── supportsOsLoginItem() ──────────────────────────────────────────────────

test('supportsOsLoginItem: true for darwin and win32, false elsewhere', () => {
  makeBed({ platform: 'darwin' });
  assert.equal(autostart.supportsOsLoginItem(), true);

  makeBed({ platform: 'win32' });
  assert.equal(autostart.supportsOsLoginItem(), true);

  makeBed({ platform: 'linux' });
  assert.equal(autostart.supportsOsLoginItem(), false);
});

// ─── setAutoStart() — writes BOTH config AND the OS Login Item ──────────────

test('setAutoStart(true) on macOS writes config + setLoginItemSettings({openAtLogin: true})', () => {
  const { calls, store } = makeBed({ platform: 'darwin' });
  const r = autostart.setAutoStart(true);
  assert.equal(r.ok, true);
  assert.equal(r.osLoginItem, true);
  assert.equal(store.config.autoStartMonitoring, 1);
  assert.deepEqual(calls.setLoginItemSettings, [{ openAtLogin: true }]);
  assert.equal(store.osOpenAtLogin, true, 'OS state should reflect the toggle');
});

test('setAutoStart(false) on macOS writes config + setLoginItemSettings({openAtLogin: false})', () => {
  const { calls, store } = makeBed({ platform: 'darwin', initialOsLoginItem: true });
  autostart.setAutoStart(false);
  assert.equal(store.config.autoStartMonitoring, 0);
  assert.deepEqual(calls.setLoginItemSettings, [{ openAtLogin: false }]);
  assert.equal(store.osOpenAtLogin, false);
});

test('setAutoStart(true) on Windows writes both config and OS Login Item', () => {
  const { calls, store } = makeBed({ platform: 'win32' });
  autostart.setAutoStart(true);
  assert.equal(store.config.autoStartMonitoring, 1);
  assert.deepEqual(calls.setLoginItemSettings, [{ openAtLogin: true }]);
});

test('setAutoStart on Linux writes config but skips OS Login Item', () => {
  // Electron's Login Item support on Linux is best-effort via desktop entries;
  // gate to avoid surprising behavior. Config still persists so the renderer's
  // "auto-start agent after sign-in" path keeps working.
  const { calls, store } = makeBed({ platform: 'linux' });
  const r = autostart.setAutoStart(true);
  assert.equal(store.config.autoStartMonitoring, 1);
  assert.equal(calls.setLoginItemSettings.length, 0, 'must NOT touch OS Login Item on Linux');
  assert.equal(r.osLoginItem, false);
});

test('setAutoStart coerces truthy/falsy inputs to a strict boolean', () => {
  const { calls, store } = makeBed({ platform: 'darwin' });
  autostart.setAutoStart('yes');
  assert.equal(store.config.autoStartMonitoring, 1);
  assert.deepEqual(calls.setLoginItemSettings.at(-1), { openAtLogin: true });

  autostart.setAutoStart(0);
  assert.equal(store.config.autoStartMonitoring, 0);
  assert.deepEqual(calls.setLoginItemSettings.at(-1), { openAtLogin: false });
});

// ─── getAutoStart() — OS state is the source of truth on supported platforms

test('getAutoStart on macOS reads from app.getLoginItemSettings, not config', () => {
  // Even if config is stale (says 0), the OS state wins. This lets users
  // change the toggle via System Settings and have the UI reflect it.
  const { calls } = makeBed({
    platform: 'darwin',
    initialConfig: { autoStartMonitoring: 0 },
    initialOsLoginItem: true,
  });
  const r = autostart.getAutoStart();
  assert.equal(r.enabled, true, 'OS state (true) must override stale config (0)');
  assert.equal(calls.getLoginItemSettings, 1);
});

test('getAutoStart on Windows reads from app.getLoginItemSettings', () => {
  const { calls } = makeBed({ platform: 'win32', initialOsLoginItem: false });
  const r = autostart.getAutoStart();
  assert.equal(r.enabled, false);
  assert.equal(calls.getLoginItemSettings, 1);
});

test('getAutoStart on Linux falls back to config (default true when unset)', () => {
  const { calls } = makeBed({ platform: 'linux' });
  const r = autostart.getAutoStart();
  assert.equal(r.enabled, true, 'Linux default should be enabled');
  assert.equal(calls.getLoginItemSettings, 0, 'must not call Electron Login Item APIs on Linux');
});

test('getAutoStart on Linux honors saved config value', () => {
  const { calls } = makeBed({ platform: 'linux', initialConfig: { autoStartMonitoring: 0 } });
  const r = autostart.getAutoStart();
  assert.equal(r.enabled, false);
  assert.equal(calls.getLoginItemSettings, 0);
});

// ─── applyDefaultOnFirstLaunch() ────────────────────────────────────────────

test('applyDefaultOnFirstLaunch: registers Login Item + persists config when no marker exists', () => {
  // Simulates a brand-new install: empty config, OS Login Item not yet set.
  const { calls, store } = makeBed({ platform: 'darwin', initialConfig: {} });
  const r = autostart.applyDefaultOnFirstLaunch();
  assert.equal(r.firstLaunch, true);
  assert.equal(r.enabled, true);
  assert.equal(store.config.autoStartMonitoring, 1, 'config should mark first-launch handled');
  assert.deepEqual(calls.setLoginItemSettings, [{ openAtLogin: true }]);
  assert.equal(store.osOpenAtLogin, true);
});

test('applyDefaultOnFirstLaunch: idempotent — returning user keeps existing setting', () => {
  // User previously set the toggle OFF. App relaunch should NOT re-enable it.
  const { calls, store } = makeBed({
    platform: 'darwin',
    initialConfig: { autoStartMonitoring: 0 },
    initialOsLoginItem: false,
  });
  const r = autostart.applyDefaultOnFirstLaunch();
  assert.equal(r.firstLaunch, false);
  assert.equal(r.enabled, false);
  assert.equal(calls.setLoginItemSettings.length, 0, 'must not re-register Login Item');
  assert.equal(store.config.autoStartMonitoring, 0);
});

test('applyDefaultOnFirstLaunch: reconciles config when user toggled OS Login Item externally', () => {
  // User had it ON; opened System Settings → Login Items and removed Tally.
  // Next app launch should detect the divergence and update config to match.
  const { store } = makeBed({
    platform: 'darwin',
    initialConfig: { autoStartMonitoring: 1 },
    initialOsLoginItem: false, // OS truth: disabled
  });
  const r = autostart.applyDefaultOnFirstLaunch();
  assert.equal(r.firstLaunch, false);
  assert.equal(r.enabled, false, 'should report OS truth, not stale config');
  assert.equal(store.config.autoStartMonitoring, 0, 'config should be reconciled to OS state');
});

test('applyDefaultOnFirstLaunch on Linux: uses config-only path, no OS calls', () => {
  const { calls, store } = makeBed({ platform: 'linux', initialConfig: {} });
  const r = autostart.applyDefaultOnFirstLaunch();
  assert.equal(r.firstLaunch, true);
  assert.equal(r.enabled, true);
  assert.equal(store.config.autoStartMonitoring, 1);
  assert.equal(calls.setLoginItemSettings.length, 0);
});

// ─── Defensive wrappers — Electron throws shouldn't crash the app ───────────

test('readOsLoginItem returns null and logs when getLoginItemSettings throws', () => {
  const calls = { logs: [] };
  autostart.init({
    app: {
      getLoginItemSettings: () => { throw new Error('boom'); },
      setLoginItemSettings: () => {},
    },
    loadConfig: () => ({ autoStartMonitoring: 1 }),
    saveConfig: () => {},
    platform: 'darwin',
    logger: (msg) => calls.logs.push(msg),
  });
  // Falls through to config fallback when OS read fails
  const r = autostart.getAutoStart();
  assert.equal(r.enabled, true);
  assert.ok(calls.logs.some(l => /getLoginItemSettings threw/.test(l)));
});

test('writeOsLoginItem swallows setLoginItemSettings errors but still writes config', () => {
  const calls = { setCalls: 0, logs: [] };
  const store = { config: {} };
  autostart.init({
    app: {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: () => { calls.setCalls++; throw new Error('SCOd'); },
    },
    loadConfig: () => ({ ...store.config }),
    saveConfig: (patch) => { Object.assign(store.config, patch); },
    platform: 'darwin',
    logger: (msg) => calls.logs.push(msg),
  });
  const r = autostart.setAutoStart(true);
  assert.equal(r.ok, true, 'setAutoStart should still report ok — config persisted');
  assert.equal(r.osLoginItem, false, 'osLoginItem flag reflects the failed write');
  assert.equal(store.config.autoStartMonitoring, 1, 'config must persist regardless of OS call failure');
  assert.equal(calls.setCalls, 1, 'OS call was attempted');
  assert.ok(calls.logs.some(l => /setLoginItemSettings threw/.test(l)));
});

// ─── End-to-end wiring — main.js delegates to autostart module ──────────────

test('main.js wiring: get-autostart + set-autostart IPC channels delegate to autostart', () => {
  // Source-level check that the IPC bridge in main.js routes to this module
  // (rather than re-implementing the logic inline). Cheap but catches the
  // refactor regression of someone copying logic back into main.js.
  const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(MAIN_JS, /require\(['"]\.\/autostart['"]\)/);
  assert.match(MAIN_JS, /ipcMain\.handle\(['"]get-autostart['"][^\n]*autostart\.getAutoStart/);
  assert.match(MAIN_JS, /ipcMain\.handle\(['"]set-autostart['"][^\n]*autostart\.setAutoStart/);
  assert.match(MAIN_JS, /autostart\.applyDefaultOnFirstLaunch\(\)/,
    'first-launch hook must run from app.whenReady()');
});
