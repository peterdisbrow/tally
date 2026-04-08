/**
 * Monthly Health Report
 * On the 1st of each month at 9 AM, generate and send a health report
 * for each church to their TDs + the admin contact chat ID.
 *
 */
const { createQueryClient } = require('./db');

const intervals = [];
process.on('SIGTERM', () => intervals.forEach(clearInterval));
process.on('SIGINT', () => intervals.forEach(clearInterval));

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class MonthlyReport {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} [opts.defaultBotToken] - Telegram bot token
   * @param {string} [opts.adminChatId] - Admin contact Telegram chat ID
   */
  constructor({ db, defaultBotToken, adminChatId } = {}) {
    this.db = db && typeof db.prepare === 'function' ? db : null;
    this.client = this._resolveClient(db);
    this.defaultBotToken = defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.adminChatId = adminChatId || process.env.ADMIN_TELEGRAM_CHAT_ID || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this.tallyBot = null;
    this.lifecycleEmails = null;
    this._timer = null;
    this._lastReportMonth = null; // 'YYYY-MM' of last run, to avoid double-sending
    this.ready = Promise.resolve();
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client && !this.db) throw new Error('[MonthlyReport] Database client is not configured.');
    return this.client;
  }

  async _all(sql, params = []) {
    if (this.db) return this.db.prepare(sql).all(...params);
    return this._requireClient().query(sql, params);
  }

  async _one(sql, params = []) {
    if (this.db) return this.db.prepare(sql).get(...params) || null;
    return this._requireClient().queryOne(sql, params);
  }

  /**
   * Start the monthly report timer.
   */
  start() {
    // Check every 15 minutes — fires when it's the 1st at 9 AM
    this._timer = setInterval(() => this._tick(), 15 * 60 * 1000);
    intervals.push(this._timer);
    console.log('[MonthlyReport] Started — fires on 1st of each month at 9 AM');

    // Catch-up: if the relay restarted on the 1st between 9:00 and 9:14 we would
    // have missed the window. Run immediately at startup if it's the 1st and the
    // hour is 9 and we have not yet sent for this month-key.
    setImmediate(() => this._tick());
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ─── REPORT GENERATION ────────────────────────────────────────────────────

  /**
   * Generate a monthly health report string for a church.
   * @param {string} churchId
   * @param {string} month - 'YYYY-MM'
   * @returns {string|null} formatted Telegram message, or null if church not found
   */
  async generate(churchId, month) {
    const [year, mon] = month.split('-').map(Number);
    const startDate = new Date(year, mon - 1, 1).toISOString();
    const endDate   = new Date(year, mon,     1).toISOString();

    const church = await this._one('SELECT * FROM churches WHERE churchId = ?', [churchId]);
    if (!church) return null;

    // Service events for the month
    const events = await this._all(
      'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? AND timestamp < ?',
      [churchId, startDate, endDate]
    );

    // Alerts for the month (table may not exist in all deployments)
    let alerts = [];
    try {
      alerts = await this._all(
        'SELECT * FROM alerts WHERE church_id = ? AND created_at >= ? AND created_at < ?',
        [churchId, startDate, endDate]
      );
    } catch { /* alerts table may not exist */ }

    // ── Compute metrics ───────────────────────────────────────────────────

    // Services monitored = unique calendar dates with any service event
    const uniqueDates = new Set(events.map(e => e.timestamp.slice(0, 10)));
    const servicesMonitored = uniqueDates.size;

    const alertsTriggered = alerts.length;
    const autoRecovered   = events.filter(e => e.auto_resolved).length;
    const escalated       = alerts.filter(a => a.escalated).length;

    // Most common event type
    const typeCounts = {};
    for (const e of events) {
      typeCounts[e.event_type] = (typeCounts[e.event_type] || 0) + 1;
    }
    let mostCommon = null, mostCommonCount = 0;
    for (const [type, count] of Object.entries(typeCounts)) {
      if (count > mostCommonCount) { mostCommon = type; mostCommonCount = count; }
    }

    // Uptime estimate — each unresolved critical event ≈ 30 min downtime
    const criticalTypes = ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'];
    const unresolvedCritical = events.filter(
      e => !e.resolved && criticalTypes.includes(e.event_type)
    ).length;
    const daysInMonth    = new Date(year, mon, 0).getDate();
    const totalMinutes   = daysInMonth * 24 * 60;
    const downtimeMin    = unresolvedCritical * 30;
    const uptime         = Math.max(0, Math.min(100, ((totalMinutes - downtimeMin) / totalMinutes) * 100));
    const uptimeIcon     = uptime >= 99 ? '🟢' : uptime >= 95 ? '🟡' : '🔴';

    const monthName = new Date(year, mon - 1, 1).toLocaleString('en-US', { month: 'long' });
    const divider   = '━━━━━━━━━━━━━━━━';

    return [
      `📊 ${monthName} Report — ${church.name}`,
      divider,
      `Services monitored: ${servicesMonitored}`,
      `Alerts triggered: ${alertsTriggered}`,
      `Auto-recovered: ${autoRecovered}`,
      `Escalated: ${escalated}`,
      mostCommon
        ? `Most common issue: ${mostCommon.replace(/_/g, ' ')} (${mostCommonCount}x)`
        : 'Most common issue: none',
      `Uptime estimate: ${uptime.toFixed(1)}% ${uptimeIcon}`,
    ].join('\n');
  }

  // ─── SCHEDULER ────────────────────────────────────────────────────────────

  _tick() {
    try {
      const now = new Date();
      if (now.getDate() !== 1 || now.getHours() !== 9) return;

      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      if (this._lastReportMonth === monthKey) return; // already ran this month
      this._lastReportMonth = monthKey;

      // Report covers the *previous* calendar month
      const reportDate  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const reportMonth = `${reportDate.getFullYear()}-${String(reportDate.getMonth() + 1).padStart(2, '0')}`;

      console.log(`[MonthlyReport] Generating ${reportMonth} reports`);

      // Only send reports to Pro/Enterprise tier churches (skip Connect and Event)
      Promise.resolve(this._all('SELECT * FROM churches')).then((allChurches) => {
        for (const church of allChurches) {
          const tier = (church.billing_tier || 'connect').toLowerCase();
          if (tier === 'connect' || tier === 'event') continue;
          this._sendReport(church.churchId, reportMonth).catch(e =>
            console.error(`[MonthlyReport] Error for ${church.name}:`, e.message)
          );
        }
      }).catch((e) => {
        console.error('[MonthlyReport] Tick error:', e.message);
      });
    } catch (e) {
      console.error('[MonthlyReport] Tick error:', e.message);
    }
  }

  async _sendReport(churchId, month) {
    const msg = await this.generate(churchId, month);
    if (!msg) return;

    // ── Telegram delivery ──
    const botToken = this.defaultBotToken;

    let tds = [];
    try {
      tds = await this._all(
        'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1',
        [churchId]
      );
    } catch { /* table may not exist */ }

    if (botToken) {
      const targets = new Set(tds.map(td => String(td.telegram_chat_id)).filter(Boolean));
      if (this.adminChatId) targets.add(String(this.adminChatId));

      for (const chatId of targets) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: msg }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (e) {
          console.error('[MonthlyReport] Telegram send error:', e.message);
        }
      }
    }

    // ── Email delivery ──
    if (this.lifecycleEmails) {
      try {
        const church = await this._one('SELECT * FROM churches WHERE churchId = ?', [churchId]);
        if (church) {
          // Per-recipient opt-out is handled in sendEmail() via _isRecipientUnsubscribed()
          const [year, mon] = month.split('-').map(Number);
          const startDate = new Date(year, mon - 1, 1).toISOString();
          const endDate = new Date(year, mon, 1).toISOString();

          // Compute report data for email template
          const events = await this._all(
            'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? AND timestamp < ?',
            [churchId, startDate, endDate]
          );

          let alerts = [];
          try {
            alerts = await this._all(
              'SELECT * FROM alerts WHERE church_id = ? AND created_at >= ? AND created_at < ?',
              [churchId, startDate, endDate]
            );
          } catch { /* alerts table may not exist */ }

          const uniqueDates = new Set(events.map(e => e.timestamp.slice(0, 10)));
          const autoRecovered = events.filter(e => e.auto_resolved).length;
          const escalated = alerts.filter(a => a.escalated).length;

          const typeCounts = {};
          for (const e of events) {
            typeCounts[e.event_type] = (typeCounts[e.event_type] || 0) + 1;
          }
          let mostCommon = null;
          for (const [type, count] of Object.entries(typeCounts)) {
            if (!mostCommon || count > typeCounts[mostCommon]) mostCommon = type;
          }

          const criticalTypes = ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'];
          const unresolvedCritical = events.filter(
            e => !e.resolved && criticalTypes.includes(e.event_type)
          ).length;
          const daysInMonth = new Date(year, mon, 0).getDate();
          const totalMinutes = daysInMonth * 24 * 60;
          const downtimeMin = unresolvedCritical * 30;
          const uptime = Math.max(0, Math.min(100, ((totalMinutes - downtimeMin) / totalMinutes) * 100));
          const monthLabel = new Date(year, mon - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

          const reportData = {
            month,
            monthLabel,
            servicesMonitored: uniqueDates.size,
            alertsTriggered: alerts.length,
            autoRecovered,
            escalated,
            mostCommonIssue: mostCommon ? mostCommon.replace(/_/g, ' ') : null,
            uptime,
          };

          // Send to leadership emails
          const leadershipEmails = (church.leadership_emails || '').split(',').map(e => e.trim()).filter(e => e && e.includes('@'));
          // Also send to portal_email if set
          const recipients = new Set(leadershipEmails);
          if (church.portal_email) recipients.add(church.portal_email);

          for (const email of recipients) {
            this.lifecycleEmails.sendMonthlyReportEmail(church, reportData, email).catch(err => {
              console.error(`[MonthlyReport] Email error for ${email}:`, err.message);
            });
          }
        }
      } catch (e) {
        console.error(`[MonthlyReport] Email delivery error for ${churchId}:`, e.message);
      }
    }
  }

  /** Attach lifecycle emails engine for monthly report emails */
  setLifecycleEmails(engine) {
    this.lifecycleEmails = engine;
  }

  /** Alias for server.js API route compatibility */
  async generateReport(churchId, month) {
    if (!month) {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const text = await this.generate(churchId, month);
    return { churchId, month, text };
  }

  /** Format a report object to a text string */
  formatReport(report) {
    return report?.text || 'No report data available.';
  }
}

module.exports = { MonthlyReport };
