/**
 * Health Score — Computes a 0-100 health score for a church based on
 * uptime, alert rate, recovery rate, pre-service pass rate, and stream stability.
 */

const WEIGHTS = {
  uptime:             0.30,
  alertRate:          0.20,
  recoveryRate:       0.15,
  preServicePassRate: 0.15,
  streamStability:    0.20,
};

const RECOMMENDATIONS = {
  uptime: [
    { threshold: 70, tip: 'Devices are frequently offline during services — check network cables and power to your production rack.' },
    { threshold: 85, tip: 'Some connectivity drops detected — consider a dedicated network switch for AV equipment.' },
    { threshold: 95, tip: 'Minor uptime dips — verify Wi-Fi is not being used for critical AV gear (use wired connections).' },
  ],
  alertRate: [
    { threshold: 50, tip: 'Very high alert volume — review your equipment setup and internet connection stability.' },
    { threshold: 70, tip: 'Frequent alerts during services — check your most common alert types and address root causes.' },
    { threshold: 90, tip: 'Occasional alerts — consider upgrading firmware on devices that trigger warnings.' },
  ],
  recoveryRate: [
    { threshold: 50, tip: 'Most issues require manual intervention — enable auto-recovery in your Tally settings.' },
    { threshold: 75, tip: 'Some issues need TD attention — review unrecoverable alert types and prepare quick-fix procedures.' },
    { threshold: 90, tip: 'Good recovery rate — document the remaining manual fixes so any volunteer can handle them.' },
  ],
  preServicePassRate: [
    { threshold: 50, tip: 'Pre-service checks are frequently failing — run through the checklist 30 minutes before every service.' },
    { threshold: 75, tip: 'Some pre-service issues — ensure all equipment is powered on before checks run.' },
    { threshold: 90, tip: 'Occasional pre-service failures — verify device connections and firmware versions.' },
  ],
  streamStability: [
    { threshold: 50, tip: 'Stream bitrate is very inconsistent — test your upload speed and consider a dedicated internet line for streaming.' },
    { threshold: 70, tip: 'Noticeable stream quality fluctuations — close bandwidth-heavy applications on other devices during services.' },
    { threshold: 90, tip: 'Minor bitrate variations — consider setting a fixed bitrate in your encoder instead of variable.' },
  ],
};

/**
 * Compute a weighted health score for a church over the given period.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {number} [days=7]  Number of days to look back
 * @returns {{ score: number, breakdown: object, trend: string, recommendations: string[] }}
 */
function computeHealthScore(db, churchId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const breakdown = {
    uptime:             _computeUptime(db, churchId, since),
    alertRate:          _computeAlertRate(db, churchId, since),
    recoveryRate:       _computeRecoveryRate(db, churchId, since),
    preServicePassRate: _computePreServicePassRate(db, churchId, since),
    streamStability:    _computeStreamStability(db, churchId, since),
  };

  // Check if ALL sub-scores had no data (all returned null)
  const hasData = Object.values(breakdown).some(v => v !== null);
  if (!hasData) {
    return { score: null, status: 'new', message: 'Not enough data yet', breakdown, trend: 'stable', recommendations: [] };
  }

  // Weighted average — exclude null sub-scores and redistribute weight
  let score = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (breakdown[key] !== null) {
      score += breakdown[key] * weight;
      totalWeight += weight;
    }
  }
  score = totalWeight > 0 ? Math.round(Math.max(0, Math.min(100, score / totalWeight))) : null;

  if (score === null) {
    return { score: null, status: 'new', message: 'Not enough data yet', breakdown, trend: 'stable', recommendations: [] };
  }

  const trend = _computeTrendFromDb(db, churchId);
  const recommendations = getHealthRecommendations(breakdown);

  return { score, breakdown, trend, recommendations };
}

/**
 * Get weekly health scores for trend analysis.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {number} [weeks=4]
 * @returns {{ weeks: Array<{ weekStart: string, score: number, breakdown: object }>, trend: string }}
 */
