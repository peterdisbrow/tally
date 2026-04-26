'use strict';

/**
 * Status Batcher — coalesces rapid-fire status updates into batched
 * deliveries, reducing WebSocket/SSE frame count without meaningfully
 * affecting perceived responsiveness.
 *
 * Usage:
 *   const { createStatusBatcher } = require('./src/statusBatcher');
 *   const batcher = createStatusBatcher(flushFn, { windowMs: 100 });
 *
 *   // Instead of sending immediately:
 *   batcher.enqueue('church_abc', statusEvent);
 *   // flushFn will be called with the latest event per churchId
 *   // after windowMs, or immediately if no pending flush.
 */

/**
 * @param {(churchId: string, event: object) => void} flushFn
 *   Called with the most recent event for each churchId when the batch window closes.
 * @param {{ windowMs?: number }} options
 * @returns {{ enqueue: (churchId: string, event: object) => void, flush: () => void }}
 */
function createStatusBatcher(flushFn, { windowMs = 100 } = {}) {
  // churchId → latest event (last-write-wins within the batch window)
  const pending = new Map();
  let timer = null;

  function flush() {
    timer = null;
    const entries = Array.from(pending.entries());
    pending.clear();
    for (const [churchId, event] of entries) {
      try {
        flushFn(churchId, event);
      } catch (err) {
        // Don't let one failed flush block the rest
        console.error('[statusBatcher flush] flushFn error for', churchId, err);
      }
    }
  }

  function enqueue(churchId, event) {
    const wasEmpty = pending.size === 0;
    // Last-write-wins: keep only the latest event per churchId
    pending.set(churchId, event);

    if (wasEmpty && !timer) {
      // First event in a new batch window — schedule flush
      timer = setTimeout(flush, windowMs);
    }
  }

  return { enqueue, flush, _pending: pending };
}

module.exports = { createStatusBatcher };
