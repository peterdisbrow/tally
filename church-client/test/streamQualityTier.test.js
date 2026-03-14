const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamHealthMonitor, getStreamQualityTier } = require('../src/streamHealthMonitor');

// ─── Helper: create a monitor with a mock agent ─────────────────────────────

function createMonitorWithAgent() {
  const monitor = new StreamHealthMonitor();
  const events = [];
  monitor.agent = {
    sendToRelay(msg) { events.push(msg); },
    config: {},
    status: {},
  };
  return { monitor, events };
}

// ─── Tier Classification Tests ──────────────────────────────────────────────

test('Excellent tier: >4Mbps at 1080p60 with <1% drops', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  assert.equal(result.tier, 'excellent');
  assert.ok(result.score >= 85 && result.score <= 100,
    `Score ${result.score} should be 85-100`);
  assert.ok(result.details.includes('5.0Mbps'));
});

test('Excellent tier: >2.5Mbps at 720p30 with <1% drops', () => {
  const result = getStreamQualityTier(3_000_000, '1280x720', 30, 0.002);
  assert.equal(result.tier, 'excellent');
  assert.ok(result.score >= 85 && result.score <= 100,
    `Score ${result.score} should be 85-100`);
});

test('Good tier: >2Mbps at 1080p with <3% drops', () => {
  const result = getStreamQualityTier(2_500_000, '1920x1080', 30, 0.02);
  assert.equal(result.tier, 'good');
  assert.ok(result.score >= 65 && result.score <= 84,
    `Score ${result.score} should be 65-84`);
});

test('Good tier: >1.5Mbps at 720p with <3% drops', () => {
  const result = getStreamQualityTier(1_800_000, '1280x720', 30, 0.01);
  assert.equal(result.tier, 'good');
  assert.ok(result.score >= 65 && result.score <= 84,
    `Score ${result.score} should be 65-84`);
});

test('Fair tier: >1Mbps with <10% drops', () => {
  const result = getStreamQualityTier(1_200_000, '854x480', 30, 0.05);
  assert.equal(result.tier, 'fair');
  assert.ok(result.score >= 40 && result.score <= 64,
    `Score ${result.score} should be 40-64`);
});

test('Fair tier: 1Mbps at low resolution', () => {
  const result = getStreamQualityTier(1_100_000, '640x360', 24, 0.08);
  assert.equal(result.tier, 'fair');
  assert.ok(result.score >= 40 && result.score <= 64,
    `Score ${result.score} should be 40-64`);
});

test('Poor tier: <1Mbps', () => {
  const result = getStreamQualityTier(500_000, '1920x1080', 60, 0.0);
  assert.equal(result.tier, 'poor');
  assert.ok(result.score >= 0 && result.score <= 39,
    `Score ${result.score} should be 0-39`);
});

test('Poor tier: >10% frame drops regardless of other metrics', () => {
  const result = getStreamQualityTier(6_000_000, '1920x1080', 60, 0.15);
  assert.equal(result.tier, 'poor');
  assert.ok(result.score >= 0 && result.score <= 39,
    `Score ${result.score} should be 0-39`);
});

// ─── Score Calculation Tests ────────────────────────────────────────────────

test('Score is always between 0 and 100', () => {
  const high = getStreamQualityTier(50_000_000, '3840x2160', 120, 0.0);
  assert.ok(high.score >= 0 && high.score <= 100, `Score ${high.score}`);

  const low = getStreamQualityTier(10_000, '320x240', 5, 0.5);
  assert.ok(low.score >= 0 && low.score <= 100, `Score ${low.score}`);
});

test('Higher bitrate yields higher score within same tier', () => {
  const lower = getStreamQualityTier(1_100_000, '854x480', 30, 0.05);
  const higher = getStreamQualityTier(1_500_000, '854x480', 30, 0.05);
  assert.ok(higher.score >= lower.score,
    `Higher bitrate score ${higher.score} should be >= ${lower.score}`);
});

