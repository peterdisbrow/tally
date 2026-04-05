'use strict';

function cloneStatus(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function diffStatus(prev, curr) {
  if (!prev) return curr;

  const changed = {};
  let hasChanges = false;

  for (const key of Object.keys(curr)) {
    const prevVal = prev[key];
    const currVal = curr[key];

    if (prevVal === currVal) continue;

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

  for (const key of Object.keys(prev)) {
    if (!(key in curr)) {
      changed[key] = null;
      hasChanges = true;
    }
  }

  return hasChanges ? changed : null;
}

function createStatusDeltaTracker(fullSnapshotInterval = 30) {
  let snapshot = null;
  let count = 0;

  return {
    compute(nextStatus) {
      count += 1;
      const nextSnapshot = cloneStatus(nextStatus);

      if (!snapshot || count % fullSnapshotInterval === 0) {
        snapshot = nextSnapshot;
        return { delta: nextSnapshot, isFull: true };
      }

      const delta = diffStatus(snapshot, nextSnapshot);
      snapshot = nextSnapshot;
      return { delta, isFull: false };
    },
    reset() {
      snapshot = null;
      count = 0;
    },
  };
}

module.exports = {
  createStatusDeltaTracker,
  diffStatus,
  cloneStatus,
};
