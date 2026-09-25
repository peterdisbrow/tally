#!/usr/bin/env node
/**
 * Shared booth e2e helpers (extracted verbatim from paces-e2e.mjs) for the simulator pass.
 * Local relay (:3400) + MockLab ATEM (:9910/:9911) only. Never production.
 */
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _electron } = require('/workspace/tally/electron-app/node_modules/playwright');

const ROOT = '/workspace/tally-linux';
const REPO = '/workspace/tally';
const ELECTRON_APP = path.join(REPO, 'electron-app');
const creds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test-credentials.json'), 'utf8'));
const RUN_ID = process.env.TALLY_RUN_ID || 'sim-booth';
const OUT = path.join(ROOT, 'results', RUN_ID);
const SHOTS = path.join(ROOT, 'screenshots', RUN_ID);
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const CONFIG_PATH = path.join(ROOT, 'data', RUN_ID, 'config.json');
const PACKAGED_BIN = process.env.TALLY_PACKAGED_BIN || '';
const results = [];
let app = null;
let page = null;

function record(name, status, detail = '') {
  results.push({ name, status, detail, at: new Date().toISOString() });
  console.log(`${status === 'PASS' ? '✓' : status === 'SKIPPED' ? '○' : '✗'} [${status}] ${name}${detail ? ' — ' + detail : ''}`);
}
async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
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

function finish(code) {
  const outFile = path.join(OUT, 'e2e-results.json');
  fs.writeFileSync(outFile, JSON.stringify({ runId: RUN_ID, results }, null, 2));
  console.log(`\nWrote ${outFile}`);
  process.exit(code);
}

async function launchApp(configPath = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      relay: creds.relayWs,
      autoStartMonitoring: 0,
    }, null, 2));
  }
  const launchEnv = {
    ...process.env,
    NODE_ENV: PACKAGED_BIN ? 'production' : 'development',
    DISPLAY: process.env.DISPLAY || ':2',
    TALLY_DEFAULT_RELAY_URL: creds.relayWs,
    TALLY_CONFIG_PATH: configPath,
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

  let launched;
  if (PACKAGED_BIN) {
    fs.chmodSync(PACKAGED_BIN, 0o755);
    launched = await _electron.launch({
      executablePath: PACKAGED_BIN,
      args: [`--relay-url=${creds.relayWs}`, `--config-path=${configPath}`, '--no-sandbox'],
      env: launchEnv,
      timeout: 120000,
    });
  } else {
    launched = await _electron.launch({
      args: [
        path.join(ELECTRON_APP, 'src', 'main.js'),
        `--relay-url=${creds.relayWs}`,
        `--config-path=${configPath}`,
        '--no-sandbox',
      ],
      cwd: ELECTRON_APP,
      env: launchEnv,
      timeout: 90000,
    });
  }
  const win = await launched.firstWindow({ timeout: 45000 });
  await win.waitForLoadState('domcontentloaded');
  await waitMs(2000);
  return { app: launched, page: win };
}

async function closeApp(a) {
  if (!a) return;
  try { await a.close(); } catch {
    try { await a.evaluate(({ app: x }) => x.exit(0)); } catch { /* */ }
  }
  await waitMs(1000);
}

async function signInAndRoom(p) {
  await p.waitForSelector('#si-email', { timeout: 20000 });
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
  await waitMs(1000);
  const msg = (await p.locator('#si-message').textContent().catch(() => '')) || '';
  if (/fail|error|wrong|invalid|too many/i.test(msg)) {
    throw new Error('sign-in failed: ' + msg);
  }
  const createForm = p.locator('#rs-create-form');
  if (await createForm.isVisible().catch(() => false)) {
    await p.fill('#rs-room-name', 'Sanctuary Linux');
    await p.click('#rs-create-btn');
  } else {
    const btn = p.locator('.rs-room-btn').first();
    if (await btn.count()) await btn.click();
    else {
      const add = p.locator('#rs-add-link a, #rs-add-link button').first();
      if (await add.count()) {
        await add.click();
        await p.fill('#rs-room-name', 'Sanctuary Linux');
        await p.click('#rs-create-btn');
      }
    }
  }
  await p.waitForFunction(() => {
    const dash = document.getElementById('dashboard');
    const wiz = document.getElementById('wizard') || document.getElementById('equipment-wizard') || document.getElementById('onboarding');
    return (dash && dash.classList.contains('active')) ||
           (wiz && (wiz.classList.contains('active') || wiz.style.display !== 'none'));
  }, { timeout: 45000 });
  await waitMs(1000);
  await p.evaluate(async () => {
    try {
      if (typeof skipToManualSetup === 'function') await skipToManualSetup();
      else {
        await window.electronAPI.saveConfig({ setupComplete: true });
        if (typeof showDashboard === 'function') showDashboard();
      }
    } catch (_) {}
  });
  await waitMs(1500);
  await p.evaluate(() => {
    try {
      if (typeof dismissFirstLaunch === 'function') dismissFirstLaunch();
      else {
        localStorage.setItem('firstLaunchSeen', '1');
        const modal = document.getElementById('first-launch-modal');
        if (modal) modal.style.display = 'none';
      }
    } catch (_) {}
  });
  await waitMs(400);
}

