/**
 * AudioMonitor Tests
 *
 * Tests the silence detection and alerting logic in src/audioMonitor.js.
 * No real timers are used — time-based logic is tested by directly
 * manipulating _silenceStartTime to simulate elapsed time.
 *
 * Coverage:
 *   - _atemLevelToDb: all firmware formats (dBFS*1000, linear 16-bit, linear 32-bit)
 *   - Silence detection: timer start, persist, reset on audio return
 *   - 15s alert: fires when silence sustained, deduplicates
 *   - 30s failover signal: fires once, not resent
 *   - Audio cleared signal: sent when audio returns after failover
 *   - OBS-only guard: no monitoring when OBS not streaming
 *   - Left/right channel handling
 *   - ATEM not connected: no crash
 *   - start() / stop() lifecycle
 *   - getStatus(): reports silence state accurately
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AudioMonitor } = require('../src/audioMonitor');

// ─── Mock agent factory ───────────────────────────────────────────────────────
//
// `masterLevel` is the raw ATEM audio level (integer). Pass null for
// "no master" (tests graceful null handling).

function createMockAgent({ obsStreaming = true, atemConnected = true, masterLevel = null } = {}) {
  const relayMessages = [];

  const agent = {
    status: {
      obs: { streaming: obsStreaming, connected: true },
      atem: { connected: atemConnected },
    },
    sendToRelay: (msg) => relayMessages.push(msg),
    obs: null,
    atem: atemConnected
      ? {
          state: {
            audio: {
              master: masterLevel !== null ? { inputLevel: masterLevel } : null,
            },
          },
        }
      : null,
    relayMessages,
  };

  return agent;
}

// ─── _atemLevelToDb ───────────────────────────────────────────────────────────

test('_atemLevelToDb: 0 (digital silence) returns -Infinity', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(0), -Infinity);
});

test('_atemLevelToDb: negative values use dBFS*1000 format', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(-10000), -10);
  assert.equal(m._atemLevelToDb(-40000), -40);
  assert.equal(m._atemLevelToDb(-6000),  -6);
});

test('_atemLevelToDb: -1 converts to -0.001 dBFS', () => {
  const m = new AudioMonitor();
  assert.equal(m._atemLevelToDb(-1), -0.001);
});

test('_atemLevelToDb: 32768 (full-scale 16-bit linear) is ~0 dBFS', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(32768);
  assert.ok(Math.abs(db) < 0.01, `Expected ~0 dBFS, got ${db}`);
});

test('_atemLevelToDb: 16384 (half-scale) is ~-6 dBFS', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(16384);
  assert.ok(Math.abs(db - (-6.02)) < 0.1, `Expected ~-6 dBFS, got ${db}`);
});

test('_atemLevelToDb: 1 (near-digital-zero linear) is very quiet', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(1);
  assert.ok(db < -90, `Expected very negative dBFS, got ${db}`);
});

test('_atemLevelToDb: 65535 (full-scale 32-bit range) is ~0 dBFS', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(65535);
  assert.ok(Math.abs(db) < 0.01, `Expected ~0 dBFS, got ${db}`);
});

test('_atemLevelToDb: 32767 (just below 32768) gives approximately correct dB', () => {
  const m = new AudioMonitor();
  const db = m._atemLevelToDb(32767);
  // Just below full scale — should be very close to 0
  assert.ok(db > -0.01 && db <= 0, `Expected near-0 dBFS, got ${db}`);
});

// ─── Silence detection: timer management ─────────────────────────────────────

test('silence timer NOT started when audio is above threshold (-5 dBFS = -5000 raw)', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -5000 }); // -5 dBFS > -40 threshold
  m.agent = agent;
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null, 'No silence timer when audio is present');
});

test('silence timer starts when audio falls below -40 dBFS threshold', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 }); // -50 dBFS < -40 threshold
  m.agent = agent;
  m._checkATEMAudio();
  assert.ok(m._silenceStartTime !== null, 'Silence timer should start');
});

test('silence timer persists across consecutive below-threshold calls', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;
  m._checkATEMAudio();
  const firstStart = m._silenceStartTime;
  assert.ok(firstStart !== null);
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, firstStart, 'Timer should not reset on repeat calls');
});

test('silence timer resets when audio returns above threshold', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._checkATEMAudio(); // start timer
  assert.ok(m._silenceStartTime !== null);

  agent.atem.state.audio.master.inputLevel = -5000; // audio back
  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null, 'Timer should reset when audio returns');
});

// ─── 15-second alert ─────────────────────────────────────────────────────────

test('15s alert fires after sustained silence', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  // Simulate timer having run for 15+ seconds
  m._silenceStartTime = Date.now() - 15_001;
  m._checkATEMAudio();

  const alerts = agent.relayMessages.filter(r => r.type === 'alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alertType, 'audio_silence');
  assert.ok(alerts[0].message.includes('15+ seconds'));
  assert.equal(alerts[0].severity, 'warning');
});

test('15s alert does NOT fire before 15 seconds have elapsed', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._silenceStartTime = Date.now() - 5000; // only 5s
  m._checkATEMAudio();

  const alerts = agent.relayMessages.filter(r => r.type === 'alert');
  assert.equal(alerts.length, 0, 'No alert before 15s');
});

test('15s alert deduplicated: same alert not sent twice within 5-min window', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._sendAlert('atem_audio_silence', 'First alert');
  const countAfterFirst = agent.relayMessages.length;

  m._sendAlert('atem_audio_silence', 'Duplicate within window');
  assert.equal(agent.relayMessages.length, countAfterFirst, 'Dedup should suppress second alert');
});

test('alert can re-fire after 5-min dedup window expires', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  // Seed last alert time to 6 minutes ago
  m._lastAlertTimes.set('atem_audio_silence', Date.now() - 6 * 60_000);

  m._sendAlert('atem_audio_silence', 'Alert after window expired');
  const alerts = agent.relayMessages.filter(r => r.type === 'alert');
  assert.equal(alerts.length, 1, 'Should fire after dedup window');
});

test('different alert keys are each sent independently', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent();
  m.agent = agent;

  m._sendAlert('key_a', 'Alert A');
  m._sendAlert('key_b', 'Alert B');
  assert.equal(agent.relayMessages.length, 2, 'Different keys should each fire once');
});

// ─── 30-second failover signal ────────────────────────────────────────────────

test('failover signal_event sent after 30s of sustained silence', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  // 30s elapsed; 15s alert already deduped so it won't reset the timer
  m._silenceStartTime = Date.now() - 30_001;
  m._lastAlertTimes.set('atem_audio_silence', Date.now() - 1000); // dedup active

  m._checkATEMAudio();

  const signals = agent.relayMessages.filter(r => r.type === 'signal_event');
  assert.equal(signals.length, 1);
  assert.equal(signals[0].signal, 'audio_silence_sustained');
  assert.ok(signals[0].durationSec >= 30);
});

test('failover signal NOT sent before 30s', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._silenceStartTime = Date.now() - 20_000; // 20s — under threshold
  m._lastAlertTimes.set('atem_audio_silence', Date.now() - 1000); // dedup active

  m._checkATEMAudio();

  const signals = agent.relayMessages.filter(r => r.type === 'signal_event');
  assert.equal(signals.length, 0, 'No failover signal before 30s');
});

test('failover signal sent only once per silence event', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  // First call — silence for 30s, failover sends
  m._silenceStartTime = Date.now() - 30_001;
  m._lastAlertTimes.set('atem_audio_silence', Date.now() - 1000);
  m._checkATEMAudio(); // sends failover

  // Second call — _failoverSignalSent is true, timer was reset,
  // starts fresh. Even after re-setting the timer, flag blocks re-send.
  m._silenceStartTime = Date.now() - 30_001;
  m._lastAlertTimes.set('atem_audio_silence', Date.now() - 1000);
  m._checkATEMAudio();

  const signals = agent.relayMessages.filter(r =>
    r.type === 'signal_event' && r.signal === 'audio_silence_sustained'
  );
  assert.equal(signals.length, 1, 'Failover signal should fire exactly once');
});

// ─── Audio cleared signal ─────────────────────────────────────────────────────

test('audio_silence_cleared sent when audio returns after a failover was emitted', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  // Precondition: timer running AND failover was already sent
  m._silenceStartTime = Date.now() - 5000;
  m._failoverSignalSent = true;

  // Audio comes back
  agent.atem.state.audio.master.inputLevel = -5000; // above threshold
  m._checkATEMAudio();

  const cleared = agent.relayMessages.filter(r => r.signal === 'audio_silence_cleared');
  assert.equal(cleared.length, 1, 'Should notify relay when audio returns after failover');
});

test('audio_silence_cleared NOT sent when audio returns without a prior failover', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._silenceStartTime = Date.now() - 5000;
  m._failoverSignalSent = false; // no failover was sent

  agent.atem.state.audio.master.inputLevel = -5000;
  m._checkATEMAudio();

  const cleared = agent.relayMessages.filter(r => r.signal === 'audio_silence_cleared');
  assert.equal(cleared.length, 0);
});

test('_failoverSignalSent resets to false after audio returns', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: -50000 });
  m.agent = agent;

  m._silenceStartTime = Date.now() - 5000;
  m._failoverSignalSent = true;

  agent.atem.state.audio.master.inputLevel = -5000;
  m._checkATEMAudio();

  assert.equal(m._failoverSignalSent, false, 'Flag should reset after audio returns');
});

// ─── OBS streaming guard ──────────────────────────────────────────────────────

test('tick: silence check skipped when OBS is not streaming', async () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: false, masterLevel: -50000 });
  m.agent = agent;

  await m.tick();

  assert.equal(m._silenceStartTime, null, 'Timer should not start if OBS not streaming');
});

test('tick: silence timer resets when OBS stops mid-stream', async () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: true, masterLevel: -50000 });
  m.agent = agent;

  m._silenceStartTime = Date.now() - 5000;

  agent.status.obs.streaming = false;
  await m.tick();

  assert.equal(m._silenceStartTime, null, 'Silence timer should reset when OBS stops');
});

// ─── ATEM connection guard ─────────────────────────────────────────────────────

test('_checkATEMAudio: no crash when ATEM is null', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ atemConnected: false });
  m.agent = agent;
  assert.doesNotThrow(() => m._checkATEMAudio());
});

test('_checkATEMAudio: no crash when audio state is null', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ atemConnected: true });
  agent.atem.state.audio.master = null;
  m.agent = agent;
  assert.doesNotThrow(() => m._checkATEMAudio());
  assert.equal(m._silenceStartTime, null);
});

test('_checkATEMAudio: no crash when ATEM state is undefined', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ atemConnected: true });
  agent.atem.state = undefined;
  m.agent = agent;
  assert.doesNotThrow(() => m._checkATEMAudio());
});

// ─── Left/right channel handling ──────────────────────────────────────────────

test('_checkATEMAudio: detects silence via left/right channels when inputLevel absent', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: null });
  agent.atem.state.audio.master = { left: -50000, right: -50000 }; // both silent
  m.agent = agent;

  m._checkATEMAudio();
  assert.ok(m._silenceStartTime !== null, 'Should detect silence from left/right channels');
});

test('_checkATEMAudio: uses louder of left/right channels', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: null });
  // Left channel silent, right channel has audio
  agent.atem.state.audio.master = { left: -60000, right: -5000 };
  m.agent = agent;

  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null, 'Should not detect silence when one channel has audio');
});

test('_checkATEMAudio: reads outputLevel when inputLevel absent', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ masterLevel: null });
  agent.atem.state.audio.master = { outputLevel: -5000 }; // -5 dBFS = audio present
  m.agent = agent;

  m._checkATEMAudio();
  assert.equal(m._silenceStartTime, null, 'Should not start silence timer when outputLevel has audio');
});

// ─── start() / stop() lifecycle ───────────────────────────────────────────────

test('start() sets agent and creates interval', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: false }); // obsStreaming false so tick is no-op
  m.start(agent);

  assert.ok(m._tickInterval !== null, 'Interval should be set after start()');
  assert.strictEqual(m.agent, agent);

  m.stop(); // cleanup
});

test('start() is idempotent — second call does not create new interval', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: false });
  m.start(agent);
  const firstInterval = m._tickInterval;

  m.start(agent);
  assert.equal(m._tickInterval, firstInterval, 'Second start() should not replace the interval');

  m.stop();
});

test('stop() clears interval and resets all state', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: false });
  m.start(agent);
  m._silenceStartTime = Date.now();
  m._failoverSignalSent = true;

  m.stop();

  assert.equal(m._tickInterval, null);
  assert.equal(m.agent, null);
  assert.equal(m._silenceStartTime, null);
  assert.equal(m._failoverSignalSent, false);
});

// ─── getStatus() ──────────────────────────────────────────────────────────────

test('getStatus: reports not monitoring when stopped', () => {
  const m = new AudioMonitor();
  const s = m.getStatus();
  assert.equal(s.monitoring, false);
  assert.equal(s.silenceDetected, false);
  assert.equal(s.silenceDurationSec, 0);
});

test('getStatus: reports monitoring=true when started', () => {
  const m = new AudioMonitor();
  const agent = createMockAgent({ obsStreaming: false });
  m.start(agent);
  assert.equal(m.getStatus().monitoring, true);
  m.stop();
});

test('getStatus: reports silence detected and duration when timer is running', () => {
  const m = new AudioMonitor();
  m._silenceStartTime = Date.now() - 10_000;

  const s = m.getStatus();
  assert.equal(s.silenceDetected, true);
  assert.ok(s.silenceDurationSec >= 10, `Expected >=10s, got ${s.silenceDurationSec}`);
});

test('getStatus: silenceDurationSec is 0 when no silence', () => {
  const m = new AudioMonitor();
  assert.equal(m.getStatus().silenceDurationSec, 0);
});
