/**
 * SIM PASS — Allen & Heath dLive + Avantis (MIDI over TCP, MixRack port 51325).
 * Stateful console mock that behaves like the real desks: remote SETs are silent,
 * dLive answers Get Mute / Get Fader / Get HPF, Avantis answers only name/colour
 * requests, velocity-00 mutes are ignored, blank scenes don't recall, the wrong
 * base MIDI channel is ignored, unplugged = half-open silent socket.
 * Direct driver → real agent (fake relay) → REAL relay remote-engineer loop.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ahMock = require('../mocks/ahMidiServer');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

const SRC = process.env.TALLY_MIXER_SRC || path.join(__dirname, '..', '..', 'src');
const { AvantisMixer } = require(path.join(SRC, 'mixers', 'avantis.js'));
const { MixerBridge } = require(path.join(SRC, 'mixerBridge.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNITY = 0x6B; // A&H LV 0 dB

// Node 20's test runner parses the child's stdout as a v8 stream; route driver chatter to stderr.
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const mocks = [];
async function mk(opts) { const m = await ahMock.start({ port: 0, model: 'dLive', ...opts }); mocks.push(m); return m; }
const drivers = [];
async function drv(mock, extra = {}) {
  const d = new AvantisMixer({ host: '127.0.0.1', port: mock.port, model: mock.model, ...extra });
  drivers.push(d);
  await d.connect();
  await sleep(100);
  return d;
}
test.afterEach(async () => { while (drivers.length) { try { await drivers.pop().disconnect(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('dLive mute/unmute/fader are confirmed by Get read-back; unmute really unmutes; 0.75 = 0 dB (LV 6B)', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  const r = await d.muteChannel(3);
  assert.equal(r?.confirmed, true);
  assert.equal(mock.get('mute:input:2'), true);
  await d.unmuteChannel(3);
  assert.equal(mock.get('mute:input:2'), false, 'unmute must use velocity 3F — the console ignores velocity 00');
  await d.setFader(4, 0.75);
  assert.equal(mock.get('fader:input:3'), UNITY, '0.75 must land at 0 dB like X32/SQ');
  await d.setFader(4, 1.0);
  assert.equal(mock.get('fader:input:3'), 0x7F, '+10 dB');
  await d.setFader(4, 0.5);
  assert.ok(Math.abs(mock.get('fader:input:3') - 0x57) <= 1, `0.5 = −10 dB (57), got ${mock.get('fader:input:3')}`);
  await d.setFader(4, 0);
  assert.equal(mock.get('fader:input:3'), 0, '−inf');
});

test('dLive master mute hits MAIN 1 (N+4 note 30), not Mono Aux 1; getStatus reads it back', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteMaster();
  assert.equal(mock.get('mute:main:0'), true, 'Main 1 muted');
  assert.equal(mock.get('mute:aux:0'), false, 'Aux 1 untouched');
  const s = await d.getStatus();
  assert.equal(s.online, true);
  assert.equal(s.mainMuted, true);
  assert.equal(s.mainFader, 0.75, 'main fader read back at 0 dB');
  await d.unmuteMaster();
  assert.equal(mock.get('mute:main:0'), false);
});

test('DCA (notes 36+) and mute groups (dLive 4E+, Avantis 46+) hit the right targets, not FX sends', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await d.muteDca(2);
  assert.equal(mock.get('mute:dca:1'), true);
  assert.equal(mock.state.mutes['fxSend:1'], undefined, 'FX send 2 untouched');
  await d.setDcaFader(3, 0.75);
  assert.equal(mock.get('fader:dca:2'), UNITY);
  await d.activateMuteGroup(1);
  assert.equal(mock.get('mute:muteGroup:0'), true);
  await d.deactivateMuteGroup(1);
  assert.equal(mock.get('mute:muteGroup:0'), false);
  const av = await mk({ model: 'Avantis' });
  const a = await drv(av);
  const r = await a.activateMuteGroup(2);
  assert.equal(r?.confirmed, false);
  await sleep(50);
  assert.equal(av.get('mute:muteGroup:1'), true, 'Avantis mute group 2 = note 47');
});

test('dLive that ignores SETs → FAILS; read-back that lies (stale) → FAILS', { timeout: 15000 }, async () => {
  const m1 = await mk({ breakMode: 'drop-sets' });
  const d1 = await drv(m1);
  await assert.rejects(d1.muteChannel(2), /did not apply|did not confirm/i);
  await assert.rejects(d1.muteMaster(), /did not apply|did not confirm/i);
  await assert.rejects(d1.setFader(1, 0.3), /did not apply|did not confirm/i);
  await assert.rejects(d1.setChannelName(1, 'Pastor'), /did not apply|did not confirm/i);
  const m2 = await mk({ breakMode: 'stale' });
  const d2 = await drv(m2);
  await assert.rejects(d2.muteChannel(6), /did not apply|did not confirm/i);
  await assert.rejects(d2.setFader(6, 0.2), /did not apply|did not confirm/i);
});

test('console that accepts TCP but answers nothing → commands fail AND reported offline (dLive + Avantis)', { timeout: 15000 }, async () => {
  const m = await mk({ breakMode: 'no-reply' });
  const d = await drv(m);
  await assert.rejects(d.muteChannel(1), /did not confirm/i);
  assert.equal(await d.isOnline(), false);
  const s = await d.getStatus();
  assert.equal(s.online, false);
  assert.equal(s.mainMuted, null, 'unknown mute must be null, not "unmuted"');
  const av = await mk({ model: 'Avantis', breakMode: 'no-reply' });
  const a = await drv(av);
  assert.equal(await a.isOnline(), false);
  await assert.rejects(a.muteChannel(1), /not connected|not answering/i);
  assert.equal(av.get('mute:input:0'), false);
});

test('unplugged (half-open socket) → commands fail, offline, mute unknown; recovers on replug', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  assert.equal(await d.isOnline(), true);
  mock.setReachable(false);
  await assert.rejects(d.muteChannel(1), /did not confirm|not connected/i);
  assert.equal(await d.isOnline(), false);
  assert.equal((await d.getStatus()).mainMuted, null);
  mock.setReachable(true);
  assert.equal(await d.isOnline(), true, 'recovers when the cable is back');
  await d.muteChannel(1);
  assert.equal(mock.get('mute:input:0'), true);
});

test('bad channel / DCA / mute group / scene / level → error, NOTHING sent (dLive 128 in, Avantis 64 in)', { timeout: 15000 }, async () => {
  const mock = await mk();
  const d = await drv(mock);
  await assert.rejects(d.muteChannel(129), /invalid/i);
  await assert.rejects(d.muteChannel('abc'), /invalid/i);
  await assert.rejects(d.muteChannel(0), /invalid/i);
  await assert.rejects(d.muteDca(25), /invalid/i);
  await assert.rejects(d.activateMuteGroup(9), /invalid/i);
  await assert.rejects(d.recallScene(501), /invalid/i);
  await assert.rejects(d.recallScene(0), /invalid/i);
  await assert.rejects(d.setFader(1, 1.5), /invalid/i);
  await d.muteChannel(128);
  assert.equal(mock.get('mute:input:127'), true, 'dLive has 128 inputs');
  assert.equal(mock.get('mute:input:0'), false, 'channel 1 untouched');
  assert.equal(mock.state.recalls + mock.state.refusedRecalls, 0);
  const av = await mk({ model: 'Avantis' });
  const a = await drv(av);
  await assert.rejects(a.muteChannel(65), /invalid/i);
  await assert.rejects(a.muteDca(17), /invalid/i);
  assert.equal(av.state.sets, 0);
});

test('base MIDI channel: bridge passes midiChannel; mismatch fails naming the channel; 13–16 refused', { timeout: 15000 }, async () => {
  const mock = await mk();
  mock.setBaseChannel(2);                                   // console set to MIDI ch 3
  const wrong = await drv(mock);                            // Tally default = ch 12
  await assert.rejects(wrong.muteChannel(1), /MIDI base channel 12/);
  assert.equal(await wrong.isOnline(), false);
  const b = new MixerBridge({ type: 'dlive', host: '127.0.0.1', port: mock.port, midiChannel: 2 });
  drivers.push(b);
  await b.connect();
  await sleep(100);
  assert.equal((await b.getStatus()).online, true, 'bridge honours midiChannel');
  await b.muteChannel(1);
  assert.equal(mock.get('mute:input:0'), true);
  const bad = await drv(mock, { midiChannel: 13 });
  assert.equal(await bad.isOnline(), false);
  await assert.rejects(bad.muteChannel(1), /1–12/);
});

test('Avantis (no Get in its protocol): sets go out only after a live round-trip and are reported NOT confirmed', { timeout: 15000 }, async () => {
  const av = await mk({ model: 'Avantis' });
  const a = await drv(av);
  assert.equal(await a.isOnline(), true);
  const r1 = await a.muteChannel(5);
  assert.equal(r1?.confirmed, false);
  assert.match(r1.reason, /read-back/i);
  const r2 = await a.setFader(5, 0.75);
  assert.equal(r2?.confirmed, false);
  const r3 = await a.muteMaster();
  assert.equal(r3?.confirmed, false);
  await sleep(50);
  assert.equal(av.get('mute:input:4'), true);
  assert.equal(av.get('fader:input:4'), UNITY);
  assert.equal(av.get('mute:main:0'), true);
  const s = await a.getStatus();
  assert.equal(s.online, true);
  assert.equal(s.mainMuted, null, 'Avantis cannot read master mute → unknown, never a guess');
  av.setReachable(false);
  await assert.rejects(a.muteChannel(6), /not answering|NOT sent/i);
  await sleep(50);
  assert.equal(av.get('mute:input:5'), false, 'nothing applied while unplugged');
  assert.equal(await a.isOnline(), false);
});

test('names and colours are read back on both consoles; bad names/colours refused', { timeout: 15000 }, async () => {
  for (const model of ['dLive', 'Avantis']) {
    const m = await mk({ model });
    const d = await drv(m);
    const r = await d.setChannelName(2, 'Pastor');
    assert.equal(r?.confirmed, true, model);
    assert.equal(m.get('name:input:1'), 'Pastor');
    await assert.rejects(d.setChannelName(2, 'Worship Leader'), /invalid/i, `${model}: > 8 chars`);
    await d.setChannelColor(2, 'green');
    assert.equal(m.get('color:input:1'), 2);
    await assert.rejects(d.setChannelColor(2, 'magenta'), /invalid/i);
    assert.equal(m.get('color:input:1'), 2, 'bad colour did not reset to off');
  }
});

test('HPF: dLive applies + reads back; Avantis refuses; pan refuses on both and never touches main-mix assign', { timeout: 15000 }, async () => {
  const m = await mk();
  const d = await drv(m);
  await d.setHpf(1, { enabled: true, frequency: 100 });
  const h = m.get('hpf:input:0');
  assert.equal(h.on, true);
  const want = Math.floor((127 * (4608 * Math.log2(100 / 4) - 10699)) / 41314); // dLive V2.0 HPF formula
  assert.equal(h.vv, want, `100 Hz → ${want}, got ${h.vv}`);
  await assert.rejects(d.setHpf(1, { frequency: 5000 }), /invalid/i);
  await assert.rejects(d.setPan(1, -1), /not available/i);
  assert.equal(m.get('mainAssign:input:0'), true, 'channel still assigned to main');
  const av = await mk({ model: 'Avantis' });
  const a = await drv(av);
  await assert.rejects(a.setHpf(1, { frequency: 100 }), /not available/i);
  await assert.rejects(a.setPan(1, -1), /not available/i);
  assert.equal(av.get('mainAssign:input:0'), true);
  const strip = await a.setFullChannelStrip(3, { name: 'Choir', hpf: { frequency: 80 }, pan: 0.2, fader: 0.75 });
  assert.ok(strip.skipped.includes('hpf') && strip.skipped.includes('pan'), JSON.stringify(strip));
  assert.ok(strip.unconfirmed.includes('fader'), JSON.stringify(strip));
});

test('scene recall: really sent, reported NOT confirmed; blank scene not claimed; dLive Surface port refuses', { timeout: 15000 }, async () => {
  const m = await mk();
  m.storeScene(130, 'Worship', { 'mute:input:0': true });
  const d = await drv(m);
  const r = await d.recallScene(130);
  assert.equal(r?.confirmed, false);
  assert.equal(m.state.currentScene, 130, 'bank 1 + program 1');
  assert.equal(m.get('mute:input:0'), true);
  const r2 = await d.recallScene(200);
  assert.equal(r2?.confirmed, false);
  assert.equal(m.state.refusedRecalls, 1);
  await assert.rejects(d.saveScene(3), /not available/i);
  await assert.rejects(d.clearSolos(), /not available/i);
  await assert.rejects(d.pressSoftKey(1), /not available/i);
  const surf = await mk({ surface: true });
  const s = new AvantisMixer({ host: '127.0.0.1', port: 51328, model: 'dLive' });
  s._tcp.port = surf.port; drivers.push(s); await s.connect(); await sleep(100);
  await assert.rejects(s.recallScene(1), /MixRack/);
});

test('console-surface changes reach Tally; a trailing velocity-00 is not read as "unmuted"', { timeout: 15000 }, async () => {
  for (const model of ['dLive', 'Avantis']) {
    const m = await mk({ model });
    const d = await drv(m);
    m.surfaceSet('mute:main:0', 1);
    await sleep(100);
    assert.equal((await d.getStatus()).mainMuted, true, model);
    m.surfaceSet('mute:input:4', 1);
    await sleep(100);
    assert.equal((await d.getChannelStatus(5)).muted, true, model);
    m.surfaceSet('fader:input:4', UNITY);
    await sleep(100);
    assert.equal((await d.getChannelStatus(5)).fader, 0.75, model);
  }
});

// ── Real agent (fake relay) ──────────────────────────────────────────────────
const mixCfg = (port, type = 'dlive') => ({ mixer: { type, host: '127.0.0.1', port, model: type === 'dlive' ? 'dLive' : 'Avantis' } });

test('agent: dLive main muted at the console → visible + alert ≤ 6 s; unplug → offline ≤ 7.5 s, no false "unmuted"', { timeout: 60000 }, async (t) => {
  const mock = await mk();
  const agent = await startAgent(mixCfg(mock.port));
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.mixer?.connected === true && st.mixer?.mainMuted === false, 15000, 'mixer connected');
  const t0 = Date.now();
  mock.surfaceSet('mute:main:0', 1);
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

test('remote: engineer drives dLive through the relay; refusals, unconfirmable actions and offline are truthful', { timeout: 90000, skip: skipRelay }, async (t) => {
  const mock = await mk();
  mock.storeScene(3, 'Worship');
  const loop = await startRelayLoop(mixCfg(mock.port));
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.mixer?.connected === true, 20000, 'relay sees mixer');

  const r1 = await loop.controllerCommand('mixer.mute', { channel: 5 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.doesNotMatch(String(r1.result), /not confirm/i, 'dLive mute is confirmed');
  assert.equal(mock.get('mute:input:4'), true);

  const r2 = await loop.controllerCommand('mixer.recallScene', { scene: 3 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.match(String(r2.result), /not confirm/i);
  assert.equal(mock.state.currentScene, 3);

  const r3 = await loop.controllerCommand('mixer.setPan', { channel: 1, pan: -0.5 });
  assert.ok(r3.error, `pan must be refused: ${JSON.stringify(r3)}`);
  assert.equal(mock.get('mainAssign:input:0'), true);

  const r4 = await loop.controllerCommand('mixer.setChannelName', { channel: 1, name: 'Pastor' });
  assert.equal(r4.error, null, JSON.stringify(r4));
  assert.equal(mock.get('name:input:0'), 'Pastor');

  const h = await loop.httpCommand('mixer.unmute', { channel: 5 }, { wait: true });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(mock.get('mute:input:4'), false);
  const hBad = await loop.httpCommand('mixer.mute', { channel: 200 }, { wait: true });
  assert.equal(hBad.status, 422, JSON.stringify(hBad.body));
  assert.equal(mock.get('mute:input:0'), false);

  mock.setReachable(false);
  await loop.waitForRelay((st) => st.mixer?.connected === false, 10000, 'relay sees mixer offline');
  const r5 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.ok(r5.error, `unplugged console must fail: ${JSON.stringify(r5)}`);
  assert.equal(mock.get('mute:input:0'), false);
  mock.setReachable(true);
  await loop.waitForRelay((st) => st.mixer?.connected === true, 12000, 'relay sees mixer back');
  const r6 = await loop.controllerCommand('mixer.mute', { channel: 1 });
  assert.equal(r6.error, null, JSON.stringify(r6));
  assert.equal(mock.get('mute:input:0'), true);
});

test('remote: engineer on an Avantis is told mutes/faders are sent-not-confirmed; unplugged → refused, nothing applied', { timeout: 90000, skip: skipRelay }, async (t) => {
  const mock = await mk({ model: 'Avantis' });
  const loop = await startRelayLoop(mixCfg(mock.port, 'avantis'));
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.mixer?.connected === true, 20000, 'relay sees mixer');
  const r1 = await loop.controllerCommand('mixer.mute', { channel: 2 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.match(String(r1.result), /sent — not confirmed/i);
  await sleep(50);
  assert.equal(mock.get('mute:input:1'), true);
  const r2 = await loop.controllerCommand('mixer.setFader', { channel: 2, level: 0.75 });
  assert.match(String(r2.result), /not confirmed/i, JSON.stringify(r2));
  const r3 = await loop.controllerCommand('mixer.setHpf', { channel: 2, frequency: 100 });
  assert.ok(r3.error, `Avantis HPF must be refused: ${JSON.stringify(r3)}`);
  mock.setReachable(false);
  await loop.waitForRelay((st) => st.mixer?.connected === false, 10000, 'relay sees Avantis offline');
  const r4 = await loop.controllerCommand('mixer.mute', { channel: 3 });
  assert.ok(r4.error, JSON.stringify(r4));
  assert.equal(mock.get('mute:input:2'), false);
});
