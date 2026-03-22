'use strict';
/**
 * Sync Monitor — polls each church's Tally Encoder /sync API
 * and surfaces A/V offset data on the relay dashboard.
 *
 * setupSyncMonitor(db, relay, telegramBot, notifyUpdate)
 *   - db          — better-sqlite3 Database instance
 *   - relay       — { churches: Map<churchId, churchRuntime> }
 *   - telegramBot — TallyBot instance (may be null)
 *   - notifyUpdate — function(churchId?) to push SSE dashboard update
 */

const POLL_INTERVAL_MS   = 5_000;   // how often to poll each encoder
const HISTORY_WINDOW_MS  = 60_000;  // rolling 60-second window
const WARN_THROTTLE_MS   = 5 * 60 * 1000; // once per 5 min for "warn"

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ churches: Map<string, object> }} relay
 * @param {object|null} telegramBot
 * @param {function} notifyUpdate
 */
function setupSyncMonitor(db, relay, telegramBot, notifyUpdate) {
  // Per-church state
  // churchId → { history: [{avOffsetMs, ts}], lastStatus, lastWarnAlert, lastCritAlert }
  const state = new Map();

  // ── Telegram alert helper ───────────────────────────────────────────────────
  const BOT_TOKEN  = process.env.ALERT_BOT_TOKEN;
  const CHAT_ID    = process.env.ANDREW_TELEGRAM_CHAT_ID;

  async function sendTelegram(message) {
    if (!BOT_TOKEN || !CHAT_ID) return;
    try {
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'Markdown',
          }),
          signal: AbortSignal.timeout(5000),
        }
      );
    } catch (e) {
      console.error('[SyncMonitor] Telegram send error:', e.message);
    }
  }

  // ── Per-church polling ─────────────────────────────────────────────────────
  async function pollChurch(church) {
    const apiUrl = church.encoderApiUrl;
    if (!apiUrl) return; // no encoder URL configured — skip

    const churchId   = church.churchId;
    const churchName = church.name || churchId;

    // Ensure state entry exists
    if (!state.has(churchId)) {
      state.set(churchId, {
        history: [], lastStatus: null, lastWarnAlert: 0, lastCritAlert: 0,
        consecutiveFailures: 0, // transient-error filter
      });
    }
    const cs = state.get(churchId);

    let data;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${apiUrl.replace(/\/$/, '')}/sync`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      cs.consecutiveFailures = 0; // reset on successful fetch
    } catch {
      cs.consecutiveFailures += 1;
      // Require 2 consecutive failures before reporting unavailable.
      // A single network hiccup should not flip the dashboard or trigger alerts.
      if (cs.consecutiveFailures < 2) {
        return; // skip this poll cycle — keep last known status
      }
      data = { avOffsetMs: null, status: 'unavailable' };
    }

    const now = Date.now();

    // ── Update rolling history ───────────────────────────────────────────────
    if (data.avOffsetMs !== null && data.avOffsetMs !== undefined) {
      cs.history.push({ avOffsetMs: data.avOffsetMs, ts: now });
    }
    // Prune entries older than 60 seconds
    cs.history = cs.history.filter(h => now - h.ts <= HISTORY_WINDOW_MS);

    // ── Compute statistics ───────────────────────────────────────────────────
    let avg60s     = null;
    let maxDrift60s = null;
    if (cs.history.length > 0) {
      const sum = cs.history.reduce((a, h) => a + Math.abs(h.avOffsetMs), 0);
      avg60s      = Math.round(sum / cs.history.length);
      maxDrift60s = Math.max(...cs.history.map(h => Math.abs(h.avOffsetMs)));
    }

    const newStatus = data.status || 'unavailable';
    const prevStatus = cs.lastStatus;
    cs.lastStatus = newStatus;

    // ── Publish to church runtime ────────────────────────────────────────────
    church.syncStatus = {
      avOffsetMs:  data.avOffsetMs ?? null,
      status:      newStatus,
      avg60s,
      maxDrift60s,
      updatedAt:   new Date().toISOString(),
    };

    // ── Alert on status transitions ──────────────────────────────────────────
    if (newStatus === 'critical') {
      // Alert on transition into critical, then throttle to once per 5 min.
      // Without this guard the alert fires every 5 s (every poll cycle) while
      // the offset stays critical, flooding the TD's Telegram.
      if (prevStatus !== 'critical' || now - cs.lastCritAlert > WARN_THROTTLE_MS) {
        await sendTelegram(
          `🔴 *A/V SYNC CRITICAL — ${churchName}*\n` +
          `Offset: ${data.avOffsetMs}ms (>100ms)\n` +
          `60s avg: ${avg60s ?? '—'}ms | max: ${maxDrift60s ?? '—'}ms`
        );
        cs.lastCritAlert = now;
      }

    } else if (newStatus === 'warn' && prevStatus !== 'warn' && prevStatus !== 'critical') {
      // Transition into warn — throttle to once per 5 min
      if (now - cs.lastWarnAlert > WARN_THROTTLE_MS) {
        await sendTelegram(
          `🟡 *A/V SYNC WARNING — ${churchName}*\n` +
          `Offset: ${data.avOffsetMs}ms (33–100ms)\n` +
          `60s avg: ${avg60s ?? '—'}ms | max: ${maxDrift60s ?? '—'}ms`
        );
        cs.lastWarnAlert = now;
      }

    } else if (newStatus === 'ok' && (prevStatus === 'warn' || prevStatus === 'critical')) {
      // Recovery
      await sendTelegram(
        `🟢 *A/V SYNC RECOVERED — ${churchName}*\n` +
        `Offset back within tolerance: ${data.avOffsetMs}ms`
      );
    }

    // Notify dashboard SSE if status changed or on first reading
    if (newStatus !== prevStatus || prevStatus === null) {
      try { notifyUpdate(churchId); } catch { /* ignore */ }
    }
  }

  // ── Main poll loop ─────────────────────────────────────────────────────────
  async function pollAll() {
    const { churches } = relay;
    for (const church of churches.values()) {
      try {
        await pollChurch(church);
      } catch (e) {
        console.error(`[SyncMonitor] Error polling ${church.name || church.churchId}:`, e.message);
      }
    }
  }

  setInterval(pollAll, POLL_INTERVAL_MS);
  // Initial poll after a short delay (let encoder API settle)
  setTimeout(pollAll, 3000);

  console.log('[SyncMonitor] A/V sync monitor started (poll interval: 5s)');
}

module.exports = { setupSyncMonitor };
