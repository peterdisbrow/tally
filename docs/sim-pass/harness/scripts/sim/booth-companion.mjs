#!/usr/bin/env node
/**
 * SIM PASS — Bitfocus Companion booth UI e2e + remote-engineer commands.
 * Real Electron app + real agent + stateful Companion mock that mirrors a real Companion 5.0.6
 * (clock fingerprint, 204 on empty slots, b_text labels, custom variables that must exist,
 * module statuses, 403 when the HTTP API is off, offline, not-companion).
 * Remote path: LOCAL lab relay :3400 /api/command {wait:true} → agent → Companion.
 * The mock runs on 41800 — never 8000/8001 (real Companion instances on this box).
 *
 * Stated windows:
 *   MODULE_MS   a Companion module goes into error → card names it           ≤ 8 000 ms
 *   OFFLINE_MS  Companion quits → card "Disconnected", hero issue, dot error  ≤ 8 000 ms
 *   RECOVER_MS  Companion back → card ok                                      ≤ 10 000 ms
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const compMock = require(process.env.COMP_MOCK || '/workspace/tally/church-client/test/mocks/companionServer.js');
const PORT = Number(process.env.COMP_PORT || 41800);
if ([8000, 8001, 18000].includes(PORT)) throw new Error('refusing to use a real Companion port');
const P = 'companion';
const W = { module: 8000, offline: 8000, recover: 10000 };
const timings = {};
let app = null, page = null, mock = null;

async function screen(p) {
  return p.evaluate(() => {
    const card = document.getElementById('cr-card-companion');
    const row = document.querySelector('#simple-device-list .simple-device-item[data-status-key="companion"] .device-dot');
    const list = document.getElementById('companion-connection-list');
    return {
      cardShown: !!card && card.style.display !== 'none',
      cardStatus: card?.dataset.status || '',
      cardValue: (card?.querySelector('.cr-card-value')?.textContent || '').trim(),
      cardDetail: (card?.querySelector('.cr-card-detail')?.textContent || '').trim(),
      hero: (document.getElementById('cr-hero-headline')?.textContent || '').trim(),
      dot: row ? row.className : '(no companion row)',
      secList: list ? (list.textContent || '').trim() : '',
      secListErr: list ? !!list.querySelector('[data-status="error"]') : false,
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

async function configureViaUI() {
  await page.evaluate(() => switchTab('devices'));
  await L.waitMs(500);
  const adv = page.locator('a:has-text("Switch to Advanced")').first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await L.waitMs(400); }
  let host = page.locator('#equip-catalog input[data-field="host"][data-device="companion"]').first();
  if (!(await host.count())) {
    await page.locator('#equip-catalog .equip-catalog-entry', { hasText: 'Companion' }).locator('.btn-add').first().click();
    await L.waitMs(500);
    host = page.locator('#equip-catalog input[data-field="host"][data-device="companion"]').first();
  }
  const portPh = await page.locator('#equip-catalog input[data-field="port"][data-device="companion"]').first().getAttribute('placeholder').catch(() => null);
  const portVal = await page.locator('#equip-catalog input[data-field="port"][data-device="companion"]').first().inputValue().catch(() => null);
  await host.fill('127.0.0.1');
  await page.fill('#equip-catalog input[data-field="port"][data-device="companion"]', String(PORT));
  const testDetail = async () => {
    await page.evaluate(() => testEquip('companion'));
    await L.waitMs(400);
    return page.evaluate(() => (document.getElementById('equip-companion-detail')?.textContent || '').trim());
  };
  mock.setMode('not-companion');
  const tNot = await testDetail();
  mock.setMode('api-disabled');
  const tOff = await testDetail();
  mock.setMode('ok');
  const tOk = await testDetail();
  await L.shot(page, `${P}-ui-form`);
  await page.click('#btn-save-equip');
  const ok = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  try { await ok.waitFor({ state: 'visible', timeout: 5000 }); await ok.click(); } catch (_) { /* not running */ }
  await L.waitMs(2500);
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  console.log(`[save] cfg.companionUrl=${cfg.companionUrl}`);
  await toDashboard();
  return { tNot, tOff, tOk, cfg, portPh, portVal };
}

