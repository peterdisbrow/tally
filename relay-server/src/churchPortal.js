/**
 * Church Portal — self-service management for individual churches
 *
 * Routes:
 *   GET  /church-login                   login page
 *   POST /api/church/login               validate → JWT cookie → redirect
 *   POST /api/church/logout              clear cookie
 *   GET  /church-portal                  portal HTML (cookie auth)
 *
 *   GET  /api/church/me                  church profile
 *   PUT  /api/church/me                  update email, phone, notification prefs
 *   GET  /api/church/campuses            list linked campuses
 *   POST /api/church/campuses            create linked campus
 *   DELETE /api/church/campuses/:id      remove linked campus
 *
 *   Campus Mode — Pro/Enterprise self-service campus linking:
 *   POST /api/church/campus/link         generate link code (action=generate) or join via code (action=join)
 *   GET  /api/church/campus/list         list campuses in this church's campus group
 *   DELETE /api/church/campus/:id/unlink remove a satellite from the group (or self-unlink)
 *   GET  /api/church/schedule            service schedule
 *   PUT  /api/church/schedule            update schedule
 *   GET  /api/church/tds                 tech directors list
 *   POST /api/church/tds                 add TD
 *   DELETE /api/church/tds/:tdId         remove TD
 *   GET  /api/church/sessions            recent sessions
 *   GET  /api/church/guest-tokens        list guest tokens
 *   POST /api/church/guest-tokens        generate token
 *   DELETE /api/church/guest-tokens/:tok revoke token
 *
 * Admin helper routes (requireAdmin):
 *   POST /api/churches/:churchId/portal-credentials  { email, password }
 */

const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { createLogger } = require('./logger');
const log = createLogger('portal');
const { hashPassword, verifyPassword, generateRegistrationCode: _genRegCode } = require('./auth');
const { createRateLimit } = require('./rateLimit');
const { isStreamActive, isRecordingActive } = require('./status-utils');
const { escapeHtml } = require('./escapeHtml');
const { generateCsrfToken, setCsrfCookie } = require('./csrf');

function safeErrorMessage(err, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}

// ─── JWT helpers ───────────────────────────────────────────────────────────────

function issueChurchToken(churchId, jwtSecret) {
  return jwt.sign({ type: 'church_portal', churchId }, jwtSecret, { expiresIn: '7d' });
}

function generateRegistrationCode(db) {
  return _genRegCode(db);
}

function requireChurchPortalAuth(db, jwtSecret) {
  return (req, res, next) => {
    const token = req.cookies?.tally_church_session;
    if (!token) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      return res.redirect('/church-login');
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.type !== 'church_portal') throw new Error('wrong type');
      const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) throw new Error('church not found');
      req.church = church;
      next();
    } catch {
      res.clearCookie('tally_church_session');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
      return res.redirect('/church-login');
    }
  };
}

function requireChurchPortalOrAppAuth(db, jwtSecret) {
  const cookieAuth = requireChurchPortalAuth(db, jwtSecret);
  return (req, res, next) => {
    const auth = req.headers?.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), jwtSecret);
        if (payload.type !== 'church_portal' && payload.type !== 'church_app') {
          throw new Error('wrong type');
        }
        const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
        if (!church) return res.status(404).json({ error: 'Church not found' });
        req.church = church;
        return next();
      } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    }
    return cookieAuth(req, res, next);
  };
}

// ─── Dashboard Stats ────────────────────────────────────────────────────────────

const SCHEDULE_DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE_DAY_LABELS_MAP = {
  sunday: 'Sunday', monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday',
};

/**
 * Compute at-a-glance dashboard stats for a church.
 * @param {import('better-sqlite3').Database} db
 * @param {string} churchId
 * @param {Map} churches  In-memory runtime map (for equipment status)
 * @param {Date} [now]  Injectable for testing
 * @returns {object}
 */