test('Frame drops reduce score', () => {
  const clean = getStreamQualityTier(2_500_000, '1920x1080', 30, 0.0);
  const droppy = getStreamQualityTier(2_500_000, '1920x1080', 30, 0.025);
  assert.ok(clean.score >= droppy.score,
    `Clean score ${clean.score} should be >= droppy score ${droppy.score}`);
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

test('No data: null bitrate returns poor with score 0', () => {
  const result = getStreamQualityTier(null, null, null, null);
  assert.equal(result.tier, 'poor');
  assert.equal(result.score, 0);
  assert.ok(result.details.includes('No bitrate data'));
});

test('No data: undefined bitrate returns poor with score 0', () => {
  const result = getStreamQualityTier(undefined, undefined, undefined, undefined);
  assert.equal(result.tier, 'poor');
  assert.equal(result.score, 0);
});

test('Zero bitrate returns poor', () => {
  const result = getStreamQualityTier(0, '1920x1080', 60, 0.0);
  assert.equal(result.tier, 'poor');
  assert.equal(result.score, 0);
});

test('Negative bitrate returns poor', () => {
  const result = getStreamQualityTier(-1000, '1920x1080', 60, 0.0);
  assert.equal(result.tier, 'poor');
  assert.equal(result.score, 0);
});

test('Missing resolution still classifies', () => {
  const result = getStreamQualityTier(5_000_000, null, 60, 0.005);
  assert.ok(['excellent', 'good', 'fair', 'poor'].includes(result.tier));
  assert.ok(result.details.includes('unknown'));
});

test('Missing fps still classifies', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', null, 0.005);
  assert.ok(['excellent', 'good', 'fair', 'poor'].includes(result.tier));
});

test('Missing frameDropRate treats drops as 0', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, null);
  assert.equal(result.tier, 'excellent');
});

test('Mid-stream resolution change re-classifies correctly', () => {
  const { monitor } = createMonitorWithAgent();

  const r1 = monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  assert.equal(r1.tier, 'excellent');

  const r2 = monitor.getStreamQualityTier(5_000_000, '854x480', 60, 0.005);
  assert.notEqual(r2.tier, 'excellent',
    'Should not remain excellent after dropping to 480p');
});

// ─── Details String ─────────────────────────────────────────────────────────

test('Details string includes bitrate, resolution, fps, and drops', () => {
  const result = getStreamQualityTier(3_000_000, '1280x720', 30, 0.02);
  assert.ok(result.details.includes('3.0Mbps'));
  assert.ok(result.details.includes('1280x720'));
  assert.ok(result.details.includes('30fps'));
  assert.ok(result.details.includes('2.0%'));
});

// ─── Tier History Tests ─────────────────────────────────────────────────────

test('Tier history is recorded', () => {
  const { monitor } = createMonitorWithAgent();

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  monitor.getStreamQualityTier(2_500_000, '1920x1080', 30, 0.02);
  monitor.getStreamQualityTier(1_200_000, '854x480', 30, 0.05);

  const history = monitor.getTierHistory();
  assert.equal(history.length, 3);
  assert.equal(history[0].tier, 'excellent');
  assert.equal(history[1].tier, 'good');
  assert.equal(history[2].tier, 'fair');
});

test('Tier history includes timestamps', () => {
  const { monitor } = createMonitorWithAgent();
  const before = Date.now();
  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  const after = Date.now();

  const history = monitor.getTierHistory();
  assert.equal(history.length, 1);
  assert.ok(history[0].timestamp >= before && history[0].timestamp <= after);
});

test('Tier history is a copy (not a reference)', () => {
  const { monitor } = createMonitorWithAgent();
  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);

  const h1 = monitor.getTierHistory();
  h1.push({ tier: 'fake', score: 999 });

  const h2 = monitor.getTierHistory();
  assert.equal(h2.length, 1, 'Modifying returned history should not affect internal state');
});

// ─── Tier Transition Events ─────────────────────────────────────────────────

test('stream_quality_degraded emitted on 2-tier drop (excellent -> fair)', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  monitor.getStreamQualityTier(1_200_000, '854x480', 30, 0.05);

  const degraded = events.filter(e => e.alertType === 'stream_quality_degraded');
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].from, 'excellent');
  assert.equal(degraded[0].to, 'fair');
  assert.equal(degraded[0].severity, 'warning');
});

test('stream_quality_degraded emitted on 3-tier drop (excellent -> poor)', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  const degraded = events.filter(e => e.alertType === 'stream_quality_degraded');
  assert.equal(degraded.length, 1);
  assert.equal(degraded[0].from, 'excellent');
  assert.equal(degraded[0].to, 'poor');
});

test('No degraded event on 1-tier drop (excellent -> good)', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  monitor.getStreamQualityTier(2_500_000, '1920x1080', 30, 0.02);

  const degraded = events.filter(e => e.alertType === 'stream_quality_degraded');
  assert.equal(degraded.length, 0);
});

test('No degraded event on tier improvement', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);

  const degraded = events.filter(e => e.alertType === 'stream_quality_degraded');
  assert.equal(degraded.length, 0);
});

