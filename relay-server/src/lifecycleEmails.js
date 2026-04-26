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

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('./jwtSecret');

const DOWNLOAD_MAC_URL = 'https://github.com/peterdisbrow/tally/releases/download/v1.0.1/Tally-signed.dmg';

class LifecycleEmails {
  constructor(db, { resendApiKey, fromEmail, appUrl, queryClient } = {}) {
    const looksLikeQueryClient = !queryClient
      && db
      && typeof db.query === 'function'
      && typeof db.run === 'function'
      && typeof db.prepare !== 'function';

    this.db = looksLikeQueryClient ? null : db;
    this.queryClient = queryClient || (looksLikeQueryClient ? db : null);
    this.resendApiKey = resendApiKey || '';
    this.fromEmail = fromEmail || 'Tally <noreply@tallyconnect.app>';
    this.appUrl = appUrl || 'https://tallyconnect.app';
    this._writeQueue = Promise.resolve();
    this._cache = {
      churchesById: new Map(),
      preferencesByChurchId: new Map(),
      overridesByEmailType: new Map(),
      emailSends: [],
      salesLeadsByEmail: new Map(),
    };
    this.ready = this._bootstrap();
  }

  async _bootstrap() {
    if (this.queryClient) {
      await this._ensureSchemaAsync();
      await this.refreshCache();
      return;
    }

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

    // Email preferences table — lets users opt out of specific email categories
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_preferences (
        church_id TEXT NOT NULL,
        category TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (church_id, category)
      )
    `);

    // Per-recipient unsubscribe table — individual recipients can opt out
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_unsubscribes (
        church_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        category TEXT NOT NULL,
        unsubscribed_at TEXT NOT NULL,
        PRIMARY KEY (church_id, recipient, category)
      )
    `);

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

  async _ensureSchemaAsync() {
    const idColumn = this.queryClient?.driver === 'postgres'
      ? 'BIGSERIAL PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT';
    const statements = [
      `
      CREATE TABLE IF NOT EXISTS email_sends (
        id ${idColumn},
        church_id TEXT NOT NULL,
        email_type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        resend_id TEXT,
        UNIQUE(church_id, email_type)
      )`,
      `
      CREATE TABLE IF NOT EXISTS email_template_overrides (
        email_type TEXT PRIMARY KEY,
        subject TEXT,
        html TEXT,
        updated_at TEXT NOT NULL
      )`,
      `ALTER TABLE email_sends ADD COLUMN subject TEXT`,
      `
      CREATE TABLE IF NOT EXISTS email_preferences (
        church_id TEXT NOT NULL,
        category TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (church_id, category)
      )`,
      `
      CREATE TABLE IF NOT EXISTS sales_leads (
        id ${idColumn},
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        church_name TEXT,
        source TEXT DEFAULT 'website',
        captured_at TEXT NOT NULL,
        status TEXT DEFAULT 'active'
      )`,
    ];

    for (const sql of statements) {
      try {
        await this._exec(sql);
      } catch (err) {
        // Column migration and "already exists" paths are intentionally best-effort.
        console.debug('[lifecycleEmails migrations] schema statement:', err?.message);
      }
    }
  }

