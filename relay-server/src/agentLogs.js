'use strict';

/**
 * Server-side ingestion for `agent_log` WebSocket messages from church-client
 * agents. Each message contains a small batch of structured log entries; we
 * validate the batch, persist to the `church_agent_logs` table, and enforce
 * per-church retention so storage stays bounded.
 *
 * Schema (created in server.js bootstrap):
 *   church_agent_logs (
 *     id, church_id, room_id, device_type, device_id,
 *     level, message, error_json, created_at
 *   )
 *
 * Retention policy (enforced opportunistically on insert + by a daily cron):
 *   - 7 days
 *   - 10,000 rows per church (hard cap; oldest rows trimmed first)
 *
 * The ingestion is best-effort: persistence failures are logged, never thrown,
 * because dropping a debug log is preferable to bouncing the agent socket.
 */

const ALLOWED_LEVELS = new Set(['info', 'warn', 'error']);
const MAX_ENTRIES_PER_BATCH = 100;
const MAX_MESSAGE_LEN = 4000;
const MAX_ROWS_PER_CHURCH = 10_000;
const RETENTION_DAYS = 7;
const SECRET_KEY_PATTERN = /token|password|secret|key/i;

function clipString(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}

function redact(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[truncated]';
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/**
 * Build the agent-log handler.
 *
 * @param {object} opts
 * @param {object} opts.queryClient — shared DB client (sqlite or postgres).
 * @param {object} [opts.logger]    — optional logger with .warn/.error/.info; falls back to console.
 * @param {number} [opts.maxRowsPerChurch=10000]
 * @param {number} [opts.retentionDays=7]
 */
function createAgentLogHandler(opts) {
  const {
    queryClient,
    logger = console,
    maxRowsPerChurch = MAX_ROWS_PER_CHURCH,
    retentionDays = RETENTION_DAYS,
  } = opts || {};

  if (!queryClient) {
    throw new Error('agentLogs: queryClient is required');
  }

  // Track per-church insert counters so we only re-trim periodically rather
  // than on every single insert (which would mean a DELETE for every row).
  const insertsSinceTrim = new Map();
  const TRIM_EVERY = 100; // re-evaluate the per-church cap every N inserts

  /**
   * Normalize and validate a single inbound entry. Returns null if invalid.
   *
   * Drops anything that looks like it leaked credentials at the top-level
   * `message` string — defense-in-depth on top of the agent-side redactor.
   */
  function normalizeEntry(authedChurchId, rawEntry) {
    if (!rawEntry || typeof rawEntry !== 'object') return null;

    // Authoritative churchId is the authenticated socket's church — never trust
    // a value the agent claims for itself.
    const churchId = String(authedChurchId || '').trim();
    if (!churchId) return null;

    // If the agent claims a different churchId, drop the entry (covers a
    // malicious or buggy agent trying to write into another church's logs).
    if (rawEntry.churchId && String(rawEntry.churchId) !== churchId) {
      return null;
    }

    const level = String(rawEntry.level || '').toLowerCase();
    if (!ALLOWED_LEVELS.has(level)) return null;

    const message = clipString(String(rawEntry.message ?? ''), MAX_MESSAGE_LEN);
    if (!message) return null;

    let ts = rawEntry.ts;
    if (typeof ts !== 'string' || isNaN(Date.parse(ts))) {
      ts = new Date().toISOString();
    }

    const roomId = rawEntry.roomId ? clipString(String(rawEntry.roomId), 200) : null;
    const deviceType = clipString(String(rawEntry.deviceType || 'church-client'), 50);
    const deviceId = clipString(String(rawEntry.deviceId || ''), 200);

    let errorJson = null;
    if (rawEntry.error || rawEntry.context) {
      const payload = {};
      if (rawEntry.error)   payload.error   = redact(rawEntry.error);
      if (rawEntry.context) payload.context = redact(rawEntry.context);
      try {
        errorJson = clipString(JSON.stringify(payload), MAX_MESSAGE_LEN * 2);
      } catch {
        errorJson = null;
      }
    }

    return {
      churchId,
      roomId,
      deviceType,
      deviceId,
      level,
      message,
      errorJson,
      createdAt: ts,
    };
  }

  async function trimChurch(churchId) {
    // Hard cap: keep at most maxRowsPerChurch rows per church.
    // Both SQLite (3.24+) and Postgres support DELETE…WHERE id IN (subquery),
    // so we use a portable form. The subquery selects the id of the
    // (maxRowsPerChurch + 1)-th most recent row; everything older is deleted.
    try {
      // Time-based retention
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      await queryClient.run(
        'DELETE FROM church_agent_logs WHERE church_id = ? AND created_at < ?',
        [churchId, cutoff],
      );

      // Row-count cap — find the cutoff id, then delete everything at-or-before it.
      const countRow = await queryClient.queryOne(
        'SELECT COUNT(*) AS cnt FROM church_agent_logs WHERE church_id = ?',
        [churchId],
      );
      const cnt = Number(countRow?.cnt || 0);
      if (cnt > maxRowsPerChurch) {
        const excess = cnt - maxRowsPerChurch;
        // Find the id of the oldest row we want to KEEP.
        const cutoffRow = await queryClient.queryOne(
          'SELECT id FROM church_agent_logs WHERE church_id = ? ORDER BY id ASC LIMIT 1 OFFSET ?',
          [churchId, excess],
        );
        const cutoffId = cutoffRow?.id;
        if (cutoffId != null) {
          await queryClient.run(
            'DELETE FROM church_agent_logs WHERE church_id = ? AND id < ?',
            [churchId, cutoffId],
          );
        }
      }
    } catch (e) {
      logger.warn?.(`[agentLogs] trim failed for ${churchId}: ${e.message}`);
    }
  }

  /**
   * Handle one `agent_log` message.
   *
   * @param {string} churchId — the authenticated socket's churchId.
   * @param {object} msg     — parsed `agent_log` message; expects `entries: [...]`.
   * @returns {Promise<{accepted:number, rejected:number}>}
   */
  async function handle(churchId, msg) {
    if (!churchId || !msg || msg.type !== 'agent_log') {
      return { accepted: 0, rejected: 0 };
    }

    const rawEntries = Array.isArray(msg.entries) ? msg.entries : [];
    if (rawEntries.length === 0) return { accepted: 0, rejected: 0 };

    const entries = rawEntries.slice(0, MAX_ENTRIES_PER_BATCH)
      .map((e) => normalizeEntry(churchId, e))
      .filter(Boolean);

    if (entries.length === 0) {
      return { accepted: 0, rejected: rawEntries.length };
    }

    // Use the same `INSERT … ON CONFLICT DO NOTHING` portable form fixed in #86.
    // The id column is auto-generated, so there's no natural conflict key —
    // we rely on the implicit PK to never collide. We still write rows
    // sequentially so a single bad row doesn't poison the whole batch.
    let accepted = 0;
    for (const e of entries) {
      try {
        await queryClient.run(
          `INSERT INTO church_agent_logs
             (church_id, room_id, device_type, device_id, level, message, error_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.churchId, e.roomId, e.deviceType, e.deviceId, e.level, e.message, e.errorJson, e.createdAt],
        );
        accepted++;
      } catch (err) {
        logger.warn?.(`[agentLogs] insert failed: ${err.message}`);
      }
    }

    // Opportunistic trim: every TRIM_EVERY successful inserts, evaluate caps.
    if (accepted > 0) {
      const prev = insertsSinceTrim.get(churchId) || 0;
      const next = prev + accepted;
      if (next >= TRIM_EVERY) {
        insertsSinceTrim.set(churchId, 0);
        // Don't await — let trim happen in the background
        trimChurch(churchId).catch(() => {});
      } else {
        insertsSinceTrim.set(churchId, next);
      }
    }

    return { accepted, rejected: rawEntries.length - accepted };
  }

  /**
   * Daily cleanup job: walk every church and apply retention. Safe to call
   * concurrently with handle() — both use the shared queryClient.
   */
  async function runDailyCleanup() {
    try {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
      // Sweep all churches at once; per-church row caps are cheap once the
      // time-based cull has already removed most rows.
      await queryClient.run(
        'DELETE FROM church_agent_logs WHERE created_at < ?',
        [cutoff],
      );
      // Then trim per-church caps for any church whose count is still over.
      const churches = await queryClient.query(
        'SELECT church_id, COUNT(*) AS cnt FROM church_agent_logs GROUP BY church_id HAVING COUNT(*) > ?',
        [maxRowsPerChurch],
      );
      for (const row of churches) {
        await trimChurch(row.church_id);
      }
    } catch (e) {
      logger.error?.(`[agentLogs] daily cleanup failed: ${e.message}`);
    }
  }

  return {
    handle,
    trimChurch,
    runDailyCleanup,
    // exported for tests
    _normalizeEntry: normalizeEntry,
  };
}

module.exports = {
  createAgentLogHandler,
  ALLOWED_LEVELS,
  MAX_ENTRIES_PER_BATCH,
  MAX_MESSAGE_LEN,
  MAX_ROWS_PER_CHURCH,
  RETENTION_DAYS,
};
