/**
 * healthAlerts.js — Proactive health monitoring
 * Runs daily, detects churches trending toward problems,
 * and alerts the admin team before churches contact support.
 *
 * "Reach out to a church before they reach out to you."
 */

const { computeHealthScore } = require('../healthScore.js');

const ALERT_THRESHOLDS = {
  healthScoreDrop: 70,        // Alert when score drops below this
  healthScoreDropRate: 15,    // Alert when score drops by this much in one week
  recurringFailure: 3,        // Same failure type 3+ weeks in a row
  missedPreService: 2,        // 2+ missed/failed pre-service checks in a row
  offlineStreak: 3,           // Offline for 3+ consecutive scheduled services
  noSessionsWeeks: 2,         // No sessions for 2+ weeks (churn risk)
};

const SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

class HealthAlertMonitor {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {{ sendTelegramMessage: (chatId: string, botToken: string, msg: string) => Promise<void> }} alertEngine
   * @param {Map} churches — in-memory church map (used for heartbeat data)
   */
  constructor(db, alertEngine, churches) {
    this.db = db;
    this.alertEngine = alertEngine;
    this.churches = churches;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        churchId TEXT NOT NULL,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT DEFAULT '{}',
        acknowledged INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  /**
   * Main daily check — runs all detection rules.
   * @returns {{ alerts: Array<{ churchId: string, churchName: string, type: string, severity: string, message: string, data: object }> }}
   */
  async runDailyCheck() {
    const alerts = [];

    // Get all active / trialing churches
    const activeChurches = this._getActiveChurches();

    for (const church of activeChurches) {
      const churchId = church.churchId;
      const churchName = church.name || churchId;

      // Run each detection check and collect alerts
      const checks = [
        this.checkHealthScoreDrop(churchId, churchName),
        this.checkRecurringFailures(churchId, churchName),
        this.checkPreServiceFailures(churchId, churchName),
        this.checkChurnRisk(churchId, churchName),
        this.checkMissedServices(churchId, churchName),
      ];

      for (const check of checks) {
        const result = await check;
        if (result) alerts.push(result);
      }
    }

    // Store each alert (with dedup)
    const storedAlerts = [];
    for (const alert of alerts) {
      const stored = await this.storeAlert(alert);
      if (stored) storedAlerts.push(alert);
    }

    // Send admin summary if there are new alerts
    if (storedAlerts.length > 0) {
      await this.sendAdminSummary(storedAlerts);
    }

    return { alerts: storedAlerts };
  }

  /**
   * Get active/trialing churches from the database.
   */
  _getActiveChurches() {
    try {
      return this.db.prepare(
        "SELECT churchId, name, billing_status FROM churches WHERE billing_status IN ('active', 'trialing')"
      ).all();
    } catch (e) {
      console.error('[healthAlerts] Failed to fetch active churches:', e.message);
      return [];
    }
  }

  /**
   * Check 1: Health score dropped below threshold or rapid drop.
   */
  async checkHealthScoreDrop(churchId, churchName) {
    try {
      const current = computeHealthScore(this.db, churchId, 7);
      const previous = computeHealthScore(this.db, churchId, 14);

      // Estimate the previous-week-only score:
      // The 14-day score includes this week, so we approximate
      // by using the 14-day score as a proxy for the prior period.
      // A more accurate approach: compute score for days 8-14 only.
      const currentScore = current.score;
      const previousScore = previous.score;

      // If either score is null (new church / no data), skip comparison
      if (currentScore === null || previousScore === null) return null;

      // Check for rapid drop (current week vs 2-week average as proxy for last week)
      const drop = previousScore - currentScore;

      if (currentScore < 50) {
        return {
          churchId,
          churchName,
          type: 'health_score_critical',
          severity: SEVERITY.CRITICAL,
          message: `Health score dropped to ${currentScore} (was ${previousScore} over 14 days)`,
          data: { currentScore, previousScore, drop, breakdown: current.breakdown },
        };
      }

      if (drop >= ALERT_THRESHOLDS.healthScoreDropRate) {
        return {
          churchId,
          churchName,
          type: 'health_score_rapid_drop',
          severity: SEVERITY.CRITICAL,
          message: `Health score dropped ${drop} points (${previousScore} -> ${currentScore})`,
          data: { currentScore, previousScore, drop, breakdown: current.breakdown },
        };
      }

      if (currentScore < ALERT_THRESHOLDS.healthScoreDrop) {
        return {
          churchId,
          churchName,
          type: 'health_score_low',
          severity: SEVERITY.WARNING,
          message: `Health score is ${currentScore} (below ${ALERT_THRESHOLDS.healthScoreDrop} threshold)`,
          data: { currentScore, previousScore, breakdown: current.breakdown },
        };
      }

      return null;
    } catch (e) {
      console.warn('[healthAlerts] checkHealthScoreDrop failed for', churchId, ':', e.message);
      return null;
    }
  }

  /**
   * Check 2: Recurring failure pattern — same failure type appearing 3+ weeks in a row.
   */
  async checkRecurringFailures(churchId, churchName) {
    try {
      const now = Date.now();
      const weeks = 4;
      const weekBuckets = []; // array of Sets of event types per week

      for (let w = 0; w < weeks; w++) {
        const weekEnd = new Date(now - w * 7 * 24 * 60 * 60 * 1000).toISOString();
        const weekStart = new Date(now - (w + 1) * 7 * 24 * 60 * 60 * 1000).toISOString();

        const events = this.db.prepare(
          `SELECT DISTINCT event_type FROM service_events
           WHERE church_id = ? AND timestamp >= ? AND timestamp < ?
           AND event_type NOT IN ('stream_started', 'recording_started', 'service_ended')`
        ).all(churchId, weekStart, weekEnd);

        weekBuckets.push(new Set(events.map(e => e.event_type)));
      }

      // Check which types appear in 3+ consecutive weeks (most recent first)
      // weekBuckets[0] = this week, [1] = last week, [2] = 2 weeks ago, [3] = 3 weeks ago
      const allTypes = new Set();
      for (const bucket of weekBuckets) {
        for (const t of bucket) allTypes.add(t);
      }

      for (const type of allTypes) {
        let consecutiveWeeks = 0;
        for (let w = 0; w < weeks; w++) {
          if (weekBuckets[w].has(type)) {
            consecutiveWeeks++;
          } else {
            break; // must be consecutive from current week
          }
        }

        if (consecutiveWeeks >= ALERT_THRESHOLDS.recurringFailure) {
          const typeName = type.replace(/_/g, ' ');
          return {
            churchId,
            churchName,
            type: 'recurring_failure',
            severity: SEVERITY.WARNING,
            message: `${typeName} occurring every week for ${consecutiveWeeks} consecutive weeks`,
            data: { failureType: type, consecutiveWeeks },
          };
        }
      }

      return null;
    } catch (e) {
      console.warn('[healthAlerts] checkRecurringFailures failed for', churchId, ':', e.message);
      return null;
    }
  }

  /**
   * Check 3: Pre-service check failures — 2+ consecutive failures.
   */
  async checkPreServiceFailures(churchId, churchName) {
    try {
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

      const checks = this.db.prepare(
        `SELECT pass, checks_json, created_at FROM preservice_check_results
         WHERE church_id = ? AND created_at >= ?
         ORDER BY created_at DESC`
      ).all(churchId, since);

      if (checks.length < ALERT_THRESHOLDS.missedPreService) return null;

      // Count consecutive failures from the most recent check
      let consecutiveFailures = 0;
      const failingChecks = [];
      for (const check of checks) {
        if (!check.pass) {
          consecutiveFailures++;
          try {
            const parsed = JSON.parse(check.checks_json || '[]');
            const failing = parsed.filter(c => !c.pass && !c.passed).map(c => c.name || c.label || c.check);
            for (const f of failing) {
              if (f && !failingChecks.includes(f)) failingChecks.push(f);
            }
          } catch { /* ignore parse errors */ }
        } else {
          break; // consecutive streak broken
        }
      }

      if (consecutiveFailures >= ALERT_THRESHOLDS.missedPreService) {
        return {
          churchId,
          churchName,
          type: 'preservice_failures',
          severity: SEVERITY.WARNING,
          message: `Pre-service checks failed ${consecutiveFailures} times in a row${failingChecks.length ? ` (${failingChecks.slice(0, 3).join(', ')})` : ''}`,
          data: { consecutiveFailures, failingChecks },
        };
      }

      return null;
    } catch (e) {
      console.warn('[healthAlerts] checkPreServiceFailures failed for', churchId, ':', e.message);
      return null;
    }
  }

  /**
   * Check 4: No sessions / churn risk — no sessions for 2+ weeks when previously active.
   */
  async checkChurnRisk(churchId, churchName) {
    try {
      const twoWeeksAgo = new Date(Date.now() - ALERT_THRESHOLDS.noSessionsWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();
      const sixWeeksAgo = new Date(Date.now() - 6 * 7 * 24 * 60 * 60 * 1000).toISOString();

      // Check if there are any recent sessions
      const recentSessions = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM service_sessions
         WHERE church_id = ? AND started_at >= ?`
      ).get(churchId, twoWeeksAgo);

      if (recentSessions.cnt > 0) return null; // Still active

      // Check if church was previously active (had sessions in the 4 weeks before that)
      const olderSessions = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM service_sessions
         WHERE church_id = ? AND started_at >= ? AND started_at < ?`
      ).get(churchId, sixWeeksAgo, twoWeeksAgo);

      if (olderSessions.cnt === 0) return null; // Never active or brand new — not churn

      return {
        churchId,
        churchName,
        type: 'churn_risk',
        severity: SEVERITY.INFO,
        message: `No sessions for ${ALERT_THRESHOLDS.noSessionsWeeks}+ weeks (had ${olderSessions.cnt} sessions before that) — possible churn`,
        data: { weeksSilent: ALERT_THRESHOLDS.noSessionsWeeks, previousSessionCount: olderSessions.cnt },
      };
    } catch (e) {
      console.warn('[healthAlerts] checkChurnRisk failed for', churchId, ':', e.message);
      return null;
    }
  }

  /**
   * Check 5: Offline during scheduled services — church was offline for 3+ scheduled service times.
   */
  async checkMissedServices(churchId, churchName) {
    try {
      const threeWeeksAgo = new Date(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000).toISOString();

      // Get schedule for church
      let schedule;
      try {
        const row = this.db.prepare(
          'SELECT service_times FROM churches WHERE churchId = ?'
        ).get(churchId);
        schedule = row ? JSON.parse(row.service_times || '[]') : [];
      } catch {
        schedule = [];
      }

      if (!schedule.length) return null; // No schedule configured

      // Count sessions in last 3 weeks
      const sessions = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM service_sessions
         WHERE church_id = ? AND started_at >= ?`
      ).get(churchId, threeWeeksAgo);

      // Expected sessions = schedule entries * 3 weeks
      const expectedPerWeek = schedule.length;
      const expectedTotal = expectedPerWeek * 3;
      const actual = sessions.cnt;
      const missed = expectedTotal - actual;

      if (missed >= ALERT_THRESHOLDS.offlineStreak) {
        return {
          churchId,
          churchName,
          type: 'missed_services',
          severity: SEVERITY.WARNING,
          message: `Missed ${missed} of ${expectedTotal} expected services in the last 3 weeks`,
          data: { missed, expected: expectedTotal, actual, scheduledPerWeek: expectedPerWeek },
        };
      }

      return null;
    } catch (e) {
      console.warn('[healthAlerts] checkMissedServices failed for', churchId, ':', e.message);
      return null;
    }
  }

  /**
   * Send admin summary via Telegram — groups alerts by severity.
   */
  async sendAdminSummary(alerts) {
    const botToken = process.env.ALERT_BOT_TOKEN;
    const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID;

    if (!botToken || !adminChatId || !this.alertEngine) return;

    const grouped = {
      [SEVERITY.CRITICAL]: [],
      [SEVERITY.WARNING]: [],
      [SEVERITY.INFO]: [],
    };

    for (const alert of alerts) {
      (grouped[alert.severity] || grouped[SEVERITY.INFO]).push(alert);
    }

    const lines = ['*Proactive Health Alerts*', ''];

    if (grouped[SEVERITY.CRITICAL].length) {
      lines.push(`*Critical (${grouped[SEVERITY.CRITICAL].length} church${grouped[SEVERITY.CRITICAL].length !== 1 ? 'es' : ''})*`);
      for (const a of grouped[SEVERITY.CRITICAL]) {
        lines.push(`- ${a.churchName}: ${a.message}`);
      }
      lines.push('');
    }

    if (grouped[SEVERITY.WARNING].length) {
      lines.push(`*Warning (${grouped[SEVERITY.WARNING].length} church${grouped[SEVERITY.WARNING].length !== 1 ? 'es' : ''})*`);
      for (const a of grouped[SEVERITY.WARNING]) {
        lines.push(`- ${a.churchName}: ${a.message}`);
      }
      lines.push('');
    }

    if (grouped[SEVERITY.INFO].length) {
      lines.push(`*Info (${grouped[SEVERITY.INFO].length} church${grouped[SEVERITY.INFO].length !== 1 ? 'es' : ''})*`);
      for (const a of grouped[SEVERITY.INFO]) {
        lines.push(`- ${a.churchName}: ${a.message}`);
      }
      lines.push('');
    }

    const text = lines.join('\n');

    try {
      await this.alertEngine.sendTelegramMessage(adminChatId, botToken, text);
    } catch (e) {
      console.error('[HealthAlerts] Telegram send error:', e.message);
    }
  }

  /**
   * Store alert with dedup — won't store the same churchId+type within 7 days.
   * @returns {boolean} true if stored (new alert), false if deduped
   */
  async storeAlert(alert) {
    const dedupWindow = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const existing = this.db.prepare(
      `SELECT id FROM health_alerts
       WHERE churchId = ? AND type = ? AND created_at >= ?
       LIMIT 1`
    ).get(alert.churchId, alert.type, dedupWindow);

    if (existing) return false; // Dedup: already alerted within 7 days

    this.db.prepare(
      `INSERT INTO health_alerts (churchId, type, severity, message, data)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      alert.churchId,
      alert.type,
      alert.severity,
      alert.message,
      JSON.stringify(alert.data || {}),
    );

    return true;
  }
}


/**
 * Start proactive health alerts — creates the table and sets up a daily interval.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ sendTelegramMessage: Function }} alertEngine
 * @param {Map} churches
 * @param {object} [options]
 * @param {number} [options.runHour=7] — Hour of the day to run (24h, default 7 AM)
 * @param {number[]} [options._intervals] — Array to push interval IDs into (for cleanup)
 * @returns {HealthAlertMonitor}
 */
function startHealthAlerts(db, alertEngine, churches, options = {}) {
  const monitor = new HealthAlertMonitor(db, alertEngine, churches);
  const runHour = options.runHour ?? 7;
  const intervals = options._intervals || [];
  let lastRunDate = null;

  // Check every 5 minutes if it's the target hour
  const intervalId = setInterval(async () => {
    const now = new Date();
    if (now.getHours() === runHour && now.getMinutes() < 5) {
      const todayStr = now.toISOString().slice(0, 10);
      if (lastRunDate === todayStr) return;
      lastRunDate = todayStr;
      console.log(`[HealthAlerts] Daily check at ${now.toISOString()}`);
      try {
        const result = await monitor.runDailyCheck();
        console.log(`[HealthAlerts] Found ${result.alerts.length} new alert(s)`);
      } catch (e) {
        console.error('[HealthAlerts] Daily check error:', e.message);
      }
    }
  }, 5 * 60 * 1000);

  intervals.push(intervalId);

  return monitor;
}


module.exports = { HealthAlertMonitor, startHealthAlerts, ALERT_THRESHOLDS };
