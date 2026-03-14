const test = require('node:test');
const assert = require('node:assert/strict');

const { PresetManager, PTZManager } = require('../src/ptz');

// ─── Preset Save / Recall ────────────────────────────────────────────────────

test('savePreset stores a preset with name and position', () => {
  const pm = new PresetManager();
  const result = pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  assert.equal(result.name, 'Pulpit');
  assert.deepStrictEqual(result.position, { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  assert.ok(result.savedAt);
});

test('savePreset uses default name when none provided', () => {
  const pm = new PresetManager();
  const result = pm.savePreset('cam1', '5', '', { pan: 0, tilt: 0, zoom: 0 });
  assert.equal(result.name, 'Preset 5');
});

test('savePreset throws when position is missing required fields', () => {
  const pm = new PresetManager();
  assert.throws(() => pm.savePreset('cam1', '1', 'Bad', { pan: 0.1 }),
    /Position must include numeric pan, tilt, and zoom/);
  assert.throws(() => pm.savePreset('cam1', '1', 'Bad', null),
    /Position must include numeric pan, tilt, and zoom/);
});

test('savePreset overwrites existing preset with same id', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Old', { pan: 0, tilt: 0, zoom: 0 });
  pm.savePreset('cam1', '1', 'New', { pan: 1, tilt: 1, zoom: 1 });
  const presets = pm.listPresets('cam1');
  assert.equal(presets.length, 1);
  assert.equal(presets[0].name, 'New');
  assert.deepStrictEqual(presets[0].position, { pan: 1, tilt: 1, zoom: 1 });
});

test('recallPreset returns the preset data', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  const result = pm.recallPreset('cam1', '1');
  assert.equal(result.name, 'Pulpit');
  assert.deepStrictEqual(result.position, { pan: 0.5, tilt: -0.2, zoom: 0.3 });
});

test('recallPreset throws for unknown preset', () => {
  const pm = new PresetManager();
  assert.throws(() => pm.recallPreset('cam1', '99'), /Preset 99 not found/);
});

test('recallPreset records history entry', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  pm.recallPreset('cam1', '1');
  const history = pm.getPresetRecallHistory('cam1');
  assert.equal(history.length, 1);
  assert.equal(history[0].presetId, '1');
  assert.equal(history[0].name, 'Pulpit');
  assert.ok(history[0].recalledAt);
});

// ─── listPresets ─────────────────────────────────────────────────────────────

test('listPresets returns all saved presets for a camera', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  pm.savePreset('cam1', '2', 'Choir', { pan: -0.3, tilt: 0.1, zoom: 0.8 });
  pm.savePreset('cam2', '1', 'Stage', { pan: 0, tilt: 0, zoom: 0 });

  const cam1Presets = pm.listPresets('cam1');
  assert.equal(cam1Presets.length, 2);

  const cam2Presets = pm.listPresets('cam2');
  assert.equal(cam2Presets.length, 1);
  assert.equal(cam2Presets[0].name, 'Stage');
});

test('listPresets returns empty array for unknown camera', () => {
  const pm = new PresetManager();
  assert.deepStrictEqual(pm.listPresets('unknown'), []);
});

// ─── Position Verification with Tolerance ────────────────────────────────────

test('verifyPresetPosition returns verified true when within tolerance', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  const result = pm.verifyPresetPosition('cam1', '1', { pan: 0.52, tilt: -0.18, zoom: 0.3 }, 0.05);

  assert.equal(result.verified, true);
  assert.deepStrictEqual(result.expected, { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  assert.ok(result.drift.pan < 0.05);
  assert.ok(result.drift.tilt < 0.05);
  assert.ok(result.drift.zoom < 0.05);
});

test('verifyPresetPosition returns verified false when outside tolerance', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  const result = pm.verifyPresetPosition('cam1', '1', { pan: 0.7, tilt: -0.2, zoom: 0.3 }, 0.05);

  assert.equal(result.verified, false);
  assert.ok(result.drift.pan > 0.05);
});

