/**
 * SIM PASS — VISCA PTZ (TCP / raw UDP / Sony VISCA-over-IP).
 * Stateful camera mock that answers like a real camera and says no.
 * Direct camera tests + the REAL agent process against a fake relay.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const viscaMock = require('../mocks/viscaPtzServer');
const { startAgent, freePort } = require('../helpers/agentHarness');

// TALLY_PTZ_MODULE lets the red-proof runner point these tests at older code.
const ptzMod = require(process.env.TALLY_PTZ_MODULE || path.join(__dirname, '..', '..', 'src', 'ptz.js'));
const { PTZManager } = ptzMod;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function camFor(mock, protocol, extra = {}) {
  const mgr = new PTZManager([{ ip: '127.0.0.1', name: 'Cam 1', protocol, port: mock.port, ...extra }], () => {});
  await mgr.connectAll();
  return { mgr, cam: mgr.cameras[0] };
}
const mocks = [];
async function mk(opts) { const m = await viscaMock.start(opts); mocks.push(m); return m; }
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

// ── Direct camera behaviour ───────────────────────────────────────────────────

test('VISCA TCP: port open but camera never answers VISCA → NOT connected', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp', breakMode: 'no-reply' });
  const { mgr, cam } = await camFor(mock, 'visca-tcp');
  assert.equal(cam.connected, false, 'an open TCP port is not a camera');
  assert.match(String(cam.error || ''), /no visca|reply|timeout/i);
  mgr.close?.();
});

test('VISCA TCP: live camera → connected via power inquiry; preset store/recall moves the real position', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp' });
  const { mgr, cam } = await camFor(mock, 'visca-tcp');
  assert.equal(cam.connected, true);
  assert.ok(mock.state.inquiries >= 1, 'liveness came from a VISCA inquiry');
  assert.equal(cam.toStatus().power, 'on');
  mock.state.pan = 800; mock.state.tilt = 200; mock.state.zoom = 4000;
  await mgr.setPreset(1, 3, '', { zeroBasedPreset: true });
  mock.state.pan = -1000; mock.state.tilt = -100; mock.state.zoom = 0;
  await mgr.recallPreset(1, 3, { zeroBasedPreset: true });
  assert.deepEqual([mock.state.pan, mock.state.tilt, mock.state.zoom], [800, 200, 4000], 'camera moved to stored preset');
  const pos = await cam.getPosition();
  assert.deepEqual(pos, { pan: 800, tilt: 200, zoom: 4000 }, 'position read back from camera');
  mgr.close?.();
});

test('VISCA TCP: camera in standby → commands rejected (not executable), power reported', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp' });
  mock.state.power = 'standby';
  const { mgr, cam } = await camFor(mock, 'visca-tcp');
  assert.equal(cam.toStatus().power, 'standby');
  await assert.rejects(mgr.recallPreset(1, 2), /not executable|standby/i);
  assert.equal(mock.state.presetRecalls, 0);
  mgr.close?.();
});

test('VISCA TCP: invalid command → camera syntax error is surfaced, not swallowed', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp' });
  const { mgr, cam } = await camFor(mock, 'visca-tcp');
  await assert.rejects(cam._sendVisca([0x81, 0x01, 0x04, 0x3f, 0x02, 0x90, 0xff]), /syntax/i);
  assert.equal(mock.state.errorsSent.syntax, 1);
  assert.equal(cam.connected, true, 'a rejected command does not mean the camera is gone');
  mgr.close?.();
});

test('VISCA TCP: concurrent commands are serialized — camera never answers "buffer full"', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp', presetMoveMs: 60 });
  const { mgr } = await camFor(mock, 'visca-tcp');
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => mgr.recallPreset(1, n)));
  assert.deepEqual(results.map((r) => r.status), Array(6).fill('fulfilled'), JSON.stringify(results.map((r) => r.reason?.message)));
  assert.equal(mock.state.errorsSent.bufferFull, 0);
  assert.equal(mock.state.presetRecalls, 6);
  mgr.close?.();
});

test('VISCA TCP: ACK without Completion → command fails (no fake success)', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'tcp', breakMode: 'ack-only' });
  const { mgr, cam } = await camFor(mock, 'visca-tcp');
  assert.equal(cam.connected, true, 'inquiries are answered');
  cam.completionTimeoutMs = 800;
  await assert.rejects(mgr.recallPreset(1, 1), /completion/i);
  mgr.close?.();
});

test('raw VISCA UDP: dead camera (no replies) is NOT connected; live camera connects and executes', { timeout: 20000 }, async () => {
  const dead = await mk({ transport: 'udp' });
  await dead.setReachable(false);
  const d = await camFor(dead, 'visca-udp');
  assert.equal(d.cam.connected, false, 'a sent datagram is not a camera');
  d.mgr.close?.();

  const live = await mk({ transport: 'udp' });
  const l = await camFor(live, 'visca-udp');
  assert.equal(l.cam.connected, true);
  await l.mgr.recallPreset(1, 5, { zeroBasedPreset: true });
  assert.equal(live.state.lastPreset, 5);
  l.mgr.close?.();
});

test('Sony VISCA-over-IP: correct payload types + sequence; camera accepts every packet', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'sony' });
  const { mgr, cam } = await camFor(mock, 'sony-visca-udp');
  assert.equal(cam.connected, true);
  await mgr.recallPreset(1, 2, { zeroBasedPreset: true });
  await mgr.panTilt(1, 0.5, 0, { durationMs: 30 });
  assert.equal(mock.state.lastPreset, 2);
  assert.equal(mock.state.errorsSent.sonyMessage, 0, 'inquiries must use payload type 0x0110');
  assert.equal(mock.state.errorsSent.sonySequence, 0);
  mgr.close?.();
});

test('Sony VISCA-over-IP: replies with the wrong sequence number are not trusted', { timeout: 20000 }, async () => {
  const mock = await mk({ transport: 'sony', breakMode: 'wrong-seq' });
  const { mgr, cam } = await camFor(mock, 'sony-visca-udp');
  assert.equal(cam.connected, false);
  mgr.close?.();
});

// ── Real agent process ───────────────────────────────────────────────────────

const ptzCfg = (port, protocol = 'visca-tcp') => ({ ptz: [{ ip: '127.0.0.1', name: 'Cam 1', protocol, port }] });

test('agent: VISCA camera reported connected + power; ptz.preset moves the camera; errors come back as errors', { timeout: 60000 }, async (t) => {
  const mock = await mk({ transport: 'tcp' });
  const agent = await startAgent(ptzCfg(mock.port));
  t.after(() => agent.stop());
  const s = await agent.waitFor((st) => st.ptz?.[0]?.connected === true, 15000, 'ptz connected');
  assert.equal(s.status.ptz[0].power, 'on');
  const ok = await agent.command('ptz.preset', { camera: 1, preset: 4, zeroBasedPreset: true });
  assert.ok(!ok.error, `preset error: ${ok.error}`);
  assert.equal(mock.state.lastPreset, 4);

  mock.state.power = 'standby';
  const bad = await agent.command('ptz.preset', { camera: 1, preset: 5, zeroBasedPreset: true });
  assert.match(String(bad.error || ''), /not executable|standby/i, 'standby camera must return an error, not success');
  assert.equal(mock.state.lastPreset, 4);
  await agent.waitFor((st) => st.ptz?.[0]?.power === 'standby', 8000, 'standby visible in status');
});

test('agent: unplug → offline pushed ≤ 2 s; plug back → online ≤ 8 s', { timeout: 60000 }, async (t) => {
  const mock = await mk({ transport: 'tcp' });
  const agent = await startAgent(ptzCfg(mock.port));
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.ptz?.[0]?.connected === true, 15000, 'ptz connected');
  await sleep(300);
  const t0 = Date.now();
  await mock.setReachable(false);
  const off = await agent.waitFor((st) => st.ptz?.[0]?.connected === false, 12000, 'ptz offline');
  assert.ok(Date.now() - t0 <= 2000, `offline took ${Date.now() - t0}ms (want ≤ 2000)`);
  assert.ok(off.status.ptz[0].error, 'offline has a reason');
  const bad = await agent.command('ptz.preset', { camera: 1, preset: 2 });
  assert.ok(bad.error, 'command to an unplugged camera must fail');
  const t1 = Date.now();
  await mock.setReachable(true);
  await agent.waitFor((st) => st.ptz?.[0]?.connected === true, 12000, 'ptz back');
  assert.ok(Date.now() - t1 <= 8000, `recovery took ${Date.now() - t1}ms (want ≤ 8000)`);
});

test('agent: camera powered off at agent start → comes online when plugged in', { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const agent = await startAgent(ptzCfg(port));
  t.after(() => agent.stop());
  await agent.waitFor((st) => Array.isArray(st.ptz) && st.ptz.length === 1 && st.ptz[0].connected === false, 20000, 'ptz offline at start');
  const mock = await mk({ transport: 'tcp', port });
  const t1 = Date.now();
  await agent.waitFor((st) => st.ptz?.[0]?.connected === true, 15000, 'ptz online after plug-in');
  assert.ok(Date.now() - t1 <= 8000, `took ${Date.now() - t1}ms`);
  const ok = await agent.command('ptz.preset', { camera: 1, preset: 1, zeroBasedPreset: true });
  assert.ok(!ok.error, ok.error);
  assert.equal(mock.state.lastPreset, 1);
});

test('agent: open port that is not a VISCA camera is never reported connected', { timeout: 60000 }, async (t) => {
  const mock = await mk({ transport: 'tcp', breakMode: 'no-reply' });
  const agent = await startAgent(ptzCfg(mock.port));
  t.after(() => agent.stop());
  await agent.waitFor((st) => Array.isArray(st.ptz) && st.ptz.length === 1, 20000, 'ptz status present');
  await sleep(6000);
  const lied = agent.frames.filter((f) => f.status.ptz?.[0]?.connected === true);
  assert.equal(lied.length, 0, `claimed connected ${lied.length}x`);
});

test('agent: raw UDP camera dies silently → offline within one poll (≤ 8 s)', { timeout: 60000 }, async (t) => {
  const mock = await mk({ transport: 'udp' });
  const agent = await startAgent(ptzCfg(mock.port, 'visca-udp'));
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.ptz?.[0]?.connected === true, 15000, 'udp ptz connected');
  const t0 = Date.now();
  await mock.setReachable(false);
  await agent.waitFor((st) => st.ptz?.[0]?.connected === false, 12000, 'udp ptz offline');
  assert.ok(Date.now() - t0 <= 8000, `offline took ${Date.now() - t0}ms`);
});
