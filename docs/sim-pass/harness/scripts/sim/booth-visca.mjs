#!/usr/bin/env node
/**
 * SIM PASS — VISCA PTZ booth UI e2e (source or packaged via TALLY_PACKAGED_BIN).
 * Real Electron app + real agent + stateful VISCA camera mocks (TCP + Sony UDP).
 * Everything asserted is read from the SCREEN (dashboard PTZ card, hero, Devices dots,
 * Equipment Test result). Lab only: local relay :3400 + MockLab ATEM :9910.
 *
 * Windows (booth promise):
 *   TCP_DROP_MS     camera drops TCP → card shows it offline         ≤ 5 000 ms
 *   SILENT_DROP_MS  UDP camera goes silent → offline                 ≤ 12 000 ms
 *   RECOVER_MS      camera back → card online                        ≤ 12 000 ms
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const visca = require('/workspace/tally/church-client/test/mocks/viscaPtzServer.js');
const TCP_DROP_MS = 5000, SILENT_DROP_MS = 12000, RECOVER_MS = 12000;
const timings = {};
let app = null, page = null;
const mocks = [];

async function screen(p) {
  return p.evaluate(() => {
    const card = document.getElementById('cr-card-ptz');
    const dot = (k) => document.querySelector(`.simple-device-item[data-status-key="${k}"] .device-dot`)?.className || '';
    return {
      cardVisible: !!card && getComputedStyle(card).display !== 'none',
      cardState: card?.dataset.status || '',
      value: (document.getElementById('cr-ptz-status')?.textContent || '').trim(),
      detail: (document.getElementById('cr-ptz-detail')?.textContent || '').trim(),
      hero: (document.getElementById('cr-hero-headline')?.textContent || '').trim(),
      dot0: dot('ptz:0'), dot1: dot('ptz:1'), dotAtem: dot('atem'),
      atemGreen: !!document.getElementById('dot-atem')?.classList.contains('green'),
    };
  });
}
async function toDashboard(p) { await p.evaluate(() => { try { switchTab('dashboard'); } catch (_) {} }); await L.waitMs(300); }
async function until(pred, timeoutMs, watch) {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < timeoutMs) {
    s = await screen(page);
    if (watch) watch(s);
    if (pred(s)) return { ok: true, ms: Date.now() - t0, s };
    await L.waitMs(250);
  }
  return { ok: false, ms: Date.now() - t0, s };
}

async function openPtzEditor() {
  await page.evaluate(() => switchTab('devices'));
  await L.waitMs(500);
  const adv = page.locator('a:has-text("Switch to Advanced")').first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await L.waitMs(400); }
  if (!(await page.locator('#equip-catalog input[data-field="ip"][data-device="ptz"]').count())) {
    await page.locator('#equip-catalog .equip-catalog-entry', { hasText: 'PTZ Camera' }).locator('.btn-add').first().click();
    await L.waitMs(500);
  }
}
async function fillPtz(idx, { ip, name, protocol, port }) {
  while ((await page.locator(`#equip-catalog input[data-field="ip"][data-device="ptz"][data-idx="${idx}"]`).count()) === 0) {
    await page.locator('#equip-catalog button.btn-add', { hasText: 'Add PTZ Camera' }).first().click();
    await L.waitMs(400);
  }
  const sel = (f) => `#equip-catalog [data-field="${f}"][data-device="ptz"][data-idx="${idx}"]`;
  await page.fill(sel('ip'), ip);
  await page.fill(sel('name'), name);
  await page.selectOption(sel('protocol'), protocol);
  await page.fill(sel('port'), String(port));
}
async function testButton(idx) {
  const row = page.locator(`#equip-catalog input[data-field="ip"][data-device="ptz"][data-idx="${idx}"]`).locator('xpath=ancestor::*[contains(@class,"equip-")][1]');
  await row.locator('button.btn-test').first().click();
  const t0 = Date.now(); let txt = '';
  while (Date.now() - t0 < 8000) {
    txt = await page.evaluate((i) => (document.getElementById(`equip-ptz-detail-${i}`)?.textContent || '').trim(), idx);
    if (txt && !/Testing/.test(txt)) break;
    await L.waitMs(200);
  }
  const dotCls = await page.evaluate((i) => document.getElementById(`equip-dot-ptz-${i}`)?.className || '', idx);
  return { txt, dotCls };
}
async function save() {
  await page.click('#btn-save-equip');
  const ok = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  try { await ok.waitFor({ state: 'visible', timeout: 5000 }); await ok.click(); } catch (_) { /* not running */ }
  await L.waitMs(2500);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  console.log(`[save] cfg.ptz=${JSON.stringify(cfg.ptz || null).slice(0, 300)}`);
  await toDashboard(page);
}
const cmd = (c, p) => page.evaluate(async ([c2, p2]) => window.electronAPI.sendCommand(c2, p2), [c, p]);

