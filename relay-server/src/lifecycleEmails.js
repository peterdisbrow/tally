/**
 * Lifecycle Email Sequences — Tally by ATEM School
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

const { createLogger } = require('./logger');
const log = createLogger('lifecycle');

const GITHUB_RELEASES_URL = 'https://github.com/atemschool/tally/releases/latest';

class LifecycleEmails {
  constructor(db, { resendApiKey, fromEmail, appUrl }) {
    this.db = db;
    this.resendApiKey = resendApiKey || '';
    this.fromEmail = fromEmail || 'Tally by ATEM School <noreply@atemschool.com>';
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

    const now = new Date().toISOString();

    if (!this.resendApiKey) {
      log.info(`No RESEND_API_KEY — would send "${subject}" (${emailType}) to ${to}`);
      // Still record it so we don't spam logs
      this._recordSend(churchId, emailType, to, now, null);
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
      });

      if (!res.ok) {
        const err = await res.text();
        log.error(`Resend failed (${res.status}): ${err}`);
        return { sent: false, reason: 'resend-error' };
      }

      const data = await res.json();
      this._recordSend(churchId, emailType, to, now, data.id);
      log.info(`Sent "${subject}" (${emailType}) to ${to}, id: ${data.id}`);
      return { sent: true, id: data.id };
    } catch (e) {
      log.error(`Send failed: ${e.message}`);
      return { sent: false, reason: 'network-error' };
    }
  }

  _hasSent(churchId, emailType) {
    const row = this.db.prepare(
      'SELECT 1 FROM email_sends WHERE church_id = ? AND email_type = ?'
    ).get(churchId, emailType);
    return !!row;
  }

  _recordSend(churchId, emailType, recipient, sentAt, resendId) {
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO email_sends (church_id, email_type, recipient, sent_at, resend_id) VALUES (?, ?, ?, ?, ?)'
      ).run(churchId, emailType, recipient, sentAt, resendId || null);
    } catch (e) {
      log.error(`Failed to record send: ${e.message}`);
    }
  }

  // ─── HOURLY CHECK ───────────────────────────────────────────────────────────

  async runCheck() {
    try {
      await this._checkSetupReminders();
      await this._checkFirstSundayPrep();
      await this._checkWeekOneCheckin();
      await this._checkTrialEndingSoon();
      await this._checkTrialEndingTomorrow();
      await this._checkWeeklyDigest();
      await this._checkReviewRequest();
      await this._checkWinBack();
    } catch (e) {
      log.error(`runCheck error: ${e.message}`);
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

    const churches = this.db.prepare(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status IN ('active', 'trialing')
        AND portal_email IS NOT NULL
        AND onboarding_app_connected_at IS NOT NULL
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

    // Session count from session_recaps table
    let totalSessions = 0;
    try {
      const sessionCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM session_recaps WHERE church_id = ? AND started_at >= ?'
      ).get(churchId, sinceIso);
      totalSessions = sessionCount?.cnt || 0;
    } catch {
      // session_recaps table might not exist
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
        Tally by ATEM School &mdash; <a href="${this.appUrl}" style="color: #999;">${this.appUrl.replace('https://', '')}</a>
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
        Setup takes about 10 minutes &mdash; here's a quick refresher:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          <strong>1.</strong> <a href="${downloadUrl}" style="color: #22c55e; text-decoration: none;">Download the Tally app</a> on your booth computer<br>
          <strong>2.</strong> Sign in with your registration code<br>
          <strong>3.</strong> Tally auto-discovers your ATEM, OBS, and other gear
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        That's it. Once connected, you'll see your gear status in the <a href="${this.appUrl}/portal" style="color: #22c55e; text-decoration: none;">Church Portal</a> and get alerts if anything goes wrong.
      </p>

      ${this._cta('Download Tally', downloadUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Need help? Reply to this email or reach out at andrew@atemschool.com &mdash; happy to walk you through it.
      </p>
    `);

    const text = `Need help getting Tally set up?

Hi! You signed up for Tally at ${church.name} but we haven't seen your booth computer connect yet.

Setup takes about 10 minutes:
1. Download the Tally app: ${downloadUrl}
2. Sign in with your registration code
3. Tally auto-discovers your ATEM, OBS, and other gear

Once connected, you'll see your gear status at ${this.appUrl}/portal

Need help? Reply to this email or reach out at andrew@atemschool.com

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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
          &bull; If your stream drops, Tally auto-recovers it (usually in under 10 seconds)<br>
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
- If your stream drops, Tally auto-recovers it (usually in under 10 seconds)
- If a device disconnects, you get an alert with diagnosis
- Check your phone instead of being glued to the booth

Quick tip: If you haven't set up Telegram alerts yet, do it before Sunday. Connect at ${this.appUrl}/portal

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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
        Founder, Tally by ATEM School
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
Founder, Tally by ATEM School

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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
        Questions? Reply to this email or reach out at andrew@atemschool.com.
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

Questions? Reply to this email or reach out at andrew@atemschool.com.

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

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

    const text = `Your Tally subscription has been cancelled\n\nYour subscription for ${church.name} has been cancelled and will remain active until ${endDate}.\n\nYour data is preserved for 30 days. Reactivate anytime at ${portalUrl}\n\nTally by ATEM School`;

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

    const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Managed' };
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
        &mdash; Andrew Disbrow<br>Founder, Tally by ATEM School
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
        You can also post your review on
        <a href="https://g.page/r/YOUR_GOOGLE_REVIEW_LINK" style="color: #22c55e;">Google</a>,
        <a href="https://www.capterra.com/reviews/new/YOUR_CAPTERRA_ID" style="color: #22c55e;">Capterra</a>, or
        <a href="https://www.g2.com/products/tally-connect/reviews" style="color: #22c55e;">G2</a>
        &mdash; either way, it means a lot.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; Andrew Disbrow<br>Founder, Tally by ATEM School
      </p>
    `);

    const text = `You're one of our top churches

${church.name} has run ${stats.sessionCount} services with Tally, and ${stats.cleanCount} of them were completely clean — zero issues. That's impressive.

Would you take 60 seconds to share your experience?
Your review helps other church production teams discover Tally.

Leave a review: ${portalUrl}

You can also post on Google, Capterra, or G2.

— Andrew Disbrow
Founder, Tally by ATEM School

Tally by ATEM School — ${this.appUrl.replace('https://', '')}`;

    return { html, text };
  }
}

module.exports = { LifecycleEmails };
