/**
 * SIM PASS — ATEM, remote engineer path end to end:
 *   engineer (controller WS / admin HTTP {wait:true}) → REAL relay → REAL agent
 *   → ATEM mock speaking the real BMD UDP protocol (test/mocks/atemServer.js).
 *
 * A real ATEM never answers "error": it acks a command for a source it doesn't
 * have and simply ignores it. So an honest Tally must confirm every switch by
 * reading the switcher's state back. These tests assert what the engineer gets.
 *
 * Each test binds its own ATEM on 127.0.x.y:9910 (the ATEM port is fixed by the
 * protocol; loopback aliases keep tests apart and never touch the lab's
 * MockLab ATEM on 127.0.0.1:9910).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const atemMock = require('../mocks/atemServer');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const skipRelay = !relayAvailable() && 'relay-server not installed';
const mocks = [];
let ipSeq = Math.floor(Math.random() * 200);
async function mk(opts = {}) {
  for (let i = 0; i < 20; i++) {
    const host = `127.0.${2 + ((ipSeq++) % 240)}.${2 + Math.floor(Math.random() * 240)}`;
    try { const m = await atemMock.start({ host, port: 9910, ...opts }); mocks.push(m); return m; } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
  }
  throw new Error('no free loopback alias for the ATEM mock');
}
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });
const pace = () => new Promise((r) => setTimeout(r, 350)); // relay rate limit: ≤10 cmds/s/church

async function upLoop(t, m, extra = {}) {
  const loop = await startRelayLoop({ atemIp: m.host, ...extra });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.atem?.connected === true && st.atem?.programInput === 1 && st.atem?.previewInput === 2, 25000, 'relay sees ATEM with PGM 1 / PVW 2');
  const cmd = async (c, p = {}) => { await pace(); return loop.controllerCommand(c, p, 15000); };
  const http = async (c, p = {}) => { await pace(); return loop.httpCommand(c, p, { wait: true, timeoutMs: 15000 }); };
  return { loop, cmd, http };
}

test('remote: program / preview / cut / auto are applied on the switcher and confirmed by its state', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd, http } = await upLoop(t, m);

  const r1 = await cmd('atem.setProgram', { input: 3 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(m.state.programInput, 3, 'switcher really on Cam 3');
  await loop.waitForRelay((st) => st.atem.programInput === 3, 5000, 'relay shows PGM 3');

  const r2 = await cmd('atem.setPreview', { input: 4 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.previewInput, 4);

  const r3 = await cmd('atem.cut', {});
  assert.equal(r3.error, null, JSON.stringify(r3));
  assert.equal(m.state.programInput, 4);
  assert.equal(m.state.previewInput, 3);

  const r4 = await cmd('atem.auto', {});
  assert.equal(r4.error, null, JSON.stringify(r4));
  // Confirmed means the transition really FINISHED on the switcher, not "sent".
  assert.equal(m.state.inTransition, false, 'auto reported done while the transition was still running');
  assert.equal(m.state.programInput, 3, 'auto must have taken PVW (3) to program');
  await loop.waitForRelay((st) => st.atem.programInput === 3 && st.atem.previewInput === 4, 5000, 'relay after auto');

  const h = await http('atem.setProgram', { input: 2 });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.completed, true);
  assert.equal(m.state.programInput, 2);
});

test('remote: the switcher ignoring a command (source the model lacks) is a refusal, never "done"', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk(); // ATEM Mini Pro: 4 inputs, 1 media player, no Super Source
  const { cmd, http } = await upLoop(t, m);

  const sent0 = m.state.commandsReceived.length;
  const r1 = await cmd('atem.setProgram', { input: 7 });
  assert.ok(r1.error, `Cam 7 on a 4-input ATEM must be refused: ${JSON.stringify(r1)}`);
  assert.equal(m.state.programInput, 1);
  assert.equal(m.state.commandsReceived.length, sent0, 'a known-bad input must not even be sent');

  const r2 = await cmd('atem.setProgram', { input: 3020 }); // Media Player 2 — this model has only MP1
  assert.ok(r2.error, `ATEM ignored MP2 but Tally said: ${JSON.stringify(r2)}`);
  assert.match(String(r2.error), /did not|ignored|not confirm/i);
  assert.equal(m.state.programInput, 1, 'program unchanged');

  const r3 = await cmd('atem.setPreview', { input: 6000 }); // Super Source — not on a Mini Pro
  assert.ok(r3.error, `preview to missing Super Source must be refused: ${JSON.stringify(r3)}`);
  assert.equal(m.state.previewInput, 2);

  const h = await http('atem.setProgram', { input: 3020 });
  assert.equal(h.status, 422, `HTTP must be a device refusal (422): ${h.status} ${JSON.stringify(h.body)}`);
  assert.equal(m.state.programInput, 1);
});

test('remote: ATEM recording with no USB disk and streaming with a bad key are refused; good cases confirmed', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk({ hasMedia: false, streamKeyValid: false });
  const { loop, cmd } = await upLoop(t, m);

  const r1 = await cmd('atem.startRecording', {});
  assert.ok(r1.error, `record with no disk must be refused: ${JSON.stringify(r1)}`);
  assert.equal(m.state.recording, 'Idle');

  const r2 = await cmd('atem.startStreaming', {});
  assert.ok(r2.error, `stream the service rejected must be refused: ${JSON.stringify(r2)}`);
  assert.equal(m.state.streaming, 'Idle');

  m.setMedia(true);
  m.state.streamKeyValid = true;
  const r3 = await cmd('atem.startRecording', {});
  assert.equal(r3.error, null, JSON.stringify(r3));
  assert.equal(m.state.recording, 'Recording');
  await loop.waitForRelay((st) => st.atem.recording === true, 6000, 'relay shows ATEM recording');
  const r4 = await cmd('atem.startStreaming', {});
  assert.equal(r4.error, null, JSON.stringify(r4));
  assert.equal(m.state.streaming, 'Streaming', 'stream confirmed only once really Streaming');
  const r5 = await cmd('atem.stopRecording', {});
  assert.equal(r5.error, null, JSON.stringify(r5));
  assert.equal(m.state.recording, 'Idle');
});

test('remote: ATEM unplugged → honest offline, commands refused fast (never "done"), recovery works', { timeout: 150000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd, http } = await upLoop(t, m);

  // Command in the window right after the cable is pulled, before Tally has noticed.
  m.setReachable(false);
  const t0 = Date.now();
  const r0 = await cmd('atem.setProgram', { input: 3 });
  assert.ok(r0.error || r0.timedOut, `a switch to an unplugged ATEM was reported done: ${JSON.stringify(r0)}`);
  assert.ok(!r0.timedOut, `engineer got no answer at all (${r0.ms}ms)`);
  assert.equal(m.state.programInput, 1);

  await loop.waitForRelay((st) => st.atem?.connected === false, 12000, 'relay sees ATEM offline');
  const downMs = Date.now() - t0;
  assert.ok(downMs <= 9000, `offline seen after ${downMs}ms`);
  const r1 = await cmd('atem.setProgram', { input: 3 });
  assert.match(String(r1.error), /not connected|offline|not reachable/i, JSON.stringify(r1));
  assert.ok(r1.ms < 3000, `refusal took ${r1.ms}ms`);
  const h = await http('atem.cut', {});
  assert.equal(h.status, 422, `${h.status} ${JSON.stringify(h.body)}`);

  m.setReachable(true);
  const t1 = Date.now();
  await loop.waitForRelay((st) => st.atem?.connected === true, 20000, 'relay sees ATEM back');
  assert.ok(Date.now() - t1 <= 12000, `recovered after ${Date.now() - t1}ms`);
  const r2 = await cmd('atem.setProgram', { input: 4 });
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.programInput, 4);
});

test('remote: ATEM power-cycled → every command path works on the NEW connection (no stale switcher object)', { timeout: 150000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, cmd } = await upLoop(t, m);
  await m.crash();
  await loop.waitForRelay((st) => st.atem?.connected === false, 12000, 'relay sees ATEM off');
  await new Promise((r) => setTimeout(r, 1500));
  await m.restart();
  await loop.waitForRelay((st) => st.atem?.connected === true, 20000, 'relay sees ATEM back after power cycle');
  await new Promise((r) => setTimeout(r, 500));

  const r1 = await cmd('atem.setProgram', { input: 2 });
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.equal(m.state.programInput, 2);
  const r2 = await cmd('atem.startRecording', {});
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.recording, 'Recording', 'recording must reach the switcher after a reconnect');
  const r3 = await cmd('atem.stopRecording', {});
  assert.equal(r3.error, null, JSON.stringify(r3));
  assert.equal(m.state.recording, 'Idle');
});

test('remote: operator switching on the ATEM panel shows up for the engineer; church offline → 503, nothing queued', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk();
  const { loop, http } = await upLoop(t, m);
  m.operatorProgram(4);
  const seen = await loop.waitForRelay((st) => st.atem.programInput === 4, 5000, 'relay follows the panel');
  assert.ok(seen.ms < 4000, `panel change reached the engineer after ${seen.ms}ms`);

  await loop.stopAgent();
  await loop.waitForRelay((st, conn) => conn === false, 15000, 'church offline at relay');
  const h = await http('atem.setProgram', { input: 1 });
  assert.equal(h.status, 503, `${h.status} ${JSON.stringify(h.body)}`);
  assert.equal(m.state.programInput, 4);
});

test('remote: ATEM Mini built-in encoder — encoder.startStream/stopStream are confirmed by the switcher; a rejected key is refused', { timeout: 120000, skip: skipRelay }, async (t) => {
  const m = await mk({ streamKeyValid: false });
  const { cmd } = await upLoop(t, m, { encoder: { type: 'atem-streaming', host: m.host, port: 80, label: '', statusUrl: '', source: '' } });
  const r1 = await cmd('encoder.startStream', {});
  assert.ok(r1.error, `stream the ATEM could not start was reported as: ${JSON.stringify(r1)}`);
  assert.equal(m.state.streaming, 'Idle');
  m.state.streamKeyValid = true;
  const r2 = await cmd('encoder.startStream', {});
  assert.equal(r2.error, null, JSON.stringify(r2));
  assert.equal(m.state.streaming, 'Streaming');
  const r3 = await cmd('encoder.stopStream', {});
  assert.equal(r3.error, null, JSON.stringify(r3));
  assert.equal(m.state.streaming, 'Idle');
});
