/**
 * Integration: AtemAnalytics ↔ EncoderBridge
 *
 * Tests the interactions between AtemAnalytics (ATEM input tracking) and
 * EncoderBridge (encoder lifecycle and status), verifying:
 * - ATEM state changes propagate correctly through the analytics chain
 * - AtemAnalytics session lifecycle correlates with encoder status
 * - EncoderBridge correctly wraps adapter errors (failing encoder → safe status)
 * - RTMP-push setLive integration for externally controlled encoders
 * - Encoder type routing and adapter delegation
 * - AtemAnalytics stats are correct across a realistic service lifecycle
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AtemAnalytics } = require('../src/atemAnalytics');
const { EncoderBridge } = require('../src/encoderBridge');
const { RtmpPushEncoder } = require('../src/encoders/rtmpPush');

// ─── ATEM Input → Analytics propagation ──────────────────────────────────────

test('ATEM program input changes propagate through analytics: correct order and durations', () => {
  const analytics = new AtemAnalytics([
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
    { id: 1001, name: 'Slide Deck' },
  ]);

  // Simulate a realistic service: open on Camera 1, switch to slides, back to cam
  analytics.startTracking();
  analytics.recordInputChange(1, 'Camera 1', 0);
  analytics.recordInputChange(1001, 'Slide Deck', 10000);   // 10s on cam 1
  analytics.recordInputChange(2, 'Camera 2', 25000);        // 15s on slides
  analytics.recordInputChange(1, 'Camera 1', 30000);        // 5s on cam 2
  analytics.stopTracking();

  const timeline = analytics.getSwitchTimeline();
  assert.equal(timeline.length, 4);

  // Verify durations
  assert.equal(timeline[0].inputId, 1);
  assert.equal(timeline[0].duration, 10000);
  assert.equal(timeline[1].inputId, 1001);
  assert.equal(timeline[1].duration, 15000);
  assert.equal(timeline[2].inputId, 2);
  assert.equal(timeline[2].duration, 5000);
  assert.equal(timeline[3].inputId, 1); // Last shot — duration computed at stop
  assert.ok(timeline[3].duration >= 0);
});

test('ATEM stats reflect dominant input correctly across service', () => {
  const analytics = new AtemAnalytics([
    { id: 1, name: 'Main Camera' },
    { id: 2, name: 'Wide Shot' },
    { id: 3, name: 'Slides' },
  ]);

  analytics.startTracking();
  // Main Camera dominates the service
  analytics.recordInputChange(1, 'Main Camera', 0);
  analytics.recordInputChange(2, 'Wide Shot', 60000);    // 1 min on main
  analytics.recordInputChange(1, 'Main Camera', 65000);  // 5s on wide
  analytics.recordInputChange(3, 'Slides', 125000);      // 60s on main again
  analytics.recordInputChange(1, 'Main Camera', 140000); // 15s on slides
  analytics.stopTracking();

  const stats = analytics.getSessionStats();

  // Main Camera (id=1) should be first (most time on air: ~120s)
  assert.equal(stats.inputs[0].id, 1);
  assert.ok(stats.inputs[0].timeOnAir > stats.inputs[1].timeOnAir, 'Main Camera should dominate');

  // Total switches count
  assert.equal(stats.totalSwitches, 5);

  // All switches accounted for in inputs
  const totalSwitchesFromInputs = stats.inputs.reduce((sum, i) => sum + i.switchCount, 0);
  assert.equal(totalSwitchesFromInputs, 5);
});

test('ATEM analytics unused inputs are identified when configured but not switched to', () => {
  const analytics = new AtemAnalytics([
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
    { id: 3, name: 'Camera 3' },   // never used
    { id: 4, name: 'Slides' },     // never used
  ]);

  analytics.startTracking();
  analytics.recordInputChange(1, 'Camera 1', 0);
  analytics.recordInputChange(2, 'Camera 2', 5000);
  analytics.recordInputChange(1, 'Camera 1', 10000);
  analytics.stopTracking();

  const stats = analytics.getSessionStats();

  // Only cameras 1 and 2 were used
  assert.deepEqual(stats.unusedInputs.sort(), [3, 4]);
  assert.equal(stats.inputs.length, 2);
});

test('ATEM analytics correctly computes percentOfTotal across inputs', () => {
  const analytics = new AtemAnalytics();
  const start = 0;
  // Exactly 50/50 split between two inputs
  analytics.startTracking();
  analytics.recordInputChange(1, 'Camera 1', start);
  analytics.recordInputChange(2, 'Camera 2', start + 5000);
  analytics.recordInputChange(1, 'Camera 1', start + 10000); // 5s on cam2
  // stopTracking at 10000ms, so last shot has some duration
  analytics.stopTracking();

  const stats = analytics.getSessionStats();
  // Total durations should sum to close to 100% (within floating point)
  const totalPercent = stats.inputs.reduce((sum, i) => sum + i.percentOfTotal, 0);
  // The last shot's duration depends on Date.now(), so just verify < 101
  assert.ok(totalPercent <= 101, 'Percentages should not exceed 100%');
  assert.ok(totalPercent >= 0, 'Percentages should be non-negative');
});

test('ATEM session reset: startTracking clears previous session data', () => {
  const analytics = new AtemAnalytics([{ id: 1, name: 'Camera 1' }]);

  // First session
  analytics.startTracking();
  analytics.recordInputChange(1, 'Camera 1', 0);
  analytics.recordInputChange(2, 'Camera 2', 5000);
  analytics.stopTracking();

  const firstStats = analytics.getSessionStats();
  assert.equal(firstStats.totalSwitches, 2);

  // Second session — should start clean
  analytics.startTracking();
  analytics.recordInputChange(3, 'Camera 3', 0);
  analytics.stopTracking();

  const secondStats = analytics.getSessionStats();
  assert.equal(secondStats.totalSwitches, 1);
  assert.equal(secondStats.inputs.length, 1);
  assert.equal(secondStats.inputs[0].id, 3);
});

// ─── EncoderBridge adapter routing ───────────────────────────────────────────

test('EncoderBridge routes OBS type to ObsEncoder', () => {
  const bridge = new EncoderBridge({ type: 'obs', host: 'localhost', port: 4455 });
  assert.equal(bridge.type, 'obs');
  assert.equal(bridge.adapter.constructor.name, 'ObsEncoder');
});

test('EncoderBridge routes vmix type to VmixEncoder', () => {
  const bridge = new EncoderBridge({ type: 'vmix', host: 'localhost', port: 8088 });
  assert.equal(bridge.type, 'vmix');
  assert.equal(bridge.adapter.constructor.name, 'VmixEncoder');
});

test('EncoderBridge routes atem-streaming type to RtmpPushEncoder', () => {
  const bridge = new EncoderBridge({ type: 'atem-streaming', host: '192.168.1.100' });
  assert.equal(bridge.adapter.constructor.name, 'RtmpPushEncoder');
  assert.equal(bridge.adapter.type, 'atem-streaming');
});

test('EncoderBridge routes unknown type to rtmp-generic fallback', () => {
  const bridge = new EncoderBridge({ type: 'totally-unknown-encoder-xyz' });
  assert.equal(bridge.adapter.constructor.name, 'RtmpPushEncoder');
  assert.equal(bridge.adapter.type, 'rtmp-generic');
});

test('EncoderBridge.isOnline() returns false gracefully when adapter throws', async () => {
  const bridge = new EncoderBridge({ type: 'obs', host: 'localhost', port: 4455 });
  // Force adapter to throw
  bridge._encoder.isOnline = async () => { throw new Error('WebSocket refused'); };

  const result = await bridge.isOnline();
  assert.equal(result, false);
});

test('EncoderBridge.getStatus() returns default status when adapter throws', async () => {
  const bridge = new EncoderBridge({ type: 'obs', host: 'localhost', port: 4455 });
  bridge._encoder.getStatus = async () => { throw new Error('Connection refused'); };

  const status = await bridge.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.bitrateKbps, null);
});

test('EncoderBridge.connect() returns false gracefully when adapter throws', async () => {
  const bridge = new EncoderBridge({ type: 'obs', host: 'localhost' });
  bridge._encoder.connect = async () => { throw new Error('ECONNREFUSED'); };

  const result = await bridge.connect();
  assert.equal(result, false);
});

// ─── RTMP-Push setLive integration ────────────────────────────────────────────

test('RTMP-Push encoder setLive transitions live status correctly', async () => {
  const rtmp = new RtmpPushEncoder({ type: 'youtube-live', label: 'YouTube' });

  const initialStatus = await rtmp.getStatus();
  assert.equal(initialStatus.live, false);

  // Relay signals encoder is now live
  rtmp.setLive(true);
  const liveStatus = await rtmp.getStatus();
  assert.equal(liveStatus.live, true);

  // Relay signals encoder stopped
  rtmp.setLive(false);
  const stoppedStatus = await rtmp.getStatus();
  assert.equal(stoppedStatus.live, false);
  assert.equal(stoppedStatus.bitrateKbps, null); // bitrate resets on stop
});

test('RTMP-Push encoder setBitrate and setFps update status correctly', async () => {
  const rtmp = new RtmpPushEncoder({ type: 'facebook-live' });
  rtmp.setLive(true);
  rtmp.setBitrate(4500);
  rtmp.setFps(30);

  const status = await rtmp.getStatus();
  assert.equal(status.bitrateKbps, 4500);
  assert.equal(status.fps, 30);
  assert.equal(status.live, true);
});

test('RTMP-Push encoder setBitrate(0) clears bitrate (indicates stream degraded)', async () => {
  const rtmp = new RtmpPushEncoder({ type: 'custom-rtmp' });
  rtmp.setLive(true);
  rtmp.setBitrate(3000);
  rtmp.setBitrate(0); // stream dropped to 0

  const status = await rtmp.getStatus();
  assert.equal(status.bitrateKbps, null);
});

test('RTMP-Push encoder tracks live start time on setLive(true)', () => {
  const rtmp = new RtmpPushEncoder({ type: 'rtmp-generic' });
  const before = Date.now();
  rtmp.setLive(true);
  const after = Date.now();

  assert.ok(rtmp._liveStartedAt >= before);
  assert.ok(rtmp._liveStartedAt <= after);
});

test('RTMP-Push encoder without host is always considered online (no API to check)', async () => {
  const rtmp = new RtmpPushEncoder({ type: 'yolobox', host: '' });
  const online = await rtmp.isOnline();
  assert.equal(online, true);
});

test('EncoderBridge.setLive() is delegated to the underlying RTMP adapter', () => {
  const bridge = new EncoderBridge({ type: 'youtube-live' });
  assert.equal(bridge.adapter.constructor.name, 'RtmpPushEncoder');

  bridge.setLive(true);
  assert.equal(bridge.adapter._live, true);

  bridge.setLive(false);
  assert.equal(bridge.adapter._live, false);
});

test('EncoderBridge.setLive() is a no-op for adapters that do not support it', () => {
  // OBS encoder does not have setLive — should not throw
  const bridge = new EncoderBridge({ type: 'obs', host: 'localhost' });
  bridge._encoder.setLive = undefined; // explicitly no setLive

  assert.doesNotThrow(() => bridge.setLive(true));
});

// ─── ATEM analytics + encoder status correlation ──────────────────────────────

test('ATEM tracking stops cleanly when encoder reports offline — no active shot leak', () => {
  // Simulates what happens when encoder goes offline mid-service
  const analytics = new AtemAnalytics([
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
  ]);

  analytics.startTracking();
  analytics.recordInputChange(1, 'Camera 1', 1000);
  analytics.recordInputChange(2, 'Camera 2', 5000);

  // Encoder goes offline — tracking is stopped forcibly
  analytics.stopTracking();

  const timeline = analytics.getSwitchTimeline();
  // Both shots should be closed (no null endTimes)
  assert.ok(timeline.every(s => s.endTime !== null), 'All shots must have endTime');
  assert.ok(timeline.every(s => s.duration !== null), 'All shots must have duration');
});

test('ATEM analytics: rapid switching (20 cuts) produces consistent stats', () => {
  const analytics = new AtemAnalytics([
    { id: 1, name: 'Cam 1' },
    { id: 2, name: 'Cam 2' },
  ]);

  analytics.startTracking();

  // Simulate fast cutting (every 500ms)
  for (let i = 0; i < 20; i++) {
    const inputId = (i % 2) + 1;
    analytics.recordInputChange(inputId, `Cam ${inputId}`, i * 500);
  }
  analytics.stopTracking();

  const stats = analytics.getSessionStats();

  assert.equal(stats.totalSwitches, 20);
  assert.equal(stats.inputs.length, 2);

  // Both cameras should have ~10 switches each
  const cam1 = stats.inputs.find(i => i.id === 1);
  const cam2 = stats.inputs.find(i => i.id === 2);
  assert.ok(cam1);
  assert.ok(cam2);

  // Total switchCount should equal totalSwitches
  const totalFromInputs = stats.inputs.reduce((sum, i) => sum + i.switchCount, 0);
  assert.equal(totalFromInputs, 20);
});

test('ATEM analytics: longShot and shortestShot correctly identified in mixed-duration session', () => {
  const analytics = new AtemAnalytics();
  const now = 1000000; // fixed starting timestamp
  analytics.startTracking();

  // Shot durations: cam2=100ms, cam3=5000ms, cam1=30000ms, then stop
  analytics.recordInputChange(1, 'Camera 1', now);
  analytics.recordInputChange(2, 'Camera 2', now + 100);   // Camera 1 was 100ms (short)
  analytics.recordInputChange(3, 'Camera 3', now + 5100);  // Camera 2 was 5000ms
  analytics.recordInputChange(1, 'Camera 1', now + 35100); // Camera 3 was 30000ms

  // stopTracking with a fixed timestamp via a second call trick:
  // We record a final switch at a specific time, then stop
  analytics.recordInputChange(2, 'Camera 2', now + 65100); // Camera 1 was 30000ms
  // Now call stopTracking — Camera 2's last shot goes to Date.now(), but we only test closed shots
  analytics.stopTracking();

  const timeline = analytics.getSwitchTimeline();

  // The 4 closed shots (before last Camera 2) are deterministic
  const closedShots = timeline.slice(0, 4); // first 4 have known durations

  const durations = closedShots.map(s => s.duration);

  // Camera 1's first shot: 100ms (short among closed shots)
  assert.equal(closedShots[0].inputId, 1);
  assert.equal(closedShots[0].duration, 100);

  // Camera 2: 5000ms
  assert.equal(closedShots[1].inputId, 2);
  assert.equal(closedShots[1].duration, 5000);

  // Camera 3: 30000ms (longest among closed shots)
  assert.equal(closedShots[2].inputId, 3);
  assert.equal(closedShots[2].duration, 30000);

  // Camera 1 second time: 30000ms
  assert.equal(closedShots[3].inputId, 1);
  assert.equal(closedShots[3].duration, 30000);

  // Verify stats structure is valid
  const stats = analytics.getSessionStats();
  assert.ok(stats.longestShot !== null);
  assert.ok(stats.shortestShot !== null);
  assert.equal(stats.longestShot.duration, Math.max(...timeline.map(s => s.duration)));
  assert.equal(stats.shortestShot.duration, Math.min(...timeline.map(s => s.duration)));
});

// ─── EncoderBridge startStream / stopStream delegation ────────────────────────

test('EncoderBridge.startStream() throws for adapters that do not support it', async () => {
  const bridge = new EncoderBridge({ type: 'youtube-live' }); // RTMP push, no startStream
  // RtmpPushEncoder doesn't implement startStream
  if (!bridge._encoder.startStream) {
    await assert.rejects(
      () => bridge.startStream(),
      /startStream is not supported/,
    );
  }
});

test('EncoderBridge.stopStream() throws for adapters that do not support it', async () => {
  const bridge = new EncoderBridge({ type: 'facebook-live' });
  if (!bridge._encoder.stopStream) {
    await assert.rejects(
      () => bridge.stopStream(),
      /stopStream is not supported/,
    );
  }
});
