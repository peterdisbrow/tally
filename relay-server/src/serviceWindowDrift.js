/**
 * Service Window Drift Detection
 *
 * Detects when services start late, end early, run overtime, overlap,
 * or happen outside any scheduled window.
 */

const { buildNonTestSessionClauseSync } = require('./schemaCompat');

const LATE_START_THRESHOLD = 10;   // minutes after scheduled start
const EARLY_END_THRESHOLD = 15;    // minutes before scheduled end
const OVERTIME_THRESHOLD = 20;     // minutes past scheduled end

/**
 * Find the scheduled window that best matches a session's start time.
 * Returns { day, startHour, startMin, durationHours, scheduledStartMin, scheduledEndMin } or null.
 */
function findMatchingWindow(schedule, sessionStart) {
  const day = sessionStart.getDay();
  const sessionMin = sessionStart.getHours() * 60 + sessionStart.getMinutes();
  const BUFFER = 60; // look within 60 min of a scheduled start

  let best = null;
  let bestDelta = Infinity;

  for (const s of schedule) {
    if (s.day !== day) continue;
    const startMin = s.startHour * 60 + (s.startMin || 0);
    const delta = Math.abs(sessionMin - startMin);
    if (delta < bestDelta && delta <= BUFFER) {
      bestDelta = delta;
      best = {
        ...s,
        scheduledStartMin: startMin,
        scheduledEndMin: startMin + (s.durationHours || 2) * 60,
      };
    }
  }
  return best;
}

/**
 * Detect drift for a current or recent session.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {{ startedAt: Date|string, endedAt?: Date|string|null, sessionId?: string }} currentSession
 * @returns {{ drifts: Array<{ type: string, severity: string, message: string, scheduledTime: string|null, actualTime: string, deltaMinutes: number }> }}
 */
