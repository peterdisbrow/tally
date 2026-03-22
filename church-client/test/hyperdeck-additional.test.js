/**
 * Additional tests for src/hyperdeck.js — HyperDeck
 *
 * Covers methods not exercised by hyperdeck-commands.test.js and
 * hyperdeck-disk.test.js:
 *   getDiskWarnings, setRecordingBitrate, play/stop/record/nextClip/prevClip,
 *   refreshStatus (not connected), _sendAndWait (not connected), _applyBlock
 *   (connection info, slot info, transport info).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { HyperDeck } = require('../src/hyperdeck');

// ─── HELPER — connected HyperDeck with network layer stubbed ─────────────────

function makeConnectedHD() {
  const hd = new HyperDeck({ host: '10.0.0.1', name: 'Test Deck' });
  hd.connected = true;
  hd.socket = { destroyed: false, write: () => {} };
  hd._sendAndWait = async (cmd) => ({ code: 200, title: 'ok', fields: {}, lines: [] });
  hd.refreshStatus = async () => hd.getStatus();
  return hd;
}

// ─── getDiskWarnings() ────────────────────────────────────────────────────────

test('getDiskWarnings() — no diskSpace returns empty array', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  assert.deepEqual(hd.getDiskWarnings(), []);
});

test('getDiskWarnings() — disk OK returns empty array', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 200,
  };
  assert.deepEqual(hd.getDiskWarnings(), []);
});

test('getDiskWarnings() — recording_disk_full when estimatedMinutesRemaining < 5', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 3,
  };
  const warnings = hd.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('getDiskWarnings() — recording_disk_full when percentUsed > 95 and no estimatedMinutes', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 96,
    estimatedMinutesRemaining: null,
  };
  const warnings = hd.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_full');
});

test('getDiskWarnings() — recording_disk_critical when estimatedMinutesRemaining = 15', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 15,
  };
  const warnings = hd.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_critical');
});

test('getDiskWarnings() — recording_disk_low when estimatedMinutesRemaining = 90', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 90,
  };
  const warnings = hd.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].type, 'recording_disk_low');
});

test('getDiskWarnings() — boundary estimatedMinutesRemaining=5 (>= 5, not full by time)', () => {
  // At exactly 5 minutes, the "< 5" check does NOT trigger.
  // percentUsed=50 so the "> 95" check also does not trigger.
  // Result is critical (< 30) unless percentUsed tips it to full.
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 5,
  };
  const warnings = hd.getDiskWarnings();
  assert.equal(warnings.length, 1);
  assert.ok(
    warnings[0].type === 'recording_disk_critical' || warnings[0].type === 'recording_disk_full',
    `expected full or critical, got ${warnings[0].type}`
  );
});

test('getDiskWarnings() — warning message contains the device name', () => {
  const hd = new HyperDeck({ host: '10.0.0.1', name: 'Studio Deck' });
  hd._status.diskSpace = {
    percentUsed: 50,
    estimatedMinutesRemaining: 3,
  };
  const warnings = hd.getDiskWarnings();
  assert.ok(warnings[0].message.includes('Studio Deck'), `message should include device name: ${warnings[0].message}`);
});

// ─── setRecordingBitrate() ────────────────────────────────────────────────────

test('setRecordingBitrate(50_000_000) sets _recordingBitrateBytes = 6250000', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd.setRecordingBitrate(50_000_000);
  assert.equal(hd._recordingBitrateBytes, 50_000_000 / 8);
});

test('setRecordingBitrate(0) sets _recordingBitrateBytes to max(1, 0)/8', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd.setRecordingBitrate(0);
  // Math.max(1, Number(0) || 0) = Math.max(1, 0) = 1; 1/8 = 0.125
  assert.equal(hd._recordingBitrateBytes, 1 / 8);
});

test('setRecordingBitrate("bad") sets _recordingBitrateBytes to max(1, 0)/8', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd.setRecordingBitrate('bad');
  // Number('bad') = NaN, NaN || 0 = 0, max(1, 0) = 1, 1/8 = 0.125
  assert.equal(hd._recordingBitrateBytes, 1 / 8);
});

// ─── Transport control methods ────────────────────────────────────────────────

test('play() resolves and calls _sendAndWait("play", [200])', async () => {
  const hd = makeConnectedHD();
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push({ cmd, codes }); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.play();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'play');
  assert.deepEqual(calls[0].codes, [200]);
});

test('stop() resolves and calls _sendAndWait("stop", [200])', async () => {
  const hd = makeConnectedHD();
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push({ cmd, codes }); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.stop();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'stop');
  assert.deepEqual(calls[0].codes, [200]);
});

test('record() resolves and calls _sendAndWait("record", [200])', async () => {
  const hd = makeConnectedHD();
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push({ cmd, codes }); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.record();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'record');
  assert.deepEqual(calls[0].codes, [200]);
});

test('nextClip() with clipId=3 sends "goto: clip id: 4"', async () => {
  const hd = makeConnectedHD();
  hd._status.clipId = 3;
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push(cmd); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.nextClip();
  assert.equal(calls[0], 'goto: clip id: 4');
});

test('prevClip() with clipId=3 sends "goto: clip id: 2"', async () => {
  const hd = makeConnectedHD();
  hd._status.clipId = 3;
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push(cmd); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.prevClip();
  assert.equal(calls[0], 'goto: clip id: 2');
});

test('prevClip() with clipId=1 clamps to minimum 1 — sends "goto: clip id: 1"', async () => {
  const hd = makeConnectedHD();
  hd._status.clipId = 1;
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push(cmd); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.prevClip();
  assert.equal(calls[0], 'goto: clip id: 1');
});

test('nextClip() with clipId=null defaults current to 1 and sends "goto: clip id: 2"', async () => {
  const hd = makeConnectedHD();
  hd._status.clipId = null;
  const calls = [];
  hd._sendAndWait = async (cmd, codes) => { calls.push(cmd); return { code: 200, title: 'ok', fields: {}, lines: [] }; };
  await hd.nextClip();
  assert.equal(calls[0], 'goto: clip id: 2');
});

// ─── refreshStatus() — not connected ──────────────────────────────────────────

test('refreshStatus() when not connected returns getStatus() immediately', async () => {
  const hd = new HyperDeck({ host: '10.0.0.1', name: 'Offline Deck' });
  // not connected — no socket needed
  const status = await hd.refreshStatus();
  assert.equal(typeof status, 'object');
  assert.equal(status.connected, false);
  assert.equal(status.name, 'Offline Deck');
});

// ─── _sendAndWait — not connected ─────────────────────────────────────────────

test('_sendAndWait rejects with "not connected" when disconnected', async () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  await assert.rejects(
    () => hd._sendAndWait('play'),
    /not connected/
  );
});

// ─── _applyBlock — connection info ────────────────────────────────────────────

test('_applyBlock sets model from connection info block', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._applyBlock({
    code: 200,
    title: 'connection info',
    fields: { model: 'HyperDeck Studio HD Plus', 'protocol version': '1.12' },
    lines: [],
  });
  assert.equal(hd._status.model, 'HyperDeck Studio HD Plus');
  assert.equal(hd._status.protocolVersion, '1.12');
});

// ─── _applyBlock — slot info ──────────────────────────────────────────────────

test('_applyBlock computes percentUsed correctly (total=1000, free=500 → 50%)', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._applyBlock({
    code: 202,
    title: 'slot info',
    fields: {
      'slot id': '1',
      'volume total': '1000',
      'volume free': '500',
    },
    lines: [],
  });
  assert.ok(hd._status.diskSpace, 'diskSpace should be set');
  assert.equal(hd._status.diskSpace.total, 1000);
  assert.equal(hd._status.diskSpace.free, 500);
  assert.equal(hd._status.diskSpace.used, 500);
  assert.equal(hd._status.diskSpace.percentUsed, 50);
});

// ─── _applyBlock — transport info ─────────────────────────────────────────────

test('_applyBlock sets recording=true when transport status="record"', () => {
  const hd = new HyperDeck({ host: '10.0.0.1' });
  hd._applyBlock({
    code: 208,
    title: 'transport info',
    fields: { status: 'record', 'clip id': '2', 'slot id': '1' },
    lines: [],
  });
  assert.equal(hd._status.recording, true);
  assert.equal(hd._status.transport, 'record');
  assert.equal(hd._status.clipId, 2);
});