function getHealthTrend(db, churchId, weeks = 4) {
  const weeklyScores = [];

  for (let i = weeks - 1; i >= 0; i--) {
    const weekEnd = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

    const since = weekStart.toISOString();
    const until = weekEnd.toISOString();

    const breakdown = {
      uptime:             _computeUptime(db, churchId, since, until),
      alertRate:          _computeAlertRate(db, churchId, since, until),
      recoveryRate:       _computeRecoveryRate(db, churchId, since, until),
      preServicePassRate: _computePreServicePassRate(db, churchId, since, until),
      streamStability:    _computeStreamStability(db, churchId, since, until),
    };

    let score = 0;
    let totalWeight = 0;
    for (const [key, weight] of Object.entries(WEIGHTS)) {
      if (breakdown[key] !== null) {
        score += breakdown[key] * weight;
        totalWeight += weight;
      }
    }
    score = totalWeight > 0 ? Math.round(Math.max(0, Math.min(100, score / totalWeight))) : null;

    weeklyScores.push({
      weekStart: weekStart.toISOString().slice(0, 10),
      score,
      breakdown,
    });
  }

  const trend = _determineTrend(weeklyScores.map(w => w.score));

  return { weeks: weeklyScores, trend };
}

/**
 * Generate actionable recommendations based on the lowest sub-scores.
 *
 * @param {{ uptime: number, alertRate: number, recoveryRate: number, preServicePassRate: number, streamStability: number }} breakdown
 * @returns {string[]}
 */
function getHealthRecommendations(breakdown) {
  const recommendations = [];

  // Sort categories by score ascending (worst first)
  const sorted = Object.entries(breakdown)
    .filter(([, val]) => typeof val === 'number')
    .sort(([, a], [, b]) => a - b);

  for (const [category, value] of sorted) {
    const tips = RECOMMENDATIONS[category];
    if (!tips) continue;

    // Find the most relevant tip (first threshold the score is below)
    for (const { threshold, tip } of tips) {
      if (value < threshold) {
        recommendations.push(tip);
        break;
      }
    }

    if (recommendations.length >= 3) break;
  }

  return recommendations;
}


// ─── INTERNAL COMPUTATION HELPERS ─────────────────────────────────────────────

/**
 * Uptime: % of service session time that devices were connected.
 * Uses service_sessions duration vs alert-indicated downtime.
 */
function _computeUptime(db, churchId, since, until) {
  try {
    const params = until
      ? [churchId, since, until]
      : [churchId, since];
    const untilClause = until ? ' AND started_at < ?' : '';

    const sessions = db.prepare(
      `SELECT duration_minutes, alert_count, auto_recovered_count
       FROM service_sessions
       WHERE church_id = ? AND started_at >= ?${untilClause} AND ended_at IS NOT NULL`
    ).all(...params);

    if (!sessions.length) return null; // No sessions = no data

    const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    if (totalMinutes === 0) return null;

    // Estimate downtime: 5 minutes per unresolved critical alert (not auto-recovered)
    // plus count critical events from service_events table
    const criticalEvents = db.prepare(
      `SELECT COUNT(*) as cnt FROM service_events
       WHERE church_id = ? AND timestamp >= ?${untilClause}
       AND event_type IN ('stream_stopped', 'atem_disconnected', 'recording_failed',
                          'multiple_systems_down', 'atem_stream_stopped',
                          'vmix_stream_stopped', 'encoder_stream_stopped')
       AND resolved = 0`
    ).get(...params);

    const unresolvedDowntime = (criticalEvents?.cnt || 0) * 5;

    // Also count resolved events but with shorter downtime estimate (2 min recovery)
    const resolvedEvents = db.prepare(
      `SELECT COUNT(*) as cnt FROM service_events
       WHERE church_id = ? AND timestamp >= ?${untilClause}
       AND event_type IN ('stream_stopped', 'atem_disconnected', 'recording_failed',
                          'multiple_systems_down', 'atem_stream_stopped',
                          'vmix_stream_stopped', 'encoder_stream_stopped')
       AND resolved = 1`
    ).get(...params);

    const resolvedDowntime = (resolvedEvents?.cnt || 0) * 2;
    const totalDowntime = unresolvedDowntime + resolvedDowntime;

    const uptime = Math.max(0, ((totalMinutes - totalDowntime) / totalMinutes) * 100);
    return Math.round(uptime * 10) / 10;
  } catch (e) {
    console.warn('[healthScore] _computeUptime failed for church', churchId, ':', e.message);
    return null;
  }
}

