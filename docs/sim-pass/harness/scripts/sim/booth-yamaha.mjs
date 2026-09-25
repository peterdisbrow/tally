#!/usr/bin/env node
/**
 * SIM PASS — Yamaha CL / QL / TF booth UI e2e + remote-engineer commands.
 * Real Electron app + real agent + stateful Yamaha RCP mock on TCP 49280 (OK/ERROR
 * per line, get read-back, NOTIFY to other clients, empty scenes refused, out-of-range
 * → ERROR, unplug = half-open silent socket). The mixer is added in the UI with the
 * port left blank (the default must be 49280 — nothing listens on the old 8765).
 * Remote path: LOCAL lab relay :3400 /api/command {wait:true} → agent → console.
 *
 * Stated windows:
 *   MUTE_MS     master muted at console → card "MUTED", hero issue, dot warning   ≤ 7 500 ms
 *   OFFLINE_MS  console unplugged → card "Console offline", hero issue, dot error ≤ 7 500 ms
 *   RECOVER_MS  console back → card "Console online", dot ok                        ≤ 7 500 ms
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const yMock = require('/workspace/tally/church-client/test/mocks/yamahaRcpServer.js');
const MODEL = (process.env.YAMAHA_MODEL || 'CL5').toUpperCase();
const KIND = 'yamaha';
const P = `yamaha-${MODEL.toLowerCase()}`;
const WIN = 7500;
const timings = {};
let app = null, page = null, mock = null;

async function screen(p) {
  return p.evaluate(() => {
    const card = document.getElementById('cr-card-audio');
    const row = document.querySelector('#simple-device-list .simple-device-item[data-status-key="mixer"] .device-dot');
    return {
      cardStatus: card?.dataset.status || '',
      cardValue: (card?.querySelector('.cr-card-value')?.textContent || '').trim(),
      cardDetail: (card?.querySelector('.cr-card-detail')?.textContent || '').trim(),
      hero: (document.getElementById('cr-hero-headline')?.textContent || '').trim(),
      mixerDot: row ? row.className : '(no mixer row)',
      detailsAudio: (document.getElementById('val-audio')?.textContent || '').trim(),
      mixerRowText: (document.querySelector('#simple-device-list .simple-device-item[data-status-key="mixer"]')?.textContent || '').replace(/\s+/g, ' ').trim(),
      atemGreen: !!document.getElementById('dot-atem')?.classList.contains('green'),
    };
  });
}
async function until(pred, timeoutMs, watch) {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < timeoutMs) {
    s = await screen(page); if (watch) watch(s);
    if (pred(s)) return { ok: true, ms: Date.now() - t0, s };
    await L.waitMs(250);
  }
  return { ok: false, ms: Date.now() - t0, s };
}
async function toDashboard() { await page.evaluate(() => { try { switchTab('dashboard'); } catch (_) {} }); await L.waitMs(300); }

async function configureMixerViaUI(port) {
  await page.evaluate(() => switchTab('devices'));
  await L.waitMs(500);
  const adv = page.locator('a:has-text("Switch to Advanced")').first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await L.waitMs(400); }
  let typeSel = page.locator('#equip-catalog select[data-field="type"][data-device="mixer"]').first();
  if (!(await typeSel.count())) {
    await page.locator('#equip-catalog .equip-catalog-entry', { hasText: 'Audio Mixer' }).locator('.btn-add').first().click();
    await L.waitMs(500);
    typeSel = page.locator('#equip-catalog select[data-field="type"][data-device="mixer"]').first();
  }
  await typeSel.selectOption(KIND);
  await L.waitMs(400);
  await page.fill('#equip-catalog input[data-field="host"][data-device="mixer"]', '127.0.0.1');
  await page.fill('#equip-catalog input[data-field="port"][data-device="mixer"]', port ? String(port) : '');
  await L.shot(page, `${P}-ui-form`);
  await page.click('#btn-save-equip');
  const ok = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  try { await ok.waitFor({ state: 'visible', timeout: 5000 }); await ok.click(); } catch (_) { /* not running */ }
  await L.waitMs(2500);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  console.log(`[save] cfg.mixer=${JSON.stringify(cfg.mixer || null)}`);
  await toDashboard();
}