  async refreshCache() {
    if (!this.queryClient) return this._cache;

    const [churches, preferences, overrides, emailSends, leads, unsubscribes] = await Promise.all([
      this._queryAll('SELECT churchId, name FROM churches'),
      this._queryAll('SELECT church_id, category, enabled, updated_at FROM email_preferences'),
      this._queryAll('SELECT email_type, subject, html, updated_at FROM email_template_overrides'),
      this._queryAll('SELECT id, church_id, email_type, recipient, sent_at, resend_id, subject FROM email_sends'),
      this._queryAll('SELECT id, email, name, church_name, source, captured_at, status FROM sales_leads'),
      this._queryAll('SELECT church_id, recipient, category, unsubscribed_at FROM email_unsubscribes'),
    ].map(async (promise) => {
      try { return await promise; } catch { return []; }
    }));

    this._cache.churchesById = new Map(
      (churches || []).map((row) => [row.churchId || row.church_id || row.id, row])
    );

    const prefsByChurchId = new Map();
    for (const row of preferences || []) {
      const current = prefsByChurchId.get(row.church_id) || {};
      current[row.category] = Number(row.enabled) === 1;
      prefsByChurchId.set(row.church_id, current);
    }
    this._cache.preferencesByChurchId = prefsByChurchId;

    this._cache.overridesByEmailType = new Map(
      (overrides || []).map((row) => [row.email_type, row])
    );

    this._cache.emailSends = [...(emailSends || [])].sort(
      (a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
    );

    this._cache.salesLeadsByEmail = new Map(
      (leads || []).map((row) => [row.email, row])
    );

    this._cache.recipientUnsubscribes = unsubscribes || [];

    return this._cache;
  }

  async _exec(sql) {
    if (this.queryClient) return this.queryClient.exec(sql);
    return this.db.exec(sql);
  }

  async _queryAll(sql, params = []) {
    if (this.queryClient) return this.queryClient.query(sql, params);
    return this.db.prepare(sql).all(...params);
  }

  async _queryOne(sql, params = []) {
    if (this.queryClient) return this.queryClient.queryOne(sql, params);
    return this.db.prepare(sql).get(...params) || null;
  }

  async _queryValue(sql, params = []) {
    if (this.queryClient) return this.queryClient.queryValue(sql, params);
    const row = this.db.prepare(sql).get(...params);
    if (!row) return null;
    const [firstValue] = Object.values(row);
    return firstValue ?? null;
  }

  async _selectAll(sql, params = []) {
    return this._queryAll(sql, params);
  }

  async _selectOne(sql, params = []) {
    return this._queryOne(sql, params);
  }

  async _count(sql, params = []) {
    const row = await this._queryOne(sql, params);
    if (!row) return 0;
    const values = Object.values(row);
    return Number(values[0] || 0);
  }

  async _run(sql, params = []) {
    if (this.queryClient) return this.queryClient.run(sql, params);
    return this.db.prepare(sql).run(...params);
  }

  _queueWrite(task) {
    if (!this.queryClient) {
      return Promise.resolve().then(task);
    }

    const run = async () => {
      try {
        return await task();
      } catch (e) {
        console.error(`[LifecycleEmails] Queued write failed: ${e.message}`);
        return null;
      }
    };

    this._writeQueue = this._writeQueue.then(run, run);
    return this._writeQueue;
  }

  _cacheChurch(church) {
    if (!church?.churchId) return;
    this._cache.churchesById.set(church.churchId, church);
  }

  _cachePreference(churchId, category, enabled) {
    const current = { ...(this._cache.preferencesByChurchId.get(churchId) || {}) };
    current[category] = !!enabled;
    this._cache.preferencesByChurchId.set(churchId, current);
  }

  _cacheOverride(emailType, row) {
    if (!row) {
      this._cache.overridesByEmailType.delete(emailType);
      return;
    }
    this._cache.overridesByEmailType.set(emailType, row);
  }

  _cacheSend(row) {
    if (!row) return;
    const key = `${row.church_id || row.churchId || 'admin'}::${row.email_type}`;
    this._cache.emailSends = [
      row,
      ...this._cache.emailSends.filter((entry) => `${entry.church_id || entry.churchId || 'admin'}::${entry.email_type}` !== key),
    ];
  }

  _cacheLead(row) {
    if (!row?.email) return;
    this._cache.salesLeadsByEmail.set(row.email, row);
  }

  // ─── CORE SEND ──────────────────────────────────────────────────────────────

  /**
   * Send an email via Resend, logging to email_sends for dedup.
   * Returns { sent, id?, reason? }
   *
   * @param {boolean} [urgent] — bypasses per-church 5-minute throttle (use for
   *   externally-triggered emails like payment-failed or trial-expired)
   */
  async sendEmail({ churchId, emailType, to, subject, html, text, urgent = false }) {
    await this.ready;

    // Check if already sent
    if (this._hasSent(churchId, emailType)) {
      return { sent: false, reason: 'already-sent' };
    }

    // Per-church 5-minute throttle — prevents burst when runCheck() qualifies
    // multiple email types simultaneously. Bypassed for urgent externally-triggered emails.
    if (!urgent) {
      const throttled = this._isThrottled(churchId);
      if (throttled) {
        console.log(`[LifecycleEmails] Throttled (${emailType}) for church ${churchId} — last email sent ${throttled}s ago`);
        return { sent: false, reason: 'throttled' };
      }
    }

    if (!to) {
      return { sent: false, reason: 'no-recipient' };
    }

    // Check email preferences — respect opt-outs (church-wide and per-recipient)
    if (this._isOptedOut(churchId, emailType)) {
      return { sent: false, reason: 'opted-out' };
    }
    if (this._isRecipientUnsubscribed(churchId, to, emailType)) {
      return { sent: false, reason: 'recipient-unsubscribed' };
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

  // ─── EMAIL PREFERENCES ────────────────────────────────────────────────────

  static EMAIL_CATEGORIES = {
    'service-recaps':  { name: 'Service Recaps',      types: ['session-recap'] },
    'weekly-digest':   { name: 'Weekly Digest',        types: ['weekly-digest'] },
    'monthly-reports': { name: 'Monthly Reports',      types: ['monthly-roi-summary'] },
    'onboarding':      { name: 'Setup & Onboarding',   types: ['setup-reminder', 'first-sunday-prep', 'week-one-checkin', 'activation-escalation', 'telegram-setup-nudge', 'pre-service-friday', 'trial-to-paid-onboarding'] },
    'feature-tips':    { name: 'Feature Tips',          types: ['schedule-setup-nudge', 'multi-cam-nudge', 'viewer-analytics-nudge', 'nps-survey'] },
    'billing':         { name: 'Billing & Trial',       types: ['trial-ending-7days', 'trial-ending-soon', 'trial-ending-tomorrow', 'trial-expired', 'payment-failed', 'grace-period-ending', 'grace-period-ending-early', 'annual-renewal-reminder', 'invoice-upcoming'] },
    'referral':        { name: 'Referral Program',      types: ['referral-invite'] },
    'win-back':        { name: 'Win-Back & Retention',  types: ['early-win-back', 'win-back', 'cancellation-survey', 'inactivity-alert'] },
  };

  /** Get category for a given email type */
  _getCategoryForType(emailType) {
    // Session recaps have dynamic keys like session-recap-{id}
    if (emailType.startsWith('session-recap')) return 'service-recaps';
    if (emailType.startsWith('weekly-digest-email-') || emailType.startsWith('weekly-digest-')) return 'weekly-digest';
    if (emailType.startsWith('monthly-report-email-') || emailType.startsWith('monthly-roi-summary-')) return 'monthly-reports';
    for (const [cat, def] of Object.entries(LifecycleEmails.EMAIL_CATEGORIES)) {
      if (def.types.includes(emailType)) return cat;
    }
    return null; // uncategorized — always send
  }

  /** Check if a church has opted out of a category */
  _isOptedOut(churchId, emailType) {
    const category = this._getCategoryForType(emailType);
    if (!category) return false; // uncategorized always sends
    if (this.queryClient) {
      const prefs = this._cache.preferencesByChurchId.get(churchId);
      return prefs ? prefs[category] === false : false;
    }
    try {
      const row = this.db.prepare(
        'SELECT enabled FROM email_preferences WHERE church_id = ? AND category = ?'
      ).get(churchId, category);
      return row && row.enabled === 0;
    } catch { return false; }
  }

  /** Get all preferences for a church */
  getPreferences(churchId) {
    const prefs = {};
    for (const cat of Object.keys(LifecycleEmails.EMAIL_CATEGORIES)) {
      prefs[cat] = true; // default enabled
    }
    if (this.queryClient) {
      const cached = this._cache.preferencesByChurchId.get(churchId);
      if (cached) {
        for (const [cat, enabled] of Object.entries(cached)) {
          if (cat in prefs) prefs[cat] = !!enabled;
        }
      }
      return prefs;
    }
    try {
      const rows = this.db.prepare(
        'SELECT category, enabled FROM email_preferences WHERE church_id = ?'
      ).all(churchId);
      for (const row of rows) {
        if (row.category in prefs) prefs[row.category] = row.enabled === 1;
      }
    } catch { /* table may not exist */ }
    return prefs;
  }

  /** Update preference for a church */
  setPreference(churchId, category, enabled) {
    if (!(category in LifecycleEmails.EMAIL_CATEGORIES)) return false;
    const now = new Date().toISOString();
    if (this.queryClient) {
      this._cachePreference(churchId, category, enabled);
      void this._queueWrite(() => this._run(
        'INSERT OR REPLACE INTO email_preferences (church_id, category, enabled, updated_at) VALUES (?, ?, ?, ?)',
        [churchId, category, enabled ? 1 : 0, now],
      ));
      return true;
    }
    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO email_preferences (church_id, category, enabled, updated_at) VALUES (?, ?, ?, ?)'
      ).run(churchId, category, enabled ? 1 : 0, now);
      return true;
    } catch { return false; }
  }

  /** Check if a specific recipient has unsubscribed from a category */
  _isRecipientUnsubscribed(churchId, recipient, emailType) {
    if (!recipient) return false;
    const category = this._getCategoryForType(emailType);
    if (!category) return false;
    const normalizedEmail = recipient.trim().toLowerCase();
    if (this.queryClient) {
      const unsubs = this._cache.recipientUnsubscribes;
      return unsubs ? unsubs.some(r =>
        (r.church_id || r.churchId) === churchId &&
        r.recipient === normalizedEmail &&
        r.category === category
      ) : false;
    }
    try {
      const row = this.db.prepare(
        'SELECT 1 FROM email_unsubscribes WHERE church_id = ? AND recipient = ? AND category = ?'
      ).get(churchId, normalizedEmail, category);
      return !!row;
    } catch { return false; }
  }

  /** Unsubscribe a specific recipient from a category */
  unsubscribeRecipient(churchId, recipient, category) {
    const normalizedEmail = recipient.trim().toLowerCase();
    const now = new Date().toISOString();
    if (this.queryClient) {
      if (!this._cache.recipientUnsubscribes) this._cache.recipientUnsubscribes = [];
      const existing = this._cache.recipientUnsubscribes.find(r =>
        (r.church_id || r.churchId) === churchId &&
        r.recipient === normalizedEmail &&
        r.category === category
      );
      if (!existing) {
        this._cache.recipientUnsubscribes.push({ church_id: churchId, recipient: normalizedEmail, category, unsubscribed_at: now });
      }
      void this._queueWrite(() => this._run(
        'INSERT OR REPLACE INTO email_unsubscribes (church_id, recipient, category, unsubscribed_at) VALUES (?, ?, ?, ?)',
        [churchId, normalizedEmail, category, now],
      ));
      return true;
    }
    try {
      this.db.prepare(
        'INSERT OR REPLACE INTO email_unsubscribes (church_id, recipient, category, unsubscribed_at) VALUES (?, ?, ?, ?)'
      ).run(churchId, normalizedEmail, category, now);
      return true;
    } catch { return false; }
  }

  _hasSent(churchId, emailType) {
    if (this.queryClient) {
      return this._cache.emailSends.some(
        (row) => (row.church_id || row.churchId) === churchId && row.email_type === emailType
      );
    }
    const row = this.db.prepare(
      'SELECT 1 FROM email_sends WHERE church_id = ? AND email_type = ?'
    ).get(churchId, emailType);
    return !!row;
  }

  /**
   * Returns seconds since last send if within 5-minute throttle window, else false.
   */
  _isThrottled(churchId) {
    const THROTTLE_MS = 5 * 60 * 1000;
    const now = Date.now();
    const recent = this._cache.emailSends
      .filter((row) => (row.church_id || row.churchId) === churchId && row.sent_at)
      .map((row) => new Date(row.sent_at).getTime())
      .filter((t) => !isNaN(t))
      .reduce((max, t) => Math.max(max, t), 0);

    if (!recent) return false;
    const elapsed = now - recent;
    if (elapsed < THROTTLE_MS) return Math.max(1, Math.floor(elapsed / 1000));
    return false;
  }

  _recordSend(churchId, emailType, recipient, sentAt, resendId, subject) {
    if (this.queryClient) {
      const row = {
        church_id: churchId,
        email_type: emailType,
        recipient,
        sent_at: sentAt,
        resend_id: resendId || null,
        subject: subject || null,
      };
      this._cacheSend(row);
      this._cacheChurch({ churchId, name: this._cache.churchesById.get(churchId)?.name || null });
      void this._queueWrite(() => this._run(
        'INSERT OR IGNORE INTO email_sends (church_id, email_type, recipient, sent_at, resend_id, subject) VALUES (?, ?, ?, ?, ?, ?)',
        [churchId, emailType, recipient, sentAt, resendId || null, subject || null],
      ));
      return;
    }
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
    const unsubscribeFooter = this._buildUnsubscribeFooter(church.churchId, toEmail, 'digest');
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
        ${unsubscribeFooter}
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
    const unsubscribeFooter = this._buildUnsubscribeFooter(church.churchId, toEmail, 'report');

    // Build narrative insight line
    const recoveryRate = alertsTriggered > 0 ? Math.round((autoRecovered / alertsTriggered) * 100) : 100;
    const prevServicesMonitored = reportData.prevServicesMonitored;
    const trendLine = prevServicesMonitored != null && prevServicesMonitored > 0
      ? (servicesMonitored > prevServicesMonitored
          ? `<p style="color: #86efac; font-size: 13px; margin: 0 0 16px;">↑ Up from ${prevServicesMonitored} services last month &mdash; your most active month yet.</p>`
          : servicesMonitored < prevServicesMonitored
            ? `<p style="color: #94A3B8; font-size: 13px; margin: 0 0 16px;">↓ Down from ${prevServicesMonitored} services last month.</p>`
            : `<p style="color: #94A3B8; font-size: 13px; margin: 0 0 16px;">Same as last month (${prevServicesMonitored} services).</p>`)
      : '';
    const roiLine = autoRecovered > 0
      ? `<p style="color: #86efac; font-size: 14px; margin: 16px 0 0; font-weight: 600;">Tally auto-fixed ${autoRecovered} issue${autoRecovered !== 1 ? 's' : ''} this month &mdash; ${autoRecovered} Sunday moment${autoRecovered !== 1 ? 's' : ''} your congregation never saw.</p>`
      : `<p style="color: #86efac; font-size: 14px; margin: 16px 0 0; font-weight: 600;">Clean month &mdash; no issues required auto-recovery.</p>`;

    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; background: #09090B; color: #F8FAFC; padding: 32px; border-radius: 12px;">
        <h1 style="font-size: 20px; margin-bottom: 4px;">Monthly Production Report</h1>
        <p style="color: #94A3B8; margin: 0 0 24px;">${churchName} &middot; ${this._esc(monthLabel)}</p>
        ${trendLine}
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Services Monitored</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${servicesMonitored}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Alerts Triggered</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${alertsTriggered}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Auto-Recovered</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${autoRecovered}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Recovery Rate</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600; color: ${recoveryRate >= 80 ? '#22c55e' : recoveryRate >= 50 ? '#eab308' : '#ef4444'};">${recoveryRate}%</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Escalated</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${escalated}</td></tr>
          <tr><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; color: #94A3B8;">Most Common Issue</td><td style="padding: 8px 12px; border-bottom: 1px solid #1a2e1f; text-align: right; font-weight: 600;">${mostCommonIssue ? this._esc(mostCommonIssue) : '<span style="color:#22c55e;">None</span>'}</td></tr>
          <tr><td style="padding: 8px 12px; color: #94A3B8;">Uptime Estimate</td><td style="padding: 8px 12px; text-align: right; font-weight: 600; color: ${uptimeColor};">${typeof uptime === 'number' ? uptime.toFixed(1) + '%' : uptime}</td></tr>
        </table>
        ${roiLine}
        <div style="text-align: center; margin-top: 24px;">
          <a href="${this.appUrl}/church-portal?church=${church.churchId}" style="display:inline-block; background:#22c55e; color:#000; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:600; font-size:14px;">Sign In to View Report</a>
        </div>
        <p style="text-align: center; margin-top: 20px; color: #475569; font-size: 11px;">Sent by Tally &middot; <a href="${this.appUrl}" style="color:#475569;">tallyconnect.app</a></p>
        ${unsubscribeFooter}
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

  _buildUnsubscribeFooter(churchId, email, type) {
    if (!churchId || !email || !type) return '';
    try {
      const token = jwt.sign({ churchId, email, type }, getJwtSecret(), { expiresIn: '365d' });
      const unsubscribeUrl = `${process.env.RELAY_URL || 'https://api.tallyconnect.app'}/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
      return `<p style="font-size:12px;color:#888;text-align:center;margin-top:32px;"><a href="${unsubscribeUrl}" style="color:#888;">Unsubscribe</a> from these emails.</p>`;
    } catch {
      return '';
    }
  }

  // ─── HOURLY CHECK ───────────────────────────────────────────────────────────

  async runCheck() {
    try {
      await this.ready;

      // ── Onboarding sequence ──
      await this._checkSetupReminders();
      await this._checkFirstSundayPrep();
      await this._checkWeekOneCheckin();
      await this._checkActivationEscalation();   // GAP 2: Day 10 never-connected escalation
      await this._checkTelegramSetupNudge();      // GAP 7: Day 5 no Telegram nudge
      await this._checkPreServiceFriday();        // GAP 3: 48h before first scheduled service

      // ── Trial sequence ──
      await this._checkTrialEnding7Days();
      await this._checkTrialEndingSoon();
      await this._checkTrialEndingTomorrow();
      await this._checkTrialToPaidOnboarding();   // GAP 4: 24h after first payment

      // ── Billing ──
      await this._checkGracePeriodEarlyWarning(); // GAP 13: Day 2 of grace (5 days before expiry)
      await this._checkGracePeriodEndingSoon();
      await this._checkAnnualRenewalReminder();   // GAP 6: 30 days before annual renewal

      // ── Engagement ──
      await this._checkWeeklyDigest();
      await this._checkInactivityAlert();          // GAP 11: 4+ weeks no sessions
      await this._checkNPSSurvey();                // GAP 8: Day 60 NPS
      await this._checkFirstYearAnniversary();     // GAP 9: 365 days active

      // ── Retention / win-back ──
      await this._checkCancellationSurvey();
      await this._checkEarlyWinBack();             // GAP 1: Day 7-14 post-cancel
      await this._checkWinBack();                  // Day 14-30 post-cancel

      // ── Referral ──
      await this._checkReferralInvite();           // GAP 10: Day 90, 4+ sessions

      // ── Feature adoption ──
      await this._checkScheduleSetupNudge();       // Day 7, no schedule configured
      await this._checkMultiCamNudge();            // Day 21, single-camera only
      await this._checkViewerAnalyticsNudge();     // Day 30, no stream platform connected

      // ── Reviews ──
      await this._checkReviewRequest();

      // ── Lead nurture ──
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

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE onboarding_app_connected_at IS NULL
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `, [cutoff, maxAge]);

    for (const church of churches) {
      const { html, text } = this._buildSetupReminderEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'setup-reminder',
        to: church.portal_email,
        subject: "Your booth computer isn't connected yet \u2014 here's how to finish setup",
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

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE onboarding_app_connected_at IS NOT NULL
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `, [cutoff, maxAge]);

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

  // ─── SEQUENCE 3: WEEK ONE CHECK-IN (Day 5) ─────────────────────────────────
  // Shifted from Day 7 to Day 5 to avoid collision with Trial Ending 7 Days email.

  async _checkWeekOneCheckin() {
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `, [cutoff, maxAge]);

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

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `, [sevenDaysFromNow, new Date(now).toISOString()]);

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

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `, [fiveDaysFromNow, new Date(now).toISOString()]);

    for (const church of churches) {
      const daysLeft = Math.ceil(
        (new Date(church.billing_trial_ends).getTime() - now) / (24 * 60 * 60 * 1000)
      );
      const { html, text } = this._buildTrialEndingSoonEmail(church, daysLeft);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'trial-ending-soon',
        to: church.portal_email,
        subject: daysLeft <= 3
          ? `3 days left \u2014 don\u2019t lose your safety net this Sunday`
          : `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        html,
        text,
      });
    }
  }

  // ─── SEQUENCE 5: TRIAL ENDING TOMORROW (1 day before) ──────────────────────

  async _checkTrialEndingTomorrow() {
    const now = Date.now();
    const oneDayFromNow = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email, billing_trial_ends
      FROM churches
      WHERE billing_status = 'trialing'
        AND billing_trial_ends IS NOT NULL
        AND billing_trial_ends <= ?
        AND billing_trial_ends > ?
        AND portal_email IS NOT NULL
    `, [oneDayFromNow, new Date(now).toISOString()]);

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
      urgent: true,
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
      urgent: true,
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
    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email, billing_tier
      FROM churches
      WHERE billing_status IN ('active', 'trialing')
        AND portal_email IS NOT NULL
        AND onboarding_app_connected_at IS NOT NULL
        AND billing_tier IN ('pro', 'managed')
    `);

    for (const church of churches) {
      const emailType = `weekly-digest-${weekId}`;
      const stats = await this._gatherWeeklyStats(church.churchId, weekAgo);

      // Only send if there was some activity (at least one session or event)
      if (stats.totalEvents === 0 && stats.totalSessions === 0) continue;

      const { html, text } = this._buildWeeklyDigestEmail(church, stats);
      await this.sendEmail({
        churchId: church.churchId,
        emailType,
        to: church.portal_email,
        subject: `Weekly Report \u2014 ${church.name}`,
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

  async _gatherWeeklyStats(churchId, sinceIso) {
    // Events from service_events table
    let totalEvents = 0;
    let criticalEvents = 0;
    let autoRecoveries = 0;

    try {
      const events = await this._selectAll(
        "SELECT event_type, resolved, auto_resolved FROM service_events WHERE church_id = ? AND timestamp >= ? AND event_type NOT LIKE 'incident_summary_%'"
      , [churchId, sinceIso]);

      totalEvents = events.length;
      const criticalTypes = ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'];
      criticalEvents = events.filter(e => criticalTypes.includes(e.event_type)).length;
      autoRecoveries = events.filter(e => e.auto_resolved).length;
    } catch (err) {
      // service_events table might not exist — not critical
      console.debug('[lifecycleEmails _gatherWeeklyStats] service_events query:', err?.message);
    }

    // Alerts from alerts table
    let totalAlerts = 0;
    try {
      totalAlerts = await this._count(
        'SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND created_at >= ?',
        [churchId, sinceIso],
      );
    } catch (err) {
      // alerts table might not exist
      console.debug('[lifecycleEmails _gatherWeeklyStats] alerts query:', err?.message);
    }

    // Session count from service_sessions table
    let totalSessions = 0;
    try {
      totalSessions = await this._count(
        'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != \'test\')',
        [churchId, sinceIso],
      );
    } catch (err) {
      // service_sessions table might not exist
      console.debug('[lifecycleEmails _gatherWeeklyStats] service_sessions query:', err?.message);
    }

    // Fallback: if no formal sessions but events exist, estimate from distinct event dates
    if (totalSessions === 0 && totalEvents > 0) {
      try {
        totalSessions = await this._count(
          "SELECT COUNT(DISTINCT date(timestamp)) as cnt FROM service_events WHERE church_id = ? AND timestamp >= ? AND event_type NOT LIKE 'incident_summary_%'",
          [churchId, sinceIso],
        );
      } catch (err) {
        // ignore — best-effort estimate
        console.debug('[lifecycleEmails _gatherWeeklyStats] estimate sessions from events:', err?.message);
      }
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
    const downloadUrl = DOWNLOAD_MAC_URL;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your booth computer isn't connected yet</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We haven't seen your booth computer connect for <strong>${church.name}</strong> yet &mdash;
        and your trial clock is ticking. Setup takes about 5 minutes, and our AI assistant handles most of it:
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
        You've had Tally at <strong>${church.name}</strong> for about 5 days now.
        I'd love to hear how your first Sunday went &mdash; or what's on your mind before the next one.
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
        Hit reply and let us know how it's going &mdash; every response goes straight to our team.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `How's Tally working for you?

You've had Tally at ${church.name} for about 5 days now. I'd love to hear how your first Sunday went — or what's on your mind before the next one.

A few things you might not have tried yet:
- Remote control via Telegram — type "cut to camera 2" or "start recording"
- Pre-service health check — automatic 30-min-before confirmation
- Post-service timeline — see exactly what happened during the service
- Weekly reports — share uptime stats with leadership

Hit reply and let us know how it's going — every response goes straight to our team.

— The Tally Team

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
          <span style="color:#dc2626">&#10007;</span> Real-time monitoring of your ATEM, OBS, encoders, and audio gear<br>
          <span style="color:#dc2626">&#10007;</span> Automatic stream recovery when things go silent mid-service<br>
          <span style="color:#dc2626">&#10007;</span> Telegram alerts to your TD when problems are detected<br>
          <span style="color:#dc2626">&#10007;</span> Pre-service system checks 30 minutes before you go live<br>
          <span style="color:#dc2626">&#10007;</span> AI-powered production assistant in Telegram
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
    const headline = daysLeft <= 3
      ? `3 days left &mdash; don\u2019t lose your safety net this Sunday`
      : `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">${headline}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your free trial for <strong>${this._esc(church.name)}</strong> is almost up.
        When it ends, here's exactly what stops working:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <span style="color:#dc2626">&#10007;</span> Real-time monitoring of your ATEM, OBS, encoders, and audio gear<br>
          <span style="color:#dc2626">&#10007;</span> Automatic stream recovery when things go silent mid-service<br>
          <span style="color:#dc2626">&#10007;</span> Telegram alerts to your TD when problems are detected<br>
          <span style="color:#dc2626">&#10007;</span> Pre-service system checks 30 minutes before you go live<br>
          <span style="color:#dc2626">&#10007;</span> AI-powered production assistant in Telegram
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Sunday morning without Tally means manual checks, silent failures, and scrambling in the booth.
        Subscribe now and keep the safety net in place.
      </p>

      ${this._cta('Keep Tally Running \u2192', billingUrl)}

      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        Plans start at $49/month. Cancel anytime. Your settings and history are preserved &mdash; no reconfiguration needed.
      </p>
    `);

    const text = daysLeft <= 3
      ? `3 days left — don't lose your safety net this Sunday`
      : `Your Tally trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;

    const fullText = `${text}

Your free trial for ${church.name} ends soon. Here's what stops working:

✗ Real-time monitoring of your gear
✗ Automatic stream recovery
✗ Telegram alerts for your TD
✗ Pre-service system checks
✗ AI production assistant

Subscribe at ${billingUrl} to keep Tally running. Plans start at $49/month.

Tally — ${this.appUrl.replace('https://', '')}`;

    return { html, text: fullText };
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
        Your next Sunday is coming up &mdash; and without Tally, you're back to manual checks and hoping nothing breaks.
        Without monitoring, a stream drop goes undetected for an average of 4 minutes before someone notices.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your free trial for <strong>${church.name}</strong> has expired. Tally is no longer monitoring your production gear.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <span style="color:#dc2626">&#10007;</span> No auto-recovery if your stream drops during service<br>
          <span style="color:#dc2626">&#10007;</span> No pre-service health checks<br>
          <span style="color:#dc2626">&#10007;</span> No Telegram alerts or remote control<br>
          <span style="color:#dc2626">&#10007;</span> No weekly reports for leadership
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

Your next Sunday is coming up — and without Tally, you're back to manual checks and hoping nothing breaks.

Your free trial for ${church.name} has expired. Tally is no longer monitoring your production gear.

What you're missing:
✗ No auto-recovery if your stream drops during service
✗ No pre-service health checks
✗ No Telegram alerts or remote control
✗ No weekly reports for leadership

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

    // Generate a contextual insight line
    let insightLine = '';
    if (stats.criticalEvents === 0 && stats.totalSessions > 0) {
      insightLine = `<p style="font-size: 14px; color: #22c55e; font-weight: 600; margin: 0 0 16px;">✓ Clean week &mdash; zero critical issues across ${stats.totalSessions} service${stats.totalSessions !== 1 ? 's' : ''}.</p>`;
    } else if (stats.autoRecoveries > 0 && stats.criticalEvents > 0) {
      const pct = Math.min(100, Math.round((stats.autoRecoveries / stats.totalEvents) * 100));
      insightLine = `<p style="font-size: 14px; color: #eab308; font-weight: 600; margin: 0 0 16px;">Tally auto-handled ${pct}% of issues this week without any manual intervention.</p>`;
    } else if (stats.criticalEvents > 0) {
      insightLine = `<p style="font-size: 14px; color: #ef4444; font-weight: 600; margin: 0 0 16px;">${stats.criticalEvents} critical event${stats.criticalEvents !== 1 ? 's' : ''} required attention this week. Check your portal for the full timeline.</p>`;
    }

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Weekly Report &mdash; ${church.name}</h1>
      ${insightLine}
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

    const text = `Weekly Report — ${church.name}

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
        We're sorry to see you go. Your subscription for <strong>${church.name}</strong> has been cancelled and will remain active until <strong>${endDate}</strong>.
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
    `);

    const text = `Your Tally subscription has been cancelled\n\nWe're sorry to see you go. Your subscription for ${church.name} has been cancelled and will remain active until ${endDate}.\n\nYour data is preserved for 30 days. Reactivate anytime at ${portalUrl}\n\nTally`;

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
    const TIER_UNLOCKED = {
      plus: ['Multi-room monitoring', 'Weekly production digests', 'Extended 90-day session history'],
      pro: ['AutoPilot automation rules', 'Analytics dashboard &amp; trends', 'Priority support &amp; onboarding call'],
      managed: ['Dedicated success manager', 'Custom integrations &amp; SLA', 'Multi-location fleet management'],
    };
    const portalUrl = `${this.appUrl}/portal`;
    const newTierName = TIER_NAMES[newTier] || newTier;
    const oldTierName = TIER_NAMES[oldTier] || oldTier;
    const unlockedFeatures = TIER_UNLOCKED[newTier] || [];
    const unlockedHtml = unlockedFeatures.length
      ? `<div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
          <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">What you just unlocked on ${newTierName}:</div>
          <div style="font-size: 14px; color: #333; line-height: 2;">${unlockedFeatures.map(f => `&bull; ${f}`).join('<br>')}</div>
        </div>`
      : '';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">You're now on ${newTierName}!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has been upgraded from ${oldTierName} to <strong>${newTierName}</strong>. Your new features are available immediately &mdash; no restart needed.
      </p>

      ${unlockedHtml}

      ${this._cta('Get Started with ' + newTierName + ' \u2192', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Your billing has been adjusted with proration. Check your portal for details. Reply if you have any questions.
      </p>
    `);

    const text = `You're now on ${newTierName}!\n\n${church.name} has been upgraded from ${oldTierName} to ${newTierName}.\n\n${unlockedFeatures.length ? 'What you just unlocked:\n' + unlockedFeatures.map(f => `- ${f.replace(/&amp;/g, '&')}`).join('\n') + '\n\n' : ''}Get started: ${portalUrl}`;

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
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally monitoring has stopped</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The 7-day grace period for <strong>${church.name}</strong> has expired. Tally is no longer monitoring your production gear &mdash;
        which means your next service runs without a safety net.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fef2f2; border-radius: 10px; border: 1px solid #fecaca;">
        <div style="font-size: 14px; font-weight: 700; color: #dc2626; margin-bottom: 8px;">While paused, you're missing:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <span style="color:#dc2626">&#10007;</span> Real-time monitoring &mdash; stream drops go undetected<br>
          <span style="color:#dc2626">&#10007;</span> Auto-recovery &mdash; outages require manual intervention<br>
          <span style="color:#dc2626">&#10007;</span> Pre-service checks &mdash; no green light before you go live<br>
          <span style="color:#dc2626">&#10007;</span> Telegram alerts &mdash; your TD is flying blind
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Update your payment method to restore Tally immediately &mdash; it reconnects within seconds.
        Your data is safe for 30 days.
      </p>

      ${this._cta('Update Payment & Restore Now', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        If this happened by mistake (expired card, bank block), just update your card and Tally restores instantly.
        Reply to this email if you need help sorting it out.
      </p>
    `);

    const text = `Tally monitoring has stopped\n\nThe 7-day grace period for ${church.name} has expired. Your next service runs without a safety net.\n\nWhile paused:\n✗ Stream drops go undetected\n✗ No auto-recovery\n✗ No pre-service checks\n✗ No Telegram alerts\n\nUpdate your payment at ${portalUrl} to restore Tally instantly. Your data is safe for 30 days.\n\nIf this was a mistake, just update your card — Tally reconnects within seconds. Reply if you need help.`;

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
        Glad to have you back! &mdash; The Tally Team
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

  // ─── SEQUENCE 13: WIN-BACK (14 days after cancellation) ──────────────────
  // Day 14 is peak win-back window — first missed Sunday reminds them of the pain.

  async _checkWinBack() {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Find churches cancelled 14-30 days ago that haven't resubscribed
    let cancelledChurches = [];
    try {
      cancelledChurches = await this._selectAll(`
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
      `, [fourteenDaysAgo, thirtyDaysAgo]);
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
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">We miss you at Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        It's been about two weeks since <strong>${church.name}</strong> cancelled. You've probably had a Sunday
        or two without Tally by now &mdash; I hope it went well.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        If anything went sideways &mdash; a stream drop, a gear surprise, scrambling in the booth &mdash;
        we'd love to have you back. Your settings are still saved, so reactivation takes seconds.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        And if things went great, we'd genuinely love to know that too. Reply and tell us &mdash; every response goes straight to our team.
      </p>

      ${this._cta('Reactivate Your Account', portalUrl)}

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `We miss you at Tally\n\nIt's been about two weeks since ${church.name} cancelled. If anything went sideways on Sunday without Tally, your settings are still saved — reactivation takes seconds.\n\nReactivate: ${portalUrl}\n\n— The Tally Team`;

    return { html, text };
  }

  // ─── SEQUENCE 8: REVIEW REQUEST ─────────────────────────────────────────────
  // Fires once for happy, paying customers: 30-90 days active, 4+ sessions, 2+ clean.

  async _checkReviewRequest() {
    const minAge = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const maxAge = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
    `, [minAge, maxAge]);

    for (const church of churches) {
      // Check session quality
      let sessionCount = 0, cleanCount = 0;
      try {
        sessionCount = await this._count(
          'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND (session_type IS NULL OR session_type != \'test\')',
          [church.churchId],
        );
        cleanCount = await this._count(
          "SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND grade LIKE '%Clean%' AND (session_type IS NULL OR session_type != 'test')",
          [church.churchId],
        );
      } catch { continue; }

      if (sessionCount < 4 || cleanCount < 2) continue;

      // Skip if review already submitted
      try {
        const existing = await this._selectOne(
          'SELECT 1 FROM church_reviews WHERE church_id = ?',
          [church.churchId],
        );
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

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `You're one of our top churches

${church.name} has run ${stats.sessionCount} services with Tally, and ${stats.cleanCount} of them were completely clean — zero issues. That's impressive.

Would you take 60 seconds to share your experience?
Your review helps other church production teams discover Tally.

Leave a review: ${portalUrl}

You can also post on Google, Capterra, or G2.

— The Tally Team

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
    const downloadUrl = DOWNLOAD_MAC_URL;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Sunday production safety net starts here</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has been registered and your 30-day free trial is active.
        Check your inbox for a verification email, then follow these steps to get Tally running:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Quick start:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1.</strong> <a href="${downloadUrl}" style="color: #22c55e; text-decoration: none;">Download the Tally app</a> on your booth computer<br>
          <strong>2.</strong> Sign in with your registration code<br>
          <strong>3.</strong> Our AI setup assistant will walk you through the rest &mdash; just tell it about your gear, service times, and team in a quick conversation
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

    const text = `Your Sunday production safety net starts here\n\n${church.name} has been registered and your 30-day free trial is active.\n\nQuick start:\n1. Download the Tally app: ${downloadUrl}\n2. Sign in with your registration code\n3. Our AI setup assistant walks you through the rest — just tell it about your gear and service times\n\nOpen your portal: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

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
      churches = await this._selectAll(`
        SELECT c.churchId, c.name, c.portal_email, bc.grace_period_ends_at
        FROM churches c
        JOIN billing_customers bc ON bc.church_id = c.churchId
        WHERE c.portal_email IS NOT NULL
          AND c.billing_status = 'past_due'
          AND bc.grace_period_ends_at IS NOT NULL
          AND bc.grace_period_ends_at <= ?
          AND bc.grace_period_ends_at > ?
      `, [twoDaysFromNow, new Date(now).toISOString()]);
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

    // Calculate days until Sunday for urgency framing
    const today = new Date();
    const daysToSunday = (7 - today.getDay()) % 7 || 7;
    const sundayNote = daysToSunday <= daysLeft
      ? `<p style="font-size: 15px; color: #dc2626; font-weight: 600; line-height: 1.6;">Sunday is in ${daysToSunday} day${daysToSunday !== 1 ? 's' : ''} &mdash; if this isn't resolved by then, Tally won't be monitoring your service.</p>`
      : '';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your grace period ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        We still haven't been able to process payment for <strong>${church.name}</strong>.
        If not resolved in the next ${daysLeft} day${daysLeft !== 1 ? 's' : ''}, Tally will be paused.
      </p>

      ${sundayNote}

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

      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        If your card expired or your bank blocked the charge, updating takes 30 seconds and Tally continues automatically.
      </p>
    `);

    const text = `Your grace period ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}\n\nWe still can't process payment for ${church.name}. Update your payment at ${portalUrl} to avoid service interruption.\n\nSunday is in ${daysToSunday} days — resolve this before then to keep Tally monitoring your service.\n\nTally`;
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
    await this.ready;
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
      this._recordSend(church.churchId, 'email-change-confirmation', to, new Date().toISOString(), data.id, 'Your Tally email has been updated');
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
        ${alerts === 0 && recoveries === 0
          ? `No issues detected. Zero. Your production gear ran perfectly for ${duration} minutes &mdash; that's exactly what Tally is here for. Share this with your team.`
          : alerts === 0
            ? `Everything ran smoothly. Tally auto-handled ${recoveries} recovery${recoveries !== 1 ? 's' : ''} silently &mdash; no manual intervention needed.`
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
    await this.ready;
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
          subject: `URGENT: ${alertType} at ${church.name}`,
          html, text,
          tags: [{ name: 'category', value: 'urgent-alert-escalation' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { const err = await res.text(); console.error(`[LifecycleEmails] Urgent alert email failed: ${err}`); return { sent: false, reason: 'resend-error' }; }
      const data = await res.json();
      this._recordSend(church.churchId, `urgent-alert-${alertId || Date.now()}`, to, new Date().toISOString(), data.id, `URGENT: ${alertType} at ${church.name}`);
      return { sent: true, id: data.id };
    } catch (e) { return { sent: false, reason: 'network-error' }; }
  }

  _buildUrgentAlertEmail(church, { alertType, context }) {
    const portalUrl = `${this.appUrl}/portal`;

    // Format context as table rows rather than JSON dump
    let contextRows = '';
    if (context && typeof context === 'object') {
      contextRows = Object.entries(context)
        .map(([k, v]) => `<tr><td style="padding: 4px 0; color: #64748b;">${this._esc(k)}</td><td style="text-align: right; font-weight: 600;">${this._esc(String(v))}</td></tr>`)
        .join('');
    } else if (context) {
      contextRows = `<tr><td colspan="2" style="padding: 4px 0; color: #333;">${this._esc(String(context))}</td></tr>`;
    }

    const html = this._wrap(`
      <div style="margin: 0 0 24px; padding: 16px 20px; background: #fef2f2; border-radius: 10px; border: 2px solid #ef4444;">
        
        <strong style="font-size: 16px; color: #dc2626; margin-left: 8px;">CRITICAL ALERT — No Response</strong>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        A critical alert at <strong>${church.name}</strong> has gone unacknowledged for 90 seconds.
        The technical director has not responded via Telegram.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0;">
        <table style="width: 100%; font-size: 14px; color: #333;">
          <tr><td style="padding: 4px 0; color: #64748b;">Alert type</td><td style="text-align: right; font-weight: 700;">${this._esc(alertType || 'Unknown')}</td></tr>
          <tr><td style="padding: 4px 0; color: #64748b;">Church</td><td style="text-align: right; font-weight: 700;">${this._esc(church.name)}</td></tr>
          ${contextRows}
        </table>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        This email is a backup notification. Please check the portal for current status.
      </p>

      ${this._cta('View Alert Status', portalUrl)}
    `);

    const text = `CRITICAL ALERT — No Response\n\nAlert: ${alertType} at ${church.name}\nNo TD acknowledgment after 90 seconds.\n\nCheck status: ${portalUrl}\n\nTally`;
    return { html, text };
  }

  // ─── SEQUENCE 26: CANCELLATION FEEDBACK SURVEY ──────────────────────────
  // Hourly check: 3 days after cancellation, asks for feedback.

  async _checkCancellationSurvey() {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
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
      `, [threeDaysAgo, tenDaysAgo]);
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
        Hi &mdash; it's the Tally team. Since <strong>${church.name}</strong> cancelled a few days ago,
        we wanted to ask: <strong>what could we have done better?</strong>
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
        Just hit reply and let us know. Even one sentence helps &mdash; every response goes straight to our team
        and helps us make Tally better for everyone.
      </p>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        And of course, if you ever want to come back, your data and settings are saved for 30 days.
        Just log in at <a href="${this.appUrl}/portal" style="color: #22c55e; text-decoration: none;">your portal</a>.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `We'd love your honest feedback\n\n${church.name} cancelled a few days ago. What could we have done better?\n\n- Pricing?\n- Features?\n- Reliability?\n- Fit?\n- Something else?\n\nJust reply to this email — every response goes straight to our team.\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── LEAD NURTURE DRIP SEQUENCE ─────────────────────────────────────────
  // Captures leads and sends a 4-email drip over 14 days.

  /** Capture a new sales lead. Returns the lead row. */
  captureLead({ email, name, source, churchName }) {
    if (!email) return null;
    const now = new Date().toISOString();
    if (this.queryClient) {
      const lead = {
        id: this._cache.salesLeadsByEmail.get(email)?.id || null,
        email,
        name: name || null,
        church_name: churchName || null,
        source: source || 'website',
        captured_at: now,
        status: 'active',
      };
      this._cacheLead(lead);
      void this._queueWrite(() => this._run(
        'INSERT OR IGNORE INTO sales_leads (email, name, church_name, source, captured_at) VALUES (?, ?, ?, ?, ?)',
        [email, name || null, churchName || null, source || 'website', now],
      ));
      return lead;
    }
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
        leads = await this._selectAll(
          'SELECT * FROM sales_leads WHERE status = ? AND captured_at <= ? AND captured_at >= ?',
          ['active', maxCapturedAt, minCapturedAt],
        );
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
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Every Sunday, something breaks in the booth</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hey ${name} &mdash; every church production team knows this feeling: the stream drops mid-sermon,
        nobody catches it for 4 minutes, and by the time someone scrambles to fix it, the online audience
        is gone. We built Tally to fix that &mdash; automatically.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally watches your production gear 24/7 and handles problems before your congregation notices:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; <strong>Auto-recovers</strong> dropped streams before anyone notices<br>
          &bull; <strong>Pre-service checks</strong> 30 minutes before service starts<br>
          &bull; <strong>Real-time alerts</strong> to your tech director via Telegram<br>
          &bull; <strong>Weekly reports</strong> for church leadership
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        30-day free trial, full access, no credit card required.
      </p>

      ${this._cta('Start Your Free Trial', signupUrl)}

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `Every Sunday, something breaks in the booth\n\nHey ${name} — every church production team knows this: the stream drops mid-sermon, nobody catches it for 4 minutes, and the online audience is gone. We built Tally to fix that — automatically.\n\n- Auto-recovers dropped streams before anyone notices\n- Pre-service health checks 30 min before service\n- Real-time alerts via Telegram\n- Weekly reports for leadership\n\n30-day free trial, no credit card: ${signupUrl}\n\n— The Tally Team`;
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
        &mdash; The Tally Team
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
          &bull; 30 days of full access, no credit card needed<br>
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
        &mdash; The Tally Team
      </p>
    `);

    const text = `Ready to try Tally?\n\n30 days free, no credit card, 10-minute setup.\n\nStart your trial: ${signupUrl}\n\nThis is the last email in this series. Visit tallyconnect.app/signup anytime.\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── SEQUENCE 15: WELCOME EMAIL (after email verification) ───────────────

  async sendWelcomeVerified(church) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };

    const portalUrl = `${this.appUrl}/portal`;
    const downloadUrl = DOWNLOAD_MAC_URL;

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

    // Tier-specific feature highlights
    const TIER_FEATURES = {
      connect: ['24/7 real-time monitoring &amp; auto-recovery', 'Pre-service health checks', 'Telegram alerts &amp; remote control', 'Session timelines &amp; reports'],
      plus: ['Everything in Connect', 'Multi-room monitoring', 'Weekly production digests', 'Extended session history'],
      pro: ['Everything in Plus', 'AutoPilot automation rules', 'Analytics dashboard', 'Priority support &amp; onboarding'],
      managed: ['Everything in Pro', 'Dedicated success manager', 'Custom integrations &amp; SLA', 'Multi-location fleet management'],
      event: ['Single-event monitoring pass', 'Real-time alerts &amp; auto-recovery', 'Post-event recap report'],
    };
    const tierFeatures = TIER_FEATURES[tier] || TIER_FEATURES.connect;
    const featureList = tierFeatures.map(f => `&bull; ${f}`).join('<br>');

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Welcome to ${tierName} &mdash; you're all set!</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Thanks for subscribing! <strong>${church.name}</strong> is now on the <strong>${tierName}</strong> plan${interval === 'annual' ? ' (annual)' : ''}.
        You're joining hundreds of church production teams who now spend Sunday morning watching the service, not fighting it.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">What's included on ${tierName}:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">${featureList}</div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        You can manage your subscription, view invoices, and update payment details from your Church Portal.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Thank you for trusting Tally with your production. Reply to this email anytime &mdash; we're here if you need anything.
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
    await this.ready;
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
      this._recordSend(church.churchId, 'password-reset', church.portal_email, new Date().toISOString(), data.id, 'Reset your Tally password');
      return { sent: true, id: data.id };
    } catch (e) {
      console.error(`[LifecycleEmails] Password reset send failed: ${e.message}`);
      return { sent: false, reason: 'network-error' };
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // NEW EMAILS — all 13 gaps from EMAIL_AUDIT.md
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── GAP 1: EARLY WIN-BACK (Day 7-14 post-cancel) ─────────────────────────
  // Team-signed, no feature list, empathy + reactivate link.

  async _checkEarlyWinBack() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
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
      `, [sevenDaysAgo, fourteenDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      const { html, text } = this._buildEarlyWinBackEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'early-win-back',
        to: church.portal_email,
        subject: "How'd Sunday go without Tally?",
        html, text,
      });
    }
  }

  _buildEarlyWinBackEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">How'd Sunday go?</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        It's the Tally team. <strong>${church.name}</strong> cancelled about a week ago,
        which means you've had at least one Sunday without monitoring by now.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        I'm not going to pitch you anything &mdash; I'm just genuinely curious how it went.
        If everything was fine, that's great to know. If anything went sideways &mdash; a stream drop,
        a gear issue nobody caught in time &mdash; your settings are still saved and you can reactivate in seconds.
      </p>

      ${this._cta('Reactivate Tally', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Or just reply and tell me how Sunday went. I read every response.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `How'd Sunday go?\n\nIt's the Tally team. ${church.name} cancelled about a week ago, which means you've had at least one Sunday without monitoring.\n\nIf anything went sideways, your settings are still saved and you can reactivate in seconds: ${portalUrl}\n\nOr just reply and tell us how it went.\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── GAP 2: ACTIVATION ESCALATION (Day 10, never connected) ───────────────
  // List 3 common blockers, invite reply.

  async _checkActivationEscalation() {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE onboarding_app_connected_at IS NULL
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
        AND billing_status IN ('trialing', 'active')
    `, [tenDaysAgo, fourteenDaysAgo]);

    for (const church of churches) {
      const { html, text } = this._buildActivationEscalationEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'activation-escalation',
        to: church.portal_email,
        subject: "Your Tally setup isn't complete \u2014 want us to help?",
        html, text,
      });
    }
  }

  _buildActivationEscalationEmail(church) {
    const downloadUrl = DOWNLOAD_MAC_URL;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your setup isn't complete yet</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Your trial at <strong>${church.name}</strong> is almost over and we still haven't seen your booth computer connect.
        That means Tally hasn't been able to monitor anything yet.
      </p>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        The most common reasons setup gets stuck:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a;">
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1. The app downloaded but didn't run</strong> &mdash; look for Tally in your Applications folder and double-click it<br>
          <strong>2. Registration code wasn't accepted</strong> &mdash; check your original signup email for the code, or reply and we'll resend it<br>
          <strong>3. Firewall is blocking the connection</strong> &mdash; Tally needs outbound access to api.tallyconnect.app on port 443
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>Reply to this email</strong> with your setup question and our team will help you through it.
        Or download the app again and try the setup assistant fresh:
      </p>

      ${this._cta('Download Tally', downloadUrl)}

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `Your setup isn't complete yet\n\nYour trial at ${church.name} is almost over and we haven't seen your booth computer connect yet.\n\nCommon blockers:\n1. App downloaded but didn't run — look in Applications and double-click Tally\n2. Registration code not accepted — reply and we'll resend it\n3. Firewall blocking the connection — Tally needs outbound port 443\n\nReply to this email with your question — our team will help. Or try again: ${downloadUrl}\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── GAP 3: PRE-SERVICE FRIDAY EMAIL (48h before first scheduled service) ──
  // Checklist format, contextual timing.

  async _checkPreServiceFriday() {
    const in48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    let upcomingServices = [];
    try {
      upcomingServices = await this._selectAll(`
        SELECT ss.church_id, ss.service_time, c.name, c.portal_email, c.churchId
        FROM service_schedules ss
        JOIN churches c ON c.churchId = ss.church_id
        WHERE ss.service_time >= ?
          AND ss.service_time <= ?
          AND c.portal_email IS NOT NULL
          AND c.billing_status IN ('trialing', 'active')
          AND c.onboarding_app_connected_at IS NOT NULL
      `, [in24h, in48h]);
    } catch { return; } // service_schedules may not exist

    for (const svc of upcomingServices) {
      const church = { churchId: svc.churchId, name: svc.name, portal_email: svc.portal_email };
      const serviceTime = new Date(svc.service_time);
      const { html, text } = this._buildPreServiceFridayEmail(church, serviceTime);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: `pre-service-friday-${svc.service_time}`,
        to: church.portal_email,
        subject: 'Two days to Sunday \u2014 Tally is watching',
        html, text,
      });
    }
  }

  _buildPreServiceFridayEmail(church, serviceTime) {
    const portalUrl = `${this.appUrl}/portal`;
    const serviceLabel = serviceTime
      ? serviceTime.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) +
        ' at ' + serviceTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : 'your upcoming service';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Two days to Sunday &mdash; you're ready</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally has <strong>${serviceLabel}</strong> on the schedule for <strong>${church.name}</strong>.
        Here's your pre-service checklist:
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; color: #333; line-height: 2.5;">
          <span style="color:#22c55e">&#10003;</span> Tally is monitoring your gear continuously<br>
          <span style="color:#22c55e">&#10003;</span> Automatic pre-flight check runs 30 min before service<br>
          <span style="color:#22c55e">&#10003;</span> Stream recovery is armed and ready<br>
          ☐ Telegram alerts set up? <a href="${portalUrl}" style="color: #22c55e; text-decoration: none;">Configure now →</a><br>
          ☐ Leadership recipients set? <a href="${portalUrl}" style="color: #22c55e; text-decoration: none;">Add them →</a>
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        On Sunday morning, you'll get a green-light confirmation (or a specific issue list) 30 minutes before service.
        After service, you'll get a session recap with grades, timeline, and stats.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}
    `);

    const text = `Two days to Sunday — you're ready\n\nTally has ${serviceLabel} on the schedule for ${church.name}.\n\nPre-service checklist:\n[x] Tally monitoring your gear\n[x] Pre-flight check runs 30 min before\n[x] Stream recovery armed\n[ ] Telegram alerts set up? ${portalUrl}\n[ ] Leadership recipients set? ${portalUrl}\n\nYou'll get a green-light confirmation 30 min before service starts.\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── GAP 4: TRIAL-TO-PAID ONBOARDING (24h after first payment) ────────────
  // Tier-specific features they haven't activated yet.

  async _checkTrialToPaidOnboarding() {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT c.churchId, c.name, c.portal_email, c.billing_tier, bc.subscribed_at
        FROM churches c
        JOIN billing_customers bc ON bc.church_id = c.churchId
        WHERE c.billing_status = 'active'
          AND c.portal_email IS NOT NULL
          AND bc.subscribed_at IS NOT NULL
          AND bc.subscribed_at <= ?
          AND bc.subscribed_at >= ?
      `, [oneDayAgo, twoDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      const { html, text } = this._buildTrialToPaidOnboardingEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'trial-to-paid-onboarding',
        to: church.portal_email,
        subject: `3 things to configure now that you're on ${this._tierName(church.billing_tier)}`,
        html, text,
      });
    }
  }

  _tierName(tier) {
    return { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise' }[tier] || tier || 'your plan';
  }

  _buildTrialToPaidOnboardingEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    const tierName = this._tierName(church.billing_tier);

    const TIER_ACTIONS = {
      connect: [
        ['Set your service schedule', 'Tally needs to know when your services are to run pre-flight checks. Takes 2 minutes.', portalUrl + '#schedule'],
        ['Add your tech director to Telegram alerts', 'This is how Tally reaches your TD in real-time. Critical for auto-recovery.', portalUrl + '#notifications'],
        ['Invite leadership to receive reports', 'Send weekly digests to your pastor or executive team automatically.', portalUrl + '#tds'],
      ],
      plus: [
        ['Add your other rooms', 'Plus supports multi-room — add each location so Tally monitors them all.', portalUrl + '#rooms'],
        ['Set your service schedule for each room', 'Each room can have its own service times and alert recipients.', portalUrl + '#schedule'],
        ['Set up Telegram for each room\'s TD', 'Each room TD should have their own Telegram alert channel.', portalUrl + '#notifications'],
      ],
      pro: [
        ['Set up your first AutoPilot rule', 'Pro includes automation — try "auto-start recording when service begins."', portalUrl + '#autopilot'],
        ['Schedule your onboarding call', 'Pro includes a personal onboarding session. Reply to this email to schedule.', 'mailto:support@tallyconnect.app'],
        ['Configure analytics recipients', 'Your analytics dashboard is ready — share it with leadership.', portalUrl + '#analytics'],
      ],
      managed: [
        ['Reach out to your success manager', 'Your dedicated success manager will contact you within 24 hours to schedule setup.', 'mailto:support@tallyconnect.app'],
        ['Add all rooms &amp; locations', 'Enterprise supports unlimited rooms — add them all and assign TDs.', portalUrl + '#rooms'],
        ['Review your SLA and support channels', 'Your Enterprise SLA includes priority escalation. Review it in your portal.', portalUrl + '#billing'],
      ],
    };

    const actions = TIER_ACTIONS[church.billing_tier] || TIER_ACTIONS.connect;
    const actionItems = actions.map(([title, desc, url], i) => `
      <div style="padding: 16px 20px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; margin-bottom: 10px;">
        <strong style="font-size: 14px; color: #111;">${i + 1}. ${title}</strong>
        <p style="font-size: 13px; color: #555; margin: 4px 0 8px;">${desc}</p>
        <a href="${url}" style="font-size: 13px; color: #22c55e; text-decoration: none; font-weight: 600;">Do this now →</a>
      </div>`).join('');

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Welcome to ${tierName} &mdash; 3 things to set up today</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> is now a paying subscriber &mdash; thank you.
        Here are the three highest-impact things to configure on ${tierName}:
      </p>

      <div style="margin: 24px 0;">${actionItems}</div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Each of these takes under 5 minutes and dramatically increases how much Tally can do for you.
      </p>

      ${this._cta('Open Your Portal', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions? Reply to this email &mdash; happy to help.
      </p>
    `);

    const text = `Welcome to ${tierName} — 3 things to set up today\n\n${church.name} is now a paying subscriber. Here are the three highest-impact things to configure:\n\n${actions.map(([t], i) => `${i + 1}. ${t}`).join('\n')}\n\nOpen your portal: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── GAP 5: MONTHLY ROI SUMMARY ────────────────────────────────────────────
  // Human-readable ROI narrative for the portal owner (separate from leadership report).

  async sendMonthlyROISummary(church, reportData) {
    if (!church.portal_email) return { sent: false, reason: 'no-recipient' };
    const month = reportData.month || new Date().toISOString().slice(0, 7);
    const { html, text } = this._buildMonthlyROISummaryEmail(church, reportData);
    return this.sendEmail({
      churchId: church.churchId,
      emailType: `monthly-roi-summary-${month}`,
      to: church.portal_email,
      subject: `${reportData.monthLabel || month} at ${church.name} \u2014 here's what Tally prevented`,
      html, text,
    });
  }

  _buildMonthlyROISummaryEmail(church, reportData) {
    const portalUrl = `${this.appUrl}/portal`;
    const autoRecovered = reportData.autoRecovered || 0;
    const alertsTriggered = reportData.alertsTriggered || 0;
    const servicesMonitored = reportData.servicesMonitored || 0;
    const monthLabel = reportData.monthLabel || reportData.month || 'This month';
    // Estimate minutes saved: each auto-recovery prevents ~4 min of undetected outage
    const minutesSaved = autoRecovered * 4;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">${this._esc(monthLabel)} in review &mdash; here's what Tally prevented</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally monitored <strong>${servicesMonitored} service${servicesMonitored !== 1 ? 's' : ''}</strong> at
        <strong>${church.name}</strong> last month. Here's the ROI in plain English:
      </p>

      <div style="margin: 24px 0; padding: 24px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0; text-align: center;">
        <div style="font-size: 36px; font-weight: 800; color: #15803d;">${autoRecovered}</div>
        <div style="font-size: 15px; color: #333; margin-top: 4px;">issue${autoRecovered !== 1 ? 's' : ''} auto-resolved by Tally</div>
        ${minutesSaved > 0 ? `<div style="font-size: 14px; color: #64748b; margin-top: 8px;">That's ~${minutesSaved} minutes of undetected downtime prevented</div>` : ''}
      </div>

      ${autoRecovered > 0
        ? `<p style="font-size: 15px; color: #333; line-height: 1.6;">
            ${autoRecovered} Sunday moment${autoRecovered !== 1 ? 's' : ''} your congregation never saw. Each auto-recovery happens silently &mdash;
            your stream drops, Tally restarts it in under 5 seconds, and your online audience never notices.
          </p>`
        : `<p style="font-size: 15px; color: #22c55e; font-weight: 600; line-height: 1.6;">
            Clean month &mdash; no issues required intervention. Tally watched ${servicesMonitored} service${servicesMonitored !== 1 ? 's' : ''} without a problem.
          </p>`}

      ${alertsTriggered > 0 ? `<p style="font-size: 14px; color: #555; line-height: 1.6;">
        Tally also flagged ${alertsTriggered} alert${alertsTriggered !== 1 ? 's' : ''} that required attention &mdash;
        issues that might have gone unnoticed without monitoring.
      </p>` : ''}

      ${this._cta('View Full Monthly Report', portalUrl)}
    `);

    const text = `${monthLabel} in review — here's what Tally prevented\n\n${church.name}: ${servicesMonitored} services monitored, ${autoRecovered} issues auto-resolved${minutesSaved > 0 ? `, ~${minutesSaved} minutes of downtime prevented` : ''}.\n\n${autoRecovered > 0 ? `${autoRecovered} Sunday moments your congregation never saw.` : 'Clean month — no issues required intervention.'}\n\nView report: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── GAP 6: ANNUAL RENEWAL REMINDER (30 days before annual renewal) ─────────

  async _checkAnnualRenewalReminder() {
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const twentyEightDaysFromNow = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT c.churchId, c.name, c.portal_email, c.billing_tier, bc.current_period_end
        FROM churches c
        JOIN billing_customers bc ON bc.church_id = c.churchId
        WHERE c.billing_status = 'active'
          AND c.billing_interval = 'annual'
          AND c.portal_email IS NOT NULL
          AND bc.current_period_end IS NOT NULL
          AND bc.current_period_end <= ?
          AND bc.current_period_end >= ?
      `, [thirtyDaysFromNow, twentyEightDaysFromNow]);
    } catch { return; }

    for (const church of churches) {
      const { html, text } = await this._buildAnnualRenewalReminderEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: `annual-renewal-reminder-${church.current_period_end?.slice(0, 10) || 'unknown'}`,
        to: church.portal_email,
        subject: `Your annual Tally subscription renews in 30 days`,
        html, text,
      });
    }
  }

  _renderAnnualRenewalReminderEmail(church, yearStats = null) {
    const portalUrl = `${this.appUrl}/portal`;
    const tierName = this._tierName(church.billing_tier);
    const renewalDate = church.current_period_end
      ? new Date(church.current_period_end).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '30 days from now';

    const statsHtml = yearStats && (yearStats.sessions > 0 || yearStats.autoFixed > 0) ? `
      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">Your year with Tally:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; <strong>${yearStats.sessions}</strong> service${yearStats.sessions !== 1 ? 's' : ''} monitored<br>
          ${yearStats.autoFixed > 0 ? `&bull; <strong>${yearStats.autoFixed}</strong> issue${yearStats.autoFixed !== 1 ? 's' : ''} auto-resolved before anyone noticed` : ''}
        </div>
      </div>` : '';

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your annual Tally subscription renews in 30 days</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Thanks for a great year with <strong>${church.name}</strong> on ${tierName}.
        Your annual subscription renews on <strong>${renewalDate}</strong> &mdash; no action needed unless you'd like to make changes.
      </p>

      ${statsHtml}

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        View your billing details, update your payment method, or manage your plan from your portal:
      </p>

      ${this._cta('View Billing Details', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions about renewal? Reply to this email &mdash; happy to help.
      </p>
    `);

    const text = `Your annual Tally subscription renews in 30 days\n\nThanks for a great year, ${church.name}! Your ${tierName} subscription renews on ${renewalDate}.\n\n${yearStats ? `Year in review: ${yearStats.sessions} services monitored, ${yearStats.autoFixed} auto-resolved.\n\n` : ''}View billing: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  async _buildAnnualRenewalReminderEmail(church) {
    let yearStats = null;
    try {
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const sessions = await this._count('SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != \'test\')', [church.churchId, yearAgo]);
      const autoFixed = await this._count("SELECT COUNT(*) as cnt FROM service_events WHERE church_id = ? AND auto_resolved = 1 AND timestamp >= ?", [church.churchId, yearAgo]);
      yearStats = { sessions, autoFixed };
    } catch { /* tables may not exist */ }

    return this._renderAnnualRenewalReminderEmail(church, yearStats);
  }

  // ─── GAP 7: TELEGRAM NOT SET UP NUDGE (Day 5 if no Telegram) ────────────────

  async _checkTelegramSetupNudge() {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT churchId, name, portal_email
        FROM churches
        WHERE portal_email IS NOT NULL
          AND onboarding_app_connected_at IS NOT NULL
          AND (telegram_chat_id IS NULL OR telegram_chat_id = '')
          AND registeredAt <= ?
          AND registeredAt >= ?
          AND billing_status IN ('trialing', 'active')
      `, [fiveDaysAgo, tenDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      const { html, text } = this._buildTelegramSetupNudgeEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'telegram-setup-nudge',
        to: church.portal_email,
        subject: "You're missing the best part of Tally",
        html, text,
      });
    }
  }

  _buildTelegramSetupNudgeEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">You're missing the best part of Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> is connected and monitoring &mdash; great.
        But without Telegram set up, your technical director isn't getting real-time alerts.
        That means issues are caught, but nobody's being notified.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Set up Telegram in 3 minutes:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1.</strong> Download Telegram on your TD's phone (free)<br>
          <strong>2.</strong> Search for <strong>@TallyConnectBot</strong> in Telegram<br>
          <strong>3.</strong> Start the bot and paste in your church ID
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Once connected, your TD gets instant alerts on their phone when something breaks &mdash;
        with a one-tap command to auto-fix it. No more checking the booth computer every few minutes.
      </p>

      ${this._cta('Set Up Telegram Alerts', portalUrl + '#notifications')}
    `);

    const text = `You're missing the best part of Tally\n\n${church.name} is connected but Telegram isn't set up — so nobody's getting real-time alerts.\n\nSet up in 3 minutes:\n1. Download Telegram (free)\n2. Search @TallyConnectBot\n3. Start the bot and paste your church ID\n\nSet up now: ${portalUrl}#notifications\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── GAP 8: NPS SURVEY (Day 60 for all active customers) ───────────────────

  async _checkNPSSurvey() {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const sixtyFiveDaysAgo = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
    `, [sixtyDaysAgo, sixtyFiveDaysAgo]);

    for (const church of churches) {
      const { html, text } = this._buildNPSSurveyEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'nps-survey',
        to: church.portal_email,
        subject: 'Quick question \u2014 how likely are you to recommend Tally?',
        html, text,
      });
    }
  }

  _buildNPSSurveyEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    // Build clickable 1-10 score row
    const scores = Array.from({ length: 10 }, (_, i) => i + 1);
    const scoreLinks = scores.map(n => `<a href="${this.appUrl}/nps?church=${church.churchId}&score=${n}" style="display:inline-block; width:36px; height:36px; line-height:36px; text-align:center; border-radius:6px; background:${n <= 6 ? '#fef2f2' : n <= 8 ? '#fffbeb' : '#f0fdf4'}; border:1px solid ${n <= 6 ? '#fecaca' : n <= 8 ? '#fde68a' : '#bbf7d0'}; color:#111; text-decoration:none; font-weight:700; font-size:13px; margin:2px;">${n}</a>`).join('');

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Quick question &mdash; 30 seconds</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Hey &mdash; <strong>${church.name}</strong> has been running Tally for about 60 days now.
        I have one question:
      </p>

      <div style="margin: 24px 0; padding: 24px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; text-align: center;">
        <p style="font-size: 16px; font-weight: 700; color: #111; margin: 0 0 16px;">
          How likely are you to recommend Tally to another church production team?
        </p>
        <div style="margin: 16px 0;">${scoreLinks}</div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; margin-top: 8px;">
          <span>Not likely</span><span>Very likely</span>
        </div>
      </div>

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Or just reply to this email with your score and any comments &mdash; every response goes straight to our team.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `Quick question — how likely are you to recommend Tally?\n\n${church.name} has been running Tally for about 60 days. How likely are you to recommend us to another church production team?\n\nScore 1-10: just reply with your number and any comments.\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── GAP 9: FIRST YEAR ANNIVERSARY ─────────────────────────────────────────

  async _checkFirstYearAnniversary() {
    const threeSixtyFiveDaysAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const threeSixtyEightDaysAgo = new Date(Date.now() - 368 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email, billing_tier
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
    `, [threeSixtyFiveDaysAgo, threeSixtyEightDaysAgo]);

    for (const church of churches) {
      const { html, text } = await this._buildFirstYearAnniversaryEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'first-year-anniversary',
        to: church.portal_email,
        subject: `${church.name} just completed one year with Tally`,
        html, text,
      });
    }
  }

  _renderFirstYearAnniversaryEmail(church, yearStats = { sessions: 0, autoFixed: 0 }) {
    const portalUrl = `${this.appUrl}/portal`;
    const tierName = this._tierName(church.billing_tier);

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">One year with Tally</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> just hit one year on the ${tierName} plan. That's 52 Sundays with Tally watching your gear &mdash; thank you for your trust.
      </p>

      ${yearStats.sessions > 0 ? `
      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">Your year in numbers:</div>
        <div style="font-size: 14px; color: #333; line-height: 2;">
          &bull; <strong>${yearStats.sessions}</strong> service${yearStats.sessions !== 1 ? 's' : ''} monitored<br>
          ${yearStats.autoFixed > 0 ? `&bull; <strong>${yearStats.autoFixed}</strong> issue${yearStats.autoFixed !== 1 ? 's' : ''} auto-resolved — moments your congregation never saw` : '&bull; No critical issues this year &mdash; remarkable run'}
        </div>
      </div>` : ''}

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        If you know another church production team dealing with stream drops or gear surprises on Sunday morning &mdash;
        we'd love an introduction. You can send them to <a href="${this.appUrl}/signup" style="color: #22c55e; text-decoration: none;">tallyconnect.app/signup</a>
        and mention your church name for a referral credit.
      </p>

      ${this._cta('View Your Year in the Portal', portalUrl)}

      <p style="font-size: 14px; color: #666;">
        Grateful for you. &mdash; The Tally Team
      </p>
    `);

    const text = `One year with Tally!\n\n${church.name} just hit one year on ${tierName}. Thank you for your trust.\n\n${yearStats.sessions > 0 ? `Year in numbers: ${yearStats.sessions} services monitored, ${yearStats.autoFixed} auto-resolved.\n\n` : ''}Know another church dealing with stream issues? Send them to tallyconnect.app/signup and mention your church name for a referral credit.\n\nView your year: ${portalUrl}\n\n— The Tally Team`;
    return { html, text };
  }

  async _buildFirstYearAnniversaryEmail(church) {
    let yearStats = { sessions: 0, autoFixed: 0 };
    try {
      const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const sessions = await this._count('SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != \'test\')', [church.churchId, yearAgo]);
      const autoFixed = await this._count("SELECT COUNT(*) as cnt FROM service_events WHERE church_id = ? AND auto_resolved = 1 AND timestamp >= ?", [church.churchId, yearAgo]);
      yearStats = { sessions, autoFixed };
    } catch { /* tables may not exist */ }

    return this._renderFirstYearAnniversaryEmail(church, yearStats);
  }

  // ─── GAP 10: REFERRAL PROGRAM INVITE (Day 90, 4+ sessions) ────────────────

  async _checkReferralInvite() {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const ninetyFiveDaysAgo = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND registeredAt <= ?
        AND registeredAt >= ?
    `, [ninetyDaysAgo, ninetyFiveDaysAgo]);

    for (const church of churches) {
      // Need 4+ sessions
      let sessionCount = 0;
      try {
        sessionCount = await this._count('SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND (session_type IS NULL OR session_type != \'test\')', [church.churchId]);
      } catch { continue; }
      if (sessionCount < 4) continue;

      const { html, text } = this._buildReferralInviteEmail(church, { sessionCount });
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'referral-invite',
        to: church.portal_email,
        subject: 'Know another church production team struggling with the same problems?',
        html, text,
      });
    }
  }

  _buildReferralInviteEmail(church, { sessionCount }) {
    const signupUrl = `${this.appUrl}/signup`;
    const portalUrl = `${this.appUrl}/portal`;

    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Know another church production team we could help?</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        <strong>${church.name}</strong> has run <strong>${sessionCount} services</strong> with Tally now &mdash;
        that's a solid track record. Church production teams talk to each other.
        If you know another TD dealing with stream drops or Sunday morning scrambles, send them to Tally.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 8px;">How it works:</div>
        <div style="font-size: 14px; color: #333; line-height: 2.2;">
          <strong>1.</strong> Share <a href="${signupUrl}" style="color: #22c55e; text-decoration: none;">tallyconnect.app/signup</a> with a church you know<br>
          <strong>2.</strong> Ask them to mention <strong>${church.name}</strong> when they sign up<br>
          <strong>3.</strong> When they subscribe, you both get <strong>one month free</strong>
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        No referral codes to track &mdash; just tell them to mention your church name. We'll handle the rest.
      </p>

      ${this._cta('Share Tally with Another Church', signupUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Questions? Reply to this email.
      </p>

      <p style="font-size: 14px; color: #666;">
        &mdash; The Tally Team
      </p>
    `);

    const text = `Know another church production team we could help?\n\n${church.name} has run ${sessionCount} services with Tally — thank you. If you know another TD dealing with stream drops, send them to ${signupUrl}.\n\nHow referrals work:\n1. Share tallyconnect.app/signup\n2. Ask them to mention "${church.name}" when signing up\n3. When they subscribe, you both get one month free\n\n— The Tally Team`;
    return { html, text };
  }

  // ─── GAP 11: INACTIVITY ALERT (4+ weeks no sessions) ───────────────────────

  async _checkInactivityAlert() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
        AND onboarding_app_connected_at IS NOT NULL
        AND registeredAt <= ?
    `, [thirtyDaysAgo]);

    for (const church of churches) {
      // Check last session date
      let lastSessionAt = null;
      try {
        const row = await this._selectOne(
          'SELECT MAX(started_at) as last_at FROM service_sessions WHERE church_id = ? AND (session_type IS NULL OR session_type != \'test\')',
          [church.churchId],
        );
        lastSessionAt = row?.last_at;
      } catch { continue; }

      // Only flag if last session was 30+ days ago (or never)
      if (lastSessionAt && lastSessionAt >= thirtyDaysAgo) continue;

      const { html, text } = this._buildInactivityAlertEmail(church);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'inactivity-alert',
        to: church.portal_email,
        subject: "We haven't seen any services lately \u2014 everything okay?",
        html, text,
      });
    }
  }

  _buildInactivityAlertEmail(church) {
    const portalUrl = `${this.appUrl}/portal`;
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">We haven't seen any services lately</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        Tally hasn't detected any service activity at <strong>${church.name}</strong> in the past 4 weeks.
        Just checking in &mdash; everything okay?
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #fffbeb; border-radius: 10px; border: 1px solid #fde68a;">
        <div style="font-size: 14px; color: #333; line-height: 2;">
          Common reasons for inactivity:<br>
          &bull; Summer break or seasonal schedule change<br>
          &bull; Booth computer was disconnected or moved<br>
          &bull; Service schedule hasn't been set in the portal<br>
          &bull; App needs a reconnect after a system update
        </div>
      </div>

      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        If you're taking a break &mdash; no worries. Tally will be here when you're back.
        If services are running and Tally isn't monitoring, let's fix that:
      </p>

      ${this._cta('Check Your Connection', portalUrl)}

      <p style="font-size: 14px; color: #666; line-height: 1.6;">
        Reply to this email if you need help reconnecting &mdash; usually takes 2 minutes.
      </p>
    `);

    const text = `We haven't seen any services lately\n\nTally hasn't detected any service activity at ${church.name} in the past 4 weeks. If services are running and Tally isn't monitoring, let's fix that: ${portalUrl}\n\nReply if you need help reconnecting.\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── FEATURE ADOPTION: SCHEDULE SETUP NUDGE (Day 7) ────────────────────────
  // 7 days after signup, app connected, but no service schedule configured

  async _checkScheduleSetupNudge() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT churchId, name, portal_email
        FROM churches
        WHERE portal_email IS NOT NULL
          AND onboarding_app_connected_at IS NOT NULL
          AND registeredAt <= ?
          AND registeredAt >= ?
          AND billing_status IN ('trialing', 'active')
      `, [sevenDaysAgo, fourteenDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      // Skip if schedule already has entries
      let hasSchedule = false;
      try {
        const row = await this._selectOne('SELECT 1 FROM service_schedules WHERE church_id = ? LIMIT 1', [church.churchId]);
        hasSchedule = !!row;
      } catch { /* table may not exist */ }
      if (hasSchedule) continue;

      const portalUrl = `${this.appUrl}/portal`;
      const html = this._wrap(`
        <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Tally works best when it knows your schedule</h1>
        <p style="font-size: 15px; color: #333; line-height: 1.6;">
          <strong>${this._esc(church.name)}</strong> is connected and monitoring &mdash; nice work.
          But without a service schedule, Tally can't run pre-service health checks or send recap emails.
        </p>

        <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
          <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">What scheduling unlocks:</div>
          <div style="font-size: 14px; color: #333; line-height: 2.2;">
            &bull; <strong>Pre-service checks</strong> 30 minutes before go-live<br>
            &bull; <strong>Automatic session tracking</strong> with grades and recaps<br>
            &bull; <strong>Weekly digest emails</strong> to leadership<br>
            &bull; <strong>Smarter alerts</strong> that only fire during services
          </div>
        </div>

        <p style="font-size: 15px; color: #333; line-height: 1.6;">
          Adding your schedule takes about 2 minutes in the portal.
        </p>

        ${this._cta('Set Up Your Schedule', portalUrl)}
      `);

      const text = `Tally works best when it knows your schedule\n\n${church.name} is connected but has no service schedule — so pre-service checks, recaps, and weekly digests aren't running.\n\nWhat scheduling unlocks:\n- Pre-service checks 30 min before go-live\n- Automatic session tracking with grades\n- Weekly digest emails to leadership\n\nSet up in 2 minutes: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'schedule-setup-nudge',
        to: church.portal_email,
        subject: 'Tally works best when it knows your schedule',
        html, text,
      });
    }
  }

  // ─── FEATURE ADOPTION: MULTI-CAM NUDGE (Day 21) ──────────────────────────
  // 3 weeks in, only using 1 camera — let them know multi-cam exists

  async _checkMultiCamNudge() {
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();
    const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT churchId, name, portal_email, billing_tier
        FROM churches
        WHERE portal_email IS NOT NULL
          AND onboarding_app_connected_at IS NOT NULL
          AND registeredAt <= ?
          AND registeredAt >= ?
          AND billing_status IN ('trialing', 'active')
          AND billing_tier IN ('plus', 'pro', 'managed')
      `, [twentyOneDaysAgo, twentyEightDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      // Skip if they already have multiple rooms or cameras
      let roomCount = 0;
      try {
        roomCount = await this._count('SELECT COUNT(*) as cnt FROM rooms WHERE campus_id = ? AND deleted_at IS NULL', [church.churchId]);
      } catch { /* table may not exist */ }
      if (roomCount > 1) continue;

      const portalUrl = `${this.appUrl}/portal`;
      const html = this._wrap(`
        <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Did you know Tally can monitor multiple cameras?</h1>
        <p style="font-size: 15px; color: #333; line-height: 1.6;">
          Your <strong>${this._esc(church.name)}</strong> account includes multi-camera monitoring.
          If you have a second camera angle, a lobby display, or a kids' room feed &mdash;
          Tally can watch all of them at once.
        </p>

        <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
          <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">Multi-camera use cases:</div>
          <div style="font-size: 14px; color: #333; line-height: 2.2;">
            &bull; <strong>Main + wide shot</strong> &mdash; catch issues on either feed<br>
            &bull; <strong>Sanctuary + overflow</strong> &mdash; monitor both rooms<br>
            &bull; <strong>Live stream + recording</strong> &mdash; verify both outputs
          </div>
        </div>

        ${this._cta('Add Another Camera', portalUrl)}

        <p style="font-size: 14px; color: #666;">
          If you only have one camera, no worries &mdash; Tally is already protecting it.
        </p>
      `);

      const text = `Did you know Tally can monitor multiple cameras?\n\nYour ${church.name} account supports multi-camera monitoring. If you have a second angle, overflow room, or kids' room — Tally can watch them all.\n\nUse cases:\n- Main + wide shot\n- Sanctuary + overflow room\n- Live stream + recording feed\n\nAdd a camera: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'multi-cam-nudge',
        to: church.portal_email,
        subject: "Did you know Tally can monitor multiple cameras?",
        html, text,
      });
    }
  }

  // ─── FEATURE ADOPTION: VIEWER ANALYTICS NUDGE (Day 30) ────────────────────
  // 30 days in, no stream platform connected — encourage YouTube/Facebook linking

  async _checkViewerAnalyticsNudge() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT churchId, name, portal_email
        FROM churches
        WHERE portal_email IS NOT NULL
          AND onboarding_app_connected_at IS NOT NULL
          AND registeredAt <= ?
          AND registeredAt >= ?
          AND billing_status IN ('active')
      `, [thirtyDaysAgo, fortyDaysAgo]);
    } catch { return; }

    for (const church of churches) {
      // Skip if they have any stream platform configured
      let hasPlatform = false;
      try {
        const row = await this._selectOne(
          "SELECT 1 FROM stream_platforms WHERE church_id = ? AND status = 'active' LIMIT 1",
          [church.churchId],
        );
        hasPlatform = !!row;
      } catch { /* table may not exist */ }
      if (hasPlatform) continue;

      const portalUrl = `${this.appUrl}/portal`;
      const html = this._wrap(`
        <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">See how many people are watching your stream</h1>
        <p style="font-size: 15px; color: #333; line-height: 1.6;">
          <strong>${this._esc(church.name)}</strong> has been running smooth services &mdash; great work.
          Want to know how many people are actually tuning in?
        </p>

        <p style="font-size: 15px; color: #333; line-height: 1.6;">
          Connect your YouTube or Facebook account and Tally will track live viewer counts
          during every service. You'll see peak viewers in your session recaps and analytics dashboard.
        </p>

        <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
          <div style="font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 12px;">What you'll get:</div>
          <div style="font-size: 14px; color: #333; line-height: 2.2;">
            &bull; <strong>Live viewer count</strong> during every service<br>
            &bull; <strong>Peak viewers</strong> in your session recaps<br>
            &bull; <strong>Viewer trends</strong> in your analytics dashboard<br>
            &bull; <strong>Platform breakdown</strong> (YouTube vs Facebook)
          </div>
        </div>

        ${this._cta('Connect Your Stream Platform', portalUrl)}
      `);

      const text = `See how many people are watching your stream\n\n${church.name} is running smooth services. Connect YouTube or Facebook to see live viewer counts, peak viewers in recaps, and viewer trends.\n\nWhat you'll get:\n- Live viewer count during services\n- Peak viewers in session recaps\n- Viewer trends in analytics\n- Platform breakdown\n\nConnect now: ${portalUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;

      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'viewer-analytics-nudge',
        to: church.portal_email,
        subject: 'See how many people are watching your stream',
        html, text,
      });
    }
  }

  // ─── GAP 12: FEATURE ANNOUNCEMENT ──────────────────────────────────────────
  // Manual trigger from admin for new feature releases.

  async sendFeatureAnnouncement({ featureKey, subject, headline, body, ctaText, ctaUrl }) {
    if (!featureKey) return { sent: 0, skipped: 0 };

    const churches = await this._selectAll(`
      SELECT churchId, name, portal_email
      FROM churches
      WHERE billing_status = 'active'
        AND portal_email IS NOT NULL
    `);

    let sent = 0, skipped = 0;
    for (const church of churches) {
      const emailType = `feature-announcement-${featureKey}`;
      const { html, text } = this._buildFeatureAnnouncementEmail(church, { headline, body, ctaText: ctaText || 'Learn More', ctaUrl: ctaUrl || this.appUrl + '/portal' });
      const result = await this.sendEmail({
        churchId: church.churchId,
        emailType,
        to: church.portal_email,
        subject: subject || headline,
        html, text,
      });
      if (result.sent) sent++; else skipped++;
    }

    console.log(`[LifecycleEmails] Feature announcement "${featureKey}": ${sent} sent, ${skipped} skipped`);
    return { sent, skipped };
  }

  _buildFeatureAnnouncementEmail(church, { headline, body, ctaText, ctaUrl }) {
    const html = this._wrap(`
      <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">${this._esc(headline)}</h1>
      <p style="font-size: 15px; color: #333; line-height: 1.6;">
        This update is live now for <strong>${this._esc(church.name)}</strong>.
      </p>

      <div style="margin: 24px 0; padding: 20px; background: #f0fdf4; border-radius: 10px; border: 1px solid #bbf7d0;">
        <div style="font-size: 14px; color: #333; line-height: 1.8;">${body}</div>
      </div>

      ${this._cta(ctaText, ctaUrl)}

      <p style="font-size: 13px; color: #888;">
        This feature is available immediately &mdash; no update or setup required.
      </p>
    `);

    const text = `${headline}\n\nThis update is live now for ${church.name}.\n\n${body.replace(/<[^>]+>/g, '')}\n\n${ctaUrl}\n\nTally — ${this.appUrl.replace('https://', '')}`;
    return { html, text };
  }

  // ─── GAP 13: SECOND GRACE PERIOD TOUCH (Day 2 of grace, 5 days before expiry) ──
  // Handled by adding an early check in _checkGracePeriodEndingSoon — see below.
  // The existing _checkGracePeriodEndingSoon now also fires at day 2 (5 days left).

  async _checkGracePeriodEarlyWarning() {
    const now = Date.now();
    const fiveDaysFromNow = new Date(now + 5 * 24 * 60 * 60 * 1000).toISOString();
    const threeDaysFromNow = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();

    let churches = [];
    try {
      churches = await this._selectAll(`
        SELECT c.churchId, c.name, c.portal_email, bc.grace_period_ends_at
        FROM churches c
        JOIN billing_customers bc ON bc.church_id = c.churchId
        WHERE c.portal_email IS NOT NULL
          AND c.billing_status = 'past_due'
          AND bc.grace_period_ends_at IS NOT NULL
          AND bc.grace_period_ends_at <= ?
          AND bc.grace_period_ends_at > ?
      `, [fiveDaysFromNow, threeDaysFromNow]);
    } catch { return; }

    for (const church of churches) {
      const daysLeft = Math.ceil(
        (new Date(church.grace_period_ends_at).getTime() - now) / (24 * 60 * 60 * 1000)
      );
      const { html, text } = this._buildGracePeriodEndingSoonEmail(church, daysLeft);
      await this.sendEmail({
        churchId: church.churchId,
        emailType: 'grace-period-ending-early',
        to: church.portal_email,
        subject: `Tally will be paused in ${daysLeft} day${daysLeft !== 1 ? 's' : ''} \u2014 update payment now`,
        html, text,
      });
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
    // New gap emails (from EMAIL_AUDIT.md)
    { type: 'early-win-back',          name: 'Early Win-Back',           trigger: 'Auto — 7-14 days after cancellation' },
    { type: 'activation-escalation',   name: 'Activation Escalation',    trigger: 'Auto — Day 10, app never connected' },
    { type: 'pre-service-friday',      name: 'Pre-Service Friday',       trigger: 'Auto — 48h before first scheduled service' },
    { type: 'trial-to-paid-onboarding', name: 'Trial-to-Paid Onboarding', trigger: 'Auto — 24h after first payment' },
    { type: 'monthly-roi-summary',     name: 'Monthly ROI Summary',      trigger: 'Monthly — portal owner ROI narrative' },
    { type: 'annual-renewal-reminder', name: 'Annual Renewal Reminder',  trigger: 'Auto — 30 days before annual renewal' },
    { type: 'telegram-setup-nudge',    name: 'Telegram Setup Nudge',     trigger: 'Auto — Day 5, no Telegram configured' },
    { type: 'nps-survey',              name: 'NPS Survey',               trigger: 'Auto — Day 60 for active customers' },
    { type: 'first-year-anniversary',  name: 'First Year Anniversary',   trigger: 'Auto — 365 days since signup' },
    { type: 'referral-invite',         name: 'Referral Invite',          trigger: 'Auto — Day 90, 4+ sessions' },
    { type: 'inactivity-alert',        name: 'Inactivity Alert',         trigger: 'Auto — 4+ weeks no sessions' },
    { type: 'feature-announcement',    name: 'Feature Announcement',     trigger: 'Manual — admin triggered per release' },
    { type: 'grace-period-ending-early', name: 'Grace Period Early Warning', trigger: 'Auto — 5 days before grace expiry (day 2)' },
    // Feature adoption drip
    { type: 'schedule-setup-nudge',    name: 'Schedule Setup Nudge',     trigger: 'Auto — Day 7, no schedule configured' },
    { type: 'multi-cam-nudge',         name: 'Multi-Camera Nudge',       trigger: 'Auto — Day 21, single-camera Plus+ only' },
    { type: 'viewer-analytics-nudge',  name: 'Viewer Analytics Nudge',   trigger: 'Auto — Day 30, no stream platform connected' },
  ];

  /** Get email send history with optional filters */
  getEmailHistory({ limit = 50, offset = 0, emailType, churchId } = {}) {
    if (this.queryClient) {
      const filtered = this._cache.emailSends.filter((row) => {
        if (emailType && !String(row.email_type || '').includes(emailType)) return false;
        if (churchId && (row.church_id || row.churchId) !== churchId) return false;
        return true;
      });

      const rows = filtered
        .slice()
        .sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime())
        .slice(offset, offset + limit)
        .map((row) => ({
          ...row,
          church_name: this._cache.churchesById.get(row.church_id || row.churchId)?.name || null,
        }));

      return { rows, total: filtered.length };
    }

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
    if (this.queryClient) {
      const total = this._cache.emailSends.length;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const byType = new Map();

      let today = 0;
      let thisWeek = 0;
      for (const row of this._cache.emailSends) {
        const sentAt = new Date(row.sent_at);
        if (sentAt >= todayStart) today += 1;
        if (sentAt >= weekAgo) thisWeek += 1;
        byType.set(row.email_type, (byType.get(row.email_type) || 0) + 1);
      }

      return {
        total,
        today,
        thisWeek,
        byType: [...byType.entries()]
          .map(([email_type, cnt]) => ({ email_type, cnt }))
          .sort((a, b) => b.cnt - a.cnt),
      };
    }

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
    if (this.queryClient) {
      this._cache.overridesByEmailType.forEach((_, emailType) => overrides.add(emailType));
    } else {
      try {
        const rows = this.db.prepare('SELECT email_type FROM email_template_overrides').all();
        rows.forEach(r => overrides.add(r.email_type));
      } catch { /* table might not exist yet */ }
    }

    return LifecycleEmails.EMAIL_REGISTRY.map(entry => ({
      ...entry,
      hasOverride: overrides.has(entry.type),
    }));
  }

  /** Get a template override from DB */
  _getOverride(emailType) {
    if (this.queryClient) {
      const baseType = emailType.startsWith('weekly-digest-') ? 'weekly-digest' :
        emailType.startsWith('upgrade-') ? 'upgrade' : emailType;
      return this._cache.overridesByEmailType.get(baseType) || null;
    }
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
        const downloadUrl = DOWNLOAD_MAC_URL;
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
      'first-service-completed': () => ({ ...this._buildFirstServiceCompletedEmail(sampleChurch, { grade: 'Clean Service', durationMinutes: 72, alerts: [], recoveries: 0 }), subject: 'First service in the books — here\'s how it went' }),
      'dispute-alert':           () => ({ ...this._buildDisputeAlertEmail(sampleChurch, { amount: 9900, reason: 'product_not_received' }), subject: 'Payment dispute opened — action required' }),
      'urgent-alert-escalation': () => ({ ...this._buildUrgentAlertEmail(sampleChurch, { alertType: 'stream_stopped', context: { source: 'OBS', duration: '90s' } }), subject: 'URGENT: stream_stopped at Sample Church' }),
      'cancellation-survey':     () => ({ ...this._buildCancellationSurveyEmail(sampleChurch), subject: 'Quick question — what could we have done better?' }),
      // Lead nurture drip
      'lead-welcome':            () => ({ ...this._buildLeadWelcomeEmail({ email: 'lead@example.com', name: 'John Smith' }), subject: 'Every Sunday, something breaks in the booth' }),
      'lead-day3-value':         () => ({ ...this._buildLeadDay3Email({ email: 'lead@example.com', name: 'John Smith' }), subject: '3 problems Tally solves before Sunday' }),
      'lead-day7-casestudy':     () => ({ ...this._buildLeadDay7Email({ email: 'lead@example.com', name: 'John Smith' }), subject: 'How one church eliminated stream failures' }),
      'lead-day14-offer':        () => ({ ...this._buildLeadDay14Email({ email: 'lead@example.com', name: 'John Smith' }), subject: 'Ready to try Tally? Start your free trial' }),
      // New gap emails
      'early-win-back':          () => ({ ...this._buildEarlyWinBackEmail(sampleChurch), subject: "How'd Sunday go without Tally?" }),
      'activation-escalation':   () => ({ ...this._buildActivationEscalationEmail(sampleChurch), subject: "Your Tally setup isn't complete — want us to help?" }),
      'pre-service-friday':      () => ({ ...this._buildPreServiceFridayEmail(sampleChurch, new Date(Date.now() + 48 * 60 * 60 * 1000)), subject: 'Two days to Sunday — Tally is watching' }),
      'trial-to-paid-onboarding': () => ({ ...this._buildTrialToPaidOnboardingEmail({ ...sampleChurch, billing_tier: 'pro' }), subject: '3 things to configure now that you\'re on Pro' }),
      'monthly-roi-summary':     () => ({ ...this._buildMonthlyROISummaryEmail(sampleChurch, { month: '2026-03', monthLabel: 'March 2026', servicesMonitored: 8, alertsTriggered: 5, autoRecovered: 4, prevServicesMonitored: 6 }), subject: 'March 2026 at Sample Church — here\'s what Tally prevented' }),
      'annual-renewal-reminder': () => ({ ...this._renderAnnualRenewalReminderEmail({ ...sampleChurch, billing_tier: 'pro', current_period_end: new Date(Date.now() + 30 * 86400000).toISOString() }, { sessions: 48, autoFixed: 6 }), subject: 'Your annual Tally subscription renews in 30 days' }),
      'telegram-setup-nudge':    () => ({ ...this._buildTelegramSetupNudgeEmail(sampleChurch), subject: "You're missing the best part of Tally" }),
      'nps-survey':              () => ({ ...this._buildNPSSurveyEmail(sampleChurch), subject: 'Quick question — how likely are you to recommend Tally?' }),
      'first-year-anniversary':  () => ({ ...this._renderFirstYearAnniversaryEmail({ ...sampleChurch, billing_tier: 'pro' }, { sessions: 52, autoFixed: 8 }), subject: 'Sample Church just completed one year with Tally' }),
      'referral-invite':         () => ({ ...this._buildReferralInviteEmail(sampleChurch, { sessionCount: 24 }), subject: 'Know another church production team struggling with the same problems?' }),
      'inactivity-alert':        () => ({ ...this._buildInactivityAlertEmail(sampleChurch), subject: "We haven't seen any services lately — everything okay?" }),
      'feature-announcement':    () => ({ ...this._buildFeatureAnnouncementEmail(sampleChurch, { headline: 'New: AutoPilot scene recall', body: 'AutoPilot now supports ProPresenter scene recall during service transitions.', ctaText: 'See What\'s New', ctaUrl: this.appUrl + '/portal' }), subject: 'New: AutoPilot scene recall' }),
      'grace-period-ending-early': () => ({ ...this._buildGracePeriodEndingSoonEmail(sampleChurch, 5), subject: 'Tally will be paused in 5 days — update payment now' }),
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
    if (this.queryClient) {
      this._cacheOverride(emailType, { email_type: emailType, subject: subject || null, html: html || null, updated_at: now });
      void this._queueWrite(() => this._run(`
      INSERT INTO email_template_overrides (email_type, subject, html, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email_type) DO UPDATE SET
        subject = excluded.subject,
        html = excluded.html,
        updated_at = excluded.updated_at
    `, [emailType, subject || null, html || null, now]));
      console.log(`[LifecycleEmails] Template override saved for "${emailType}"`);
      return { emailType, subject, updated_at: now };
    }
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
    if (this.queryClient) {
      this._cacheOverride(emailType, null);
      void this._queueWrite(() => this._run('DELETE FROM email_template_overrides WHERE email_type = ?', [emailType]));
      console.log(`[LifecycleEmails] Template override removed for "${emailType}"`);
      return;
    }
    this.db.prepare('DELETE FROM email_template_overrides WHERE email_type = ?').run(emailType);
    console.log(`[LifecycleEmails] Template override removed for "${emailType}"`);
  }

  /** Send a manual/custom email — bypasses dedup */
  async sendManual({ churchId, emailType, to, subject, html, text }) {
    await this.ready;
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
      this._recordSend(churchId || 'admin', actualType, to, new Date().toISOString(), data.id, subject);

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
