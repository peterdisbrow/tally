const test = require('node:test');
const assert = require('node:assert/strict');

const { AtemAnalytics } = require('../src/atemAnalytics');

// ─── Basic switch tracking ──────────────────────────────────────────────────

test('recordInputChange is ignored when not tracking', () => {
  const a = new AtemAnalytics();
  a.recordInputChange(1, 'Camera 1', 1000);
  assert.deepStrictEqual(a.getSwitchTimeline(), []);
});

test('single input records one timeline entry on stop', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(1, 'Camera 1', 1000);
  a.stopTracking();
  const tl = a.getSwitchTimeline();
  assert.equal(tl.length, 1);
  assert.equal(tl[0].inputId, 1);
  assert.equal(tl[0].inputName, 'Camera 1');
  assert.equal(tl[0].timestamp, 1000);
  assert.ok(tl[0].endTime >= 1000);
  assert.equal(typeof tl[0].duration, 'number');
});

// ─── Multi-input session ────────────────────────────────────────────────────

test('multi-input session tracks switches correctly', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(1, 'Camera 1', 1000);
  a.recordInputChange(2, 'Camera 2', 4000);
  a.recordInputChange(3, 'Camera 3', 7000);
  a.recordInputChange(1, 'Camera 1', 9000);
  a.stopTracking();

  const tl = a.getSwitchTimeline();
  assert.equal(tl.length, 4);

  // First shot: Camera 1, 1000-4000
  assert.equal(tl[0].inputId, 1);
  assert.equal(tl[0].duration, 3000);

  // Second shot: Camera 2, 4000-7000
  assert.equal(tl[1].inputId, 2);
  assert.equal(tl[1].duration, 3000);

  // Third shot: Camera 3, 7000-9000
  assert.equal(tl[2].inputId, 3);
  assert.equal(tl[2].duration, 2000);

  // Fourth shot: Camera 1 again, 9000-stopTime
  assert.equal(tl[3].inputId, 1);
  assert.ok(tl[3].duration >= 0);
});

// ─── Stats computation accuracy ─────────────────────────────────────────────

test('getSessionStats computes correct per-input stats', () => {
  const configured = [
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
    { id: 3, name: 'Camera 3' },
    { id: 4, name: 'Camera 4' },
  ];
  const a = new AtemAnalytics(configured);
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'Camera 1', 0);
  a.recordInputChange(2, 'Camera 2', 5000);
  a.recordInputChange(1, 'Camera 1', 8000);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();

  assert.equal(stats.totalDuration, 10000);
  assert.equal(stats.totalSwitches, 3);

  // Camera 1: 5000 + 2000 = 7000ms, 2 switches
  const cam1 = stats.inputs.find((i) => i.id === 1);
  assert.equal(cam1.timeOnAir, 7000);
  assert.equal(cam1.switchCount, 2);
  assert.equal(cam1.percentOfTotal, 70);

  // Camera 2: 3000ms, 1 switch
  const cam2 = stats.inputs.find((i) => i.id === 2);
  assert.equal(cam2.timeOnAir, 3000);
  assert.equal(cam2.switchCount, 1);
  assert.equal(cam2.percentOfTotal, 30);

  // Avg shot duration: (5000+3000+2000)/3 = 3333
  assert.equal(stats.avgShotDuration, 3333);

  // Longest shot: Camera 1 first shot (5000ms)
  assert.equal(stats.longestShot.input, 1);
  assert.equal(stats.longestShot.duration, 5000);

  // Shortest shot: Camera 1 last shot (2000ms)
  assert.equal(stats.shortestShot.input, 1);
  assert.equal(stats.shortestShot.duration, 2000);
});

// ─── Unused input detection ─────────────────────────────────────────────────

test('unusedInputs lists configured inputs that were never used', () => {
  const configured = [
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
    { id: 3, name: 'Camera 3' },
    { id: 1000, name: 'Color Bars' },
  ];
  const a = new AtemAnalytics(configured);
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'Camera 1', 0);
  a.recordInputChange(3, 'Camera 3', 5000);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.deepStrictEqual(stats.unusedInputs.sort(), [2, 1000].sort());
});

test('unusedInputs is empty when all configured inputs are used', () => {
  const configured = [
    { id: 1, name: 'A' },
    { id: 2, name: 'B' },
  ];
  const a = new AtemAnalytics(configured);
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'A', 0);
  a.recordInputChange(2, 'B', 5000);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.deepStrictEqual(stats.unusedInputs, []);
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('edge case: no switches yields empty stats', () => {
  const a = new AtemAnalytics([{ id: 1, name: 'Camera 1' }]);
  a.startTracking();
  a.stopTracking();

  const stats = a.getSessionStats();
  assert.equal(stats.totalSwitches, 0);
  assert.equal(stats.avgShotDuration, 0);
  assert.equal(stats.longestShot, null);
  assert.equal(stats.shortestShot, null);
  assert.deepStrictEqual(stats.unusedInputs, [1]);
  assert.deepStrictEqual(stats.inputs, []);
});

test('edge case: single input only, never switched away', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(5, 'Pulpit', 0);
  a._sessionEnd = 60000;
  a._tracking = false;
  a._currentInput.endTime = 60000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.equal(stats.totalSwitches, 1);
  assert.equal(stats.inputs.length, 1);
  assert.equal(stats.inputs[0].id, 5);
  assert.equal(stats.inputs[0].timeOnAir, 60000);
  assert.equal(stats.inputs[0].percentOfTotal, 100);
  assert.equal(stats.avgShotDuration, 60000);
  assert.equal(stats.longestShot.duration, 60000);
  assert.equal(stats.shortestShot.duration, 60000);
});

