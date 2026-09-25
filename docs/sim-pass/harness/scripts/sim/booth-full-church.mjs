#!/usr/bin/env node
/**
 * Full-church: every CORE device the booth can monitor at the same time,
 * then crash/unplug them together, drop the relay, and kill -9 the app.
 * Local lab only (relay :3400, MockLab ATEM :9910). Never production.
 *
 * The booth has one mixer slot, so X32 stands in for the console. SQ, dLive,
 * and Yamaha are CORE too, but they cannot be configured beside X32; their
 * own booth scripts cover them.
 *
 * Pass A/B: TALLY_RUN_ID=fullchurch-src-A  (and appimage/deb).
 */
import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const x32Mock = require('/workspace/tally/church-client/test/mocks/x32Server.js');
const obsMock = require('/workspace/tally/church-client/test/mocks/obsServer.js');
const ppMock = require('/workspace/tally/church-client/test/mocks/propresenterServer.js');

let app = null;
let page = null;
let x32 = null;
let obs = null;
let pp = null;
let mocklabStopped = false;

function pidOf(pattern) {
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(pattern)} || true`, { encoding: 'utf8' });
    const n = Number((out.trim().split('\n')[0] || '').trim());
    return n || null;
  } catch { return null; }
}
/** PID listening on a TCP port, from /proc (ss is not installed on this VM). */
function pidListening(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  let inode = null;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 10) continue;
      if (p[3] === '0A' && p[1].endsWith(':' + hex)) { inode = p[9]; break; }
    }
    if (inode) break;
  }
  if (!inode) return null;
  for (const dir of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(dir)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${dir}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${dir}/fd/${fd}`) === `socket:[${inode}]`) return Number(dir);
      } catch { /* */ }
    }
  }
  return null;
}
function signal(pid, sig) {
  if (!pid) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
}

async function snap() {
  return page.evaluate(async () => {
    const st = await window.electronAPI.getStatus();
    const text = (id) => (document.getElementById(id)?.textContent || '').trim();
    const on = (id) => !!document.getElementById(id)?.classList.contains('active');
    const banner = document.getElementById('offline-banner');
    const dot = (sel) => document.querySelector(sel)?.className || '';
    const connected = (v) => v === true || (v && typeof v === 'object' && v.connected === true);
    return {
      screen: on('dashboard') ? 'dashboard' : on('room-selector') ? 'room-selector' : on('sign-in') ? 'sign-in' : 'other',
      hero: text('cr-hero-headline'),
      banner: !!banner && getComputedStyle(banner).display !== 'none',
      bannerText: text('offline-banner-text'),
      atem: connected(st?.atem),
      relay: connected(st?.relay),
      obs: connected(st?.obs) || connected(st?.encoder),
      mixer: connected(st?.audio) || connected(st?.mixer),
      pp: connected(st?.proPresenter),
      atemDot: document.getElementById('dot-atem')?.className || '',
      mixerDot: dot('#simple-device-list .simple-device-item[data-status-key="mixer"] .device-dot'),
      ppDot: dot('#simple-device-list .simple-device-item[data-status-key="proPresenter"] .device-dot'),
      enc: text('cr-encoder-status'),
      audio: text('cr-card-audio') ? (document.querySelector('#cr-card-audio .cr-card-value')?.textContent || '').trim() : '',
      ppCard: (document.querySelector('#cr-card-propresenter .cr-card-value')?.textContent || '').trim(),
    };
  });
}

async function until(pred, timeoutMs) {
  const t0 = Date.now();
  let s = null;
  while (Date.now() - t0 < timeoutMs) {
    s = await snap().catch(() => null);
    if (s && pred(s)) return { ok: true, ms: Date.now() - t0, s };
    await L.waitMs(400);
  }
  return { ok: false, ms: Date.now() - t0, s };
}

function startMocklab() {
  const log = fs.openSync('/workspace/tally-linux/logs/mocklab.log', 'a');
  const child = spawn('node', ['/workspace/tally-linux/sims/start-mocklab.js'], { detached: true, stdio: ['ignore', log, log] });
  child.unref();
}
async function restoreLab() {
  if (!pidOf('sims/start-mocklab.js')) startMocklab();
  else if (mocklabStopped) signal(pidOf('sims/start-mocklab.js'), 'SIGCONT');
  mocklabStopped = false;
  try { execSync('bash /workspace/tally-linux/scripts/restart-relay.sh', { stdio: 'ignore', timeout: 25000 }); } catch { /* */ }
}

