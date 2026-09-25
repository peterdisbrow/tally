#!/usr/bin/env node
/**
 * SIM PASS — OBS booth UI e2e (source or packaged via TALLY_PACKAGED_BIN).
 * Real Electron app + real agent + protocol-faithful OBS mock (auth, close
 * codes, events). Everything asserted is read passively from the SCREEN.
 * Lab only: local relay :3400 + MockLab ATEM :9910. Mock OBS on a free port.
 *
 * Stated windows (booth promise):
 *   DISCONNECT_MS  OBS killed → chip not green, card "Disconnected", no LIVE   ≤ 5 000 ms
 *   RECOVER_MS     OBS back   → chip green, card "Connected", OBS version      ≤ 15 000 ms
 *   AUTHFAIL       wrong password → never green (20 s watch), reason on screen ≤ 12 000 ms
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const obsMock = require('/workspace/tally/church-client/test/mocks/obsServer.js');
const DISCONNECT_MS = 5000, RECOVER_MS = 15000, AUTHFAIL_REASON_MS = 12000;
const timings = {};
let app = null, page = null, mock = null;

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function screen(p) {
  return p.evaluate(() => {
    const vis = (el) => !!el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null;
    const chipOf = (id) => document.getElementById(id)?.closest('.status-chip');
    const encChip = chipOf('dot-encoder');
    const dot = document.getElementById('dot-encoder');
    const card = document.getElementById('cr-card-encoder');
    const err = document.getElementById('encoder-error');
    return {
      chipVisible: vis(encChip),
      chipLabel: document.getElementById('dot-encoder-label')?.textContent || '',
      chipGreen: !!dot && dot.classList.contains('green'),
      chipState: dot ? dot.className : '',
      cardVisible: !!card && getComputedStyle(card).display !== 'none',
      cardTitle: document.getElementById('cr-encoder-title')?.textContent || '',
      cardStatus: (document.getElementById('cr-encoder-status')?.textContent || '').trim(),
      cardDetail: (document.getElementById('cr-encoder-detail')?.textContent || '').trim(),
      cardDetailInViewport: (() => { const d = document.getElementById('cr-encoder-detail'); if (!d || !d.textContent.trim()) return false; const r = d.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })(),
      firmware: (document.getElementById('val-encoder-firmware')?.textContent || '').trim(),
      error: err && getComputedStyle(err).display !== 'none' ? err.textContent.trim() : '',
      live: !!document.getElementById('live-badge')?.classList.contains('active'),
      encSectionVisible: (() => { const s = document.getElementById('encoder-status-section'); return !!s && getComputedStyle(s).display !== 'none'; })(),
      phantomChips: ['dot-companion', 'dot-propresenter-chip', 'dot-resolume-chip'].filter((id) => vis(chipOf(id))),
      atemGreen: !!document.getElementById('dot-atem')?.classList.contains('green'),
    };
  });
}
const connectedOnScreen = (s) => s.chipVisible && s.chipGreen && /connected/i.test(s.cardStatus) && !/disconnected/i.test(s.cardStatus);
const honestDown = (s) => s.chipVisible && !s.chipGreen && /disconnected/i.test(s.cardStatus) && !s.live;

async function toDashboard(p) { await p.evaluate(() => { try { switchTab('dashboard'); } catch (_) {} }); await L.waitMs(300); }
/** Poll the screen until pred(s) or timeout; returns {ok, ms, s, samples} and records any sample for watch(). */
async function until(pred, timeoutMs, watch) {
  const t0 = Date.now(); let s = null; const samples = [];
  while (Date.now() - t0 < timeoutMs) {
    s = await screen(page); samples.push({ t: Date.now() - t0, ...s });
    if (watch) watch(s);
    if (pred(s)) return { ok: true, ms: Date.now() - t0, s, samples };
    await L.waitMs(250);
  }
  return { ok: false, ms: Date.now() - t0, s, samples };
}