function labAdmin() {
  const key = (fs.readFileSync(path.join(L.ROOT, 'data/relay.env'), 'utf8').match(/^ADMIN_API_KEY=(.*)$/m) || [])[1];
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  let churchId = cfg.churchId || cfg.rejoinRoom?.churchId;
  if (!churchId && cfg.token) { try { churchId = JSON.parse(Buffer.from(cfg.token.split('.')[1], 'base64url').toString()).churchId; } catch (_) {} }
  return {
    churchId,
    cmd: async (command, params) => {
      const r = await fetch(`${L.creds.relayHttp}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ churchId, command, params, wait: true }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}

async function main() {
  mock = await yMock.start({ port: 49280, model: MODEL });
  mock.storeScene(4, 'Sunday', { 'on:input:9': 0 });
  console.log(`Yamaha ${MODEL} mock rcp 127.0.0.1:${mock.port}`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard();

  // 1) Add the Yamaha in the UI, port blank → default must reach RCP 49280 → online
  const tCfg = Date.now();
  await configureMixerViaUI(null);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  const up = await until((s) => s.cardStatus === 'ok' && /console online/i.test(s.cardValue) && /device-dot ok/.test(s.mixerDot), 30000);
  timings.onlineAfterSaveMs = Date.now() - tCfg;
  L.record('mixer_online_on_screen', up.ok && cfg.mixer?.type === KIND && mock.state.clientsConnected > 0 ? 'PASS' : 'FAIL', `cfg.mixer=${JSON.stringify(cfg.mixer)} clients=${mock.state.clientsConnected} ${JSON.stringify(up.s)}`);
  L.record('device_list_name_readable', /Yamaha/.test(up.s?.mixerRowText || '') && !/YAMAHA/.test(up.s?.mixerRowText || '') ? 'PASS' : 'FAIL', up.s?.mixerRowText || '');
  await L.shot(page, `${P}-01-online`);

  // 2) Stereo master turned OFF on the console surface → MUTED card, hero issue, warning dot
  mock.surfaceSet('on:st:0', 0);
  const mu = await until((s) => s.cardStatus === 'error' && /muted/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot warning/.test(s.mixerDot), 15000);
  timings.muteMs = mu.ms;
  L.record('master_mute_honest', mu.ok && mu.ms <= WIN ? 'PASS' : 'FAIL', `${mu.ms}ms ${JSON.stringify(mu.s)}`);
  await L.shot(page, `${P}-02-muted`);
  mock.surfaceSet('on:st:0', 1);
  const um = await until((s) => s.cardStatus === 'ok' && !/issue/i.test(s.hero), 15000);
  L.record('master_unmute_clears', um.ok ? 'PASS' : 'FAIL', `${um.ms}ms ${JSON.stringify(um.s)}`);

  // 3) Local command path (booth app) — confirmed result or real refusal
  const r = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.mute', { channel: 3 }));
  await L.waitMs(200);
  const bad = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.mute', { channel: 200 }));
  L.record('booth_command_real_result', !r?.error && !/not confirmed/i.test(JSON.stringify(r)) && mock.get('on:input:2') === 0 && /invalid channel/i.test(bad?.error || '') && mock.get('on:input:0') === 1 ? 'PASS' : 'FAIL',
    `mute→${JSON.stringify(r).slice(0, 140)} ch3.on=${mock.get('on:input:2')}; ch200→${JSON.stringify(bad?.error || null).slice(0, 120)} ch1.on=${mock.get('on:input:0')}`);

  // 4) Remote engineer through the LOCAL lab relay (wait:true → real outcome)
  const adm = labAdmin();
  const a1 = await adm.cmd('mixer.unmute', { channel: 3 });
  await L.waitMs(200);
  const a2 = await adm.cmd('mixer.recallScene', { scene: 4 });
  const a3 = await adm.cmd('mixer.recallScene', { scene: 250 });
  const a4 = await adm.cmd('mixer.setPan', { channel: 1, pan: -0.5 });
  const a5 = await adm.cmd('mixer.setChannelName', { channel: 1, name: 'Pastor' });
  const a6 = await adm.cmd('mixer.setHpf', { channel: 1, frequency: 100 });
  const a7 = await adm.cmd('mixer.muteDca', { dca: 2 });
  const a8 = await adm.cmd('mixer.mute', { channel: 200 });
  L.record('remote_commands_real_results',
    a1.status === 200 && a1.body.completed && mock.get('on:input:2') === 1
      && a2.status === 200 && !/not confirmed/i.test(JSON.stringify(a2.body)) && mock.state.currentScene === (/^TF/.test(MODEL) ? 'scene_a:4' : 4) && mock.get('on:input:9') === 0
      && a3.status === 422 && /refused|not recalled|invalid scene/i.test(a3.body.error || '')
      && a4.status === 200 && mock.get('pan:input:0') === -32
      && a5.status === 200 && mock.get('name:input:0') === 'Pastor'
      && a6.status === 422
      && a7.status === 200 && mock.get('on:dca:1') === 0
      && a8.status === 422 && mock.get('on:input:0') === 1 ? 'PASS' : 'FAIL',
    `church=${adm.churchId} unmute=${a1.status}:${JSON.stringify(a1.body.result || a1.body).slice(0, 90)} scene4=${a2.status}:${JSON.stringify(a2.body.result || a2.body).slice(0, 110)} cur=${mock.state.currentScene} scene250=${a3.status}:${a3.body.error} pan=${a4.status}:${mock.get('pan:input:0')} rename=${a5.status}:${mock.get('name:input:0')} hpf=${a6.status}:${JSON.stringify(a6.body.error).slice(0, 90)} dca2=${a7.status}:${mock.get('on:dca:1')} ch200=${a8.status}:${a8.body.error}`);

  // 5) Unplug (half-open socket) → offline card, hero issue, error dot; no flap
  mock.setReachable(false);
  const off = await until((s) => s.cardStatus === 'error' && /offline/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot error/.test(s.mixerDot), 20000);
  timings.offlineMs = off.ms;
  L.record('console_unplug_honest', off.ok && off.ms <= WIN ? 'PASS' : 'FAIL', `${off.ms}ms ${JSON.stringify(off.s)}`);
  await L.shot(page, `${P}-03-offline`);
  const before = mock.get('on:input:0');
  const rOff = await adm.cmd('mixer.mute', { channel: 1 });
  L.record('remote_command_console_offline_fails', rOff.status === 422 && /not connected|did not confirm|not answering/i.test(rOff.body.error || '') && mock.get('on:input:0') === before ? 'PASS' : 'FAIL', `${rOff.status} ${JSON.stringify(rOff.body).slice(0, 160)}`);
  let flap = false;
  await until(() => false, 10000, (s) => { if (s.cardStatus === 'ok' || /nominal/i.test(s.hero)) flap = true; });
  L.record('console_stays_offline_no_flap', !flap ? 'PASS' : 'FAIL', `flapped=${flap}`);

  // 6) Replug → recovers
  mock.setReachable(true);
  const back = await until((s) => s.cardStatus === 'ok' && /console online/i.test(s.cardValue) && /device-dot ok/.test(s.mixerDot), 20000);
  timings.recoverMs = back.ms;
  L.record('console_replug_recovers', back.ok && back.ms <= WIN ? 'PASS' : 'FAIL', `${back.ms}ms ${JSON.stringify(back.s)}`);
  await L.shot(page, `${P}-04-recovered`);

  const s = await screen(page);
  L.record('atem_unaffected', s.atemGreen ? 'PASS' : 'FAIL', `atem=${s.atemGreen}`);
}

main()
  .catch(async (e) => { L.record('fatal', 'FAIL', String(e?.stack || e).slice(0, 800)); try { if (page) await L.shot(page, `${P}-fatal`); } catch (_) {} })
  .finally(async () => {
    fs.writeFileSync(path.join(L.OUT, `${P}-timings.json`), JSON.stringify(timings, null, 2));
    try { await L.closeApp(app); } catch (_) {}
    try { if (mock) await mock.stop(); } catch (_) {}
    const failed = L.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${L.results.length - failed}/${L.results.length} PASS  timings=${JSON.stringify(timings)}`);
    L.finish(failed ? 1 : 0);
  });
