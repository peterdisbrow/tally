/**
 * autostart-contract.test.js — what the "Start monitoring on launch" toggle
 * actually does, and what it does NOT do.
 *
 * AUDIT FINDING (May 2026): the IPC channel pair `get-autostart` /
 * `set-autostart` only flips the local config field `autoStartMonitoring`,
 * which controls whether the church-client *agent* starts after the user
 * signs into the desktop app. It does NOT register the Tally app as a macOS
 * Login Item via `app.setLoginItemSettings()` — meaning the app does not
 * relaunch itself after a reboot or logout.
 *
 * If product-side intent changes and the toggle should also register a Login
 * Item, the assertion below (`MUST NOT call setLoginItemSettings`) needs to
 * be replaced with an assertion that it DOES. Until then, this test pins
 * current behaviour so a future contributor can't quietly add a Login Item
 * call without the rest of the team noticing.
 *
 * The IPC handler logic is loaded directly from main.js source via regex
 * extraction — full main.js cannot be required without booting Electron.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const PRELOAD_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const RENDERER_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');

// ─── IPC channel exists end-to-end ──────────────────────────────────────────

test('preload exposes getAutoStart / setAutoStart as the IPC bridge', () => {
  assert.match(PRELOAD_JS, /getAutoStart:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(['"]get-autostart['"]\)/);
  assert.match(PRELOAD_JS, /setAutoStart:\s*\(enabled\)\s*=>\s*ipcRenderer\.invoke\(['"]set-autostart['"]/);
});

test('main.js handles both get-autostart and set-autostart channels', () => {
  assert.match(MAIN_JS, /ipcMain\.handle\(['"]get-autostart['"]/);
  assert.match(MAIN_JS, /ipcMain\.handle\(['"]set-autostart['"]/);
});

// ─── What the toggle does ───────────────────────────────────────────────────

test('set-autostart persists autoStartMonitoring in local config', () => {
  // The handler writes config.autoStartMonitoring (1 or 0) and nothing else.
  // This is the storage key proceedAfterRoomSelection() reads on launch.
  assert.match(
    MAIN_JS,
    /ipcMain\.handle\(['"]set-autostart['"][^}]*saveConfig\(\{\s*autoStartMonitoring:/s,
  );
});

test('autoStartMonitoring is in the save-config allow-list (not silently dropped)', () => {
  // Regression guard: if someone tightens the ALLOWED_CONFIG_KEYS set without
  // including autoStartMonitoring, every setAutoStart() write becomes a no-op.
  assert.match(MAIN_JS, /ALLOWED_CONFIG_KEYS[\s\S]{0,2000}'autoStartMonitoring'/);
});

test('renderer auto-starts the agent on dashboard entry when the flag is set', () => {
  // proceedAfterRoomSelection() is the only consumer — confirm the link.
  assert.match(RENDERER_JS, /api\.getAutoStart\(\)/);
  assert.match(RENDERER_JS, /shouldAutoStart[\s\S]{0,200}api\.startAgent\(\)/);
});

test('UI label accurately describes the toggle (agent start, not OS login)', () => {
  // The label MUST stay aligned with what the handler does. If the toggle
  // ever gains Login Item behaviour, this assertion needs updating to match.
  assert.match(INDEX_HTML, /id="autostart-checkbox"/);
  assert.match(INDEX_HTML, /Start monitoring on launch/);
});

// ─── What the toggle does NOT do — the audit gap ────────────────────────────

test('AUDIT GAP: main.js never calls app.setLoginItemSettings (no OS login registration)', () => {
  // If you are adding macOS Login Item support, replace this assertion with a
  // positive check that set-autostart calls app.setLoginItemSettings({
  //   openAtLogin: enabled, openAsHidden: true (so it boots straight to tray)
  // }) — and update the HTML label to "Launch Tally at login" or similar.
  assert.doesNotMatch(MAIN_JS, /setLoginItemSettings/,
    'Found setLoginItemSettings — autostart now registers an OS login item; ' +
    'update this test (and the UI label) accordingly.');
  assert.doesNotMatch(MAIN_JS, /getLoginItemSettings/);
});

test('AUDIT GAP: no auto-launch package wired up in package.json', () => {
  // Belt-and-suspenders check — the auto-launch npm package is the other
  // common path for cross-platform login-item registration. Should it appear
  // here, the gap is being closed and the test above needs to flip too.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.equal(allDeps['auto-launch'], undefined,
    'auto-launch dependency added — login-item registration may now be active.');
});