async function main() {
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  x32 = await x32Mock.start({ model: 'X32' });
  obs = await obsMock.start({ port: 0, password: 'booth-pw' });
  pp = await ppMock.start({ port: 41025, controlPort: 0 });
  const obsPort = obs.port;
  const x32Port = x32.port;
  const ppPort = pp.port;
  console.log(`full-church mocks x32=${x32Port} obs=${obsPort} pp=${ppPort} atem=127.0.0.1:9910`);

  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  await page.evaluate(async ({ x32Port, obsPort, ppPort }) => {
    await window.electronAPI.saveEquipment({
      atemIp: '127.0.0.1',
      atems: [{ ip: '127.0.0.1', role: 'primary', name: 'Sanctuary' }],
      encoderType: 'obs',
      encoderHost: '127.0.0.1',
      encoderPort: obsPort,
      encoderPassword: 'booth-pw',
      obsUrl: `ws://127.0.0.1:${obsPort}`,
      obsPassword: 'booth-pw',
      encoders: [{ encoderType: 'obs', host: '127.0.0.1', port: String(obsPort), password: 'booth-pw' }],
      mixerType: 'x32',
      mixerHost: '127.0.0.1',
      mixerPort: x32Port,
      proPresenterHost: '127.0.0.1',
      proPresenterPort: ppPort,
    });
    await window.electronAPI.saveConfig({ setupComplete: true, atemIp: '127.0.0.1' });
    try { await window.electronAPI.stopAgent(); } catch { /* */ }
    await window.electronAPI.startAgent();
  }, { x32Port, obsPort, ppPort });

  const up = await until((s) => s.screen === 'dashboard' && s.atem && s.relay && s.obs && s.mixer && s.pp, 45000);
  L.record('full_church_all_core_online', up.ok ? 'PASS' : 'FAIL', JSON.stringify(up.s));
  await L.shot(page, 'full-01-online');

  // Unplug / crash every device together, and take the relay down.
  x32.setReachable(false);
  try { obs.crash(); } catch { /* */ }
  try { await obs.stop(); } catch { /* */ }
  obs = null;
  try { await pp.stop(); } catch { /* */ }
  pp = null;
  const ml = pidOf('sims/start-mocklab.js');
  // Kill MockLab (ATEM). A frozen process still looks connected; a dead UDP port does not.
  mocklabStopped = !!(ml && signal(ml, 'SIGKILL'));
  const relay = pidListening(3400);
  console.log(`crash-all mocklab=${ml} killed=${mocklabStopped} relay=${relay}`);
  if (relay) { try { process.kill(relay, 'SIGTERM'); } catch { /* */ } }

  // The visible booth must say the devices are down and the relay is unreachable.
  // status.relay can stay true while a half-open agent socket lingers; the banner is the honest surface.
  const down = await until((s) => s.atem === false && s.obs !== true && s.mixer === false && s.pp === false
    && s.banner && /unreachable|offline/i.test(s.bannerText) && !/nominal/i.test(s.hero), 45000);
  L.record('crash_unplug_all_honest', down.ok ? 'PASS' : 'FAIL', JSON.stringify(down.s));
  await L.shot(page, 'full-02-all-down');

  // Bring the lab back. The booth must recover with no clicks.
  if (mocklabStopped || !pidOf('sims/start-mocklab.js')) {
    startMocklab();
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch('http://127.0.0.1:9911/api/state', { signal: AbortSignal.timeout(1000) }); if (r.ok) break; } catch { /* */ }
      await L.waitMs(250);
    }
  }
  mocklabStopped = false;
  await L.waitMs(500);
  try { execSync('bash /workspace/tally-linux/scripts/restart-relay.sh', { stdio: 'ignore', timeout: 25000 }); } catch { /* */ }
  x32.setReachable(true);
  obs = await obsMock.start({ port: obsPort, password: 'booth-pw' });
  pp = await ppMock.start({ port: ppPort, controlPort: 0 });

  const back = await until((s) => s.atem && s.obs && s.mixer && s.pp && !s.banner && /nominal/i.test(s.hero), 60000);
  L.record('crash_unplug_all_recovers', back.ok ? 'PASS' : 'FAIL', JSON.stringify(back.s));
  await L.shot(page, 'full-03-recovered');

  // kill -9, relaunch, auto-rejoin, devices come back without a room click.
  const pid = app.process().pid;
  try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  try { execSync(`pkill -9 -P ${pid} 2>/dev/null || true`); } catch { /* */ }
  app = null;
  await L.waitMs(1500);
  ({ app, page } = await L.launchApp());
  const rejoined = await until((s) => s.screen === 'dashboard' && s.atem && s.relay && s.obs && s.mixer && s.pp, 50000);
  L.record('kill9_rejoin_full_church', rejoined.ok ? 'PASS' : 'FAIL', JSON.stringify(rejoined.s));
  await L.shot(page, 'full-04-rejoin');
}

main()
  .catch(async (e) => {
    if (!L.results.some((r) => r.name === 'full_church_all_core_online')) {
      L.record('full_church_all_core_online', 'FAIL', String(e && e.stack || e));
    } else {
      L.record('full_church_threw', 'FAIL', String(e && e.message || e));
    }
  })
  .finally(async () => {
    await restoreLab();
    try { if (x32) await x32.stop(); } catch { /* */ }
    try { if (obs) await obs.stop(); } catch { /* */ }
    try { if (pp) await pp.stop(); } catch { /* */ }
    try { if (app) await app.close(); } catch { /* */ }
    const failed = L.results.some((r) => r.status !== 'PASS') || L.results.length < 4;
    L.finish(failed ? 1 : 0);
  });
