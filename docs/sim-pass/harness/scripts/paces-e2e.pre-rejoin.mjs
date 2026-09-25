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
    const consistent = uiDown.banner && !/^connected$/i.test(uiDown.pill.trim()) && !/^online$/i.test(uiDown.network.trim()) && !/relay connected/i.test(uiDown.heroSub);
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

  // ─── 5. Config persistence across kill -9 ───
  try {
    const marker = `paces-kill9-${Date.now()}`;
    await page.evaluate(async ({ host, marker }) => {
      await window.electronAPI.saveConfig({
        atemIp: host,
        liveStreamUrl: `https://example.invalid/${marker}`,
        setupComplete: true,
      });
      // Real user path: "Save Equipment Config" → persists + syncs room equipment to relay
      await window.electronAPI.saveEquipment({ atemIp: host });
    }, { host: creds.atemHost, marker });
    await waitMs(2500);
    const before = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Kill the Electron process hard
    const electronPid = app.process().pid;
    console.log(`  kill -9 electron pid=${electronPid}`);
    try { process.kill(electronPid, 'SIGKILL'); } catch { /* */ }
    // Also kill child processes if any
    try { execSync(`pkill -9 -P ${electronPid} 2>/dev/null || true`); } catch { /* */ }
    await waitMs(2000);
    app = null;
    // Relaunch with same config path
    ({ app, page } = await launchApp(CONFIG_PATH));
    await waitMs(1500);
    const after = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const want = `https://example.invalid/${marker}`;
    // By design (commit 30f33d5) roomId is cleared at startup and the room
    // selector shows every launch. So: equipment config + session token must
    // survive kill -9; sign-in must NOT be required; room pick → dashboard.
    const cfgOk = after.atemIp === creds.atemHost && after.liveStreamUrl === want && after.setupComplete === true
      && !!after.token;
    let screen = 'unknown';
    for (let i = 0; i < 30; i++) {
      screen = await page.evaluate(() => {
        const on = (id) => !!document.getElementById(id)?.classList.contains('active');
        if (on('dashboard')) return 'dashboard';
        if (on('room-selector')) return 'room-selector';
        const si = document.getElementById('si-email');
        if (si && si.offsetParent !== null) return 'sign-in';
        return 'loading';
      });
      if (screen !== 'loading') break;
      await waitMs(500);
    }
    await shot(page, '11-after-kill9-relaunch');
    if (screen === 'room-selector') {
      await page.locator('.rs-room-btn').first().click();
      await page.waitForFunction(() => !!document.getElementById('dashboard')?.classList.contains('active'), { timeout: 30000 }).catch(() => {});
      await page.evaluate(() => { try { if (typeof dismissFirstLaunch === 'function') dismissFirstLaunch(); } catch (_) {} });
    }
    const onDash = await page.evaluate(() => !!document.getElementById('dashboard')?.classList.contains('active'));
    const cfgAfterRoom = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const equipmentKept = cfgAfterRoom.atemIp === creds.atemHost;
    record('config_persist_kill9', (cfgOk && screen !== 'sign-in' && onDash && equipmentKept) ? 'PASS' : 'FAIL',
      `marker before=${before.liveStreamUrl === want} after=${after.liveStreamUrl === want} atemIp=${after.atemIp} token=${!!after.token} relaunchScreen=${screen} dashboardAfterRoomPick=${onDash} atemIpAfterRoomPick=${cfgAfterRoom.atemIp}`);
  } catch (e) {
    record('config_persist_kill9', 'FAIL', String(e.message || e));
  }

  // After kill -9 relaunch: start monitoring from persisted config only (no re-entry)
  try {
    await page.evaluate(async () => { await window.electronAPI.startAgent(); });
    const t0 = Date.now();
    const up = await waitAtemConnected(page, true, 50000);
    const atemMs = Date.now() - t0;
    let st = up.status;
    let relayUp = false;
    for (let i = 0; i < 60; i++) {
      st = await page.evaluate(async () => window.electronAPI.getStatus());
      relayUp = st?.relay === true || st?.relay?.connected === true;
      if (relayUp) break;
      await waitMs(500);
    }
    const relayMs = Date.now() - t0;
    const pv = await waitPgmPvw(page, 5, 3, 20000);
    await shot(page, '11b-after-kill9-monitoring');
    record('restart_after_kill9_reconnect', (up.ok && relayUp && pv.ok) ? 'PASS' : 'FAIL',
      `atem=${up.ok}@${atemMs}ms relay=${relayUp}@${relayMs}ms pgm="${pv.pgm}" pvw="${pv.pvw}"`);
  } catch (e) {
    record('restart_after_kill9_reconnect', 'FAIL', String(e.message || e));
  }

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
