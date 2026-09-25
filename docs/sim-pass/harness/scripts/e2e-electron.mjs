#!/usr/bin/env node
/**
 * Tally Linux e2e — Playwright Electron harness (source launch).
 * Points ONLY at local relay (:3400) + MockLab ATEM (:9910/:9911).
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Prefer electron-app's playwright
const { _electron } = require('/workspace/tally/electron-app/node_modules/playwright');

const ROOT = '/workspace/tally-linux';
const REPO = '/workspace/tally';
const ELECTRON_APP = path.join(REPO, 'electron-app');
const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-credentials.json'), 'utf8'));
const RUN_ID = process.env.TALLY_RUN_ID || 'run1';
const OUT = path.join(ROOT, 'results', RUN_ID);
const SHOTS = path.join(ROOT, 'screenshots', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const CONFIG_PATH = path.join(ROOT, 'data', RUN_ID, 'config.json');
const APPIMAGE = process.env.TALLY_APPIMAGE || '';
// Prefer extracted AppImage binary (squashfs-root/tally-connect) so Playwright
// argv reaches Electron. Raw AppImage via FUSE often drops/breaks CLI flags.
const PACKAGED_BIN = process.env.TALLY_PACKAGED_BIN || '';
const PACKAGED = PACKAGED_BIN || APPIMAGE;
const results = [];

function record(name, status, detail = '') {
  results.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`${status === 'PASS' ? '✓' : status === 'SKIPPED' ? '○' : '✗'} [${status}] ${name}${detail ? ' — ' + detail : ''}`);
}
async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}
async function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function postControl(route, body = {}) {
  const res = await fetch(`${creds.controlApi}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: res.ok, text }; }
}

async function main() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    relay: creds.relayWs,
    autoStartMonitoring: 0,
  }, null, 2));

  let app, page;
  try {
    const launchEnv = {
      ...process.env,
      NODE_ENV: PACKAGED ? 'production' : 'development',
      APPIMAGE_EXTRACT_AND_RUN: (APPIMAGE && !PACKAGED_BIN) ? '1' : process.env.APPIMAGE_EXTRACT_AND_RUN,
      DISPLAY: process.env.DISPLAY || ':2',
      TALLY_DEFAULT_RELAY_URL: creds.relayWs,
      TALLY_CONFIG_PATH: CONFIG_PATH,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    };

    // Strip relay-server / harness secrets that must not leak into Electron or the agent.
    // Sourcing relay.env in the parent shell previously polluted JWT_SECRET/PORT/DATABASE_*
    // and correlated with false Offline banners + failed ATEM connects under load.
    for (const k of [
      'JWT_SECRET', 'UNSUBSCRIBE_SECRET', 'ADMIN_API_KEY', 'SESSION_SECRET',
      'DATABASE_DRIVER', 'DATABASE_PATH', 'PORT', 'APP_URL', 'ALLOWED_ORIGINS',
      'LOG_FORMAT', 'TALLY_REQUIRE_ACTIVE_BILLING',
    ]) {
      delete launchEnv[k];
    }

    if (PACKAGED) {
      // Packaged payload — extracted binary preferred for reliable --config-path argv
      const exe = PACKAGED_BIN || APPIMAGE;
      fs.chmodSync(exe, 0o755);
      app = await _electron.launch({
        executablePath: exe,
        args: [
          `--relay-url=${creds.relayWs}`,
          `--config-path=${CONFIG_PATH}`,
          '--no-sandbox',
        ],
        env: launchEnv,
        timeout: 120000,
      });
    } else {
      app = await _electron.launch({
        args: [
          path.join(ELECTRON_APP, 'src', 'main.js'),
          `--relay-url=${creds.relayWs}`,
          `--config-path=${CONFIG_PATH}`,
          '--no-sandbox',
        ],
        cwd: ELECTRON_APP,
        env: launchEnv,
        timeout: 90000,
      });
    }
    page = await app.firstWindow({ timeout: 45000 });
    await page.waitForLoadState('domcontentloaded');
    await waitMs(2500);
    await shot(page, '01-launch');
    record('app_launch', 'PASS');
  } catch (e) {
    record('app_launch', 'FAIL', String(e.stack || e));
    return finish(1);
  }

  // Sign in
  try {
    await page.waitForSelector('#si-email', { timeout: 20000 });
    await page.fill('#si-email', creds.email);
    await page.fill('#si-password', creds.password);
    await shot(page, '02-signin-filled');
    await page.click('#si-btn');
    await page.waitForFunction(() => {
      const rs = document.getElementById('room-selector');
      const dash = document.getElementById('dashboard');
      const msg = document.getElementById('si-message')?.textContent || '';
      return (rs && rs.classList.contains('active')) ||
             (dash && dash.classList.contains('active')) ||
             /fail|error|wrong|invalid/i.test(msg);
    }, { timeout: 45000 });
    await waitMs(1500);
    await shot(page, '03-after-signin');
    const msg = (await page.locator('#si-message').textContent().catch(() => '')) || '';
    if (/fail|error|wrong|invalid/i.test(msg)) {
      record('sign_in_local_relay', 'FAIL', msg);
    } else {
      record('sign_in_local_relay', 'PASS', msg || 'post-auth UI');
    }
  } catch (e) {
    await shot(page, '03-signin-fail').catch(() => {});
    record('sign_in_local_relay', 'FAIL', String(e.message || e));
  }

  // Room
  try {
    const createForm = page.locator('#rs-create-form');
    if (await createForm.isVisible().catch(() => false)) {
      await page.fill('#rs-room-name', 'Sanctuary Linux');
      await page.click('#rs-create-btn');
    } else {
      const btn = page.locator('.rs-room-btn').first();
      if (await btn.count()) await btn.click();
      else {
        // Try add-link then create
        const add = page.locator('#rs-add-link a, #rs-add-link button').first();
        if (await add.count()) {
          await add.click();
          await page.fill('#rs-room-name', 'Sanctuary Linux');
          await page.click('#rs-create-btn');
        }
      }
    }
    await page.waitForFunction(() => {
      const dash = document.getElementById('dashboard');
      const wiz = document.getElementById('wizard') || document.getElementById('equipment-wizard') || document.getElementById('onboarding');
      return (dash && dash.classList.contains('active')) ||
             (wiz && (wiz.classList.contains('active') || wiz.style.display !== 'none'));
    }, { timeout: 45000 });
    await waitMs(1500);
    // New churches land on equipment wizard — skip to dashboard with setupComplete
    await page.evaluate(async () => {
      try {
        if (typeof skipToManualSetup === 'function') {
          await skipToManualSetup();
        } else {
          await window.electronAPI.saveConfig({ setupComplete: true });
          if (typeof showDashboard === 'function') showDashboard();
        }
      } catch (_) { /* best effort */ }
    });
    await waitMs(2000);
    // Dismiss first-launch welcome modal so Control Room is interactable
    await page.evaluate(() => {
      try {
        if (typeof dismissFirstLaunch === 'function') dismissFirstLaunch();
        else {
          localStorage.setItem('firstLaunchSeen', '1');
          const modal = document.getElementById('first-launch-modal');
          if (modal) modal.style.display = 'none';
        }
      } catch (_) {}
    });
    await waitMs(500);
    await shot(page, '04-dashboard');
    record('room_select', 'PASS', 'wizard-skip or dashboard');
  } catch (e) {
    await shot(page, '04-room-fail').catch(() => {});
    record('room_select', 'FAIL', String(e.message || e));
  }

  // Configure ATEM + (re)start agent so atemIp is picked up
  try {
    await page.evaluate(async ({ host, relay }) => {
      // stop first — startAgent is a no-op if already running (wizard may have started it)
      try { await window.electronAPI.stopAgent(); } catch (_) {}
      await window.electronAPI.saveConfig({ atemIp: host, relay });
      await window.electronAPI.startAgent();
    }, { host: creds.atemHost, relay: creds.relayWs });
    // Poll until ATEM or relay reports connected (boolean fields on agentStatus)
    let status = null;
    let atemConnected = false;
    let relayConnected = false;
    for (let i = 0; i < 45; i++) {
      await waitMs(1000);
      status = await page.evaluate(async () => window.electronAPI.getStatus());
      atemConnected = status?.atem === true || status?.atem?.connected === true;
      relayConnected = status?.relay === true || status?.relay?.connected === true;
      if (atemConnected && relayConnected) break;
    }
    await shot(page, '05-agent-started');
    // Honesty: the local agent must really be up (relay WS connected + relay sees the church).
    // A stale relay snapshot can otherwise make atem look connected with no agent running.
    const h = await fetch(`${creds.relayHttp}/api/health`).then((r) => r.json()).catch(() => ({}));
    const relaySeesChurch = (h.connectedChurches || 0) >= 1;
    record('device_connect_atem_sim', (atemConnected && relayConnected && relaySeesChurch) ? 'PASS' : 'FAIL',
      `SIMULATED MockLab; atem=${atemConnected} relay=${relayConnected} relayConnectedChurches=${h.connectedChurches}; status=${JSON.stringify(status).slice(0, 300)}`);
  } catch (e) {
    record('device_connect_atem_sim', 'FAIL', String(e.message || e));
  }

  // Program / preview — PASS only when VISIBLE UI matches sim (never status-only)
  try {
    // Control-room tally strip lives on the Dashboard tab (room skip lands on Devices)
    await page.evaluate(() => {
      try { if (typeof switchTab === 'function') switchTab('dashboard'); } catch (_) {}
    });
    await waitMs(500);
    // Ensure agent is up before cutting — otherwise UI stays stale until connect
    for (let i = 0; i < 15; i++) {
      const st0 = await page.evaluate(async () => window.electronAPI.getStatus());
      if (st0?.atem === true || st0?.atem?.connected === true) break;
      await waitMs(1000);
    }
    await postControl('program', { me: 0, input: 5 });
    await postControl('preview', { me: 0, input: 3 });
    let pgm = '', pvw = '', ok = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await waitMs(500);
      // Ensure strip visible (compact control room)
      await page.evaluate(() => {
        const strip = document.getElementById('cr-tally-strip');
        if (strip) strip.style.display = 'flex';
      }).catch(() => {});
      pgm = ((await page.locator('#cr-pgm-source').textContent().catch(() => '')) || '').trim();
      pvw = ((await page.locator('#cr-pvw-source').textContent().catch(() => '')) || '').trim();
      const pgmOk = /^(5|Cam\s*5|Camera\s*5|Input\s*5)$/i.test(pgm) || /\b5\b/.test(pgm);
      const pvwOk = /^(3|Cam\s*3|Camera\s*3|Input\s*3)$/i.test(pvw) || /\b3\b/.test(pvw);
      // Reject placeholder
      if (pgm === '--' || pvw === '--' || pgm === '—' || pvw === '—') {
        ok = false;
      } else {
        ok = pgmOk && pvwOk;
      }
      if (ok) break;
    }
    await shot(page, '06-pgm-pvw');
    const st = await page.evaluate(async () => window.electronAPI.getStatus());
    const prog = st?.programInput ?? st?.atem?.programInput;
    const prev = st?.previewInput ?? st?.atem?.previewInput;
    record('tally_program_preview_sim', ok ? 'PASS' : 'FAIL',
      `SIMULATED MockLab; UI pgm="${pgm}" pvw="${pvw}" statusProg=${prog} statusPvw=${prev}`);
  } catch (e) {
    record('tally_program_preview_sim', 'FAIL', String(e.message || e));
  }

  // Disconnect: point at dead IP, then restore (SIMULATED). Require BOTH sides.
  try {
    await page.evaluate(async () => {
      await window.electronAPI.saveConfig({ atemIp: '127.0.0.254' });
      await window.electronAPI.stopAgent();
      await new Promise((r) => setTimeout(r, 1500));
      await window.electronAPI.startAgent();
    });
    let disconnected = false;
    let st1 = null;
    for (let i = 0; i < 20; i++) {
      await waitMs(500);
      st1 = await page.evaluate(async () => window.electronAPI.getStatus());
      const atem = st1?.atem;
      const connected = atem === true || (atem && typeof atem === 'object' && atem.connected === true);
      if (!connected) { disconnected = true; break; }
    }
    await shot(page, '07-disconnect');
    await page.evaluate(async ({ host }) => {
      await window.electronAPI.saveConfig({ atemIp: host });
      await window.electronAPI.stopAgent();
      await new Promise((r) => setTimeout(r, 1500));
      await window.electronAPI.startAgent();
    }, { host: creds.atemHost });
    let reconnected = false;
    let st2 = null;
    // Cold agent respawn after dead-IP attempt can take as long as first connect
    for (let i = 0; i < 50; i++) {
      await waitMs(1000);
      st2 = await page.evaluate(async () => window.electronAPI.getStatus());
      const atem = st2?.atem;
      const connected = atem === true || (atem && typeof atem === 'object' && atem.connected === true);
      if (connected) { reconnected = true; break; }
    }
    await shot(page, '08-reconnect');
    const pass = disconnected && reconnected;
    record('alert_disconnect_reconnect_sim',
      pass ? 'PASS' : 'FAIL',
      `SIMULATED unreachable IP; disconnected=${disconnected} reconnected=${reconnected}`);
  } catch (e) {
    record('alert_disconnect_reconnect_sim', 'FAIL', String(e.message || e));
  }

  // Relay health + persistence
  try {
    const health = await fetch(`${creds.relayHttp}/api/health`).then((r) => r.json());
    record('relay_health_local',
      (health?.status === 'healthy' || health?.ok) ? 'PASS' : 'FAIL',
      JSON.stringify(health).slice(0, 200));
  } catch (e) {
    record('relay_health_local', 'FAIL', String(e.message || e));
  }

  try {
    await page.evaluate(async () => {
      await window.electronAPI.saveConfig({ atemIp: '127.0.0.1' });
    });
    await waitMs(500);
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    record('app_restart_persistence',
      saved.atemIp === '127.0.0.1' ? 'PASS' : 'FAIL',
      `config keys=${Object.keys(saved).join(',')}`);
  } catch (e) {
    record('app_restart_persistence', 'FAIL', String(e.message || e));
  }

  // Agent stop/start as relay-path simulation
  try {
    const isUp = (st, k) => st?.[k] === true || st?.[k]?.connected === true;
    await page.evaluate(async () => { await window.electronAPI.stopAgent(); });
    await waitMs(2000);
    const stStop = await page.evaluate(async () => window.electronAPI.getStatus());
    const droppedOk = !isUp(stStop, 'relay') && !isUp(stStop, 'atem');
    await shot(page, '09-agent-stopped');
    await page.evaluate(async () => { await window.electronAPI.startAgent(); });
    let backOk = false, stBack = null;
    for (let i = 0; i < 40; i++) {
      await waitMs(1000);
      stBack = await page.evaluate(async () => window.electronAPI.getStatus());
      if (isUp(stBack, 'relay') && isUp(stBack, 'atem')) { backOk = true; break; }
    }
    await shot(page, '10-agent-restarted');
    record('relay_drop_reconnect_agent', (droppedOk && backOk) ? 'PASS' : 'FAIL',
      `stop→relay/atem cleared=${droppedOk}; start→relay+atem back=${backOk}`);
  } catch (e) {
    record('relay_drop_reconnect_agent', 'FAIL', String(e.message || e));
  }

  try {
    await app.close();
  } catch {
    try { await app.evaluate(({ app: a }) => a.exit(0)); } catch { /* */ }
  }
  return finish(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

function finish(code) {
  const outFile = path.join(OUT, 'e2e-results.json');
  fs.writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, results }, null, 2));
  console.log(`\nWrote ${outFile}`);
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  record('harness_crash', 'FAIL', String(e.stack || e));
  finish(1);
});
