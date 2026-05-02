'use strict';

/**
 * Augment a raw streamProtection status (from the church-client manager) with
 * a relay-side `triggeredAt` timestamp so portal SSE consumers can show
 * "since X" badges without tracking transitions themselves.
 *
 * Input shape (from church-client/src/streamProtection.js):
 *   { enabled, active, state, lastEvent, lastEventAt,
 *     canManualRestart, cdnHealth, cdnPlatforms }
 *
 * Output shape:
 *   { ...all input fields preserved,
 *     active:      boolean — coerced to bool (mirrors manager's flag),
 *     triggeredAt: string|null — ISO timestamp of when active most recently
 *                  became true; null when cleared. Stable across substate
 *                  changes (protecting → encoder_disconnected) so the UI
 *                  doesn't reset its "since" timer mid-incident. }
 *
 * @param {object|null|undefined} raw   - new streamProtection status from the church
 * @param {object|null|undefined} prev  - previous normalized value for the same instance
 * @returns {object|null}
 */
function normalizeStreamProtection(raw, prev = null) {
  if (!raw || typeof raw !== 'object') return null;

  const active = !!raw.active;
  let triggeredAt;
  if (!active) {
    triggeredAt = null;
  } else if (prev && prev.active && prev.triggeredAt) {
    triggeredAt = prev.triggeredAt;
  } else {
    triggeredAt = raw.lastEventAt || new Date().toISOString();
  }

  return {
    ...raw,
    active,
    triggeredAt,
  };
}

module.exports = { normalizeStreamProtection };
