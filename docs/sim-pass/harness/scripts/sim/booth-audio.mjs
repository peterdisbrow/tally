#!/usr/bin/env node
/**
 * SIM PASS — Audio console (X32/M32) booth UI e2e + remote-engineer commands.
 * Real Electron app + real agent + stateful X32 OSC mock (silent SETs, echo GETs,
 * empty scenes refused, unplug = silence). Screen read passively.
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
const x32Mock = require('/workspace/tally/church-client/test/mocks/x32Server.js');
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
  await typeSel.selectOption('x32');
  await L.waitMs(400);
  await page.fill('#equip-catalog input[data-field="host"][data-device="mixer"]', '127.0.0.1');
  await page.fill('#equip-catalog input[data-field="port"][data-device="mixer"]', String(port));
  await L.shot(page, 'audio-ui-form');
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
  mock = await x32Mock.start({ model: 'X32' });
  mock.storeScene(4, 'Sunday');
  console.log(`X32 mock udp 127.0.0.1:${mock.port}`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard();

  // 1) Configure the console through the Equipment UI → online on screen, dot ok
  const tCfg = Date.now();
  await configureMixerViaUI(mock.port);
  const up = await until((s) => s.cardStatus === 'ok' && /console online/i.test(s.cardValue) && /device-dot ok/.test(s.mixerDot), 30000);
  timings.onlineAfterSaveMs = Date.now() - tCfg;
  L.record('mixer_online_on_screen', up.ok ? 'PASS' : 'FAIL', JSON.stringify(up.s));
  await L.shot(page, 'audio-01-online');

  // 2) Master muted at the console → MUTED card, hero issue, warning dot
  let t0 = Date.now(); mock.state.main.on = 0;
  const mu = await until((s) => s.cardStatus === 'error' && /muted/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot warning/.test(s.mixerDot), 15000);
  timings.muteMs = mu.ms;
  L.record('master_mute_honest', mu.ok && mu.ms <= WIN ? 'PASS' : 'FAIL', `${mu.ms}ms ${JSON.stringify(mu.s)}`);
  await L.shot(page, 'audio-02-muted');
  mock.state.main.on = 1;
  const um = await until((s) => s.cardStatus === 'ok' && !/issue/i.test(s.hero), 15000);
  L.record('master_unmute_clears', um.ok ? 'PASS' : 'FAIL', `${um.ms}ms ${JSON.stringify(um.s)}`);

  // 3) Local command path (booth app) — real result or real error
  const r = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.mute', { channel: 3 }));
  const bad = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.recallScene', { scene: 50 }));
  L.record('booth_command_real_result', !r?.error && mock.state.ch[3].on === 0 && !!bad?.error ? 'PASS' : 'FAIL',
    `mute→${JSON.stringify(r).slice(0, 100)} ch3.on=${mock.state.ch[3].on}; empty scene→${JSON.stringify(bad?.error || null).slice(0, 120)}`);

  // 4) Remote engineer through the LOCAL lab relay (wait:true → real outcome)
  const adm = labAdmin();
  const a1 = await adm.cmd('mixer.unmute', { channel: 3 });
  const a2 = await adm.cmd('mixer.recallScene', { scene: 4 });
  const a3 = await adm.cmd('mixer.recallScene', { scene: 51 });
  const a4 = await adm.cmd('mixer.pressSoftKey', { key: 1 });
  L.record('remote_commands_real_results',
    a1.status === 200 && a1.body.completed && mock.state.ch[3].on === 1 && a2.status === 200 && mock.state.current === 4
      && a3.status === 422 && /empty/i.test(a3.body.error || '') && a4.status === 422 ? 'PASS' : 'FAIL',
    `church=${adm.churchId} unmute=${a1.status}/${JSON.stringify(a1.body).slice(0, 80)} scene4=${a2.status} cur=${mock.state.current} empty=${a3.status}:${a3.body.error} softkey=${a4.status}:${a4.body.error}`);

  // 5) Unplug console → offline card, hero issue, error dot; no flap while gone
  t0 = Date.now(); mock.setReachable(false);
  const off = await until((s) => s.cardStatus === 'error' && /offline/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot error/.test(s.mixerDot), 20000);
  timings.offlineMs = off.ms;
  L.record('console_unplug_honest', off.ok && off.ms <= WIN ? 'PASS' : 'FAIL', `${off.ms}ms ${JSON.stringify(off.s)}`);
  await L.shot(page, 'audio-03-offline');
  const rOff = await adm.cmd('mixer.mute', { channel: 1 });
  L.record('remote_command_console_offline_fails', rOff.status === 422 && /not responding/i.test(rOff.body.error || '') ? 'PASS' : 'FAIL', `${rOff.status} ${JSON.stringify(rOff.body).slice(0, 160)}`);
  let flap = false;
  await until(() => false, 10000, (s) => { if (s.cardStatus === 'ok' || /nominal/i.test(s.hero)) flap = true; });
  L.record('console_stays_offline_no_flap', !flap ? 'PASS' : 'FAIL', `flapped=${flap}`);

  // 6) Replug → recovers
  t0 = Date.now(); mock.setReachable(true);
  const back = await until((s) => s.cardStatus === 'ok' && /console online/i.test(s.cardValue) && /device-dot ok/.test(s.mixerDot), 20000);
  timings.recoverMs = back.ms;
  L.record('console_replug_recovers', back.ok && back.ms <= WIN ? 'PASS' : 'FAIL', `${back.ms}ms ${JSON.stringify(back.s)}`);
  await L.shot(page, 'audio-04-recovered');

  const s = await screen(page);
  L.record('atem_unaffected', s.atemGreen ? 'PASS' : 'FAIL', `atem=${s.atemGreen}`);
}

main()
  .catch(async (e) => { L.record('fatal', 'FAIL', String(e?.stack || e).slice(0, 800)); try { if (page) await L.shot(page, 'audio-fatal'); } catch (_) {} })
  .finally(async () => {
    fs.writeFileSync(path.join(L.OUT, 'audio-timings.json'), JSON.stringify(timings, null, 2));
    try { await L.closeApp(app); } catch (_) {}
    try { if (mock) await mock.stop(); } catch (_) {}
    const failed = L.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${L.results.length - failed}/${L.results.length} PASS  timings=${JSON.stringify(timings)}`);
    L.finish(failed ? 1 : 0);
  });
