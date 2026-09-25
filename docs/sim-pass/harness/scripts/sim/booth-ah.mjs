#!/usr/bin/env node
/**
 * SIM PASS — Allen & Heath dLive / Avantis booth UI e2e + remote-engineer commands.
 * AH_MODEL=dlive (default) | avantis.
 * Real Electron app + real agent + stateful dLive/Avantis MIDI-over-TCP mock (silent
 * SETs, dLive answers Gets, Avantis answers only name requests, wrong base MIDI
 * channel ignored, unplug = half-open silent socket).
 * The mock console's base MIDI channel is 3: with the booth's default (12) the
 * console must read OFFLINE; after choosing "MIDI ch 3" in the UI it comes online.
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
const ahMock = require('/workspace/tally/church-client/test/mocks/ahMidiServer.js');
const KIND = (process.env.AH_MODEL || 'dlive').toLowerCase() === 'avantis' ? 'avantis' : 'dlive';
const BRAND = KIND === 'dlive' ? 'dLive' : 'Avantis';
const P = `ah-${KIND}`;
const WIN = 7500;
// AH_BOOTH_LEGACY=1: red-proof mode for old builds whose driver ignored the MIDI
// selector — console on the factory base channel 12, skip the wrong-channel step.
const LEGACY = process.env.AH_BOOTH_LEGACY === '1';
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

async function configureMixerViaUI(port, midiCh) {
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
  await page.fill('#equip-catalog input[data-field="port"][data-device="mixer"]', LEGACY ? '' : String(port));
  const chSel = page.locator('#equip-catalog select[data-field="midiChannel"][data-device="mixer"]').first();
  if (!(await chSel.count())) {
    if (!LEGACY) throw new Error(`no MIDI channel selector for Allen & Heath ${BRAND}`);
  } else await chSel.selectOption(midiCh ? String(midiCh) : '');
  await L.shot(page, `${P}-ui-form-ch${midiCh || 'default'}`);
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
  // Legacy red mode: old builds always used base channel 12 on 51325.
  mock = await ahMock.start({ port: LEGACY ? 51325 : 0, model: BRAND });
  if (!LEGACY) mock.setBaseChannel(2); // console base MIDI channel 3
  mock.storeScene(4, 'Sunday');
  console.log(`${BRAND} mock tcp 127.0.0.1:${mock.port} (base MIDI ch ${LEGACY ? 12 : 3})`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard();

  // 1) Default base channel (12) → console ignores Tally → booth must say OFFLINE (never "online")
  if (!LEGACY) {
    await configureMixerViaUI(mock.port, null);
    let sawOnline = false;
    const wrongCh = await until((s) => { if (/console online/i.test(s.cardValue)) sawOnline = true; return s.cardStatus === 'error' && /offline/i.test(s.cardValue) && /device-dot error/.test(s.mixerDot); }, 20000);
    await until(() => false, 12000, (s) => { if (/console online/i.test(s.cardValue)) sawOnline = true; });
    L.record('wrong_midi_channel_reads_offline', wrongCh.ok && !sawOnline ? 'PASS' : 'FAIL', `${wrongCh.ms}ms sawOnline=${sawOnline} ${JSON.stringify(wrongCh.s)}`);
    await L.shot(page, `${P}-00-wrong-channel`);
  }

  // 2) Choose MIDI ch 3 in the UI → online, dot ok, config holds 0-based 2, readable name
  const tCfg = Date.now();
  await configureMixerViaUI(mock.port, LEGACY ? null : 3);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  const up = await until((s) => s.cardStatus === 'ok' && /console online/i.test(s.cardValue) && /device-dot ok/.test(s.mixerDot), 30000);
  timings.onlineAfterSaveMs = Date.now() - tCfg;
  L.record('mixer_online_on_screen', up.ok && cfg.mixer?.midiChannel === (LEGACY ? undefined : 2) && cfg.mixer?.type === KIND ? 'PASS' : 'FAIL', `cfg.mixer=${JSON.stringify(cfg.mixer)} ${JSON.stringify(up.s)}`);
  L.record('device_list_name_readable', new RegExp(`Allen & Heath ${BRAND} Console`).test(up.s?.mixerRowText || '') && !/DLIVE|AVANTIS/.test(up.s?.mixerRowText || '') ? 'PASS' : 'FAIL', up.s?.mixerRowText || '');
  await L.shot(page, `${P}-01-online`);

  // 3) Main 1 muted on the console surface → MUTED card, hero issue, warning dot
  mock.surfaceSet('mute:main:0', 1);
  const mu = await until((s) => s.cardStatus === 'error' && /muted/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot warning/.test(s.mixerDot), 15000);
  timings.muteMs = mu.ms;
  L.record('master_mute_honest', mu.ok && mu.ms <= WIN ? 'PASS' : 'FAIL', `${mu.ms}ms ${JSON.stringify(mu.s)}`);
  await L.shot(page, `${P}-02-muted`);
  mock.surfaceSet('mute:main:0', 0);
  const um = await until((s) => s.cardStatus === 'ok' && !/issue/i.test(s.hero), 15000);
  L.record('master_unmute_clears', um.ok ? 'PASS' : 'FAIL', `${um.ms}ms ${JSON.stringify(um.s)}`);

  // 4) Local command path (booth app) — real result or real refusal
  const r = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.mute', { channel: 3 }));
  await L.waitMs(200);
  const bad = await page.evaluate(async () => window.electronAPI.sendCommand('mixer.mute', { channel: 200 }));
  const okMsg = KIND === 'dlive' ? !/not confirmed/i.test(JSON.stringify(r)) : /not confirmed/i.test(JSON.stringify(r));
  L.record('booth_command_real_result', !r?.error && okMsg && mock.get('mute:input:2') === true && /invalid channel/i.test(bad?.error || '') && mock.get('mute:input:0') === false ? 'PASS' : 'FAIL',
    `mute→${JSON.stringify(r).slice(0, 140)} ch3=${mock.get('mute:input:2')}; ch200→${JSON.stringify(bad?.error || null).slice(0, 120)} ch1=${mock.get('mute:input:0')}`);

  // 5) Remote engineer through the LOCAL lab relay (wait:true → real outcome)
  const adm = labAdmin();
  const a1 = await adm.cmd('mixer.unmute', { channel: 3 });
  await L.waitMs(200);
  const a1ok = a1.status === 200 && a1.body.completed && mock.get('mute:input:2') === false
    && (KIND === 'dlive' ? !/not confirmed/i.test(JSON.stringify(a1.body)) : /not confirmed/i.test(JSON.stringify(a1.body)));
  const a2 = await adm.cmd('mixer.recallScene', { scene: 4 });
  const a3 = await adm.cmd('mixer.mute', { channel: 200 });
  const a4 = await adm.cmd('mixer.setPan', { channel: 1, pan: -0.5 });
  const a5 = await adm.cmd('mixer.setChannelName', { channel: 1, name: 'Pastor' });
  const a6 = await adm.cmd('mixer.setHpf', { channel: 1, frequency: 100 });
  const hpfOk = KIND === 'dlive' ? a6.status === 200 && mock.get('hpf:input:0').on === true : a6.status === 422;
  L.record('remote_commands_real_results',
    a1ok
      && a2.status === 200 && /not confirmed/i.test(JSON.stringify(a2.body)) && mock.state.currentScene === 4
      && a3.status === 422 && mock.get('mute:input:0') === false
      && a4.status === 422 && mock.get('mainAssign:input:0') === true
      && a5.status === 200 && mock.get('name:input:0') === 'Pastor' && hpfOk ? 'PASS' : 'FAIL',
    `church=${adm.churchId} unmute=${a1.status}:${JSON.stringify(a1.body.result || a1.body).slice(0, 90)} scene4=${a2.status}:${JSON.stringify(a2.body.result || a2.body).slice(0, 110)} cur=${mock.state.currentScene} ch200=${a3.status}:${a3.body.error} pan=${a4.status}:${a4.body.error} rename=${a5.status}:${mock.get('name:input:0')} hpf=${a6.status}:${JSON.stringify(a6.body.result || a6.body.error).slice(0, 90)}`);

  // 6) Unplug (half-open socket) → offline card, hero issue, error dot; no flap
  mock.setReachable(false);
  const off = await until((s) => s.cardStatus === 'error' && /offline/i.test(s.cardValue) && /issue/i.test(s.hero) && /device-dot error/.test(s.mixerDot), 20000);
  timings.offlineMs = off.ms;
  L.record('console_unplug_honest', off.ok && off.ms <= WIN ? 'PASS' : 'FAIL', `${off.ms}ms ${JSON.stringify(off.s)}`);
  await L.shot(page, `${P}-03-offline`);
  const before = mock.get('mute:input:0');
  const rOff = await adm.cmd('mixer.mute', { channel: 1 });
  L.record('remote_command_console_offline_fails', rOff.status === 422 && /not connected|did not confirm|not answering/i.test(rOff.body.error || '') && mock.get('mute:input:0') === before ? 'PASS' : 'FAIL', `${rOff.status} ${JSON.stringify(rOff.body).slice(0, 160)}`);
  let flap = false;
  await until(() => false, 10000, (s) => { if (s.cardStatus === 'ok' || /nominal/i.test(s.hero)) flap = true; });
  L.record('console_stays_offline_no_flap', !flap ? 'PASS' : 'FAIL', `flapped=${flap}`);

  // 7) Replug → recovers
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
