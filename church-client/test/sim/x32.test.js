/**
 * SIM PASS — Behringer X32 / Midas M32 (OSC/UDP).
 * Stateful console mock that behaves like the real one: SETs are silent,
 * GETs echo, unknown addresses and empty scenes are ignored.
 * Direct driver → real agent (fake relay) → REAL relay remote-engineer loop.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const x32Mock = require('../mocks/x32Server');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

// TALLY_MIXER_SRC lets the red-proof runner point these tests at older code.
const SRC = process.env.TALLY_MIXER_SRC || path.join(__dirname, '..', '..', 'src');
const { BehringerMixer } = require(path.join(SRC, 'mixers', 'behringer.js'));
const { MixerBridge } = require(path.join(SRC, 'mixerBridge.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b) => Math.abs(a - b) < 0.002;

const mocks = [];
async function mk(opts) { const m = await x32Mock.start(opts); mocks.push(m); return m; }
const drivers = [];
async function drv(mock, model = 'X32') { const d = new BehringerMixer({ host: '127.0.0.1', port: mock.port, model }); drivers.push(d); await d.connect(); return d; }
test.afterEach(async () => { while (drivers.length) { try { await drivers.pop().disconnect(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('X32 /info: model and firmware read from the right fields (M32 → "M32", "4.09")', { timeout: 15000 }, async () => {
  const mock = await mk({ model: 'M32' });
  const d = await drv(mock, 'X32');
  const s = await d.getStatus();
  assert.equal(s.online, true);
  assert.equal(s.model, 'M32');
  assert.equal(s.firmware, '4.09');
  await d.disconnect();
});

test('X32 mute/unmute/fader are confirmed by reading the console back', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteChannel(3);
  assert.equal(mock.state.ch[3].on, 0);
  await d.unmuteChannel(3);
  assert.equal(mock.state.ch[3].on, 1);
  await d.setFader(4, 0.5);
  assert.ok(near(mock.state.ch[4].fader, 0.5));
  await d.muteMaster();
  assert.equal(mock.state.main.on, 0);
  assert.equal((await d.getStatus()).mainMuted, true);
  await d.disconnect();
});

test('X32 console ignores SETs → command FAILS (no fake OK)', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'drop-sets' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(2), /did not confirm|not confirmed/i);
  await assert.rejects(d.muteMaster(), /did not confirm|not confirmed/i);
  assert.equal(mock.state.main.on, 1);
  await d.disconnect();
});

test('X32 unplugged → commands fail and console reported offline', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  mock.setReachable(false);
  await assert.rejects(d.muteChannel(1), /not respond|timeout|offline|did not confirm/i);
  assert.equal(await d.isOnline(), false);
  assert.equal((await d.getStatus()).online, false);
  await d.disconnect();
});

test('X32 channel that does not exist → error, not success', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(40));
  await d.disconnect();
});

test('X32 scene recall uses the real console action and actually changes the mix; empty scene is refused', { timeout: 15000 }, async () => {
  const mock = await mk();
  mock.storeScene(5, 'Sunday AM', { ch: { 1: { on: 0, fader: 0.25 } } });
  const d = await drv(mock);
  await d.recallScene(5);
  assert.equal(mock.state.recalls, 1, 'console recalled the scene');
  assert.equal(mock.state.current, 5);
  assert.equal(mock.state.ch[1].on, 0);
  await assert.rejects(d.recallScene(9), /empty|no scene|not found|did not/i);
  assert.equal(mock.state.current, 5);
  await d.disconnect();
});

test('X32 scene recall ignored by console → FAILS', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'no-scene' });
  mock.storeScene(2, 'Evening');
  const d = await drv(mock);
  await assert.rejects(d.recallScene(2), /did not|not confirm/i);
  await d.disconnect();
});

test('X32 DCA mute/fader and mute groups really apply (they exist in X32 OSC)', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteDca(2);
  assert.equal(mock.state.dca[2].on, 0);
  await d.setDcaFader(3, 0.4);
  assert.ok(near(mock.state.dca[3].fader, 0.4));
  await d.activateMuteGroup(1);
  assert.equal(mock.state.mute[1], 1);
  await d.deactivateMuteGroup(1);
  assert.equal(mock.state.mute[1], 0);
  await d.disconnect();
});

test('X32 unsupported action (soft keys) → honest error, not a silent OK', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await assert.rejects(d.pressSoftKey(1), /not supported|not available/i);
  await d.disconnect();
});

test('X32 scene save is verified on the console', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.saveScene(7, 'Tally Save');
  assert.equal(mock.state.scenes[7]?.name, 'Tally Save');
  const bad = await mk({ breakMode: 'drop-sets' });
  const d2 = await drv(bad);
  await assert.rejects(d2.saveScene(7, 'X'), /did not|not confirm/i);
  await d.disconnect(); await d2.disconnect();
});

test('X32 mute readback that lies (stale) → FAILS', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'stale-mute' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(6), /did not confirm|not confirmed/i);
  await d.disconnect();
});

test('MixerBridge exposes the console model so capability gating works', { timeout: 15000 }, async () => {
  const mock = await mk({ model: 'M32' });
  const b = new MixerBridge({ type: 'x32', host: '127.0.0.1', port: mock.port });
  drivers.push(b);
  await b.connect();
  await b.getStatus();
  assert.equal(b.model, 'M32');
  await b.disconnect();
});

// ── Real agent (fake relay) ──────────────────────────────────────────────────
const mixCfg = (port) => ({ mixer: { type: 'x32', host: '127.0.0.1', port } });

test('agent: master muted at the console → visible + critical alert within 6 s; unplug → offline ≤ 7.5 s (5 s poll + 1.5 s reply timeout) without a false "unmuted"', { timeout: 60000 }, async (t) => {
  const mock = await mk();
  const agent = await startAgent(mixCfg(mock.port));
  t.after(() => agent.stop());
  const s = await agent.waitFor((st) => st.mixer?.connected === true, 15000, 'mixer connected');
  assert.equal(s.status.mixer.model, 'X32');
  assert.equal(s.status.mixer.firmware, '4.06');
  const t0 = Date.now();
  mock.state.main.on = 0; // engineer at the console hits master mute
  await agent.waitFor((st) => st.mixer?.mainMuted === true, 8000, 'mainMuted visible');
  assert.ok(Date.now() - t0 <= 6000, `mute seen after ${Date.now() - t0}ms`);
  await sleep(300);
  assert.ok(agent.alerts.some((a) => /MUTED/i.test(a.message || a.alert || '')), 'muted alert sent');
  const n = agent.alerts.length;
  const t1 = Date.now();
  mock.setReachable(false);
  await agent.waitFor((st) => st.mixer?.connected === false, 10000, 'mixer offline');
  assert.ok(Date.now() - t1 <= 7500, `offline seen after ${Date.now() - t1}ms`);
  await sleep(500);
  const later = agent.alerts.slice(n).map((a) => a.message || '');
  assert.ok(!later.some((m) => /unmuted/i.test(m)), `false unmute alert: ${JSON.stringify(later)}`);
});

// ── Remote engineer via the REAL relay ───────────────────────────────────────
const skipRelay = relayAvailable() ? false : 'relay-server deps not installed';

test('remote: engineer mutes/unmutes + recalls scene through the relay; console refusals and offline come back as errors', { timeout: 90000, skip: skipRelay }, async (t) => {
  const mock = await mk();
  mock.storeScene(3, 'Worship');
  const loop = await startRelayLoop(mixCfg(mock.port));
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.mixer?.connected === true, 20000, 'relay sees mixer');

  const r1 = await loop.controllerCommand('mixer.mute', { channel: 5 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(mock.state.ch[5].on, 0, 'channel 5 really muted');

  const r2 = await loop.controllerCommand('mixer.recallScene', { scene: 3 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(mock.state.current, 3);

  const r3 = await loop.controllerCommand('mixer.recallScene', { scene: 42 });
  assert.ok(r3.error, `empty scene must be refused: ${JSON.stringify(r3)}`);

  const r4 = await loop.controllerCommand('mixer.pressSoftKey', { key: 1 });
  assert.ok(r4.error, `unsupported must not be OK: ${JSON.stringify(r4)}`);

  const h = await loop.httpCommand('mixer.unmute', { channel: 5 }, { wait: true });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.completed, true);
  assert.equal(mock.state.ch[5].on, 1);
  const hBad = await loop.httpCommand('mixer.recallScene', { scene: 43 }, { wait: true });
  assert.equal(hBad.status, 422, JSON.stringify(hBad.body));
  assert.match(String(hBad.body.error), /empty|scene/i);

  mock.setReachable(false);
  await loop.waitForRelay((st) => st.mixer?.connected === false, 10000, 'relay sees mixer offline');
  const r5 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.ok(r5.error, `unplugged console must fail: ${JSON.stringify(r5)}`);
  mock.setReachable(true);
  await loop.waitForRelay((st) => st.mixer?.connected === true, 12000, 'relay sees mixer back');
  const r6 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.equal(r6.error, null, JSON.stringify(r6));
});