/** Configure (or clear) the OBS encoder through the real Equipment UI. */
async function configureObsViaUI({ host, port, password, clear = false }) {
  await page.evaluate(() => switchTab('devices'));
  await L.waitMs(500);
  const adv = page.locator('a:has-text("Switch to Advanced")').first();
  if (await adv.isVisible().catch(() => false)) { await adv.click(); await L.waitMs(400); }
  let typeSel = page.locator('#equip-catalog select[data-field="encoderType"][data-device="encoder"]').first();
  if (!(await typeSel.count())) {
    await page.locator('#equip-catalog .equip-catalog-entry', { hasText: 'Streaming Encoder' }).locator('.btn-add').first().click();
    await L.waitMs(500);
    typeSel = page.locator('#equip-catalog select[data-field="encoderType"][data-device="encoder"]').first();
  }
  await typeSel.selectOption(clear ? '' : 'obs');
  await L.waitMs(400);
  if (!clear) {
    await page.fill('#equip-catalog input[data-field="host"][data-device="encoder"]', host);
    await page.fill('#equip-catalog input[data-field="port"][data-device="encoder"]', String(port));
    await page.fill('#equip-catalog input[data-field="password"][data-device="encoder"]', password);
  }
  await L.shot(page, clear ? 'obs-ui-clear-form' : `obs-ui-form-${password ? 'pw' : 'nopw'}`);
  await page.click('#btn-save-equip');
  // While monitoring, the app asks "Saving will briefly restart monitoring. Continue?" — click OK like an operator.
  const ok = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  try { await ok.waitFor({ state: 'visible', timeout: 5000 }); await L.shot(page, 'obs-ui-save-confirm'); await ok.click(); } catch (_) { /* no confirm when not running */ }
  // Save auto-restarts the agent (stop → 1 s → start)
  await L.waitMs(2500);
  const diag = await page.evaluate(() => ({
    confirm: document.getElementById('save-confirm')?.style.display,
    error: document.getElementById('save-error')?.textContent || '',
  }));
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  console.log(`[save] confirm=${diag.confirm} error="${diag.error}" cfg.obsUrl=${cfg.obsUrl} encoder=${JSON.stringify(cfg.encoder || null).slice(0, 120)} obsPw=${cfg.obsPassword ? 'set' : 'none'}`);
  await toDashboard(page);
}

