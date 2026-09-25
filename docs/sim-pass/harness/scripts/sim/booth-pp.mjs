#!/usr/bin/env node
/**
 * SIM PASS — ProPresenter booth UI e2e + remote-engineer commands.
 * Real Electron app + real agent + stateful ProPresenter 7 mock built from the official
 * OpenAPI spec (GET /version, slide_index, looks, timers, …; 404 for unknown ids;
 * offline = connections dropped; not-pp = a web server that isn't ProPresenter;
 * runtime break modes ignore-triggers / http-500).
 * Remote path: LOCAL lab relay :3400 /api/command {wait:true} → agent → ProPresenter.
 * Port 1025 is taken by MockLab's fake PP, so the mock runs on 41025 (entered in the UI).
 *
 * Stated windows:
 *   SLIDE_MS    operator changes slide → card shows it                    ≤ 5 000 ms
 *   OFFLINE_MS  ProPresenter quits → card "Disconnected", hero issue, dot error ≤ 10 000 ms
 *   RECOVER_MS  ProPresenter back → card ok                                 ≤ 15 000 ms
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const ppMock = require(process.env.PP_MOCK || '/workspace/tally/church-client/test/mocks/propresenterServer.js');
const PORT = Number(process.env.PP_PORT || 41025);
const P = 'pp';
const W = { slide: 5000, offline: 10000, recover: 15000 };
const timings = {};
let app = null, page = null, mock = null;

async function screen(p) {
  return p.evaluate(() => {
    const card = document.getElementById('cr-card-propresenter');
    const row = document.querySelector('#simple-device-list .simple-device-item[data-status-key="proPresenter"] .device-dot');
    return {
      cardShown: !!card && card.style.display !== 'none',
      cardStatus: card?.dataset.status || '',
      cardValue: (card?.querySelector('.cr-card-value')?.textContent || '').trim(),
      cardDetail: (card?.querySelector('.cr-card-detail')?.textContent || '').trim(),
      hero: (document.getElementById('cr-hero-headline')?.textContent || '').trim(),
      ppDot: row ? row.className : '(no pp row)',
      secPresentation: (document.getElementById('val-pp-presentation')?.textContent || '').trim(),
      secSlide: (document.getElementById('val-pp-slide')?.textContent || '').trim(),
      secLook: (document.getElementById('val-pp-look')?.textContent || '').trim(),
      secScreen: (document.getElementById('val-pp-screen')?.textContent || '').trim(),
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

async function configurePPViaUI() {
  await page.evaluate(() => switchTab('devices'));
  await L.waitMs(500);
  const adv = page.locator('a:has-text("Switch to Advanced")').first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await L.waitMs(400); }
  let host = page.locator('#equip-catalog input[data-field="host"][data-device="propresenter"]').first();
  if (!(await host.count())) {
    await page.locator('#equip-catalog .equip-catalog-entry', { hasText: 'ProPresenter' }).locator('.btn-add').first().click();
    await L.waitMs(500);
    host = page.locator('#equip-catalog input[data-field="host"][data-device="propresenter"]').first();
  }
  await host.fill('127.0.0.1');
  await page.fill('#equip-catalog input[data-field="port"][data-device="propresenter"]', String(PORT));
  // "Test" against a web server that is NOT ProPresenter, then the real one
  const testDetail = async () => {
    await page.evaluate(() => testEquip('propresenter'));
    await L.waitMs(300);
    return page.evaluate(() => (document.getElementById('equip-propresenter-detail')?.textContent || '').trim());
  };
  mock.setMode('not-pp');
  const tNot = await testDetail();
  mock.setMode('ok');
  const tOk = await testDetail();
  await L.shot(page, `${P}-ui-form`);
  await page.click('#btn-save-equip');
  const ok = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  try { await ok.waitFor({ state: 'visible', timeout: 5000 }); await ok.click(); } catch (_) { /* not running */ }
  await L.waitMs(2500);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  console.log(`[save] cfg.proPresenter=${JSON.stringify(cfg.proPresenter || null)}`);
  await toDashboard();
  return { tNot, tOk, cfg };
}

