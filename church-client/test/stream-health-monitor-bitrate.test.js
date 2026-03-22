/**
 * StreamHealthMonitor — Source Detection, Bitrate Monitoring & Viewer Tracking
 *
 * The quality-tier classification is already covered by streamQualityTier.test.js.
 * This file covers the remaining logic:
 *
 *   - _getActiveStreamSource(): which device is streaming
 *   - _getCurrentBitrate(): read bitrate from OBS / ATEM / encoder
 *   - _checkBitrate(): baseline establishment, drop detection, source-change reset
 *   - _sendAlert(): deduplication within 5-min window
 *   - _recordViewerSnapshot() / getViewerCounts(): viewer tracking
 *   - check(): resets baseline when no stream is active
 *   - stop(): clears all state
 *   - getStatus(): reflects internal state accurately
 *
 * All tests are deterministic — no timers, no network, no ATEM/OBS connections.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamHealthMonitor } = require('../src/streamHealthMonitor');

// ─── Helper: create a monitor with a mock agent ───────────────────────────────

function createMonitor(statusOverrides = {}, configOverrides = {}) {
  const monitor = new StreamHealthMonitor();
  const relayMessages = [];
  monitor.agent = {
    sendToRelay: (msg) => relayMessages.push(msg),
    config: { ...configOverrides },
    status: { ...statusOverrides },
  };
  monitor.relayMessages = relayMessages;
  return monitor;
}

// ─── _getActiveStreamSource ───────────────────────────────────────────────────

test('_getActiveStreamSource: returns null when agent is null', () => {
  const m = new StreamHealthMonitor();
  assert.equal(m._getActiveStreamSource(), null);
});

test('_getActiveStreamSource: returns null when nothing is streaming', () => {
  const m = createMonitor({ obs: { streaming: false }, atem: { streaming: false } });
  assert.equal(m._getActiveStreamSource(), null);
});

test('_getActiveStreamSource: detects OBS streaming', () => {
  const m = createMonitor({ obs: { streaming: true } });
  assert.equal(m._getActiveStreamSource(), 'obs');
});

test('_getActiveStreamSource: detects ATEM built-in encoder streaming', () => {
  const m = createMonitor({ atem: { streaming: true } });
  assert.equal(m._getActiveStreamSource(), 'atem');
});

test('_getActiveStreamSource: detects vMix streaming', () => {
  const m = createMonitor({ vmix: { streaming: true } });
  assert.equal(m._getActiveStreamSource(), 'vmix');
});

test('_getActiveStreamSource: detects encoder live by type', () => {
  const m = createMonitor({ encoder: { live: true, type: 'blackmagic' } });
  assert.equal(m._getActiveStreamSource(), 'blackmagic');
});

test('_getActiveStreamSource: detects encoder streaming flag', () => {
  const m = createMonitor({ encoder: { streaming: true, type: 'teradek' } });
  assert.equal(m._getActiveStreamSource(), 'teradek');
});

test('_getActiveStreamSource: encoder without type falls back to "encoder"', () => {
  const m = createMonitor({ encoder: { live: true } });
  assert.equal(m._getActiveStreamSource(), 'encoder');
});

test('_getActiveStreamSource: OBS takes priority over ATEM when both streaming', () => {
  const m = createMonitor({ obs: { streaming: true }, atem: { streaming: true } });
  assert.equal(m._getActiveStreamSource(), 'obs');
});

test('_getActiveStreamSource: encoder.live=false is not streaming', () => {
  const m = createMonitor({ encoder: { live: false, type: 'obs' } });
  assert.equal(m._getActiveStreamSource(), null);
});

// ─── _getCurrentBitrate ───────────────────────────────────────────────────────

test('_getCurrentBitrate: returns null when agent is null', () => {
  const m = new StreamHealthMonitor();
  assert.equal(m._getCurrentBitrate(), null);
});

test('_getCurrentBitrate: reads bitrate from OBS in kbps', () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });
  const result = m._getCurrentBitrate();
  assert.deepStrictEqual(result, { bitrateKbps: 4500, source: 'OBS' });
});

test('_getCurrentBitrate: OBS bitrate of 0 is not returned (no reading)', () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 0 } });
  const result = m._getCurrentBitrate();
  assert.equal(result, null, 'OBS bitrate=0 should be treated as no data');
});

test('_getCurrentBitrate: ATEM bitrate is in bps and gets converted to kbps', () => {
  const m = createMonitor({ atem: { streaming: true, streamingBitrate: 4_500_000 } });
  const result = m._getCurrentBitrate();
  assert.deepStrictEqual(result, { bitrateKbps: 4500, source: 'ATEM' });
});

test('_getCurrentBitrate: ATEM 3Mbps converts to 3000 kbps', () => {
  const m = createMonitor({ atem: { streaming: true, streamingBitrate: 3_000_000 } });
  assert.equal(m._getCurrentBitrate().bitrateKbps, 3000);
});

test('_getCurrentBitrate: reads from hardware encoder', () => {
  const m = createMonitor({ encoder: { live: true, bitrateKbps: 5000, type: 'epiphan' } });
  const result = m._getCurrentBitrate();
  assert.deepStrictEqual(result, { bitrateKbps: 5000, source: 'epiphan' });
});

test('_getCurrentBitrate: encoder without type uses "Encoder" as source label', () => {
  const m = createMonitor({ encoder: { live: true, bitrateKbps: 3000 } });
  assert.equal(m._getCurrentBitrate().source, 'Encoder');
});

test('_getCurrentBitrate: vMix does not expose bitrate (returns null)', () => {
  const m = createMonitor({ vmix: { streaming: true } });
  assert.equal(m._getCurrentBitrate(), null);
});

// ─── _checkBitrate: baseline establishment ────────────────────────────────────

test('_checkBitrate: no baseline before 3 samples', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });

  await m._checkBitrate();
  assert.equal(m._baselineBitrate, null, 'No baseline after sample 1');

  await m._checkBitrate();
  assert.equal(m._baselineBitrate, null, 'No baseline after sample 2');

  await m._checkBitrate();
  assert.ok(m._baselineBitrate !== null, 'Baseline should be set after 3 samples');
});

test('_checkBitrate: baseline is the average of first 3 samples', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4000 } });

  await m._checkBitrate(); // 4000
  m.agent.status.obs.bitrate = 5000;
  await m._checkBitrate(); // 5000
  m.agent.status.obs.bitrate = 6000;
  await m._checkBitrate(); // 6000 → avg = 5000

  assert.ok(Math.abs(m._baselineBitrate - 5000) < 1, `Expected 5000, got ${m._baselineBitrate}`);
});

test('_checkBitrate: keeps a rolling window of at most 5 samples', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });

  for (let i = 0; i < 10; i++) {
    await m._checkBitrate();
  }

  assert.ok(m._bitrateKbps.length <= 5, `Window should be <=5, got ${m._bitrateKbps.length}`);
});

test('_checkBitrate: no data (bitrate=0) skips sample collection', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 0 } });

  await m._checkBitrate();
  assert.equal(m._bitrateKbps.length, 0, 'Zero bitrate should not be collected');
  assert.equal(m._baselineBitrate, null);
});

// ─── _checkBitrate: drop detection ────────────────────────────────────────────

test('_checkBitrate: no alert for a sub-50% bitrate drop', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });

  // Establish baseline at 4500
  await m._checkBitrate();
  await m._checkBitrate();
  await m._checkBitrate();

  // Drop to 3500 — only ~22% drop, below 50% threshold
  m.agent.status.obs.bitrate = 3500;
  await m._checkBitrate();
  await m._checkBitrate();
  await m._checkBitrate();

  const alerts = m.relayMessages.filter(r => r.alertType === 'stream_platform_health');
  assert.equal(alerts.length, 0, 'No alert for sub-50% drop');
});

test('_checkBitrate: alert fires when average bitrate drops >50% from baseline', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });

  // Establish baseline at 4500 kbps
  await m._checkBitrate();
  await m._checkBitrate();
  await m._checkBitrate();

  // Massive drop to 500 kbps
  m.agent.status.obs.bitrate = 500;
  // Window needs enough low samples to push rolling avg below 50% of baseline
  // After samples: [4500,4500,4500] then add [500,500,500]
  // At sample 6 window = [4500,4500,500,500,500] avg=2300 → drop=49% < 50
  // At sample 7 window = [4500,500,500,500,500] avg=1700 → drop=62% > 50 → ALERT
  for (let i = 0; i < 5; i++) {
    await m._checkBitrate();
  }

  const alerts = m.relayMessages.filter(r => r.alertType === 'stream_platform_health');
  assert.ok(alerts.length > 0, 'Alert should fire on sustained >50% bitrate drop');
  assert.ok(alerts[0].message.includes('bitrate dropped'));
});

test('_checkBitrate: source change resets baseline', async () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });

  // Establish OBS baseline
  await m._checkBitrate();
  await m._checkBitrate();
  await m._checkBitrate();
  assert.ok(m._baselineBitrate !== null);
  assert.equal(m._lastBitrateSource, 'OBS');

  // Switch source to ATEM
  m.agent.status.obs.streaming = false;
  m.agent.status.obs.bitrate = 0;
  m.agent.status.atem = { streaming: true, streamingBitrate: 3_000_000 };

  await m._checkBitrate();

  assert.equal(m._baselineBitrate, null, 'Baseline should reset on source change');
  assert.equal(m._lastBitrateSource, 'ATEM');
  assert.equal(m._bitrateKbps.length, 1, 'New sample should start collection');
});

// ─── check() resets state when not streaming ──────────────────────────────────

test('check(): resets baseline and samples when no source is active', async () => {
  const m = createMonitor({ obs: { streaming: false } });
  m._baselineBitrate = 4500;
  m._bitrateKbps = [4500, 4500, 4500];
  m._lastBitrateSource = 'OBS';

  await m.check();

  assert.equal(m._baselineBitrate, null, 'Baseline should be cleared');
  assert.deepStrictEqual(m._bitrateKbps, [], 'Samples should be cleared');
  assert.equal(m._lastBitrateSource, null);
});

// ─── _sendAlert: deduplication ────────────────────────────────────────────────

test('_sendAlert: same key within 5-min window is suppressed', () => {
  const m = createMonitor();

  m._sendAlert('test_key', 'First');
  m._sendAlert('test_key', 'Duplicate');

  const alerts = m.relayMessages.filter(r => r.alertType === 'stream_platform_health');
  assert.equal(alerts.length, 1, 'Second alert within window should be suppressed');
});

test('_sendAlert: different keys are sent independently', () => {
  const m = createMonitor();

  m._sendAlert('key_a', 'Alert A');
  m._sendAlert('key_b', 'Alert B');

  const alerts = m.relayMessages.filter(r => r.alertType === 'stream_platform_health');
  assert.equal(alerts.length, 2);
});

test('_sendAlert: alert message is included in relay payload', () => {
  const m = createMonitor();
  m._sendAlert('my_key', 'Stream is failing');

  const alert = m.relayMessages.find(r => r.alertType === 'stream_platform_health');
  assert.ok(alert);
  assert.ok(alert.message.includes('Stream is failing'));
  assert.equal(alert.severity, 'warning');
});

// ─── _recordViewerSnapshot / getViewerCounts ──────────────────────────────────

test('_recordViewerSnapshot: records a viewer count', () => {
  const m = createMonitor();
  m._lastViewerReport = Date.now(); // prevent relay send in this test

  m._recordViewerSnapshot('youtube', 150);

  const counts = m.getViewerCounts();
  assert.equal(counts.breakdown.youtube, 150);
  assert.equal(counts.total, 150);
});

test('_recordViewerSnapshot: accumulates multiple platforms', () => {
  const m = createMonitor();
  m._lastViewerReport = Date.now();

  m._recordViewerSnapshot('youtube', 100);
  m._lastViewerReport = Date.now();
  m._recordViewerSnapshot('facebook', 200);
  m._lastViewerReport = Date.now();

  const counts = m.getViewerCounts();
  assert.equal(counts.breakdown.youtube, 100);
  assert.equal(counts.breakdown.facebook, 200);
  assert.equal(counts.total, 300);
});

test('_recordViewerSnapshot: caps internal snapshots at 60', () => {
  const m = createMonitor();

  for (let i = 0; i < 70; i++) {
    m._lastViewerReport = Date.now(); // prevent relay send
    m._recordViewerSnapshot('youtube', i);
  }

  assert.equal(m._viewerSnapshots.length, 60, 'Should cap at 60 snapshots');
});

test('getViewerCounts: returns only the latest snapshot per platform', () => {
  const m = createMonitor();
  const now = Date.now();

  // Two YouTube snapshots — latest should win
  m._viewerSnapshots.push({ platform: 'youtube', viewers: 50,  timestamp: now - 5000 });
  m._viewerSnapshots.push({ platform: 'youtube', viewers: 75,  timestamp: now });

  const counts = m.getViewerCounts();
  assert.equal(counts.breakdown.youtube, 75, 'Should return latest snapshot');
  assert.equal(counts.total, 75);
});

test('getViewerCounts: multiple platforms sum correctly', () => {
  const m = createMonitor();
  const now = Date.now();

  m._viewerSnapshots.push({ platform: 'youtube',  viewers: 100, timestamp: now });
  m._viewerSnapshots.push({ platform: 'facebook', viewers: 50,  timestamp: now });
  m._viewerSnapshots.push({ platform: 'vimeo',    viewers: 25,  timestamp: now });

  assert.equal(m.getViewerCounts().total, 175);
});

test('getViewerCounts: returns a copy of snapshots (not the internal array)', () => {
  const m = createMonitor();
  m._viewerSnapshots.push({ platform: 'youtube', viewers: 100, timestamp: Date.now() });

  const counts = m.getViewerCounts();
  counts.snapshots.push({ fake: true });

  assert.equal(m._viewerSnapshots.length, 1, 'Internal array should not be modified');
});

test('getViewerCounts: returns 0 total and empty breakdown when no snapshots', () => {
  const m = new StreamHealthMonitor();
  const counts = m.getViewerCounts();
  assert.equal(counts.total, 0);
  assert.deepStrictEqual(counts.breakdown, {});
  assert.deepStrictEqual(counts.snapshots, []);
});

// ─── stop() clears state ──────────────────────────────────────────────────────

test('stop(): clears baseline, samples, and source', () => {
  const m = createMonitor({ obs: { streaming: true, bitrate: 4500 } });
  m._baselineBitrate = 4500;
  m._bitrateKbps = [4500, 4500, 4500];
  m._lastBitrateSource = 'OBS';
  m._viewerSnapshots = [{ platform: 'youtube', viewers: 100, timestamp: Date.now() }];

  m.stop();

  assert.equal(m._baselineBitrate, null);
  assert.deepStrictEqual(m._bitrateKbps, []);
  assert.equal(m._lastBitrateSource, null);
  assert.equal(m.agent, null);
  assert.equal(m._interval, null);
  assert.deepStrictEqual(m._viewerSnapshots, []);
});

// ─── getStatus() ──────────────────────────────────────────────────────────────

test('getStatus: returns null fields when no data', () => {
  const m = new StreamHealthMonitor();
  const s = m.getStatus();
  assert.equal(s.monitoring, false);
  assert.equal(s.baselineBitrate, null);
  assert.equal(s.recentBitrate, null);
  assert.equal(s.qualityTier, null);
  assert.equal(s.qualityScore, null);
  assert.equal(s.tierHistory, 0);
  assert.equal(s.viewers, null);
  assert.equal(s.viewerBreakdown, null);
});

test('getStatus: reports baseline bitrate as formatted string', () => {
  const m = createMonitor();
  m._baselineBitrate = 4500;
  m._lastBitrateSource = 'OBS';

  const s = m.getStatus();
  assert.equal(s.baselineBitrate, '4500 kbps');
  assert.equal(s.streamSource, 'OBS');
});

test('getStatus: reports recent bitrate average', () => {
  const m = createMonitor();
  m._bitrateKbps = [4000, 5000, 6000];

  const s = m.getStatus();
  // avg = 5000
  assert.equal(s.recentBitrate, '5000 kbps');
});

test('getStatus: reports viewer count from snapshots', () => {
  const m = createMonitor();
  m._viewerSnapshots.push({ platform: 'youtube', viewers: 250, timestamp: Date.now() });

  const s = m.getStatus();
  assert.equal(s.viewers, 250);
  assert.deepStrictEqual(s.viewerBreakdown, { youtube: 250 });
});

test('getStatus: viewers is null when there are no snapshots', () => {
  const m = createMonitor();
  const s = m.getStatus();
  assert.equal(s.viewers, null);
  assert.equal(s.viewerBreakdown, null);
});

test('getStatus: tierHistory reflects recorded classifications', () => {
  const m = createMonitor();
  m.agent = {
    sendToRelay: () => {},
    config: {},
    status: {},
  };

  m.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005); // excellent
  m.getStreamQualityTier(1_200_000, '854x480',   30, 0.05);  // fair

  const s = m.getStatus();
  assert.equal(s.tierHistory, 2);
  assert.equal(s.qualityTier, 'fair');
});