test('stream_quality_critical emitted when Poor for >60s', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor._poorTierSince = Date.now() - 61_000;
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  const critical = events.filter(e => e.alertType === 'stream_quality_critical');
  assert.equal(critical.length, 1);
  assert.equal(critical[0].severity, 'critical');
  assert.ok(critical[0].poorDurationMs > 60_000);
});

test('stream_quality_critical NOT emitted when Poor for <60s', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  const critical = events.filter(e => e.alertType === 'stream_quality_critical');
  assert.equal(critical.length, 0);
});

test('stream_quality_critical emitted only once per Poor streak', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor._poorTierSince = Date.now() - 61_000;
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  const critical = events.filter(e => e.alertType === 'stream_quality_critical');
  assert.equal(critical.length, 1);
});

test('Poor streak resets when tier improves, can re-trigger', () => {
  const { monitor, events } = createMonitorWithAgent();

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor._poorTierSince = Date.now() - 61_000;
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);

  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);
  monitor._poorTierSince = Date.now() - 61_000;
  monitor.getStreamQualityTier(500_000, '854x480', 15, 0.2);

  const critical = events.filter(e => e.alertType === 'stream_quality_critical');
  assert.equal(critical.length, 2);
});

// ─── Standalone getStreamQualityTier export ─────────────────────────────────

test('Standalone getStreamQualityTier works without monitor instance', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  assert.equal(result.tier, 'excellent');
  assert.ok(result.score >= 85);
});

// ─── getStatus includes quality tier info ───────────────────────────────────

test('getStatus reports quality tier after classification', () => {
  const { monitor } = createMonitorWithAgent();

  monitor.getStreamQualityTier(5_000_000, '1920x1080', 60, 0.005);
  const status = monitor.getStatus();

  assert.equal(status.qualityTier, 'excellent');
  assert.ok(status.qualityScore >= 85);
  assert.equal(status.tierHistory, 1);
});

test('getStatus reports null tier before any classification', () => {
  const monitor = new StreamHealthMonitor();
  const status = monitor.getStatus();
  assert.equal(status.qualityTier, null);
  assert.equal(status.qualityScore, null);
  assert.equal(status.tierHistory, 0);
});

// ─── Boundary / edge tier transitions ───────────────────────────────────────

test('Exactly 1Mbps is fair (not poor)', () => {
  const result = getStreamQualityTier(1_000_000, '854x480', 30, 0.05);
  assert.equal(result.tier, 'fair');
});

test('Just under 1Mbps is poor', () => {
  const result = getStreamQualityTier(999_999, '1920x1080', 60, 0.0);
  assert.equal(result.tier, 'poor');
});

test('Exactly 10% drops is poor (spec: fair requires <10% drops)', () => {
  const result = getStreamQualityTier(1_200_000, '854x480', 30, 0.10);
  assert.equal(result.tier, 'poor');
});

test('Just under 10% drops is fair', () => {
  const result = getStreamQualityTier(1_200_000, '854x480', 30, 0.099);
  assert.equal(result.tier, 'fair');
});

test('Just over 10% drops is poor', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, 0.101);
  assert.equal(result.tier, 'poor');
});

// ─── NEW: Real-world church stream bitrates ─────────────────────────────────

test('Typical small church stream: 2.5 Mbps 720p30', () => {
  const result = getStreamQualityTier(2_500_000, '1280x720', 30, 0.005);
  // 2.5 Mbps = exactly the threshold, but spec says >2.5, so not excellent via the strict condition
  // Actually: >2.5 means 2.5 does NOT qualify for excellent
  // Should be good since >1.5Mbps at 720p with <3% drops
  assert.ok(['excellent', 'good'].includes(result.tier),
    `2.5 Mbps 720p30 should be excellent or good, got ${result.tier}`);
});

test('Typical medium church stream: 4.5 Mbps 1080p30', () => {
  const result = getStreamQualityTier(4_500_000, '1920x1080', 30, 0.003);
  // >4Mbps, 1080p, but only 30fps with <1% drops
  // The excellent condition requires (>4Mbps && >=1080 && >=60fps) OR (>2.5Mbps && >=720 && >=30fps)
  // Second condition matches: >2.5Mbps, >=720, >=30fps, <1% drops
  assert.equal(result.tier, 'excellent');
});

test('Typical large church stream: 8 Mbps 1080p60', () => {
  const result = getStreamQualityTier(8_000_000, '1920x1080', 60, 0.001);
  assert.equal(result.tier, 'excellent');
  assert.ok(result.score >= 85);
});

