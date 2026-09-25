#!/usr/bin/env node
/**
 * Real Linux booth kill -9 proof for auto-rejoin.
 * Local relay :3400 + MockLab only. Never production.
 *
 * Pass means: after SIGKILL, relaunch lands on the dashboard of the same room
 * with no click, the loading line said "Rejoining …" while the relay round-trip
 * was in flight, and the banner says the app closed unexpectedly.
 * Change Room then another kill -9 must show the room picker (no auto-rejoin).
 *
 * TALLY_REPO selects the booth source (current checkout or a pre-rejoin worktree).
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PW = process.env.TALLY_PLAYWRIGHT || '/workspace/electron-app/node_modules/playwright';
const { _electron } = require(PW);

const ROOT = '/workspace/tally-linux';
const REPO = process.env.TALLY_REPO || '/workspace/tally';
const ELECTRON_APP = path.join(REPO, 'electron-app');
const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-credentials.json'), 'utf8'));
const RUN_ID = process.env.TALLY_RUN_ID || 'kill9';
const OUT = path.join(ROOT, 'results', RUN_ID);
const SHOTS = path.join(ROOT, 'screenshots', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
const CONFIG_PATH = path.join(ROOT, 'data', RUN_ID, 'config.json');

const results = [];
let app = null;
let page = null;

function record(name, status, detail = '') {
  results.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`${status === 'PASS' ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}
function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function shot(p, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await p.screenshot({ path: file, fullPage: false });
  return file;
}

async function launchApp(configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const launchEnv = {
    ...process.env,
    NODE_ENV: 'development',
    DISPLAY: process.env.DISPLAY || ':1',
    TALLY_DEFAULT_RELAY_URL: creds.relayWs,
    TALLY_CONFIG_PATH: configPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  for (const k of [
    'JWT_SECRET', 'UNSUBSCRIBE_SECRET', 'ADMIN_API_KEY', 'SESSION_SECRET',
    'DATABASE_DRIVER', 'DATABASE_PATH', 'PORT', 'APP_URL', 'ALLOWED_ORIGINS',
    'LOG_FORMAT', 'TALLY_REQUIRE_ACTIVE_BILLING',
  ]) delete launchEnv[k];

  const launched = await _electron.launch({
    args: [
      path.join(ELECTRON_APP, 'src', 'main.js'),
      `--relay-url=${creds.relayWs}`,
      `--config-path=${configPath}`,
      '--no-sandbox',
      '--disable-gpu',
    ],
    cwd: ELECTRON_APP,
    env: launchEnv,
    timeout: 90000,
  });
  const win = await launched.firstWindow({ timeout: 45000 });
  await win.waitForLoadState('domcontentloaded');
  return { app: launched, page: win };
}

function killApp() {
  const pid = app.process().pid;
  console.log(`kill -9 electron pid=${pid}`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  try { execSync(`pkill -9 -P ${pid} 2>/dev/null || true`); } catch { /* */ }
  app = null;
}

async function screenOf(p) {
  return p.evaluate(() => {
    const on = (id) => !!document.getElementById(id)?.classList.contains('active');
    if (on('dashboard')) return 'dashboard';
    if (on('room-selector')) return 'room-selector';
    const si = document.getElementById('si-email');
    if (on('sign-in') && si && si.offsetParent !== null) return 'sign-in';
    const loading = document.getElementById('sign-in-loading');
    if (on('sign-in') && loading && loading.classList.contains('active')) return 'loading';
    return 'other';
  }).catch(() => 'gone');
}

