/**
 * Tests for src/deltaUpdates.js — delta diffing and snapshot tracking for
 * per-instance status updates.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createDeltaTracker,
  diffStatus,
  cloneStatus,
  applyStatusDelta,
} = require('../src/deltaUpdates');

describe('diffStatus', () => {
  it('returns curr as-is when prev is null (first update)', () => {
    const curr = { online: true, atem: { connected: true } };
    expect(diffStatus(null, curr)).toBe(curr);
  });

  it('returns null when nothing changed', () => {
    const prev = { online: true, bitrate: 5000 };
    const curr = { online: true, bitrate: 5000 };
    expect(diffStatus(prev, curr)).toBeNull();
  });

  it('returns changed scalar fields only', () => {
    const prev = { online: true, bitrate: 5000, label: 'Main' };
    const curr = { online: true, bitrate: 6000, label: 'Main' };
    expect(diffStatus(prev, curr)).toEqual({ bitrate: 6000 });
  });

  it('detects nested object changes via JSON.stringify', () => {
    const prev = { atem: { connected: true, input: 1 } };
    const curr = { atem: { connected: true, input: 2 } };
    const delta = diffStatus(prev, curr);
    expect(delta).toEqual({ atem: { connected: true, input: 2 } });
  });

  it('returns null when nested objects are identical', () => {
    const obj = { connected: true, input: 1 };
    const prev = { atem: obj };
    const curr = { atem: { connected: true, input: 1 } };
    expect(diffStatus(prev, curr)).toBeNull();
  });

  it('marks removed keys as null', () => {
    const prev = { online: true, deprecated: 'value' };
    const curr = { online: true };
    const delta = diffStatus(prev, curr);
    expect(delta).toEqual({ deprecated: null });
  });

  it('handles array fields as objects (JSON.stringify comparison)', () => {
    const prev = { streams: [1, 2, 3] };
    const curr = { streams: [1, 2, 4] };
    expect(diffStatus(prev, curr)).toEqual({ streams: [1, 2, 4] });
  });

  it('returns null when arrays are identical', () => {
    const prev = { streams: [1, 2, 3] };
    const curr = { streams: [1, 2, 3] };
    expect(diffStatus(prev, curr)).toBeNull();
  });

  it('handles new keys added in curr', () => {
    const prev = { online: true };
    const curr = { online: true, newField: 'hello' };
    expect(diffStatus(prev, curr)).toEqual({ newField: 'hello' });
  });

  it('handles null values in curr for object comparison', () => {
    const prev = { atem: { connected: true }, obs: null };
    const curr = { atem: null, obs: null };
    // atem changed (object vs null — different types, not both objects)
    const delta = diffStatus(prev, curr);
    expect(delta).toEqual({ atem: null });
  });

  it('detects change from null to object', () => {
    const prev = { atem: null };
    const curr = { atem: { connected: true } };
    const delta = diffStatus(prev, curr);
    expect(delta).toEqual({ atem: { connected: true } });
  });
});

describe('createDeltaTracker', () => {
  it('first computeDelta returns full snapshot with isFull=true', () => {
    const tracker = createDeltaTracker();
    const status = { online: true };
    const result = tracker.computeDelta('church_a', null, status);
    expect(result.isFull).toBe(true);
    expect(result.delta).toEqual(status);
    expect(result.delta).not.toBe(status);
  });

  it('subsequent update with no changes returns delta=null', () => {
    const tracker = createDeltaTracker();
    const status = { online: true, bitrate: 5000 };
    tracker.computeDelta('church_a', null, status);
    const result = tracker.computeDelta('church_a', null, { online: true, bitrate: 5000 });
    expect(result.isFull).toBe(false);
    expect(result.delta).toBeNull();
  });

  it('returns changed fields when status changes', () => {
    const tracker = createDeltaTracker();
    tracker.computeDelta('church_a', null, { online: true, bitrate: 5000 });
    const result = tracker.computeDelta('church_a', null, { online: true, bitrate: 6000 });
    expect(result.isFull).toBe(false);
    expect(result.delta).toEqual({ bitrate: 6000 });
  });

  it('uses instanceName to key snapshots separately', () => {
    const tracker = createDeltaTracker();
    const statusA = { input: 1 };
    const statusB = { input: 2 };

    const r1 = tracker.computeDelta('church_a', 'room-1', statusA);
    const r2 = tracker.computeDelta('church_a', 'room-2', statusB);

    expect(r1.isFull).toBe(true);
    expect(r2.isFull).toBe(true); // different key, treated as first update
  });

  it('clearSnapshot forces next update to be a full snapshot', () => {
    const tracker = createDeltaTracker();
    tracker.computeDelta('church_a', null, { online: true });
    tracker.clearSnapshot('church_a', null);

    const result = tracker.computeDelta('church_a', null, { online: true });
    expect(result.isFull).toBe(true);
  });

  it('clearChurch clears all instances for a church', () => {
    const tracker = createDeltaTracker();
    tracker.computeDelta('church_a', 'room-1', { online: true });
    tracker.computeDelta('church_a', 'room-2', { online: true });
    tracker.computeDelta('church_b', null, { online: true });

    tracker.clearChurch('church_a');

    // church_a instances now get full snapshots
    expect(tracker.computeDelta('church_a', 'room-1', { online: true }).isFull).toBe(true);
    expect(tracker.computeDelta('church_a', 'room-2', { online: true }).isFull).toBe(true);
    // church_b is unaffected (2nd call, not first)
    expect(tracker.computeDelta('church_b', null, { online: true }).isFull).toBe(false);
  });

  it('sends full snapshot every FULL_SNAPSHOT_INTERVAL (30) updates', () => {
    const tracker = createDeltaTracker();
    const status = { online: true };

    // First is full
    tracker.computeDelta('church_a', null, status);

    // Updates 2-29 should be delta (no changes, so null delta, not full)
    for (let i = 2; i < 30; i++) {
      const r = tracker.computeDelta('church_a', null, status);
      expect(r.isFull).toBe(false);
    }

    // 30th update (count % 30 === 0) should be full
    const r30 = tracker.computeDelta('church_a', null, status);
    expect(r30.isFull).toBe(true);
  });

  it('stores new status as snapshot after each update', () => {
    const tracker = createDeltaTracker();
    const first = { online: true, bitrate: 1000 };
    const second = { online: false, bitrate: 2000 };

    tracker.computeDelta('church_a', null, first);
    tracker.computeDelta('church_a', null, second);

    // Third update: only changes relative to second
    const result = tracker.computeDelta('church_a', null, { online: false, bitrate: 3000 });
    expect(result.delta).toEqual({ bitrate: 3000 });
  });

  it('_diffStatus is exposed for testing', () => {
    const tracker = createDeltaTracker();
    expect(typeof tracker._diffStatus).toBe('function');
  });

  it('handles null instanceName same as no instance (keyed by churchId alone)', () => {
    const tracker = createDeltaTracker();
    tracker.computeDelta('church_a', null, { online: true });
    const r = tracker.computeDelta('church_a', null, { online: true });
    expect(r.isFull).toBe(false); // same key, not first update
  });

  it('stores a cloned snapshot so later mutations do not leak back in', () => {
    const tracker = createDeltaTracker();
    const status = { obs: { streaming: false } };
    const first = tracker.computeDelta('church_a', null, status);

    status.obs.streaming = true;
    expect(first.delta.obs.streaming).toBe(false);

    const result = tracker.computeDelta('church_a', null, { obs: { streaming: false } });
    expect(result.delta).toBeNull();
  });
});

describe('cloneStatus', () => {
  it('deep clones nested objects and arrays', () => {
    const original = { obs: { scenes: ['a', 'b'] } };
    const cloned = cloneStatus(original);

    cloned.obs.scenes.push('c');
    expect(original.obs.scenes).toEqual(['a', 'b']);
  });
});

describe('applyStatusDelta', () => {
  it('merges top-level replacements onto the previous status', () => {
    const previous = {
      obs: { connected: true, streaming: false },
      system: { roomId: 'room-1' },
    };

    const next = applyStatusDelta(previous, {
      obs: { connected: true, streaming: true },
    });

    expect(next).toEqual({
      obs: { connected: true, streaming: true },
      system: { roomId: 'room-1' },
    });
    expect(next).not.toBe(previous);
  });

  it('removes keys when the delta sets them to null', () => {
    const next = applyStatusDelta(
      { obs: { connected: true }, cpu: { percent: 20 } },
      { cpu: null }
    );

    expect(next).toEqual({ obs: { connected: true } });
  });

  it('returns a cloned previous snapshot for heartbeat-only deltas', () => {
    const previous = { obs: { connected: true } };
    const next = applyStatusDelta(previous, {});

    expect(next).toEqual(previous);
    expect(next).not.toBe(previous);
  });

  it('builds a fresh object when previous status is missing', () => {
    const next = applyStatusDelta(null, { obs: { connected: true } });
    expect(next).toEqual({ obs: { connected: true } });
  });
});
