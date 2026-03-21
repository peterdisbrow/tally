/**
 * Lifecycle Email Sequences — Tally
 *
 * Sends the right email at the right time, automatically:
 *   1. Setup Nudge (Day 1)          — app not connected after 24h
 *   2. First Sunday Prep (Day 3)    — app connected, prep for first service
 *   3. Check-In (Day 7)             — how's it going?
 *   4. Trial Ending Soon (5 days)   — trial about to expire
 *   5. Trial Ending Tomorrow (1 day)— final trial warning
 *   6. Trial Expired                — triggered externally from checkExpiredTrials()
 *   7. Payment Failed               — triggered externally from billing webhook
 *   8. Weekly Digest                — Monday 8 AM summary for active churches
 *
 * Duplicate prevention via `email_sends` table — each email type sent once per church.
 */

const GITHUB_RELEASES_URL = 'https://github.com/tallyconnect/tally/releases/latest';

class LifecycleEmails {
  constructor(db, { resendApiKey, fromEmail, appUrl }) {
    this.db = db;
    this.resendApiKey = resendApiKey || '';
    this.fromEmail = fromEmail || 'Tally <noreply@tallyconnect.app>';
    this.appUrl = appUrl || 'https://tallyconnect.app';
    this._ensureSchema();
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        email_type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        resend_id TEXT,
        UNIQUE(church_id, email_type)
      )
    `);

    // Template overrides table — admin edits stored separately from code
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_template_overrides (
        email_type TEXT PRIMARY KEY,
        subject TEXT,
        html TEXT,
        updated_at TEXT NOT NULL
      )
    `);

    // Migration: add subject column to email_sends
    try { this.db.exec('ALTER TABLE email_sends ADD COLUMN subject TEXT'); } catch { /* already exists */ }

    // Sales leads table for lead capture + drip nurture sequences
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sales_leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        church_name TEXT,
        source TEXT DEFAULT 'website',
        captured_at TEXT NOT NULL,
        status TEXT DEFAULT 'active'
      )
    `);
  }

  // ─── CORE SEND ──────────────────────────────────────────────────────────────

  /**
   * Send an email via Resend, logging to email_sends for dedup.
   * Returns { sent, id?, reason? }
   */
  async sendEmail({ churchId, emailType, to, subject, html, text }) {
    // Check if already sent
    if (this._hasSent(churchId, emailType)) {
      return { sent: false, reason: 'already-sent' };
    }

    if (!to) {
      return { sent: false, reason: 'no-recipient' };
    }

    // Check for admin template overrides
    const override = this._getOverride(emailType);
    if (override) {
      if (override.subject) subject = override.subject;
      if (override.html) html = override.html;
    }

    const now = new Date().toISOString();

    if (!this.resendApiKey) {
      console.log(`[LifecycleEmails] No RESEND_API_KEY — would send "${subject}" (${emailType}) to ${to}`);
      // Still record it so we don't spam logs
      this._recordSend(churchId, emailType, to, now, null, subject);
      return { sent: false, reason: 'no-api-key' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [to],
          subject,
          html,
          text,
          tags: [{ name: 'category', value: emailType }],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[LifecycleEmails] Resend failed (${res.status}): ${err}`);
        return { sent: false, reason: 'resend-error' };
      }

      const data = await res.json();
      this._recordSend(churchId, emailType, to, now, data.id, subject);
      console.log(`[LifecycleEmails] Sent "${subject}" (${emailType}) to ${to}, id: ${data.id}`);
      return { sent: true, id: data.id };
    } catch (e) {
      console.error(`[LifecycleEmails] Send failed: ${e.message}`);
      return { sent: false, reason: 'network-error' };
    }
  }

  _hasSent(churchId, emailType) {
    const row = this.db.prepare(
      'SELECT 1 FROM email_sends WHERE church_id = ? AND email_type = ?'
    ).get(churchId, emailType);
    return !!row;
  }

  _recordSend(churchId, emailType, recipient, sentAt, resendId, subject) {
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO email_sends (church_id, email_type, recipient, sent_at, resend_id, subject) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(churchId, emailType, recipient, sentAt, resendId || null, subject || null);
    } catch (e) {
      console.error(`[LifecycleEmails] Failed to record send: ${e.message}`);
    }
  }

  // ─── SESSION RECAP EMAIL ────────────────────────────────────────────────────

  /**
   * Send a post-service recap email to a leadership email address.
   * Uses session-specific dedup key so each session sends once per recipient.
   */
  async sendSessionRecapEmail(church, session, toEmail) {
    const sessionId = session.sessionId || 'unknown';
    const emailType = `session-recap-${sessionId}`;

    const dayName = session.startedAt ? new Date(session.startedAt).toLocaleDateString('en-US', { weekday: 'long' }) : '';
    const dateStr = session.startedAt ? new Date(session.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const durationStr = session.durationMinutes ? `${session.durationMinutes} min` : 'N/A';
    const grade = session.grade || 'N/A';
    const gradeColor = grade === 'A+' || grade === 'A' ? '#22c55e' : grade === 'B' ? '#eab308' : '#ef4444';
    const streamMin = session.streamTotalMinutes || 0;
    const peakViewers = session.peakViewers ?? 'N/A';
    const alerts = session.alertCount || 0;
    const autoFixed = session.autoRecovered || 0;
    const churchName = this._esc(church.name || 'Your Church');

    const subject = `Service Recap: ${churchName} — ${dayName} ${dateStr}`;
    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #09090B; color: #F8FAFC; padding: 32px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; background: ${gradeColor}22; border: 2px solid ${gradeColor}; border-radius: 50%; width: 64px; height: 64px; line-height: 64px; font-size: 28px; font-weight: 800; color: ${gradeColor};">${this._esc(grade)}</div>
          <h1 style="margin: 12px 0 4px; font-size: 20px; color: #F8FAFC;">${churchName}</h1>
          <p style="margin: 0; color: #94A3B8; font-size: 14px;">${dayName} ${dateStr} &middot; ${durationStr}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Stream Runtime</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${streamMin} min</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Peak Viewers</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${peakViewers}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Alerts</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${alerts === 0 ? '<span style="color:#22c55e;">None</span>' : `<span style="color:#ef4444;">${alerts}</span>`}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Auto-Fixed</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${autoFixed}</td></tr>
          <tr><td style="padding: 8px 12px; color: #94A3B8;">Recording</td><td style="padding: 8px 12px; text-align: right; font-weight: 600;">${session.recordingConfirmed ? '<span style="color:#22c55e;">Yes</span>' : '<span style="color:#94A3B8;">No</span>'}</td></tr>
        </table>
        ${alerts === 0 ? '<p style="text-align:center; color:#22c55e; font-weight:600;">Smooth service — no issues detected.</p>' : ''}
        <div style="text-align: center; margin-top: 24px;">
          <a href="${this.appUrl}/church-portal?church=${church.churchId}" style="display:inline-block; background:#22c55e; color:#000; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">Sign In to View Report</a>
        </div>
        <p style="text-align: center; margin-top: 20px; color: #475569; font-size: 11px;">Sent by Tally &middot; <a href="${this.appUrl}" style="color:#475569;">tallyconnect.app</a></p>
      </div>
    `;

    return this.sendEmail({ churchId: church.churchId, emailType, to: toEmail, subject, html });
  }

  // ─── WEEKLY DIGEST EMAIL ──────────────────────────────────────────────────

  /**
   * Send a weekly digest email to a leadership email address.
   * Uses week-specific dedup key so each week sends once per recipient.
   */
  async sendWeeklyDigestEmail(church, digestData, toEmail) {
    const now = new Date();
    const weekStr = `${now.getFullYear()}-W${String(Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7)).padStart(2, '0')}`;
    const emailType = `weekly-digest-email-${weekStr}`;
    const dateLabel = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const churchName = this._esc(church.name || 'Your Church');

    const reliability = digestData.reliability ?? 'N/A';
    const reliabilityColor = typeof reliability === 'number' && reliability >= 99 ? '#22c55e' : typeof reliability === 'number' && reliability >= 95 ? '#eab308' : '#ef4444';
    const totalEvents = digestData.totalEvents || 0;
    const autoRecovered = digestData.autoRecovered || 0;
    const sessionCount = digestData.sessionCount || 0;
    const patterns = digestData.patterns || [];
    const topAlertType = digestData.topAlertType || null;

    const subject = `Your Week in Review — ${church.name || 'Your Church'}`;
    const patternRows = patterns.length > 0
      ? patterns.map(p => `<li style="margin-bottom:6px;">${this._esc(p.pattern)} <span style="color:#475569;">— ${this._esc(p.timeWindow || '')}</span>${p.recommendation ? `<br><span style="color:#22c55e; font-size:12px;">&rarr; ${this._esc(p.recommendation)}</span>` : ''}</li>`).join('')
      : '<li style="color:#22c55e;">No recurring issues this week</li>';

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #09090B; color: #F8FAFC; padding: 32px; border-radius: 12px;">
        <h1 style="font-size: 20px; margin-bottom: 4px;">Weekly Report</h1>
        <p style="color: #94A3B8; margin: 0 0 24px;">${churchName} &middot; Week of ${dateLabel}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Services This Week</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${sessionCount}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Reliability</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600; color: ${reliabilityColor};">${typeof reliability === 'number' ? reliability + '%' : reliability}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Total Events</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${totalEvents}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Auto-Recovered</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${autoRecovered}</td></tr>
          <tr><td style="padding: 8px 12px; color: #94A3B8;">Top Alert Type</td><td style="padding: 8px 12px; text-align: right; font-weight: 600;">${topAlertType ? this._esc(topAlertType) : '<span style="color:#22c55e;">None</span>'}</td></tr>
        </table>
        <h3 style="font-size: 14px; margin: 20px 0 8px; color: #86efac;">Recurring Patterns</h3>
        <ul style="padding-left: 20px; color: #F8FAFC; font-size: 13px;">${patternRows}</ul>
        <div style="text-align: center; margin-top: 24px;">
          <a href="${this.appUrl}/church-portal?church=${church.churchId}" style="display:inline-block; background:#22c55e; color:#000; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">Sign In to View Report</a>
        </div>
        <p style="text-align: center; margin-top: 20px; color: #475569; font-size: 11px;">Sent by Tally &middot; <a href="${this.appUrl}" style="color:#475569;">tallyconnect.app</a></p>
      </div>
    `;

    return this.sendEmail({ churchId: church.churchId, emailType, to: toEmail, subject, html });
  }

  // ─── MONTHLY REPORT EMAIL ──────────────────────────────────────────────────

  /**
   * Send a monthly production report email to a leadership or TD email address.
   * Uses month-specific dedup key so each month sends once per recipient.
   */
  async sendMonthlyReportEmail(church, reportData, toEmail) {
    const month = reportData.month || 'unknown';
    const emailType = `monthly-report-email-${month}`;
    const churchName = this._esc(church.name || 'Your Church');

    const servicesMonitored = reportData.servicesMonitored || 0;
    const alertsTriggered = reportData.alertsTriggered || 0;
    const autoRecovered = reportData.autoRecovered || 0;
    const escalated = reportData.escalated || 0;
    const uptime = reportData.uptime != null ? reportData.uptime : 'N/A';
    const uptimeColor = typeof uptime === 'number' && uptime >= 99 ? '#22c55e' : typeof uptime === 'number' && uptime >= 95 ? '#eab308' : '#ef4444';
    const mostCommonIssue = reportData.mostCommonIssue || null;
    const monthLabel = reportData.monthLabel || month;

    const subject = `Monthly Production Report — ${church.name || 'Your Church'}`;

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #09090B; color: #F8FAFC; padding: 32px; border-radius: 12px;">
        <h1 style="font-size: 20px; margin-bottom: 4px;">Monthly Production Report</h1>
        <p style="color: #94A3B8; margin: 0 0 24px;">${churchName} &middot; ${this._esc(monthLabel)}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Services Monitored</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${servicesMonitored}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Alerts Triggered</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${alertsTriggered}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Auto-Recovered</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${autoRecovered}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Escalated</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${escalated}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Most Common Issue</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${mostCommonIssue ? this._esc(mostCommonIssue) : '<span style="color:#22c55e;">None</span>'}</td></tr>
          <tr><td style="padding: 8px 12px; color: #94A3B8;">Uptime Estimate</td><td style="padding: 8px 12px; text-align: right; font-weight: 600; color: ${uptimeColor};">${typeof uptime === 'number' ? uptime.toFixed(1) + '%' : uptime}</td></tr>
        </table>
        <div style="text-align: center; margin-top: 24px;">
          <a href="${this.appUrl}/church-portal?church=${church.churchId}" style="display:inline-block; background:#22c55e; color:#000; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">Sign In to View Report</a>
        </div>
        <p style="text-align: center; margin-top: 20px; color: #475569; font-size: 11px;">Sent by Tally &middot; <a href="${this.appUrl}" style="color:#475569;">tallyconnect.app</a></p>
      </div>
    `;

    const text = `Monthly Production Report — ${church.name || 'Your Church'}

${monthLabel}

Services Monitored: ${servicesMonitored}
Alerts Triggered: ${alertsTriggered}
Auto-Recovered: ${autoRecovered}
Escalated: ${escalated}
Most Common Issue: ${mostCommonIssue || 'None'}
Uptime Estimate: ${typeof uptime === 'number' ? uptime.toFixed(1) + '%' : uptime}

View your portal at ${this.appUrl}/church-portal?church=${church.churchId}

Tally — ${this.appUrl.replace('https://', '')}`;

    return this.sendEmail({ churchId: church.churchId, emailType, to: toEmail, subject, html, text });
  }

  /** HTML escape helper */
  _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ─── HOURLY CHECK ───────────────────────────────────────────────────────────

  async runCheck() {
    try {
      await this._checkSetupReminders();
      await this._checkFirstSundayPrep();
      await this._checkWeekOneCheckin();
      await this._checkTrialEnding7Days();
      await this._checkTrialEndingSoon();
      await this._checkTrialEndingTomorrow();
      await this._checkWeeklyDigest();
      await this._checkReviewRequest();
      await this._checkWinBack();
      await this._checkGracePeriodEndingSoon();
      await this._checkCancellationSurvey();
      await this._checkLeadNurture();
    } catch (e) {
      console.error(`[LifecycleEmails] runCheck error: ${e.message}`);
    }
  }

  // ─── SEQUENCE 1: SETUP NUDGE (Day 1) ───────────────────────────────────────
  // 24 hours after signup, app not connected yet

  async _checkSetupReminders() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(); // don't nudge after 7 days

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE onboarding_app_connected_at IS NULL
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `).all(cutoff, maxAge);

    for (const church of churches) {
      const { html, text } = this._buildSetupReminderEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'setup-reminder',
        to: church.portal_email,
        subject: 'Need help getting Tally set up?',
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 2: FIRST SUNDAY PREP (Day 3) ─────────────────────────────────
  // 3 days after signup, app IS connected

  async _checkFirstSundayPrep() {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE onboarding_app_connected_at IS NOT NULL
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `).all(cutoff, maxAge);

    for (const church of churches) {
      const { html, text } = this._buildFirstSundayEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'first-sunday-prep',
        to: church.portal_email,
        subject: 'Get ready for your first Sunday with Tally',
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 3: WEEK ONE CHECK-IN (Day 7) ─────────────────────────────────

  async _checkWeekOneCheckin() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `).all(cutoff, maxAge);

    for (const church of churches) {
      const { html, text } = this._buildCheckinEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'week-one-checkin',
        to: church.portal_email,
        subject: "How's Tally working for you?",
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 3b: TRIAL ENDING IN 7 DAYS ───────────────────────────────────

  async _checkTrialEnding7Days() {
    const now = Date.now();
    const sevenDaysFromNow = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `).all(sevenDaysFromNow, new Date(now).toISOString());

    for (const church of churches) {
      const daysLeft = Math.ceil(
        (new Date(church.billing_trial_ends).getTime() - now) / (24 * 60 * 60 * 1000)
      );
      const { html, text } = this._buildTrialEnding7DaysEmail(church, daysLeft);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'trial-ending-7days',
        to: church.portal_email,
        subject: `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — here's what you'll lose`,
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 4: TRIAL ENDING SOON (5 days before) ─────────────────────────

  async _checkTrialEndingSoon() {
    const now = Date.now();
    const fiveDaysFromNow = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `).all(fiveDaysFromNow, new Date(now).toISOString());

    for (const church of churches) {
      const daysLeft = Math.ceil(
        (new Date(church.billing_trial_ends).getTime() - now) / (24 * 60 * 60 * 1000)
      );
      const { html, text } = this._buildTrialEndingSoonEmail(church, daysLeft);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'trial-ending-soon',
        to: church.portal_email,
        subject: `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 5: TRIAL ENDING TOMORROW (1 day before) ──────────────────────

  async _checkTrialEndingTomorrow() {
    const now = Date.now();
    const oneDayFromNow = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `).all(oneDayFromNow, new Date(now).toISOString());

    for (const church of churches) {
      const { html, text } = this._buildTrialEndingTomorrowEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'trial-ending-tomorrow',
        to: church.portal_email,
        subject: 'Your Tally trial ends tomorrow',
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 6: TRIAL EXPIRED (called externally) ─────────────────────────

  async sendTrialExpired(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const { html, text } = this._buildTrialExpiredEmail(church);
    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'trial-expired',
      to: church.portal_email,
      subject: 'Your Tally trial has ended',
      html,
      text,
    });
  }

  // ─── SEQUENCE 7: PAYMENT FAILED (called externally) ────────────────────────

  async sendPaymentFailed(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const { html, text } = this._buildPaymentFailedEmail(church);
    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'payment-failed',
      to: church.portal_email,
      subject: 'Action needed: payment failed for Tally',
      html,
      text,
    });
  }

  // ─── SEQUENCE 8: WEEKLY DIGEST (Monday 8 AM) ──────────────────────────────

  async _checkWeeklyDigest() {
    const now = new Date();
    // Run on Mondays. Since the server runs in UTC, we check hours 13-16 (8am-11am US timezones).
    // The dedup key (weekly-digest-{weekId}) ensures each church gets at most one per week.
    if (now.getUTCDay() !== 1) return;
    const utcHour = now.getUTCHours();
    if (utcHour < 13 || utcHour > 16) return; // 13-16 UTC = 8am-11am ET / 5am-8am PT

    const weekId = this._getWeekId(now);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Weekly digest is a Pro+ feature (connect/plus get monthly reports at most)
    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email, billing_tier
      FROM churches
      WHERE billing_status IN ('active', 'trialing')
        AND portal_email IS NOT NULL
        AND onboarding_app_connected_at IS NOT NULL
        AND billing_tier IN ('pro', 'managed')
    `).all();

    for (const church of churches) {
      const emailType = `weekly-digest-${weekId}`;
      const stats = this._gatherWeeklyStats(church.churchId, weekAgo);

      // Only send if there was some activity (at least one session or event)
      if (stats.totalEvents === 0 && stats.totalSessions === 0) continue;

      const { html, text } = this._buildWeeklyDigestEmail(church, stats);
      await this.sendEmail({
        churchId: church.churchId,
        emailType,
        to: church.portal_email,
        subject: `Tally Weekly Report \u2014 ${church.name}`,
        html,
        text,
      });
    }
  }

  _getWeekId(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  _gatherWeeklyStats(churchId, sinceIso) {
    // Events from service_events table
    let totalEvents = 0;
    let criticalEvents = 0;
    let autoRecoveries = 0;

    try {
      const events = this.db.prepare(
        'SELECT event_type, resolved, auto_resolved FROM service_events WHERE church_id = ? AND timestamp >= ?'
      ).all(churchId, sinceIso);

      totalEvents = events.length;
      const criticalTypes = ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'];
      criticalEvents = events.filter(e => criticalTypes.includes(e.event_type)).length;
      autoRecoveries = events.filter(e => e.auto_resolved).length;
    } catch {
      // service_events table might not exist — not critical
    }

    // Alerts from alerts table
    let totalAlerts = 0;
    try {
      const alertCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND created_at >= ?'
      ).get(churchId, sinceIso);
      totalAlerts = alertCount?.cnt || 0;
    } catch {
      // alerts table might not exist
    }

    // Session count from service_sessions table
    let totalSessions = 0;
    try {
      const sessionCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ?'
      ).get(churchId, sinceIso);
      totalSessions = sessionCount?.cnt || 0;
    } catch {
      // service_sessions table might not exist
    }

    return { totalEvents, criticalEvents, autoRecoveries, totalAlerts, totalSessions };
  }

  // ─── EMAIL BUILDERS ─────────────────────────────────────────────────────────
  // All use the same green-accent template matching existing Tally emails.

  _header() {
    return `
      <div style="margin-bottom: 24px;">
        <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>
        <strong style="font-size: 16px; color: #111;">Tally</strong>
      </div>`;
  }

  _footer() {
    return `
      <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />
      <p style="font-size: 12px; color: #999;">
        Tally &mdash; <a href="${this.appUrl}" style="color: #999;">${this.appUrl.replace('https://', '')}</a>
      </p>`;
  }

  _wrap(body) {
    return `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">
      ${this._header()}
      ${body}
      ${this._footer()}
    </div>`;
  }

  _cta(text, url) {
    return `
      <p style="margin: 28px 0;">
        <a href="${url}" style="
          display: inline-block; padding: 12px 28px; font-size: 15px; font-weight: 700;
          background: #22c55e; color: #000; text-decoration: none; border-radius: 8px;
        ">${text}</a>
      </p>`;
  }

  // ── 1. Setup Reminder ──

  _buildSetupReminderEmail(church) {
    const downloadUrl = GITHUB_RELEASES_URL;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Need help getting Tally set up?</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hi! You signed up for Tally at <strong>${church.name}</strong> but we haven't seen your booth computer connect yet.
        Setup takes about 5 minutes &mdash; our AI assistant handles most of it for you:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          <strong>1.</strong> <a href="${downloadUrl}" style="color: #22c55e; text-decoration: none;">Download the Tally app</a> on your booth computer<br>
          <strong>2.</strong> Sign in with your registration code<br>
          <strong>3.</strong> Chat with our setup assistant &mdash; tell it your gear and service times, and it configures everything
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        That's it. Once connected, you'll see your gear status in the <a href="${this.appUrl}/portal" style="color: #22c55e; text-decoration: none;">Church Portal</a> and get alerts if anything goes wrong.
      </p>

      ${this._cta('Download Tally', downloadUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Need help? Reply to this email or reach out at support@tallyconnect.app &mdash; happy to walk you through it.
      </p>
    `);

    const text = `Need help getting Tally set up?

Hi! You signed up for Tally at ${church.name} but we haven't seen your booth computer connect yet.

Setup takes about 5 minutes — our AI assistant handles most of it:
1. Download the Tally app: ${downloadUrl}
2. Sign in with your registration code
3. Chat with our setup assistant — tell it your gear and service times

Once connected, you'll see your gear status at ${this.appUrl}/portal

Need help? Reply to this email or reach out at support@tallyconnect.app

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 2. First Sunday Prep ──

  _buildFirstSundayEmail(church) {
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Get ready for your first Sunday with Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Great news &mdash; your booth computer at <strong>${church.name}</strong> is connected and Tally is monitoring your gear.
        Here's what to expect this Sunday:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Before service:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Tally runs a <strong>pre-flight check</strong> 30 minutes before your scheduled service<br>
          &bull; You'll get a green-light notification or a list of exactly what needs attention<br>
          &bull; No more walking into the booth wondering if everything's on
        </div>
      </div>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; font-weight: 700; color: #334155; margin-bottom: 12px;">During service:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; If your stream drops, Tally auto-recovers it automatically<br>
          &bull; If a device disconnects, you get an alert with diagnosis<br>
          &bull; Check your phone instead of being glued to the booth
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>Quick tip:</strong> If you haven't set up Telegram alerts yet, do it before Sunday.
        It's how Tally talks to you in real-time. Connect at <a href="${this.appUrl}/portal" style="color: #22c55e; text-decoration: none;">your portal</a>.
      </p>

      ${this._cta('Open Your Portal', this.appUrl + '/portal')}
    `);

    const text = `Get ready for your first Sunday with Tally

Great news — your booth computer at ${church.name} is connected and Tally is monitoring your gear.

Before service:
- Tally runs a pre-flight check 30 minutes before your scheduled service
- You'll get a green-light notification or a list of exactly what needs attention
- No more walking into the booth wondering if everything's on

During service:
- If your stream drops, Tally auto-recovers it before anyone notices
- If a device disconnects, you get an alert with diagnosis
- Check your phone instead of being glued to the booth

Quick tip: If you haven't set up Telegram alerts yet, do it before Sunday. Connect at ${this.appUrl}/portal

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 3. Week-One Check-In ──

  _buildCheckinEmail(church) {
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">How's Tally working for you?</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        You've had Tally at <strong>${church.name}</strong> for about a week now.
        I'd love to hear how your first Sunday went.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        A few things you might not have tried yet:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          &bull; <strong>Remote control via Telegram</strong> &mdash; type "cut to camera 2" or "start recording"<br>
          &bull; <strong>Pre-service health check</strong> &mdash; automatic 30-min-before confirmation<br>
          &bull; <strong>Post-service timeline</strong> &mdash; see exactly what happened during the service<br>
          &bull; <strong>Weekly reports</strong> &mdash; share uptime stats with leadership
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hit reply and let me know how it's going &mdash; I read every response personally.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        &mdash; Andrew Disbrow<br>
        Founder, Tally
      </p>
    `);

    const text = `How's Tally working for you?

You've had Tally at ${church.name} for about a week now. I'd love to hear how your first Sunday went.

A few things you might not have tried yet:
- Remote control via Telegram — type "cut to camera 2" or "start recording"
- Pre-service health check — automatic 30-min-before confirmation
- Post-service timeline — see exactly what happened during the service
- Weekly reports — share uptime stats with leadership

Hit reply and let me know how it's going — I read every response personally.

— Andrew Disbrow
Founder, Tally

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 3b. Trial Ending in 7 Days ──

  _buildTrialEnding7DaysEmail(church, daysLeft) {
    const billingUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your free trial for <strong>${this._esc(church.name)}</strong> is wrapping up in one week.
        Here's exactly what you'll lose when it ends:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          ❌ Real-time monitoring of your ATEM, OBS, encoders, and audio gear<br>
          ❌ Automatic stream recovery when things go silent mid-service<br>
          ❌ Telegram alerts to your TD when problems are detected<br>
          ❌ Pre-service system checks 30 minutes before you go live<br>
          ❌ AI-powered production assistant in Telegram
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Sunday morning without Tally means manual checks, silent failures, and scrambling in the booth.
        Subscribe now and keep the safety net in place.
      </p>

      ${this._cta('Keep Tally Running →', billingUrl)}

      <p style="font-size: 13px; color: #666; line-height: 1.5; margin-top: 16px;">
        Plans start at $49/month. Cancel anytime. Your settings and history are preserved if you subscribe after the trial — no reconfiguration needed.
      </p>
    `);

    const text = `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}

Your free trial for ${church.name} ends in one week. Here's what you'll lose:

✗ Real-time monitoring of your gear
✗ Automatic stream recovery
✗ Telegram alerts for your TD
✗ Pre-service system checks
✗ AI production assistant

Subscribe at ${billingUrl} to keep Tally running. Plans start at $49/month.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 4. Trial Ending Soon ──

  _buildTrialEndingSoonEmail(church, daysLeft) {
    const billingUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your free trial for <strong>${church.name}</strong> is wrapping up soon.
        Here's what Tally has been doing for you:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Real-time monitoring of your production gear<br>
          &bull; Automatic recovery when things break<br>
          &bull; Alerts before your team even notices a problem<br>
          &bull; Pre-service checks so you know everything's ready
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        To keep Tally running, subscribe from your Church Portal. Plans start at $49/month.
      </p>

      ${this._cta('Subscribe Now', billingUrl)}

      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        When your trial ends, monitoring and auto-recovery will stop. Your data and settings are preserved &mdash; just subscribe to pick up right where you left off.
      </p>
    `);

    const text = `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}

Your free trial for ${church.name} is wrapping up soon.

Tally has been:
- Monitoring your production gear in real-time
- Automatically recovering when things break
- Alerting you before your team notices a problem
- Running pre-service checks

To keep Tally running, subscribe at ${billingUrl}. Plans start at $49/month.

When your trial ends, monitoring will stop. Your data and settings are preserved — just subscribe to pick up where you left off.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 5. Trial Ending Tomorrow ──

  _buildTrialEndingTomorrowEmail(church) {
    const billingUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally trial ends tomorrow</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        This is a friendly heads-up: your Tally trial for <strong>${church.name}</strong> expires tomorrow.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        After your trial ends:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Real-time monitoring will <strong>stop</strong><br>
          &bull; Auto-recovery will be <strong>disabled</strong><br>
          &bull; Telegram alerts and remote control will <strong>stop working</strong><br>
          &bull; Your settings and data are <strong>safe for 30 days</strong>
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Subscribe now to keep everything running through this Sunday and beyond.
      </p>

      ${this._cta('Subscribe Now', billingUrl)}
    `);

    const text = `Your Tally trial ends tomorrow

This is a friendly heads-up: your Tally trial for ${church.name} expires tomorrow.

After your trial ends:
- Real-time monitoring will stop
- Auto-recovery will be disabled
- Telegram alerts and remote control will stop working
- Your settings and data are safe for 30 days

Subscribe now at ${billingUrl} to keep everything running.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 6. Trial Expired ──

  _buildTrialExpiredEmail(church) {
    const billingUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally trial has ended</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your free trial for <strong>${church.name}</strong> has expired. Tally is no longer monitoring your production gear.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; font-weight: 700; color: #334155; margin-bottom: 8px;">What you're missing:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; No auto-recovery if your stream drops during service<br>
          &bull; No pre-service health checks<br>
          &bull; No remote control or alerts<br>
          &bull; No weekly reports for leadership
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your data and settings are safe for 30 days. Subscribe anytime to pick up right where you left off &mdash; no re-setup needed.
      </p>

      ${this._cta('Subscribe \u2014 Plans from $49/mo', billingUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions? Reply to this email or reach out at support@tallyconnect.app.
      </p>
    `);

    const text = `Your Tally trial has ended

Your free trial for ${church.name} has expired. Tally is no longer monitoring your production gear.

What you're missing:
- No auto-recovery if your stream drops during service
- No pre-service health checks
- No remote control or alerts
- No weekly reports for leadership

Your data and settings are safe for 30 days. Subscribe at ${billingUrl} to pick up where you left off.

Questions? Reply to this email or reach out at support@tallyconnect.app.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 7. Payment Failed ──

  _buildPaymentFailedEmail(church) {
    const billingUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Action needed: payment failed</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We weren't able to process the latest payment for Tally at <strong>${church.name}</strong>.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a;">
        <div style="font-size: 14px; color: #333; line-height: 1.8;">
          <strong>What happens next:</strong><br>
          &bull; You have a <strong>7-day grace period</strong> &mdash; Tally keeps working normally<br>
          &bull; We'll retry the payment automatically<br>
          &bull; If it's not resolved, monitoring will be paused after 7 days
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Please update your payment method to keep Tally running:
      </p>

      ${this._cta('Update Payment Method', billingUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        If you think this is a mistake, reply to this email and I'll help sort it out.
      </p>
    `);

    const text = `Action needed: payment failed for Tally

We weren't able to process the latest payment for Tally at ${church.name}.

What happens next:
- You have a 7-day grace period — Tally keeps working normally
- We'll retry the payment automatically
- If it's not resolved, monitoring will be paused after 7 days

Update your payment method at ${billingUrl}

If you think this is a mistake, reply to this email and I'll help sort it out.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ── 8. Weekly Digest ──

  _buildWeeklyDigestEmail(church, stats) {
    const portalUrl = `${this.appUrl}/portal`;

    const statsRows = [
      { label: 'Sessions monitored', value: stats.totalSessions },
      { label: 'Events detected', value: stats.totalEvents },
      { label: 'Critical alerts', value: stats.criticalEvents },
      { label: 'Auto-recoveries', value: stats.autoRecoveries },
    ];

    const statsHtml = statsRows.map(r => `
      <tr>
        <td style="padding: 8px 16px; font-size: 14px; color: #333; border-bottom: 1px solid #f1f5f9;">${r.label}</td>
        <td style="padding: 8px 16px; font-size: 14px; color: #111; font-weight: 700; text-align: right; border-bottom: 1px solid #f1f5f9;">${r.value}</td>
      </tr>
    `).join('');

    const summaryLine = stats.criticalEvents === 0
      ? 'No critical issues this week. Everything ran smoothly.'
      : `${stats.criticalEvents} critical event${stats.criticalEvents !== 1 ? 's' : ''} detected${stats.autoRecoveries > 0 ? `, ${stats.autoRecoveries} auto-recovered` : ''}.`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Weekly Report &mdash; ${church.name}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Here's what happened at <strong>${church.name}</strong> this past week:
      </p>

      <table style="width: 100%; border-collapse: collapse; margin: 24px 0; background: #f8fafc; border-radius: 10px; overflow: hidden;">
        ${statsHtml}
      </table>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        ${summaryLine}
      </p>

      ${this._cta('View Full Details', portalUrl)}

      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        Share this report with your leadership team &mdash; forward this email or view it in your <a href="${portalUrl}" style="color: #22c55e; text-decoration: none;">Church Portal</a>.
      </p>
    `);

    const text = `Tally Weekly Report — ${church.name}

Here's what happened this past week:

- Sessions monitored: ${stats.totalSessions}
- Events detected: ${stats.totalEvents}
- Critical alerts: ${stats.criticalEvents}
- Auto-recoveries: ${stats.autoRecoveries}

${summaryLine}

View full details at ${portalUrl}

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ─── SEQUENCE 9: CANCELLATION CONFIRMATION ─────────────────────────────────
  // Sent when a subscription is cancelled.

  async sendCancellationConfirmation(church, { periodEnd } = {}) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const portalUrl = `${this.appUrl}/portal`;
    const endDate = periodEnd ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the end of your billing period';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally subscription has been cancelled</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We're sorry to see <strong>${church.name}</strong> go. Your subscription has been cancelled and will remain active until <strong>${endDate}</strong>.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Monitoring continues until your current period ends<br>
          &bull; Your data and settings are preserved for 30 days after<br>
          &bull; You can reactivate anytime from your Church Portal
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Changed your mind? Reactivate your subscription before it expires:
      </p>

      ${this._cta('Reactivate Subscription', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        We'd love to know why you cancelled &mdash; reply to this email and let us know. Your feedback helps us improve.
      </p>
    `);

    const text = `Your Tally subscription has been cancelled\n\nYour subscription for ${church.name} has been cancelled and will remain active until ${endDate}.\n\nYour data is preserved for 30 days. Reactivate anytime at ${portalUrl}\n\nTally`;

    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'cancellation-confirmation',
      to: church.portal_email,
      subject: 'Your Tally subscription has been cancelled',
      html, text,
    });
  }

  // ─── SEQUENCE 10: UPGRADE CONFIRMATION ────────────────────────────────────

  async sendUpgradeConfirmation(church, { oldTier, newTier } = {}) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise' };
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Plan upgraded to ${TIER_NAMES[newTier] || newTier}!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has been upgraded from ${TIER_NAMES[oldTier] || oldTier} to <strong>${TIER_NAMES[newTier] || newTier}</strong>. Your new features are available immediately.
      </p>

      ${this._cta('Explore Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Your billing has been adjusted with proration. Check your portal for details.
      </p>
    `);

    const text = `Plan upgraded to ${TIER_NAMES[newTier] || newTier}!\n\n${church.name} has been upgraded from ${TIER_NAMES[oldTier] || oldTier} to ${TIER_NAMES[newTier] || newTier}.\n\nExplore your portal: ${portalUrl}`;

    // Use a unique email type so it can be sent again on future upgrades
    return this.sendEmail({
      churchId: church.churchId,
      emailType: `upgrade-${oldTier}-to-${newTier}`,
      to: church.portal_email,
      subject: `Plan upgraded to ${TIER_NAMES[newTier] || newTier}`,
      html, text,
    });
  }

  // ─── SEQUENCE 11: GRACE PERIOD EXPIRED ────────────────────────────────────

  async sendGraceExpired(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally has been paused</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The 7-day grace period for <strong>${church.name}</strong> has expired. Tally is no longer monitoring your production gear.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Real-time monitoring has <strong>stopped</strong><br>
          &bull; Auto-recovery is <strong>disabled</strong><br>
          &bull; Your data is safe for <strong>30 days</strong>
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Update your payment method to restore Tally immediately:
      </p>

      ${this._cta('Update Payment & Reactivate', portalUrl)}
    `);

    const text = `Tally has been paused\n\nThe 7-day grace period for ${church.name} has expired. Update your payment at ${portalUrl} to restore Tally.\n\nYour data is safe for 30 days.`;

    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'grace-expired',
      to: church.portal_email,
      subject: 'Tally monitoring paused — update payment to restore',
      html, text,
    });
  }

  // ─── SEQUENCE 12: REACTIVATION CONFIRMATION ──────────────────────────────

  async sendReactivationConfirmation(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Welcome back!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Great news &mdash; <strong>${church.name}</strong> is back online with Tally. Your subscription has been reactivated and monitoring has resumed.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Real-time monitoring is <strong>active</strong><br>
          &bull; Auto-recovery is <strong>enabled</strong><br>
          &bull; All your previous settings have been <strong>restored</strong>
        </div>
      </div>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666;">
        Glad to have you back! &mdash; Andrew
      </p>
    `);

    const text = `Welcome back!\n\n${church.name} is back online with Tally. Monitoring has resumed.\n\nOpen your portal: ${portalUrl}`;

    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'reactivation-confirmation',
      to: church.portal_email,
      subject: 'Welcome back! Tally is monitoring again',
      html, text,
    });
  }

  // ─── SEQUENCE 13: WIN-BACK (30 days after cancellation) ──────────────────

  async _checkWinBack() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    // Find churches cancelled 30-60 days ago that haven't resubscribed
    let cancelledChurches = [];
    try {
      cancelledChurches = this.db.prepare(`
        SELECT c.churchId, c.name, c.portal_email
        FROM churches c
        WHERE c.billing_status IN ('canceled', 'inactive')
          AND c.portal_email IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM billing_customers bc
            WHERE bc.church_id = c.churchId
              AND bc.status = 'canceled'
              AND bc.updated_at <= ?
              AND bc.updated_at >= ?
          )
      `).all(thirtyDaysAgo, sixtyDaysAgo);
    } catch { return; }

    for (const church of cancelledChurches) {
      const { html, text } = this._buildWinBackEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'win-back',
        to: church.portal_email,
        subject: 'We miss you at Tally — here\'s what you\'re missing',
        html, text,
      });
    }
  }

  _buildWinBackEmail(church) {
    const signupUrl = `${this.appUrl}/signup`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">We miss you at Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        It's been about a month since <strong>${church.name}</strong> cancelled. We wanted to check in and see if you'd like to come back.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; font-weight: 700; color: #334155; margin-bottom: 8px;">Since you left, we've added:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; Faster auto-recovery (under 5 seconds)<br>
          &bull; Smarter pre-service checks<br>
          &bull; Improved session reports<br>
          &bull; More device integrations
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your data and settings are still safe. Reactivate and pick up right where you left off:
      </p>

      ${this._cta('Reactivate Your Account', signupUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions? Reply to this email &mdash; I'd love to help.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally
      </p>
    `);

    const text = `We miss you at Tally\n\nIt's been about a month since ${church.name} cancelled. Your data is still safe — reactivate at ${signupUrl}\n\n— Andrew Disbrow, Founder`;

    return { html, text };
  }

  // ─── SEQUENCE 8: REVIEW REQUEST ─────────────────────────────────────────────
  // Fires once for happy, paying customers: 30-180 days active, 4+ sessions, 2+ clean.

  async _checkReviewRequest() {
    const minAge = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
    `).all(minAge, maxAge);

    for (const church of churches) {
      // Check session quality
      let sessionCount = 0, cleanCount = 0;
      try {
        const sc = this.db.prepare(
          'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ?'
        ).get(church.churchId);
        sessionCount = sc?.cnt || 0;
        const cc = this.db.prepare(
          "SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND grade LIKE '%Clean%'"
        ).get(church.churchId);
        cleanCount = cc?.cnt || 0;
      } catch { continue; }

      if (sessionCount < 4 || cleanCount < 2) continue;

      // Skip if review already submitted
      try {
        const existing = this.db.prepare(
          'SELECT 1 FROM church_reviews WHERE church_id = ?'
        ).get(church.churchId);
        if (existing) continue;
      } catch { /* table may not exist yet */ }

      const { html, text } = this._buildReviewRequestEmail(church, { sessionCount, cleanCount });
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'review-request',
        to: church.portal_email,
        subject: `${church.name} is crushing it — mind sharing a quick review?`,
        html,
        text,
      });
    }
  }

  _buildReviewRequestEmail(church, stats) {
    const portalUrl = `${this.appUrl}/church-portal?action=review`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">You're one of our top churches</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has run <strong>${stats.sessionCount} services</strong> with Tally,
        and <strong>${stats.cleanCount} of them were completely clean</strong> &mdash; zero issues. That's impressive.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <strong style="font-size: 15px; color: #111;">Would you take 60 seconds to share your experience?</strong>
        <p style="font-size: 14px; color: #333; line-height: 1.6; margin: 8px 0 0;">
          Your review helps other church production teams discover Tally &mdash; and keeps us building the right things.
        </p>
      </div>

      ${this._cta('Leave a Quick Review →', portalUrl)}

      <p style="font-size: 13px; color: #888; line-height: 1.6;">
        Your feedback helps other church production teams discover Tally &mdash; it means a lot.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally
      </p>
    `);

    const text = `You're one of our top churches

${church.name} has run ${stats.sessionCount} services with Tally, and ${stats.cleanCount} of them were completely clean — zero issues. That's impressive.

Would you take 60 seconds to share your experience?
Your review helps other church production teams discover Tally.

Leave a review: ${portalUrl}

You can also post on Google, Capterra, or G2.

— Andrew Disbrow
Founder, Tally

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }
  // ─── SEQUENCE 18: REGISTRATION CONFIRMATION ────────────────────────────
  // Sent immediately after signup, before email verification.

  async sendRegistrationConfirmation(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildRegistrationEmail(church);
    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'registration-confirmation',
      to: church.portal_email,
      subject: `${church.name} is registered — let's get started`,
      html, text,
    });
  }

  _buildRegistrationEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    const downloadUrl = GITHUB_RELEASES_URL;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Welcome to Tally!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has been registered and your 14-day free trial is active.
        Here's everything you need to get started:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Quick start:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1.</strong> Verify your email (check your inbox)<br>
          <strong>2.</strong> <a href="${downloadUrl}" style="color: #22c55e; text-decoration: none;">Download the Tally app</a> on your booth computer<br>
          <strong>3.</strong> Sign in with your registration code<br>
          <strong>4.</strong> Our AI setup assistant will walk you through the rest &mdash; just tell it about your gear, service times, and team in a quick conversation
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The setup assistant scans your network, finds your equipment, and configures everything automatically. Once connected, you'll have real-time monitoring, automatic recovery, and pre-service health checks &mdash; all running in the background.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Need help? Reply to this email or reach out at support@tallyconnect.app.
      </p>
    `);

    const text = `Welcome to Tally!\n\n${church.name} has been registered and your 14-day free trial is active.\n\nQuick start:\n1. Verify your email\n2. Download the Tally app: ${downloadUrl}\n3. Sign in with your registration code\n4. Our AI setup assistant walks you through the rest — just tell it about your gear and service times\n\nOpen your portal: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }

  // ─── SEQUENCE 19: DOWNGRADE CONFIRMATION ─────────────────────────────────

  async sendDowngradeConfirmation(church, { oldTier, newTier }) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const { html, text, subject } = this._buildDowngradeEmail(church, { oldTier, newTier });
    return this.sendEmail({
      churchId: church.churchId,
      emailType: `downgrade-${oldTier}-to-${newTier}`,
      to: church.portal_email,
      subject, html, text,
    });
  }

  _buildDowngradeEmail(church, { oldTier, newTier }) {
    const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise' };
    const oldName = TIER_NAMES[oldTier] || oldTier;
    const newName = TIER_NAMES[newTier] || newTier;
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Plan changed to ${newName}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has been moved from ${oldName} to <strong>${newName}</strong>.
        The change takes effect at the end of your current billing period.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a;">
        <div style="font-size: 14px; color: #333; line-height: 1.8;">
          <strong>What this means:</strong><br>
          &bull; You keep full ${oldName} features until this billing cycle ends<br>
          &bull; Next billing cycle, your plan switches to ${newName}<br>
          &bull; You can upgrade back anytime from your portal
        </div>
      </div>

      ${this._cta('Manage Your Plan', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions about the change? Reply to this email &mdash; happy to help.
      </p>
    `);

    const text = `Plan changed to ${newName}\n\n${church.name} has been moved from ${oldName} to ${newName}. The change takes effect at the end of your current billing period.\n\nManage your plan: ${portalUrl}\n\nTally`;
    return { html, text, subject: `Plan changed to ${newName}` };
  }

  // ─── SEQUENCE 20: GRACE PERIOD ENDING SOON ──────────────────────────────
  // Hourly check: 5+ days into the 7-day grace period (2 days left).

  async _checkGracePeriodEndingSoon() {
    const now = Date.now();
    const twoDaysFromNow = new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = this.db.prepare(`
        SELECT c.churchId, c.name, c.portal_email, bc.grace_period_ends_at
        FROM churches c
        JOIN billing_customers bc ON bc.church_id = c.churchId
        WHERE c.portal_email IS NOT NULL
          AND c.billing_status = 'past_due'
          AND bc.grace_period_ends_at IS NOT NULL
          AND bc.grace_period_ends_at <= ?
          AND bc.grace_period_ends_at > ?
      `).all(twoDaysFromNow, new Date(now).toISOString());
    } catch { return; }

    for (const church of churches) {
      const daysLeft = Math.ceil(
        (new Date(church.grace_period_ends_at).getTime() - now) / (24 * 60 * 60 * 1000)
      );
      const { html, text } = this._buildGracePeriodEndingSoonEmail(church, daysLeft);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'grace-period-ending',
        to: church.portal_email,
        subject: `Tally will be paused in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} — update payment now`,
        html, text,
      });
    }
  }

  _buildGracePeriodEndingSoonEmail(church, daysLeft) {
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your grace period ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We still haven't been able to process payment for <strong>${church.name}</strong>.
        If not resolved in the next ${daysLeft} day${daysLeft !== 1 ? 's' : ''}, Tally will be paused.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 1.8;">
          <strong>When paused:</strong><br>
          &bull; Real-time monitoring <strong>stops</strong><br>
          &bull; Auto-recovery <strong>disabled</strong><br>
          &bull; Pre-service checks <strong>won't run</strong><br>
          &bull; Your data is safe for 30 days
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Update your payment method now to avoid any interruption:
      </p>

      ${this._cta('Update Payment Method', portalUrl)}
    `);

    const text = `Your grace period ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}\n\nWe still can't process payment for ${church.name}. Update your payment at ${portalUrl} to avoid service interruption.\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 21: INVOICE UPCOMING ──────────────────────────────────────
  // Triggered from Stripe invoice.upcoming webhook (3 days before charge).

  async sendInvoiceUpcoming(church, { amount, dueDate }) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const monthKey = new Date(dueDate || Date.now()).toISOString().slice(0, 7); // 2026-03
    const { html, text } = this._buildInvoiceUpcomingEmail(church, { amount, dueDate });
    return this.sendEmail({
      churchId: church.churchId,
      emailType: `invoice-upcoming-${monthKey}`,
      to: church.portal_email,
      subject: `Upcoming invoice: $${(amount / 100).toFixed(2)} for Tally`,
      html, text,
    });
  }

  _buildInvoiceUpcomingEmail(church, { amount, dueDate }) {
    const portalUrl = `${this.appUrl}/portal`;
    const formattedAmount = `$${(amount / 100).toFixed(2)}`;
    const formattedDate = dueDate
      ? new Date(dueDate * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : 'soon';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Upcoming invoice</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        A payment of <strong>${formattedAmount}</strong> for <strong>${church.name}</strong> will be charged on <strong>${formattedDate}</strong>.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; font-size: 14px; color: #333;">
          <tr><td style="padding: 4px 0;">Church</td><td style="text-align: right; font-weight: 700;">${church.name}</td></tr>
          <tr><td style="padding: 4px 0;">Amount</td><td style="text-align: right; font-weight: 700;">${formattedAmount}</td></tr>
          <tr><td style="padding: 4px 0;">Charge date</td><td style="text-align: right; font-weight: 700;">${formattedDate}</td></tr>
        </table>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        No action needed &mdash; this is just a heads-up. You can view invoices and update your payment method from your portal.
      </p>

      ${this._cta('View Billing', portalUrl)}
    `);

    const text = `Upcoming invoice\n\nA payment of ${formattedAmount} for ${church.name} will be charged on ${formattedDate}.\n\nView billing at ${portalUrl}\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 22: EMAIL CHANGE CONFIRMATION ─────────────────────────────
  // Sent when portal email is changed. Bypasses dedup (like password-reset).

  async sendEmailChangeConfirmation(church, { oldEmail, newEmail }) {
    const to = newEmail || church.portal_email;
    if (!to) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildEmailChangeEmail(church, { oldEmail, newEmail });

    // Bypass dedup — send directly like password-reset
    if (!this.resendApiKey) {
      console.log(`[LifecycleEmails] No RESEND_API_KEY — would send email change confirmation to ${to}`);
      return { sent: false, reason: 'no-api-key' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.fromEmail, to: [to],
          subject: 'Your Tally email has been updated',
          html, text,
          tags: [{ name: 'category', value: 'email-change-confirmation' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { const err = await res.text(); console.error(`[LifecycleEmails] Email change send failed: ${err}`); return { sent: false, reason: 'resend-error' }; }
      const data = await res.json();
      try { this.db.prepare('INSERT INTO email_sends (church_id, email_type, recipient, sent_at, resend_id, subject) VALUES (?, ?, ?, ?, ?, ?)').run(church.churchId, 'email-change-confirmation', to, new Date().toISOString(), data.id, 'Your Tally email has been updated'); } catch { }
      return { sent: true, id: data.id };
    } catch (e) { return { sent: false, reason: 'network-error' }; }
  }

  _buildEmailChangeEmail(church, { oldEmail, newEmail }) {
    const portalUrl = `${this.appUrl}/portal`;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Email address updated</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The portal email for <strong>${church.name}</strong> has been changed.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          <strong>Previous:</strong> ${oldEmail || 'not set'}<br>
          <strong>New:</strong> ${newEmail}
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        All future emails (invoices, alerts, reports) will be sent to <strong>${newEmail}</strong>.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        If you didn't make this change, please contact support@tallyconnect.app immediately.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}
    `);

    const text = `Email address updated\n\nThe portal email for ${church.name} has been changed from ${oldEmail || 'not set'} to ${newEmail}.\n\nIf you didn't make this change, contact support@tallyconnect.app.\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 23: FIRST SERVICE COMPLETED ──────────────────────────────
  // Sent after the very first service session ends.

  async sendFirstServiceCompleted(church, sessionData) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildFirstServiceCompletedEmail(church, sessionData);
    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'first-service-completed',
      to: church.portal_email,
      subject: `First service in the books — here's how it went`,
      html, text,
    });
  }

  _buildFirstServiceCompletedEmail(church, sessionData) {
    const portalUrl = `${this.appUrl}/portal`;
    const grade = sessionData?.grade || 'Monitored';
    const duration = sessionData?.durationMinutes || 0;
    const alerts = sessionData?.alerts?.length || 0;
    const recoveries = sessionData?.recoveries || 0;

    const gradeColor = grade.includes('Clean') ? '#22c55e' : grade.includes('Minor') ? '#eab308' : '#ef4444';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your first service is in the books!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally just finished monitoring the first service at <strong>${church.name}</strong>. Here's a quick summary:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; font-size: 14px; color: #333;">
          <tr><td style="padding: 6px 0;">Grade</td><td style="text-align: right; font-weight: 700; color: ${gradeColor};">${grade}</td></tr>
          <tr><td style="padding: 6px 0;">Duration</td><td style="text-align: right; font-weight: 700;">${duration} min</td></tr>
          <tr><td style="padding: 6px 0;">Alerts</td><td style="text-align: right; font-weight: 700;">${alerts}</td></tr>
          ${recoveries ? `<tr><td style="padding: 6px 0;">Auto-recoveries</td><td style="text-align: right; font-weight: 700;">${recoveries}</td></tr>` : ''}
        </table>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        ${alerts === 0
          ? 'Everything ran smoothly &mdash; no issues detected. Tally was watching the whole time.'
          : `Tally detected ${alerts} issue${alerts !== 1 ? 's' : ''}${recoveries ? ` and auto-recovered ${recoveries}` : ''}. Check your portal for the full timeline.`}
      </p>

      ${this._cta('View Service Timeline', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        <strong>Tip:</strong> Share this with your production team lead &mdash; forward this email or invite them to the portal.
      </p>
    `);

    const text = `Your first service is in the books!\n\nTally monitored ${church.name}'s first service.\n\nGrade: ${grade} | Duration: ${duration} min | Alerts: ${alerts}\n\nView timeline: ${portalUrl}\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 24: DISPUTE ALERT ──────────────────────────────────────────
  // Sent to admin when a charge dispute is opened.

  async sendDisputeAlert(church, { amount, reason, disputeId }) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildDisputeAlertEmail(church, { amount, reason });
    return this.sendEmail({
      churchId: church.churchId,
      emailType: `dispute-alert-${disputeId || Date.now()}`,
      to: church.portal_email,
      subject: `Payment dispute opened — action required`,
      html, text,
    });
  }

  _buildDisputeAlertEmail(church, { amount, reason }) {
    const portalUrl = `${this.appUrl}/portal`;
    const formattedAmount = amount ? `$${(amount / 100).toFixed(2)}` : 'unknown';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Payment dispute opened</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        A payment dispute has been filed for <strong>${church.name}</strong>.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <table style="width: 100%; font-size: 14px; color: #333;">
          <tr><td style="padding: 4px 0;">Amount</td><td style="text-align: right; font-weight: 700;">${formattedAmount}</td></tr>
          <tr><td style="padding: 4px 0;">Reason</td><td style="text-align: right; font-weight: 700;">${reason || 'Not specified'}</td></tr>
        </table>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Disputes are serious and can result in account restrictions. If you believe this is a mistake, please reply to this email immediately so we can help resolve it.
      </p>

      ${this._cta('View Your Account', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        We'll work with you to resolve this as quickly as possible.
      </p>
    `);

    const text = `Payment dispute opened\n\nA dispute of ${formattedAmount} has been filed for ${church.name}. Reason: ${reason || 'not specified'}.\n\nPlease reply to this email to help resolve this.\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 25: URGENT ALERT ESCALATION ────────────────────────────────
  // Sent when a CRITICAL alert is escalated (90s no acknowledgment).
  // Bypasses dedup — each escalation gets its own email.

  async sendUrgentAlertEscalation(church, { alertType, context, alertId }) {
    const to = church.portal_email;
    if (!to) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildUrgentAlertEmail(church, { alertType, context });

    if (!this.resendApiKey) {
      console.log(`[LifecycleEmails] No RESEND_API_KEY — would send urgent alert email to ${to}`);
      return { sent: false, reason: 'no-api-key' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.fromEmail, to: [to],
          subject: `🚨 URGENT: ${alertType} at ${church.name}`,
          html, text,
          tags: [{ name: 'category', value: 'urgent-alert-escalation' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { const err = await res.text(); console.error(`[LifecycleEmails] Urgent alert email failed: ${err}`); return { sent: false, reason: 'resend-error' }; }
      const data = await res.json();
      try { this.db.prepare('INSERT INTO email_sends (church_id, email_type, recipient, sent_at, resend_id, subject) VALUES (?, ?, ?, ?, ?, ?)').run(church.churchId, `urgent-alert-${alertId || Date.now()}`, to, new Date().toISOString(), data.id, `URGENT: ${alertType} at ${church.name}`); } catch { }
      return { sent: true, id: data.id };
    } catch (e) { return { sent: false, reason: 'network-error' }; }
  }

  _buildUrgentAlertEmail(church, { alertType, context }) {
    const portalUrl = `${this.appUrl}/portal`;
    const contextStr = typeof context === 'object' ? JSON.stringify(context, null, 2) : (context || '');

    const html = this._wrap(`
      <div style="margin: 0 0 24px; padding: 16px 20px; background: #fef2f2; border-radius: 10px; border: 2px solid #ef4444;">
        <span style="font-size: 20px;">🚨</span>
        <strong style="font-size: 16px; color: #dc2626; margin-left: 8px;">CRITICAL ALERT — No Response</strong>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        A critical alert at <strong>${church.name}</strong> has gone unacknowledged for 90 seconds.
        The technical director has not responded via Telegram.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; font-size: 14px; color: #333;">
          <tr><td style="padding: 4px 0;">Alert type</td><td style="text-align: right; font-weight: 700;">${alertType || 'Unknown'}</td></tr>
          <tr><td style="padding: 4px 0;">Church</td><td style="text-align: right; font-weight: 700;">${church.name}</td></tr>
          ${contextStr ? `<tr><td style="padding: 4px 0;" colspan="2"><pre style="margin: 8px 0 0; font-size: 12px; background: #f1f5f9; padding: 8px; border-radius: 4px; overflow-x: auto;">${contextStr}</pre></td></tr>` : ''}
        </table>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        This email is a backup notification. Please check the portal for current status.
      </p>

      ${this._cta('View Alert Status', portalUrl)}
    `);

    const text = `🚨 CRITICAL ALERT — No Response\n\nAlert: ${alertType} at ${church.name}\nNo TD acknowledgment after 90 seconds.\n\nCheck status: ${portalUrl}\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 26: CANCELLATION FEEDBACK SURVEY ──────────────────────────
  // Hourly check: 3 days after cancellation, asks for feedback.

  async _checkCancellationSurvey() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = this.db.prepare(`
        SELECT c.churchId, c.name, c.portal_email
        FROM churches c
        WHERE c.billing_status IN ('canceled', 'inactive')
          AND c.portal_email IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM billing_customers bc
            WHERE bc.church_id = c.churchId
              AND bc.status = 'canceled'
              AND bc.updated_at <= ?
              AND bc.updated_at >= ?
          )
      `).all(threeDaysAgo, tenDaysAgo);
    } catch { return; }

    for (const church of churches) {
      const { html, text } = this._buildCancellationSurveyEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'cancellation-survey',
        to: church.portal_email,
        subject: 'Quick question — what could we have done better?',
        html, text,
      });
    }
  }

  _buildCancellationSurveyEmail(church) {
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">We'd love your honest feedback</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hi &mdash; it's Andrew from Tally. Since <strong>${church.name}</strong> cancelled a few days ago,
        I wanted to personally ask: <strong>what could we have done better?</strong>
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          Was it:<br>
          &bull; <strong>Pricing</strong> &mdash; too expensive for what you got?<br>
          &bull; <strong>Features</strong> &mdash; missing something you needed?<br>
          &bull; <strong>Reliability</strong> &mdash; too many issues or false alerts?<br>
          &bull; <strong>Fit</strong> &mdash; your team didn't end up using it?<br>
          &bull; <strong>Something else</strong> entirely?
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Just hit reply and let me know. Even one sentence helps &mdash; I read every response personally
        and use it to make Tally better for everyone.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        And of course, if you ever want to come back, your data and settings are saved for 30 days.
        Just log in at <a href="${this.appUrl}/portal" style="color: #22c55e; text-decoration: none;">your portal</a>.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally
      </p>
    `);

    const text = `We'd love your honest feedback\n\n${church.name} cancelled a few days ago. What could we have done better?\n\n- Pricing?\n- Features?\n- Reliability?\n- Fit?\n- Something else?\n\nJust reply to this email — I read every response.\n\n— Andrew Disbrow\nFounder, Tally`;
    return { html, text };
  }

  // ─── LEAD NURTURE DRIP SEQUENCE ─────────────────────────────────────────
  // Captures leads and sends a 4-email drip over 14 days.

  /** Capture a new sales lead. Returns the lead row. */
  captureLead({ email, name, source, churchName }) {
    if (!email) return null;
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO sales_leads (email, name, church_name, source, captured_at) VALUES (?, ?, ?, ?, ?)'
      ).run(email, name || null, churchName || null, source || 'website', now);
    } catch (e) {
      console.error(`[LifecycleEmails] Lead capture failed: ${e.message}`);
      return null;
    }
    return this.db.prepare('SELECT * FROM sales_leads WHERE email = ?').get(email);
  }

  /** Send the immediate welcome email for a new lead */
  async sendLeadWelcome(lead) {
    if (!lead?.email) return { sent: false, reason: 'no-recipient' };
    const { html, text } = this._buildLeadWelcomeEmail(lead);
    return this.sendEmail({
      churchId: `lead:${lead.email}`,
      emailType: 'lead-welcome',
      to: lead.email,
      subject: 'Here\'s how churches are running stress-free services',
      html, text,
    });
  }

  /** Hourly check: send drip emails at day 3, 7, 14 */
  async _checkLeadNurture() {
    const now = Date.now();
    const drips = [
      { emailType: 'lead-day3-value',     minAge: 3,  maxAge: 7,  builder: '_buildLeadDay3Email',  subject: '3 problems Tally solves before Sunday' },
      { emailType: 'lead-day7-casestudy', minAge: 7,  maxAge: 14, builder: '_buildLeadDay7Email',  subject: 'How one church eliminated stream failures' },
      { emailType: 'lead-day14-offer',    minAge: 14, maxAge: 30, builder: '_buildLeadDay14Email', subject: 'Ready to try Tally? Start your free trial' },
    ];

    for (const drip of drips) {
      const minCapturedAt = new Date(now - drip.maxAge * 24 * 60 * 60 * 1000).toISOString();
      const maxCapturedAt = new Date(now - drip.minAge * 24 * 60 * 60 * 1000).toISOString();

      let leads = [];
      try {
        leads = this.db.prepare(
          'SELECT * FROM sales_leads WHERE status = ? AND captured_at <= ? AND captured_at >= ?'
        ).all('active', maxCapturedAt, minCapturedAt);
      } catch { continue; }

      for (const lead of leads) {
        const { html, text } = this[drip.builder](lead);
        await this.sendEmail({
          churchId: `lead:${lead.email}`,
          emailType: drip.emailType,
          to: lead.email,
          subject: drip.subject,
          html, text,
        });
      }
    }
  }

  _buildLeadWelcomeEmail(lead) {
    const signupUrl = `${this.appUrl}/signup`;
    const name = lead.name ? lead.name.split(' ')[0] : 'there';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Hey ${name} &mdash; thanks for your interest in Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally is the production monitoring system built specifically for churches.
        It watches your ATEM switcher, OBS, streaming, and other gear &mdash;
        and automatically fixes problems before your congregation notices.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">What Tally does:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; <strong>Auto-recovers</strong> dropped streams before anyone notices<br>
          &bull; <strong>Pre-service checks</strong> 30 minutes before service starts<br>
          &bull; <strong>Real-time alerts</strong> to your tech director via Telegram<br>
          &bull; <strong>Weekly reports</strong> for church leadership
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        You get a 14-day free trial with full access &mdash; no credit card required to start.
      </p>

      ${this._cta('Start Your Free Trial', signupUrl)}

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally
      </p>
    `);

    const text = `Hey ${name} — thanks for your interest in Tally\n\nTally monitors your church production gear and auto-fixes problems.\n\n- Auto-recovers dropped streams\n- Pre-service health checks\n- Real-time alerts via Telegram\n- Weekly reports\n\nStart your free trial: ${signupUrl}\n\n— Andrew Disbrow`;
    return { html, text };
  }

  _buildLeadDay3Email(lead) {
    const signupUrl = `${this.appUrl}/signup`;
    const name = lead.name ? lead.name.split(' ')[0] : 'there';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">3 problems Tally solves before Sunday</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hey ${name} &mdash; every church production team deals with these:
      </p>

      <div style="margin: 24px 0;">
        <div style="padding: 16px 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca; margin-bottom: 12px;">
          <strong style="color: #dc2626;">1. Stream drops mid-service</strong>
          <p style="font-size: 14px; color: #333; margin: 4px 0 0;">Tally detects it and auto-restarts OBS/stream automatically. No one in the booth has to scramble.</p>
        </div>
        <div style="padding: 16px 20px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a; margin-bottom: 12px;">
          <strong style="color: #b45309;">2. No one checks gear before service</strong>
          <p style="font-size: 14px; color: #333; margin: 4px 0 0;">Tally runs a pre-flight check 30 minutes early and texts your TD if anything's off.</p>
        </div>
        <div style="padding: 16px 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
          <strong style="color: #15803d;">3. Leadership has no visibility</strong>
          <p style="font-size: 14px; color: #333; margin: 4px 0 0;">Tally sends weekly reports showing uptime, issues, and session grades &mdash; easy to share with pastors.</p>
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        All of this runs in the background. Set it up once, and it just works.
      </p>

      ${this._cta('Try It Free for 14 Days', signupUrl)}
    `);

    const text = `3 problems Tally solves:\n\n1. Stream drops → auto-recovery before anyone notices\n2. Gear not checked → pre-flight 30 min before service\n3. No leadership visibility → weekly reports\n\nTry free: ${signupUrl}`;
    return { html, text };
  }

  _buildLeadDay7Email(lead) {
    const signupUrl = `${this.appUrl}/signup`;
    const name = lead.name ? lead.name.split(' ')[0] : 'there';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">How one church eliminated stream failures</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hey ${name} &mdash; wanted to share a quick story.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <p style="font-size: 15px; color: #333; line-height: 1.6; margin: 0;">
          A 300-member church in Texas was losing their stream 2-3 times per month. Their volunteer TD would scramble
          to restart OBS while the online audience dropped off. Leadership was frustrated.
        </p>
        <p style="font-size: 15px; color: #333; line-height: 1.6; margin: 16px 0 0;">
          After installing Tally, their stream drops went to <strong>zero visible outages</strong>. Tally auto-recovered
          every disconnection before the online congregation even noticed. Their TD now checks his phone instead of being
          glued to the booth.
        </p>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The setup took 10 minutes. No special hardware needed &mdash; just the Tally app on the booth computer.
      </p>

      ${this._cta('Start Your Free Trial', signupUrl)}

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew
      </p>
    `);

    const text = `How one church eliminated stream failures\n\nA 300-member church was losing their stream 2-3 times per month. After Tally: zero visible outages. Auto-recovery handles everything.\n\nSetup takes 10 minutes. Try free: ${signupUrl}`;
    return { html, text };
  }

  _buildLeadDay14Email(lead) {
    const signupUrl = `${this.appUrl}/signup`;
    const name = lead.name ? lead.name.split(' ')[0] : 'there';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Ready to try Tally?</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hey ${name} &mdash; just checking in one more time. If your church production team deals with
        stream issues, gear surprises on Sunday morning, or volunteer burnout &mdash; Tally can help.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Your free trial includes:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; 14 days of full access, no credit card needed<br>
          &bull; Auto-recovery, pre-service checks, real-time alerts<br>
          &bull; 10-minute setup &mdash; works with your existing gear<br>
          &bull; Personal support from our team if you need it
        </div>
      </div>

      ${this._cta('Start Your Free Trial', signupUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Not the right time? No worries. This is the last email in this series &mdash;
        we won't keep bugging you. But if you ever want to try it, just visit
        <a href="${signupUrl}" style="color: #22c55e; text-decoration: none;">tallyconnect.app/signup</a>.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally
      </p>
    `);

    const text = `Ready to try Tally?\n\n14 days free, no credit card, 10-minute setup.\n\nStart your trial: ${signupUrl}\n\nThis is the last email in this series. Visit tallyconnect.app/signup anytime.\n\n— Andrew Disbrow`;
    return { html, text };
  }

  // ─── SEQUENCE 15: WELCOME EMAIL (after email verification) ───────────────

  async sendWelcomeVerified(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const portalUrl = `${this.appUrl}/portal`;
    const downloadUrl = GITHUB_RELEASES_URL;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">You're all set!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your email has been verified for <strong>${church.name}</strong>. Welcome to Tally!
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Next steps:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1.</strong> <a href="${downloadUrl}" style="color: #22c55e; text-decoration: none;">Download the Tally app</a> on your booth computer<br>
          <strong>2.</strong> Sign in with your registration code<br>
          <strong>3.</strong> Set up <strong>Telegram alerts</strong> so your TDs get notified on their phones<br>
          <strong>4.</strong> Set your <strong>service schedule</strong> for automatic pre-flight checks
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your trial has started &mdash; you have full access to everything while you try it out.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions? Reply to this email or check out our <a href="${this.appUrl}/how-to" style="color: #22c55e; text-decoration: none;">setup guides</a>.
      </p>
    `);

    const text = `You're all set!\n\nYour email has been verified for ${church.name}. Welcome to Tally!\n\nNext steps:\n1. Download the Tally app: ${downloadUrl}\n2. Sign in with your registration code\n3. Set up Telegram alerts\n4. Set your service schedule\n\nYour trial has started — full access to everything.\n\nOpen your portal: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'welcome-verified',
      to: church.portal_email,
      subject: `Welcome to Tally, ${church.name}!`,
      html, text,
    });
  }

  // ─── SEQUENCE 16: PAYMENT CONFIRMED (new subscription) ─────────────────

  async sendPaymentConfirmed(church, { tier, interval } = {}) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event Pass' };
    const tierName = TIER_NAMES[tier] || tier || 'your plan';
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Payment confirmed &mdash; you're on ${tierName}!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Thanks for subscribing! <strong>${church.name}</strong> is now on the <strong>${tierName}</strong> plan${interval === 'annual' ? ' (annual)' : ''}.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">What's included:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; 24/7 real-time monitoring &amp; auto-recovery<br>
          &bull; Pre-service health checks<br>
          &bull; Telegram alerts &amp; remote control<br>
          &bull; Session timelines &amp; reports<br>
          &bull; Priority support
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        You can manage your subscription, view invoices, and update payment details from your Church Portal.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Thank you for trusting Tally with your production. We're here if you need anything.
      </p>
    `);

    const text = `Payment confirmed — you're on ${tierName}!\n\nThanks for subscribing! ${church.name} is now on the ${tierName} plan${interval === 'annual' ? ' (annual)' : ''}.\n\nManage your subscription at ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

    return this.sendEmail({
      churchId: church.churchId,
      emailType: 'payment-confirmed',
      to: church.portal_email,
      subject: `Payment confirmed — ${church.name} is on ${tierName}`,
      html, text,
    });
  }

  // ─── SEQUENCE 17: PASSWORD RESET ──────────────────────────────────────────

  async sendPasswordReset(church, { resetUrl }) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Reset your password</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We received a request to reset the portal password for <strong>${church.name}</strong>.
      </p>

      ${this._cta('Reset Password', resetUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.5;">
        This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
      </p>
    `);

    const text = `Reset your password\n\nWe received a request to reset the portal password for ${church.name}.\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.\n\nTally — ${this.appUrl.replace('https://', '')}`;

    // Password reset emails should NOT be deduped — allow multiple sends
    // So we bypass the normal sendEmail and call Resend directly
    if (!this.resendApiKey) {
      console.log(`[LifecycleEmails] No RESEND_API_KEY — would send password reset to ${church.portal_email}`);
      return { sent: false, reason: 'no-api-key' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [church.portal_email],
          subject: 'Reset your Tally password',
          html, text,
          tags: [{ name: 'category', value: 'password-reset' }],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[LifecycleEmails] Password reset send failed (${res.status}): ${err}`);
        return { sent: false, reason: 'resend-error' };
      }

      const data = await res.json();
      console.log(`[LifecycleEmails] Password reset sent to ${church.portal_email}, id: ${data.id}`);
      return { sent: true, id: data.id };
    } catch (e) {
      console.error(`[LifecycleEmails] Password reset send failed: ${e.message}`);
      return { sent: false, reason: 'network-error' };
    }
  }
  // ─── ADMIN DASHBOARD METHODS ──────────────────────────────────────────────

  /** Email type registry — maps email_type to display info */
  static EMAIL_REGISTRY = [
    { type: 'setup-reminder',          name: 'Setup Nudge',             trigger: 'Auto — 24h after signup, app not connected' },
    { type: 'first-sunday-prep',       name: 'First Sunday Prep',       trigger: 'Auto — 3 days after signup, app connected' },
    { type: 'week-one-checkin',        name: 'Week-One Check-In',       trigger: 'Auto — 7 days after signup' },
    { type: 'trial-ending-soon',       name: 'Trial Ending Soon',       trigger: 'Auto — 5 days before trial expires' },
    { type: 'trial-ending-tomorrow',   name: 'Trial Ending Tomorrow',   trigger: 'Auto — 1 day before trial expires' },
    { type: 'trial-expired',           name: 'Trial Expired',           trigger: 'Billing webhook — trial ended' },
    { type: 'payment-failed',          name: 'Payment Failed',          trigger: 'Billing webhook — payment declined' },
    { type: 'weekly-digest',           name: 'Weekly Digest',           trigger: 'Auto — Monday 8 AM for Pro+ churches' },
    { type: 'cancellation-confirmation', name: 'Cancellation Confirmed', trigger: 'Billing webhook — subscription cancelled' },
    { type: 'upgrade',                 name: 'Upgrade Confirmation',    trigger: 'Billing webhook — plan upgraded' },
    { type: 'grace-expired',           name: 'Grace Period Expired',    trigger: 'Billing webhook — 7-day grace ended' },
    { type: 'reactivation-confirmation', name: 'Reactivation Confirmed', trigger: 'Billing webhook — account reactivated' },
    { type: 'win-back',                name: 'Win-Back',                trigger: 'Auto — 30-60 days after cancellation' },
    { type: 'review-request',          name: 'Review Request',          trigger: 'Auto — 30-180 days, 4+ sessions, 2+ clean' },
    { type: 'welcome-verified',        name: 'Welcome Email',           trigger: 'On email verification' },
    { type: 'payment-confirmed',       name: 'Payment Confirmed',       trigger: 'Billing webhook — new subscription' },
    { type: 'password-reset',          name: 'Password Reset',          trigger: 'Self-service — forgot password' },
    // Gap emails
    { type: 'registration-confirmation', name: 'Registration Confirmation', trigger: 'On signup — immediate' },
    { type: 'downgrade-confirmation',  name: 'Downgrade Confirmation',   trigger: 'On plan downgrade' },
    { type: 'grace-period-ending',     name: 'Grace Period Ending',      trigger: 'Auto — 2 days before grace expires' },
    { type: 'invoice-upcoming',        name: 'Invoice Upcoming',         trigger: 'Stripe webhook — invoice.upcoming' },
    { type: 'email-change-confirmation', name: 'Email Change',           trigger: 'On portal email change' },
    { type: 'first-service-completed', name: 'First Service Recap',      trigger: 'After first session ends' },
    { type: 'dispute-alert',           name: 'Dispute Alert',            trigger: 'Stripe webhook — charge.dispute.created' },
    { type: 'urgent-alert-escalation', name: 'Urgent Alert Email',       trigger: 'Alert escalation — 90s no ack' },
    { type: 'cancellation-survey',     name: 'Cancellation Survey',      trigger: 'Auto — 3 days after cancellation' },
    // Lead nurture drip
    { type: 'lead-welcome',            name: 'Lead: Welcome',            trigger: 'On lead capture — immediate' },
    { type: 'lead-day3-value',         name: 'Lead: Value Prop',         trigger: 'Auto — 3 days after capture' },
    { type: 'lead-day7-casestudy',     name: 'Lead: Case Study',         trigger: 'Auto — 7 days after capture' },
    { type: 'lead-day14-offer',        name: 'Lead: Special Offer',      trigger: 'Auto — 14 days after capture' },
  ];

  /** Get email send history with optional filters */
  getEmailHistory({ limit = 50, offset = 0, emailType, churchId } = {}) {
    const where = [];
    const params = [];

    if (emailType) {
      where.push('es.email_type LIKE ?');
      params.push(`%${emailType}%`);
    }
    if (churchId) {
      where.push('es.church_id = ?');
      params.push(churchId);
    }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as total FROM email_sends es ${whereClause}`
    ).get(...params);

    const rows = this.db.prepare(`
      SELECT es.*, c.name AS church_name
      FROM email_sends es
      LEFT JOIN churches c ON c.churchId = es.church_id
      ${whereClause}
      ORDER BY es.sent_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    return { rows, total: countRow?.total || 0 };
  }

  /** Get stats for email dashboard */
  getEmailStats() {
    const total = this.db.prepare('SELECT COUNT(*) as cnt FROM email_sends').get()?.cnt || 0;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = this.db.prepare('SELECT COUNT(*) as cnt FROM email_sends WHERE sent_at >= ?')
      .get(todayStart.toISOString())?.cnt || 0;

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thisWeek = this.db.prepare('SELECT COUNT(*) as cnt FROM email_sends WHERE sent_at >= ?')
      .get(weekAgo)?.cnt || 0;

    // Per-type breakdown
    const byType = this.db.prepare(
      'SELECT email_type, COUNT(*) as cnt FROM email_sends GROUP BY email_type ORDER BY cnt DESC'
    ).all();

    return { total, today, thisWeek, byType };
  }

  /** Get all template types with override status */
  getTemplateList() {
    const overrides = new Set();
    try {
      const rows = this.db.prepare('SELECT email_type FROM email_template_overrides').all();
      rows.forEach(r => overrides.add(r.email_type));
    } catch { /* table might not exist yet */ }

    return LifecycleEmails.EMAIL_REGISTRY.map(entry => ({
      ...entry,
      hasOverride: overrides.has(entry.type),
    }));
  }

  /** Get a template override from DB */
  _getOverride(emailType) {
    try {
      // Also check partial matches for dynamic types (weekly-digest-*, upgrade-*-to-*)
      const baseType = emailType.startsWith('weekly-digest-') ? 'weekly-digest' :
        emailType.startsWith('upgrade-') ? 'upgrade' : emailType;
      return this.db.prepare('SELECT subject, html FROM email_template_overrides WHERE email_type = ?').get(baseType);
    } catch { return null; }
  }

  /** Preview a template with sample data */
  getPreview(emailType) {
    const sampleChurch = { name: 'Sample Church', churchId: 'preview-123', portal_email: 'admin@example.com' };
    const override = this._getOverride(emailType);

    // Map email types to their builder methods + default subjects
    const builders = {
      'setup-reminder':          () => ({ ...this._buildSetupReminderEmail(sampleChurch), subject: 'Need help getting Tally set up?' }),
      'first-sunday-prep':       () => ({ ...this._buildFirstSundayEmail(sampleChurch), subject: 'Get ready for your first Sunday with Tally' }),
      'week-one-checkin':        () => ({ ...this._buildCheckinEmail(sampleChurch), subject: "How's Tally working for you?" }),
      'trial-ending-soon':       () => ({ ...this._buildTrialEndingSoonEmail(sampleChurch, 5), subject: 'Your Tally trial ends in 5 days' }),
      'trial-ending-tomorrow':   () => ({ ...this._buildTrialEndingTomorrowEmail(sampleChurch), subject: 'Your Tally trial ends tomorrow' }),
      'trial-expired':           () => ({ ...this._buildTrialExpiredEmail(sampleChurch), subject: 'Your Tally trial has ended' }),
      'payment-failed':          () => ({ ...this._buildPaymentFailedEmail(sampleChurch), subject: 'Action needed: payment failed for Tally' }),
      'weekly-digest':           () => ({ ...this._buildWeeklyDigestEmail(sampleChurch, { totalSessions: 3, totalEvents: 12, criticalEvents: 1, autoRecoveries: 1, totalAlerts: 2 }), subject: 'Tally Weekly Report — Sample Church' }),
      'cancellation-confirmation': () => {
        const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const portalUrl = `${this.appUrl}/portal`;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally subscription has been cancelled</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            We're sorry to see <strong>Sample Church</strong> go. Your subscription will remain active until <strong>${endDate}</strong>.
          </p>
          ${this._cta('Reactivate Subscription', portalUrl)}
        `);
        return { html, text: '', subject: 'Your Tally subscription has been cancelled' };
      },
      'upgrade':                 () => {
        const portalUrl = `${this.appUrl}/portal`;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Plan upgraded to Pro!</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            <strong>Sample Church</strong> has been upgraded from Plus to <strong>Pro</strong>. Your new features are available immediately.
          </p>
          ${this._cta('Explore Your Portal', portalUrl)}
        `);
        return { html, text: '', subject: 'Plan upgraded to Pro' };
      },
      'grace-expired':           () => {
        const portalUrl = `${this.appUrl}/portal`;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally has been paused</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            The 7-day grace period for <strong>Sample Church</strong> has expired.
          </p>
          ${this._cta('Update Payment & Reactivate', portalUrl)}
        `);
        return { html, text: '', subject: 'Tally monitoring paused — update payment to restore' };
      },
      'reactivation-confirmation': () => {
        const portalUrl = `${this.appUrl}/portal`;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Welcome back!</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            Great news — <strong>Sample Church</strong> is back online with Tally.
          </p>
          ${this._cta('Open Your Portal', portalUrl)}
        `);
        return { html, text: '', subject: 'Welcome back! Tally is monitoring again' };
      },
      'win-back':                () => ({ ...this._buildWinBackEmail(sampleChurch), subject: "We miss you at Tally — here's what you're missing" }),
      'review-request':          () => ({ ...this._buildReviewRequestEmail(sampleChurch, { sessionCount: 12, cleanCount: 9 }), subject: 'Sample Church is crushing it — mind sharing a quick review?' }),
      'welcome-verified':        () => {
        const portalUrl = `${this.appUrl}/portal`;
        const downloadUrl = GITHUB_RELEASES_URL;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">You're all set!</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            Your email has been verified for <strong>Sample Church</strong>. Welcome to Tally!
          </p>
          ${this._cta('Open Your Portal', portalUrl)}
        `);
        return { html, text: '', subject: 'Welcome to Tally, Sample Church!' };
      },
      'payment-confirmed':       () => {
        const portalUrl = `${this.appUrl}/portal`;
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Payment confirmed — you're on Pro!</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            Thanks for subscribing! <strong>Sample Church</strong> is now on the <strong>Pro</strong> plan.
          </p>
          ${this._cta('Open Your Portal', portalUrl)}
        `);
        return { html, text: '', subject: 'Payment confirmed — Sample Church is on Pro' };
      },
      'password-reset':          () => {
        const html = this._wrap(`
          <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Reset your password</h1>
          <p style="font-size: 15px; color: #333; line-height: 1.6;">
            We received a request to reset the portal password for <strong>Sample Church</strong>.
          </p>
          ${this._cta('Reset Password', this.appUrl + '/portal/reset-password?token=sample-token')}
        `);
        return { html, text: '', subject: 'Reset your Tally password' };
      },
      // Gap emails
      'registration-confirmation': () => ({ ...this._buildRegistrationEmail(sampleChurch), subject: 'Sample Church is registered — let\'s get started' }),
      'downgrade-confirmation':  () => ({ ...this._buildDowngradeEmail(sampleChurch, { oldTier: 'pro', newTier: 'plus' }) }),
      'grace-period-ending':     () => ({ ...this._buildGracePeriodEndingSoonEmail(sampleChurch, 2), subject: 'Tally will be paused in 2 days — update payment now' }),
      'invoice-upcoming':        () => ({ ...this._buildInvoiceUpcomingEmail(sampleChurch, { amount: 9900, dueDate: Math.floor(Date.now() / 1000) + 3 * 86400 }), subject: 'Upcoming invoice: $99.00 for Tally' }),
      'email-change-confirmation': () => ({ ...this._buildEmailChangeEmail(sampleChurch, { oldEmail: 'old@example.com', newEmail: 'new@example.com' }), subject: 'Your Tally email has been updated' }),
      'first-service-completed': () => ({ ...this._buildFirstServiceCompletedEmail(sampleChurch, { grade: '🟢 Clean Service', durationMinutes: 72, alerts: [], recoveries: 0 }), subject: 'First service in the books — here\'s how it went' }),
      'dispute-alert':           () => ({ ...this._buildDisputeAlertEmail(sampleChurch, { amount: 9900, reason: 'product_not_received' }), subject: 'Payment dispute opened — action required' }),
      'urgent-alert-escalation': () => ({ ...this._buildUrgentAlertEmail(sampleChurch, { alertType: 'stream_stopped', context: { source: 'OBS', duration: '90s' } }), subject: '🚨 URGENT: stream_stopped at Sample Church' }),
      'cancellation-survey':     () => ({ ...this._buildCancellationSurveyEmail(sampleChurch), subject: 'Quick question — what could we have done better?' }),
      // Lead nurture drip
      'lead-welcome':            () => ({ ...this._buildLeadWelcomeEmail({ email: 'lead@example.com', name: 'John Smith' }), subject: 'Here\'s how churches are running stress-free services' }),
      'lead-day3-value':         () => ({ ...this._buildLeadDay3Email({ email: 'lead@example.com', name: 'John Smith' }), subject: '3 problems Tally solves before Sunday' }),
      'lead-day7-casestudy':     () => ({ ...this._buildLeadDay7Email({ email: 'lead@example.com', name: 'John Smith' }), subject: 'How one church eliminated stream failures' }),
      'lead-day14-offer':        () => ({ ...this._buildLeadDay14Email({ email: 'lead@example.com', name: 'John Smith' }), subject: 'Ready to try Tally? Start your free trial' }),
    };

    const builder = builders[emailType];
    if (!builder) return { error: 'Unknown email type' };

    const built = builder();
    return {
      subject: override?.subject || built.subject,
      html: override?.html || built.html,
      text: built.text || '',
      hasOverride: !!override,
      defaultSubject: built.subject,
      defaultHtml: built.html,
    };
  }

  /** Save an admin override for a template */
  applyOverride(emailType, { subject, html }) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO email_template_overrides (email_type, subject, html, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email_type) DO UPDATE SET
        subject = excluded.subject,
        html = excluded.html,
        updated_at = excluded.updated_at
    `).run(emailType, subject || null, html || null, now);
    console.log(`[LifecycleEmails] Template override saved for "${emailType}"`);
    return { emailType, subject, updated_at: now };
  }

  /** Remove an admin override — reverts to default template */
  removeOverride(emailType) {
    this.db.prepare('DELETE FROM email_template_overrides WHERE email_type = ?').run(emailType);
    console.log(`[LifecycleEmails] Template override removed for "${emailType}"`);
  }

  /** Send a manual/custom email — bypasses dedup */
  async sendManual({ churchId, emailType, to, subject, html, text }) {
    if (!to) return { sent: false, reason: 'no-recipient' };

    const actualType = emailType ? `manual:${emailType}` : 'custom';

    if (!this.resendApiKey) {
      console.log(`[LifecycleEmails] No RESEND_API_KEY — would send manual "${subject}" to ${to}`);
      return { sent: false, reason: 'no-api-key' };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [to],
          subject,
          html,
          text: text || '',
          tags: [{ name: 'category', value: actualType }],
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        const err = await res.text();
        console.error(`[LifecycleEmails] Manual send failed (${res.status}): ${err}`);
        return { sent: false, reason: 'resend-error', detail: err };
      }

      const data = await res.json();
      // Record in email_sends (use INSERT without UNIQUE conflict by using the manual: prefix)
      try {
        this.db.prepare(
          'INSERT INTO email_sends (church_id, email_type, recipient, sent_at, resend_id, subject) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(churchId || 'admin', actualType, to, new Date().toISOString(), data.id, subject);
      } catch { /* ignore duplicate key for manual sends */ }

      console.log(`[LifecycleEmails] Manual send "${subject}" to ${to}, id: ${data.id}`);
      return { sent: true, id: data.id };
    } catch (e) {
      console.error(`[LifecycleEmails] Manual send failed: ${e.message}`);
      return { sent: false, reason: 'network-error' };
    }
  }

  /** Get the email wrapper HTML (for custom email composition) */
  getWrapperHtml() {
    return this._wrap('<p style="font-size: 15px; color: #333; line-height: 1.6;">Your content here...</p>');
  }
}

module.exports = { LifecycleEmails };
