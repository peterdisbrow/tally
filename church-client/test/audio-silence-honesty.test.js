/**
 * Audio / silence monitoring honesty (sim pass — audio is core).
 *  - A REAL ATEM never fills state.audio.master with levels: Fairlight models
 *    only send levels (FDLv) after startFairlightMixerSendLevels(), delivered
 *    via the 'levelChanged' event. Tally must subscribe and use them.
 *  - The 15 s silence alert must not reset the silence clock (the 30 s
 *    failover signal has to fire at 30 s, not ~45 s).
 *  - Stale levels (ATEM stopped sending) are not "audio present".
 *  - Streaming with no level source must say so (coverage: 'none'), not look
 *    like "monitoring, all quiet is fine".
 *  - Audio coming back after a silence alert is reported.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const SRC = process.env.TALLY_AUDIO_SRC || path.join(__dirname, '..', 'src');
const { AudioMonitor } = require(path.join(SRC, 'audioMonitor.js'));

let now = 1_000_000;
const realNow = Date.now;
test.beforeEach(() => { now = 1_000_000; Date.now = () => now; });
test.afterEach(() => { Date.now = realNow; });

function realAtemAgent({ levels = null } = {}) {
  const msgs = [];
  const agent = {
    status: { obs: { streaming: true, connected: false }, atem: { connected: true } },
    // Real atem-connection state for a Fairlight ATEM: no master levels in state.
    atem: { state: { audio: undefined, fairlight: { master: { faderGain: 0 }, inputs: {} } } },
    atemAudioLevels: levels,
    sendToRelay: (m) => msgs.push(m),
    msgs,
  };
  return agent;
}
const fl = (db) => ({ t: Date.now(), leftDb: db, rightDb: db, source: 'fairlight' });

test('real Fairlight ATEM levels (levelChanged) are used as the audio source', async () => {
  const agent = realAtemAgent({ levels: fl(-18) });
  const m = new AudioMonitor(); m.agent = agent;
  await m.tick();
  const s = m.getStatus();
  assert.equal(s.source, 'atem');
  assert.equal(Math.round(s.lastLevelDb), -18);
});

test('silence alert at 15 s does not reset the clock: failover signal at 30 s', async () => {
  const agent = realAtemAgent({ levels: fl(-80) });
  const m = new AudioMonitor(); m.agent = agent;
  for (let t = 0; t <= 31; t += 1) { now = 1_000_000 + t * 1000; agent.atemAudioLevels = fl(-80); await m.tick(); }
  assert.ok(agent.msgs.some((x) => x.type === 'alert' && x.alertType === 'audio_silence'), 'silence alert sent');
  assert.ok(agent.msgs.some((x) => x.type === 'signal_event' && x.signal === 'audio_silence_sustained'), 'failover signal at 30 s');
  assert.ok(m.getStatus().silenceDurationSec >= 30, `silence duration ${m.getStatus().silenceDurationSec}`);
});

test('legacy level path: 15 s alert does not push the 30 s failover signal back', async () => {
  const msgs = [];
  const agent = { status: { obs: { streaming: true }, atem: { connected: true } }, atem: { state: { audio: { master: { left: 0, right: 0 } } } }, sendToRelay: (x) => msgs.push(x) };
  const m = new AudioMonitor(); m.agent = agent;
  for (let t = 0; t <= 31; t += 1) { now = 1_000_000 + t * 1000; await m.tick(); }
  assert.ok(msgs.some((x) => x.alertType === 'audio_silence'), 'alert at 15 s');
  assert.ok(msgs.some((x) => x.signal === 'audio_silence_sustained'), 'failover signal by 31 s');
});

test('stale levels (ATEM stopped sending) are not treated as live audio', async () => {
  const agent = realAtemAgent({ levels: fl(-10) });
  const m = new AudioMonitor(); m.agent = agent;
  now += 10_000; // last level is 10 s old
  await m.tick();
  const s = m.getStatus();
  assert.equal(s.source, null, 'stale meter is not a source');
  assert.equal(s.coverage, 'none');
});

test('streaming with no level source → coverage "none" (honest), not silently fine', async () => {
  const agent = realAtemAgent({ levels: null });
  const m = new AudioMonitor(); m.agent = agent;
  await m.tick();
  const s = m.getStatus();
  assert.equal(s.source, null);
  assert.equal(s.coverage, 'none');
});

test('audio returns after a silence alert → "audio restored" is reported', async () => {
  const agent = realAtemAgent({ levels: fl(-80) });
  const m = new AudioMonitor(); m.agent = agent;
  for (let t = 0; t <= 17; t += 1) { now = 1_000_000 + t * 1000; agent.atemAudioLevels = fl(-80); await m.tick(); }
  assert.ok(agent.msgs.some((x) => x.alertType === 'audio_silence'));
  now += 1000; agent.atemAudioLevels = fl(-12); await m.tick();
  assert.ok(agent.msgs.some((x) => x.type === 'alert' && /restored|back/i.test(x.message || '')), JSON.stringify(agent.msgs.map((x) => x.message || x.signal)));
});

test('ATEM switcher subscribes to Fairlight levels on connect and exposes master level in dB', async (t) => {
  const { AtemSwitcher } = require(path.join(SRC, 'switchers', 'atemSwitcher.js'));
  const sw = new AtemSwitcher({ id: 'a1', ip: '' });
  const fake = new EventEmitter();
  let subscribed = 0;
  fake.state = { info: {}, video: { mixEffects: [] }, fairlight: { master: {}, inputs: {} } };
  fake.startFairlightMixerSendLevels = async () => { subscribed++; };
  fake.destroy = () => {};
  sw._atem = fake;
  t.after(() => { sw._stopping = true; clearTimeout(sw._stabilityTimer); clearInterval(sw._timecodeInterval); });
  sw._attachEventHandlers();
  fake.emit('connected');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(subscribed, 1, 'startFairlightMixerSendLevels() called');
  fake.emit('levelChanged', { system: 'fairlight', type: 'master', levels: { outputLeftLevel: -1850, outputRightLevel: -2000, leftLevel: -1850, rightLevel: -2000 } });
  const lv = sw.getAudioLevels();
  assert.equal(lv.leftDb, -18.5);
  assert.equal(lv.rightDb, -20);
  sw._stopping = true; // no real reconnect in a unit test
  fake.emit('disconnected');
  assert.equal(sw.getAudioLevels(), null, 'no levels once disconnected');
});
