/**
 * SIM PASS — Bitfocus Companion over its HTTP API (mock mirrors a real Companion 5.0.6).
 * Real agent → fake relay (status honesty over time) and real agent → REAL relay
 * (engineer commands: confirmed, refused, offline).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const compMock = require('../mocks/companionServer');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const mocks = [];
async function mk(opts = {}) { const m = await compMock.start({ port: 0, ...opts }); mocks.push(m); return m; }
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('agent: Companion up with module statuses; module error visible ≤ 6 s; Companion quits → offline ≤ 6 s; API switched off is named', { timeout: 90000 }, async (t) => {
  const m = await mk();
  const agent = await startAgent({ companionUrl: m.url });
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.companion?.connected === true && st.companion?.connections?.[0]?.status === 'ok', 20000, 'companion connected with module status');
  let t0 = Date.now();
  m.setConnectionStatus({ label: 'atem', category: 'error', level: 'connection_failure', message: 'ECONNREFUSED' });
  await agent.waitFor((st) => st.companion?.connections?.[0]?.status === 'error' && /ECONNREFUSED/.test(st.companion.connections[0].detail || ''), 10000, 'module error');
  assert.ok(Date.now() - t0 <= 6000, `module error seen after ${Date.now() - t0}ms`);
  t0 = Date.now();
  m.setMode('offline');
  await agent.waitFor((st) => st.companion?.connected === false && (st.companion.connections || []).length === 0, 12000, 'companion offline');
  assert.ok(Date.now() - t0 <= 6000, `offline seen after ${Date.now() - t0}ms`);
  m.setMode('api-disabled');
  await agent.waitFor((st) => st.companion?.connected === false && st.companion?.apiDisabled === true, 10000, 'api disabled named');
  m.setMode('ok');
  await agent.waitFor((st) => st.companion?.connected === true && st.companion?.apiDisabled === false, 10000, 'companion back');
});

test('agent: another web server on the Companion port is never reported as Companion', { timeout: 40000 }, async (t) => {
  const m = await mk({ mode: 'not-companion' });
  const agent = await startAgent({ companionUrl: m.url });
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.companion && st.companion.connected === false && /not Companion/.test(st.companion.error || ''), 20000, 'not companion');
  await new Promise((r) => setTimeout(r, 4000));
  assert.ok(!agent.frames.some((f) => f.status.companion?.connected === true), 'never connected');
});

const skipRelay = relayAvailable() ? false : 'relay-server deps not installed';

test('remote: engineer drives Companion through the relay; presses, names, variables, refusals and offline are truthful', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const loop = await startRelayLoop({ companionUrl: m.url });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.companion?.connected === true, 20000, 'relay sees Companion');
  // The relay rate-limits commands per church per second (product behaviour) — pace like an engineer would.
  const cmd = async (c, p) => { await new Promise((r) => setTimeout(r, 350)); return loop.controllerCommand(c, p); };

  const r1 = await cmd('companion.press', { page: 1, row: 0, col: 1 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.match(String(r1.result), /"Service Start"/);
  assert.equal(m.state.pressLog.at(-1).text, 'Service Start');

  const n0 = m.state.pressLog.length;
  const r2 = await cmd('companion.press', { page: 1, row: 3, col: 7 });
  assert.match(String(r2.error), /No button at page 1 row 3 column 7/);
  const r3 = await cmd('companion.pressNamed', { name: 'sunday' });
  assert.match(String(r3.error), /matches 2 Companion buttons/);
  assert.equal(m.state.pressLog.length, n0, 'refused presses must not press anything');

  const r4 = await cmd('companion.pressNamed', { name: 'Dante: Sunday' });
  assert.equal(r4.error, null, JSON.stringify(r4));
  assert.equal(m.state.pressLog.at(-1).col, 2);

  const r5 = await cmd('companion.setCustomVariable', { name: 'tally_service_ready', value: 'green' });
  assert.equal(r5.error, null, JSON.stringify(r5));
  assert.match(String(r5.result), /confirmed/);
  assert.equal(m.state.customVariables.tally_service_ready, 'green');
  const r6 = await cmd('companion.setCustomVariable', { name: 'service_state', value: 'live' });
  assert.match(String(r6.error), /no custom variable "service_state"/);

  const r7 = await cmd('companion.getVariable', { connection: 'atem', variable: 'pgm1_input' });
  assert.equal(r7.error, null, JSON.stringify(r7));
  assert.equal(r7.result.value, 'Camera 1');
  const r8 = await cmd('companion.getVariable', { connection: 'atem', variable: 'nope' });
  assert.match(String(r8.error), /no variable atem:nope/);

  const r9 = await cmd('companion.connections', {});
  assert.equal(r9.error, null);
  assert.equal(r9.result[0].status, 'ok');

  const r10 = await cmd('dante.scene', { name: 'Sunday' });
  assert.equal(r10.error, null, JSON.stringify(r10));
  assert.match(String(r10.result), /pressed, not confirmed/);

  m.setMode('api-disabled');
  const r11 = await cmd('companion.press', { page: 1, row: 0, col: 0 });
  assert.match(String(r11.error), /HTTP API is switched off/, JSON.stringify(r11));

  m.setMode('offline');
  await loop.waitForRelay((st) => st.companion?.connected === false, 12000, 'relay sees Companion offline');
  const r12 = await cmd('companion.press', { page: 1, row: 0, col: 0 });
  assert.match(String(r12.error), /not reachable/);
  m.setMode('ok');
  await loop.waitForRelay((st) => st.companion?.connected === true, 20000, 'relay sees Companion back');
});