async function signInAndRoom(p) {
  await p.waitForSelector('#si-email', { timeout: 25000 });
  await p.fill('#si-email', creds.email);
  await p.fill('#si-password', creds.password);
  await p.click('#si-btn');
  await p.waitForFunction(() => {
    const rs = document.getElementById('room-selector');
    const dash = document.getElementById('dashboard');
    const msg = document.getElementById('si-message')?.textContent || '';
    return (rs && rs.classList.contains('active')) ||
      (dash && dash.classList.contains('active')) ||
      /fail|error|wrong|invalid|too many/i.test(msg);
  }, { timeout: 45000 });
  const msg = (await p.locator('#si-message').textContent().catch(() => '')) || '';
  if (/fail|error|wrong|invalid|too many/i.test(msg)) throw new Error('sign-in failed: ' + msg);
  const createForm = p.locator('#rs-create-form');
  if (await createForm.isVisible().catch(() => false)) {
    await p.fill('#rs-room-name', 'Sanctuary Linux');
    await p.click('#rs-create-btn');
  } else {
    const btn = p.locator('.rs-room-btn').first();
    if (await btn.count()) await btn.click();
    else {
      await p.locator('#rs-add-link a, #rs-add-link button').first().click();
      await p.fill('#rs-room-name', 'Sanctuary Linux');
      await p.click('#rs-create-btn');
    }
  }
  await p.waitForFunction(() => {
    const dash = document.getElementById('dashboard');
    const wiz = document.getElementById('wizard');
    return (dash && dash.classList.contains('active')) || (wiz && wiz.classList.contains('active'));
  }, { timeout: 45000 });
  await p.evaluate(async () => {
    try {
      if (typeof skipToManualSetup === 'function') await skipToManualSetup();
      else {
        await window.electronAPI.saveConfig({ setupComplete: true });
        if (typeof showDashboard === 'function') showDashboard();
      }
    } catch { /* */ }
  });
  await p.evaluate(() => {
    try {
      if (typeof dismissFirstLaunch === 'function') dismissFirstLaunch();
      else {
        localStorage.setItem('firstLaunchSeen', '1');
        const modal = document.getElementById('first-launch-modal');
        if (modal) modal.style.display = 'none';
      }
    } catch { /* */ }
  });
  await waitMs(500);
}

async function connectAtem(p) {
  await p.evaluate(async ({ host, relay }) => {
    try { await window.electronAPI.stopAgent(); } catch { /* */ }
    await window.electronAPI.saveConfig({ atemIp: host, relay, setupComplete: true });
    await window.electronAPI.saveEquipment({ atemIp: host });
    await window.electronAPI.startAgent();
  }, { host: creds.atemHost, relay: creds.relayWs });
  let status = null;
  let atem = false;
  let relay = false;
  for (let i = 0; i < 40; i++) {
    await waitMs(500);
    status = await p.evaluate(async () => window.electronAPI.getStatus());
    atem = status?.atem === true || status?.atem?.connected === true;
    relay = status?.relay === true || status?.relay?.connected === true;
    if (atem && relay) break;
  }
  return { atem, relay, status };
}

