#!/usr/bin/env node
/**
 * Tally Linux HARD PACES pass — extends the 9-check e2e with stress/edge cases.
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
const RUN_ID = process.env.TALLY_RUN_ID || 'paces1';
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

async function main() {
  // Clear in-memory login rate limiter (harness limitation, 5 logins / 15 min)
  try { execSync('bash /workspace/tally-linux/scripts/restart-relay.sh', { stdio: 'inherit' }); } catch { /* */ }
  // Fresh config for this run
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    relay: creds.relayWs,
    autoStartMonitoring: 0,
  }, null, 2));

  // ─── 1. Cold start → sign-in → room → ATEM → PGM/PVW ───
  try {
    ({ app, page } = await launchApp());
    await shot(page, '01-launch');
    record('cold_start_launch', 'PASS');
  } catch (e) {
    record('cold_start_launch', 'FAIL', String(e.stack || e));
    return finish(1);
  }

  try {
    await signInAndRoom(page);
    await shot(page, '02-signed-in-dashboard');
    record('sign_in_room', 'PASS');
  } catch (e) {
    await shot(page, '02-signin-fail').catch(() => {});
    record('sign_in_room', 'FAIL', String(e.message || e));
    await closeApp(app);
    return finish(1);
  }

  try {
    const { atemConnected, status } = await connectAtem(page);
    await shot(page, '03-atem-connected');
    record('atem_sim_connect', atemConnected ? 'PASS' : 'FAIL',
      `atem=${atemConnected} status=${JSON.stringify(status).slice(0, 300)}`);
  } catch (e) {
    record('atem_sim_connect', 'FAIL', String(e.message || e));
  }

  try {
    const { ok, pgm, pvw } = await waitPgmPvw(page, 5, 3);
    await waitMs(3000); // let local-status polls land (regression: they re-added unconfigured pills)
    await shot(page, '04-pgm-pvw');
    record('pgm_pvw_visible', ok ? 'PASS' : 'FAIL', `UI pgm="${pgm}" pvw="${pvw}"`);
    const ui = await uiSnapshot(page);
    const clean = ui.unconfiguredChipsVisible.length === 0 && ui.unconfiguredCardsVisible.length === 0 && ui.unconfiguredSectionsVisible.length === 0 && !/issue/i.test(ui.heroHead) && !ui.banner && /connected/i.test(ui.pill) && !/disconnected/i.test(ui.pill);
    record('ui_clean_atem_only_booth', clean ? 'PASS' : 'FAIL', JSON.stringify(ui));
  } catch (e) {
    record('pgm_pvw_visible', 'FAIL', String(e.message || e));
  }

  // ─── 2. Wrong/dead ATEM IP then recover to sim ───
  try {
    await page.evaluate(async () => {
      await window.electronAPI.saveConfig({ atemIp: '127.0.0.254' });
      await window.electronAPI.stopAgent();
      await new Promise((r) => setTimeout(r, 1500));
      await window.electronAPI.startAgent();
    });
    const dead = await waitAtemConnected(page, false, 15000);
    // Relay is healthy here — agent restart must NOT claim "Relay unreachable"
    let falseOffline = null;
    for (let i = 0; i < 16; i++) {
      const u = await uiSnapshot(page);
      if (u.banner || /offline/i.test(u.pill) || /relay offline/i.test(u.network)) { falseOffline = u; break; }
      await waitMs(500);
    }
    await shot(page, '05-dead-atem-ip');
    record('no_false_relay_offline_on_agent_restart', falseOffline ? 'FAIL' : 'PASS',
      falseOffline ? JSON.stringify(falseOffline) : 'banner/pill/network stayed non-offline during 8s agent restart (relay healthy)');
    await page.evaluate(async ({ host }) => {
      await window.electronAPI.saveConfig({ atemIp: host });
      await window.electronAPI.stopAgent();
      await new Promise((r) => setTimeout(r, 1500));
      await window.electronAPI.startAgent();
    }, { host: creds.atemHost });
    const live = await waitAtemConnected(page, true, 55000);
    await shot(page, '06-recover-atem-sim');
    const pv = await waitPgmPvw(page, 5, 3, 20000);
    const pass = dead.ok && live.ok && pv.ok;
    record('dead_ip_then_recover', pass ? 'PASS' : 'FAIL',
      `disconnected=${dead.ok} reconnected=${live.ok} pgmPvw=${pv.ok} pgm="${pv.pgm}" pvw="${pv.pvw}"`);
  } catch (e) {
    record('dead_ip_then_recover', 'FAIL', String(e.message || e));
  }

  // ─── 3. Rapid ATEM disconnect/reconnect ×5 ───
  try {
    let cyclesOk = 0;
    const cycleDetails = [];
    for (let c = 1; c <= 5; c++) {
      await page.evaluate(async () => {
        await window.electronAPI.saveConfig({ atemIp: '127.0.0.253' });
        await window.electronAPI.stopAgent();
        await new Promise((r) => setTimeout(r, 1200));
        await window.electronAPI.startAgent();
      });
      const d = await waitAtemConnected(page, false, 12000);
      await page.evaluate(async ({ host }) => {
        await window.electronAPI.saveConfig({ atemIp: host });
        await window.electronAPI.stopAgent();
        await new Promise((r) => setTimeout(r, 1200));
        await window.electronAPI.startAgent();
      }, { host: creds.atemHost });
      const r = await waitAtemConnected(page, true, 50000);
      const ok = d.ok && r.ok;
      if (ok) cyclesOk++;
      cycleDetails.push(`c${c}:disc=${d.ok}/rec=${r.ok}`);
      console.log(`  rapid cycle ${c}/5 disc=${d.ok} rec=${r.ok}`);
    }
    await shot(page, '07-rapid-atem-x5');
    // After cycles, PGM/PVW must still work
    const pv = await waitPgmPvw(page, 5, 3, 20000);
    await shot(page, '08-after-rapid-pgm-pvw');
    const pass = cyclesOk === 5 && pv.ok;
    record('rapid_atem_disconnect_reconnect_x5', pass ? 'PASS' : 'FAIL',
      `${cyclesOk}/5; ${cycleDetails.join('; ')}; pgm="${pv.pgm}" pvw="${pv.pvw}"`);
  } catch (e) {
    record('rapid_atem_disconnect_reconnect_x5', 'FAIL', String(e.message || e));
  }

  // ─── 4. Relay down 30–60s → offline banner + local mode honesty ───
  let relayPidBefore = findRelayPid();
  try {
    if (!relayPidBefore) throw new Error('relay pid not found on :3400');
    console.log(`  stopping relay pid=${relayPidBefore} for offline banner test`);
    // PACES_RELAY_MODE=stop → SIGSTOP (hung relay, half-open TCP); kill → SIGTERM (conn refused)
    if ((process.env.PACES_RELAY_MODE || 'stop') === 'kill') {
      process.kill(relayPidBefore, 'SIGTERM');
      relayPidBefore = null;
    } else {
      try { process.kill(relayPidBefore, 'SIGSTOP'); } catch {
        process.kill(relayPidBefore, 'SIGTERM');
        relayPidBefore = null;
      }
    }
    const outageStart = Date.now();
    // Health monitor: 10s interval × 3 failures ≈ 30s; wait up to 55s for banner
    let bannerVisible = false;
    let bannerText = '';
    let connLabel = '';
    const bannerDeadline = Date.now() + 55000;
    while (Date.now() < bannerDeadline) {
      await waitMs(1000);
      const info = await page.evaluate(() => {
        const b = document.getElementById('offline-banner');
        const style = b ? window.getComputedStyle(b) : null;
        const visible = !!(b && style && style.display !== 'none' && style.visibility !== 'hidden' && b.offsetParent !== null);
        // also accept display:flex/block set inline
        const inlineShow = b && b.style.display && b.style.display !== 'none';
        return {
          visible: visible || inlineShow || (b && getComputedStyle(b).display !== 'none'),
          text: document.getElementById('offline-banner-text')?.textContent || '',
          detail: document.getElementById('offline-banner-detail')?.textContent || '',
          conn: document.getElementById('connectivity-label')?.textContent || '',
          connClass: document.getElementById('connectivity-indicator')?.className || '',
          display: b ? getComputedStyle(b).display : 'missing',
        };
      });
      bannerText = info.text;
      connLabel = info.conn;
      if (info.display !== 'none' && info.display !== 'missing') { bannerVisible = true; break; }
    }
    const outageMs = Date.now() - outageStart;
    await shot(page, '09-offline-banner');
    const uiDown = await uiSnapshot(page);
    const consistent = uiDown.banner && !/^connected$/i.test(uiDown.pill.trim()) && !/^online$/i.test(uiDown.network.trim()) && !/relay connected/i.test(uiDown.heroSub) && !/All Systems Nominal/i.test(uiDown.heroHead);
    record('relay_down_ui_consistent', consistent ? 'PASS' : 'FAIL', JSON.stringify(uiDown));
    // Keep relay down for at least 40s total (spec: 30–60s outage)
    while (Date.now() - outageStart < 40000) await waitMs(1000);
    const bannerStill = await page.evaluate(() => getComputedStyle(document.getElementById('offline-banner')).display !== 'none');
    await shot(page, '09b-offline-banner-40s');
    // Local mode honesty: ATEM should still be connected locally while relay is down
    const localStatus = await page.evaluate(async () => window.electronAPI.getStatus());
    const atemStill = localStatus?.atem === true || localStatus?.atem?.connected === true;

    // Bring relay back
    if (relayPidBefore) {
      try { process.kill(relayPidBefore, 'SIGCONT'); } catch { /* */ }
    } else {
      startRelay();
    }
    await waitRelayHealth(true, 45000);
    // Wait for banner to clear / connectivity restore
    let restored = false;
    let restoreInfo = null;
    for (let i = 0; i < 60; i++) {
      await waitMs(1000);
      const info = await page.evaluate(async () => {
        const b = document.getElementById('offline-banner');
        const display = b ? getComputedStyle(b).display : 'none';
        const conn = document.getElementById('connectivity-label')?.textContent || '';
        const st = await window.electronAPI.getStatus();
        const relay = st?.relay === true || st?.relay?.connected === true;
        return { display, conn, relay };
      });
      restoreInfo = info;
      if (info.display === 'none' && info.relay) {
        restored = true;
        break;
      }
    }
    await shot(page, '10-relay-restored');
    const totalOutageSec = Math.round((Date.now() - outageStart) / 1000);
    const pass = bannerVisible && bannerStill && restored;
    record('relay_down_offline_banner', pass ? 'PASS' : 'FAIL',
      `bannerVisible=${bannerVisible} text="${bannerText}" conn="${connLabel}" mode=${process.env.PACES_RELAY_MODE || 'stop'} outageSecBeforeBanner=${Math.round(outageMs/1000)} bannerStillAt40s=${bannerStill} atemLocal=${atemStill} restored=${restored} restoreInfo=${JSON.stringify(restoreInfo)}`);
    if (!atemStill) {
      record('relay_down_local_mode_honesty', 'FAIL', 'ATEM dropped while relay was down — expected local monitoring to hold');
    } else {
      record('relay_down_local_mode_honesty', 'PASS', 'ATEM stayed connected locally during relay outage');
    }
  } catch (e) {
    // Always try to restore relay
    try {
      if (relayPidBefore) process.kill(relayPidBefore, 'SIGCONT');
    } catch {
      try { startRelay(); } catch { /* */ }
    }
    await waitRelayHealth(true, 30000).catch(() => {});
    record('relay_down_offline_banner', 'FAIL', String(e.message || e));
    record('relay_down_local_mode_honesty', 'FAIL', 'skipped due to prior error');
  }

  // ─── 5. Auto-rejoin last room (Andrew, Sep 24 6:02 PM) ───
  // kill -9 → relaunch auto-rejoins same room with PGM/PVW on screen (no clicks,
  // no harness startAgent); clean quit → rejoin; relay down at relaunch → local
  // rejoin then confirm; Leave Room / sign-out → picker; deleted room → picker + message.
  const cfgFile = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const screenOf = (p) => p.evaluate(() => {
    const on = (id) => !!document.getElementById(id)?.classList.contains('active');
    if (on('dashboard')) return 'dashboard';
    if (on('room-selector')) return 'room-selector';
    const si = document.getElementById('si-email');
    if (on('sign-in') && si && si.offsetParent !== null) return 'sign-in';
    return 'loading';
  }).catch(() => 'loading');
  async function waitScreen(p, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let s = 'loading';
    while (Date.now() < deadline) {
      s = await screenOf(p);
      if (s !== 'loading') {
        // room-selector must have finished loading rooms to be meaningful
        if (s !== 'room-selector') return s;
        const loaded = await p.evaluate(() => getComputedStyle(document.getElementById('rs-loading')).display === 'none').catch(() => false);
        if (loaded) return s;
      }
      await waitMs(250);
    }
    return s;
  }
  const rejoinBanner = (p) => p.evaluate(() => {
    const b = document.getElementById('rejoin-banner');
    return {
      visible: !!b && getComputedStyle(b).display !== 'none',
      text: document.getElementById('rejoin-banner-text')?.textContent || '',
      detail: document.getElementById('rejoin-banner-detail')?.textContent || '',
      local: !!b?.classList.contains('local'),
    };
  }).catch(() => ({ visible: false, text: '', detail: '', local: false }));
  function killApp() {
    const pid = app.process().pid;
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
    try { execSync(`pkill -9 -P ${pid} 2>/dev/null || true`); } catch { /* */ }
    app = null;
  }
  // PGM/PVW read off the screen WITHOUT the harness touching the switcher.
  async function passivePgmPvw(p, timeoutMs = 30000) {
    await p.evaluate(() => { try { if (typeof switchTab === 'function') switchTab('dashboard'); } catch (_) {} }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    let pgm = '', pvw = '';
    while (Date.now() < deadline) {
      pgm = ((await p.locator('#cr-pgm-source').textContent().catch(() => '')) || '').trim();
      pvw = ((await p.locator('#cr-pvw-source').textContent().catch(() => '')) || '').trim();
      if (/Camera\s*5|\b5\b/i.test(pgm) && /Camera\s*3|\b3\b/i.test(pvw) && pgm !== '--' && pvw !== '--') return { ok: true, pgm, pvw };
      await waitMs(250);
    }
    return { ok: false, pgm, pvw };
  }
  // From relaunch t0: dashboard, ATEM, relay, PGM/PVW on screen.
  async function measureRejoin(p, t0, { wantRelay = true } = {}) {
    const screen = await waitScreen(p, 45000);
    const dashMs = Date.now() - t0;
    const banner = await rejoinBanner(p);
    const up = await waitAtemConnected(p, true, 50000);
    const atemMs = Date.now() - t0;
    let relayUp = false;
    if (wantRelay) {
      for (let i = 0; i < 120; i++) {
        const st = await p.evaluate(async () => window.electronAPI.getStatus());
        relayUp = st?.relay === true || st?.relay?.connected === true;
        if (relayUp) break;
        await waitMs(250);
      }
    }
    const relayMs = Date.now() - t0;
    const pv = await passivePgmPvw(p, 30000);
    const pvMs = Date.now() - t0;
    const running = await p.evaluate(async () => window.electronAPI.isRunning()).catch(() => false);
    return { screen, dashMs, banner, atem: up.ok, atemMs, relayUp, relayMs, pv, pvMs, running };
  }
  const roomNameOf = () => { try { return cfgFile().rejoinRoom?.roomName || cfgFile().roomName || ''; } catch { return ''; } };
  const rejoinTimings = [];

  // 5a. kill -9 → auto-rejoin same room
  let roomBefore = null;
  try {
    const marker = `paces-kill9-${Date.now()}`;
    await page.evaluate(async ({ host, marker }) => {
      await window.electronAPI.saveConfig({ atemIp: host, liveStreamUrl: `https://example.invalid/${marker}`, setupComplete: true });
      await window.electronAPI.saveEquipment({ atemIp: host });
    }, { host: creds.atemHost, marker });
    await waitMs(2500);
    const before = cfgFile();
    roomBefore = before.roomId;
    const recordBefore = before.rejoinRoom;
    console.log(`  kill -9 electron pid=${app.process().pid} room=${roomBefore}`);
    killApp();
    await waitMs(2000);
    const t0 = Date.now();
    ({ app, page } = await launchApp(CONFIG_PATH));
    const m = await measureRejoin(page, t0);
    await shot(page, '11-kill9-auto-rejoin');
    const after = cfgFile();
    const want = `https://example.invalid/${marker}`;
    const cfgOk = after.atemIp === creds.atemHost && after.liveStreamUrl === want && after.setupComplete === true && !!after.token;
    record('config_persist_kill9', cfgOk ? 'PASS' : 'FAIL',
      `marker before=${before.liveStreamUrl === want} after=${after.liveStreamUrl === want} atemIp=${after.atemIp} token=${!!after.token} recordBeforeKill=${!!recordBefore}`);
    const room = recordBefore?.roomName || '';
    const pass = m.screen === 'dashboard' && m.banner.visible && m.banner.text.includes(room) && /Reconnected to/.test(m.banner.text)
      && /unexpectedly/i.test(m.banner.detail) && !m.banner.local && m.atem && m.relayUp && m.pv.ok && after.roomId === roomBefore && !!roomBefore;
    rejoinTimings.push({ case: 'kill9', ...m });
    record('kill9_auto_rejoin_same_room', pass ? 'PASS' : 'FAIL',
      `screen=${m.screen} banner="${m.banner.text}" / "${m.banner.detail}" sameRoom=${after.roomId === roomBefore} dashboard@${m.dashMs}ms atem=${m.atem}@${m.atemMs}ms relay=${m.relayUp}@${m.relayMs}ms pgmPvwOnScreen=${m.pv.ok}@${m.pvMs}ms pgm="${m.pv.pgm}" pvw="${m.pv.pvw}"`);
    record('restart_after_kill9_reconnect', (m.atem && m.relayUp && m.pv.ok) ? 'PASS' : 'FAIL',
      `no manual start: atem=${m.atem}@${m.atemMs}ms relay=${m.relayUp}@${m.relayMs}ms (from relaunch)`);
  } catch (e) {
    record('config_persist_kill9', 'FAIL', String(e.message || e));
    record('kill9_auto_rejoin_same_room', 'FAIL', String(e.message || e));
    record('restart_after_kill9_reconnect', 'FAIL', String(e.message || e));
  }

  // 5b. clean quit → relaunch auto-rejoins (documented policy: rejoin unless left)
  try {
    await closeApp(app); app = null;
    const afterQuit = cfgFile();
    const t0 = Date.now();
    ({ app, page } = await launchApp(CONFIG_PATH));
    const m = await measureRejoin(page, t0);
    await shot(page, '11c-clean-quit-auto-rejoin');
    rejoinTimings.push({ case: 'clean-quit', ...m });
    const pass = afterQuit.rejoinRoom?.cleanExit === true && !afterQuit.roomId && m.screen === 'dashboard' && m.banner.visible
      && /Rejoined your last room/i.test(m.banner.detail) && m.atem && m.relayUp && m.pv.ok && cfgFile().roomId === roomBefore;
    record('clean_quit_auto_rejoin', pass ? 'PASS' : 'FAIL',
      `onDisk cleanExit=${afterQuit.rejoinRoom?.cleanExit} roomIdClearedOnQuit=${!afterQuit.roomId} screen=${m.screen} detail="${m.banner.detail}" dashboard@${m.dashMs}ms atem@${m.atemMs}ms relay@${m.relayMs}ms pgmPvw=${m.pv.ok}@${m.pvMs}ms`);
  } catch (e) {
    record('clean_quit_auto_rejoin', 'FAIL', String(e.message || e));
  }

  // 5c. crash while relay is DOWN → local rejoin (ATEM live, honest banner) → relay back → confirmed
  try {
    killApp();
    const rp = findRelayPid();
    if (rp) process.kill(rp, 'SIGTERM');
    await waitRelayHealth(false, 15000);
    await waitMs(1000);
    const t0 = Date.now();
    ({ app, page } = await launchApp(CONFIG_PATH));
    const m = await measureRejoin(page, t0, { wantRelay: false });
    const relayClaim = await page.evaluate(async () => { const s = await window.electronAPI.getStatus(); return s?.relay === true || s?.relay?.connected === true; });
    await shot(page, '11d-relay-down-local-rejoin');
    // Hero honesty: while relay is down the headline must never be green-nominal;
    // after the connect grace it must settle on the calm local-mode headline.
    const heroSeen = [];
    let heroLocal = false;
    for (let i = 0; i < 70; i++) {
      const h = await page.evaluate(() => ({ t: document.getElementById('cr-hero-headline')?.textContent || '', c: document.getElementById('cr-hero-icon')?.className || '' }));
      if (!heroSeen.includes(h.t)) heroSeen.push(h.t);
      if (/Monitoring Locally/.test(h.t) && /local/.test(h.c)) { heroLocal = true; break; }
      await waitMs(500);
    }
    await shot(page, '11d2-relay-down-hero-local');
    const localOk = m.screen === 'dashboard' && m.banner.visible && m.banner.local && /relay offline/i.test(m.banner.text) && m.atem && m.pv.ok && !relayClaim;
    startRelay();
    await waitRelayHealth(true, 45000);
    const tRelay = Date.now();
    let confirmed = false, relayUp = false, b = null;
    for (let i = 0; i < 120; i++) {
      b = await rejoinBanner(page);
      const st = await page.evaluate(async () => window.electronAPI.getStatus());
      relayUp = st?.relay === true || st?.relay?.connected === true;
      confirmed = /confirmed/i.test(b.detail) && !b.local;
      if (confirmed && relayUp) break;
      await waitMs(500);
    }
    const confirmMs = Date.now() - tRelay;
    await shot(page, '11e-relay-back-room-confirmed');
    let heroBack = '';
    for (let i = 0; i < 40; i++) {
      heroBack = await page.evaluate(() => document.getElementById('cr-hero-headline')?.textContent || '');
      if (heroBack === 'All Systems Nominal') break;
      await waitMs(500);
    }
    const heroOk = heroLocal && !heroSeen.includes('All Systems Nominal') && heroBack === 'All Systems Nominal';
    record('hero_honest_relay_down', heroOk ? 'PASS' : 'FAIL',
      `relay down headlines seen=${JSON.stringify(heroSeen)} settledLocal=${heroLocal}; relay back headline="${heroBack}"`);
    const sameRoom = cfgFile().roomId === roomBefore;
    rejoinTimings.push({ case: 'relay-down-local', ...m, confirmMs });
    record('relay_down_relaunch_local_rejoin', (localOk && confirmed && relayUp && sameRoom) ? 'PASS' : 'FAIL',
      `local: screen=${m.screen} banner="${m.banner.text}" local=${m.banner.local} atem=${m.atem}@${m.atemMs}ms pgmPvw=${m.pv.ok}@${m.pvMs}ms relayClaimedWhileDown=${relayClaim}; after relay back: confirmed=${confirmed} relay=${relayUp} in ${confirmMs}ms sameRoom=${sameRoom}`);
  } catch (e) {
    try { if (!findRelayPid()) startRelay(); } catch { /* */ }
    await waitRelayHealth(true, 30000).catch(() => {});
    record('relay_down_relaunch_local_rejoin', 'FAIL', String(e.message || e));
    record('hero_honest_relay_down', 'FAIL', String(e.message || e));
  }

  // 5d. Leave room (Change Room) → relaunch shows picker (no auto-join)
  try {
    await page.click('#change-room-btn');
    await waitScreen(page, 20000);
    const recordAfterLeave = cfgFile().rejoinRoom;
    await closeApp(app); app = null;
    ({ app, page } = await launchApp(CONFIG_PATH));
    const screen = await waitScreen(page, 45000);
    await waitMs(1500);
    const running = await page.evaluate(async () => window.electronAPI.isRunning());
    const b = await rejoinBanner(page);
    await shot(page, '11f-leave-room-relaunch-picker');
    const pass = !recordAfterLeave && screen === 'room-selector' && !running && !b.visible;
    record('leave_room_relaunch_shows_picker', pass ? 'PASS' : 'FAIL',
      `recordClearedOnLeave=${!recordAfterLeave} screen=${screen} agentRunning=${running} rejoinBanner=${b.visible}`);
  } catch (e) {
    record('leave_room_relaunch_shows_picker', 'FAIL', String(e.message || e));
  }

  // 5d2. Relay drops while the operator is on the picker, then they pick their
  // room: the failed equipment fetch must NOT wipe the room's equipment, roomId
  // must match the chosen room, and the ATEM must come up locally. (Re-arms rejoin.)
  try {
    const beforePick = cfgFile();
    const rp = findRelayPid();
    if (rp) process.kill(rp, 'SIGTERM');
    await waitRelayHealth(false, 15000);
    console.log(`[5d2] relay down; picking room ${new Date().toISOString()}`);
    await page.locator('.rs-room-btn').first().click({ timeout: 20000 });
    await page.waitForFunction(() => !!document.getElementById('dashboard')?.classList.contains('active'), { timeout: 45000 });
    console.log(`[5d2] dashboard ${new Date().toISOString()}`);
    let atemUp = false;
    const tPick = Date.now();
    for (let i = 0; i < 60 && !atemUp; i++) {
      const st = await page.evaluate(async () => window.electronAPI.getStatus());
      atemUp = st?.atem === true || st?.atem?.connected === true;
      if (!atemUp) await waitMs(500);
    }
    const atemMs = Date.now() - tPick;
    const afterPick = cfgFile();
    const roomKey = afterPick.roomName || '_default';
    const savedCopy = (afterPick.roomConfigs || {})[roomKey] || {};
    await shot(page, '11f2-picker-relay-down-equipment-kept');
    startRelay();
    await waitRelayHealth(true, 45000);
    const pass = !!beforePick.atemIp && afterPick.atemIp === beforePick.atemIp && savedCopy.atemIp === beforePick.atemIp
      && afterPick.roomId === roomBefore && atemUp;
    record('picker_relay_down_keeps_equipment', pass ? 'PASS' : 'FAIL',
      `atemIp before="${beforePick.atemIp}" after="${afterPick.atemIp}" savedCopy="${savedCopy.atemIp}" roomId=${afterPick.roomId}==${roomBefore}:${afterPick.roomId === roomBefore} roomName="${afterPick.roomName}" atemLocal=${atemUp}@${atemMs}ms`);
  } catch (e) {
    try { if (!findRelayPid()) startRelay(); } catch { /* */ }
    await waitRelayHealth(true, 30000).catch(() => {});
    record('picker_relay_down_keeps_equipment', 'FAIL', String(e.message || e));
  }

  // 5e. Sign-out → relaunch: sign-in screen; after signing in → picker (not auto-joined)
  try {
    await page.evaluate(async () => { await window.electronAPI.signOut(); });
    await waitMs(1000);
    const cfgAfter = cfgFile();
    await closeApp(app); app = null;
    ({ app, page } = await launchApp(CONFIG_PATH));
    const screen1 = await waitScreen(page, 45000);
    await page.fill('#si-email', creds.email);
    await page.fill('#si-password', creds.password);
    await page.click('#si-btn');
    let screen2 = 'sign-in';
    for (let i = 0; i < 90 && (screen2 === 'sign-in' || screen2 === 'loading'); i++) {
      await waitMs(500);
      screen2 = await waitScreen(page, 5000);
      if (screen2 === 'sign-in' && /fail|error|wrong|invalid|too many/i.test(await page.locator('#si-message').textContent().catch(() => ''))) break;
    }
    await waitMs(1500);
    const running = await page.evaluate(async () => window.electronAPI.isRunning());
    await shot(page, '11g-signout-relaunch-picker');
    const pass = !cfgAfter.token && !cfgAfter.rejoinRoom && screen1 === 'sign-in' && screen2 === 'room-selector' && !running;
    record('signout_relaunch_shows_picker', pass ? 'PASS' : 'FAIL',
      `wiped token=${!cfgAfter.token} record=${!cfgAfter.rejoinRoom} relaunch=${screen1} afterSignIn=${screen2} agentRunning=${running}`);
    // Sign-out wiped setupComplete → room pick opens the equipment wizard (by design); skip it like first run.
    await page.locator('.rs-room-btn').first().click();
    await page.waitForFunction(() => {
      const dash = document.getElementById('dashboard');
      const wiz = document.getElementById('wizard');
      return (dash && dash.classList.contains('active')) || (wiz && wiz.classList.contains('active'));
    }, { timeout: 30000 });
    await page.evaluate(async () => {
      try { if (typeof skipToManualSetup === 'function') await skipToManualSetup(); } catch (_) {}
      try { if (typeof dismissFirstLaunch === 'function') dismissFirstLaunch(); } catch (_) {}
    });
    await page.waitForFunction(() => !!document.getElementById('dashboard')?.classList.contains('active'), { timeout: 30000 });
    await waitMs(1500);
  } catch (e) {
    record('signout_relaunch_shows_picker', 'FAIL', String(e.message || e));
  }

  // 5f. Room deleted while the booth was down → picker with plain message; no loop
  try {
    const cfgNow = cfgFile();
    const roomId = cfgNow.rejoinRoom?.roomId;
    const roomName = cfgNow.rejoinRoom?.roomName || '';
    if (!roomId) throw new Error('no rejoin record before delete test');
    killApp();
    await waitMs(1500);
    const adminKey = (fs.readFileSync(path.join(ROOT, 'data/relay.env'), 'utf8').match(/^ADMIN_API_KEY=(.*)$/m) || [])[1];
    const del = await fetch(`${creds.relayHttp}/api/admin/rooms/${encodeURIComponent(roomId)}`, { method: 'DELETE', headers: { 'x-api-key': adminKey } });
    const delOk = del.ok;
    ({ app, page } = await launchApp(CONFIG_PATH));
    const screen = await waitScreen(page, 45000);
    await waitMs(1500);
    const msg = ((await page.locator('#rs-message').textContent().catch(() => '')) || '').trim();
    const running = await page.evaluate(async () => window.electronAPI.isRunning());
    const st = await page.evaluate(async () => window.electronAPI.getStatus());
    const fakeConnected = st?.atem === true || st?.atem?.connected === true || st?.relay === true;
    const b = await rejoinBanner(page);
    await shot(page, '13-deleted-room-picker-message');
    const recordGone = !cfgFile().rejoinRoom;
    // No loop: next launch is a plain picker without the message
    await closeApp(app); app = null;
    ({ app, page } = await launchApp(CONFIG_PATH));
    const screen2 = await waitScreen(page, 45000);
    await waitMs(1000);
    const msg2 = ((await page.locator('#rs-message').textContent().catch(() => '')) || '').trim();
    const pass = delOk && screen === 'room-selector' && msg.includes(roomName) && /no longer available/i.test(msg) && !running && !fakeConnected && !b.visible && recordGone && screen2 === 'room-selector' && !msg2;
    record('deleted_room_relaunch_picker_message', pass ? 'PASS' : 'FAIL',
      `adminDelete=${del.status} screen=${screen} msg="${msg}" agentRunning=${running} fakeConnected=${fakeConnected} banner=${b.visible} recordCleared=${recordGone}; nextLaunch=${screen2} msg2="${msg2}"`);
    // Restore lab fixture through the real product path: create the room again
    if (await page.locator('#rs-create-form').isVisible().catch(() => false)) {
      await page.fill('#rs-room-name', 'Sanctuary Linux');
      await page.click('#rs-create-btn');
    } else {
      await page.locator('.rs-room-btn').first().click();
    }
    await page.waitForFunction(() => !!document.getElementById('dashboard')?.classList.contains('active'), { timeout: 30000 }).catch(() => {});
  } catch (e) {
    record('deleted_room_relaunch_picker_message', 'FAIL', String(e.message || e));
  }
  fs.writeFileSync(path.join(OUT, 'rejoin-timings.json'), JSON.stringify(rejoinTimings, null, 2));

  await closeApp(app);
  app = null;
  // Clean any leftover electron
  try { execSync('bash /workspace/tally-linux/scripts/cleanup-tally.sh'); } catch { /* */ }
  await waitMs(1500);

  // ─── 6. Two sequential full sessions (no lock/port collisions) ───
  try {
    const sessionResults = [];
    for (let s = 1; s <= 2; s++) {
      const cfg = path.join(ROOT, 'data', RUN_ID, `session${s}-config.json`);
      fs.writeFileSync(cfg, JSON.stringify({ relay: creds.relayWs, autoStartMonitoring: 0 }, null, 2));
      const launched = await launchApp(cfg);
      try {
        await signInAndRoom(launched.page);
        const { atemConnected } = await connectAtem(launched.page);
        const pv = await waitPgmPvw(launched.page, 5, 3, 20000);
        await shot(launched.page, `12-session${s}-pgm-pvw`);
        const ok = atemConnected && pv.ok;
        sessionResults.push({ s, ok, atemConnected, pgm: pv.pgm, pvw: pv.pvw });
        console.log(`  session ${s}: atem=${atemConnected} pgm="${pv.pgm}" pvw="${pv.pvw}"`);
      } finally {
        await closeApp(launched.app);
        try { execSync('bash /workspace/tally-linux/scripts/cleanup-tally.sh'); } catch { /* */ }
        await waitMs(2000);
      }
    }
    const pass = sessionResults.length === 2 && sessionResults.every((x) => x.ok);
    record('two_sequential_sessions', pass ? 'PASS' : 'FAIL', JSON.stringify(sessionResults));
  } catch (e) {
    record('two_sequential_sessions', 'FAIL', String(e.message || e));
  }

  // Ensure relay still healthy at end
  try {
    const health = await fetch(`${creds.relayHttp}/api/health`).then((r) => r.json());
    record('relay_health_end',
      (health?.status === 'healthy' || health?.ok) ? 'PASS' : 'FAIL',
      JSON.stringify(health).slice(0, 180));
  } catch (e) {
    // Try restart
    startRelay();
    await waitRelayHealth(true, 20000);
    record('relay_health_end', 'FAIL', String(e.message || e) + ' (attempted restart)');
  }

  return finish(results.some((r) => r.status === 'FAIL') ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  record('harness_crash', 'FAIL', String(e.stack || e));
  // Best-effort relay restore
  try {
    const pid = findRelayPid();
    if (!pid) startRelay();
  } catch { /* */ }
  finish(1);
});