function labAdmin() {
  const key = (fs.readFileSync(path.join(L.ROOT, 'data/relay.env'), 'utf8').match(/^ADMIN_API_KEY=(.*)$/m) || [])[1];
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  let churchId = cfg.churchId || cfg.rejoinRoom?.churchId;
  if (!churchId && cfg.token) { try { churchId = JSON.parse(Buffer.from(cfg.token.split('.')[1], 'base64url').toString()).churchId; } catch (_) {} }
  return {
    churchId,
    cmd: async (command, params = {}) => {
      const r = await fetch(`${L.creds.relayHttp}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ churchId, command, params, wait: true }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}
const txt = (r) => JSON.stringify(r.body?.result ?? r.body?.error ?? r.body).slice(0, 130);

async function main() {
  mock = await ppMock.start({ port: PORT, controlPort: 0 });
  mock.operatorShow('pres-worship', 0);
  console.log(`ProPresenter mock http://127.0.0.1:${mock.port}`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard();

  // 1) Add ProPresenter in the UI; the Test button must tell a non-PP web server apart
  const tCfg = Date.now();
  const { tNot, tOk, cfg } = await configurePPViaUI();
  L.record('test_button_honest', /not ProPresenter/i.test(tNot) && /ProPresenter 7\.16\.2 running/.test(tOk) ? 'PASS' : 'FAIL', `not-pp→"${tNot}" pp→"${tOk}"`);
  const up = await until((s) => s.cardShown && s.cardStatus === 'ok' && s.cardValue === 'Worship Set' && /^Slide 1 of 12$/.test(s.cardDetail) && /device-dot ok/.test(s.ppDot), 30000);
  timings.onlineAfterSaveMs = Date.now() - tCfg;
  L.record('pp_online_on_screen', up.ok && cfg.proPresenter?.port == PORT ? 'PASS' : 'FAIL', `cfg=${JSON.stringify(cfg.proPresenter)} ${JSON.stringify(up.s)}`);
  await L.shot(page, `${P}-01-online`);

  // 2) Operator moves the show in ProPresenter → booth follows; clear → "Nothing on screen"
  mock.operatorShow('pres-worship', 4);
  const sl = await until((s) => s.cardDetail === 'Slide 5 of 12', 15000);
  timings.slideMs = sl.ms;
  L.record('operator_slide_follows', sl.ok && sl.ms <= W.slide ? 'PASS' : 'FAIL', `${sl.ms}ms ${JSON.stringify(sl.s)}`);
  mock.operatorClear();
  const cl = await until((s) => s.cardStatus === 'ok' && /nothing on screen/i.test(s.cardDetail), 15000);
  L.record('operator_clear_shows_nothing_on_screen', cl.ok && cl.ms <= W.slide ? 'PASS' : 'FAIL', `${cl.ms}ms ${JSON.stringify(cl.s)}`);
  mock.operatorAudience(false);
  const au = await until((s) => s.secScreen === 'OFF', 15000);
  L.record('audience_screens_state_shown', au.ok ? 'PASS' : 'FAIL', `${au.ms}ms screen=${au.s?.secScreen}`);
  mock.operatorAudience(true);

  // 3) The booth screen is monitor-only: its command path must refuse ProPresenter commands
  //    clearly (not claim success), and nothing may change in ProPresenter.
  mock.operatorShow('pres-worship', 1);
  await L.waitMs(1500);
  const r = await page.evaluate(async () => window.electronAPI.sendCommand('propresenter.next', {}));
  L.record('booth_command_path_honest', /unknown command/i.test(JSON.stringify(r)) && mock.state.slideIndex === 1 ? 'PASS' : 'FAIL', `next→${JSON.stringify(r).slice(0, 120)} idx=${mock.state.slideIndex}`);
  mock.operatorShow('pres-worship', 2);
  await L.waitMs(1500);

  // 4) Remote engineer through the LOCAL lab relay (wait:true → real outcome)
  const adm = labAdmin();
  const a1 = await adm.cmd('propresenter.next');
  const a2 = await adm.cmd('propresenter.goToSlide', { index: 99 });
  const a3 = await adm.cmd('propresenter.setLook', { name: 'Nope' });
  const a4 = await adm.cmd('propresenter.setLook', { name: 'Stream Only' });
  const a5 = await adm.cmd('propresenter.triggerMacro', { name: 'Walk In' });
  const a6 = await adm.cmd('propresenter.startTimer', { name: 'Sermon' });
  mock.setBreak('ignore-triggers');
  const a7 = await adm.cmd('propresenter.next');
  mock.setBreak('http-500');
  const a8 = await adm.cmd('propresenter.clearSlide');
  mock.setBreak('');
  L.record('remote_commands_real_results',
    a1.status === 200 && /now slide 4/.test(txt(a1)) && mock.state.slideIndex === 3
      && a2.status === 422 && /refused|slide 100/i.test(a2.body.error || '')
      && a3.status === 422 && /not found/i.test(a3.body.error || '')
      && a4.status === 200 && mock.state.currentLook === 'look-stream'
      && a5.status === 200 && /not confirmed|no readable state/i.test(txt(a5)) && mock.state.lastMacro != null
      && a6.status === 200 && mock.state.timers.find((t) => t.id.uuid === 'timer-sermon').state === 'running'
      && a7.status === 422 && /did not change/i.test(a7.body.error || '') && mock.state.slideIndex === 3
      && a8.status === 422 && /refused.*HTTP 500/i.test(a8.body.error || '') ? 'PASS' : 'FAIL',
    `church=${adm.churchId} next=${a1.status}:${txt(a1)} go99=${a2.status}:${txt(a2)} lookNope=${a3.status}:${txt(a3)} look=${a4.status}:${mock.state.currentLook} macro=${a5.status}:${txt(a5)} timer=${a6.status}:${txt(a6)} ignored=${a7.status}:${txt(a7)} http500=${a8.status}:${txt(a8)}`);
  const lk = await until((s) => s.secLook === 'Stream Only', 10000);
  L.record('remote_change_visible_in_booth', lk.ok ? 'PASS' : 'FAIL', `${lk.ms}ms look=${lk.s?.secLook}`);

  // 5) ProPresenter quits → Disconnected, hero issue, error dot, no stale slide
  mock.setMode('offline');
  const off = await until((s) => s.cardStatus === 'error' && /not reachable/i.test(s.cardDetail) && /issue/i.test(s.hero) && /device-dot error/.test(s.ppDot) && !/slide/i.test(s.cardDetail), 20000);
  timings.offlineMs = off.ms;
  L.record('pp_quit_honest', off.ok && off.ms <= W.offline ? 'PASS' : 'FAIL', `${off.ms}ms ${JSON.stringify(off.s)}`);
  await L.shot(page, `${P}-02-offline`);
  const idx = mock.state.slideIndex;
  const rOff = await adm.cmd('propresenter.next');
  L.record('remote_command_pp_offline_fails', rOff.status === 422 && /not reachable|not connected/i.test(rOff.body.error || '') && mock.state.slideIndex === idx ? 'PASS' : 'FAIL', `${rOff.status} ${JSON.stringify(rOff.body).slice(0, 160)}`);
  let flap = false;
  await until(() => false, 10000, (s) => { if (s.cardStatus === 'ok' || /nominal/i.test(s.hero)) flap = true; });
  L.record('pp_stays_offline_no_flap', !flap ? 'PASS' : 'FAIL', `flapped=${flap}`);

  // 6) ProPresenter back → ok
  mock.setMode('ok');
  const back = await until((s) => s.cardStatus === 'ok' && /device-dot ok/.test(s.ppDot) && /^Slide \d+ of 12$/.test(s.cardDetail), 30000);
  timings.recoverMs = back.ms;
  L.record('pp_back_recovers', back.ok && back.ms <= W.recover ? 'PASS' : 'FAIL', `${back.ms}ms ${JSON.stringify(back.s)}`);
  await L.shot(page, `${P}-03-recovered`);

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