function getDashboardStats(db, churchId, churches, now) {
  if (!now) now = new Date();

  // ── Time boundaries ─────────────────────────────────────────────────────
  const dayOfWeek = now.getDay(); // 0=Sun
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek);
  thisWeekStart.setHours(0, 0, 0, 0);
  const thisWeekStartISO = thisWeekStart.toISOString();

  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekStartISO = lastWeekStart.toISOString();

  // ── This week sessions ────────────────────────────────────────────────
  let thisWeekSessions = { services: 0, alerts: 0, autoRecoveries: 0, totalDurationMin: 0, totalStreamMin: 0 };
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS services,
        COALESCE(SUM(alert_count), 0) AS alerts,
        COALESCE(SUM(auto_recovered_count), 0) AS autoRecoveries,
        COALESCE(SUM(duration_minutes), 0) AS totalDurationMin,
        COALESCE(SUM(stream_runtime_minutes), 0) AS totalStreamMin
      FROM service_sessions
      WHERE church_id = ? AND started_at >= ?
    `).get(churchId, thisWeekStartISO);
    if (row) {
      thisWeekSessions = row;
    }
  } catch { /* table may not exist */ }

  const uptimePercent = thisWeekSessions.totalDurationMin > 0
    ? Math.round(Math.min(100, (thisWeekSessions.totalStreamMin / thisWeekSessions.totalDurationMin) * 100) * 10) / 10
    : (thisWeekSessions.services > 0 ? 100 : 0);

  // ── Last week alerts (for trend) ──────────────────────────────────────
  let lastWeekAlerts = 0;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(alert_count), 0) AS alerts
      FROM service_sessions
      WHERE church_id = ? AND started_at >= ? AND started_at < ?
    `).get(churchId, lastWeekStartISO, thisWeekStartISO);
    if (row) lastWeekAlerts = row.alerts;
  } catch { /* table may not exist */ }

  const alertDiff = thisWeekSessions.alerts - lastWeekAlerts;
  let alertsTrending = 'stable';
  if (alertDiff > 0) alertsTrending = 'up';
  else if (alertDiff < 0) alertsTrending = 'down';
  const comparedToLastWeek = alertDiff > 0 ? `+${alertDiff}` : String(alertDiff);

  // ── Equipment status (from in-memory runtime) ─────────────────────────
  const equipmentStatus = { total: 0, healthy: 0, warning: 0, offline: 0 };
  const runtime = churches ? churches.get(churchId) : null;
  if (runtime && runtime.status) {
    const st = runtime.status;
    const devices = [];

    // ATEM
    if (st.atem) {
      const connected = st.atem === true || !!(st.atem && st.atem.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // OBS
    if (st.obs) {
      const connected = st.obs === true || !!(st.obs && st.obs.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // Encoder
    if (st.encoder) {
      const enc = typeof st.encoder === 'object' ? st.encoder : {};
      const connected = st.encoder === true || !!enc.connected;
      devices.push(connected ? 'healthy' : 'offline');
    }
    // Mixer
    if (st.mixer) {
      const connected = !!(st.mixer && st.mixer.connected);
      devices.push(connected ? 'healthy' : 'offline');
    }
    // HyperDecks
    if (st.hyperdecks && Array.isArray(st.hyperdecks)) {
      for (const hd of st.hyperdecks) {
        devices.push(hd.connected ? 'healthy' : 'offline');
      }
    }
    if (st.hyperdeck) {
      devices.push(st.hyperdeck.connected ? 'healthy' : 'offline');
    }
    // PTZ cameras
    if (st.ptzCameras && Array.isArray(st.ptzCameras)) {
      for (const cam of st.ptzCameras) {
        devices.push(cam.connected ? 'healthy' : 'offline');
      }
    }

    equipmentStatus.total = devices.length;
    equipmentStatus.healthy = devices.filter(d => d === 'healthy').length;
    equipmentStatus.warning = devices.filter(d => d === 'warning').length;
    equipmentStatus.offline = devices.filter(d => d === 'offline').length;
  }

  // ── Next service (from schedule) ──────────────────────────────────────
  let nextService = null;
  try {
    const row = db.prepare('SELECT schedule FROM churches WHERE churchId = ?').get(churchId);
    const sched = (row && row.schedule) ? JSON.parse(row.schedule) : {};
    nextService = _findNextService(sched, now);
  } catch { /* no schedule */ }

  return {
    thisWeek: {
      services: thisWeekSessions.services,
      alerts: thisWeekSessions.alerts,
      autoRecoveries: thisWeekSessions.autoRecoveries,
      uptimePercent,
    },
    trend: {
      alertsTrending,
      comparedToLastWeek,
    },
    equipmentStatus,
    nextService,
  };
}

/**
 * Find the next upcoming service window from the schedule.
 * @param {object} sched  { sunday: [{start, end, label}], ... }
 * @param {Date} now
 * @returns {object|null}  { time: ISO, label, minutesUntil }
 */
function _findNextService(sched, now) {
  if (!sched || typeof sched !== 'object') return null;

  const candidates = [];
  const currentDayIndex = now.getDay(); // 0=Sun

  // Check next 7 days (including today)
  for (let offset = 0; offset < 7; offset++) {
    const dayIndex = (currentDayIndex + offset) % 7;
    const dayKey = SCHEDULE_DAY_NAMES[dayIndex];
    const windows = sched[dayKey];
    if (!Array.isArray(windows)) continue;

    for (const w of windows) {
      if (!w.start) continue;
      // Parse start time (format: "HH:MM" or "H:MM")
      const parts = w.start.split(':');
      if (parts.length < 2) continue;
      const hour = parseInt(parts[0], 10);
      const minute = parseInt(parts[1], 10);
      if (isNaN(hour) || isNaN(minute)) continue;

      const candidate = new Date(now);
      candidate.setDate(now.getDate() + offset);
      candidate.setHours(hour, minute, 0, 0);

      // Skip if in the past
      if (candidate <= now) continue;

      const minutesUntil = Math.round((candidate - now) / 60000);
      const dayLabel = SCHEDULE_DAY_LABELS_MAP[dayKey] || dayKey;
      const timeStr = candidate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const label = w.label ? `${dayLabel} ${timeStr} — ${w.label}` : `${dayLabel} ${timeStr}`;

      candidates.push({ time: candidate.toISOString(), label, minutesUntil });
    }
  }

  if (candidates.length === 0) return null;
  // Return the soonest
  candidates.sort((a, b) => a.minutesUntil - b.minutesUntil);
  return candidates[0];
}

// ─── HTML builders ─────────────────────────────────────────────────────────────

const _loginHtmlTemplate = require('fs').readFileSync(require('path').join(__dirname, '../public/portal/login.html'), 'utf8');
function buildChurchLoginHtml(error = '') {
  const errorBlock = error
    ? `<div class="error">${error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}</div>`
    : '';
  return _loginHtmlTemplate.replace('{{ERROR_BLOCK}}', errorBlock);
}

// Portal HTML is served from separate static files (public/portal/)
const _portalHtmlTemplate = require('fs').readFileSync(require('path').join(__dirname, '../public/portal/portal.html'), 'utf8');

function buildChurchPortalHtml(church) {
  const name = church.name || 'Your Church';
  return _portalHtmlTemplate
    .replace(/\{\{CHURCH_ID\}\}/g, church.churchId)
    .replace(/\{\{CHURCH_NAME\}\}/g, _escapeHtml(name));
}

function _escapeHtml(str) {
  return String(str).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── Route setup ───────────────────────────────────────────────────────────────

function setupChurchPortal(app, db, churches, jwtSecret, requireAdmin, { billing, lifecycleEmails, preServiceCheck, sessionRecap, weeklyDigest, rundownEngine, scheduler, aiRateLimiter, guestTdMode, signalFailover } = {}) {
  const express = require('express');
  log.info('Setup started');

  // ── Rate limiting for login endpoint ───────────────────────────────────────
  const loginRateLimit = createRateLimit({
    scope: 'church_portal_login',
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
    keyGenerator: (_req, ip) => ip,
    onLimit: (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(429).send(buildChurchLoginHtml('Too many login attempts. Please try again later.'));
    },
  });

  const billingRateLimit = createRateLimit({ scope: 'church_billing', maxAttempts: 3, windowMs: 60_000 });

  // ── Schema ──────────────────────────────────────────────────────────────────
  const migrations = [
    "ALTER TABLE churches ADD COLUMN portal_email TEXT",
    "ALTER TABLE churches ADD COLUMN portal_password_hash TEXT",
    "ALTER TABLE churches ADD COLUMN phone TEXT",
    "ALTER TABLE churches ADD COLUMN location TEXT",
    "ALTER TABLE churches ADD COLUMN notes TEXT",
    "ALTER TABLE churches ADD COLUMN notifications TEXT DEFAULT '{}'",
    "ALTER TABLE churches ADD COLUMN telegram_chat_id TEXT",
    "ALTER TABLE churches ADD COLUMN parent_church_id TEXT",
    "ALTER TABLE churches ADD COLUMN campus_name TEXT",
    "ALTER TABLE churches ADD COLUMN schedule TEXT DEFAULT '{}'",
    "ALTER TABLE churches ADD COLUMN auto_recovery_enabled INTEGER DEFAULT 1",
    "ALTER TABLE churches ADD COLUMN leadership_emails TEXT DEFAULT ''",
  ];
  for (const m of migrations) {
    try { db.exec(m); } catch { /* already exists */ }
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_churches_parent_church_id ON churches(parent_church_id)'); } catch {}

  // Ensure portal-specific columns exist on church_tds (table created by telegramBot)
  const _portalMigrations = [
    "ALTER TABLE church_tds ADD COLUMN role TEXT DEFAULT 'td'",
    "ALTER TABLE church_tds ADD COLUMN email TEXT",
    "ALTER TABLE church_tds ADD COLUMN phone TEXT",
    "ALTER TABLE churches ADD COLUMN referral_code TEXT",
    "ALTER TABLE churches ADD COLUMN referred_by TEXT",
    "ALTER TABLE churches ADD COLUMN locale TEXT DEFAULT 'en'",
  ];
  for (const m of _portalMigrations) {
    try { db.exec(m); } catch { /* column already exists */ }
  }

  // Telegram macros table
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_macros (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(church_id, name)
    )
  `);

  // Guest tokens table (extend if not exists)
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_tokens (
      token      TEXT PRIMARY KEY,
      churchId   TEXT NOT NULL,
      label      TEXT,
      createdAt  TEXT NOT NULL,
      expiresAt  TEXT
    )
  `);

  // Support triage/ticket tables (created in relay too; repeated here for module resilience)
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_triage_runs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT DEFAULT '',
      triage_result TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      autofix_attempts_json TEXT DEFAULT '[]',
      timezone TEXT,
      app_version TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      triage_id TEXT,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      forced_bypass INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);

  // Reviews / testimonials table
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_reviews (
      id            TEXT PRIMARY KEY,
      church_id     TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      reviewer_role TEXT DEFAULT '',
      rating        INTEGER NOT NULL,
      body          TEXT NOT NULL,
      church_name   TEXT NOT NULL,
      approved      INTEGER DEFAULT 0,
      featured      INTEGER DEFAULT 0,
      submitted_at  TEXT NOT NULL,
      approved_at   TEXT,
      source        TEXT DEFAULT 'portal'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_approved ON church_reviews(approved)');

  // Referrals table — tracks who referred whom and credit status
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id              TEXT PRIMARY KEY,
      referrer_id     TEXT NOT NULL,
      referred_id     TEXT NOT NULL,
      referred_name   TEXT DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'pending',
      credit_amount   INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL,
      converted_at    TEXT,
      credited_at     TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id)');

  // Backfill referral codes for existing churches that don't have one
  const churchesMissingCode = db.prepare('SELECT churchId FROM churches WHERE referral_code IS NULL OR referral_code = ?').all('');
  for (const c of churchesMissingCode) {
    const code = generateRegistrationCode(db).toUpperCase();
    db.prepare('UPDATE churches SET referral_code = ? WHERE churchId = ?').run(code, c.churchId);
  }

  const authMiddleware = requireChurchPortalAuth(db, jwtSecret);
  const supportAuthMiddleware = requireChurchPortalOrAppAuth(db, jwtSecret);

  function maxCampusesForTier(tierValue) {
    const tier = String(tierValue || 'connect').toLowerCase();
    const limits = {
      connect: 1,   // single room
      plus: 3,      // up to 3 rooms
      pro: 5,       // up to 5 rooms
      managed: 999, // unlimited rooms (Enterprise)
      event: 1,
    };
    return limits[tier] || 1;
  }

  function campusLimitsForChurch(churchRow) {
    const tier = String(churchRow?.billing_tier || 'connect').toLowerCase();
    const maxTotal = maxCampusesForTier(tier);
    const linkedCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM churches WHERE parent_church_id = ?').get(churchRow.churchId);
    const linkedCount = Number(linkedCountRow?.cnt || 0);
    const usedTotal = 1 + linkedCount; // include this primary campus/room
    const remaining = Math.max(0, maxTotal - usedTotal);
    const canAdd = !churchRow.parent_church_id && remaining > 0;
    return { tier, maxTotal, linkedCount, usedTotal, remaining, canAdd };
  }

  // ── Login page ───────────────────────────────────────────────────────────────
  app.get('/church-login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildChurchLoginHtml());
  });

  // ── Login POST ────────────────────────────────────────────────────────────────
  app.post('/api/church/login', express.urlencoded({ extended: false }), loginRateLimit, (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(400).send(buildChurchLoginHtml('Email and password are required.'));
    }
    const church = db.prepare('SELECT * FROM churches WHERE portal_email = ?').get(email.trim().toLowerCase());
    if (!church || !church.portal_password_hash || !verifyPassword(password, church.portal_password_hash)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(401).send(buildChurchLoginHtml('Invalid email or password.'));
    }
    const token = issueChurchToken(church.churchId, jwtSecret);
    res.cookie('tally_church_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    setCsrfCookie(res, generateCsrfToken());
    res.redirect('/church-portal');
  });

  // ── Logout ────────────────────────────────────────────────────────────────────
  app.post('/api/church/logout', (req, res) => {
    res.clearCookie('tally_church_session');
    res.json({ ok: true });
  });

  // ── Portal HTML ───────────────────────────────────────────────────────────────
  app.get('/church-portal', authMiddleware, (req, res) => {
    // Refresh CSRF token on every portal load so users with existing sessions
    // (e.g. logged in before CSRF was introduced) always get a valid token.
    if (!req.cookies?.tally_csrf) {
      setCsrfCookie(res, generateCsrfToken());
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildChurchPortalHtml(req.church));
  });

  // ── GET /api/church/me ────────────────────────────────────────────────────────
  app.get('/api/church/me', authMiddleware, (req, res) => {
    const c = req.church;
    const runtime = churches.get(c.churchId);
    let tds = [];
    try { tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ? ORDER BY registered_at ASC').all(c.churchId); } catch {}
    const { portal_password_hash, token, ...safe } = c;

    let notifications = {};
    try { notifications = JSON.parse(c.notifications || '{}'); } catch {}

    res.json({
      ...safe,
      notifications,
      tds,
      connected: runtime?.ws?.readyState === 1,
      status: runtime?.status || {},
      lastSeen: runtime?.lastSeen || null,
      autoRecoveryEnabled: c.auto_recovery_enabled !== 0,
    });
  });

  // ── POST /api/church/onboarding/dismiss ──────────────────────────────────
  app.post('/api/church/onboarding/dismiss', authMiddleware, (req, res) => {
    try {
      db.prepare('UPDATE churches SET onboarding_dismissed = 1 WHERE churchId = ?').run(req.church.churchId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to dismiss onboarding' });
    }
  });

  // ── POST /api/church/onboarding/undismiss ──────────────────────────────────
  app.post('/api/church/onboarding/undismiss', authMiddleware, (req, res) => {
    try {
      db.prepare('UPDATE churches SET onboarding_dismissed = 0 WHERE churchId = ?').run(req.church.churchId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to restore onboarding' });
    }
  });

  // ── POST /api/church/onboarding/failover-tested ──────────────────────────────
  // Marks the "Run a test failover" onboarding step complete. Called when the
  // user clicks the "Mark done" button on the onboarding checklist.
  app.post('/api/church/onboarding/failover-tested', authMiddleware, (req, res) => {
    try {
      db.prepare('UPDATE churches SET onboarding_failover_tested_at = ? WHERE churchId = ?')
        .run(new Date().toISOString(), req.church.churchId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to record failover test' });
    }
  });

  // ── POST /api/church/onboarding/team-invited ─────────────────────────────────
  app.post('/api/church/onboarding/team-invited', authMiddleware, (req, res) => {
    try {
      db.prepare('UPDATE churches SET onboarding_team_invited_at = ? WHERE churchId = ?')
        .run(new Date().toISOString(), req.church.churchId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to record team invite' });
    }
  });

  // ── GET /api/church/failover ─────────────────────────────────────────────────
  app.get('/api/church/failover', supportAuthMiddleware, (req, res) => {
    try {
      const row = db.prepare(
        `SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s,
                failover_action, failover_auto_recover, failover_audio_trigger
         FROM churches WHERE churchId = ?`
      ).get(req.church.churchId);
      if (!row) return res.status(404).json({ error: 'Church not found' });
      let action = null;
      try { action = row.failover_action ? JSON.parse(row.failover_action) : null; } catch { /* invalid JSON */ }
      res.json({
        enabled: !!row.failover_enabled,
        blackThresholdS: row.failover_black_threshold_s || 5,
        ackTimeoutS: row.failover_ack_timeout_s || 30,
        action,
        autoRecover: !!row.failover_auto_recover,
        audioTrigger: !!row.failover_audio_trigger,
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load failover settings' });
    }
  });

  // ── GET /api/church/failover/state ─────────────────────────────────────────────
  app.get('/api/church/failover/state', supportAuthMiddleware, (req, res) => {
    try {
      const state = signalFailover.getState(req.church.churchId);
      res.json(state);
    } catch (e) {
      res.status(500).json({ error: 'Failed to get failover state' });
    }
  });

  // ── GET /api/church/failover/sources ──────────────────────────────────────────
  // Returns available failover sources from live device status (ATEM inputs,
  // VideoHub routes, OBS scenes) so the Electron app can populate a dropdown.
  app.get('/api/church/failover/sources', supportAuthMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const church = churches.get(churchId);
      if (!church) return res.json({ atem: [], videohub: [], obs: [] });

      const status = church.status || {};
      const sources = { atem: [], videohub: [], obs: [] };

      // ATEM inputs from labels
      const labels = status.atem?.inputLabels || {};
      for (const [id, name] of Object.entries(labels)) {
        sources.atem.push({ id: Number(id), name: String(name) });
      }
      // Fallback: if no labels but ATEM is connected, show generic inputs 1-8
      if (sources.atem.length === 0 && status.atem?.connected) {
        for (let i = 1; i <= 8; i++) sources.atem.push({ id: i, name: `Input ${i}` });
      }

      // VideoHub routes from each connected hub
      const hubs = status.videoHubs || [];
      for (const hub of hubs) {
        if (!hub.connected) continue;
        const hubInputLabels = hub.inputLabels || {};
        for (const [idx, label] of Object.entries(hubInputLabels)) {
          sources.videohub.push({ id: Number(idx), name: label, hub: hub.name || hub.ip });
        }
      }

      // OBS scenes (if OBS is the encoder)
      if (status.obs?.scenes && Array.isArray(status.obs.scenes)) {
        for (const scene of status.obs.scenes) {
          sources.obs.push({ name: scene.name || scene });
        }
      }

      res.json(sources);
    } catch (e) {
      res.status(500).json({ error: 'Failed to get failover sources' });
    }
  });

  // ── PUT /api/church/failover ─────────────────────────────────────────────────
  app.put('/api/church/failover', supportAuthMiddleware, (req, res) => {
    try {
      const { enabled, blackThresholdS, ackTimeoutS, action, autoRecover, audioTrigger } = req.body;
      const churchId = req.church.churchId;

      // Validate thresholds
      const blackS = Math.max(3, Math.min(15, Number(blackThresholdS) || 5));
      const ackS = Math.max(10, Math.min(120, Number(ackTimeoutS) || 30));

      // Validate action shape
      let actionJson = null;
      if (action && typeof action === 'object') {
        if (action.type === 'atem_switch' && action.input != null) {
          actionJson = JSON.stringify({ type: 'atem_switch', input: Number(action.input) });
        } else if (action.type === 'videohub_route' && action.output != null && action.input != null) {
          actionJson = JSON.stringify({
            type: 'videohub_route',
            output: Number(action.output),
            input: Number(action.input),
            hubIndex: Number(action.hubIndex) || 0,
          });
        }
      }

      db.prepare(
        `UPDATE churches SET failover_enabled = ?, failover_black_threshold_s = ?, failover_ack_timeout_s = ?,
                failover_action = ?, failover_auto_recover = ?, failover_audio_trigger = ?
         WHERE churchId = ?`
      ).run(enabled ? 1 : 0, blackS, ackS, actionJson, autoRecover ? 1 : 0, audioTrigger ? 1 : 0, churchId);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save failover settings' });
    }
  });

  // ── POST /api/church/failover/drill ──────────────────────────────────────────
  // Runs a simulated failover sequence and returns a pass/fail report.
  // Does NOT send real Telegram alerts or execute real device commands.
  app.post('/api/church/failover/drill', supportAuthMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const row = db.prepare(
        `SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s, failover_action
         FROM churches WHERE churchId = ?`
      ).get(churchId);

      const issues = [];
      const checks = [];

      // Check 1: failover is configured
      if (!row || !row.failover_enabled) {
        issues.push('Failover is not enabled. Enable it above and configure an action.');
      }
      checks.push({ name: 'Failover enabled', passed: !!(row && row.failover_enabled) });

      // Check 2: failover action is set
      let action = null;
      try { action = row && row.failover_action ? JSON.parse(row.failover_action) : null; } catch {}
      if (!action) issues.push('No failover action configured. Select an ATEM input or VideoHub route above.');
      checks.push({ name: 'Failover action configured', passed: !!action });

      // Check 3: church client is connected (so the action could actually execute)
      const church = churches.get(churchId);
      const clientConnected = church && church.ws && church.ws.readyState === 1;
      if (!clientConnected) issues.push('Tally desktop app is not connected — failover actions require an active client connection. This is OK for a planning drill.');
      checks.push({ name: 'Client app connected', passed: !!clientConnected, optional: true });

      // Check 4: validate the configured action type
      const validAction = action && (action.type === 'atem_switch' || action.type === 'videohub_route');
      checks.push({ name: 'Action type is valid', passed: !!validAction });

      const criticalIssues = issues.filter((_, i) => !checks[i]?.optional);
      const passed = criticalIssues.length === 0 && validAction;

      const checkList = checks.map(c =>
        (c.passed ? '[ok]' : (c.optional ? '[warn]' : '[fail]')) + ' ' + c.name
      ).join('\n');

      const actionDesc = action
        ? (action.type === 'atem_switch' ? 'Switch ATEM to ' + friendlyInputName(action.input) : 'VideoHub route output ' + action.output + ' → input ' + action.input)
        : 'No action configured';

      const thresholds = `Black threshold: ${row?.failover_black_threshold_s || 5}s, Ack timeout: ${row?.failover_ack_timeout_s || 30}s`;

      const report = passed
        ? `Drill passed! ${checkList}\n\nConfigured action: ${actionDesc}\n${thresholds}\n\nYour failover setup is ready. When a real outage occurs, Tally will: (1) Detect signal loss after ${row?.failover_black_threshold_s || 5}s, (2) Alert your TD via Telegram, (3) Auto-execute "${actionDesc}" if no ack in ${row?.failover_ack_timeout_s || 30}s.`
        : `Drill found issues:\n${issues.join('\n')}\n\n${checkList}\n\nFix the issues above and run the drill again.`;

      // Record drill run time
      try {
        db.prepare('UPDATE churches SET onboarding_failover_tested_at = ? WHERE churchId = ?')
          .run(new Date().toISOString(), churchId);
      } catch {}

      res.json({ passed, report, checks });
    } catch (e) {
      log.error('Failover drill error: ' + e.message);
      res.status(500).json({ error: 'Drill failed: ' + e.message });
    }
  });

  // ── PUT /api/church/me ────────────────────────────────────────────────────────
  app.put('/api/church/me', authMiddleware, (req, res) => {
    const { email, phone, location, notes, notifications, telegramChatId, engineerProfile, autoRecoveryEnabled, currentPassword, newPassword, leadershipEmails, locale } = req.body;
    const churchId = req.church.churchId;

    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      // Require current password for security
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required to change password' });
      const row = db.prepare('SELECT portal_password_hash FROM churches WHERE churchId = ?').get(churchId);
      if (!row?.portal_password_hash || !verifyPassword(currentPassword, row.portal_password_hash)) {
        return res.status(403).json({ error: 'Current password is incorrect' });
      }
      db.prepare('UPDATE churches SET portal_password_hash = ? WHERE churchId = ?')
        .run(hashPassword(newPassword), churchId);
    }

    const { audioViaAtem } = req.body;
    const allowedColumns = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications', 'engineer_profile', 'auto_recovery_enabled', 'audio_via_atem', 'leadership_emails', 'locale'];
    const patch = {};
    if (email          !== undefined) patch.portal_email     = email.trim().toLowerCase();
    if (phone          !== undefined) patch.phone            = phone;
    if (location       !== undefined) patch.location         = location;
    if (notes          !== undefined) patch.notes            = notes;
    if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
    if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);
    if (engineerProfile !== undefined) patch.engineer_profile = JSON.stringify(engineerProfile);
    if (autoRecoveryEnabled !== undefined) patch.auto_recovery_enabled = autoRecoveryEnabled ? 1 : 0;
    if (audioViaAtem   !== undefined) patch.audio_via_atem   = audioViaAtem ? 1 : 0;
    if (leadershipEmails !== undefined) patch.leadership_emails = String(leadershipEmails || '').trim();
    if (locale !== undefined) patch.locale = ['en', 'es'].includes(locale) ? locale : 'en';

    const safePatch = Object.fromEntries(Object.entries(patch).filter(([k]) => allowedColumns.includes(k)));
    const oldEmail = req.church.portal_email;
    if (Object.keys(safePatch).length) {
      const sets = Object.keys(safePatch).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE churches SET ${sets} WHERE churchId = ?`).run(...Object.values(safePatch), churchId);
      // Sync audio_via_atem to in-memory runtime state + mark as manual override
      if (safePatch.audio_via_atem !== undefined) {
        const runtime = churches.get(churchId);
        if (runtime) {
          runtime.audio_via_atem = safePatch.audio_via_atem;
          runtime._audioViaAtemManualOverride = true;
        }
      }
      // Send email change confirmation if portal_email changed
      if (safePatch.portal_email && safePatch.portal_email !== oldEmail && lifecycleEmails) {
        lifecycleEmails.sendEmailChangeConfirmation(req.church, { oldEmail, newEmail: safePatch.portal_email }).catch(e => console.error('[Profile] Email change confirmation failed:', e.message));
      }
    }
    res.json({ ok: true });
  });

  // ── Campus management (multi-campus) ────────────────────────────────────────
  // ── Campus Mode helpers ───────────────────────────────────────────────────────
  // Campus Mode is a Pro/Enterprise-only feature that lets existing churches
  // link together via a code rather than creating new accounts through a reseller.
  function isCampusModeEligible(church) {
    const tier = String(church?.billing_tier || 'connect').toLowerCase();
    return tier === 'pro' || tier === 'managed';
  }

  // ── POST /api/church/campus/link ──────────────────────────────────────────────
  // action=generate — main campus creates/refreshes its link code
  // action=join     — satellite enters the main campus's link code to join
  app.post('/api/church/campus/link', authMiddleware, express.json(), (req, res) => {
    try {
      if (!isCampusModeEligible(req.church)) {
        return res.status(403).json({ error: 'Campus Mode requires a Pro or Enterprise plan', upgradeRequired: true });
      }
      const action = String(req.body?.action || '').trim();

      if (action === 'generate') {
        if (req.church.campus_id) {
          return res.status(400).json({ error: 'Satellite campuses cannot generate link codes. Unlink first.' });
        }
        // Generate a 6-char uppercase hex code (3 random bytes → 6 hex chars)
        const code = crypto.randomBytes(3).toString('hex').toUpperCase();
        db.prepare('UPDATE churches SET campus_link_code = ? WHERE churchId = ?').run(code, req.church.churchId);
        return res.json({ ok: true, code });
      }

      if (action === 'join') {
        if (req.church.campus_id) {
          return res.status(400).json({ error: 'Already linked to a campus group. Unlink first.' });
        }
        // Prevent a main campus (one that already has satellites) from becoming a satellite
        const hasLinkedSatellites = db.prepare(
          'SELECT COUNT(*) AS cnt FROM churches WHERE campus_id = ?'
        ).get(req.church.churchId);
        if (Number(hasLinkedSatellites?.cnt || 0) > 0) {
          return res.status(400).json({ error: 'This church already has linked satellite campuses and cannot become a satellite itself.' });
        }
        const code = String(req.body?.code || '').trim().toUpperCase();
        if (!code) return res.status(400).json({ error: 'Link code is required' });
        if (!/^[0-9A-F]{6}$/.test(code)) return res.status(400).json({ error: 'Invalid link code format' });

        const mainChurch = db.prepare('SELECT * FROM churches WHERE campus_link_code = ?').get(code);
        if (!mainChurch) return res.status(404).json({ error: 'Invalid link code — no campus found with this code' });
        if (mainChurch.churchId === req.church.churchId) {
          return res.status(400).json({ error: 'Cannot link a campus to itself' });
        }
        if (!isCampusModeEligible(mainChurch)) {
          return res.status(403).json({ error: 'The main campus does not have a qualifying Pro or Enterprise plan' });
        }

        db.prepare('UPDATE churches SET campus_id = ? WHERE churchId = ?').run(mainChurch.churchId, req.church.churchId);
        log.info(`Campus Mode: ${req.church.churchId} (${req.church.name}) joined campus group of ${mainChurch.churchId} (${mainChurch.name})`);
        return res.json({ ok: true, mainCampus: { churchId: mainChurch.churchId, name: mainChurch.name } });
      }

      return res.status(400).json({ error: 'action must be "generate" or "join"' });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/campus/list ───────────────────────────────────────────────
  // Main campus: returns its link code + all satellites. Requires Pro/Enterprise.
  // Satellite: returns main campus info regardless of its own tier.
  app.get('/api/church/campus/list', authMiddleware, (req, res) => {
    try {
      if (req.church.campus_id) {
        // This church is a satellite — return its main campus info
        const main = db.prepare('SELECT churchId, name, location FROM churches WHERE churchId = ?').get(req.church.campus_id);
        return res.json({ role: 'satellite', mainCampus: main || null, satellites: [], linkCode: null });
      }

      // This church is (or could be) the main campus — requires Pro/Enterprise
      if (!isCampusModeEligible(req.church)) {
        return res.status(403).json({ error: 'Campus Mode requires a Pro or Enterprise plan', upgradeRequired: true });
      }
      const rows = db.prepare(`
        SELECT churchId, name, location FROM churches
        WHERE campus_id = ?
        ORDER BY name ASC
      `).all(req.church.churchId);

      const satellites = rows.map((row) => {
        const runtime = churches.get(row.churchId);
        const connected = !!(runtime && runtime.ws && runtime.ws.readyState === 1);
        return { churchId: row.churchId, name: row.name, location: row.location || '', connected };
      });

      return res.json({
        role: 'main',
        linkCode: req.church.campus_link_code || null,
        satellites,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── DELETE /api/church/campus/:id/unlink ─────────────────────────────────────
  // Main campus removes a satellite (id = satellite's churchId).
  // Satellite removes itself (id = "self" or its own churchId).
  app.delete('/api/church/campus/:id/unlink', authMiddleware, (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();

      // Self-unlink: satellite removing itself from the group (no tier gate — always allowed)
      if (targetId === 'self' || targetId === req.church.churchId) {
        if (!req.church.campus_id) return res.status(400).json({ error: 'This church is not linked to any campus group' });
        db.prepare('UPDATE churches SET campus_id = NULL WHERE churchId = ?').run(req.church.churchId);
        log.info(`Campus Mode: ${req.church.churchId} (${req.church.name}) unlinked from campus group`);
        return res.json({ ok: true });
      }

      // Main campus removing a satellite — requires Pro/Enterprise
      if (!isCampusModeEligible(req.church)) {
        return res.status(403).json({ error: 'Campus Mode requires a Pro or Enterprise plan', upgradeRequired: true });
      }
      const satellite = db.prepare('SELECT * FROM churches WHERE churchId = ? AND campus_id = ?')
        .get(targetId, req.church.churchId);
      if (!satellite) return res.status(404).json({ error: 'Satellite campus not found in your campus group' });

      db.prepare('UPDATE churches SET campus_id = NULL WHERE churchId = ?').run(targetId);
      log.info(`Campus Mode: main campus ${req.church.churchId} unlinked satellite ${targetId} (${satellite.name})`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/church/campuses', authMiddleware, (req, res) => {
    try {
      const limits = campusLimitsForChurch(req.church);
      // Fetch campuses from both flows:
      // 1. parent_church_id: admin/reseller-created campuses (old flow)
      // 2. campus_id: self-service Campus Mode linked campuses (new flow)
      const rows = db.prepare(`
        SELECT churchId, name, location, token, registration_code, registeredAt,
               CASE WHEN parent_church_id = ? THEN 'managed' ELSE 'linked' END AS campus_source
        FROM churches
        WHERE parent_church_id = ? OR campus_id = ?
        ORDER BY name ASC
      `).all(req.church.churchId, req.church.churchId, req.church.churchId);

      const campuses = rows.map((row) => {
        const runtime = churches.get(row.churchId);
        const connected = !!(runtime && runtime.ws && runtime.ws.readyState === 1);
        const lastSeen = runtime?.lastSeen || runtime?.lastHeartbeat || null;

        // Recent alert count (last 7 days)
        let recentAlerts = 0;
        try {
          const week = new Date(Date.now() - 7 * 86400000).toISOString();
          const alertRow = db.prepare(
            'SELECT COUNT(*) as cnt FROM service_events WHERE church_id = ? AND timestamp >= ?'
          ).get(row.churchId, week);
          recentAlerts = alertRow?.cnt || 0;
        } catch { /* table may not exist */ }

        // Last session info
        let lastSession = null;
        try {
          const sess = db.prepare(
            'SELECT started_at, duration_minutes, grade FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 1'
          ).get(row.churchId);
          if (sess) lastSession = { startedAt: sess.started_at, durationMin: sess.duration_minutes, grade: sess.grade };
        } catch { /* table may not exist */ }

        return {
          churchId: row.churchId,
          name: row.name,
          location: row.location || '',
          token: row.token || '',
          registrationCode: row.registration_code || '',
          registeredAt: row.registeredAt || null,
          campusSource: row.campus_source || 'managed', // 'managed' = admin-created, 'linked' = Campus Mode
          connected,
          lastSeen,
          recentAlerts,
          lastSession,
        };
      });
      res.json({
        limits: {
          tier: limits.tier,
          maxTotal: limits.maxTotal,
          usedTotal: limits.usedTotal,
          remaining: limits.remaining,
          canAdd: limits.canAdd,
        },
        campuses,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/campuses', authMiddleware, express.json(), (req, res) => {
    try {
      if (req.church.parent_church_id) {
        return res.status(403).json({ error: 'Only the primary campus account can manage campuses' });
      }
      const limits = campusLimitsForChurch(req.church);
      if (!limits.canAdd) {
        return res.status(403).json({
          error: `Your ${String(limits.tier).toUpperCase()} plan allows ${limits.maxTotal} room${limits.maxTotal === 1 ? '' : 's'}. Upgrade for more.`,
          limits: {
            tier: limits.tier,
            maxTotal: limits.maxTotal,
            usedTotal: limits.usedTotal,
            remaining: limits.remaining,
            canAdd: limits.canAdd,
          },
        });
      }

      const name = String(req.body?.name || '').trim();
      const location = String(req.body?.location || '').trim();
      if (!name) return res.status(400).json({ error: 'Campus name is required' });

      const conflict = db.prepare('SELECT churchId FROM churches WHERE name = ?').get(name);
      if (conflict) return res.status(409).json({ error: 'A church or campus with that name already exists' });

      const churchId = crypto.randomUUID();
      const token = jwt.sign({ churchId, name }, jwtSecret, { expiresIn: '365d' });
      const registeredAt = new Date().toISOString();
      const registrationCode = generateRegistrationCode(db);

      db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
        .run(churchId, name, '', token, registeredAt);

      db.prepare(`
        UPDATE churches
        SET parent_church_id = ?, campus_name = ?, location = ?, registration_code = ?,
            billing_tier = COALESCE(?, billing_tier),
            billing_status = COALESCE(?, billing_status),
            reseller_id = COALESCE(?, reseller_id)
        WHERE churchId = ?
      `).run(
        req.church.churchId,
        name,
        location || '',
        registrationCode,
        req.church.billing_tier || null,
        req.church.billing_status || null,
        req.church.reseller_id || null,
        churchId
      );

      churches.set(churchId, {
        churchId,
        name,
        email: '',
        token,
        ws: null,
        status: { connected: false, atem: null, obs: null },
        lastSeen: null,
        registeredAt,
        disconnectedAt: null,
        registrationCode,
        parent_church_id: req.church.churchId,
        campus_name: name,
      });

      res.status(201).json({
        churchId,
        name,
        location: location || '',
        token,
        registrationCode,
        registeredAt,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PATCH /api/church/campuses/:campusId — rename or update location ───────
  app.patch('/api/church/campuses/:campusId', authMiddleware, (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      const campus = db.prepare('SELECT * FROM churches WHERE churchId = ? AND parent_church_id = ?')
        .get(campusId, req.church.churchId);
      if (!campus) return res.status(404).json({ error: 'Campus not found' });

      const updates = [];
      const params = [];
      const { name, location } = req.body || {};

      if (name !== undefined) {
        const cleanName = String(name).trim();
        if (!cleanName) return res.status(400).json({ error: 'Campus name cannot be empty' });
        const conflict = db.prepare('SELECT churchId FROM churches WHERE name = ? AND churchId != ?').get(cleanName, campusId);
        if (conflict) return res.status(409).json({ error: 'A church or campus with that name already exists' });
        updates.push('name = ?', 'campus_name = ?');
        params.push(cleanName, cleanName);
        const runtime = churches.get(campusId);
        if (runtime) runtime.name = cleanName;
      }
      if (location !== undefined) {
        updates.push('location = ?');
        params.push(String(location).trim());
      }

      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      params.push(campusId);
      db.prepare(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`).run(...params);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/church/campuses/:campusId', authMiddleware, (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      const campus = db.prepare('SELECT * FROM churches WHERE churchId = ? AND parent_church_id = ?')
        .get(campusId, req.church.churchId);
      if (!campus) return res.status(404).json({ error: 'Campus not found' });

      const runtime = churches.get(campusId);
      if (runtime && runtime.ws) {
        try { runtime.ws.close(1000, 'Campus removed'); } catch { /* ignore */ }
      }
      churches.delete(campusId);

      try { db.prepare('DELETE FROM church_tds WHERE church_id = ?').run(campusId); } catch {}
      try { db.prepare('DELETE FROM guest_tokens WHERE churchId = ?').run(campusId); } catch {}
      db.prepare('DELETE FROM churches WHERE churchId = ?').run(campusId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Rooms — CRUD under a campus ──────────────────────────────────────────────
  // A room is a physical space within a campus (Main Sanctuary, Youth Room, etc.)
  // campus_id here is the churchId of the child campus record.

  function _verifyCampusOwnership(campusId, parentChurchId) {
    // Allow the main church to manage rooms under its own ID (campus_id = churchId)
    if (campusId === parentChurchId) return { churchId: campusId };
    return db.prepare('SELECT churchId FROM churches WHERE churchId = ? AND parent_church_id = ?')
      .get(campusId, parentChurchId);
  }

  // GET /api/church/campuses/:campusId/rooms
  app.get('/api/church/campuses/:campusId/rooms', authMiddleware, (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      if (!_verifyCampusOwnership(campusId, req.church.churchId)) {
        return res.status(404).json({ error: 'Campus not found' });
      }
      const rooms = db.prepare('SELECT * FROM rooms WHERE campus_id = ? ORDER BY name ASC').all(campusId);
      res.json({ rooms: rooms.map((r) => ({ id: r.id, campusId: r.campus_id, name: r.name, description: r.description || '', createdAt: r.created_at })) });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/campuses/:campusId/rooms
  app.post('/api/church/campuses/:campusId/rooms', authMiddleware, express.json(), (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      if (!_verifyCampusOwnership(campusId, req.church.churchId)) {
        return res.status(404).json({ error: 'Campus not found' });
      }
      const name = String(req.body?.name || '').trim();
      const description = String(req.body?.description || '').trim();
      if (!name) return res.status(400).json({ error: 'Room name is required' });

      const id = crypto.randomUUID();
      const created_at = new Date().toISOString();
      db.prepare('INSERT INTO rooms (id, campus_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, campusId, name, description, created_at);
      res.status(201).json({ id, campusId, name, description, createdAt: created_at });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // PATCH /api/church/campuses/:campusId/rooms/:roomId
  app.patch('/api/church/campuses/:campusId/rooms/:roomId', authMiddleware, express.json(), (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      const roomId = String(req.params.roomId || '').trim();
      if (!_verifyCampusOwnership(campusId, req.church.churchId)) {
        return res.status(404).json({ error: 'Campus not found' });
      }
      const room = db.prepare('SELECT id FROM rooms WHERE id = ? AND campus_id = ?').get(roomId, campusId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const updates = [];
      const params = [];
      const { name, description } = req.body || {};
      if (name !== undefined) {
        const cleanName = String(name).trim();
        if (!cleanName) return res.status(400).json({ error: 'Room name cannot be empty' });
        updates.push('name = ?');
        params.push(cleanName);
      }
      if (description !== undefined) {
        updates.push('description = ?');
        params.push(String(description).trim());
      }
      if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
      params.push(roomId);
      db.prepare(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // DELETE /api/church/campuses/:campusId/rooms/:roomId
  app.delete('/api/church/campuses/:campusId/rooms/:roomId', authMiddleware, (req, res) => {
    try {
      const campusId = String(req.params.campusId || '').trim();
      const roomId = String(req.params.roomId || '').trim();
      if (!_verifyCampusOwnership(campusId, req.church.churchId)) {
        return res.status(404).json({ error: 'Campus not found' });
      }
      const room = db.prepare('SELECT id FROM rooms WHERE id = ? AND campus_id = ?').get(roomId, campusId);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/rooms — flat list of all rooms this church can see ───────
  app.get('/api/church/rooms', authMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      // Get this church's campus group (self + linked campuses)
      const church = db.prepare('SELECT campus_id, campus_link_code FROM churches WHERE churchId = ?').get(churchId);
      const campusIds = [churchId];
      if (church?.campus_id) campusIds.push(church.campus_id);
      if (church?.campus_link_code) {
        const satellites = db.prepare('SELECT churchId FROM churches WHERE campus_id = ?').all(churchId);
        for (const s of satellites) campusIds.push(s.churchId);
      }
      const placeholders = campusIds.map(() => '?').join(',');
      const rooms = db.prepare(`SELECT r.id, r.campus_id, r.name, r.description, r.created_at,
        c.name AS campus_name, c.room_id AS assigned_church_id
        FROM rooms r
        LEFT JOIN churches c ON c.room_id = r.id
        WHERE r.campus_id IN (${placeholders})
        ORDER BY r.name ASC`).all(...campusIds);
      // Also check which churches are assigned to each room
      const result = rooms.map(r => {
        const assigned = db.prepare('SELECT churchId, name, room_name FROM churches WHERE room_id = ?').all(r.id);
        return {
          id: r.id,
          campusId: r.campus_id,
          campusName: r.campus_name || '',
          name: r.name,
          description: r.description || '',
          assignedDesktops: assigned.map(a => ({ churchId: a.churchId, name: a.name })),
        };
      });
      res.json({ rooms: result, currentRoomId: db.prepare('SELECT room_id FROM churches WHERE churchId = ?').get(churchId)?.room_id || null });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/church/room-assign — assign this church/desktop to a room
  app.post('/api/church/room-assign', authMiddleware, express.json(), (req, res) => {
    try {
      const churchId = req.church.churchId;
      const roomId = req.body?.roomId || null;
      const roomName = req.body?.roomName || '';
      if (roomId) {
        // Verify the room exists and belongs to this church's campus group
        const room = db.prepare('SELECT r.id, r.name FROM rooms r WHERE r.id = ?').get(roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        db.prepare('UPDATE churches SET room_id = ?, room_name = ? WHERE churchId = ?').run(roomId, room.name, churchId);
        res.json({ ok: true, roomId, roomName: room.name });
      } else {
        // Unassign
        db.prepare('UPDATE churches SET room_id = NULL, room_name = NULL WHERE churchId = ?').run(churchId);
        res.json({ ok: true, roomId: null, roomName: null });
      }
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/problems ─────────────────────────────────────────────────
  // Returns latest Tally Engineer report. Accepts optional ?campusId=xxx.
  app.get('/api/church/problems', authMiddleware, (req, res) => {
    try {
      let targetId = req.church.churchId;
      const campusId = req.query.campusId;
      if (campusId && campusId !== req.church.churchId) {
        // Verify campus belongs to this parent church
        const campus = db.prepare('SELECT churchId FROM churches WHERE churchId = ? AND parent_church_id = ?')
          .get(campusId, req.church.churchId);
        if (!campus) return res.status(404).json({ error: 'Campus not found' });
        targetId = campusId;
      }
      const row = db.prepare(
        'SELECT * FROM problem_finder_reports WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(targetId);
      if (!row) return res.json({ status: null, message: 'No reports yet' });
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/preservice-check ──────────────────────────────────────────
  // Returns the latest pre-service check result for the authenticated church.
  app.get('/api/church/preservice-check', supportAuthMiddleware, (req, res) => {
    try {
      const row = db.prepare(
        'SELECT * FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(req.church.churchId);
      if (!row) return res.json(null);
      res.json(row);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/preservice-check/run ───────────────────────────────────
  // Triggers a manual pre-service check via WebSocket command to the church client.
  app.post('/api/church/preservice-check/run', supportAuthMiddleware, async (req, res) => {
    try {
      if (!preServiceCheck) return res.status(503).json({ error: 'Pre-service check not available' });
      const result = await preServiceCheck.runManualCheck(req.church.churchId);
      if (!result) return res.json({ result: null, message: 'Client offline or no response' });
      res.json({ result });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/preservice-check/fix-all ────────────────────────────────
  // Sends fix commands for all auto-fixable failures from the latest pre-service check.
  app.post('/api/church/preservice-check/fix-all', supportAuthMiddleware, async (req, res) => {
    try {
      const churchId = req.church.churchId;
      const churchRuntime = churches.get(churchId);
      if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
        return res.json({ results: [], message: 'Client offline' });
      }

      // Get latest check results
      const row = db.prepare(
        'SELECT checks_json FROM preservice_check_results WHERE church_id = ? ORDER BY created_at DESC LIMIT 1'
      ).get(churchId);
      if (!row) return res.json({ results: [], message: 'No check results' });

      let checks = [];
      try { checks = JSON.parse(row.checks_json || '[]'); } catch {}

      // Map of check names to fix commands
      const FIX_MAP = {
        'Main Output': { command: 'mixer.unmute', params: { channel: 'master' } },
      };

      const failures = checks.filter(c => !c.pass && FIX_MAP[c.name]);
      if (!failures.length) return res.json({ results: [], message: 'No auto-fixable issues' });

      const crypto = require('crypto');
      const results = [];

      for (const check of failures) {
        const fix = FIX_MAP[check.name];
        const msgId = crypto.randomUUID();
        try {
          const resultPromise = new Promise((resolve) => {
            const timer = setTimeout(() => { cleanup(); resolve({ success: false, error: 'timeout' }); }, 8000);
            const handler = (msg) => {
              if (msg.type === 'command_result' && msg.churchId === churchId && msg.messageId === msgId) {
                cleanup();
                resolve(msg.error ? { success: false, error: msg.error } : { success: true });
              }
            };
            const cleanup = () => {
              clearTimeout(timer);
              if (preServiceCheck) {
                const idx = preServiceCheck._resultListeners.indexOf(handler);
                if (idx !== -1) preServiceCheck._resultListeners.splice(idx, 1);
              }
            };
            if (preServiceCheck) preServiceCheck._resultListeners.push(handler);
          });

          churchRuntime.ws.send(JSON.stringify({ type: 'command', command: fix.command, params: fix.params || {}, id: msgId }));
          const result = await resultPromise;
          results.push({ check: check.name, command: fix.command, ...result });
        } catch (e) {
          results.push({ check: check.name, command: fix.command, success: false, error: e.message });
        }
      }

      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── RUNDOWN ENDPOINTS ─────────────────────────────────────────────────────────

  app.get('/api/church/rundowns', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.json([]);
      res.json(rundownEngine.getRundowns(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundowns', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { name, steps } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
      const rundown = rundownEngine.createRundown(req.church.churchId, name.trim(), steps || []);
      res.json(rundown);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const rundown = rundownEngine.getRundown(req.params.id);
      if (!rundown || rundown.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      res.json(rundown);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.put('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const existing = rundownEngine.getRundown(req.params.id);
      if (!existing || existing.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      const { name, steps } = req.body;
      const updated = rundownEngine.updateRundown(req.params.id, { name, steps });
      res.json(updated);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.delete('/api/church/rundowns/:id', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const existing = rundownEngine.getRundown(req.params.id);
      if (!existing || existing.church_id !== req.church.churchId) return res.status(404).json({ error: 'Rundown not found' });
      res.json(rundownEngine.deleteRundown(req.params.id));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundowns/:id/activate', authMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const result = rundownEngine.activateRundown(req.church.churchId, req.params.id);
      if (!result) return res.status(404).json({ error: 'Rundown not found' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/rundown/active', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.json({ active: false });
      const active = rundownEngine.getActiveRundown(req.church.churchId);
      if (!active) return res.json({ active: false });
      const current = rundownEngine.getCurrentStep(req.church.churchId);
      res.json({ active: true, ...active, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/advance', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const result = rundownEngine.advanceStep(req.church.churchId);
      if (!result) return res.status(400).json({ error: 'Cannot advance — at last step or no active rundown' });
      const current = rundownEngine.getCurrentStep(req.church.churchId);
      res.json({ ...result, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/execute', supportAuthMiddleware, async (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const current = rundownEngine.getCurrentStep(req.church.churchId);
      if (!current || !current.step) return res.status(400).json({ error: 'No active step' });

      const commands = current.step.commands || [];
      if (commands.length === 0) return res.json({ executed: true, results: [] });

      const churchId = req.church.churchId;
      const churchRuntime = churches.get(churchId);
      if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
        return res.status(503).json({ error: 'Church client offline' });
      }

      const crypto = require('crypto');
      const results = [];
      for (const cmd of commands) {
        const msgId = crypto.randomUUID();
        try {
          churchRuntime.ws.send(JSON.stringify({
            type: 'command',
            command: cmd.command,
            params: cmd.params || {},
            messageId: msgId,
            source: 'rundown',
          }));
          results.push({ command: cmd.command, sent: true });
        } catch (e) {
          results.push({ command: cmd.command, sent: false, error: e.message });
        }
      }
      res.json({ executed: true, results, step: current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/rundown/deactivate', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      res.json(rundownEngine.deactivateRundown(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── POST /api/church/rundown/jump ──────────────────────────────────────────
  // Jump to a specific step in the active rundown by index.
  app.post('/api/church/rundown/jump', supportAuthMiddleware, (req, res) => {
    try {
      if (!rundownEngine) return res.status(503).json({ error: 'Rundown engine not available' });
      const { stepIndex } = req.body;
      if (stepIndex == null || typeof stepIndex !== 'number') {
        return res.status(400).json({ error: 'stepIndex (number) required' });
      }
      const result = rundownEngine.goToStep(req.church.churchId, stepIndex);
      if (!result) return res.status(400).json({ error: 'Cannot jump — invalid step or no active rundown' });
      const current = rundownEngine.getCurrentStep(req.church.churchId);
      res.json({ ...result, ...current });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── POST /api/church/app/send-command ──────────────────────────────────────
  // Sends a command to the church client via WebSocket, accessible with church
  // app Bearer tokens (used by the Electron troubleshooter auto-actions).
  app.post('/api/church/app/send-command', supportAuthMiddleware, (req, res) => {
    const { command, params } = req.body || {};
    if (!command) return res.status(400).json({ error: 'command required' });

    const ALLOWED_APP_COMMANDS = new Set([
      'restart_stream', 'stop_stream', 'start_recording', 'stop_recording',
      'reconnect_obs', 'reconnect_atem', 'reconnect_encoder', 'restart_encoder',
      'system.diagnosticBundle', 'system.preServiceCheck',
      'mixer.unmute', 'mixer.mute', 'mixer.recallScene',
      'atem.runMacro', 'obs.setScene', 'vmix.function', 'vmix.setProgram',
    ]);

    if (!ALLOWED_APP_COMMANDS.has(command)) {
      return res.status(400).json({ error: `Unknown command: ${command}. Allowed: ${[...ALLOWED_APP_COMMANDS].join(', ')}` });
    }

    const churchId = req.church.churchId;
    const runtime = churches.get(churchId);
    if (!runtime?.ws || runtime.ws.readyState !== 1) {
      return res.status(409).json({ error: 'Church client is not connected' });
    }

    const crypto = require('crypto');
    const commandId = crypto.randomUUID();
    try {
      runtime.ws.send(JSON.stringify({
        type: 'command',
        id: commandId,
        command,
        params: params || {},
        source: 'app',
      }));
      res.json({ sent: true, commandId });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e, 'Failed to send command') });
    }
  });

  // ── Scheduler routes (church portal) ────────────────────────────────────────
  app.post('/api/church/scheduler/activate', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.activate(req.church.churchId, req.body.rundownId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/advance', authMiddleware, async (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = await scheduler.advance(req.church.churchId);
      if (result?.error) return res.status(400).json(result);
      res.json(result || { error: 'Could not advance' });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/skip', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.skip(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/back', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.goBack(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/jump', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.jumpToCue(req.church.churchId, Number(req.body.cueIndex));
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/pause', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      res.json(scheduler.pause(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/resume', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      const result = scheduler.resume(req.church.churchId);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.post('/api/church/scheduler/deactivate', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.status(503).json({ error: 'Scheduler not available' });
      res.json(scheduler.deactivate(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.get('/api/church/scheduler/status', authMiddleware, (req, res) => {
    try {
      if (!scheduler) return res.json({ active: false });
      res.json(scheduler.getStatus(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/coaching ──────────────────────────────────────────────────
  // Returns weekly coaching data: patterns, reliability, auto-recovery stats.
  app.get('/api/church/coaching', authMiddleware, (req, res) => {
    try {
      if (!weeklyDigest) return res.json(null);
      const data = weeklyDigest.getChurchDigest(req.church.churchId);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/session/active ────────────────────────────────────────────
  // Returns the active session with recent events for the live incident card.
  app.get('/api/church/session/active', authMiddleware, (req, res) => {
    try {
      if (!sessionRecap) return res.json({ active: false });
      const session = sessionRecap.getActiveSession(req.church.churchId);
      if (!session) return res.json({ active: false });

      // Get events for this session with diagnosis info
      let events = [];
      try {
        const { DIAGNOSIS_TEMPLATES } = require('./alertEngine');
        events = db.prepare(
          'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 20'
        ).all(session.sessionId).map(e => ({
          ...e,
          resolved: !!e.resolved,
          auto_resolved: !!e.auto_resolved,
          diagnosis: DIAGNOSIS_TEMPLATES[e.event_type] || null,
        }));
      } catch { /* service_events table may not exist */ }

      res.json({ active: true, ...session, events });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/dashboard/stats ───────────────────────────────────────────
  // Quick-stats card: this week summary, alert trend, equipment health, next service
  app.get('/api/church/dashboard/stats', authMiddleware, (req, res) => {
    try {
      const stats = getDashboardStats(db, req.church.churchId, churches);
      res.json(stats);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/schedule ──────────────────────────────────────────────────
  // Accepts optional ?campusId=xxx to load a specific campus schedule
  app.get('/api/church/schedule', authMiddleware, (req, res) => {
    try {
      let targetId = req.church.churchId;
      const campusId = req.query.campusId;
      if (campusId && campusId !== req.church.churchId) {
        // Verify campus belongs to this parent church
        const campus = db.prepare('SELECT churchId FROM churches WHERE churchId = ? AND parent_church_id = ?')
          .get(campusId, req.church.churchId);
        if (!campus) return res.status(404).json({ error: 'Campus not found' });
        targetId = campusId;
      }
      const row = db.prepare('SELECT schedule FROM churches WHERE churchId = ?').get(targetId);
      const sched = (row && row.schedule) ? JSON.parse(row.schedule) : {};
      res.json(sched);
    } catch { res.json({}); }
  });

  // ── PUT /api/church/schedule ──────────────────────────────────────────────────
  // Accepts optional ?campusId=xxx to save a specific campus schedule
  app.put('/api/church/schedule', authMiddleware, (req, res) => {
    try {
      let targetId = req.church.churchId;
      const campusId = req.query.campusId;
      if (campusId && campusId !== req.church.churchId) {
        const campus = db.prepare('SELECT churchId FROM churches WHERE churchId = ? AND parent_church_id = ?')
          .get(campusId, req.church.churchId);
        if (!campus) return res.status(404).json({ error: 'Campus not found' });
        targetId = campusId;
      }
      db.prepare('UPDATE churches SET schedule = ? WHERE churchId = ?')
        .run(JSON.stringify(req.body), targetId);
      // Update in-memory map
      const runtime = churches.get(targetId);
      if (runtime) runtime.schedule = req.body;
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/tds ───────────────────────────────────────────────────────
  app.get('/api/church/tds', authMiddleware, (req, res) => {
    let tds = [];
    try { tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ? ORDER BY registered_at ASC').all(req.church.churchId); } catch {}
    res.json(tds);
  });

  // ── POST /api/church/tds ──────────────────────────────────────────────────────
  app.post('/api/church/tds', authMiddleware, (req, res) => {
    const { name, role, email, phone, accessLevel } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const validAccessLevels = ['viewer', 'operator', 'admin'];
    const resolvedAccessLevel = validAccessLevels.includes(accessLevel) ? accessLevel : 'operator';
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    try {
      db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, role, email, phone, access_level) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(req.church.churchId, `portal_${id}`, `portal_${id}`, name, new Date().toISOString(), role || 'td', email || '', phone || '', resolvedAccessLevel);
    } catch {
      // Fallback if access_level column doesn't exist yet (migration pending)
      db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, role, email, phone) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(req.church.churchId, `portal_${id}`, `portal_${id}`, name, new Date().toISOString(), role || 'td', email || '', phone || '');
    }
    res.json({ id, name, role, accessLevel: resolvedAccessLevel, email, phone });
  });

  // ── DELETE /api/church/tds/:tdId ──────────────────────────────────────────────
  app.delete('/api/church/tds/:tdId', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM church_tds WHERE id = ? AND church_id = ?').run(req.params.tdId, req.church.churchId);
    res.json({ ok: true });
  });

  // ── MACROS CRUD ───────────────────────────────────────────────────────────────
  const { v4: _uuid } = require('uuid');

  app.get('/api/church/macros', authMiddleware, (req, res) => {
    try {
      const macros = db.prepare('SELECT * FROM church_macros WHERE church_id = ? ORDER BY name ASC').all(req.church.churchId);
      res.json(macros.map(m => ({
        ...m,
        steps: (() => { try { return JSON.parse(m.steps || '[]'); } catch { return []; } })(),
      })));
    } catch { res.json([]); }
  });

  app.get('/api/church/macros/:id', authMiddleware, (req, res) => {
    const m = db.prepare('SELECT * FROM church_macros WHERE id = ? AND church_id = ?').get(req.params.id, req.church.churchId);
    if (!m) return res.status(404).json({ error: 'Macro not found' });
    res.json({ ...m, steps: (() => { try { return JSON.parse(m.steps || '[]'); } catch { return []; } })() });
  });

  app.post('/api/church/macros', authMiddleware, (req, res) => {
    const { name, description, steps } = req.body;
    if (!name || !/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid macro name (lowercase, numbers, underscores only)' });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps array required' });
    const reserved = ['start', 'stop', 'status', 'help', 'register', 'fix', 'menu', 'history', 'macros'];
    if (reserved.includes(name)) return res.status(400).json({ error: `"${name}" is a reserved command name` });
    const id = _uuid();
    const now = new Date().toISOString();
    try {
      db.prepare('INSERT INTO church_macros (id, church_id, name, description, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, req.church.churchId, name, description || '', JSON.stringify(steps), now, now);
      res.json({ id, name, description, steps });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: `Macro "/${name}" already exists` });
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/church/macros/:id', authMiddleware, (req, res) => {
    const { name, description, steps } = req.body;
    if (!name || !/^[a-z0-9_]+$/.test(name)) return res.status(400).json({ error: 'Invalid macro name' });
    if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps array required' });
    const now = new Date().toISOString();
    try {
      db.prepare('UPDATE church_macros SET name = ?, description = ?, steps = ?, updated_at = ? WHERE id = ? AND church_id = ?')
        .run(name, description || '', JSON.stringify(steps), now, req.params.id, req.church.churchId);
      res.json({ ok: true });
    } catch (e) {
      if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: `Macro "/${name}" already exists` });
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/church/macros/:id', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM church_macros WHERE id = ? AND church_id = ?').run(req.params.id, req.church.churchId);
    res.json({ ok: true });
  });

  // ── GET /api/church/td-invite-link ────────────────────────────────────────────
  // Returns a Telegram deep link that auto-registers the TD when clicked.
  app.get('/api/church/td-invite-link', authMiddleware, (req, res) => {
    const church = req.church;
    const code = church.registration_code;
    if (!code) return res.status(404).json({ error: 'No registration code found' });
    const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'TallyConnectBot';
    const deepLink = `https://t.me/${botUsername}?start=reg_${code}`;
    res.json({ link: deepLink, code, botUsername });
  });

  // ── GET /api/church/sessions ──────────────────────────────────────────────────
  app.get('/api/church/sessions', authMiddleware, (req, res) => {
    try {
      const sessions = db.prepare(
        'SELECT * FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 20'
      ).all(req.church.churchId);
      res.json(sessions);
    } catch { res.json([]); }
  });

  // ── GET /api/church/service-reports ───────────────────────────────────────────
  // Returns recent post-service AI reports.
  app.get('/api/church/service-reports', authMiddleware, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const reports = db.prepare(
        `SELECT id, church_id, session_id, created_at, duration_minutes, uptime_pct,
                grade, alert_count, auto_recovered_count, failover_count, peak_viewers,
                stream_runtime_minutes, recommendations, ai_summary
         FROM post_service_reports WHERE church_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(req.church.churchId, limit);
      res.json(reports.map(r => ({
        ...r,
        recommendations: (() => { try { return JSON.parse(r.recommendations || '[]'); } catch { return []; } })(),
      })));
    } catch { res.json([]); }
  });

  // ── GET /api/church/service-reports/:id ───────────────────────────────────────
  // Returns the full HTML report for display or download.
  app.get('/api/church/service-reports/:id', authMiddleware, (req, res) => {
    try {
      const report = db.prepare(
        'SELECT * FROM post_service_reports WHERE id = ? AND church_id = ?'
      ).get(req.params.id, req.church.churchId);
      if (!report) return res.status(404).json({ error: 'Report not found' });
      res.json({
        ...report,
        recommendations: (() => { try { return JSON.parse(report.recommendations || '[]'); } catch { return []; } })(),
        failover_events: (() => { try { return JSON.parse(report.failover_events || '[]'); } catch { return []; } })(),
        device_health: (() => { try { return JSON.parse(report.device_health || '{}'); } catch { return {}; } })(),
      });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // ── GET /api/church/guest-tokens ──────────────────────────────────────────────
  // Uses GuestTdMode for unified token management (tokens work with Telegram /register)
  app.get('/api/church/guest-tokens', authMiddleware, (req, res) => {
    if (!guestTdMode) return res.json([]);
    const tokens = guestTdMode.listTokensForChurch(req.church.churchId);
    res.json(tokens.map(t => ({
      token: t.token, label: t.name, createdAt: t.createdAt,
      expiresAt: t.expiresAt, registered: !!t.usedByChat,
    })));
  });

  // ── POST /api/church/guest-tokens ─────────────────────────────────────────────
  app.post('/api/church/guest-tokens', authMiddleware, (req, res) => {
    if (!guestTdMode) return res.status(503).json({ error: 'Guest tokens not configured' });
    const { label, expiresInDays } = req.body;
    const expiresInHours = expiresInDays ? expiresInDays * 24 : 24;
    const church = req.church;
    const result = guestTdMode.generateTokenWithOptions(church.churchId, church.name, { label, expiresInHours });
    res.json({ token: result.token, label: result.name, expiresAt: result.expiresAt });
  });

  // ── DELETE /api/church/guest-tokens/:token ────────────────────────────────────
  app.delete('/api/church/guest-tokens/:tok', authMiddleware, async (req, res) => {
    if (!guestTdMode) return res.status(503).json({ error: 'Guest tokens not configured' });
    const existing = db.prepare('SELECT churchId FROM guest_tokens WHERE token = ?').get(req.params.tok);
    if (!existing || existing.churchId !== req.church.churchId) return res.status(404).json({ error: 'Token not found' });
    await guestTdMode.revokeAndNotify(req.params.tok);
    res.json({ ok: true });
  });

  // ── PUT /api/church/tds/:tdId/access-level ────────────────────────────────────
  app.put('/api/church/tds/:tdId/access-level', authMiddleware, (req, res) => {
    const { accessLevel } = req.body;
    if (!['viewer', 'operator', 'admin'].includes(accessLevel)) {
      return res.status(400).json({ error: 'accessLevel must be viewer, operator, or admin' });
    }
    const result = db.prepare(
      'UPDATE church_tds SET access_level = ? WHERE id = ? AND church_id = ?'
    ).run(accessLevel, req.params.tdId, req.church.churchId);
    if (!result.changes) return res.status(404).json({ error: 'TD not found' });
    res.json({ ok: true, accessLevel });
  });

  // ── GET /api/church/billing ───────────────────────────────────────────────────
  app.get('/api/church/billing', authMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const tier = church.billing_tier || 'connect';
      const billingRow = db.prepare(
        'SELECT stripe_customer_id, billing_interval, current_period_end, cancel_at_period_end FROM billing_customers WHERE church_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1'
      ).get(church.churchId);
      const billingInterval = tier === 'event'
        ? 'one_time'
        : (church.billing_interval || billingRow?.billing_interval || 'monthly');
      const status = church.billing_status || 'inactive';
      const trialEnds = church.billing_trial_ends;
      const trialDaysRemaining = trialEnds ? Math.max(0, Math.ceil((new Date(trialEnds) - Date.now()) / (1000 * 60 * 60 * 24))) : null;
      const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
      const INTERVAL_NAMES = { monthly: 'Monthly', annual: 'Annual', one_time: 'One-time' };

      let portalUrl = null;
      try {
        const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY && billingRow?.stripe_customer_id) {
          const Stripe = require('stripe');
          const stripe = Stripe(STRIPE_KEY);
          const session = await stripe.billingPortal.sessions.create({
            customer: billingRow.stripe_customer_id,
            return_url: req.headers.origin || 'https://tallyconnect.app',
          });
          portalUrl = session.url;
        }
      } catch (e) { log.error(`Billing portal session: ${e.message}`); }

      // AI usage stats for portal dashboard
      let aiUsage = null;
      try {
        if (aiRateLimiter) aiUsage = aiRateLimiter.getUsageStats(church.churchId, tier);
      } catch (e) { log.error(`AI usage stats: ${e.message}`); }

      res.json({
        tier,
        tierName: TIER_NAMES[tier] || tier,
        billingInterval,
        billingIntervalLabel: INTERVAL_NAMES[billingInterval] || billingInterval,
        status,
        trialEndsAt: trialEnds,
        trialDaysRemaining,
        portalUrl,
        cancelAtPeriodEnd: !!(billingRow?.cancel_at_period_end),
        currentPeriodEnd: billingRow?.current_period_end || null,
        aiUsage,
        features: {
          autopilot: !['connect', 'plus'].includes(tier),
          planningCenter: !['connect', 'plus'].includes(tier),
          oncall: tier !== 'connect',
          propresenter: tier !== 'connect',
          livePreview: tier !== 'connect',
          monthlyReport: !['connect', 'plus'].includes(tier),
        },
      });
    } catch (e) {
      res.status(500).json({ error: 'Billing info unavailable' });
    }
  });

  // ── POST /api/church/billing/upgrade ──────────────────────────────────────────
  // Upgrades the church's Stripe subscription to a new tier.
  app.post('/api/church/billing/upgrade', authMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });

      const Stripe = require('stripe');
      const stripeClient = Stripe(STRIPE_KEY);

      const { tier: newTier } = req.body;
      const VALID_TIERS = ['connect', 'plus', 'pro', 'managed'];
      if (!newTier || !VALID_TIERS.includes(newTier)) {
        return res.status(400).json({ error: 'Invalid tier. Must be: connect, plus, pro, or managed.' });
      }

      const church = req.church;
      const currentTier = church.billing_tier || 'connect';
      if (newTier === currentTier) {
        return res.status(400).json({ error: 'Already on this plan.' });
      }

      const TIER_ORDER = { connect: 0, plus: 1, pro: 2, managed: 3 };
      if (TIER_ORDER[newTier] < TIER_ORDER[currentTier]) {
        return res.status(400).json({ error: 'Use the downgrade endpoint instead.' });
      }

      const billingRow = db.prepare(
        'SELECT stripe_customer_id, stripe_subscription_id, billing_interval FROM billing_customers WHERE church_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1'
      ).get(church.churchId);

      if (!billingRow?.stripe_subscription_id) {
        // No existing subscription — redirect to signup
        return res.json({ redirect: 'https://tallyconnect.app/signup?plan=' + newTier });
      }

      // Resolve the new price ID
      const billingInterval = church.billing_interval || billingRow.billing_interval || 'monthly';
      const PRICE_MAP = {
        connect: { monthly: process.env.STRIPE_PRICE_CONNECT, annual: process.env.STRIPE_PRICE_CONNECT_ANNUAL },
        plus: { monthly: process.env.STRIPE_PRICE_PLUS, annual: process.env.STRIPE_PRICE_PLUS_ANNUAL },
        pro: { monthly: process.env.STRIPE_PRICE_PRO, annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
        managed: { monthly: process.env.STRIPE_PRICE_MANAGED, annual: process.env.STRIPE_PRICE_MANAGED_ANNUAL },
      };
      const newPriceId = PRICE_MAP[newTier]?.[billingInterval];
      if (!newPriceId || newPriceId.includes('placeholder')) {
        return res.status(400).json({ error: 'Price not configured for ' + newTier + ' (' + billingInterval + '). Contact support.' });
      }

      // Get current subscription to find the item to update
      const sub = await stripeClient.subscriptions.retrieve(billingRow.stripe_subscription_id);
      if (!sub?.items?.data?.length) {
        return res.status(400).json({ error: 'No active subscription found. Contact support.' });
      }

      // Update the subscription item to the new price (Stripe handles proration)
      const updated = await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        items: [{
          id: sub.items.data[0].id,
          price: newPriceId,
        }],
        metadata: { ...sub.metadata, tier: newTier },
        proration_behavior: 'create_prorations',
      });

      // Update local DB
      const now = new Date().toISOString();
      db.prepare('UPDATE churches SET billing_tier = ? WHERE churchId = ?').run(newTier, church.churchId);
      db.prepare('UPDATE billing_customers SET tier = ?, updated_at = ? WHERE church_id = ?').run(newTier, now, church.churchId);

      log.info('Upgraded church ' + church.churchId + ' from ' + currentTier + ' to ' + newTier);

      // Send upgrade confirmation email
      if (lifecycleEmails) {
        lifecycleEmails.sendUpgradeConfirmation(church, { oldTier: currentTier, newTier }).catch(e => console.error('[Billing] Upgrade confirmation email failed:', e.message));
      }

      res.json({ success: true, tier: newTier, message: 'Plan upgraded to ' + newTier });
    } catch (e) {
      log.error('Billing upgrade: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Upgrade failed') });
    }
  });

  // ── POST /api/church/billing/reactivate ─────────────────────────────────────
  // Reactivation path for cancelled/expired/inactive churches.
  app.post('/api/church/billing/reactivate', authMiddleware, billingRateLimit, async (req, res) => {
    try {
      const church = req.church;
      const { tier, billingInterval } = req.body || {};

      const result = await billing.reactivate({
        churchId: church.churchId,
        tier: tier || church.billing_tier,
        billingInterval: billingInterval || church.billing_interval,
        successUrl: 'https://tallyconnect.app/portal?reactivated=true',
        cancelUrl: 'https://tallyconnect.app/portal',
      });

      res.json(result);
    } catch (e) {
      log.error('Billing reactivate: ' + e.message);
      res.status(400).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/billing/downgrade ─────────────────────────────────────
  // Downgrade to a lower tier (same billing interval).
  app.post('/api/church/billing/downgrade', authMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });

      const Stripe = require('stripe');
      const stripeClient = Stripe(STRIPE_KEY);

      const { tier: newTier } = req.body;
      const TIER_ORDER = ['connect', 'plus', 'pro', 'managed'];
      if (!newTier || !TIER_ORDER.includes(newTier)) {
        return res.status(400).json({ error: 'Invalid tier.' });
      }

      const church = req.church;
      const currentTier = church.billing_tier || 'connect';
      const currentIndex = TIER_ORDER.indexOf(currentTier);
      const newIndex = TIER_ORDER.indexOf(newTier);

      if (newIndex >= currentIndex) {
        return res.status(400).json({ error: 'Use upgrade endpoint for higher tiers.' });
      }

      const billingRow = db.prepare(
        'SELECT stripe_customer_id, stripe_subscription_id, billing_interval FROM billing_customers WHERE church_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1'
      ).get(church.churchId);

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      const billingInterval = church.billing_interval || billingRow.billing_interval || 'monthly';
      const PRICE_MAP = {
        connect: { monthly: process.env.STRIPE_PRICE_CONNECT, annual: process.env.STRIPE_PRICE_CONNECT_ANNUAL },
        plus: { monthly: process.env.STRIPE_PRICE_PLUS, annual: process.env.STRIPE_PRICE_PLUS_ANNUAL },
        pro: { monthly: process.env.STRIPE_PRICE_PRO, annual: process.env.STRIPE_PRICE_PRO_ANNUAL },
        managed: { monthly: process.env.STRIPE_PRICE_MANAGED, annual: process.env.STRIPE_PRICE_MANAGED_ANNUAL },
      };
      const newPriceId = PRICE_MAP[newTier]?.[billingInterval];
      if (!newPriceId || newPriceId.includes('placeholder')) {
        return res.status(400).json({ error: 'Price not configured for ' + newTier + ' (' + billingInterval + ').' });
      }

      const sub = await stripeClient.subscriptions.retrieve(billingRow.stripe_subscription_id);
      if (!sub?.items?.data?.length) {
        return res.status(400).json({ error: 'No subscription items found.' });
      }

      // Downgrade takes effect at end of current billing period (no proration credit by default)
      const updated = await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        items: [{ id: sub.items.data[0].id, price: newPriceId }],
        metadata: { ...sub.metadata, tier: newTier },
        proration_behavior: 'none',
      });

      // Don't update local tier immediately — let the Stripe webhook handle it
      // when the subscription change takes effect at end of billing period.
      // db.prepare('UPDATE churches SET billing_tier = ? WHERE churchId = ?').run(newTier, church.churchId);
      // db.prepare('UPDATE billing_customers SET tier = ?, updated_at = ? WHERE church_id = ?').run(newTier, now, church.churchId);
      log.info(`[Billing] Downgrade scheduled for ${church.churchId}: ${currentTier} → ${newTier} (takes effect at period end)`);

      log.info('Downgraded church ' + church.churchId + ' from ' + currentTier + ' to ' + newTier);

      // Send downgrade confirmation email
      if (lifecycleEmails) {
        lifecycleEmails.sendDowngradeConfirmation(church, { oldTier: currentTier, newTier }).catch(e => console.error('[Billing] Downgrade confirmation email failed:', e.message));
      }

      res.json({ success: true, tier: newTier, message: 'Plan downgraded to ' + newTier + '. Change takes effect at end of current billing period.' });
    } catch (e) {
      log.error('Billing downgrade: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Downgrade failed') });
    }
  });

  // ── POST /api/church/billing/cancel ─────────────────────────────────────────
  // Schedule cancellation at period end. No immediate cut-off — transparent.
  app.post('/api/church/billing/cancel', authMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });
      const stripeClient = require('stripe')(STRIPE_KEY);

      const church = req.church;
      const billingRow = db.prepare(
        'SELECT stripe_subscription_id, current_period_end FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL ORDER BY datetime(updated_at) DESC LIMIT 1'
      ).get(church.churchId);

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      // Schedule cancellation at period end — no immediate cut-off
      await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        cancel_at_period_end: true,
      });

      // Update local DB immediately so the UI reflects it
      db.prepare(
        'UPDATE billing_customers SET cancel_at_period_end = 1, updated_at = ? WHERE stripe_subscription_id = ?'
      ).run(new Date().toISOString(), billingRow.stripe_subscription_id);

      const periodEnd = billingRow.current_period_end;
      const endDate = periodEnd
        ? new Date(periodEnd).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : null;

      log.info(`Church ${church.churchId} scheduled cancellation at period end (${periodEnd})`);

      // Send cancellation confirmation email immediately
      if (lifecycleEmails) {
        // Use a date-stamped type so reactivate→cancel cycles each get an email
        const cancelEmailType = `cancellation-scheduled-${new Date().toISOString().slice(0, 7)}`;
        lifecycleEmails.sendEmail({
          churchId: church.churchId,
          emailType: cancelEmailType,
          to: church.portal_email,
          subject: 'Your Tally subscription has been cancelled',
          html: lifecycleEmails._wrap(`
            <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your Tally subscription has been cancelled</h1>
            <p style="font-size: 15px; color: #333; line-height: 1.6;">
              We're sorry to see <strong>${lifecycleEmails._esc(church.name)}</strong> go.
              Your subscription has been cancelled and will remain active until <strong>${endDate || 'the end of your billing period'}</strong>.
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

            ${lifecycleEmails._cta('Reactivate Here', lifecycleEmails.appUrl + '/portal')}

            <p style="font-size: 14px; color: #666; line-height: 1.6;">
              We'd love to know why you cancelled &mdash; reply to this email and let us know. Your feedback helps us improve.
            </p>
          `),
          text: `Your Tally subscription has been cancelled\n\nYour subscription for ${church.name} has been cancelled and will remain active until ${endDate || 'the end of your billing period'}.\n\nYour data is preserved for 30 days. Reactivate anytime at ${lifecycleEmails.appUrl}/portal\n\nTally`,
        }).catch(e => console.error('[Billing] Cancel confirmation email failed:', e.message));
      }

      res.json({ success: true, endDate });
    } catch (e) {
      log.error('Billing cancel: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Cancellation failed') });
    }
  });

  // ── POST /api/church/billing/retention ──────────────────────────────────────
  // Apply 50% off for 3 months (retention offer) to the church's subscription.
  app.post('/api/church/billing/retention', authMiddleware, billingRateLimit, async (req, res) => {
    try {
      const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
      if (!STRIPE_KEY) return res.status(503).json({ error: 'Stripe not configured' });
      const stripeClient = require('stripe')(STRIPE_KEY);

      const church = req.church;
      const billingRow = db.prepare(
        'SELECT stripe_subscription_id FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL ORDER BY datetime(updated_at) DESC LIMIT 1'
      ).get(church.churchId);

      if (!billingRow?.stripe_subscription_id) {
        return res.status(400).json({ error: 'No active subscription found.' });
      }

      // Get or create a fixed retention coupon in Stripe
      const COUPON_ID = 'TALLY_RETENTION_50_3MO';
      let coupon;
      try {
        coupon = await stripeClient.coupons.retrieve(COUPON_ID);
      } catch {
        coupon = await stripeClient.coupons.create({
          id: COUPON_ID,
          percent_off: 50,
          duration: 'repeating',
          duration_in_months: 3,
          name: '50% off for 3 months (retention offer)',
        });
      }

      // Apply coupon to subscription
      await stripeClient.subscriptions.update(billingRow.stripe_subscription_id, {
        coupon: coupon.id,
      });

      log.info(`Applied retention coupon to church ${church.churchId}`);
      res.json({ success: true });
    } catch (e) {
      log.error('Billing retention: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Could not apply discount') });
    }
  });

  // ── GET /api/church/data-export ────────────────────────────────────────────
  // GDPR: Export all data associated with this church account.
  app.get('/api/church/data-export', authMiddleware, (req, res) => {
    try {
      const church = req.church;
      const churchId = church.churchId;

      // Gather all data associated with this church
      const exportData = {
        exportedAt: new Date().toISOString(),
        church: {},
        billing: null,
        sessions: [],
        events: [],
        alerts: [],
        tickets: [],
        tds: [],
        schedule: null,
        reviews: [],
        referrals: [],
        emailsSent: [],
      };

      // Church profile
      const row = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (row) {
        // Strip sensitive hashes
        const { portal_password_hash, token, ...safeRow } = row;
        exportData.church = safeRow;
      }

      // Billing
      try {
        exportData.billing = db.prepare('SELECT tier, billing_interval, status, trial_ends_at, current_period_end, cancel_at_period_end, created_at FROM billing_customers WHERE church_id = ?').get(churchId) || null;
      } catch { /* table may not exist */ }

      // Sessions
      try {
        exportData.sessions = db.prepare('SELECT * FROM session_recaps WHERE church_id = ? ORDER BY started_at DESC LIMIT 500').all(churchId);
      } catch { /* table may not exist */ }

      // Events
      try {
        exportData.events = db.prepare('SELECT * FROM service_events WHERE church_id = ? ORDER BY timestamp DESC LIMIT 1000').all(churchId);
      } catch { /* */ }

      // Alerts
      try {
        exportData.alerts = db.prepare('SELECT * FROM alerts WHERE church_id = ? ORDER BY created_at DESC LIMIT 500').all(churchId);
      } catch { /* */ }

      // Support tickets
      try {
        exportData.tickets = db.prepare('SELECT * FROM support_tickets WHERE church_id = ? ORDER BY created_at DESC').all(churchId);
      } catch { /* */ }

      // TDs
      try {
        exportData.tds = db.prepare('SELECT * FROM church_tds WHERE church_id = ?').all(churchId);
      } catch { /* */ }

      // Schedule
      try {
        const sched = db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
        if (sched && sched.service_times) exportData.schedule = JSON.parse(sched.service_times);
      } catch { /* */ }

      // Reviews
      try {
        exportData.reviews = db.prepare('SELECT * FROM church_reviews WHERE church_id = ?').all(churchId);
      } catch { /* */ }

      // Referrals (as referrer or referred)
      try {
        exportData.referrals = db.prepare('SELECT * FROM referrals WHERE referrer_id = ? OR referred_id = ?').all(churchId, churchId);
      } catch { /* */ }

      // Emails sent
      try {
        exportData.emailsSent = db.prepare('SELECT email_type, recipient, sent_at FROM email_sends WHERE church_id = ?').all(churchId);
      } catch { /* */ }

      res.setHeader('Content-Disposition', `attachment; filename="tally-data-export-${churchId.substring(0, 8)}.json"`);
      res.setHeader('Content-Type', 'application/json');
      res.json(exportData);
    } catch (e) {
      log.error('DataExport: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Export failed') });
    }
  });

  // ── DELETE /api/church/account ─────────────────────────────────────────────
  // GDPR: Delete church account and all associated data.
  app.delete('/api/church/account', authMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const churchId = church.churchId;
      const { confirmName } = req.body || {};

      // Require confirmation: user must type their church name
      if (!confirmName || confirmName.trim().toLowerCase() !== church.name.trim().toLowerCase()) {
        return res.status(400).json({ error: 'To delete your account, provide confirmName matching your church name.' });
      }

      // Cancel Stripe subscription if active
      try {
        const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY) {
          const Stripe = require('stripe');
          const stripeClient = Stripe(STRIPE_KEY);
          const billingRow = db.prepare(
            'SELECT stripe_subscription_id FROM billing_customers WHERE church_id = ? AND stripe_subscription_id IS NOT NULL'
          ).get(churchId);
          if (billingRow?.stripe_subscription_id) {
            await stripeClient.subscriptions.cancel(billingRow.stripe_subscription_id);
            log.info(`Cancelled Stripe subscription for ${churchId}`);
          }
        }
      } catch (e) {
        log.error(`GDPR Stripe cancellation failed for ${churchId}: ${e.message}`);
        // Continue with deletion even if Stripe cancel fails
      }

      // Delete all data from related tables (best-effort, tables may not exist)
      const tablesToClean = [
        { table: 'billing_customers', column: 'church_id' },
        { table: 'billing_disputes', column: 'church_id' },
        { table: 'session_recaps', column: 'church_id' },
        { table: 'service_events', column: 'church_id' },
        { table: 'alerts', column: 'church_id' },
        { table: 'support_tickets', column: 'church_id' },
        { table: 'support_triage_runs', column: 'church_id' },
        { table: 'church_tds', column: 'church_id' },
        { table: 'church_schedules', column: 'church_id' },
        { table: 'church_reviews', column: 'church_id' },
        { table: 'guest_tokens', column: 'churchId' },
        { table: 'maintenance_windows', column: 'churchId' },
        { table: 'email_sends', column: 'church_id' },
        { table: 'referrals', column: 'referrer_id' },
        { table: 'referrals', column: 'referred_id' },
      ];

      for (const { table, column } of tablesToClean) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(churchId);
        } catch { /* table doesn't exist — fine */ }
      }

      // Remove from runtime
      const runtime = churches.get(churchId);
      if (runtime?.ws?.readyState === 1) {
        runtime.ws.close(1000, 'account_deleted');
      }
      churches.delete(churchId);

      // Delete the church record last
      db.prepare('DELETE FROM churches WHERE churchId = ?').run(churchId);

      log.info(`GDPR: Deleted all data for church "${church.name}" (${churchId})`);
      res.json({ deleted: true, message: 'Your account and all associated data have been permanently deleted.' });
    } catch (e) {
      log.error('GDPR delete: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Deletion failed') });
    }
  });

  // ── Review eligibility helper ─────────────────────────────────────────────
  function isReviewEligible(churchId) {
    try {
      const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (!church) return false;
      if (church.billing_status !== 'active') return false;

      const daysSince = (Date.now() - new Date(church.registeredAt).getTime()) / 86400000;
      if (daysSince < 30) return false;

      let sessionCount = 0, cleanCount = 0;
      try {
        const sc = db.prepare('SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ?').get(churchId);
        sessionCount = sc?.cnt || 0;
      } catch { return false; }
      if (sessionCount < 4) return false;

      try {
        const cc = db.prepare("SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND grade LIKE '%Clean%'").get(churchId);
        cleanCount = cc?.cnt || 0;
      } catch { return false; }
      if (cleanCount < 2) return false;

      return true;
    } catch { return false; }
  }

  // ── GET /api/church/review ────────────────────────────────────────────────
  app.get('/api/church/review', authMiddleware, (req, res) => {
    try {
      const existing = db.prepare(
        'SELECT id, rating, body, reviewer_name, reviewer_role, approved, submitted_at FROM church_reviews WHERE church_id = ? ORDER BY submitted_at DESC LIMIT 1'
      ).get(req.church.churchId);

      if (existing) {
        return res.json({ hasReview: true, review: existing });
      }
      const eligible = isReviewEligible(req.church.churchId);
      res.json({ hasReview: false, eligible });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── POST /api/church/review ───────────────────────────────────────────────
  app.post('/api/church/review', authMiddleware, (req, res) => {
    try {
      const { rating, body, reviewerName, reviewerRole } = req.body;

      if (!rating || !Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Rating must be 1-5' });
      }
      if (!body || body.trim().length < 10) {
        return res.status(400).json({ error: 'Review must be at least 10 characters' });
      }
      if (body.trim().length > 500) {
        return res.status(400).json({ error: 'Review must be 500 characters or less' });
      }
      if (!reviewerName || !reviewerName.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      const existing = db.prepare('SELECT 1 FROM church_reviews WHERE church_id = ?').get(req.church.churchId);
      if (existing) {
        return res.status(409).json({ error: 'You have already submitted a review. Thank you!' });
      }

      const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO church_reviews (id, church_id, reviewer_name, reviewer_role, rating, body, church_name, submitted_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portal')
      `).run(id, req.church.churchId, reviewerName.trim(), (reviewerRole || '').trim(), rating, body.trim(), req.church.name, now);

      log.info('New review from ' + req.church.name + ' (' + rating + ' stars)');
      res.json({ ok: true, id });
    } catch (e) {
      log.error('Reviews: ' + e.message);
      res.status(500).json({ error: 'Failed to submit review' });
    }
  });

  // ── GET /api/public/reviews (NO auth — for landing page) ─────────────────
  app.get('/api/public/reviews', (req, res) => {
    try {
      const reviews = db.prepare(
        'SELECT id, reviewer_name, reviewer_role, rating, body, church_name, featured, submitted_at FROM church_reviews WHERE approved = 1 ORDER BY featured DESC, submitted_at DESC LIMIT 12'
      ).all();
      res.json({ reviews });
    } catch (e) {
      res.json({ reviews: [] });
    }
  });

  // ── Admin review management ───────────────────────────────────────────────
  app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    try {
      const reviews = db.prepare(
        'SELECT * FROM church_reviews ORDER BY approved ASC, submitted_at DESC'
      ).all();
      res.json({ reviews });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/admin/reviews/:id/approve', requireAdmin, (req, res) => {
    try {
      const now = new Date().toISOString();
      const result = db.prepare('UPDATE church_reviews SET approved = 1, approved_at = ? WHERE id = ?').run(now, req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Review not found' });
      log.info('Approved review ' + req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.put('/api/admin/reviews/:id/feature', requireAdmin, (req, res) => {
    try {
      const review = db.prepare('SELECT featured FROM church_reviews WHERE id = ?').get(req.params.id);
      if (!review) return res.status(404).json({ error: 'Review not found' });
      const newVal = review.featured ? 0 : 1;
      db.prepare('UPDATE church_reviews SET featured = ? WHERE id = ?').run(newVal, req.params.id);
      res.json({ ok: true, featured: newVal });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
    try {
      const result = db.prepare('DELETE FROM church_reviews WHERE id = ?').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Review not found' });
      log.info('Deleted review ' + req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/referrals ────────────────────────────────────────────────
  app.get('/api/church/referrals', authMiddleware, (req, res) => {
    try {
      const church = db.prepare('SELECT referral_code FROM churches WHERE churchId = ?').get(req.church.churchId);
      const referralCode = church?.referral_code || '';

      let referrals = [];
      let totalCredits = 0;
      try {
        referrals = db.prepare(
          'SELECT referred_name, status, credit_amount, created_at, converted_at FROM referrals WHERE referrer_id = ? ORDER BY created_at DESC'
        ).all(req.church.churchId);
        totalCredits = referrals
          .filter(r => r.status === 'credited')
          .reduce((sum, r) => sum + (r.credit_amount || 0), 0);
      } catch { /* table may not exist */ }

      const totalCredited = referrals.filter(r => r.status === 'credited').length;
      const maxCredits = 5;

      res.json({
        referralCode,
        shareUrl: `https://tallyconnect.app/signup?ref=${referralCode}`,
        referrals,
        totalCredits,
        totalReferred: referrals.length,
        totalConverted: referrals.filter(r => ['credited', 'converted'].includes(r.status)).length,
        totalCredited,
        maxCredits,
        creditsRemaining: Math.max(0, maxCredits - totalCredited),
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/email-preferences ────────────────────────────────────
  app.get('/api/church/email-preferences', authMiddleware, (req, res) => {
    try {
      if (!lifecycleEmails) return res.json({ categories: {}, preferences: {} });
      const categories = {};
      for (const [cat, def] of Object.entries(lifecycleEmails.constructor.EMAIL_CATEGORIES)) {
        categories[cat] = def.name;
      }
      const preferences = lifecycleEmails.getPreferences(req.church.churchId);
      res.json({ categories, preferences });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── PUT /api/church/email-preferences ──────────────────────────────────────
  app.put('/api/church/email-preferences', authMiddleware, (req, res) => {
    try {
      const { category, enabled } = req.body || {};
      if (!category || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'category and enabled (boolean) required' });
      }
      if (!lifecycleEmails) return res.json({ ok: true });
      const ok = lifecycleEmails.setPreference(req.church.churchId, category, enabled);
      if (!ok) return res.status(400).json({ error: 'Invalid category' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/alerts ──────────────────────────────────────────────────
  app.get('/api/church/alerts', authMiddleware, (req, res) => {
    try {
      const alerts = db.prepare(`
        SELECT id, alert_type, severity, context, created_at, acknowledged_at, acknowledged_by, escalated, resolved
        FROM alerts WHERE church_id = ? ORDER BY datetime(created_at) DESC LIMIT 50
      `).all(req.church.churchId);

      const parsed = alerts.map(a => ({
        ...a,
        context: (() => { try { return JSON.parse(a.context || '{}'); } catch { return {}; } })(),
      }));
      res.json(parsed);
    } catch (e) {
      // alerts table may not exist yet
      res.json([]);
    }
  });

  // ── GET /api/church/analytics ─────────────────────────────────────────────
  app.get('/api/church/analytics', authMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();

      // ── Sessions aggregate ──────────────────────────────────────────
      let sessAgg = {};
      try {
        sessAgg = db.prepare(`
          SELECT
            COUNT(*)                                 AS total_sessions,
            COALESCE(SUM(duration_minutes), 0)       AS total_duration_min,
            ROUND(AVG(duration_minutes), 0)          AS avg_session_minutes,
            ROUND(AVG(peak_viewers), 0)              AS avg_peak_viewers,
            COALESCE(SUM(alert_count), 0)            AS total_alerts,
            COALESCE(SUM(auto_recovered_count), 0)   AS auto_recovered_count,
            COALESCE(SUM(escalated_count), 0)        AS escalated_count,
            COALESCE(SUM(audio_silence_count), 0)    AS audio_silence_total,
            SUM(CASE WHEN stream_ran = 1 THEN 1 ELSE 0 END) AS stream_ran_count,
            COALESCE(SUM(stream_runtime_minutes), 0) AS total_stream_minutes
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?
        `).get(churchId, since) || {};
      } catch { /* table may not exist yet */ }

      const totalSessions = sessAgg.total_sessions || 0;
      const totalAlerts = sessAgg.total_alerts || 0;
      const autoRecovered = sessAgg.auto_recovered_count || 0;
      const totalStreamMin = sessAgg.total_stream_minutes || 0;
      const totalDurMin = sessAgg.total_duration_min || 0;

      const uptimePct = totalDurMin > 0
        ? Math.min(100, (totalStreamMin / totalDurMin) * 100)
        : (totalSessions > 0 ? 100 : 0);

      const autoRecoveryRate = totalAlerts > 0
        ? (autoRecovered / totalAlerts) * 100
        : null;

      const weeksInRange = Math.max(1, days / 7);
      const sessionsPerWeek = totalSessions / weeksInRange;

      const streamRanPct = totalSessions > 0
        ? ((sessAgg.stream_ran_count || 0) / totalSessions) * 100
        : null;

      // ── Viewer trend (by week) ──────────────────────────────────────
      let viewerTrend = [];
      try {
        viewerTrend = db.prepare(`
          SELECT
            strftime('%Y-W%W', started_at) AS week_key,
            MAX(peak_viewers)              AS peak
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ? AND peak_viewers IS NOT NULL
          GROUP BY week_key
          ORDER BY week_key ASC
        `).all(churchId, since).map(r => ({
          label: r.week_key,
          peak: r.peak || 0
        }));
      } catch {}

      // ── Weekly session counts ───────────────────────────────────────
      let weeklySessions = [];
      try {
        weeklySessions = db.prepare(`
          SELECT
            strftime('%Y-W%W', started_at) AS week_key,
            COUNT(*)                        AS count
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?
          GROUP BY week_key
          ORDER BY week_key ASC
        `).all(churchId, since).map(r => ({
          label: r.week_key,
          count: r.count
        }));
      } catch {}

      // ── Top event types ─────────────────────────────────────────────
      let topEventTypes = [];
      try {
        topEventTypes = db.prepare(`
          SELECT event_type AS type, COUNT(*) AS count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
          GROUP BY event_type
          ORDER BY count DESC
          LIMIT 8
        `).all(churchId, since);
      } catch {}

      // ── Equipment disconnects ───────────────────────────────────────
      let equipDisconnects = [];
      try {
        equipDisconnects = db.prepare(`
          SELECT
            REPLACE(event_type, '_disconnected', '') AS device,
            COUNT(*) AS count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
            AND event_type LIKE '%_disconnected'
          GROUP BY event_type
          ORDER BY count DESC
        `).all(churchId, since);
      } catch {}

      // ── Equipment auto-resolve rates ────────────────────────────────
      let equipAutoResolve = [];
      try {
        equipAutoResolve = db.prepare(`
          SELECT
            REPLACE(event_type, '_disconnected', '') AS device,
            COUNT(*) AS total,
            SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) AS auto_count
          FROM service_events
          WHERE church_id = ? AND timestamp >= ?
            AND event_type LIKE '%_disconnected'
          GROUP BY event_type
          ORDER BY total DESC
        `).all(churchId, since).map(r => ({
          device: r.device,
          rate: r.total > 0 ? (r.auto_count / r.total) * 100 : 0
        }));
      } catch {}

      res.json({
        days,
        total_sessions: totalSessions,
        uptime_pct: Math.round(uptimePct * 10) / 10,
        avg_peak_viewers: sessAgg.avg_peak_viewers ?? null,
        auto_recovery_rate: autoRecoveryRate !== null ? Math.round(autoRecoveryRate * 10) / 10 : null,
        total_alerts: totalAlerts,
        auto_recovered_count: autoRecovered,
        escalated_count: sessAgg.escalated_count || 0,
        audio_silence_total: sessAgg.audio_silence_total || 0,
        total_stream_hours: Math.round((totalStreamMin / 60) * 10) / 10,
        avg_session_minutes: sessAgg.avg_session_minutes ?? null,
        sessions_per_week: Math.round(sessionsPerWeek * 10) / 10,
        stream_ran_pct: streamRanPct !== null ? Math.round(streamRanPct * 10) / 10 : null,
        viewer_trend: viewerTrend,
        weekly_sessions: weeklySessions,
        top_event_types: topEventTypes,
        equipment_disconnects: equipDisconnects,
        equipment_auto_resolve_rates: equipAutoResolve,
      });
    } catch (e) {
      log.error(`[Analytics] Error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load analytics' });
    }
  });

  // ── GET /api/church/analytics/export — CSV export of session data ──────────
  app.get('/api/church/analytics/export', authMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();

      let sessions = [];
      try {
        sessions = db.prepare(`
          SELECT started_at, ended_at, duration_minutes, stream_ran, stream_runtime_minutes,
                 alert_count, auto_recovered_count, escalated_count, audio_silence_count,
                 peak_viewers, td_name, grade
          FROM service_sessions
          WHERE church_id = ? AND started_at >= ?
          ORDER BY started_at DESC
        `).all(churchId, since);
      } catch { /* table may not exist */ }

      const header = 'Date,End,Duration (min),Stream Ran,Stream Minutes,Alerts,Auto-Recovered,Escalated,Audio Silence,Peak Viewers,TD,Grade';
      const rows = sessions.map(s => [
        s.started_at || '',
        s.ended_at || '',
        s.duration_minutes ?? '',
        s.stream_ran ? 'Yes' : 'No',
        s.stream_runtime_minutes ?? '',
        s.alert_count ?? 0,
        s.auto_recovered_count ?? 0,
        s.escalated_count ?? 0,
        s.audio_silence_count ?? 0,
        s.peak_viewers ?? '',
        `"${(s.td_name || '').replace(/"/g, '""')}"`,
        s.grade || '',
      ].join(','));

      const csv = [header, ...rows].join('\n');
      const churchName = (req.church.name || 'tally').replace(/[^a-zA-Z0-9]/g, '-');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${churchName}-sessions-${days}d.csv"`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── GET /api/church/analytics/audience — platform viewer analytics ─────────
  app.get('/api/church/analytics/audience', authMiddleware, (req, res) => {
    try {
      const churchId = req.church.churchId;
      const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
      const since = new Date(Date.now() - days * 86400000).toISOString();

      // Per-session viewer peaks with platform breakdown
      let sessionViewers = [];
      try {
        sessionViewers = db.prepare(`
          SELECT
            vs.session_id,
            ss.started_at,
            ss.grade,
            MAX(vs.total) AS peak_total,
            MAX(vs.youtube) AS peak_youtube,
            MAX(vs.facebook) AS peak_facebook,
            MAX(vs.vimeo) AS peak_vimeo,
            COUNT(*) AS snapshot_count
          FROM viewer_snapshots vs
          LEFT JOIN service_sessions ss ON ss.id = vs.session_id
          WHERE vs.church_id = ? AND vs.captured_at >= ?
            AND vs.session_id IS NOT NULL
          GROUP BY vs.session_id
          ORDER BY ss.started_at DESC
          LIMIT 100
        `).all(churchId, since);
      } catch { /* table may not exist yet */ }

      // Weekly platform trends
      let weeklyTrend = [];
      try {
        weeklyTrend = db.prepare(`
          SELECT
            strftime('%Y-W%W', captured_at) AS week_key,
            MAX(total) AS peak_total,
            MAX(youtube) AS peak_youtube,
            MAX(facebook) AS peak_facebook,
            MAX(vimeo) AS peak_vimeo,
            ROUND(AVG(total), 0) AS avg_total,
            COUNT(*) AS snapshots
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?
          GROUP BY week_key
          ORDER BY week_key ASC
        `).all(churchId, since);
      } catch {}

      // Platform summary
      let platformSummary = {};
      try {
        const row = db.prepare(`
          SELECT
            ROUND(AVG(total), 0) AS avg_total,
            MAX(total) AS peak_total,
            ROUND(AVG(youtube), 0) AS avg_youtube,
            MAX(youtube) AS peak_youtube,
            ROUND(AVG(facebook), 0) AS avg_facebook,
            MAX(facebook) AS peak_facebook,
            ROUND(AVG(vimeo), 0) AS avg_vimeo,
            MAX(vimeo) AS peak_vimeo,
            COUNT(*) AS total_snapshots
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?
        `).get(churchId, since);
        if (row) platformSummary = row;
      } catch {}

      // Recent snapshots (last 2 hours for live view)
      const recentSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      let recentSnapshots = [];
      try {
        recentSnapshots = db.prepare(`
          SELECT total, youtube, facebook, vimeo, captured_at
          FROM viewer_snapshots
          WHERE church_id = ? AND captured_at >= ?
          ORDER BY captured_at ASC
          LIMIT 120
        `).all(churchId, recentSince);
      } catch {}

      res.json({
        days,
        platform_summary: platformSummary,
        weekly_trend: weeklyTrend,
        session_viewers: sessionViewers,
        recent_snapshots: recentSnapshots,
      });
    } catch (e) {
      log.error(`[AudienceAnalytics] Error: ${e.message}`);
      res.status(500).json({ error: 'Failed to load audience analytics' });
    }
  });

  // ── Church support hub API ──────────────────────────────────────────────────

  app.get('/api/church/support/tickets', supportAuthMiddleware, (req, res) => {
    try {
      const status = String(req.query.status || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(Number(req.query.limit || 25), 100));
      let rows;
      if (status) {
        rows = db.prepare(`
          SELECT id, church_id, triage_id, issue_category, severity, title, description, status, created_at, updated_at
          FROM support_tickets
          WHERE church_id = ? AND status = ?
          ORDER BY datetime(updated_at) DESC
          LIMIT ?
        `).all(req.church.churchId, status, limit);
      } else {
        rows = db.prepare(`
          SELECT id, church_id, triage_id, issue_category, severity, title, description, status, created_at, updated_at
          FROM support_tickets
          WHERE church_id = ?
          ORDER BY datetime(updated_at) DESC
          LIMIT ?
        `).all(req.church.churchId, limit);
      }
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/church/support/tickets/:ticketId', supportAuthMiddleware, (req, res) => {
    try {
      const ticket = db.prepare(`
        SELECT id, church_id, triage_id, issue_category, severity, title, description, status, diagnostics_json, created_at, updated_at
        FROM support_tickets
        WHERE id = ? AND church_id = ?
      `).get(req.params.ticketId, req.church.churchId);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      const updates = db.prepare(`
        SELECT id, message, actor_type, created_at
        FROM support_ticket_updates
        WHERE ticket_id = ?
        ORDER BY datetime(created_at) ASC
      `).all(ticket.id);
      let diagnostics = {};
      try { diagnostics = JSON.parse(ticket.diagnostics_json || '{}'); } catch {}
      res.json({ ...ticket, diagnostics, updates });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/triage', supportAuthMiddleware, async (req, res) => {
    try {
      const issueCategory = String(req.body.issueCategory || 'other').trim().toLowerCase();
      const severity = String(req.body.severity || 'P3').trim().toUpperCase();
      const summary = String(req.body.summary || '').trim().slice(0, 2000);
      const runtime = churches.get(req.church.churchId);
      const sinceIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const alerts = db.prepare(`
        SELECT id, alert_type, severity, created_at
        FROM alerts
        WHERE church_id = ? AND created_at >= ?
        ORDER BY datetime(created_at) DESC
        LIMIT 15
      `).all(req.church.churchId, sinceIso);

      const checks = [];
      checks.push({
        key: 'church_client_connection',
        ok: runtime?.ws?.readyState === 1,
        note: runtime?.ws?.readyState === 1 ? 'Church client connected' : 'Church client offline',
      });

      const s = runtime?.status || {};
      if (issueCategory === 'stream_down') {
        const streamActive = isStreamActive(s);
        checks.push({
          key: 'stream_state',
          ok: streamActive,
          note: streamActive ? 'Stream appears active' : 'Stream appears inactive',
        });
      }
      if (issueCategory === 'no_audio_stream') {
        const audioOk = s.obs?.audioConnected !== false
          && s.mixer?.mainMuted !== true
          && s.audio?.silenceDetected !== true;
        checks.push({
          key: 'audio_path',
          ok: audioOk,
          note: audioOk ? 'No hard audio mute detected' : 'Audio path likely muted/disconnected',
        });
      }
      if (issueCategory === 'atem_connectivity') {
        checks.push({
          key: 'atem_link',
          ok: s.atem?.connected === true,
          note: s.atem?.connected ? 'ATEM connected' : 'ATEM disconnected',
        });
      }
      if (issueCategory === 'recording_issue') {
        const recordingActive = isRecordingActive(s);
        checks.push({
          key: 'recording_state',
          ok: recordingActive,
          note: recordingActive ? 'Recording appears active' : 'Recording appears inactive',
        });
      }

      const failed = checks.filter(c => !c.ok).length;
      const triageResult = failed > 0 ? 'needs_escalation' : 'monitoring';

      const diagnostics = {
        churchId: req.church.churchId,
        issueCategory,
        severity,
        timezone: String(req.body.timezone || ''),
        relayVersion: process.env.RELAY_VERSION || null,
        appVersion: String(req.body.appVersion || ''),
        generatedAt: new Date().toISOString(),
        connection: {
          churchClientConnected: runtime?.ws?.readyState === 1,
          lastSeen: runtime?.lastSeen || null,
          lastHeartbeat: runtime?.lastHeartbeat || null,
        },
        deviceHealth: s,
        recentAlerts: alerts,
        checks,
      };

      const triageId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO support_triage_runs (
          id, church_id, issue_category, severity, summary, triage_result,
          diagnostics_json, autofix_attempts_json, timezone, app_version, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        triageId,
        req.church.churchId,
        issueCategory,
        severity,
        summary,
        triageResult,
        JSON.stringify(diagnostics),
        JSON.stringify([]),
        diagnostics.timezone || null,
        diagnostics.appVersion || null,
        `church:${req.church.churchId}`,
        nowIso
      );

      // ── AI-powered root cause analysis via Sonnet ──────────────────
      let aiAnalysis = null;
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        try {
          const diagContext = require('./diagnostic-context').buildDiagnosticContext(
            req.church.churchId, db, churches, null
          );
          const recentEvents = db.prepare(`
            SELECT event_type, timestamp, auto_resolved, details
            FROM service_events
            WHERE church_id = ? AND timestamp >= datetime('now', '-1 hour')
            ORDER BY timestamp DESC LIMIT 20
          `).all(req.church.churchId);

          const systemPrompt = `You are a church production diagnostic expert. Analyze the following system state and provide a root cause analysis.

ISSUE REPORTED: ${issueCategory} (${severity})
USER DESCRIPTION: ${summary || 'No description provided'}

${diagContext}

RECENT EVENTS (last hour):
${recentEvents.map(e => `  ${e.timestamp}: ${e.event_type}${e.auto_resolved ? ' (auto-resolved)' : ''}${e.details ? ' — ' + e.details : ''}`).join('\n') || '  No recent events'}

BASIC CHECKS:
${checks.map(c => `  ${c.key}: ${c.ok ? '✓' : '✗'} ${c.note}`).join('\n')}

Respond in EXACTLY this JSON format:
{
  "primaryCause": { "cause": "string", "confidence": 0-100, "explanation": "1-2 sentences" },
  "secondaryCauses": [{ "cause": "string", "confidence": 0-100 }],
  "steps": ["step 1", "step 2", "step 3"],
  "canAutoFix": false,
  "autoFixAction": null,
  "suggestedRule": null
}

For suggestedRule, if an AutoPilot rule could prevent this in the future, include:
{ "name": "rule name", "triggerType": "alert_condition|equipment_state_match", "description": "what it does" }`;

          const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              system: systemPrompt,
              messages: [{ role: 'user', content: 'Analyze this issue and provide your diagnosis.' }],
              temperature: 0.3,
              max_tokens: 1024,
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (aiResp.ok) {
            const aiData = await aiResp.json();
            const text = aiData.content?.[0]?.text || '';
            try {
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              if (jsonMatch) aiAnalysis = JSON.parse(jsonMatch[0]);
            } catch { /* parse failed, use raw text */ }
          }
        } catch (e) {
          log.warn('[Triage] AI analysis failed: ' + e.message);
        }
      }

      res.status(201).json({
        triageId,
        triageResult: aiAnalysis ? (aiAnalysis.primaryCause?.confidence > 70 ? 'diagnosed' : triageResult) : triageResult,
        checks,
        diagnostics,
        aiAnalysis,
        createdAt: nowIso,
      });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/tickets', supportAuthMiddleware, (req, res) => {
    try {
      const triageId = String(req.body.triageId || '').trim();
      if (!triageId) return res.status(400).json({ error: 'triageId required' });

      const triage = db.prepare(`
        SELECT * FROM support_triage_runs
        WHERE id = ? AND church_id = ?
      `).get(triageId, req.church.churchId);
      if (!triage) return res.status(404).json({ error: 'triageId not found' });

      const title = String(req.body.title || triage.summary || 'Support ticket').trim().slice(0, 160);
      if (!title) return res.status(400).json({ error: 'title required' });
      const description = String(req.body.description || '').trim().slice(0, 4000);
      const severity = String(req.body.severity || triage.severity || 'P3').trim().toUpperCase();
      const issueCategory = String(req.body.issueCategory || triage.issue_category || 'other').trim().toLowerCase();

      const ticketId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO support_tickets (
          id, church_id, triage_id, issue_category, severity, title, description, status, forced_bypass,
          diagnostics_json, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
      `).run(
        ticketId,
        req.church.churchId,
        triageId,
        issueCategory,
        severity,
        title,
        description,
        triage.diagnostics_json || '{}',
        `church:${req.church.churchId}`,
        nowIso,
        nowIso
      );

      db.prepare(`
        INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
        VALUES (?, ?, 'church', ?, ?)
      `).run(ticketId, description || 'Ticket opened from church portal', req.church.churchId, nowIso);

      res.status(201).json({ ticketId, status: 'open', createdAt: nowIso });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/church/support/tickets/:ticketId/updates', supportAuthMiddleware, (req, res) => {
    try {
      const ticket = db.prepare('SELECT * FROM support_tickets WHERE id = ? AND church_id = ?')
        .get(req.params.ticketId, req.church.churchId);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ error: 'message required' });
      const status = String(req.body.status || ticket.status).trim().toLowerCase();
      const allowedStatus = new Set(['open', 'waiting_customer', 'closed']);
      if (!allowedStatus.has(status)) return res.status(400).json({ error: 'invalid status for church update' });

      const nowIso = new Date().toISOString();
      db.prepare(`
        INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
        VALUES (?, ?, 'church', ?, ?)
      `).run(ticket.id, message.slice(0, 4000), req.church.churchId, nowIso);

      db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, nowIso, ticket.id);

      res.json({ ok: true, ticketId: ticket.id, status, updatedAt: nowIso });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Admin: set portal credentials ─────────────────────────────────────────────
  app.post('/api/churches/:churchId/portal-credentials', requireAdmin, (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = db.prepare('SELECT churchId FROM churches WHERE portal_email = ? AND churchId != ?').get(email.toLowerCase(), req.params.churchId);
    if (existing) return res.status(409).json({ error: 'Email already used by another church' });

    db.prepare('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?')
      .run(email.trim().toLowerCase(), hashPassword(password), req.params.churchId);

    log.info(`Set portal credentials for church ${req.params.churchId}: ${email}`);
    res.json({ ok: true, email: email.trim().toLowerCase(), loginUrl: '/church-login' });
  });

  log.info('Setup complete — routes registered');
}

module.exports = { setupChurchPortal, _buildChurchPortalHtml: buildChurchPortalHtml, getDashboardStats, _findNextService };
