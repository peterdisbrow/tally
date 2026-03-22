'use strict';

/**
 * AudioMonitor tests
 *
 * Covers: _atemLevelToDb, getStatus, stop, _sendAlert dedup,
 *         _checkATEMAudio silence detection, _checkOBSAudio congestion, tick dispatch.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { AudioMonitor } = require('../src/audioMonitor');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMockAgent(overrides = {}) {
  const agent = {
    status: {
      obs:  { streaming: true, connected: true },
      atem: { connected: true },
    },
    atem: {
      state: {
        audio: {
          master: { inputLevel: -5000 }, // -5 dBFS (above -40 threshold)
        },
      },
    },
    obs: {
      call: async () => ({ outputCongestion: 0.5 }),
    },
    sendToRelay: () => {},
    ...overrides,
  };
  return agent;
}

// ── 1. _atemLevelToDb ────────────────────────────────────────────────────────

test('_atemLevelToDb: raw=0 returns -Infinity', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(0), -Infinity);
});

test('_atemLevelToDb: raw=-10000 returns -10 (dBFS*1000 format)', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(-10000), -10);
});

test('_atemLevelToDb: raw=-40000 returns -40', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(-40000), -40);
});

test('_atemLevelToDb: raw=32768 returns 0 (full scale)', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(32768), 0);
});

test('_atemLevelToDb: raw=16384 returns approximately -6.02 (half of 32768)', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(16384);
  // 20 * log10(0.5) ≈ -6.0206
  assert.ok(Math.abs(db - (-6.0206)) < 0.01, `expected ≈ -6.02, got ${db}`);
});

test('_atemLevelToDb: raw=1 returns ≈ -90.3 dBFS', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(1);
  const expected = 20 * Math.log10(1 / 32768);
  assert.ok(Math.abs(db - expected) < 0.01, `expected ≈ ${expected}, got ${db}`);
});

test('_atemLevelToDb: raw=65535 returns approximately 0 (65535 divisor path)', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(65535);
  // 20 * log10(65535/65535) = 0
  assert.ok(Math.abs(db - 0) < 0.001, `expected ≈ 0, got ${db}`);
});

test('_atemLevelToDb: raw=32769 uses 65535 divisor (≈ -6.02)', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(32769);
  // 20 * log10(32769/65535) ≈ -6.02
  const expected = 20 * Math.log10(32769 / 65535);
  assert.ok(Math.abs(db - expected) < 0.01, `expected ≈ ${expected}, got ${db}`);
});

test('_atemLevelToDb: raw=99999 returns 0 (>65535 catch-all)', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(99999), 0);
});

// ── 2. getStatus — initial state ─────────────────────────────────────────────

test('getStatus: initial state is correct', () => {
  const m = new AudioMonitor();
  const s = m.getStatus();
  assert.equal(s.monitoring, false);
  assert.equal(s.silenceDetected, false);
  assert.equal(s.silenceDurationSec, 0);
  assert.deepEqual(s.lastAlerts, {});
});

// ── 3. stop() ────────────────────────────────────────────────────────────────

test('stop: after stop(), monitoring=false', () => {
  const m = new AudioMonitor();
  m.stop();
  assert.equal(m.getStatus().monitoring, false);
});

test('stop: after start then stop, monitoring=false', () => {
  const m = new AudioMonitor();
  m.start(makeMockAgent());
  m.stop();
  assert.equal(m.getStatus().monitoring, false);
});

test('stop: resets _silenceStartTime to null', () => {
  const m = new AudioMonitor();
  m._silenceStartTime = Date.now();
  m.stop();
  assert.equal(m._silenceStartTime, null);
});

test('stop: resets agent to null', () => {
  const m = new AudioMonitor();
  m.start(makeMockAgent());
  m.stop();
  assert.equal(m.agent, null);
});

// ── 4. _sendAlert — dedup logic ───────────────────────────────────────────────

test('_sendAlert: same key called twice quickly → sendToRelay called only once', () => {
  const m = new AudioMonitor();
  let callCount = 0;
  m.agent = makeMockAgent({ sendToRelay: () => { callCount++; } });

  m._sendAlert('test_key', 'first message');
  m._sendAlert('test_key', 'second message');

  assert.equal(callCount, 1, 'sendToRelay should only be called once within dedup window');
});

test('_sendAlert: after DEDUP_WINDOW_MS passes, same key fires again', () => {
  const m = new AudioMonitor();
  let callCount = 0;
  m.agent = makeMockAgent({ sendToRelay: () => { callCount++; } });

  // Simulate first alert was sent 6 minutes ago
  const SIX_MIN_AGO = Date.now() - 6 * 60_000;
  m._lastAlertTimes.set('test_key', SIX_MIN_AGO);

  m._sendAlert('test_key', 'should fire again');
  assert.equal(callCount, 1, 'sendToRelay should fire after dedup window expires');
});

test('_sendAlert: resets _silenceStartTime to null', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent();
  m._silenceStartTime = Date.now();

  m._sendAlert('reset_test', 'testing reset');
  assert.equal(m._silenceStartTime, null);
});

// ── 5. _checkATEMAudio — silence detection ────────────────────────────────────

test('_checkATEMAudio: no atem on agent → returns without doing anything', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({ atem: undefined });
  // Should not throw
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null);
});

test('_checkATEMAudio: atem exists but status.atem.connected=false → returns', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({
    status: { obs: { streaming: true, connected: true }, atem: { connected: false } },
  });
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null);
});

test('_checkATEMAudio: inputLevel above threshold → resets _silenceStartTime to null', () => {
  const m = new AudioMonitor();
  m._silenceStartTime = Date.now() - 5000; // had silence
  m.agent = makeMockAgent({
    atem: { state: { audio: { master: { inputLevel: -5000 } } } }, // -5 dBFS, above -40
  });
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null);
});

test('_checkATEMAudio: inputLevel below threshold → starts _silenceStartTime', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({
    atem: { state: { audio: { master: { inputLevel: -50000 } } } }, // -50 dBFS, below -40
  });
  m._checkATEMAudio();
  assert.ok(m._silenceStartTime !== null, '_silenceStartTime should be set when below threshold');
});

test('_checkATEMAudio: silence ≥ 15s → calls _sendAlert', () => {
  const m = new AudioMonitor();
  let alertCalled = false;
  m.agent = makeMockAgent({ sendToRelay: () => { alertCalled = true; } });
  // Set silence start to 20 seconds ago
  m._silenceStartTime = Date.now() - 20_000;
  m.agent.atem.state.audio.master.inputLevel = -50000; // below threshold

  m._checkATEMAudio();
  assert.ok(alertCalled, '_sendAlert should fire when silence ≥ 15 seconds');
});

test('_checkATEMAudio: silence ≥ 30s and !_failoverSignalSent → sends signal_event audio_silence_sustained', () => {
  const m = new AudioMonitor();
  const relayMessages = [];
  m.agent = makeMockAgent({ sendToRelay: (msg) => { relayMessages.push(msg); } });
  m._silenceStartTime = Date.now() - 31_000;
  m._failoverSignalSent = false;
  m.agent.atem.state.audio.master.inputLevel = -50000;

  m._checkATEMAudio();

  const signalMsg = relayMessages.find(msg => msg.type === 'signal_event' && msg.signal === 'audio_silence_sustained');
  assert.ok(signalMsg, 'should send audio_silence_sustained signal_event after 30s');
});

test('_checkATEMAudio: audio returns after failover signal sent → sends audio_silence_cleared', () => {
  const m = new AudioMonitor();
  const relayMessages = [];
  m.agent = makeMockAgent({ sendToRelay: (msg) => { relayMessages.push(msg); } });
  // Simulate: was silent and failover signal was sent
  m._silenceStartTime = Date.now() - 31_000;
  m._failoverSignalSent = true;
  // Now audio is back above threshold
  m.agent.atem.state.audio.master.inputLevel = -5000; // -5 dBFS, above -40

  m._checkATEMAudio();

  const clearedMsg = relayMessages.find(msg => msg.type === 'signal_event' && msg.signal === 'audio_silence_cleared');
  assert.ok(clearedMsg, 'should send audio_silence_cleared when audio returns after failover signal');
});

test('_checkATEMAudio: handles outputLevel when inputLevel missing', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({
    atem: { state: { audio: { master: { outputLevel: -5000 } } } }, // no inputLevel
  });
  // Should not throw and should process outputLevel normally
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null); // -5 dBFS is above threshold
});

test('_checkATEMAudio: handles left/right channels, uses max', () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({
    atem: {
      state: {
        audio: {
          master: {
            left:  -50000, // -50 dBFS, below threshold
            right: -5000,  // -5 dBFS, above threshold
          },
        },
      },
    },
  });
  // max(-50, -5) = -5 → above threshold, so no silence
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null, 'should use the louder channel (right at -5 dBFS)');
});

// ── 6. _checkOBSAudio — congestion ───────────────────────────────────────────

test('_checkOBSAudio: no obs on agent → returns immediately', async () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({ obs: undefined });
  // Should not throw
  await m._checkOBSAudio();
});

test('_checkOBSAudio: congestion > 0.8 → calls _sendAlert', async () => {
  const m = new AudioMonitor();
  let alertSent = false;
  m.agent = makeMockAgent({
    obs: { call: async () => ({ outputCongestion: 0.9 }) },
    sendToRelay: () => { alertSent = true; },
  });
  await m._checkOBSAudio();
  assert.ok(alertSent, 'should send alert when outputCongestion > 0.8');
});

test('_checkOBSAudio: congestion ≤ 0.8 → no alert', async () => {
  const m = new AudioMonitor();
  let alertSent = false;
  m.agent = makeMockAgent({
    obs: { call: async () => ({ outputCongestion: 0.8 }) },
    sendToRelay: () => { alertSent = true; },
  });
  await m._checkOBSAudio();
  assert.equal(alertSent, false, 'should not send alert when outputCongestion ≤ 0.8');
});

test('_checkOBSAudio: obs.call throws → no error propagated', async () => {
  const m = new AudioMonitor();
  m.agent = makeMockAgent({
    obs: { call: async () => { throw new Error('OBS not reachable'); } },
  });
  // Should not throw
  await m._checkOBSAudio();
});

// ── 7. tick() — dispatch ─────────────────────────────────────────────────────

test('tick: when agent is null → returns early without error', async () => {
  const m = new AudioMonitor();
  m.agent = null;
  // Should not throw
  await m.tick();
});

test('tick: when not streaming (status.obs.streaming=false) → resets _silenceStartTime, no ATEM check', async () => {
  const m = new AudioMonitor();
  m._silenceStartTime = Date.now() - 5000;
  let atemCheckCalled = false;
  m.agent = makeMockAgent({
    status: { obs: { streaming: false, connected: true }, atem: { connected: true } },
  });
  // Override _checkATEMAudio to detect if it was called
  m._checkATEMAudio = () => { atemCheckCalled = true; };

  await m.tick();

  assert.equal(m._silenceStartTime, null, 'should reset _silenceStartTime when not streaming');
  assert.equal(atemCheckCalled, false, 'should not call _checkATEMAudio when not streaming');
});