test('verifyPresetPosition uses default tolerance of 0.05', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });

  // Within default tolerance
  const good = pm.verifyPresetPosition('cam1', '1', { pan: 0.54, tilt: -0.16, zoom: 0.34 });
  assert.equal(good.verified, true);

  // Outside default tolerance
  const bad = pm.verifyPresetPosition('cam1', '1', { pan: 0.56, tilt: -0.2, zoom: 0.3 });
  assert.equal(bad.verified, false);
});

test('verifyPresetPosition throws for unknown preset', () => {
  const pm = new PresetManager();
  assert.throws(
    () => pm.verifyPresetPosition('cam1', '99', { pan: 0, tilt: 0, zoom: 0 }),
    /Preset 99 not found/
  );
});

test('verifyPresetPosition updates recall history with verification data', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'Pulpit', { pan: 0.5, tilt: -0.2, zoom: 0.3 });
  pm.recallPreset('cam1', '1');
  pm.verifyPresetPosition('cam1', '1', { pan: 0.52, tilt: -0.18, zoom: 0.3 }, 0.05);

  const history = pm.getPresetRecallHistory('cam1');
  assert.equal(history[0].verified, true);
  assert.ok(history[0].drift);
  assert.ok(history[0].actual);
});

// ─── Recall History ──────────────────────────────────────────────────────────

test('getPresetRecallHistory returns recent recalls most-recent-first', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'A', { pan: 0, tilt: 0, zoom: 0 });
  pm.savePreset('cam1', '2', 'B', { pan: 1, tilt: 1, zoom: 1 });

  pm.recallPreset('cam1', '1');
  pm.recallPreset('cam1', '2');
  pm.recallPreset('cam1', '1');

  const history = pm.getPresetRecallHistory('cam1');
  assert.equal(history.length, 3);
  assert.equal(history[0].presetId, '1'); // most recent
  assert.equal(history[1].presetId, '2');
  assert.equal(history[2].presetId, '1'); // oldest
});

test('getPresetRecallHistory respects limit parameter', () => {
  const pm = new PresetManager();
  pm.savePreset('cam1', '1', 'A', { pan: 0, tilt: 0, zoom: 0 });

  for (let i = 0; i < 30; i++) {
    pm.recallPreset('cam1', '1');
  }

  const limited = pm.getPresetRecallHistory('cam1', 5);
  assert.equal(limited.length, 5);

  const defaultLimit = pm.getPresetRecallHistory('cam1');
  assert.equal(defaultLimit.length, 20);
});

test('getPresetRecallHistory returns empty for unknown camera', () => {
  const pm = new PresetManager();
  assert.deepStrictEqual(pm.getPresetRecallHistory('unknown'), []);
});

// ─── Manual Move Detection ───────────────────────────────────────────────────

test('updatePosition tracks position changes', () => {
  const pm = new PresetManager();
  pm.updatePosition('cam1', { pan: 0.5, tilt: -0.2, zoom: 0.3 }, 'command');

  const pos = pm.getLastKnownPosition('cam1');
  assert.equal(pos.pan, 0.5);
  assert.equal(pos.tilt, -0.2);
  assert.equal(pos.zoom, 0.3);
  assert.equal(pos.source, 'command');
  assert.ok(pos.timestamp);
});

test('updatePosition emits ptz_manual_move_detected when polled position differs from command position', (t, done) => {
  const pm = new PresetManager();
  pm.updatePosition('cam1', { pan: 0.5, tilt: -0.2, zoom: 0.3 }, 'command');

  pm.on('ptz_manual_move_detected', (event) => {
    assert.equal(event.cameraId, 'cam1');
    assert.deepStrictEqual(event.previous, { pan: 0.5, tilt: -0.2, zoom: 0.3 });
    assert.deepStrictEqual(event.current, { pan: 0.8, tilt: 0.1, zoom: 0.3 });
    assert.ok(event.delta.pan > 0.01);
    assert.ok(event.delta.tilt > 0.01);
    done();
  });

  pm.updatePosition('cam1', { pan: 0.8, tilt: 0.1, zoom: 0.3 }, 'poll');
});