async function main() {
  const fake = await visca.start({ transport: 'tcp', breakMode: 'no-reply' }); mocks.push(fake);
  const cam1 = await visca.start({ transport: 'tcp' }); mocks.push(cam1);
  const cam2 = await visca.start({ transport: 'sony' }); mocks.push(cam2);
  console.log(`mocks: fake(no-reply) tcp:${fake.port} cam1 tcp:${cam1.port} cam2 sony-udp:${cam2.port}`);

  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard(page);
  await L.waitMs(2000);
  let s = await screen(page);
  L.record('no_ptz_card_before_config', !s.cardVisible ? 'PASS' : 'FAIL', JSON.stringify(s));

  // 1) Equipment Test against an open port that is NOT a VISCA camera → must fail
  await openPtzEditor();
  await fillPtz(0, { ip: '127.0.0.1', name: 'Cam 1', protocol: 'visca-tcp', port: fake.port });
  const tFake = await testButton(0);
  await L.shot(page, 'visca-01-test-non-visca-port');
  L.record('equip_test_non_visca_port_fails', /no visca reply/i.test(tFake.txt) && !/green|ok|success/.test(tFake.dotCls) ? 'PASS' : 'FAIL',
    `detail="${tFake.txt}" dot="${tFake.dotCls}"`);

  // 2) Real cameras: Test passes and says the camera answered
  await fillPtz(0, { ip: '127.0.0.1', name: 'Cam 1', protocol: 'visca-tcp', port: cam1.port });
  const t1 = await testButton(0);
  await fillPtz(1, { ip: '127.0.0.1', name: 'Pulpit', protocol: 'sony-visca-udp', port: cam2.port });
  const t2 = await testButton(1);
  await L.shot(page, 'visca-02-test-real-cameras');
  L.record('equip_test_real_cameras_answer', /answered/i.test(t1.txt) && /answered/i.test(t2.txt) ? 'PASS' : 'FAIL', `cam1="${t1.txt}" pulpit="${t2.txt}"`);
  await save();

  // 3) Dashboard shows both cameras online; Devices dots green (from live status)
  const up = await until((x) => x.cardVisible && x.cardState === 'ok' && /2\/2 online/.test(x.value), 30000);
  timings.onlineAfterSaveMs = up.ms;
  L.record('ptz_card_online', up.ok ? 'PASS' : 'FAIL', `${up.ms}ms card="${up.s.value}" detail="${up.s.detail}" state=${up.s.cardState}`);
  const dotsOk = await until((x) => /\bok\b/.test(x.dot0) && /\bok\b/.test(x.dot1), 8000);
  L.record('device_dots_reflect_live_status', dotsOk.ok ? 'PASS' : 'FAIL', `dot0="${dotsOk.s.dot0}" dot1="${dotsOk.s.dot1}" atem="${dotsOk.s.dotAtem}"`);
  await L.shot(page, 'visca-03-online');

  // 4) Control: preset recall through the app's command path moves the real camera; errors come back
  cam1.state.pan = 500; cam1.state.tilt = 100;
  const st = await cmd('ptz.setPreset', { camera: 1, preset: 3, zeroBasedPreset: true });
  cam1.state.pan = -800; cam1.state.tilt = -50;
  const rc = await cmd('ptz.preset', { camera: 1, preset: 3, zeroBasedPreset: true });
  const moved = cam1.state.pan === 500 && cam1.state.tilt === 100 && cam1.state.lastPreset === 3;
  cam1.state.power = 'standby';
  const rs = await cmd('ptz.preset', { camera: 1, preset: 3, zeroBasedPreset: true });
  L.record('ptz_command_moves_camera_and_errors_surface', !st?.error && !rc?.error && moved && /not executable|standby/i.test(String(rs?.error || '')) ? 'PASS' : 'FAIL',
    `setPreset=${JSON.stringify(st).slice(0, 100)} recall=${JSON.stringify(rc).slice(0, 100)} moved=${moved} (pan=${cam1.state.pan}) standbyRecall=${JSON.stringify(rs).slice(0, 140)}`);

  // 5) Standby visible (warning, not green, not an outage)
  const sb = await until((x) => x.cardState === 'warning' && /standby/i.test(x.value + x.detail), 12000);
  L.record('ptz_standby_warning', sb.ok ? 'PASS' : 'FAIL', `${sb.ms}ms card="${sb.s.value}" detail="${sb.s.detail}" state=${sb.s.cardState}`);
  await L.shot(page, 'visca-04-standby');
  cam1.state.power = 'on';
  await until((x) => x.cardState === 'ok', 12000);

  // 6) Cam 1 unplugged (TCP drop) → offline on screen quickly, hero counts the issue, dot red
  const tDrop = Date.now();
  await cam1.setReachable(false);
  const down = await until((x) => x.cardState === 'error' && /1 of 2 offline/.test(x.value) && /Cam 1/.test(x.detail), 20000);
  timings.tcpDropMs = down.ms;
  L.record('ptz_unplug_offline_on_screen', down.ok && down.ms <= TCP_DROP_MS ? 'PASS' : 'FAIL',
    `${down.ms}ms (window ${TCP_DROP_MS}) card="${down.s.value}" detail="${down.s.detail}" hero="${down.s.hero}" dot0="${down.s.dot0}"`);
  L.record('ptz_offline_counts_as_issue', /issue/i.test(down.s.hero) && /\berror\b/.test(down.s.dot0) ? 'PASS' : 'FAIL', `hero="${down.s.hero}" dot0="${down.s.dot0}"`);
  await L.shot(page, 'visca-05-cam1-unplugged');
  let flapped = false;
  await until(() => false, 10000, (x) => { if (x.cardState === 'ok') flapped = true; });
  L.record('ptz_stays_down_while_unplugged', !flapped ? 'PASS' : 'FAIL', `10s watch flapped=${flapped}`);

  // 7) Replug → back online
  const tUp = Date.now();
  await cam1.setReachable(true);
  const back = await until((x) => x.cardState === 'ok' && /2\/2 online/.test(x.value), 30000);
  timings.recoverMs = back.ms;
  L.record('ptz_replug_recovers', back.ok && back.ms <= RECOVER_MS ? 'PASS' : 'FAIL', `${back.ms}ms (window ${RECOVER_MS}) card="${back.s.value}"`);
  await L.shot(page, 'visca-06-recovered');

  // 8) Sony camera dies silently (no packets back) → offline within window
  await cam2.setReachable(false);
  const silent = await until((x) => x.cardState === 'error' && /Pulpit/.test(x.detail), 30000);
  timings.silentDropMs = silent.ms;
  L.record('ptz_silent_udp_death_detected', silent.ok && silent.ms <= SILENT_DROP_MS ? 'PASS' : 'FAIL',
    `${silent.ms}ms (window ${SILENT_DROP_MS}) card="${silent.s.value}" detail="${silent.s.detail}"`);
  await L.shot(page, 'visca-07-sony-silent');
  await cam2.setReachable(true);
  const back2 = await until((x) => x.cardState === 'ok', 30000);
  L.record('ptz_sony_recovers', back2.ok ? 'PASS' : 'FAIL', `${back2.ms}ms`);

  s = await screen(page);
  L.record('atem_unaffected', s.atemGreen ? 'PASS' : 'FAIL', `atem=${s.atemGreen}`);
}

main()
  .catch(async (e) => { L.record('fatal', 'FAIL', String(e?.stack || e).slice(0, 800)); try { if (page) await L.shot(page, 'visca-fatal'); } catch (_) {} })
  .finally(async () => {
    fs.writeFileSync(path.join(L.OUT, 'visca-timings.json'), JSON.stringify(timings, null, 2));
    try { await L.closeApp(app); } catch (_) {}
    for (const m of mocks) { try { await m.stop(); } catch (_) {} }
    const failed = L.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${L.results.length - failed}/${L.results.length} PASS  timings=${JSON.stringify(timings)}`);
    L.finish(failed ? 1 : 0);
  });
