/**
 * Monthly Health Report
 * On the 1st of each month at 9 AM, generate and send a health report
 * for each church to their TDs + Andrew's ADMIN_CHAT_ID.
 *
 * Also exposes setupRoutes(app, requireAdmin) for GET /api/churches/:churchId/report
 */

class MonthlyReport {
  /**
   * @param {object} opts
   * @param {import('better-sqlite3').Database} opts.db
   * @param {string} [opts.defaultBotToken] - Telegram bot token
   * @param {string} [opts.andrewChatId] - Andrew's Telegram chat ID
   */
  constructor({ db, defaultBotToken, andrewChatId } = {}) {
    this.db = db || null;
    this.defaultBotToken = defaultBotToken || process.env.ALERT_BOT_TOKEN;
    this.andrewChatId = andrewChatId || process.env.ANDREW_TELEGRAM_CHAT_ID;
    this.tallyBot = null;
    this._timer = null;
    this._lastReportMonth = null; // 'YYYY-MM' of last run, to avoid double-sending
  }

  /**
   * Start the monthly report timer.
   */
  start() {
    // Check every 15 minutes — fires when it's the 1st at 9 AM
    this._timer = setInterval(() => this._tick(), 15 * 60 * 1000);
    console.log('[MonthlyReport] Started — fires on 1st of each month at 9 AM');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /**
   * Register REST endpoint for manual report generation.
   * @param {import('express').Application} app
   * @param {function} requireAdmin - middleware
   */
  setupRoutes(app, requireAdmin) {
    app.get('/api/churches/:churchId/report', requireAdmin, (req, res) => {
      const { churchId } = req.params;
      let { month } = req.query;

      if (!month) {
        // Default to previous month
        const d = new Date();
        d.setMonth(d.getMonth() - 1);
        month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month must be in YYYY-MM format' });
      }

      try {
        const report = this.generate(churchId, month);
        if (!report) return res.status(404).json({ error: 'Church not found' });
        res.json({ churchId, month, report });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ─── REPORT GENERATION ────────────────────────────────────────────────────

  /**
   * Generate a monthly health report string for a church.
   * @param {string} churchId
   * @param {string} month - 'YYYY-MM'
   * @returns {string|null} formatted Telegram message, or null if church not found
   */
  generate(churchId, month) {
    const [year, mon] = month.split('-').map(Number);
    const startDate = new Date(year, mon - 1, 1).toISOString();
    const endDate   = new Date(year, mon,     1).toISOString();

    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return null;

    // Service events for the month
    const events = this.db.prepare(
      'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? AND timestamp < ?'
    ).all(churchId, startDate, endDate);

    // Alerts for the month (table may not exist in all deployments)
    let alerts = [];
    try {
      alerts = this.db.prepare(
        'SELECT * FROM alerts WHERE church_id = ? AND created_at >= ? AND created_at < ?'
      ).all(churchId, startDate, endDate);
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

      // Only send reports to Pro/Managed tier churches (skip Connect and Event)
      const allChurches = this.db.prepare('SELECT * FROM churches').all();
      for (const church of allChurches) {
        const tier = (church.billing_tier || 'connect').toLowerCase();
        if (tier === 'connect' || tier === 'event') {
          continue; // monthly reports are a Pro/Managed feature
        }
        this._sendReport(church.churchId, reportMonth).catch(e =>
          console.error(`[MonthlyReport] Error for ${church.name}:`, e.message)
        );
      }
    } catch (e) {
      console.error('[MonthlyReport] Tick error:', e.message);
    }
  }

  async _sendReport(churchId, month) {
    const msg = this.generate(churchId, month);
    if (!msg) return;

    const botToken = this.defaultBotToken;
    if (!botToken) return;

    let tds = [];
    try {
      tds = this.db.prepare(
        'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1'
      ).all(churchId);
    } catch { /* table may not exist */ }

    const targets = new Set(tds.map(td => String(td.telegram_chat_id)).filter(Boolean));
    if (this.andrewChatId) targets.add(String(this.andrewChatId));

    for (const chatId of targets) {
      try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg }),
        });
      } catch (e) {
        console.error('[MonthlyReport] Telegram send error:', e.message);
      }
    }
  }

  /** Alias for server.js API route compatibility */
  generateReport(churchId, month) {
    if (!month) {
      const d = new Date();
      d.setMonth(d.getMonth() - 1);
      month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
    const text = this.generate(churchId, month);
    return { churchId, month, text };
  }

  /** Format a report object to a text string */
  formatReport(report) {
    return report?.text || 'No report data available.';
  }
}

module.exports = { MonthlyReport };