function detectDrift(db, churchId, currentSession) {
  const drifts = [];
  const schedule = getSchedule(db, churchId);
  if (!db || typeof db.prepare !== 'function') {
    return { drifts };
  }
  const startedAt = currentSession.startedAt instanceof Date
    ? currentSession.startedAt
    : new Date(currentSession.startedAt);
  const endedAt = currentSession.endedAt
    ? (currentSession.endedAt instanceof Date ? currentSession.endedAt : new Date(currentSession.endedAt))
    : null;

  const window = findMatchingWindow(schedule, startedAt);

  // ── Unscheduled ──────────────────────────────────────────────────────────
  if (!window) {
    if (schedule.length > 0) {
      drifts.push({
        type: 'unscheduled',
        severity: 'warning',
        message: 'Service started outside any scheduled window',
        scheduledTime: null,
        actualTime: startedAt.toISOString(),
        deltaMinutes: 0,
      });
    }
    return { drifts };
  }

  // Build scheduled start/end as Date objects on the same day as the session
  const scheduledStart = new Date(startedAt);
  scheduledStart.setHours(Math.floor(window.scheduledStartMin / 60), window.scheduledStartMin % 60, 0, 0);

  const scheduledEnd = new Date(startedAt);
  scheduledEnd.setHours(Math.floor(window.scheduledEndMin / 60), window.scheduledEndMin % 60, 0, 0);
  // Handle midnight crossing
  if (window.scheduledEndMin >= 24 * 60) {
    scheduledEnd.setDate(scheduledEnd.getDate() + 1);
    scheduledEnd.setHours(Math.floor((window.scheduledEndMin - 24 * 60) / 60), (window.scheduledEndMin - 24 * 60) % 60, 0, 0);
  }

  // ── Late Start ───────────────────────────────────────────────────────────
  const startDelayMin = Math.round((startedAt - scheduledStart) / 60000);
  if (startDelayMin > LATE_START_THRESHOLD) {
    const severity = startDelayMin > 30 ? 'critical' : 'warning';
    drifts.push({
      type: 'late_start',
      severity,
      message: `Service started ${startDelayMin} min late (threshold: ${LATE_START_THRESHOLD} min)`,
      scheduledTime: scheduledStart.toISOString(),
      actualTime: startedAt.toISOString(),
      deltaMinutes: startDelayMin,
    });
  }

  if (endedAt) {
    // ── Early End ────────────────────────────────────────────────────────
    const earlyEndMin = Math.round((scheduledEnd - endedAt) / 60000);
    if (earlyEndMin > EARLY_END_THRESHOLD) {
      drifts.push({
        type: 'early_end',
        severity: 'info',
        message: `Service ended ${earlyEndMin} min before scheduled end (threshold: ${EARLY_END_THRESHOLD} min)`,
        scheduledTime: scheduledEnd.toISOString(),
        actualTime: endedAt.toISOString(),
        deltaMinutes: earlyEndMin,
      });
    }

    // ── Overtime ─────────────────────────────────────────────────────────
    const overtimeMin = Math.round((endedAt - scheduledEnd) / 60000);
    if (overtimeMin > OVERTIME_THRESHOLD) {
      const severity = overtimeMin > 45 ? 'critical' : 'warning';
      drifts.push({
        type: 'overtime',
        severity,
        message: `Service ran ${overtimeMin} min past scheduled end (threshold: ${OVERTIME_THRESHOLD} min)`,
        scheduledTime: scheduledEnd.toISOString(),
        actualTime: endedAt.toISOString(),
        deltaMinutes: overtimeMin,
      });
    }
  }

  // ── Overlap ──────────────────────────────────────────────────────────────
  // Check if there was a previous session that hadn't ended when this one started
  try {
    const nonTestSessionClause = buildNonTestSessionClauseSync(db);
    const prevSession = db.prepare(`
      SELECT started_at, ended_at FROM service_sessions
      WHERE church_id = ? AND id != ? AND ended_at IS NOT NULL${nonTestSessionClause}
      ORDER BY started_at DESC LIMIT 1
    `).get(churchId, currentSession.sessionId || '');

    if (prevSession && prevSession.ended_at) {
      const prevEnd = new Date(prevSession.ended_at);
      if (startedAt < prevEnd) {
        const overlapMin = Math.round((prevEnd - startedAt) / 60000);
        drifts.push({
          type: 'overlap',
          severity: 'critical',
          message: `Service started ${overlapMin} min before previous service ended`,
          scheduledTime: prevEnd.toISOString(),
          actualTime: startedAt.toISOString(),
          deltaMinutes: overlapMin,
        });
      }
    }
  } catch (err) {
    // service_sessions table may not exist in test contexts — skip overlap check
    console.debug('[serviceWindowDrift] overlap check error:', err?.message);
  }

  return { drifts };
}

/**
 * Compute timing stats over the last N weeks.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {number} [weeks=4]
 * @returns {{ avgStartDelay: number, avgDuration: number, avgEndDelay: number, onTimePercent: number }}
 */