test('edge case: rapid switching (very short shots)', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  for (let i = 0; i < 100; i++) {
    a.recordInputChange(i % 3, `Cam ${i % 3}`, i * 10);
  }
  a._sessionEnd = 1000;
  a._tracking = false;
  a._currentInput.endTime = 1000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.equal(stats.totalSwitches, 100);
  assert.equal(stats.totalDuration, 1000);

  // Each shot is 10ms
  assert.equal(stats.avgShotDuration, 10);

  // All three inputs should be used
  assert.equal(stats.inputs.length, 3);

  // Total time on-air across all inputs should equal totalDuration
  const totalOnAir = stats.inputs.reduce((sum, inp) => sum + inp.timeOnAir, 0);
  assert.equal(totalOnAir, 1000);
});

test('edge case: stopTracking called twice does not duplicate', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(1, 'Camera 1', 1000);
  a.stopTracking();
  const count1 = a.getSwitchTimeline().length;
  a.stopTracking(); // second call should be a no-op
  const count2 = a.getSwitchTimeline().length;
  assert.equal(count1, count2);
});

test('default input name is generated when not provided', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(7, undefined, 1000);
  a.stopTracking();
  const tl = a.getSwitchTimeline();
  assert.equal(tl[0].inputName, 'Input 7');
});

test('inputs are sorted by timeOnAir descending in stats', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'Short', 0);
  a.recordInputChange(2, 'Long', 1000);
  a.recordInputChange(3, 'Medium', 8000);
  a._sessionEnd = 12000;
  a._tracking = false;
  a._currentInput.endTime = 12000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.equal(stats.inputs[0].id, 2);   // 7000ms
  assert.equal(stats.inputs[1].id, 3);   // 4000ms
  assert.equal(stats.inputs[2].id, 1);   // 1000ms
});

// ─── NEW: Concurrent start/stop cycles (session reuse) ─────────────────────

test('startTracking resets all data for a fresh session', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(1, 'Camera 1', 1000);
  a.stopTracking();
  assert.equal(a.getSwitchTimeline().length, 1);

  // Start a new session — previous data should be gone
  a.startTracking();
  assert.deepStrictEqual(a.getSwitchTimeline(), []);
  a.recordInputChange(2, 'Camera 2', 5000);
  a.stopTracking();

  const tl = a.getSwitchTimeline();
  assert.equal(tl.length, 1);
  assert.equal(tl[0].inputId, 2);
});

test('multiple start/stop cycles produce independent stats', () => {
  const a = new AtemAnalytics([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);

  // Session 1
  a.startTracking();
  a.recordInputChange(1, 'A', 0);
  a.recordInputChange(2, 'B', 3000);
  a.stopTracking();
  const stats1 = a.getSessionStats();
  assert.equal(stats1.totalSwitches, 2);

  // Session 2
  a.startTracking();
  a.recordInputChange(1, 'A', 10000);
  a.stopTracking();
  const stats2 = a.getSessionStats();
  assert.equal(stats2.totalSwitches, 1);
  // Session 2 only used input 1
  assert.deepStrictEqual(stats2.unusedInputs, [2]);
});

// ─── NEW: Percentage rounding accuracy ──────────────────────────────────────

test('percentOfTotal rounds to two decimal places', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'A', 0);
  a.recordInputChange(2, 'B', 3333);
  a.recordInputChange(3, 'C', 6666);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  // A: 3333/10000 = 33.33%, B: 3333/10000 = 33.33%, C: 3334/10000 = 33.34%
  for (const inp of stats.inputs) {
    const decimalPlaces = (inp.percentOfTotal.toString().split('.')[1] || '').length;
    assert.ok(decimalPlaces <= 2, `percentOfTotal ${inp.percentOfTotal} should have <=2 decimal places`);
  }
  // Sum should be close to 100
  const totalPct = stats.inputs.reduce((s, i) => s + i.percentOfTotal, 0);
  assert.ok(Math.abs(totalPct - 100) < 1, `total percentages should sum to ~100, got ${totalPct}`);
});

// ─── NEW: configuredInputs with matching IDs ────────────────────────────────

test('configuredInputs with matching IDs correctly identifies unused', () => {
  const configured = [
    { id: 1, name: 'Camera 1' },
    { id: 2, name: 'Camera 2' },
    { id: 1000, name: 'Media Player 1' },
    { id: 2000, name: 'SuperSource' },
  ];
  const a = new AtemAnalytics(configured);
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'Camera 1', 0);
  a.recordInputChange(1000, 'Media Player 1', 5000);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.deepStrictEqual(stats.unusedInputs.sort(), [2, 2000].sort());
});