test('updatePosition does NOT emit event when poll shows same position', () => {
  const pm = new PresetManager();
  pm.updatePosition('cam1', { pan: 0.5, tilt: -0.2, zoom: 0.3 }, 'command');

  let emitted = false;
  pm.on('ptz_manual_move_detected', () => { emitted = true; });

  pm.updatePosition('cam1', { pan: 0.505, tilt: -0.195, zoom: 0.3 }, 'poll');
  assert.equal(emitted, false, 'Should not emit for tiny sub-threshold changes');
});

test('updatePosition does NOT emit event for sequential command updates', () => {
  const pm = new PresetManager();
  pm.updatePosition('cam1', { pan: 0.5, tilt: -0.2, zoom: 0.3 }, 'command');

  let emitted = false;
  pm.on('ptz_manual_move_detected', () => { emitted = true; });

  pm.updatePosition('cam1', { pan: 0.9, tilt: 0.5, zoom: 0.1 }, 'command');
  assert.equal(emitted, false, 'Should not emit for command-to-command transitions');
});

test('getPositionHistory returns tracked positions', () => {
  const pm = new PresetManager();
  pm.updatePosition('cam1', { pan: 0, tilt: 0, zoom: 0 }, 'command');
  pm.updatePosition('cam1', { pan: 0.5, tilt: 0.5, zoom: 0.5 }, 'poll');
  pm.updatePosition('cam1', { pan: 1, tilt: 1, zoom: 1 }, 'command');

  const history = pm.getPositionHistory('cam1');
  assert.equal(history.length, 3);
  assert.equal(history[0].pan, 0);
  assert.equal(history[2].pan, 1);
});

test('getPositionHistory respects limit', () => {
  const pm = new PresetManager();
  for (let i = 0; i < 100; i++) {
    pm.updatePosition('cam1', { pan: i * 0.01, tilt: 0, zoom: 0 }, 'command');
  }
  const limited = pm.getPositionHistory('cam1', 10);
  assert.equal(limited.length, 10);
});

test('getLastKnownPosition returns null for unknown camera', () => {
  const pm = new PresetManager();
  assert.equal(pm.getLastKnownPosition('unknown'), null);
});

// ─── PTZManager integration ─────────────────────────────────────────────────

test('PTZManager exposes a presetManager instance', () => {
  const mgr = new PTZManager([]);
  assert.ok(mgr.presetManager instanceof PresetManager);
});

// ─── Protocol handling ───────────────────────────────────────────────────────

test('presetManager works independently of PTZ protocol', () => {
  const pm = new PresetManager();
  // Save and recall should work for any camera ID regardless of protocol
  pm.savePreset('onvif-cam', '1', 'Wide', { pan: 0, tilt: 0, zoom: 0 });
  pm.savePreset('visca-cam', '1', 'Wide', { pan: 0, tilt: 0, zoom: 0 });

  const onvifPresets = pm.listPresets('onvif-cam');
  const viscaPresets = pm.listPresets('visca-cam');
  assert.equal(onvifPresets.length, 1);
  assert.equal(viscaPresets.length, 1);

  // Recall and verify work the same regardless of camera type
  pm.recallPreset('onvif-cam', '1');
  pm.recallPreset('visca-cam', '1');

  const v1 = pm.verifyPresetPosition('onvif-cam', '1', { pan: 0.01, tilt: 0.01, zoom: 0.01 }, 0.05);
  const v2 = pm.verifyPresetPosition('visca-cam', '1', { pan: 0.01, tilt: 0.01, zoom: 0.01 }, 0.05);
  assert.equal(v1.verified, true);
  assert.equal(v2.verified, true);
});
