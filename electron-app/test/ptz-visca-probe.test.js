/**
 * Equipment "Test" for PTZ must ask the camera a VISCA question (power
 * inquiry) and only pass when it answers. An open TCP port or a sent UDP
 * datagram is not a camera. Runs against the stateful church-client mock.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const viscaMock = require(path.join(__dirname, '..', '..', 'church-client', 'test', 'mocks', 'viscaPtzServer.js'));
const tester = require('../src/equipment-tester');

const mocks = [];
async function mk(o) { const m = await viscaMock.start(o); mocks.push(m); return m; }
test.after(async () => { for (const m of mocks) await m.stop().catch(() => {}); });
const run = (m, protocol) => tester.testEquipmentConnection({ type: 'ptz', ip: '127.0.0.1', port: m.port, protocol });

test('PTZ test: live VISCA TCP camera answers → pass, says it answered', async () => {
  const m = await mk({ transport: 'tcp' });
  const r = await run(m, 'visca-tcp');
  assert.equal(r.success, true, r.details);
  assert.match(r.details, /answered|responded/i);
  assert.ok(m.state.inquiries >= 1);
});
test('PTZ test: TCP port open but no VISCA reply → FAIL', async () => {
  const m = await mk({ transport: 'tcp', breakMode: 'no-reply' });
  const r = await run(m, 'visca-tcp');
  assert.equal(r.success, false, r.details);
  assert.match(r.details, /no visca reply|not a visca/i);
});
test('PTZ test: PTZOptics VISCA profile uses TCP inquiry too', async () => {
  const m = await mk({ transport: 'tcp' });
  const r = await run(m, 'ptzoptics-visca');
  assert.equal(r.success, true, r.details);
});
test('PTZ test: standby camera → reachable but says standby', async () => {
  const m = await mk({ transport: 'tcp' });
  m.state.power = 'standby';
  const r = await run(m, 'visca-tcp');
  assert.equal(r.success, true);
  assert.match(r.details, /standby/i);
});
test('PTZ test: raw UDP — dead camera FAILS, live camera passes', async () => {
  const dead = await mk({ transport: 'udp' });
  await dead.setReachable(false);
  const r1 = await run(dead, 'visca-udp');
  assert.equal(r1.success, false, r1.details);
  const live = await mk({ transport: 'udp' });
  const r2 = await run(live, 'visca-udp');
  assert.equal(r2.success, true, r2.details);
});
test('PTZ test: Sony VISCA-over-IP answered with correct framing', async () => {
  const m = await mk({ transport: 'sony' });
  const r = await run(m, 'sony-visca-udp');
  assert.equal(r.success, true, r.details);
  assert.equal(m.state.errorsSent.sonyMessage, 0);
  assert.ok(m.state.inquiries >= 1, 'camera received a properly framed inquiry');
  assert.match(r.details, /answered|responded/i);
});
