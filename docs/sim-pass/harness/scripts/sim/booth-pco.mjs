#!/usr/bin/env node
/**
 * SIM PASS — Planning Center (relay-side cloud integration) seen from the booth.
 * Real Electron app + LOCAL lab relay :3400 whose PCO_API_ORIGIN points at the PCO mock
 * (church-client/test/mocks/planningCenterServer.js, mirrors the real Services v2 API).
 * The real Planning Center API is never contacted: the script refuses to run unless the
 * lab relay env points PCO at 127.0.0.1.
 *
 * Checks: connect (PAT) → service types → sync (wall-clock times) → booth shows synced;
 * next-service plan; token revoked → sync refused with the reason + booth says "sync failing";
 * PCO down → refused; recovery clears the warning.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as L from './booth-lib.mjs';

const require = createRequire(import.meta.url);
const pcoMock = require(process.env.PCO_MOCK || '/workspace/tally/church-client/test/mocks/planningCenterServer.js');
const PORT = 41830;
const P = 'pco';
let app = null, page = null, mock = null;

const env = fs.readFileSync(path.join(L.ROOT, 'data/relay.env'), 'utf8');
if (!new RegExp(`^PCO_API_ORIGIN=http://127\\.0\\.0\\.1:${PORT}\\s*$`, 'm').test(env)) {
  console.error(`refusing to run: data/relay.env must set PCO_API_ORIGIN=http://127.0.0.1:${PORT} (never the real PCO API)`);
  process.exit(2);
}
if (!/process\.env\.PCO_API_ORIGIN/.test(fs.readFileSync('/workspace/tally/relay-server/src/planningCenter.js', 'utf8'))) {
  console.error('refusing to run: this relay build ignores PCO_API_ORIGIN and would call the real Planning Center API');
  process.exit(2);
}
const KEY = (env.match(/^ADMIN_API_KEY=(.*)$/m) || [])[1];

function churchId() {
  const cfg = JSON.parse(fs.readFileSync(L.CONFIG_PATH, 'utf8'));
  let id = cfg.churchId || cfg.rejoinRoom?.churchId;
  if (!id && cfg.token) { try { id = JSON.parse(Buffer.from(cfg.token.split('.')[1], 'base64url').toString()).churchId; } catch (_) {} }
  return id;
}
async function admin(method, p, body) {
  const r = await fetch(`${L.creds.relayHttp}${p}`, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function pcoScreen() {
  await page.evaluate(() => { try { switchTab('dashboard'); } catch (_) {} });
  await L.waitMs(200);
  await page.evaluate(() => { try { switchTab('devices'); } catch (_) {} });
  await L.waitMs(1200);
  return page.evaluate(() => {
    const el = document.getElementById('oauth-pco-status');
    const btn = document.getElementById('btn-oauth-pco');
    return { text: (el?.textContent || '').trim(), color: el?.style.color || '', btn: (btn?.textContent || '').trim() };
  });
}
async function untilScreen(pred, timeoutMs) {
  const t0 = Date.now(); let s = null;
  while (Date.now() - t0 < timeoutMs) { s = await pcoScreen(); if (pred(s)) return { ok: true, ms: Date.now() - t0, s }; }
  return { ok: false, ms: Date.now() - t0, s };
}
const j = (x) => JSON.stringify(x).slice(0, 220);

async function main() {
  mock = await pcoMock.start({ port: PORT, controlPort: 0 });
  console.log(`PCO mock ${mock.url}`);
  fs.rmSync(path.dirname(L.CONFIG_PATH), { recursive: true, force: true });
  ({ app, page } = await L.launchApp());
  await L.signInAndRoom(page);
  const cid = churchId();

  // Start from a clean PC state for this church (the lab DB persists between runs)
  await admin('POST', `/api/churches/${cid}/planning-center/disconnect`);
  await admin('PUT', `/api/churches/${cid}/planning-center`, { appId: '', secret: '', serviceTypeId: '', syncEnabled: false, writebackEnabled: false, serviceTypeIds: [] });
  const s0 = await untilScreen((s) => /Not connected/.test(s.text), 10000);
  L.record('booth_shows_not_connected', s0.ok ? 'PASS' : 'FAIL', j(s0.s));

  // 1) Connect with a Personal Access Token + pick service type
  const put = await admin('PUT', `/api/churches/${cid}/planning-center`, { appId: 'lab-app-id', secret: 'lab-secret', serviceTypeId: '1001', syncEnabled: true, writebackEnabled: true });
  const types = await admin('GET', `/api/churches/${cid}/planning-center/service-types`);
  const names = (types.body.serviceTypes || []).map((t) => t.name);
  L.record('connect_and_list_service_types', put.status === 200 && types.status === 200 && names.join('|') === 'Sunday Morning|Wednesday Night' && mock.state.callLog.some((c) => c.path.startsWith('/services/v2/service_types')) ? 'PASS' : 'FAIL', `put=${put.status} types=${types.status}:${j(names)}`);

  // 2) Sync — schedule keeps the PCO wall-clock times; plans cached
  const sync = await admin('POST', `/api/churches/${cid}/planning-center/sync`);
  const svc = (sync.body.schedule?.services || []).map((x) => `${x.day}@${String(x.startHour).padStart(2, '0')}:${String(x.startMin).padStart(2, '0')}`).sort();
  L.record('sync_wall_clock_times', sync.status === 200 && svc.join(',') === '0@09:00,0@11:00' && (sync.body.plans?.synced || 0) >= 2 ? 'PASS' : 'FAIL', `${sync.status} ${j(sync.body)}`);
  const s1 = await untilScreen((s) => /synced/.test(s.text) && !/fail/i.test(s.text) && /green/.test(s.color) && s.btn === 'Disconnect', 10000);
  L.record('booth_shows_connected_synced', s1.ok ? 'PASS' : 'FAIL', j(s1.s));
  await L.shot(page, `${P}-01-synced`);

  // 3) Next service from the cached plan (what the engineer / rundown sees)
  const next = await admin('GET', `/api/churches/${cid}/planning-center/next-service`);
  const plan = next.body.plan || {};
  L.record('next_service_plan', next.status === 200 && plan.title === 'Sunday 9:00' && (plan.items || []).length === 3 && (plan.team || []).length === 2 ? 'PASS' : 'FAIL', `${next.status} title=${plan.title} items=${(plan.items || []).length} team=${(plan.team || []).length}`);

  // 4) Token revoked in Planning Center → sync refused with the reason; booth warns
  mock.revoke();
  const rev = await admin('POST', `/api/churches/${cid}/planning-center/sync`);
  L.record('revoked_sync_refused', rev.status === 500 && /401|reconnect/i.test(rev.body.error || '') ? 'PASS' : 'FAIL', `${rev.status} ${j(rev.body)}`);
  const s2 = await untilScreen((s) => /sync failing/i.test(s.text) && /401|reconnect/i.test(s.text), 10000);
  L.record('booth_shows_sync_failing', s2.ok ? 'PASS' : 'FAIL', j(s2.s));
  await L.shot(page, `${P}-02-revoked`);
  mock.unrevoke();

  // 5) Planning Center down → refused (offline case)
  mock.setMode({ mode: 'down' });
  const down = await admin('POST', `/api/churches/${cid}/planning-center/sync`);
  L.record('pco_down_sync_refused', down.status === 500 && /503|unavailable/i.test(down.body.error || '') ? 'PASS' : 'FAIL', `${down.status} ${j(down.body)}`);
  mock.setMode({ mode: 'ok' });

  // 6) Recovery clears the warning
  const ok2 = await admin('POST', `/api/churches/${cid}/planning-center/sync`);
  const s3 = await untilScreen((s) => /synced/.test(s.text) && !/fail/i.test(s.text) && /green/.test(s.color), 10000);
  L.record('recovery_clears_warning', ok2.status === 200 && s3.ok ? 'PASS' : 'FAIL', `${ok2.status} ${j(s3.s)}`);
  await L.shot(page, `${P}-03-recovered`);

  // 7) Nothing left the box
  L.record('mock_only_no_real_pco', mock.state.callLog.length > 0 ? 'PASS' : 'FAIL', `mock calls=${mock.state.callLog.length}`);

  // 8) The operator clicks Disconnect in the booth → really disconnected (PAT too), plans dropped
  await pcoScreen();
  const adv = page.locator('#btn-oauth-pco');
  const simple = page.locator('#btn-oauth-pco-simple');
  const which = (await adv.isVisible().catch(() => false)) ? adv : simple;
  await which.click();
  const okBtn = page.locator('[data-async-overlay="1"] button', { hasText: /^OK$/ }).first();
  await okBtn.waitFor({ state: 'visible', timeout: 5000 });
  await okBtn.click();
  await L.waitMs(1500);
  const s4 = await untilScreen((s) => /Not connected/.test(s.text) && /Connect Planning Center/.test(s.btn), 10000);
  const nextAfter = await admin('GET', `/api/churches/${cid}/planning-center/next-service`);
  L.record('booth_disconnect_really_disconnects', s4.ok && !nextAfter.body.plan ? 'PASS' : 'FAIL', `${j(s4.s)} next=${j(nextAfter.body)}`);
  await L.shot(page, `${P}-04-disconnected`);
}

main()
  .catch(async (e) => { L.record('fatal', 'FAIL', String(e?.stack || e).slice(0, 800)); try { if (page) await L.shot(page, `${P}-fatal`); } catch (_) {} })
  .finally(async () => {
    try { await L.closeApp(app); } catch (_) {}
    try { if (mock) await mock.stop(); } catch (_) {}
    const failed = L.results.filter((r) => r.status === 'FAIL').length;
    console.log(`\n${L.results.length - failed}/${L.results.length} PASS`);
    L.finish(failed ? 1 : 0);
  });
