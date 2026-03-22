'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { StreamHealthMonitor } = require('../src/streamHealthMonitor.js');

// ─── getViewerCounts() ────────────────────────────────────────────────────────

describe('getViewerCounts()', () => {
  let mon;
  beforeEach(() => { mon = new StreamHealthMonitor(); });

  test('returns total=0, empty breakdown, empty snapshots when no snapshots', () => {
    const result = mon.getViewerCounts();
    assert.equal(result.total, 0);
    assert.deepEqual(result.breakdown, {});
    assert.deepEqual(result.snapshots, []);
  });

  test('one platform — sums correctly', () => {
    mon._viewerSnapshots = [{ platform: 'youtube', viewers: 100, timestamp: 1000 }];
    const result = mon.getViewerCounts();
    assert.equal(result.total, 100);
    assert.deepEqual(result.breakdown, { youtube: 100 });
    assert.equal(result.snapshots.length, 1);
  });

  test('multiple snapshots same platform — uses the latest timestamp', () => {
    mon._viewerSnapshots = [
      { platform: 'youtube', viewers: 50, timestamp: 1000 },
      { platform: 'youtube', viewers: 80, timestamp: 2000 },
    ];
    const result = mon.getViewerCounts();
    assert.equal(result.total, 80);
    assert.deepEqual(result.breakdown, { youtube: 80 });
  });

  test('multiple platforms — sums all latest snapshots', () => {
    mon._viewerSnapshots = [
      { platform: 'youtube', viewers: 100, timestamp: 1000 },
      { platform: 'facebook', viewers: 50, timestamp: 1000 },
    ];
    const result = mon.getViewerCounts();
    assert.equal(result.total, 150);
    assert.deepEqual(result.breakdown, { youtube: 100, facebook: 50 });
  });

  test('returned snapshots array is a copy, not the same reference', () => {
    mon._viewerSnapshots = [{ platform: 'youtube', viewers: 10, timestamp: 1000 }];
    const result = mon.getViewerCounts();
    assert.notStrictEqual(result.snapshots, mon._viewerSnapshots);
    assert.equal(result.snapshots.length, 1);
  });
});

// ─── _checkBitrate() ──────────────────────────────────────────────────────────

describe('_checkBitrate()', () => {
  let mon;
  beforeEach(() => { mon = new StreamHealthMonitor(); });

  test('returns early (no error, no state change) when _getCurrentBitrate returns null', async () => {
    mon._getCurrentBitrate = () => null;
    await mon._checkBitrate();
    assert.equal(mon._bitrateKbps.length, 0);
    assert.equal(mon._baselineBitrate, null);
  });

  test('pushes reading into _bitrateKbps on first call', async () => {
    mon._getCurrentBitrate = () => ({ bitrateKbps: 3000, source: 'obs' });
    await mon._checkBitrate();
    assert.equal(mon._bitrateKbps.length, 1);
    assert.equal(mon._bitrateKbps[0], 3000);
  });

  test('establishes baseline after BASELINE_SAMPLES (3) calls', async () => {
    mon._getCurrentBitrate = () => ({ bitrateKbps: 5000, source: 'obs' });
    await mon._checkBitrate();
    await mon._checkBitrate();
    // Baseline should NOT be set yet after 2 samples
    assert.equal(mon._baselineBitrate, null);
    await mon._checkBitrate();
    // After 3 samples baseline should be established
    assert.ok(mon._baselineBitrate !== null, 'Baseline should be set after 3 samples');
    assert.equal(mon._baselineBitrate, 5000);
  });

  test('caps rolling window at 5 samples', async () => {
    mon._getCurrentBitrate = () => ({ bitrateKbps: 1000, source: 'obs' });
    for (let i = 0; i < 7; i++) await mon._checkBitrate();
    assert.ok(mon._bitrateKbps.length <= 5);
  });

  test('fires alert on >50% drop from baseline', async () => {
    const alerts = [];
    mon.agent = { sendToRelay: (msg) => alerts.push(msg) };
    // Establish baseline at 5000 kbps
    mon._getCurrentBitrate = () => ({ bitrateKbps: 5000, source: 'obs' });
    for (let i = 0; i < 5; i++) await mon._checkBitrate();
    assert.ok(mon._baselineBitrate !== null);
    // Drop to 2000 kbps (60% drop — above the 50% threshold)
    mon._getCurrentBitrate = () => ({ bitrateKbps: 2000, source: 'obs' });
    for (let i = 0; i < 5; i++) await mon._checkBitrate();
    assert.ok(
      alerts.some(a => a.type === 'alert'),
      'Expected at least one alert to be sent for bitrate drop'
    );
  });

  test('does NOT fire alert when drop is below threshold', async () => {
    const alerts = [];
    mon.agent = { sendToRelay: (msg) => alerts.push(msg) };
    // Establish baseline at 5000 kbps
    mon._getCurrentBitrate = () => ({ bitrateKbps: 5000, source: 'obs' });
    for (let i = 0; i < 5; i++) await mon._checkBitrate();
    // Drop to only 4000 kbps (20% drop — below 50% threshold)
    mon._getCurrentBitrate = () => ({ bitrateKbps: 4000, source: 'obs' });
    for (let i = 0; i < 5; i++) await mon._checkBitrate();
    assert.equal(alerts.length, 0, 'Should not alert on a small drop');
  });

  test('source change resets baseline and buffer', async () => {
    // Establish baseline on 'obs'
    mon._getCurrentBitrate = () => ({ bitrateKbps: 5000, source: 'obs' });
    for (let i = 0; i < 5; i++) await mon._checkBitrate();
    assert.ok(mon._baselineBitrate !== null);
    // Switch source to 'atem'
    mon._getCurrentBitrate = () => ({ bitrateKbps: 5000, source: 'atem' });
    await mon._checkBitrate(); // source changed → baseline reset
    assert.equal(mon._baselineBitrate, null);
    assert.equal(mon._bitrateKbps.length, 1); // only the new sample
  });
});