function readCfg() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function main() {
  console.log(`repo=${REPO}`);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ relay: creds.relayWs, autoStartMonitoring: 0 }, null, 2));

  try {
    ({ app, page } = await launchApp(CONFIG_PATH));
    await signInAndRoom(page);
    const conn = await connectAtem(page);
    await waitMs(1500);
    const before = readCfg();
    await shot(page, '01-in-room');
    record('joined_room_before_kill', before.roomId ? 'PASS' : 'FAIL',
      `roomId=${before.roomId || ''} roomName=${before.roomName || ''} rejoin=${!!before.rejoinRoom} atem=${conn.atem} relay=${conn.relay}`);
    if (!before.roomId) throw new Error('never entered a room');

    const roomBefore = before.roomId;
    const roomName = before.roomName || before.rejoinRoom?.roomName || '';
    killApp();
    await waitMs(1500);
    const t0 = Date.now();
    ({ app, page } = await launchApp(CONFIG_PATH));

    const seen = [];
    let screen = 'loading';
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      const snap = await page.evaluate(() => ({
        screen: (() => {
          const on = (id) => !!document.getElementById(id)?.classList.contains('active');
          if (on('dashboard')) return 'dashboard';
          if (on('room-selector')) return 'room-selector';
          const loading = document.getElementById('sign-in-loading');
          if (on('sign-in') && loading && loading.classList.contains('active')) return 'loading';
          const si = document.getElementById('si-email');
          if (on('sign-in') && si && si.offsetParent !== null) return 'sign-in';
          return 'other';
        })(),
        loading: document.getElementById('sign-in-loading-text')?.textContent || '',
        banner: document.getElementById('rejoin-banner-text')?.textContent || '',
        detail: document.getElementById('rejoin-banner-detail')?.textContent || '',
        bannerOn: (() => {
          const b = document.getElementById('rejoin-banner');
          return !!b && getComputedStyle(b).display !== 'none';
        })(),
      })).catch(() => null);
      if (snap) {
        if (snap.loading && seen[seen.length - 1] !== snap.loading) seen.push(snap.loading);
        screen = snap.screen;
        if (screen === 'dashboard' || screen === 'room-selector' || screen === 'sign-in') break;
      }
      await waitMs(40);
    }
    // Dashboard may still be painting the banner.
    await waitMs(800);
    const banner = await page.evaluate(() => {
      const b = document.getElementById('rejoin-banner');
      return {
        visible: !!b && getComputedStyle(b).display !== 'none',
        text: document.getElementById('rejoin-banner-text')?.textContent || '',
        detail: document.getElementById('rejoin-banner-detail')?.textContent || '',
      };
    }).catch(() => ({ visible: false, text: '', detail: '' }));
    screen = await screenOf(page);
    const after = readCfg();
    await shot(page, '02-after-kill9');
    const sawRejoining = seen.some((t) => /Rejoining /i.test(t));
    const pass = screen === 'dashboard'
      && after.roomId === roomBefore
      && banner.visible
      && banner.text.includes(roomName)
      && /unexpectedly/i.test(banner.detail)
      && sawRejoining;
    record('kill9_auto_rejoin_same_room', pass ? 'PASS' : 'FAIL',
      `screen=${screen} sameRoom=${after.roomId === roomBefore} sawRejoining=${sawRejoining} loading=${JSON.stringify(seen)} banner="${banner.text}" / "${banner.detail}" visible=${banner.visible} ms=${Date.now() - t0}`);

    if (pass) {
      await page.evaluate(() => { try { dismissFirstLaunch(); } catch { /* */ } });
      await page.click('#change-room-btn');
      await page.waitForFunction(() => document.getElementById('room-selector')?.classList.contains('active'), { timeout: 20000 });
      await waitMs(500);
      const mid = readCfg();
      killApp();
      await waitMs(1500);
      ({ app, page } = await launchApp(CONFIG_PATH));
      const deadline2 = Date.now() + 30000;
      let screen2 = 'loading';
      while (Date.now() < deadline2) {
        screen2 = await screenOf(page);
        if (screen2 === 'room-selector' || screen2 === 'dashboard' || screen2 === 'sign-in') {
          if (screen2 !== 'room-selector') break;
          const loaded = await page.evaluate(() => getComputedStyle(document.getElementById('rs-loading')).display === 'none').catch(() => false);
          if (loaded) break;
        }
        await waitMs(200);
      }
      await waitMs(600);
      const banner2 = await page.evaluate(() => {
        const b = document.getElementById('rejoin-banner');
        return !!b && getComputedStyle(b).display !== 'none';
      }).catch(() => false);
      const afterLeave = readCfg();
      await shot(page, '03-after-change-room-kill9');
      const leavePass = !mid.rejoinRoom && screen2 === 'room-selector' && !banner2 && !afterLeave.rejoinRoom;
      record('change_room_then_kill9_shows_picker', leavePass ? 'PASS' : 'FAIL',
        `recordCleared=${!mid.rejoinRoom} screen=${screen2} banner=${banner2} roomId=${afterLeave.roomId || ''}`);
    } else {
      record('change_room_then_kill9_shows_picker', 'FAIL', 'not run — auto-rejoin did not pass');
    }
  } catch (e) {
    if (!results.some((r) => r.name === 'kill9_auto_rejoin_same_room')) {
      record('kill9_auto_rejoin_same_room', 'FAIL', String(e && e.stack || e));
    } else if (!results.some((r) => r.name === 'change_room_then_kill9_shows_picker')) {
      record('change_room_then_kill9_shows_picker', 'FAIL', String(e && e.message || e));
    }
    try { if (page) await shot(page, '99-error'); } catch { /* */ }
  }

  try { if (app) await app.close(); } catch { /* */ }
  const outFile = path.join(OUT, 'kill9-results.json');
  fs.writeFileSync(outFile, JSON.stringify({ repo: REPO, runId: RUN_ID, results }, null, 2));
  console.log(`wrote ${outFile}`);
  const failed = results.some((r) => r.status !== 'PASS');
  process.exit(failed ? 1 : 0);
}

main();