function labAdmin() {
  const key = (fs.readFileSync(path.join(L.ROOT, 'data/relay.env'), 'utf8').match(/^ADMIN_API_KEY=(.*)$/m) || [])[1];
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  let churchId = cfg.churchId || cfg.rejoinRoom?.churchId;
  if (!churchId && cfg.token) { try { churchId = JSON.parse(Buffer.from(cfg.token.split('.')[1], 'base64url').toString()).churchId; } catch (_) {} }
  return {
    churchId,
    cmd: async (command, params = {}) => {
      await L.waitMs(350);   // relay rate-limits commands per church per second
      const r = await fetch(`${L.creds.relayHttp}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify({ churchId, command, params, wait: true }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}
const txt = (r) => JSON.stringify(r.body?.result ?? r.body?.error ?? r.body).slice(0, 140);

async function main() {
  mock = await compMock.start({ port: PORT, controlPort: 0 });
  console.log(`Companion mock http://127.0.0.1:${mock.port}`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard();

  // 1) Add Companion in the UI; default port is 8000; Test tells other web servers / API-off apart
  const tCfg = Date.now();
  const { tNot, tOff, tOk, cfg, portPh, portVal } = await configureViaUI();
  L.record('ui_default_port_8000', (portPh === '8000' || portVal === '8000') ? 'PASS' : 'FAIL', `placeholder=${portPh} value=${portVal}`);
  L.record('test_button_honest', /not Companion/i.test(tNot) && /HTTP API is switched off/i.test(tOff) && /Companion connected — 1 connection, all OK/.test(tOk) ? 'PASS' : 'FAIL', `other→"${tNot}" apiOff→"${tOff}" ok→"${tOk}"`);
  const up = await until((s) => s.cardShown && s.cardStatus === 'ok' && s.cardValue === 'Connected' && s.cardDetail === '1 module OK' && /device-dot ok/.test(s.dot), 30000);
  timings.onlineAfterSaveMs = Date.now() - tCfg;
  L.record('companion_online_on_screen', up.ok && cfg.companionUrl === `http://127.0.0.1:${PORT}` ? 'PASS' : 'FAIL', `cfg=${cfg.companionUrl} ${JSON.stringify(up.s)}`);
  await L.shot(page, `${P}-01-online`);

  // 2) A Companion module (the ATEM connection inside Companion) fails → booth names it
  mock.setConnectionStatus({ label: 'atem', category: 'error', level: 'connection_failure', message: 'ECONNREFUSED 10.0.0.9:9910' });
  const me = await until((s) => s.cardStatus === 'error' && /1 module in error: atem \(connection_failure: ECONNREFUSED/.test(s.cardDetail) && /issue/i.test(s.hero), 15000);
  timings.moduleMs = me.ms;
  L.record('module_error_named', me.ok && me.ms <= W.module ? 'PASS' : 'FAIL', `${me.ms}ms ${JSON.stringify(me.s)}`);
  await L.shot(page, `${P}-02-module-error`);
  mock.setConnectionStatus({ label: 'atem', category: 'good', level: 'ok', message: null });
  const mo = await until((s) => s.cardStatus === 'ok' && s.cardDetail === '1 module OK', 15000);
  L.record('module_recovers', mo.ok ? 'PASS' : 'FAIL', `${mo.ms}ms ${JSON.stringify(mo.s)}`);

  // 3) Remote engineer through the LOCAL lab relay (wait:true → real outcome)
  const adm = labAdmin();
  const a1 = await adm.cmd('companion.press', { page: 1, row: 0, col: 1 });
  const n0 = mock.state.pressLog.length;
  const a2 = await adm.cmd('companion.press', { page: 1, row: 3, col: 7 });
  const a3 = await adm.cmd('companion.pressNamed', { name: 'sunday' });
  const n1 = mock.state.pressLog.length;
  const a4 = await adm.cmd('companion.pressNamed', { name: 'Dante: Sunday' });
  const a5 = await adm.cmd('companion.setCustomVariable', { name: 'tally_service_ready', value: 'green' });
  const a6 = await adm.cmd('companion.setCustomVariable', { name: 'service_state', value: 'live' });
  const a7 = await adm.cmd('companion.getVariable', { connection: 'atem', variable: 'pgm1_input' });
  const checks = {
    press: a1.status === 200 && /Service Start/.test(txt(a1)) && mock.state.pressLog[n0 - 1]?.text === 'Service Start',
    empty: a2.status === 422 && /No button at page 1 row 3 column 7/.test(a2.body.error || ''),
    ambiguous: a3.status === 422 && /matches 2 Companion buttons/.test(a3.body.error || '') && n1 === n0,
    exact: a4.status === 200 && mock.state.pressLog.at(-1)?.text === 'Dante: Sunday',
    setVar: a5.status === 200 && /confirmed/.test(txt(a5)) && mock.state.customVariables.tally_service_ready === 'green',
    missingVar: a6.status === 422 && /no custom variable "service_state"/.test(a6.body.error || ''),
    getVar: a7.status === 200 && /Camera 1/.test(txt(a7)),
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  L.record('remote_commands_real_results', bad.length ? 'FAIL' : 'PASS',
    `failed=[${bad}] church=${adm.churchId} press=${a1.status}:${txt(a1)} empty=${a2.status}:${txt(a2)} ambiguous=${a3.status}:${txt(a3)} exact=${a4.status}:${txt(a4)} setVar=${a5.status}:${txt(a5)} missingVar=${a6.status}:${txt(a6)} getVar=${a7.status}:${txt(a7)} log=${JSON.stringify(mock.state.pressLog.map((x) => x.text))}`);

  // 4) HTTP API switched off in Companion → named on the card; commands refused
  mock.setMode('api-disabled');
  const ao = await until((s) => s.cardStatus === 'error' && s.cardValue === 'HTTP API off' && /issue/i.test(s.hero), 15000);
  const aoCmd = await adm.cmd('companion.press', { page: 1, row: 0, col: 0 });
  L.record('api_off_named_and_refused', ao.ok && aoCmd.status === 422 && /HTTP API is switched off/.test(aoCmd.body.error || '') ? 'PASS' : 'FAIL', `${ao.ms}ms ${JSON.stringify(ao.s)} cmd=${aoCmd.status}:${txt(aoCmd)}`);
  mock.setMode('ok');
  await until((s) => s.cardStatus === 'ok', 15000);

  // 5) Companion quits → Disconnected, hero issue, error dot, no stale modules
  mock.setMode('offline');
  const off = await until((s) => s.cardStatus === 'error' && s.cardValue === 'Disconnected' && /not reachable/i.test(s.cardDetail) && /issue/i.test(s.hero) && /device-dot error/.test(s.dot) && s.secList === '', 20000);
  timings.offlineMs = off.ms;
  L.record('companion_quit_honest', off.ok && off.ms <= W.offline ? 'PASS' : 'FAIL', `${off.ms}ms ${JSON.stringify(off.s)}`);
  await L.shot(page, `${P}-03-offline`);
  const nOff = mock.state.pressLog.length;
  const rOff = await adm.cmd('companion.press', { page: 1, row: 0, col: 0 });
  L.record('remote_command_offline_fails', rOff.status === 422 && /not reachable/i.test(rOff.body.error || '') && mock.state.pressLog.length === nOff ? 'PASS' : 'FAIL', `${rOff.status} ${JSON.stringify(rOff.body).slice(0, 160)}`);
  let flap = false;
  await until(() => false, 8000, (s) => { if (s.cardStatus === 'ok' || /nominal/i.test(s.hero)) flap = true; });
  L.record('companion_stays_offline_no_flap', !flap ? 'PASS' : 'FAIL', `flapped=${flap}`);

  // 6) Companion back → ok
  mock.setMode('ok');
  const back = await until((s) => s.cardStatus === 'ok' && /device-dot ok/.test(s.dot) && s.cardDetail === '1 module OK', 30000);
  timings.recoverMs = back.ms;
  L.record('companion_back_recovers', back.ok && back.ms <= W.recover ? 'PASS' : 'FAIL', `${back.ms}ms ${JSON.stringify(back.s)}`);
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
