/**
 * SIM PASS — Allen & Heath SQ-5/6/7 (MIDI over TCP, port 51325).
 * Stateful console mock that behaves like the real SQ: remote SETs are silent,
 * GETs (NRPN inc 0x7F) answer, blank scenes don't recall, wrong MIDI channel is
 * ignored, surface changes are transmitted, unplugged = half-open silent socket.
 * Direct driver → real agent (fake relay) → REAL relay remote-engineer loop.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqMock = require('../mocks/sqMixerServer');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

const SRC = process.env.TALLY_MIXER_SRC || path.join(__dirname, '..', '..', 'src');
const { AllenHeathMixer } = require(path.join(SRC, 'mixers', 'allenheath.js'));
const { MixerBridge } = require(path.join(SRC, 'mixerBridge.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNITY = 15196; // SQ linear-taper 0 dB

// Node 20's test runner parses the child's stdout as a v8-serialised stream; a
// driver console.log landing between frames intermittently corrupts it
// ("Unable to deserialize cloned data"). Driver chatter goes to stderr instead.
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

process.env.TALLY_SQ_SETTLE_MS = process.env.TALLY_SQ_SETTLE_MS || '50';
process.env.TALLY_SQ_BATCH_DELAY_MS = process.env.TALLY_SQ_BATCH_DELAY_MS || '20';

const mocks = [];
async function mk(opts) { const m = await sqMock.start({ port: 0, ...opts }); mocks.push(m); return m; }
const drivers = [];
async function drv(mock, extra = {}) {
  const d = new AllenHeathMixer({ host: '127.0.0.1', port: mock.port, midiPort: mock.port, model: 'SQ6', ...extra });
  drivers.push(d);
  await d.connect();
  await sleep(150);
  return d;
}
test.afterEach(async () => { while (drivers.length) { try { await drivers.pop().disconnect(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('SQ mute/unmute/fader/master are confirmed by reading the console back; fader 0.75 = unity like X32', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteChannel(3);
  assert.equal(mock.get('mute:input:2'), 1);
  await d.unmuteChannel(3);
  assert.equal(mock.get('mute:input:2'), 0);
  await d.setFader(4, 0.75);
  assert.equal(mock.get('level:inputToLr:3'), UNITY, '0.75 must land at 0 dB on the SQ');
  await d.setFader(4, 0.5);
  assert.ok(Math.abs(mock.get('level:inputToLr:3') - (UNITY - 10 * 118.775)) < 2, '0.5 = −10 dB');
  await d.muteMaster();
  assert.equal(mock.get('mute:lr:0'), 1);
  const s = await d.getStatus();
  assert.equal(s.online, true);
  assert.equal(s.mainMuted, true);
});

test('SQ console ignores SETs → command FAILS (no fake OK)', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'drop-sets' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(2), /did not apply|did not confirm/i);
  await assert.rejects(d.muteMaster(), /did not apply|did not confirm/i);
  await assert.rejects(d.setFader(1, 0.3), /did not apply|did not confirm/i);
  assert.equal(mock.get('mute:lr:0'), 0);
});

test('SQ read-back that lies (stale) → FAILS', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'stale' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(6), /did not apply|did not confirm/i);
});

test('SQ that accepts TCP but answers nothing → commands fail AND console is reported offline', { timeout: 15000 }, async () => {
  const mock = await mk({ breakMode: 'no-reply' });
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(1), /did not confirm/i);
  assert.equal(await d.isOnline(), false);
  const s = await d.getStatus();
  assert.equal(s.online, false);
  assert.equal(s.mainMuted, null, 'unknown mute must be null, not "unmuted"');
});

test('SQ unplugged (half-open socket) → commands fail, offline, mute unknown', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  assert.equal(await d.isOnline(), true);
  mock.setReachable(false);
  await assert.rejects(d.muteChannel(1), /did not confirm|not connected/i);
  assert.equal(await d.isOnline(), false);
  const s = await d.getStatus();
  assert.equal(s.online, false);
  assert.equal(s.mainMuted, null);
  mock.setReachable(true);
  assert.equal(await d.isOnline(), true, 'recovers when the cable is back');
});

test('SQ bad channel / DCA / scene / SoftKey → error, and NOTHING is sent to channel 1', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(49), /invalid/i);
  await assert.rejects(d.muteChannel('abc'), /invalid/i);
  await assert.rejects(d.muteDca(9), /invalid/i);
  await assert.rejects(d.recallScene(301), /invalid/i);
  await assert.rejects(d.recallScene(0), /invalid/i);
  await assert.rejects(d.pressSoftKey(17), /invalid/i);
  assert.equal(mock.get('mute:input:0'), 0, 'channel 1 untouched');
  assert.equal(mock.state.recalls + mock.state.refusedRecalls, 0);
  const sq5 = await drv(mock, { model: 'SQ5' });
  await assert.rejects(sq5.pressSoftKey(9), /invalid/i, 'SQ-5 has 8 SoftKeys');
});

test('SQ console-surface changes reach Tally (mute keys match the driver\'s own keys)', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  mock.surfaceSet('mute:input:4', 1);
  await sleep(100);
  assert.equal((await d.getChannelStatus(5)).muted, true);
  mock.surfaceSet('mute:lr:0', 1);
  await sleep(100);
  assert.equal((await d.getStatus()).mainMuted, true);
});

test('SQ DCA mute/fader and mute groups are applied and confirmed', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteDca(2);
  assert.equal(mock.get('mute:dca:1'), 1);
  await d.setDcaFader(3, 0.75);
  assert.equal(mock.get('level:dca:2'), UNITY);
  await d.activateMuteGroup(1);
  assert.equal(mock.get('mute:muteGroup:0'), 1);
  await d.deactivateMuteGroup(1);
  assert.equal(mock.get('mute:muteGroup:0'), 0);
});

test('SQ scene recall + SoftKey: really sent, but reported as NOT confirmable (the SQ gives no read-back)', { timeout: 15000 }, async () => {
  const mock = await mk();
  mock.storeScene(5, 'Sunday AM', { 'mute:input:0': 1 });
  const d = await drv(mock);
  const r = await d.recallScene(5);
  assert.equal(r?.confirmed, false);
  assert.equal(mock.state.currentScene, 5);
  assert.equal(mock.get('mute:input:0'), 1, 'scene contents applied');
  const r2 = await d.recallScene(200);         // blank on the console
  assert.equal(r2?.confirmed, false, 'blank scene cannot be told apart → never claimed as done');
  assert.equal(mock.state.refusedRecalls, 1);
  const k = await d.pressSoftKey(3);
  assert.equal(k?.confirmed, false);
  await sleep(100); // bytes are on the wire; let the console process the Note Off
  assert.deepEqual(mock.state.softKeys.map((e) => [e.key, e.on]), [[3, true], [3, false]]);
});

test('SQ functions with no MIDI mapping refuse honestly (no OSC fiction)', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await assert.rejects(d.setChannelName(1, 'Pastor'), /not available/i);
  await assert.rejects(d.setHpf(1, { frequency: 100 }), /not available/i);
  await assert.rejects(d.saveScene(3, 'x'), /not available/i);
  await assert.rejects(d.clearSolos(), /not available/i);
  const strip = await d.setFullChannelStrip(2, { name: 'Choir', hpf: { frequency: 80 }, fader: 0.75, mute: false });
  assert.ok(strip.skipped.includes('name') && strip.skipped.includes('hpf'), JSON.stringify(strip));
  assert.ok(!strip.applied.includes('name') && !strip.applied.includes('hpf'));
});

test('SQ MIDI channel mismatch → console ignores Tally → failure that names the MIDI channel', { timeout: 15000 }, async () => {
  const mock = await mk();
  mock.setMidiChannel(2);
  const d = await drv(mock, { midiChannel: 0 });
  await assert.rejects(d.muteChannel(1), /MIDI channel 1/);
  assert.equal(await d.isOnline(), false);
  const ok = await drv(mock, { midiChannel: 2 });
  await ok.muteChannel(1);
  assert.equal(mock.get('mute:input:0'), 1);
});

test('MixerBridge "allenheath": single port (or legacy 51326) reaches the SQ over TCP MIDI; model exposed for caps', { timeout: 15000 }, async () => {
  const mock = await mk();
  const b = new MixerBridge({ type: 'allenheath', host: '127.0.0.1', port: mock.port, model: 'SQ6' });
  drivers.push(b);
  await b.connect();
  await sleep(150);
  const s = await b.getStatus();
  assert.equal(s.online, true);
  assert.equal(b.model, 'SQ6');
  const legacy = new AllenHeathMixer({ host: '10.0.0.1', port: 51326 });
  assert.equal(legacy.port, 51325, 'stored OSC port 51326 is mapped to the real MIDI port');
});

// ── Real agent (fake relay) ──────────────────────────────────────────────────
const mixCfg = (port) => ({ mixer: { type: 'allenheath', host: '127.0.0.1', port, midiPort: port, model: 'SQ6' } });

test('agent: SQ master muted at the console → visible + alert ≤ 6 s; unplug → offline ≤ 7.5 s, no false "unmuted"', { timeout: 60000 }, async (t) => {
  const mock = await mk();
  const agent = await startAgent(mixCfg(mock.port), { env: { TALLY_SQ_SETTLE_MS: '50', TALLY_SQ_BATCH_DELAY_MS: '20' } });
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.mixer?.connected === true && st.mixer?.mainMuted === false, 15000, 'mixer connected');
  const t0 = Date.now();
  mock.surfaceSet('mute:lr:0', 1);
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

test('remote: engineer drives the SQ through the relay; refusals, unconfirmable actions and offline are reported truthfully', { timeout: 90000, skip: skipRelay }, async (t) => {
  const mock = await mk();
  mock.storeScene(3, 'Worship');
  const loop = await startRelayLoop(mixCfg(mock.port), { env: { TALLY_SQ_SETTLE_MS: '50', TALLY_SQ_BATCH_DELAY_MS: '20' } });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.mixer?.connected === true, 20000, 'relay sees mixer');

  const r1 = await loop.controllerCommand('mixer.mute', { channel: 5 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(mock.get('mute:input:4'), 1, 'channel 5 really muted');

  const r2 = await loop.controllerCommand('mixer.recallScene', { scene: 3 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.match(String(r2.result), /not confirm/i, 'engineer is told the SQ cannot confirm recalls');
  assert.equal(mock.state.currentScene, 3);

  const r3 = await loop.controllerCommand('mixer.setChannelName', { channel: 1, name: 'Pastor' });
  assert.ok(r3.error, `no-OSC SQ must refuse naming: ${JSON.stringify(r3)}`);

  const h = await loop.httpCommand('mixer.unmute', { channel: 5 }, { wait: true });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.completed, true);
  assert.equal(mock.get('mute:input:4'), 0);
  const hBad = await loop.httpCommand('mixer.mute', { channel: 60 }, { wait: true });
  assert.equal(hBad.status, 422, JSON.stringify(hBad.body));
  assert.equal(mock.get('mute:input:0'), 0, 'bad channel did not mute channel 1');

  mock.setReachable(false);
  await loop.waitForRelay((st) => st.mixer?.connected === false, 10000, 'relay sees mixer offline');
  const r5 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.ok(r5.error, `unplugged console must fail: ${JSON.stringify(r5)}`);
  mock.setReachable(true);
  await loop.waitForRelay((st) => st.mixer?.connected === true, 12000, 'relay sees mixer back');
  const r6 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.equal(r6.error, null, JSON.stringify(r6));
  assert.equal(mock.get('mute:input:0'), 1);
});