/**
 * Alert rate: inverse score — fewer alerts per service hour = higher score.
 * 0 alerts = 100, 1 per hour = ~80, 3+ per hour = <50
 */
function _computeAlertRate(db, churchId, since, until) {
  try {
    const params = until
      ? [churchId, since, until]
      : [churchId, since];
    const untilClause = until ? ' AND created_at < ?' : '';

    // Count non-INFO alerts
    const alertCount = db.prepare(
      `SELECT COUNT(*) as cnt FROM alerts
       WHERE church_id = ? AND created_at >= ?${untilClause}
       AND severity != 'INFO'`
    ).get(...params);

    const sessionParams = until
      ? [churchId, since, until]
      : [churchId, since];
    const sessionUntilClause = until ? ' AND started_at < ?' : '';

    const sessions = db.prepare(
      `SELECT SUM(duration_minutes) as total
       FROM service_sessions
       WHERE church_id = ? AND started_at >= ?${sessionUntilClause} AND ended_at IS NOT NULL`
    ).get(...sessionParams);

    const totalHours = (sessions?.total || 0) / 60;
    if (totalHours === 0) return null; // No sessions = no data

    const alertsPerHour = (alertCount?.cnt || 0) / totalHours;

    // Score: 100 at 0 alerts/hr, drops ~20 per alert/hr, floor at 0
    const score = Math.max(0, 100 - alertsPerHour * 20);
    return Math.round(score * 10) / 10;
  } catch (e) {
    console.warn('[healthScore] _computeAlertRate failed for church', churchId, ':', e.message);
    return null;
  }
}

/**
 * Recovery rate: % of alerts that were auto-recovered.
 */
function _computeRecoveryRate(db, churchId, since, until) {
  try {
    const params = until
      ? [churchId, since, until]
      : [churchId, since];
    const untilClause = until ? ' AND started_at < ?' : '';

    const sessions = db.prepare(
      `SELECT SUM(alert_count) as total_alerts, SUM(auto_recovered_count) as total_recovered
       FROM service_sessions
       WHERE church_id = ? AND started_at >= ?${untilClause} AND ended_at IS NOT NULL`
    ).all(...params);

    const row = sessions[0];
    const totalAlerts = row?.total_alerts || 0;
    const totalRecovered = row?.total_recovered || 0;

    if (totalAlerts === 0) return null; // No alerts = no data
    return Math.round((totalRecovered / totalAlerts) * 1000) / 10;
  } catch (e) {
    console.warn('[healthScore] _computeRecoveryRate failed for church', churchId, ':', e.message);
    return null;
  }
}

/**
 * Pre-service pass rate: % of pre-service checks that passed.
 */