// ─── NEW: Timeline order correctness ────────────────────────────────────────

test('timeline entries are in chronological order', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'A', 0);
  a.recordInputChange(2, 'B', 2000);
  a.recordInputChange(3, 'C', 5000);
  a.recordInputChange(4, 'D', 8000);
  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const tl = a.getSwitchTimeline();
  for (let i = 1; i < tl.length; i++) {
    assert.ok(tl[i].timestamp >= tl[i - 1].timestamp,
      `Entry ${i} timestamp ${tl[i].timestamp} should be >= entry ${i - 1} timestamp ${tl[i - 1].timestamp}`);
    // Each entry's endTime should match the next entry's timestamp
    assert.equal(tl[i - 1].endTime, tl[i].timestamp,
      `Entry ${i - 1} endTime should equal entry ${i} timestamp`);
  }
});

// ─── NEW: Very long sessions (hours) ────────────────────────────────────────

test('very long session (2 hours) computes correct stats', () => {
  const TWO_HOURS = 2 * 60 * 60 * 1000; // 7,200,000ms
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;

  // Switch every 30 minutes between 2 cameras
  a.recordInputChange(1, 'Pulpit', 0);
  a.recordInputChange(2, 'Wide', 30 * 60 * 1000);
  a.recordInputChange(1, 'Pulpit', 60 * 60 * 1000);
  a.recordInputChange(2, 'Wide', 90 * 60 * 1000);

  a._sessionEnd = TWO_HOURS;
  a._tracking = false;
  a._currentInput.endTime = TWO_HOURS;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.equal(stats.totalDuration, TWO_HOURS);
  assert.equal(stats.totalSwitches, 4);

  // Each input should have 2 switches, 1 hour each
  const pulpit = stats.inputs.find(i => i.id === 1);
  const wide = stats.inputs.find(i => i.id === 2);
  assert.equal(pulpit.timeOnAir, 60 * 60 * 1000);
  assert.equal(wide.timeOnAir, 60 * 60 * 1000);
  assert.equal(pulpit.percentOfTotal, 50);
  assert.equal(wide.percentOfTotal, 50);

  // Avg shot: 2hrs / 4 shots = 30min = 1,800,000ms
  assert.equal(stats.avgShotDuration, 1800000);
});

// ─── NEW: Switching back and forth between same 2 inputs ────────────────────

test('switching back and forth between 2 inputs tracks all shots', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;

  const switchTimes = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
  for (let i = 0; i < switchTimes.length; i++) {
    const inputId = (i % 2) + 1;
    a.recordInputChange(inputId, `Cam ${inputId}`, switchTimes[i]);
  }

  a._sessionEnd = 10000;
  a._tracking = false;
  a._currentInput.endTime = 10000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.equal(stats.totalSwitches, 10);
  assert.equal(stats.inputs.length, 2);

  const cam1 = stats.inputs.find(i => i.id === 1);
  const cam2 = stats.inputs.find(i => i.id === 2);
  assert.equal(cam1.switchCount, 5);
  assert.equal(cam2.switchCount, 5);
  assert.equal(cam1.timeOnAir, 5000);
  assert.equal(cam2.timeOnAir, 5000);

  // Every shot should be exactly 1000ms
  const tl = a.getSwitchTimeline();
  for (const shot of tl) {
    assert.equal(shot.duration, 1000, `Each shot should be 1000ms, got ${shot.duration}`);
  }
});

// ─── NEW: No configuredInputs means empty unusedInputs ──────────────────────

test('no configuredInputs results in empty unusedInputs', () => {
  const a = new AtemAnalytics();
  a._sessionStart = 0;
  a._tracking = true;
  a.recordInputChange(1, 'Camera 1', 0);
  a._sessionEnd = 5000;
  a._tracking = false;
  a._currentInput.endTime = 5000;
  a._timeline.push({ ...a._currentInput });
  a._currentInput = null;

  const stats = a.getSessionStats();
  assert.deepStrictEqual(stats.unusedInputs, []);
});

// ─── NEW: Empty string input name defaults to "Input N" ─────────────────────

test('empty string input name defaults to "Input N"', () => {
  const a = new AtemAnalytics();
  a.startTracking();
  a.recordInputChange(3, '', 1000);
  a.stopTracking();
  const tl = a.getSwitchTimeline();
  assert.equal(tl[0].inputName, 'Input 3');
});

// ─── NEW: timestamp defaults to Date.now() when omitted ─────────────────────

test('timestamp defaults to Date.now when not provided', () => {
  const a = new AtemAnalytics();
  const before = Date.now();
  a.startTracking();
  a.recordInputChange(1, 'Camera 1');
  const after = Date.now();
  a.stopTracking();

  const tl = a.getSwitchTimeline();
  assert.ok(tl[0].timestamp >= before && tl[0].timestamp <= after,
    'timestamp should be approximately Date.now()');
});