// ─── _sendAlert() ─────────────────────────────────────────────────────────────

describe('_sendAlert()', () => {
  let mon;
  beforeEach(() => { mon = new StreamHealthMonitor(); });

  test('sends an alert to the agent when agent is set', () => {
    const messages = [];
    mon.agent = { sendToRelay: (msg) => messages.push(msg) };
    mon._sendAlert('test_key', 'test message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'alert');
    assert.equal(messages[0].message, 'test message');
  });

  test('deduplicates alerts with the same key within the dedup window', () => {
    const messages = [];
    mon.agent = { sendToRelay: (msg) => messages.push(msg) };
    mon._sendAlert('test_key', 'msg1');
    mon._sendAlert('test_key', 'msg2'); // same key — should be suppressed
    assert.equal(messages.length, 1);
  });

  test('different keys are NOT deduplicated against each other', () => {
    const messages = [];
    mon.agent = { sendToRelay: (msg) => messages.push(msg) };
    mon._sendAlert('key1', 'msg1');
    mon._sendAlert('key2', 'msg2');
    assert.equal(messages.length, 2);
  });

  test('after dedup window expires, alert is sent again', () => {
    const messages = [];
    mon.agent = { sendToRelay: (msg) => messages.push(msg) };
    mon._sendAlert('test_key', 'first');
    assert.equal(messages.length, 1);
    // Simulate the dedup window having expired by backdating the timestamp
    mon._lastAlertTimes.set('test_key', 0);
    mon._sendAlert('test_key', 'second');
    assert.equal(messages.length, 2);
    assert.equal(messages[1].message, 'second');
  });

  test('does not throw when agent is null', () => {
    mon.agent = null;
    assert.doesNotThrow(() => mon._sendAlert('no_agent_key', 'should not throw'));
  });
});

// ─── getTierHistory() ─────────────────────────────────────────────────────────

describe('getTierHistory()', () => {
  let mon;
  beforeEach(() => { mon = new StreamHealthMonitor(); });

  test('returns an empty array when no tier history exists', () => {
    const h = mon.getTierHistory();
    assert.deepEqual(h, []);
  });

  test('returns a copy of the tier history, not the same reference', () => {
    const now = Date.now();
    mon._tierHistory = [{ tier: 'good', score: 80, details: 'test', timestamp: now }];
    const h = mon.getTierHistory();
    assert.equal(h.length, 1);
    assert.notStrictEqual(h, mon._tierHistory); // must be a copy
  });

  test('returned history contains correct tier data', () => {
    const now = Date.now();
    mon._tierHistory = [
      { tier: 'excellent', score: 90, details: 'detail1', timestamp: now - 1000 },
      { tier: 'good', score: 70, details: 'detail2', timestamp: now },
    ];
    const h = mon.getTierHistory();
    assert.equal(h.length, 2);
    assert.equal(h[0].tier, 'excellent');
    assert.equal(h[1].tier, 'good');
  });

  test('mutating the returned array does not affect internal history', () => {
    const now = Date.now();
    mon._tierHistory = [{ tier: 'fair', score: 55, details: 'test', timestamp: now }];
    const h = mon.getTierHistory();
    h.push({ tier: 'poor', score: 10, details: 'injected', timestamp: now + 1 });
    assert.equal(mon._tierHistory.length, 1); // internal array unchanged
  });
});
