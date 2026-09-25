/**
 * SIM PASS — Yamaha CL / QL / TF over RCP (TCP 49280).
 * Stateful RCP console mock: every set gets an in-order OK/ERROR, gets answer,
 * other clients see NOTIFY, empty scenes are refused, out-of-range → ERROR,
 * unplugged = half-open silent socket. Direct driver → real agent → REAL relay.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const yMock = require('../mocks/yamahaRcpServer');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

const SRC = process.env.TALLY_MIXER_SRC || path.join(__dirname, '..', '..', 'src');
const { YamahaMixer } = require(path.join(SRC, 'mixers', 'yamaha.js'));
const { MixerBridge } = require(path.join(SRC, 'mixerBridge.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const mocks = [];
async function mk(opts) { const m = await yMock.start({ port: 0, model: 'CL5', ...opts }); mocks.push(m); return m; }
const drivers = [];
async function drv(mock, extra = {}) {
  const d = new YamahaMixer({ host: '127.0.0.1', port: mock.port, ...extra });
  drivers.push(d);
  await d.connect();
  await sleep(100);
  return d;
}
test.afterEach(async () => { while (drivers.length) { try { await drivers.pop().disconnect(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('CL mute/unmute/fader confirmed by get read-back; mute = Fader/On 0; 0.75 = 0 dB like X32', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  const r = await d.muteChannel(3);
  assert.notEqual(r?.confirmed, false);
  assert.equal(mock.get('on:input:2'), 0, 'channel 3 OFF (muted)');
  await d.unmuteChannel(3);
  assert.equal(mock.get('on:input:2'), 1);
  await d.setFader(4, 0.75);
  assert.equal(mock.get('level:input:3'), 0, '0 dB');
  await d.setFader(4, 0.5);
  assert.equal(mock.get('level:input:3'), -1000, '−10 dB');
  await d.setFader(4, 0);
  assert.equal(mock.get('level:input:3'), -32768, '−∞');
});

test('master = Stereo (St 0) mute; getStatus reads mute + fader back; model detected from the console', { timeout: 15000 }, async () => {
  const mock = await mk({ model: 'QL5' });
  const d = await drv(mock);
  await d.muteMaster();
  assert.equal(mock.get('on:st:0'), 0);
  const s = await d.getStatus();
  assert.equal(s.online, true);
  assert.equal(s.mainMuted, true);
  assert.equal(s.mainFader, 0.75);
  assert.match(s.model, /QL5/);
  await d.unmuteMaster();
  assert.equal((await d.getStatus()).mainMuted, false);
});

test('DCA on/level and mute groups (MuteMaster) are applied and confirmed', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteDca(2);
  assert.equal(mock.get('on:dca:1'), 0);
  await d.unmuteDca(2);
  assert.equal(mock.get('on:dca:1'), 1);
  await d.setDcaFader(3, 0.75);
  assert.equal(mock.get('level:dca:2'), 0);
  await d.activateMuteGroup(1);
  assert.equal(mock.get('muteMaster:0'), 1);
  await d.deactivateMuteGroup(1);
  assert.equal(mock.get('muteMaster:0'), 0);
});

test('console that says OK but does not apply (drop-sets) or reads back stale → FAILS', { timeout: 15000 }, async () => {
  const m1 = await mk({ breakMode: 'drop-sets' });
  const d1 = await drv(m1);
  await assert.rejects(d1.muteChannel(2), /did not apply/i);
  await assert.rejects(d1.setFader(1, 0.3), /did not apply/i);
  await assert.rejects(d1.muteMaster(), /did not apply/i);
  const m2 = await mk({ breakMode: 'stale' });
  const d2 = await drv(m2);
  await assert.rejects(d2.muteChannel(6), /did not apply/i);
});

test('console that accepts TCP but answers nothing → commands fail AND offline; unknown mute is null', { timeout: 15000 }, async () => {
  const m = await mk({ breakMode: 'no-reply' });
  const d = await drv(m);
  await assert.rejects(d.muteChannel(1), /did not confirm|not connected/i);
  assert.equal(await d.isOnline(), false);
  const s = await d.getStatus();
  assert.equal(s.online, false);
  assert.equal(s.mainMuted, null);
});

test('unplugged (half-open socket) → fail, offline, recovers on replug', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  assert.equal(await d.isOnline(), true);
  mock.setReachable(false);
  await assert.rejects(d.muteChannel(1), /did not confirm|not connected/i);
  assert.equal(await d.isOnline(), false);
  mock.setReachable(true);
  assert.equal(await d.isOnline(), true);
  await d.muteChannel(1);
  assert.equal(mock.get('on:input:0'), 0);
});

test('bad channel / DCA / group / scene / level → error, nothing applied; channel counts follow the detected model', { timeout: 15000 }, async () => {
  const mock = await mk({ model: 'CL1' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(49), /invalid/i, 'CL1 has 48 inputs');
  await assert.rejects(d.muteChannel('abc'), /invalid/i);
  await assert.rejects(d.muteDca(17), /invalid/i);
  await assert.rejects(d.activateMuteGroup(9), /invalid/i);
  await assert.rejects(d.recallScene(301), /invalid/i);
  await assert.rejects(d.setFader(1, 2), /invalid/i);
  assert.equal(mock.state.sets, 0);
  const tf = await mk({ model: 'TF5' });
  const t = await drv(tf);
  await assert.rejects(t.muteChannel(41), /invalid/i);
  await assert.rejects(t.muteDca(9), /invalid/i);
  await t.muteChannel(40);
  assert.equal(tf.get('on:input:39'), 0);
});

test('scene recall is CONFIRMED by reading the current scene back; empty scenes are refused (CL + TF banks)', { timeout: 15000 }, async () => {
  const mock = await mk();
  mock.storeScene(12, 'Worship', { 'on:input:0': 0 });
  const d = await drv(mock);
  const r = await d.recallScene(12);
  assert.equal(r?.confirmed, true);
  assert.equal(mock.state.currentScene, 12);
  assert.equal(mock.get('on:input:0'), 0, 'scene contents applied');
  await assert.rejects(d.recallScene(200), /refused|empty|not recalled/i);
  const tf = await mk({ model: 'TF5' });
  tf.storeScene(5, 'Sermon', {}, 'scene_b');
  const t = await drv(tf);
  const rt = await t.recallScene('B05');
  assert.equal(rt?.confirmed, true);
  assert.equal(tf.state.currentScene, 'scene_b:5');
  await assert.rejects(t.recallScene('A07'), /refused|empty|not recalled/i);
  await assert.rejects(t.recallScene('C01'), /invalid/i);
  const nr = await mk({ breakMode: 'no-scene' });
  nr.storeScene(3, 'x');
  const dn = await drv(nr);
  await assert.rejects(dn.recallScene(3), /did not/i, 'console said OK but scene did not change');
});

test('names and pan read back; HPF/EQ/dynamics/scene save refuse honestly', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.setChannelName(2, 'Pastor');
  assert.equal(mock.get('name:input:1'), 'Pastor');
  await assert.rejects(d.setChannelName(2, 'Worship Leader'), /invalid/i, 'CL names max 8');
  await assert.rejects(d.setChannelName(2, 'Bad"Q'), /invalid/i);
  await d.setPan(2, -1);
  assert.equal(mock.get('pan:input:1'), -63);
  await d.setPan(2, 0.5);
  assert.equal(mock.get('pan:input:1'), 32);
  await assert.rejects(d.setHpf(1, { frequency: 100 }), /not available/i);
  await assert.rejects(d.setEq(1, {}), /not available/i);
  await assert.rejects(d.setCompressor(1, {}), /not available/i);
  await assert.rejects(d.saveScene(3, 'x'), /not available/i);
  const strip = await d.setFullChannelStrip(3, { name: 'Choir', hpf: { frequency: 80 }, fader: 0.75, pan: 0 });
  assert.ok(strip.skipped.includes('hpf') && strip.applied.includes('name'), JSON.stringify(strip));
});

test('MixerBridge "yamaha": legacy OSC port 8765 is mapped to RCP 49280; bridge exposes the detected model', { timeout: 15000 }, async () => {
  const mock = await mk({ model: 'TF5' });
  const b = new MixerBridge({ type: 'yamaha', host: '127.0.0.1', port: mock.port });
  drivers.push(b);
  await b.connect();
  await sleep(100);
  const s = await b.getStatus();
  assert.equal(s.online, true);
  assert.equal(b.model, 'TF5');
  const legacy = new YamahaMixer({ host: '10.0.0.1', port: 8765 });
  assert.equal(legacy.port, 49280);
});

test('console-surface changes (NOTIFY) reach Tally and never get mistaken for a command reply', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  // A burst of surface NOTIFYs interleaved with pending requests must not shift replies.
  mock.afterSet(() => { for (let i = 0; i < 5; i++) mock.surfaceSet(`level:input:${20 + i}`, -1000); mock.surfaceSet('on:st:0', 0); });
  const r = await d.muteChannel(7);
  assert.equal(r.confirmed, true);
  assert.equal(mock.get('on:input:6'), 0);
  await d.setFader(8, 0.5);
  assert.equal(mock.get('level:input:7'), -1000);
  await sleep(50);
  assert.equal(d._state.mutes['st:0'], true, 'NOTIFY updated the cached master mute');
  assert.equal(d._state.faders['input:20'], -1000);
  assert.equal((await d.getStatus()).mainMuted, true);
  // Operator turns the channel back ON between Tally's set and its read-back → honest failure.
  mock.afterSet(({ addr, x }) => { if (/InCh\/Fader\/On/.test(addr)) mock.surfaceSet(`on:input:${x}`, 1); });
  await assert.rejects(d.muteChannel(9), /did not apply/i);
  mock.afterSet(null);
});

test('a late reply (after Tally gave up) is never taken as the answer to the next request', { timeout: 20000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  // 1) late "OK set …InCh/Fader/On 0 0 0" must not answer "get …InCh/Fader/On 2" (action differs)
  mock.delayNext(1, 1400);
  await assert.rejects(d.muteChannel(1), /did not confirm/i, 'no reply within 1 s');
  const c3 = await d.getChannelStatus(3);
  assert.equal(c3.muted, false, `channel 3 is ON — got muted=${c3.muted}`);
  // 2) late "OK get …InCh/Fader/On 0 …" for channel 1 must not answer the get for channel 4 (index differs)
  await sleep(300);
  mock.surfaceSet('on:input:0', 0);
  mock.delayNext(1, 1150);
  // A dashboard poll of channel 1 (answered late) overlaps a poll of channel 4.
  const [, c4] = await Promise.all([d.getChannelStatus(1), sleep(500).then(() => d.getChannelStatus(4))]);
  assert.equal(c4.muted, false, `channel 4 is ON — got muted=${c4.muted}`);
  await sleep(1500);
  const s2 = await d.getStatus();
  assert.equal(s2.online, true);
  assert.equal(s2.mainMuted, false);
  const r = await d.unmuteChannel(1);
  assert.equal(r.confirmed, true);
});

// ── Real agent ────────────────────────────────────────────────────────────────
const mixCfg = (port) => ({ mixer: { type: 'yamaha', host: '127.0.0.1', port } });

test('agent: Yamaha stereo master muted at the console → visible + alert ≤ 6 s; unplug → offline ≤ 7.5 s', { timeout: 60000 }, async (t) => {
  const mock = await mk();
  const agent = await startAgent(mixCfg(mock.port));
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.mixer?.connected === true && st.mixer?.mainMuted === false, 15000, 'mixer connected');
  const t0 = Date.now();
  mock.surfaceSet('on:st:0', 0);
  await agent.waitFor((st) => st.mixer?.mainMuted === true, 8000, 'mainMuted visible');
  assert.ok(Date.now() - t0 <= 6000, `mute seen after ${Date.now() - t0}ms`);
  await sleep(300);
  assert.ok(agent.alerts.some((a) => /MUTED/i.test(a.message || a.alert || '')), 'muted alert');
  const n = agent.alerts.length;
  const t1 = Date.now();
  mock.setReachable(false);
  await agent.waitFor((st) => st.mixer?.connected === false, 10000, 'mixer offline');
  assert.ok(Date.now() - t1 <= 7500, `offline after ${Date.now() - t1}ms`);
  await sleep(500);
  assert.ok(!agent.alerts.slice(n).some((a) => /unmuted/i.test(a.message || '')), 'no false unmute alert');
});

// ── Remote engineer via the REAL relay ───────────────────────────────────────
const skipRelay = relayAvailable() ? false : 'relay-server deps not installed';

test('remote: engineer drives a CL through the relay; confirmed results, refusals and offline are truthful', { timeout: 90000, skip: skipRelay }, async (t) => {
  const mock = await mk();
  mock.storeScene(3, 'Worship');
  const loop = await startRelayLoop(mixCfg(mock.port));
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.mixer?.connected === true, 20000, 'relay sees mixer');
  const r1 = await loop.controllerCommand('mixer.mute', { channel: 5 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(mock.get('on:input:4'), 0);
  const r2 = await loop.controllerCommand('mixer.recallScene', { scene: 3 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.doesNotMatch(String(r2.result), /not confirm/i, 'CL recall is confirmed');
  assert.equal(mock.state.currentScene, 3);
  const r3 = await loop.controllerCommand('mixer.recallScene', { scene: 250 });
  assert.ok(r3.error, `empty scene must fail: ${JSON.stringify(r3)}`);
  const r4 = await loop.controllerCommand('mixer.setHpf', { channel: 1, frequency: 100 });
  assert.ok(r4.error, `HPF must be refused: ${JSON.stringify(r4)}`);
  const r5 = await loop.controllerCommand('mixer.muteDca', { dca: 2 });
  assert.equal(r5.error, null, JSON.stringify(r5));
  assert.equal(mock.get('on:dca:1'), 0);
  const h = await loop.httpCommand('mixer.unmute', { channel: 5 }, { wait: true });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(mock.get('on:input:4'), 1);
  const hBad = await loop.httpCommand('mixer.mute', { channel: 99 }, { wait: true });
  assert.equal(hBad.status, 422, JSON.stringify(hBad.body));
  mock.setReachable(false);
  await loop.waitForRelay((st) => st.mixer?.connected === false, 10000, 'relay sees offline');
  const r6 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.ok(r6.error, JSON.stringify(r6));
  assert.equal(mock.get('on:input:0'), 1, 'nothing applied while unplugged');
  mock.setReachable(true);
  await loop.waitForRelay((st) => st.mixer?.connected === true, 12000, 'relay sees back');
  const r7 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.equal(r7.error, null, JSON.stringify(r7));
  assert.equal(mock.get('on:input:0'), 0);
});
