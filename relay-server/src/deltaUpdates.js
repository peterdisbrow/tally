'use strict';

/**
 * Delta Updates — computes and sends only changed fields between
 * consecutive status updates, reducing WebSocket payload sizes.
 *
 * Usage:
 *   const { createDeltaTracker } = require('./src/deltaUpdates');
 *   const deltaTracker = createDeltaTracker();
 *
 *   // On each status_update from a church instance:
 *   const delta = deltaTracker.computeDelta(churchId, instanceName, newStatus);
 *   // delta is null if nothing changed, or { ...changedFields } otherwise.
 *
 *   // Periodically send full snapshots to prevent drift:
 *   deltaTracker.clearSnapshot(churchId, instanceName);
 */

function cloneStatus(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function applyStatusDelta(previous, delta) {
  const next = previous && typeof previous === 'object'
    ? cloneStatus(previous)
    : {};

  if (!delta || typeof delta !== 'object') return next;

  for (const [key, value] of Object.entries(delta)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = cloneStatus(value);
    }
  }

  return next;
}

/**
 * Shallow-diff two plain objects (one level deep per top-level key).
 * Returns an object containing only the keys whose values changed,
 * or null if nothing changed.
 *
 * For nested objects (e.g. status.atem, status.obs), compares via
 * JSON.stringify so any nested field change is caught.
 *
 * @param {object} prev - previous status snapshot
 * @param {object} curr - current status object
 * @returns {object|null} changed fields or null if identical
 */
function diffStatus(prev, curr) {
  if (!prev) return curr; // first update — send everything

  const changed = {};
  let hasChanges = false;

  // Check all keys in current status
  for (const key of Object.keys(curr)) {
    const prevVal = prev[key];
    const currVal = curr[key];

    if (prevVal === currVal) continue;

    // For objects/arrays, compare serialized form
    if (
      typeof currVal === 'object' && currVal !== null &&
      typeof prevVal === 'object' && prevVal !== null
    ) {
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        changed[key] = currVal;
        hasChanges = true;
      }
    } else {
      changed[key] = currVal;
      hasChanges = true;
    }
  }

  // Check for keys removed in current status
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) {
      changed[key] = null; // explicitly mark removed keys
      hasChanges = true;
    }
  }

  return hasChanges ? changed : null;
}

/**
 * Create a delta tracker that maintains per-instance snapshots
 * and computes diffs on each status update.
 */
function createDeltaTracker() {
  // compositeKey → last-known status snapshot
  const snapshots = new Map();

  // Full snapshot counter — send a full snapshot every N updates
  // to prevent client drift from missed messages
  const FULL_SNAPSHOT_INTERVAL = 30;
  const updateCounts = new Map();

  function _key(churchId, instanceName) {
    return instanceName ? `${churchId}::${instanceName}` : churchId;
  }

  /**
   * Compute the delta between the last known status and the new status.
   * Stores the new status as the current snapshot.
   *
   * @param {string} churchId
   * @param {string|null} instanceName
   * @param {object} newStatus - the full status object from the church client
   * @returns {{ delta: object|null, isFull: boolean }}
   *   - delta: changed fields (null if nothing changed)
   *   - isFull: true if this is a full snapshot (first update or periodic refresh)
   */
  function computeDelta(churchId, instanceName, newStatus) {
    const key = _key(churchId, instanceName);
    const prev = snapshots.get(key) || null;
    const snapshot = cloneStatus(newStatus);

    // Track update count for periodic full snapshots
    const count = (updateCounts.get(key) || 0) + 1;
    updateCounts.set(key, count);

    // Always store the full snapshot
    snapshots.set(key, snapshot);

    // Send full snapshot on first update or every FULL_SNAPSHOT_INTERVAL
    if (!prev || count % FULL_SNAPSHOT_INTERVAL === 0) {
      return { delta: snapshot, isFull: true };
    }

    const delta = diffStatus(prev, snapshot);
    return { delta, isFull: false };
  }

  /**
   * Clear the stored snapshot for an instance, forcing the next
   * update to be a full snapshot.
   */
  function clearSnapshot(churchId, instanceName) {
    const key = _key(churchId, instanceName);
    snapshots.delete(key);
    updateCounts.delete(key);
  }

  /**
   * Clear all snapshots for a church (e.g. on full disconnect).
   */
  function clearChurch(churchId) {
    for (const key of snapshots.keys()) {
      if (key === churchId || key.startsWith(`${churchId}::`)) {
        snapshots.delete(key);
        updateCounts.delete(key);
      }
    }
  }

  return {
    computeDelta,
    clearSnapshot,
    clearChurch,
    // Exposed for testing
    _snapshots: snapshots,
    _diffStatus: diffStatus,
  };
}

module.exports = { createDeltaTracker, diffStatus, cloneStatus, applyStatusDelta };