function getServiceTimingStats(db, churchId, weeks = 4) {
  if (!db || typeof db.prepare !== 'function') {
    return { avgStartDelay: 0, avgDuration: 0, avgEndDelay: 0, onTimePercent: 100 };
  }
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
  const schedule = getSchedule(db, churchId);
  const nonTestSessionClause = buildNonTestSessionClauseSync(db);

  let sessions;
  try {
    sessions = db.prepare(`
      SELECT started_at, ended_at, duration_minutes
      FROM service_sessions
      WHERE church_id = ? AND started_at >= ? AND ended_at IS NOT NULL${nonTestSessionClause}
      ORDER BY started_at ASC
    `).all(churchId, cutoff);
  } catch (e) {
    console.warn('[serviceWindowDrift] getServiceTimingStats DB query failed for', churchId, ':', e.message);
    return { avgStartDelay: 0, avgDuration: 0, avgEndDelay: 0, onTimePercent: 100 };
  }

  if (!sessions.length) {
    return { avgStartDelay: 0, avgDuration: 0, avgEndDelay: 0, onTimePercent: 100 };
  }

  let totalStartDelay = 0;
  let totalDuration = 0;
  let totalEndDelay = 0;
  let onTimeCount = 0;

  for (const s of sessions) {
    const startedAt = new Date(s.started_at);
    const endedAt = new Date(s.ended_at);
    const duration = s.duration_minutes || Math.round((endedAt - startedAt) / 60000);
    totalDuration += duration;

    const window = findMatchingWindow(schedule, startedAt);
    if (!window) continue;

    const scheduledStart = new Date(startedAt);
    scheduledStart.setHours(Math.floor(window.scheduledStartMin / 60), window.scheduledStartMin % 60, 0, 0);

    const scheduledEnd = new Date(startedAt);
    scheduledEnd.setHours(Math.floor(window.scheduledEndMin / 60), window.scheduledEndMin % 60, 0, 0);
    if (window.scheduledEndMin >= 24 * 60) {
      scheduledEnd.setDate(scheduledEnd.getDate() + 1);
      scheduledEnd.setHours(Math.floor((window.scheduledEndMin - 24 * 60) / 60), (window.scheduledEndMin - 24 * 60) % 60, 0, 0);
    }

    const startDelay = Math.round((startedAt - scheduledStart) / 60000);
    const endDelay = Math.round((endedAt - scheduledEnd) / 60000);

    totalStartDelay += startDelay;
    totalEndDelay += endDelay;

    if (Math.abs(startDelay) <= LATE_START_THRESHOLD) {
      onTimeCount++;
    }
  }

  const count = sessions.length;
  return {
    avgStartDelay: Math.round(totalStartDelay / count),
    avgDuration: Math.round(totalDuration / count),
    avgEndDelay: Math.round(totalEndDelay / count),
    onTimePercent: Math.round((onTimeCount / count) * 100),
  };
}

/**
 * Check for overlapping scheduled windows (schedule conflicts).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @returns {Array<{ windowA: object, windowB: object, overlapMinutes: number }>}
 */
function checkUpcomingConflicts(db, churchId) {
  if (!db || typeof db.prepare !== 'function') return [];
  const schedule = getSchedule(db, churchId);
  const conflicts = [];

  // Group windows by day
  const byDay = {};
  for (const s of schedule) {
    if (!byDay[s.day]) byDay[s.day] = [];
    const startMin = s.startHour * 60 + (s.startMin || 0);
    const endMin = startMin + (s.durationHours || 2) * 60;
    byDay[s.day].push({ ...s, startMin, endMin });
  }

  for (const day of Object.keys(byDay)) {
    const windows = byDay[day].sort((a, b) => a.startMin - b.startMin);
    for (let i = 0; i < windows.length - 1; i++) {
      const a = windows[i];
      const b = windows[i + 1];
      if (a.endMin > b.startMin) {
        const overlapMinutes = a.endMin - b.startMin;
        conflicts.push({
          windowA: { day: Number(day), startHour: a.startHour, startMin: a.startMin || 0, durationHours: a.durationHours || 2 },
          windowB: { day: Number(day), startHour: b.startHour, startMin: b.startMin || 0, durationHours: b.durationHours || 2 },
          overlapMinutes,
        });
      }
    }
  }

  return conflicts;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

function getSchedule(db, churchId) {
  if (!db || typeof db.prepare !== 'function') return [];
  try {
    const row = db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
    if (!row || !row.service_times) return [];
    return JSON.parse(row.service_times);
  } catch {
    return [];
  }
}

module.exports = {
  detectDrift,
  getServiceTimingStats,
  checkUpcomingConflicts,
  findMatchingWindow,
  LATE_START_THRESHOLD,
  EARLY_END_THRESHOLD,
  OVERTIME_THRESHOLD,
};