async function connectAtem(p) {
  await p.evaluate(async ({ host, relay }) => {
    try { await window.electronAPI.stopAgent(); } catch (_) {}
    await window.electronAPI.saveConfig({ atemIp: host, relay });
    await window.electronAPI.startAgent();
  }, { host: creds.atemHost, relay: creds.relayWs });
  let status = null, atemConnected = false, relayConnected = false;
  for (let i = 0; i < 50; i++) {
    await waitMs(1000);
    status = await p.evaluate(async () => window.electronAPI.getStatus());
    atemConnected = status?.atem === true || status?.atem?.connected === true;
    relayConnected = status?.relay === true || status?.relay?.connected === true;
    if (atemConnected && relayConnected) break;
  }
  // Honesty: agent must be live on relay, not a stale snapshot
  return { atemConnected: atemConnected && relayConnected, status };
}

async function waitPgmPvw(p, expectPgm = 5, expectPvw = 3, timeoutMs = 25000) {
  await p.evaluate(() => {
    try { if (typeof switchTab === 'function') switchTab('dashboard'); } catch (_) {}
  });
  await waitMs(400);
  await postControl('program', { me: 0, input: expectPgm });
  await postControl('preview', { me: 0, input: expectPvw });
  let pgm = '', pvw = '', ok = false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitMs(500);
    await p.evaluate(() => {
      const strip = document.getElementById('cr-tally-strip');
      if (strip) strip.style.display = 'flex';
    }).catch(() => {});
    pgm = ((await p.locator('#cr-pgm-source').textContent().catch(() => '')) || '').trim();
    pvw = ((await p.locator('#cr-pvw-source').textContent().catch(() => '')) || '').trim();
    const pgmOk = new RegExp(`\\b${expectPgm}\\b`).test(pgm) || new RegExp(`Camera\\s*${expectPgm}`, 'i').test(pgm);
    const pvwOk = new RegExp(`\\b${expectPvw}\\b`).test(pvw) || new RegExp(`Camera\\s*${expectPvw}`, 'i').test(pvw);
    if (pgm === '--' || pvw === '--' || pgm === '—' || pvw === '—') ok = false;
    else ok = pgmOk && pvwOk;
    if (ok) break;
  }
  return { ok, pgm, pvw };
}

async function uiSnapshot(p) {
  return p.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
    const chip = (id) => { const d = document.getElementById(id); return d ? (d.classList.contains('status-chip') ? d : d.closest('.status-chip')) : null; };
    return {
      banner: getComputedStyle(document.getElementById('offline-banner')).display !== 'none',
      bannerText: document.getElementById('offline-banner-text')?.textContent || '',
      pill: document.getElementById('connectivity-label')?.textContent || '',
      heroHead: document.getElementById('cr-hero-headline')?.textContent || '',
      heroSub: document.getElementById('cr-hero-sub')?.textContent || '',
      network: document.getElementById('cr-network-status')?.textContent || '',
      unconfiguredChipsVisible: ['dot-encoder', 'dot-companion', 'dot-propresenter-chip', 'dot-resolume-chip']
        .filter((id) => vis(chip(id))),
      unconfiguredCardsVisible: ['cr-card-encoder', 'cr-card-companion', 'cr-card-propresenter']
        .filter((id) => { const c = document.getElementById(id); return !!c && getComputedStyle(c).display !== 'none'; }),
      visibleSections: [...document.querySelectorAll('#tab-dashboard .section, .tab-content.active .section')]
        .filter((c) => getComputedStyle(c).display !== 'none')
        .map((c) => `${c.id}:${(c.querySelector('h2')?.textContent || '').trim()}`),
      unconfiguredSectionsVisible: ['encoder-status-section', 'stream-protection-section', 'section-companion', 'section-propresenter']
        .filter((id) => { const c = document.getElementById(id); return !!c && getComputedStyle(c).display !== 'none'; }),
    };
  });
}

async function waitAtemConnected(p, wantConnected, timeoutMs = 50000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await p.evaluate(async () => window.electronAPI.getStatus());
    const atem = last?.atem;
    const connected = atem === true || (atem && typeof atem === 'object' && atem.connected === true);
    if (connected === wantConnected) return { ok: true, status: last };
    await waitMs(500);
  }
  return { ok: false, status: last };
}

function findRelayPid() {
  try {
    const out = execSync("ss -tlnp 2>/dev/null | grep ':3400' || true", { encoding: 'utf8' });
    const m = out.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* */ }
  try {
    const out = execSync("pgrep -f 'relay-server/server.js' || true", { encoding: 'utf8' });
    const pid = Number((out.trim().split('\n')[0] || '').trim());
    if (pid) return pid;
  } catch { /* */ }
  return null;
}

function startRelay() {
  const envFile = fs.readFileSync(path.join(ROOT, 'data/relay.env'), 'utf8');
  const env = { ...process.env };
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  const child = spawn('nice', ['-n', '5', 'node', path.join(REPO, 'relay-server/server.js')], {
    env,
    detached: true,
    stdio: ['ignore', fs.openSync(path.join(ROOT, 'logs/relay.log'), 'a'), fs.openSync(path.join(ROOT, 'logs/relay.log'), 'a')],
  });
  child.unref();
  fs.writeFileSync(path.join(ROOT, 'data/relay.pid'), String(child.pid));
  return child.pid;
}

async function waitRelayHealth(wantOk, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${creds.relayHttp}/api/health`, { signal: AbortSignal.timeout(2000) });
      const ok = r.ok;
      if (ok === wantOk) return true;
    } catch {
      if (!wantOk) return true;
    }
    await waitMs(500);
  }
  return false;
}


export {
  ROOT, REPO, creds, RUN_ID, OUT, SHOTS, CONFIG_PATH, PACKAGED_BIN, results,
  record, shot, waitMs, postControl, finish, launchApp, closeApp, signInAndRoom,
  connectAtem, waitPgmPvw, uiSnapshot, waitAtemConnected, findRelayPid, startRelay, waitRelayHealth,
};
