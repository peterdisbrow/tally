/**
 * Studio Clock time-sync helpers.
 * Used by rundown-clock.html (browser) and unit tests (CommonJS).
 *
 * Wall time uses server_timestamp from WS timer payloads with half-RTT
 * compensation, matching the Production Clock SPA NTP approach.
 */
(function (root) {
  'use strict';

  var MAX_RTT_MS = 2000;

  function applyServerTimestamp(prev, serverTs, receivedAt, syncT0) {
    if (typeof serverTs !== 'number' || !isFinite(serverTs)) {
      return prev || { offsetMs: 0, hasOffset: false, driftMs: null };
    }
    var t1 = typeof receivedAt === 'number' ? receivedAt : Date.now();
    var t0 = typeof syncT0 === 'number' && syncT0 > 0 ? syncT0 : t1;
    var rtt = Math.max(0, t1 - t0);
    if (rtt > MAX_RTT_MS) rtt = 0;
    var estimatedServerNow = serverTs + rtt / 2;
    return {
      offsetMs: estimatedServerNow - t1,
      hasOffset: true,
      driftMs: t1 - estimatedServerNow,
    };
  }

  function wallNow(sync, now) {
    var t = typeof now === 'number' ? now : Date.now();
    if (!sync || !sync.hasOffset) return new Date(t);
    return new Date(t + sync.offsetMs);
  }

  function isInvalidTokenClose(code, reason) {
    var text = String(reason || '').toLowerCase();
    if (code === 1008) return true;
    return /invalid share token|token required/.test(text);
  }

  var api = {
    MAX_RTT_MS: MAX_RTT_MS,
    applyServerTimestamp: applyServerTimestamp,
    wallNow: wallNow,
    isInvalidTokenClose: isInvalidTokenClose,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TallyStudioClockSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