function _computePreServicePassRate(db, churchId, since, until) {
  try {
    const params = until
      ? [churchId, since, until]
      : [churchId, since];
    const untilClause = until ? ' AND created_at < ?' : '';

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM preservice_check_results
       WHERE church_id = ? AND created_at >= ?${untilClause}`
    ).get(...params);

    const passed = db.prepare(
      `SELECT COUNT(*) as cnt FROM preservice_check_results
       WHERE church_id = ? AND created_at >= ?${untilClause} AND pass = 1`
    ).get(...params);

    if (!total?.cnt) return null; // No checks = no data
    return Math.round((passed.cnt / total.cnt) * 1000) / 10;
  } catch (e) {
    console.warn('[healthScore] _computePreServicePassRate failed for church', churchId, ':', e.message);
    return null;
  }
}

/**
 * Stream stability: bitrate consistency measured by coefficient of variation
 * of service events. Uses service_events for bitrate_low alerts as a proxy.
 * Fewer bitrate issues = higher stability score.
 */
function _computeStreamStability(db, churchId, since, until) {
  try {
    const params = until
      ? [churchId, since, until]
      : [churchId, since];
    const untilClause = until ? ' AND timestamp < ?' : '';

    // Count bitrate/quality-related events
    const qualityEvents = db.prepare(
      `SELECT COUNT(*) as cnt FROM service_events
       WHERE church_id = ? AND timestamp >= ?${untilClause}
       AND event_type IN ('bitrate_low', 'fps_low', 'stream_stopped',
                          'atem_stream_stopped', 'vmix_stream_stopped',
                          'encoder_stream_stopped')`
    ).get(...params);

    const sessionParams = until
      ? [churchId, since, until]
      : [churchId, since];
    const sessionUntilClause = until ? ' AND started_at < ?' : '';

    const sessions = db.prepare(
      `SELECT SUM(duration_minutes) as total, SUM(stream_runtime_minutes) as stream_total
       FROM service_sessions
       WHERE church_id = ? AND started_at >= ?${sessionUntilClause} AND ended_at IS NOT NULL`
    ).get(...sessionParams);

    const streamHours = (sessions?.stream_total || 0) / 60;
    if (streamHours === 0) return null; // No streaming = no data

    const issuesPerHour = (qualityEvents?.cnt || 0) / streamHours;

    // Score: 100 at 0 issues/hr, drops ~25 per issue/hr, floor at 0
    const score = Math.max(0, 100 - issuesPerHour * 25);
    return Math.round(score * 10) / 10;
  } catch (e) {
    console.warn('[healthScore] _computeStreamStability failed for church', churchId, ':', e.message);
    return null;
  }
}

/**
 * Determine trend direction from an array of weekly scores.
 */
function _determineTrend(scores) {
  // Filter out null scores (weeks with no data)
  const validScores = scores.filter(s => s !== null);
  if (validScores.length < 2) return 'stable';

  // Use simple linear regression slope
  const n = validScores.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += validScores[i];
    sumXY += i * validScores[i];
    sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (slope > 2) return 'improving';
  if (slope < -2) return 'declining';
  return 'stable';
}

/**
 * Compute trend from DB by comparing current week to previous week.
 */
function _computeTrendFromDb(db, churchId) {
  try {
    const now = Date.now();
    const thisWeekSince = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lastWeekSince = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString();
    const lastWeekUntil = thisWeekSince;

    const thisWeekSessions = db.prepare(
      `SELECT COUNT(*) as cnt, SUM(alert_count) as alerts, SUM(duration_minutes) as duration
       FROM service_sessions WHERE church_id = ? AND started_at >= ? AND ended_at IS NOT NULL`
    ).get(churchId, thisWeekSince);

    const lastWeekSessions = db.prepare(
      `SELECT COUNT(*) as cnt, SUM(alert_count) as alerts, SUM(duration_minutes) as duration
       FROM service_sessions WHERE church_id = ? AND started_at >= ? AND started_at < ? AND ended_at IS NOT NULL`
    ).get(churchId, lastWeekSince, lastWeekUntil);

    if (!thisWeekSessions?.cnt || !lastWeekSessions?.cnt) return 'stable';

    const thisRate = (thisWeekSessions.alerts || 0) / Math.max(1, thisWeekSessions.duration || 1);
    const lastRate = (lastWeekSessions.alerts || 0) / Math.max(1, lastWeekSessions.duration || 1);

    const diff = lastRate - thisRate; // positive = improving (fewer alerts this week)
    if (diff > 0.01) return 'improving';
    if (diff < -0.01) return 'declining';
    return 'stable';
  } catch (e) {
    console.warn('[healthScore] _computeTrendFromDb failed for church', churchId, ':', e.message);
    return 'stable';
  }
}

module.exports = { computeHealthScore, getHealthTrend, getHealthRecommendations, WEIGHTS };