async function main() {
  const port = await freePort();
  mock = await obsMock.start({ port, password: 'booth-pw' });
  await fetch(`${mock.control.url}/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setStreaming', args: { active: true } }) });
  console.log(`OBS mock ws://127.0.0.1:${port} (password booth-pw, streaming) ctl=${mock.control.url}`);

  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const atem = await L.connectAtem(page);
  L.record('booth_up_atem_relay', atem.atemConnected ? 'PASS' : 'FAIL', `atem+relay=${atem.atemConnected}`);
  await toDashboard(page);
  await L.waitMs(2500);

  // 1) No phantom OBS/encoder UI before OBS is configured
  let s = await screen(page);
  L.record('no_phantom_before_obs_config', !s.chipVisible && !s.cardVisible && !s.encSectionVisible && s.phantomChips.length === 0 ? 'PASS' : 'FAIL',
    JSON.stringify({ chip: s.chipVisible, card: s.cardVisible, section: s.encSectionVisible, phantom: s.phantomChips }));
  await L.shot(page, 'obs-01-before-config');

  // 2) Configure with the WRONG password via the Equipment UI → never green, reason on screen
  await configureObsViaUI({ host: '127.0.0.1', port, password: 'wrong-pw' });
  let everGreen = false;
  // The reason must be visible WITHOUT scrolling: on the OBS card itself (and in the Encoder section).
  const reason = await until((x) => /password|auth/i.test(x.error) && /password/i.test(x.cardDetail) && x.cardDetailInViewport, AUTHFAIL_REASON_MS, (x) => { if (x.chipGreen || /^connected$/i.test(x.cardStatus)) everGreen = true; });
  const watchMore = await until(() => false, 20000 - reason.ms > 0 ? 20000 - reason.ms : 0, (x) => { if (x.chipGreen || /^connected$/i.test(x.cardStatus)) everGreen = true; });
  s = watchMore.s || reason.s;
  timings.authReasonMs = reason.ms;
  const onDash = await page.evaluate(() => !!document.getElementById('dashboard')?.classList.contains('active')
    && !document.getElementById('signin')?.classList.contains('active'));
  const signInVisible = await page.locator('#si-email').isVisible().catch(() => false);
  L.record('obs_wrong_password_keeps_tally_signed_in', onDash && !signInVisible ? 'PASS' : 'FAIL',
    `dashboard=${onDash} signInVisible=${signInVisible} (a wrong OBS password must not sign the operator out of Tally)`);
  L.record('obs_wrong_password_honest', reason.ok && !everGreen && mock.state.authFailures >= 1 ? 'PASS' : 'FAIL',
    `card reason="${reason.s?.cardDetail}" (in viewport=${reason.s?.cardDetailInViewport}) section="${reason.s?.error}" after ${reason.ms}ms; everGreen=${everGreen}; card="${s?.cardStatus}"; mockAuthFailures=${mock.state.authFailures}`);
  await L.shot(page, 'obs-02-wrong-password');

  // 3) Correct password via the Equipment UI → connected + live + version on screen
  const tCfg = Date.now();
  await configureObsViaUI({ host: '127.0.0.1', port, password: 'booth-pw' });
  const up = await until((x) => connectedOnScreen(x) && x.live && /OBS 30\.0\.0/.test(x.firmware) && !x.error, 30000);
  timings.connectAfterSaveMs = Date.now() - tCfg;
  L.record('obs_connected_live_on_screen', up.ok ? 'PASS' : 'FAIL',
    `after save ${timings.connectAfterSaveMs}ms: chip=${up.s.chipLabel}/${up.s.chipState} card="${up.s.cardTitle}: ${up.s.cardStatus}" fw="${up.s.firmware}" LIVE=${up.s.live} err="${up.s.error}"`);
  L.record('obs_label_is_obs', up.s.chipLabel === 'OBS' && up.s.cardTitle === 'OBS' ? 'PASS' : 'FAIL', `chip="${up.s.chipLabel}" card="${up.s.cardTitle}"`);
  await L.shot(page, 'obs-03-connected-live');

  // 4) Control action through the app's command path → OBS state actually changes
  const r = await page.evaluate(async () => window.electronAPI.sendCommand('obs.setScene', { scene: 'Scene 3' }));
  const bad = await page.evaluate(async () => window.electronAPI.sendCommand('obs.setScene', { scene: 'No Such Scene' }));
  L.record('obs_control_action', !r?.error && mock.state.programScene === 'Scene 3' && !!bad?.error ? 'PASS' : 'FAIL',
    `setScene→${JSON.stringify(r).slice(0, 120)} mockScene=${mock.state.programScene}; badScene→error=${JSON.stringify(bad?.error || null).slice(0, 120)}`);

  // 5) Kill OBS (process death: sockets drop, port closed) → honest disconnect within window
  const tKill = Date.now();
  await mock.stop();
  const down = await until(honestDown, 15000);
  timings.disconnectMs = down.ms;
  L.record('obs_kill_honest_disconnect', down.ok && down.ms <= DISCONNECT_MS ? 'PASS' : 'FAIL',
    `${down.ms}ms (window ${DISCONNECT_MS}ms): chip=${down.s.chipState} card="${down.s.cardStatus}" LIVE=${down.s.live}`);
  await L.shot(page, 'obs-04-killed-disconnected');
  // stays honest while OBS is gone (no flap back to green)
  let flapped = false;
  await until(() => false, 12000, (x) => { if (x.chipGreen || x.live) flapped = true; });
  s = await screen(page);
  L.record('obs_stays_down_while_dead', !flapped && honestDown(s) ? 'PASS' : 'FAIL', `12s watch flapped=${flapped}; chip=${s.chipState} card="${s.cardStatus}"`);
  await L.shot(page, 'obs-05-still-down-12s');

  // 6) Restart OBS on the same port → recovers within window
  mock = await obsMock.start({ port, password: 'booth-pw' });
  const back = await until((x) => connectedOnScreen(x) && /OBS 30\.0\.0/.test(x.firmware), 40000);
  timings.recoverMs = back.ms;
  timings.totalOutageMs = Date.now() - tKill;
  L.record('obs_restart_recovers', back.ok && back.ms <= RECOVER_MS ? 'PASS' : 'FAIL',
    `${back.ms}ms (window ${RECOVER_MS}ms): chip=${back.s.chipState} card="${back.s.cardStatus}" LIVE=${back.s.live} (mock restarted not streaming → LIVE must be false)`);
  L.record('obs_no_stale_live_after_restart', back.ok && back.s.live === false ? 'PASS' : 'FAIL', `LIVE=${back.s.live}`);
  await L.shot(page, 'obs-06-recovered');

  // 7) ATEM unaffected + no phantom chips for unconfigured devices throughout
  s = await screen(page);
  L.record('atem_still_green_no_phantoms', s.atemGreen && s.phantomChips.length === 0 ? 'PASS' : 'FAIL', `atem=${s.atemGreen} phantom=${JSON.stringify(s.phantomChips)}`);

  // 8) Remove OBS via the UI → encoder UI disappears (no phantom)
  await configureObsViaUI({ clear: true });
  const gone = await until((x) => !x.chipVisible && !x.cardVisible && !x.encSectionVisible, 15000);
  L.record('obs_removed_no_phantom', gone.ok ? 'PASS' : 'FAIL', `chip=${gone.s.chipVisible} card=${gone.s.cardVisible} section=${gone.s.encSectionVisible}`);
  await L.shot(page, 'obs-07-removed');
}

main()
  .catch(async (e) => { L.record('fatal', 'FAIL', String(e?.stack || e).slice(0, 800)); try { if (page) await L.shot(page, 'obs-fatal'); } catch (_) {} })
  .finally(async () => {
    fs.writeFileSync(path.join(L.OUT, 'obs-timings.json'), JSON.stringify(timings, null, 2));
    try { await L.closeApp(app); } catch (_) {}
    try { if (mock) await mock.stop(); } catch (_) {}
    const failed = L.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${L.results.length - failed}/${L.results.length} PASS  timings=${JSON.stringify(timings)}`);
    L.finish(failed ? 1 : 0);
  });
