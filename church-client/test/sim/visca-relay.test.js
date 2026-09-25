/**
 * SIM PASS — VISCA PTZ via the REMOTE path:
 *   engineer → REAL relay (local, temp SQLite) → REAL agent → stateful camera mock.
 * Every command outcome asserted is what the engineer actually receives.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const viscaMock = require('../mocks/viscaPtzServer');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

const skip = relayAvailable() ? false : 'relay-server deps not installed';
const ptzCfg = (port) => ({ ptz: [{ ip: '127.0.0.1', name: 'Cam 1', protocol: 'visca-tcp', port }] });

test('remote: engineer recalls a preset → camera moves; standby/unplugged/bad camera come back as real errors', { timeout: 90000, skip }, async (t) => {
  const mock = await viscaMock.start({ transport: 'tcp' });
  const loop = await startRelayLoop(ptzCfg(mock.port));
  t.after(async () => { await loop.stop(); await mock.stop(); });

  // Relay (what the portal shows) sees the camera online with power.
  const s = await loop.waitForRelay((st, conn) => conn && st.ptz?.[0]?.connected === true, 20000, 'relay sees ptz online');
  assert.equal(s.status.ptz[0].power, 'on');

  // 1) success — result only after the camera completed it
  const ok = await loop.controllerCommand('ptz.preset', { camera: 1, preset: 4, zeroBasedPreset: true });
  assert.ok(!ok.timedOut && !ok.relayError, JSON.stringify(ok));
  assert.equal(ok.error, null, `engineer got error: ${ok.error}`);
  assert.equal(mock.state.lastPreset, 4, 'camera actually moved to preset 4');

  // 2) camera refuses (standby) → engineer sees the refusal, camera did not move
  mock.state.power = 'standby';
  const refused = await loop.controllerCommand('ptz.preset', { camera: 1, preset: 5, zeroBasedPreset: true });
  assert.match(String(refused.error || ''), /not executable|standby/i, `expected refusal, got ${JSON.stringify(refused)}`);
  assert.equal(mock.state.lastPreset, 4);
  await loop.waitForRelay((st) => st.ptz?.[0]?.power === 'standby', 10000, 'relay shows standby');
  mock.state.power = 'on';

  // 3) no such camera → error, not OK
  const nocam = await loop.controllerCommand('ptz.preset', { camera: 7, preset: 1 });
  assert.ok(nocam.error, `camera 7 does not exist; got ${JSON.stringify(nocam)}`);

  // 4) camera unplugged → relay status goes offline; engineer command fails honestly
  await mock.setReachable(false);
  const off = await loop.waitForRelay((st) => st.ptz?.[0]?.connected === false, 10000, 'relay shows ptz offline');
  assert.ok(off.status.ptz[0].error, 'offline carries a reason for the engineer');
  const dead = await loop.controllerCommand('ptz.preset', { camera: 1, preset: 2 });
  assert.ok(dead.error, `unplugged camera must fail; got ${JSON.stringify(dead)}`);
  assert.equal(mock.state.lastPreset, 4);

  // 5) replug → relay online again and commands work
  await mock.setReachable(true);
  await loop.waitForRelay((st) => st.ptz?.[0]?.connected === true, 15000, 'relay shows ptz back');
  const back = await loop.controllerCommand('ptz.preset', { camera: 1, preset: 2, zeroBasedPreset: true });
  assert.equal(back.error, null, back.error);
  assert.equal(mock.state.lastPreset, 2);
});

test('remote HTTP /api/command {wait:true}: returns the real result or the real device error (no blind "sent")', { timeout: 90000, skip }, async (t) => {
  const mock = await viscaMock.start({ transport: 'tcp' });
  const loop = await startRelayLoop(ptzCfg(mock.port));
  t.after(async () => { await loop.stop(); await mock.stop(); });
  await loop.waitForRelay((st, conn) => conn && st.ptz?.[0]?.connected === true, 20000, 'relay sees ptz online');

  const ok = await loop.httpCommand('ptz.preset', { camera: 1, preset: 3, zeroBasedPreset: true }, { wait: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.completed, true, `wait:true must report completion: ${JSON.stringify(ok.body)}`);
  assert.ok(!ok.body.error, ok.body.error);
  assert.equal(mock.state.lastPreset, 3);

  mock.state.power = 'standby';
  const refused = await loop.httpCommand('ptz.preset', { camera: 1, preset: 6, zeroBasedPreset: true }, { wait: true });
  assert.equal(refused.body.completed, true, JSON.stringify(refused.body));
  assert.match(String(refused.body.error || ''), /not executable|standby/i, `HTTP caller must see the refusal: ${JSON.stringify(refused.body)}`);
  assert.notEqual(refused.status, 200, 'a device refusal must not be HTTP 200 OK');
  assert.equal(mock.state.lastPreset, 3);
});

test('remote: booth agent offline → engineer is told, command is not reported as done', { timeout: 90000, skip }, async (t) => {
  const mock = await viscaMock.start({ transport: 'tcp' });
  const loop = await startRelayLoop(ptzCfg(mock.port));
  t.after(async () => { await loop.stop(); await mock.stop(); });
  await loop.waitForRelay((st, conn) => conn && st.ptz?.[0]?.connected === true, 20000, 'relay sees ptz online');
  await loop.stopAgent();
  await loop.waitForRelay((_st, conn) => conn === false, 10000, 'relay sees church offline');

  const ws = await loop.controllerCommand('ptz.preset', { camera: 1, preset: 1 }, 5000);
  assert.ok(ws.relayError && /not connected/i.test(ws.relayError), `controller: ${JSON.stringify(ws)}`);

  const http = await loop.httpCommand('ptz.preset', { camera: 1, preset: 1 }, { wait: true });
  assert.ok(http.body.sent !== true || http.body.queued === true, `must not claim sent: ${JSON.stringify(http.body)}`);
  assert.notEqual(http.body.completed, true, 'offline agent cannot have completed anything');
  assert.notEqual(mock.state.lastPreset, 1);
});
