/**
 * SIM PASS — OBS, remote engineer path end to end:
 *   engineer (controller WS / admin HTTP {wait:true}) → REAL relay → REAL agent
 *   → protocol-faithful obs-websocket v5 mock (test/mocks/obsServer.js).
 * Asserts what the engineer actually gets: confirmed results, OBS's own
 * refusals, an accepted-then-failed stream start, OBS crashed / frozen.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const obsMock = require('../mocks/obsServer');
const { freePort } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const skipRelay = !relayAvailable() && 'relay-server not installed';
const mocks = [];
async function mk(opts = {}) { const m = await obsMock.start({ port: 0, password: 'booth-pw', ...opts }); mocks.push(m); return m; }
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });
const pace = () => new Promise((r) => setTimeout(r, 350));
const ctl = (m, action, args = {}) => fetch(`${m.control.url}/action`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }),
}).then((r) => r.json());

async function upLoop(t, m) {
  const loop = await startRelayLoop({ obsUrl: m.url, obsPassword: 'booth-pw' });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.obs?.connected === true && st.obs?.currentScene === 'Scene 1', 25000, 'relay sees OBS on Scene 1');
  const cmd = async (c, p = {}) => { await pace(); return loop.controllerCommand(c, p, 15000); };
  const http = async (c, p = {}) => { await pace(); return loop.httpCommand(c, p, { wait: true, timeoutMs: 15000 }); };
  return { loop, cmd, http };
}

test('remote: scene, stream and record commands are applied by OBS and confirmed; OBS refusals come back as errors', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd, http } = await upLoop(t, m);

  const r1 = await cmd('obs.setScene', { scene: 'Scene 3' });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(m.state.programScene, 'Scene 3');
  await loop.waitForRelay((st) => st.obs.currentScene === 'Scene 3', 5000, 'relay shows Scene 3');

  const r2 = await cmd('obs.setScene', { scene: 'No Such Scene' });
  assert.ok(r2.error, JSON.stringify(r2));
  assert.match(String(r2.error), /not found|No Such Scene|600/i);
  assert.equal(m.state.programScene, 'Scene 3');

  const r3 = await cmd('obs.startStream', {});
  assert.equal(r3.error, null, JSON.stringify(r3));
  assert.equal(m.state.streaming.outputActive, true);
  await loop.waitForRelay((st) => st.obs.streaming === true, 5000, 'relay shows OBS live');
  const r4 = await cmd('obs.startStream', {});
  assert.ok(r4.error, `second start must carry OBS's "already running": ${JSON.stringify(r4)}`);
  const r5 = await cmd('obs.stopStream', {});
  assert.equal(r5.error, null, JSON.stringify(r5));
  assert.equal(m.state.streaming.outputActive, false);

  const r6 = await cmd('obs.startRecording', {});
  assert.equal(r6.error, null, JSON.stringify(r6));
  assert.equal(m.state.recording.outputActive, true);
  const r7 = await cmd('obs.stopRecording', {});
  assert.equal(r7.error, null, JSON.stringify(r7));
  assert.equal(m.state.recording.outputActive, false);

  const h = await http('obs.setScene', { scene: 'Nope' });
  assert.equal(h.status, 422, `${h.status} ${JSON.stringify(h.body)}`);
  const h2 = await http('obs.setScene', { scene: 'Scene 2' });
  assert.equal(h2.status, 200, JSON.stringify(h2.body));
  assert.equal(m.state.programScene, 'Scene 2');
});

test('remote: OBS accepts StartStream but the stream fails (bad key / ingest down) → refusal, never "Stream started"', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd, http } = await upLoop(t, m);
  await ctl(m, 'setStreamFailure', { reason: 'bad key' });
  const r1 = await cmd('obs.startStream', {});
  assert.ok(r1.error, `OBS never went live but Tally said: ${JSON.stringify(r1)}`);
  assert.equal(m.state.streaming.outputActive, false);
  const st = (await loop.relayStatus()).status;
  assert.notEqual(st.obs.streaming, true, 'relay must not show LIVE');

  await ctl(m, 'setRecordFailure', { reason: 'disk full' });
  const h = await http('obs.startRecording', {});
  assert.equal(h.status, 422, `record that never started: ${h.status} ${JSON.stringify(h.body)}`);

  // Slow but good start: confirmed only once OBS reports STARTED.
  await ctl(m, 'setStreamFailure', { reason: '' });
  await ctl(m, 'setOutputStartMs', { ms: 1500 });
  const r2 = await cmd('obs.startStream', {});
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.streaming.outputActive, true, 'result arrived before OBS was actually live');
});

test('remote: OBS crashed → honest offline, commands refused fast; OBS back → commands work', { timeout: 150000, skip: skipRelay }, async (t) => {
  const port = await freePort();
  let m = await mk({ port });
  const { loop, cmd, http } = await upLoop(t, m);
  await m.stop();
  await loop.waitForRelay((st) => st.obs?.connected === false, 8000, 'relay sees OBS offline');
  const r1 = await cmd('obs.setScene', { scene: 'Scene 2' });
  assert.match(String(r1.error), /not connected/i, JSON.stringify(r1));
  assert.ok(r1.ms < 3000, `refusal took ${r1.ms}ms`);
  const h = await http('obs.startStream', {});
  assert.equal(h.status, 422, `${h.status} ${JSON.stringify(h.body)}`);

  m = await mk({ port });
  await loop.waitForRelay((st) => st.obs?.connected === true, 20000, 'relay sees OBS back');
  const r2 = await cmd('obs.setScene', { scene: 'Scene 2' });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.programScene, 'Scene 2');
});

test('remote: OBS frozen (socket open, nothing answers) → command fails with a reason in seconds, OBS shown offline, recovers on thaw', { timeout: 150000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd } = await upLoop(t, m);
  m.freeze();
  const r1 = await cmd('obs.setScene', { scene: 'Scene 2' });
  assert.ok(!r1.timedOut, `engineer got no answer from a frozen OBS within ${r1.ms}ms`);
  assert.ok(r1.error, `frozen OBS reported as done: ${JSON.stringify(r1)}`);
  assert.match(String(r1.error), /not answer|not respond|timed out|frozen/i);
  assert.ok(r1.ms <= 9000, `took ${r1.ms}ms`);
  await loop.waitForRelay((st) => st.obs?.connected === false, 20000, 'relay sees frozen OBS as offline');
  m.thaw();
  await loop.waitForRelay((st) => st.obs?.connected === true, 25000, 'relay sees OBS back after thaw');
  const r2 = await cmd('obs.setScene', { scene: 'Scene 3' });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.programScene, 'Scene 3');
});

test('remote: Equipment-UI OBS encoder — encoder.startStream/stopStream really drive OBS and report the truth', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const port = Number(new URL(m.url).port);
  const loop = await startRelayLoop({ obsUrl: m.url, obsPassword: 'booth-pw', encoder: { type: 'obs', host: '127.0.0.1', port, password: 'booth-pw', label: '', statusUrl: '', source: '' } });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.obs?.connected === true && st.encoder?.connected === true, 25000, 'relay sees OBS encoder');
  const cmd = async (c, p = {}) => { await pace(); return loop.controllerCommand(c, p, 15000); };

  const r1 = await cmd('encoder.startStream', {});
  assert.equal(m.state.streaming.outputActive, true, 'OBS is live');
  assert.equal(r1.error, null, `OBS went live but the engineer was told: ${JSON.stringify(r1)}`);
  await loop.waitForRelay((st) => st.encoder?.live === true, 5000, 'relay shows encoder LIVE');
  const r2 = await cmd('encoder.stopStream', {});
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.streaming.outputActive, false);

  const r4 = await cmd('encoder.startRecording', {});
  assert.equal(r4.error, null, `OBS can record; engineer was told: ${JSON.stringify(r4)}`);
  assert.equal(m.state.recording.outputActive, true);
  const r5 = await cmd('encoder.stopRecording', {});
  assert.equal(r5.error, null, JSON.stringify(r5));
  assert.equal(m.state.recording.outputActive, false);

  await ctl(m, 'setStreamFailure', { reason: 'ingest down' });
  const r3 = await cmd('encoder.startStream', {});
  assert.ok(r3.error, `failed stream reported as started: ${JSON.stringify(r3)}`);
  assert.equal(m.state.streaming.outputActive, false);
});

test('remote: OBS freezes while nobody is sending commands → shown offline ≤ 15 s (no stale "connected"/LIVE)', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop } = await upLoop(t, m);
  await ctl(m, 'setStreaming', { active: true });
  await loop.waitForRelay((st) => st.obs.streaming === true, 6000, 'relay shows OBS live');
  const t0 = Date.now();
  m.freeze();
  await loop.waitForRelay((st) => st.obs?.connected === false && st.obs?.streaming !== true, 25000, 'relay sees idle frozen OBS offline');
  const ms = Date.now() - t0;
  assert.ok(ms <= 15000, `frozen OBS still shown connected for ${ms}ms`);
  const st = (await loop.relayStatus()).status;
  assert.match(String(st.obs.error || ''), /stopped responding|frozen/i, 'the booth/engineer should see why');
  m.thaw();
  await loop.waitForRelay((s) => s.obs?.connected === true && s.obs.streaming === true, 25000, 'back, live state re-read');
});