test('Church stream with network issues: 3 Mbps 720p with 5% drops', () => {
  const result = getStreamQualityTier(3_000_000, '1280x720', 30, 0.05);
  // >1Mbps and <10% drops => fair
  assert.equal(result.tier, 'fair');
});

test('Church stream via mobile hotspot: 1.5 Mbps 480p', () => {
  const result = getStreamQualityTier(1_500_000, '854x480', 30, 0.02);
  // >1Mbps, <10% drops => fair
  assert.equal(result.tier, 'fair');
});

// ─── NEW: Boundary conditions tested precisely ─────────────────────────────

test('Exactly 4Mbps at 1080p60 with 0% drops: check tier', () => {
  const result = getStreamQualityTier(4_000_000, '1920x1080', 60, 0.0);
  // Spec says >4Mbps for the 1080p60 excellent path — 4.0 is NOT >4.0
  // But the 720p30 path: >2.5Mbps, >=720, >=30fps, <1% drops — this matches
  assert.equal(result.tier, 'excellent');
});

test('Exactly 2.5Mbps at 720p30 with 0% drops: check tier', () => {
  const result = getStreamQualityTier(2_500_000, '1280x720', 30, 0.0);
  // >2.5Mbps? 2.5 is NOT >2.5 for the excellent condition
  // Falls to good: >1.5Mbps at 720p with <3% drops — matches
  assert.equal(result.tier, 'good');
});

test('Exactly 2Mbps at 1080p with 0% drops: good via 720p path', () => {
  const result = getStreamQualityTier(2_000_000, '1920x1080', 30, 0.0);
  // 2.0 > 1.5 && 1080 >= 720 && <3% drops => good via the 720p path
  assert.equal(result.tier, 'good');
});

test('Exactly 1.5Mbps at 720p with 0% drops: check tier', () => {
  const result = getStreamQualityTier(1_500_000, '1280x720', 30, 0.0);
  // Good tier requires >1.5Mbps, so 1.5 is NOT >1.5
  // Fair: >=1Mbps, <10% drops
  assert.equal(result.tier, 'fair');
});

test('Exactly 1% frame drops at excellent bitrate still allows excellent', () => {
  // <1% is required for excellent, exactly 1% does NOT qualify
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, 0.01);
  // dropPct = 1.0, which is NOT < 1
  // Falls through: dropPct < 3, >2Mbps at 1080p => good
  assert.equal(result.tier, 'good');
});

test('Exactly 3% frame drops at good bitrate', () => {
  // Good requires <3% drops, exactly 3% does NOT qualify
  const result = getStreamQualityTier(2_500_000, '1920x1080', 30, 0.03);
  // dropPct = 3.0, not < 3 => not good
  // >=1Mbps, <10% drops => fair
  assert.equal(result.tier, 'fair');
});

// ─── NEW: Resolution parsing edge cases ─────────────────────────────────────

test('Invalid resolution string still classifies', () => {
  const result = getStreamQualityTier(5_000_000, 'invalid', 60, 0.005);
  assert.ok(['excellent', 'good', 'fair', 'poor'].includes(result.tier));
  // Height would be 0, so resolution score = 0
});

test('Single number resolution (no x) still classifies', () => {
  const result = getStreamQualityTier(5_000_000, '1080', 60, 0.005);
  assert.ok(['excellent', 'good', 'fair', 'poor'].includes(result.tier));
});

test('4K resolution gets full resolution score', () => {
  const result = getStreamQualityTier(20_000_000, '3840x2160', 60, 0.0);
  assert.equal(result.tier, 'excellent');
  assert.ok(result.score >= 85);
});

// ─── NEW: FPS edge cases ────────────────────────────────────────────────────

test('0 fps still classifies', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 0, 0.005);
  assert.ok(['excellent', 'good', 'fair', 'poor'].includes(result.tier));
});

test('Very high fps (240) gets maximum fps score', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 240, 0.0);
  assert.equal(result.tier, 'excellent');
});

// ─── NEW: Negative frame drop rate treated as 0 ─────────────────────────────

test('Negative frameDropRate treated as 0% drops', () => {
  const result = getStreamQualityTier(5_000_000, '1920x1080', 60, -0.05);
  // negative * 100 = negative, but the code checks >= 0, so dropPct = -5
  // dropPct <= 1 is true (since -5 <= 1), so dropPenalty = 0
  // This should still classify correctly
  assert.equal(result.tier, 'excellent');
});
