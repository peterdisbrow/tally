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

function buildChurchLoginHtml(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Church Portal — Tally</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #09090B;
      color: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #0F1613;
      border: 1px solid #1a2e1f;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 32px;
    }
    .logo-dot {
      width: 10px;
      height: 10px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 8px #22c55e;
    }
    .logo-text {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .logo-sub {
      font-size: 12px;
      color: #94A3B8;
      margin-left: auto;
    }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    .subtitle { color: #94A3B8; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 13px; color: #94A3B8; margin-bottom: 6px; }
    input {
      width: 100%;
      background: #09090B;
      border: 1px solid #1a2e1f;
      border-radius: 8px;
      padding: 10px 14px;
      color: #F8FAFC;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
      margin-bottom: 16px;
    }
    input:focus { border-color: #22c55e; }
    .btn {
      width: 100%;
      background: #22c55e;
      color: #09090B;
      border: none;
      border-radius: 8px;
      padding: 11px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      margin-top: 4px;
    }
    .btn:hover { opacity: 0.9; }
    .error {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: #f87171;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .footer { text-align: center; margin-top: 24px; font-size: 12px; color: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-dot"></div>
      <span class="logo-text">Tally</span>
      <span class="logo-sub">Church Portal</span>
    </div>
    <h1>Sign in</h1>
    <p class="subtitle">Access your church's monitoring dashboard</p>
    ${error ? `<div class="error">${error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]))}</div>` : ''}
    <form method="POST" action="/api/church/login">
      <label>Email address</label>
      <input type="email" name="email" placeholder="td@yourchurch.org" required autocomplete="email">
      <label>Password</label>
      <input type="password" name="password" placeholder="••••••••" required autocomplete="current-password">
      <button type="submit" class="btn">Sign in</button>
    </form>
    <div class="footer">Tally — <a href="https://tallyconnect.app" style="color:#22c55e;text-decoration:none">tallyconnect.app</a></div>
  </div>
</body>
</html>`;
}

function buildChurchPortalHtml(church) {
  const name = church.name || 'Your Church';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(name)} — Tally Portal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #09090B;
      color: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      display: flex;
      min-height: 100vh;
    }
    /* SIDEBAR */
    .sidebar {
      width: 220px;
      min-width: 220px;
      background: #0F1613;
      border-right: 1px solid #1a2e1f;
      display: flex;
      flex-direction: column;
      padding: 24px 0;
      position: fixed;
      top: 0; left: 0; bottom: 0;
      z-index: 10;
    }
    .sidebar-logo {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 20px 24px;
      border-bottom: 1px solid #1a2e1f;
      margin-bottom: 16px;
    }
    .sidebar-dot {
      width: 8px; height: 8px;
      background: #22c55e;
      border-radius: 50%;
      box-shadow: 0 0 6px #22c55e;
    }
    .sidebar-brand { font-size: 16px; font-weight: 700; }
    .sidebar-church { font-size: 11px; color: #94A3B8; max-width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 20px;
      font-size: 13px;
      color: #94A3B8;
      cursor: pointer;
      border-radius: 0;
      transition: all 0.15s;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
    }
    .nav-item:hover, .nav-item.active {
      background: rgba(34,197,94,0.08);
      color: #22c55e;
    }
    .nav-item .icon { font-size: 15px; width: 18px; text-align: center; }
    .sidebar-footer {
      margin-top: auto;
      padding: 16px 20px;
      border-top: 1px solid #1a2e1f;
    }
    .btn-logout {
      width: 100%;
      background: transparent;
      border: 1px solid #1a2e1f;
      color: #94A3B8;
      border-radius: 7px;
      padding: 8px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-logout:hover { border-color: #ef4444; color: #ef4444; }
    /* MAIN */
    .main {
      margin-left: 220px;
      flex: 1;
      padding: 32px;
      max-width: 900px;
    }
    .page { display: none; }
    .page.active { display: block; }
    .page-header { margin-bottom: 24px; }
    .page-title { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .page-sub { font-size: 13px; color: #94A3B8; }
    /* CARDS */
    .card {
      background: #0F1613;
      border: 1px solid #1a2e1f;
      border-radius: 10px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .card-title { font-size: 14px; font-weight: 600; margin-bottom: 16px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; }
    /* FORMS */
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 12px; color: #94A3B8; margin-bottom: 6px; }
    .field input, .field textarea, .field select {
      width: 100%;
      background: #09090B;
      border: 1px solid #1a2e1f;
      border-radius: 8px;
      padding: 9px 12px;
      color: #F8FAFC;
      font-size: 13px;
      outline: none;
      font-family: inherit;
      transition: border-color 0.15s;
    }
    .field input:focus, .field textarea:focus, .field select:focus { border-color: #22c55e; }
    .field textarea { resize: vertical; min-height: 100px; font-family: 'Courier New', monospace; font-size: 12px; }
    .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    /* SCHEDULE EDITOR */
    .schedule-empty {
      border: 1px dashed #1a2e1f;
      border-radius: 8px;
      padding: 14px;
      color: #64748B;
      font-size: 12px;
      margin-bottom: 12px;
      text-align: center;
    }
    .schedule-rows { display: flex; flex-direction: column; gap: 10px; }
    .schedule-row {
      display: grid;
      grid-template-columns: 150px auto auto 1fr auto;
      gap: 8px;
      align-items: center;
      background: #09090B;
      border: 1px solid #1a2e1f;
      border-radius: 8px;
      padding: 10px;
    }
    .schedule-actions {
      display: flex;
      gap: 10px;
      justify-content: space-between;
      align-items: center;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    .schedule-note { color: #64748B; font-size: 12px; }
    /* SCHEDULE OVERVIEW (read-only) */
    .schedule-overview-day { margin-bottom: 10px; }
    .schedule-overview-day:last-child { margin-bottom: 0; }
    .schedule-day-label { font-size: 12px; font-weight: 600; color: #F8FAFC; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
    .schedule-window { display: inline-flex; align-items: center; gap: 6px; background: rgba(34,197,94,.06); border: 1px solid rgba(34,197,94,.15); border-radius: 6px; padding: 4px 10px; font-size: 12px; color: #CBD5E1; margin-right: 6px; margin-bottom: 4px; }
    .schedule-window .sw-time { color: #22c55e; font-weight: 500; }
    .schedule-window .sw-label { color: #94A3B8; font-style: italic; }
    .time-select { display: inline-flex; align-items: center; gap: 2px; }
    .time-select select { background: #09090B; color: #F8FAFC; border: 1px solid #1a2e1f; border-radius: 6px; padding: 6px 4px; font-size: 13px; cursor: pointer; }
    .time-select select:focus { border-color: #22c55e; outline: none; }
    .time-select span { color: #64748B; font-size: 14px; padding: 0 1px; }
    .btn-primary {
      background: #22c55e;
      color: #09090B;
      border: none;
      border-radius: 7px;
      padding: 9px 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-primary:hover { opacity: 0.85; }
    .btn-secondary {
      background: transparent;
      color: #94A3B8;
      border: 1px solid #1a2e1f;
      border-radius: 7px;
      padding: 9px 20px;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-secondary:hover { border-color: #22c55e; color: #22c55e; }
    .btn-danger {
      background: transparent;
      color: #f87171;
      border: 1px solid rgba(239,68,68,0.3);
      border-radius: 7px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-danger:hover { background: rgba(239,68,68,0.1); }
    .btn-sm {
      background: transparent;
      color: #22c55e;
      border: 1px solid rgba(34,197,94,0.3);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .btn-sm:hover { background: rgba(34,197,94,0.1); }
    /* TABLES */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.5px; padding: 0 0 10px; border-bottom: 1px solid #1a2e1f; }
    td { padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(26,46,31,0.5); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    /* BADGES */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 500;
      font-family: 'Courier New', monospace;
    }
    .badge-green { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
    .badge-yellow { background: rgba(234,179,8,0.1); color: #eab308; border: 1px solid rgba(234,179,8,0.2); }
    .badge-red { background: rgba(239,68,68,0.1); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
    .badge-gray { background: rgba(148,163,184,0.1); color: #94A3B8; border: 1px solid rgba(148,163,184,0.2); }
    /* STATUS */
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .status-dot.online { background: #22c55e; box-shadow: 0 0 5px #22c55e; }
    .status-dot.offline { background: #94A3B8; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes thinkBounce { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }
    @keyframes onboardPulse { 0%, 100% { border-color: #1a3a24; box-shadow: 0 0 0 rgba(34,197,94,0); } 50% { border-color: #22c55e; box-shadow: 0 0 12px rgba(34,197,94,0.15); } }
    @keyframes onboardSlideIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes onboardCheckPop { 0% { transform: scale(0.5); opacity: 0; } 50% { transform: scale(1.2); } 100% { transform: scale(1); opacity: 1; } }
    .onboard-action-btn { display:inline-flex; align-items:center; gap:4px; font-size:11px; color:#22c55e; background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.2); border-radius:4px; padding:3px 8px; cursor:pointer; text-decoration:none; margin-top:4px; }
    .onboard-action-btn:hover { background:rgba(34,197,94,0.15); border-color:#22c55e; }
    /* STATS ROW */
    .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 20px; }
    .stat-card {
      background: #0F1613;
      border: 1px solid #1a2e1f;
      border-radius: 10px;
      padding: 20px;
      text-align: center;
    }
    .stat-value { font-size: 28px; font-weight: 700; color: #22c55e; }
    .stat-label { font-size: 12px; color: #94A3B8; margin-top: 4px; }
    /* TOGGLE */
    .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid rgba(26,46,31,0.5); }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-label { font-size: 13px; }
    .toggle-desc { font-size: 11px; color: #94A3B8; margin-top: 2px; }
    .toggle { position: relative; width: 40px; height: 22px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
      background: #1a2e1f; border-radius: 22px; transition: 0.15s;
    }
    .slider:before {
      position: absolute; content: "";
      height: 16px; width: 16px; left: 3px; bottom: 3px;
      background: #94A3B8; border-radius: 50%; transition: 0.15s;
    }
    input:checked + .slider { background: rgba(34,197,94,0.2); }
    input:checked + .slider:before { background: #22c55e; transform: translateX(18px); }
    /* TOAST */
    #toast {
      position: fixed; bottom: 24px; right: 24px;
      background: #0F1613; border: 1px solid #22c55e; color: #22c55e;
      padding: 12px 20px; border-radius: 8px; font-size: 13px;
      opacity: 0; transform: translateY(10px);
      transition: all 0.2s; pointer-events: none; z-index: 999;
    }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.error { border-color: #ef4444; color: #f87171; }
    /* CODE */
    .code-block {
      background: #09090B;
      border: 1px solid #1a2e1f;
      border-radius: 6px;
      padding: 10px 14px;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      color: #22c55e;
      word-break: break-all;
    }
    /* ANALYTICS */
    .analytics-range {
      padding: 6px 14px;
      font-size: 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .analytics-range.active {
      background: rgba(34,197,94,0.15);
      border-color: #22c55e;
      color: #22c55e;
    }
    .a-bar-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .a-bar-label {
      width: 100px;
      text-align: right;
      color: #94A3B8;
      flex-shrink: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .a-bar-track {
      flex: 1;
      height: 18px;
      background: #09090B;
      border-radius: 4px;
      overflow: hidden;
    }
    .a-bar-fill {
      height: 100%;
      background: #22c55e;
      border-radius: 4px;
      transition: width 0.4s ease;
      min-width: 2px;
    }
    .a-bar-fill.yellow { background: #eab308; }
    .a-bar-fill.red { background: #ef4444; }
    .a-bar-value {
      width: 50px;
      color: #F8FAFC;
      font-size: 12px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .a-metric-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .a-metric-item {
      background: #09090B;
      border-radius: 8px;
      padding: 14px;
    }
    .a-metric-val {
      font-size: 20px;
      font-weight: 700;
      color: #22c55e;
    }
    .a-metric-lbl {
      font-size: 11px;
      color: #94A3B8;
      margin-top: 2px;
    }
    /* RESPONSIVE GRID UTILITIES */
    .grid-4col { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; }
    .grid-3col { display: grid; grid-template-columns: repeat(3,1fr); gap: 12px; }
    .grid-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    @media (max-width: 640px) {
      #analytics-kpi { grid-template-columns: repeat(2, 1fr) !important; }
      .a-metric-grid { grid-template-columns: 1fr; }
      .a-bar-label { width: 60px; font-size: 11px; }
    }
    /* MODAL */
    .modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.7);
      display: none; align-items: center; justify-content: center;
      z-index: 100;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: #0F1613;
      border: 1px solid #1a2e1f;
      border-radius: 12px;
      padding: 28px;
      width: 480px;
      max-width: 95vw;
    }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .modal-title { font-size: 16px; font-weight: 600; }
    .modal-close { background: none; border: none; color: #94A3B8; font-size: 20px; cursor: pointer; line-height: 1; }
    .modal-close:hover { color: #F8FAFC; }
    .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    .help-box { background: rgba(34,197,94,0.06); border: 1px solid rgba(34,197,94,0.15); border-radius: 8px; padding: 12px 16px; color: #94A3B8; font-size: 13px; line-height: 1.6; margin-bottom: 16px; }
    .help-box strong { color: #F8FAFC; }
    /* Tooltips */
    .tip { position: relative; cursor: help; border-bottom: 1px dotted #475569; }
    .tip::after { content: attr(data-tip); position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: #1E293B; color: #CBD5E1; font-size: 12px; line-height: 1.5; padding: 6px 10px; border-radius: 6px; border: 1px solid #334155; white-space: normal; width: max-content; max-width: 260px; opacity: 0; pointer-events: none; transition: opacity 0.15s; z-index: 100; }
    .tip:hover::after { opacity: 1; }
    .hamburger { display: none; position: fixed; top: 12px; left: 12px; z-index: 1001; background: #0D1117; border: 1px solid #1a2e1f; border-radius: 8px; width: 40px; height: 40px; color: #F8FAFC; font-size: 22px; cursor: pointer; align-items: center; justify-content: center; }
    .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999; }
    @media (max-width: 640px) {
      .hamburger { display: flex; }
      .sidebar { display: none; position: fixed; z-index: 1000; top: 0; left: 0; bottom: 0; width: 220px; }
      .sidebar.open { display: flex; flex-direction: column; }
      .sidebar-overlay.open { display: block; }
      .main { margin-left: 0; padding: 16px; padding-top: 56px; }
      .page-title { font-size: 18px; }
      .card { padding: 16px; }
      .stats-row { grid-template-columns: 1fr !important; gap: 10px; }
      .stat-value { font-size: 22px; }
      .grid-4col { grid-template-columns: repeat(2,1fr) !important; }
      .grid-3col { grid-template-columns: 1fr !important; }
      .grid-2col { grid-template-columns: 1fr !important; }
      .field-row { grid-template-columns: 1fr !important; }
      .schedule-row { grid-template-columns: 1fr !important; gap: 6px; }
      table { font-size: 12px; }
      th, td { padding: 8px 6px 8px 0; }
      #toast { left: 16px; right: 16px; bottom: 16px; text-align: center; }
    }
  </style>
</head>
<body>
  <button class="hamburger" id="hamburger-btn" onclick="toggleMobileNav()">☰</button>
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleMobileNav()"></div>
  <nav class="sidebar" id="sidebar-nav">
    <div class="sidebar-logo">
      <div class="sidebar-dot"></div>
      <div>
        <div class="sidebar-brand">Tally</div>
        <div class="sidebar-church" id="sidebar-church-name">${escapeHtml(name)}</div>
      </div>
    </div>
    <button class="nav-item active" data-page="overview" onclick="showPage('overview', this)">
      <span class="icon">⊙</span> Overview
    </button>
    <button class="nav-item" data-page="profile" onclick="showPage('profile', this)">
      <span class="icon">⊞</span> Profile
    </button>
    <button class="nav-item" data-page="campuses" onclick="showPage('campuses', this)">
      <span class="icon">⊚</span> Campuses
    </button>
    <button class="nav-item" data-page="tds" onclick="showPage('tds', this)">
      <span class="icon">⊛</span> Tech Directors
    </button>
    <button class="nav-item" data-page="schedule" onclick="showPage('schedule', this)">
      <span class="icon">⊡</span> Schedule
    </button>
    <button class="nav-item" data-page="notifications" onclick="showPage('notifications', this)">
      <span class="icon">⊜</span> Notifications
    </button>
    <button class="nav-item" data-page="engineer" onclick="showPage('engineer', this)">
      <span class="icon">⊘</span> Tally Engineer
    </button>
    <button class="nav-item" data-page="guests" onclick="showPage('guests', this)">
      <span class="icon">⊝</span> Guest Access
    </button>
    <button class="nav-item" data-page="sessions" onclick="showPage('sessions', this)">
      <span class="icon">⊟</span> Sessions
    </button>
    <button class="nav-item" data-page="alerts" onclick="showPage('alerts',this)">
      <span class="icon">⊗</span> Alerts
    </button>
    <button class="nav-item" data-page="analytics" onclick="showPage('analytics', this)">
      <span class="icon">📊</span> Analytics
    </button>
    <button class="nav-item" data-page="billing" onclick="showPage('billing', this)">
      <span class="icon">⊠</span> Billing
    </button>
    <button class="nav-item" data-page="support" onclick="showPage('support',this)">
      <span class="icon">⊕</span> Help & Support
    </button>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="logout()">Sign out</button>
    </div>
  </nav>

  <main class="main">

    <div id="billing-banner"></div>

    <!-- OVERVIEW -->
    <div class="page active" id="page-overview">
      <div class="page-header">
        <div class="page-title" id="overview-church-name">${escapeHtml(name)}</div>
        <div class="page-sub">Church monitoring portal</div>
      </div>

      <!-- Onboarding Checklist -->
      <div id="onboarding-checklist" style="display:none; margin-bottom:20px; background:#0F1613; border:1px solid #1a3a24; border-radius:12px; padding:20px 24px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
          <div>
            <div style="font-size:15px; font-weight:700; color:#F8FAFC;">Getting Started</div>
            <div style="font-size:12px; color:#64748B; margin-top:2px;" id="onboarding-progress-text">Complete these steps to finish setup</div>
          </div>
          <button onclick="dismissOnboarding()" style="background:none; border:1px solid #1a2e1f; color:#64748B; font-size:11px; padding:5px 12px; border-radius:6px; cursor:pointer;">Dismiss</button>
        </div>
        <div id="onboarding-items"></div>
      </div>
      <!-- Resume Setup Guide (shown when dismissed but not all steps complete) -->
      <div id="onboarding-resume" style="display:none; margin-bottom:16px; text-align:center;">
        <button onclick="undismissOnboarding()" style="background:none; border:none; color:#22c55e; font-size:12px; cursor:pointer; padding:4px 8px; opacity:0.7;">📋 Resume Setup Guide</button>
      </div>

      <!-- Upgrade Banner -->
      <div id="upgrade-banner"></div>

      <!-- Review Prompt Banner -->
      <div id="review-prompt-banner" style="display:none"></div>

      <!-- Referral Card -->
      <div id="referral-card" style="display:none"></div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="stat-status" style="display:flex;align-items:center;gap:6px;justify-content:center"><span id="stat-status-dot" style="width:8px;height:8px;border-radius:50%;background:#475569;display:inline-block"></span> <span id="stat-status-text">—</span></div>
          <div class="stat-label"><span class="tip" data-tip="Whether the Tally desktop app is currently connected to the relay server">Connection</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-sessions">—</div>
          <div class="stat-label"><span class="tip" data-tip="Number of live service sessions detected in the last 30 days">Sessions (30d)</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-tds">—</div>
          <div class="stat-label">Tech Directors</div>
        </div>
      </div>

      <!-- Live Incident Commander (shown only during active sessions) -->
      <div class="card" id="incident-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin:0"><span id="incident-status-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:8px;animation:pulse 2s infinite"></span>LIVE SESSION</div>
          <span id="incident-duration" style="font-size:12px;color:#94A3B8"></span>
        </div>
        <div id="incident-meta" style="font-size:12px;color:#94A3B8;margin-bottom:12px"></div>
        <div id="incident-body"></div>
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Real-time status of each AV device Tally monitors (ATEM, OBS, HyperDeck, etc.)">Equipment Status</span></div>
          <div style="display:flex;align-items:center;gap:8px">
            <span id="equip-staleness" style="font-size:11px;color:#475569"></span>
            <button class="btn-secondary" id="btn-refresh-equip" onclick="refreshEquipmentStatus()" style="padding:4px 10px;font-size:11px" title="Refresh">&#x21bb; Refresh</button>
          </div>
        </div>
        <div class="table-wrap">
        <table>
          <thead><tr><th>System</th><th>Status</th><th>Version</th><th>Detail</th></tr></thead>
          <tbody id="equipment-tbody">
            <tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>

      <!-- Live Stream Stats (shown when any source is streaming) -->
      <div class="card" id="stream-stats-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin:0"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#ef4444;margin-right:8px;animation:pulse 2s infinite"></span>Live Stream</div>
          <span id="stream-source-label" style="font-size:12px;color:#94A3B8;background:#0F1613;border:1px solid #1a2e1f;border-radius:6px;padding:3px 10px"></span>
        </div>
        <div class="grid-4col" style="text-align:center">
          <div>
            <div style="font-size:22px;font-weight:700;color:#F8FAFC" id="ss-bitrate">—</div>
            <div style="font-size:11px;color:#64748B;margin-top:2px">Bitrate (kbps)</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#F8FAFC" id="ss-fps">—</div>
            <div style="font-size:11px;color:#64748B;margin-top:2px">FPS</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#F8FAFC" id="ss-health">—</div>
            <div style="font-size:11px;color:#64748B;margin-top:2px">Health</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:#F8FAFC" id="ss-uptime">—</div>
            <div style="font-size:11px;color:#64748B;margin-top:2px">Uptime</div>
          </div>
        </div>
        <div id="ss-detail-row" style="margin-top:12px;display:flex;gap:16px;font-size:12px;color:#64748B;justify-content:center;flex-wrap:wrap"></div>
      </div>

      <!-- ATEM Switcher Detail Card -->
      <div class="card" id="atem-detail-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="ATEM switcher state — program/preview inputs, recording & streaming status">🎛 ATEM Switcher</span></div>
          <span id="atem-model-label" style="font-size:12px;color:#94A3B8;background:#09090B;border:1px solid #1a2e1f;border-radius:6px;padding:3px 10px"></span>
        </div>
        <div class="grid-2col" style="gap:16px;margin-bottom:14px">
          <div style="background:#09090B;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Program</div>
            <div style="font-size:22px;font-weight:700;color:#ef4444" id="atem-pgm-input">—</div>
            <div style="font-size:12px;color:#94A3B8;margin-top:4px" id="atem-pgm-label"></div>
          </div>
          <div style="background:#09090B;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Preview</div>
            <div style="font-size:22px;font-weight:700;color:#22c55e" id="atem-pvw-input">—</div>
            <div style="font-size:12px;color:#94A3B8;margin-top:4px" id="atem-pvw-label"></div>
          </div>
        </div>
        <div id="atem-status-badges" style="display:flex;gap:8px;flex-wrap:wrap"></div>
      </div>

      <!-- Audio Health Card -->
      <div class="card" id="audio-health-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Audio monitoring — mute detection, silence alerts, source information">🔊 Audio Health</span></div>
          <span id="audio-source-label" style="font-size:12px;color:#94A3B8;background:#09090B;border:1px solid #1a2e1f;border-radius:6px;padding:3px 10px"></span>
        </div>
        <div class="grid-3col" style="margin-bottom:14px">
          <div style="background:#09090B;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Mute</div>
            <div style="font-size:18px;font-weight:700" id="audio-mute-status">—</div>
          </div>
          <div style="background:#09090B;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Silence</div>
            <div style="font-size:18px;font-weight:700" id="audio-silence-status">—</div>
          </div>
          <div style="background:#09090B;border-radius:8px;padding:14px;text-align:center">
            <div style="font-size:10px;color:#64748B;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Monitoring</div>
            <div style="font-size:18px;font-weight:700" id="audio-monitoring-status">—</div>
          </div>
        </div>
        <div id="audio-detail-row" style="font-size:12px;color:#64748B;display:flex;gap:16px;flex-wrap:wrap"></div>
      </div>

      <!-- Pre-Service Check Card -->
      <div class="card" id="preservice-card" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Tally Engineer runs a systems check ~30 minutes before each service">🔧 Pre-Service Check</span></div>
          <span id="preservice-time" style="font-size:11px;color:#64748b"></span>
        </div>
        <div id="preservice-body">
          <div style="color:#475569;text-align:center;padding:12px;font-size:13px">Loading…</div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn-primary" id="preservice-fix-btn" onclick="fixAllPreServiceIssues()" style="display:none;font-size:12px;padding:6px 14px">Fix All Safe Issues</button>
          <button class="btn-secondary" id="preservice-run-btn" onclick="runPreServiceCheck()" style="font-size:12px;padding:6px 14px">Run Check Now</button>
        </div>
      </div>

      <!-- Service Rundown Card -->
      <div class="card" id="rundown-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Follow a step-by-step rundown during your service. Execute device commands directly from here.">📋 Service Rundown</span></div>
          <span id="rundown-status-badge" class="badge badge-gray">—</span>
        </div>
        <div id="rundown-body">
          <div style="color:#475569;text-align:center;padding:16px;font-size:13px">Loading…</div>
        </div>
      </div>

      <!-- Activity Feed -->
      <div class="card" id="activity-feed-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Real-time operational events — status changes, alerts, and auto-recovery actions">⚡ Activity Feed</span></div>
          <span id="activity-feed-count" style="font-size:11px;color:#475569"></span>
        </div>
        <div id="activity-feed-body" style="max-height:300px;overflow-y:auto">
          <div style="color:#475569;text-align:center;padding:16px;font-size:13px">Loading…</div>
        </div>
      </div>

      <!-- Campus Selector (multi-campus only) -->
      <div id="pf-campus-picker" style="display:none; margin-bottom:16px;">
        <label style="font-size:12px;color:#94A3B8;margin-right:8px;">Viewing:</label>
        <select id="pf-campus-select" onchange="loadProblems(this.value)" style="background:#0F1613;color:#F8FAFC;border:1px solid #1a2e1f;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;">
          <option value="">Main Campus</option>
        </select>
      </div>

      <!-- Tally Engineer Card -->
      <div class="card" id="pf-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Automated diagnostics from Tally Engineer — shows what was found, what was auto-fixed, and what still needs attention">Tally Engineer</span></div>
          <span id="pf-badge" class="badge badge-gray">—</span>
        </div>
        <div id="pf-body">
          <div style="color:#475569;text-align:center;padding:20px;font-size:13px">No diagnostics data yet — connect the Tally desktop app to see results.</div>
        </div>
      </div>

      <div class="card" id="schedule-overview-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Your configured service windows — alerts and automations follow this schedule">Service Schedule</span></div>
          <button class="btn-secondary" style="padding:4px 12px;font-size:11px" onclick="showPage('schedule', document.querySelector('[data-page=schedule]'))">Edit</button>
        </div>
        <div id="schedule-overview-body" style="font-size:13px;color:#94A3B8">Loading schedule…</div>
      </div>
      <div class="card">
        <div class="card-title">Quick Info</div>
        <table>
          <tbody>
            <tr><td style="color:#94A3B8;width:160px">Church ID</td><td><code style="font-size:12px;color:#475569">${church.churchId}</code></td></tr>
            <tr><td style="color:#94A3B8">Registered</td><td id="registered-date" style="color:#F8FAFC">—</td></tr>
            <tr><td style="color:#94A3B8">Plan</td><td id="plan-name" style="color:#F8FAFC">—</td></tr>
            <tr><td style="color:#94A3B8">Campuses / Rooms</td><td id="plan-campus-limit" style="color:#F8FAFC">—</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- PROFILE -->
    <div class="page" id="page-profile">
      <div class="page-header">
        <div class="page-title">Church Profile</div>
        <div class="page-sub">Update your contact information</div>
      </div>
      <div class="card">
        <div class="card-title">Contact Information</div>
        <div class="field-row">
          <div class="field">
            <label><span class="tip" data-tip="Contact support to change your church name">Church Name</span></label>
            <input type="text" id="profile-name" disabled style="opacity:0.5">
          </div>
          <div class="field">
            <label>Contact Email</label>
            <input type="email" id="profile-email" placeholder="td@yourchurch.org">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Phone Number</label>
            <input type="tel" id="profile-phone" placeholder="+1 (555) 000-0000">
          </div>
          <div class="field">
            <label>City / State</label>
            <input type="text" id="profile-location" placeholder="Nashville, TN">
          </div>
        </div>
        <div class="field">
          <label><span class="tip" data-tip="Visible to ATEM School support when handling your tickets">Notes for Support Team</span></label>
          <textarea id="profile-notes" placeholder="Any special setup notes, known issues, contact preferences..."></textarea>
        </div>
        <div class="field">
          <label><span class="tip" data-tip="Send post-service recaps and weekly reports to leadership. Comma-separated email addresses.">Leadership Email Recipients</span></label>
          <input type="text" id="profile-leadership-emails" placeholder="pastor@church.org, board@church.org">
          <div style="font-size:11px; color:#94a3b8; margin-top:4px;">Service recaps and weekly reports will be emailed to these addresses automatically.</div>
        </div>
        <button class="btn-primary" id="btn-save-profile" onclick="saveProfile()">Save Changes</button>
      </div>
      <div class="card">
        <div class="card-title">Change Password</div>
        <div class="field-row">
          <div class="field" style="flex:1">
            <label>Current Password</label>
            <input type="password" id="current-password" placeholder="••••••••">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>New Password</label>
            <input type="password" id="new-password" placeholder="••••••••">
          </div>
          <div class="field">
            <label>Confirm Password</label>
            <input type="password" id="confirm-password" placeholder="••••••••">
          </div>
        </div>
        <button class="btn-secondary" onclick="changePassword()">Update Password</button>
      </div>
    </div>

    <!-- CAMPUSES -->
    <div class="page" id="page-campuses">
      <div class="page-header">
        <div class="page-title">Multi-Campus</div>
        <div class="page-sub">Manage additional campuses under this account</div>
      </div>
      <p class="help-box"><strong>How it works:</strong> Each campus gets its own Church ID, connection token, and Telegram registration code. Install the Tally app at each campus and connect using that campus token.</p>
      <div id="campus-plan-note" class="help-box" style="display:none"></div>
      <div id="campus-summary" class="stats-row grid-4col" style="display:none;margin-bottom:20px">
        <div class="stat-card"><div class="stat-value" id="cs-total">0</div><div class="stat-label">Total Rooms</div></div>
        <div class="stat-card"><div class="stat-value" id="cs-online" style="color:#22c55e">0</div><div class="stat-label">Online</div></div>
        <div class="stat-card"><div class="stat-value" id="cs-offline">0</div><div class="stat-label">Offline</div></div>
        <div class="stat-card"><div class="stat-value" id="cs-alerts">0</div><div class="stat-label">Alerts (7d)</div></div>
      </div>
      <div class="card">
        <div class="card-title">Add Campus</div>
        <div class="field-row">
          <div class="field">
            <label>Campus Name</label>
            <input type="text" id="campus-name" placeholder="North Campus">
          </div>
          <div class="field">
            <label>City / State (optional)</label>
            <input type="text" id="campus-location" placeholder="Franklin, TN">
          </div>
        </div>
        <button class="btn-primary" id="btn-create-campus" onclick="addCampus()">Create Campus</button>
      </div>
      <div class="card">
        <div class="card-title">Linked Campuses</div>
        <div class="table-wrap">
        <table>
          <thead><tr><th>Campus</th><th>Status</th><th>Health</th><th>Registration Code</th><th></th></tr></thead>
          <tbody id="campuses-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- TECH DIRECTORS -->
    <div class="page" id="page-tds">
      <div class="page-header">
        <div class="page-title">Tech Directors</div>
        <div class="page-sub">People who receive alerts and have TD access</div>
      </div>
      <p class="help-box"><strong>How On-Call Routing Works:</strong> When Tally detects an issue during your service, it sends an alert to whichever TD is on-call that week. If no one responds within 90 seconds, it escalates to your primary TD. TDs can swap on-call duty via Telegram using <code style="color:#22c55e">/swap [name]</code>.</p>
      <div class="card">
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
          <button class="btn-primary" onclick="document.getElementById('modal-add-td').classList.add('open')">+ Add TD</button>
        </div>
        <div class="table-wrap">
        <table>
          <thead><tr><th>Name</th><th><span class="tip" data-tip="Primary TD gets escalations. On-call TD receives first alerts.">Role</span></th><th>Email</th><th>Phone</th><th></th></tr></thead>
          <tbody id="tds-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- SCHEDULE -->
    <div class="page" id="page-schedule">
      <div class="page-header">
        <div class="page-title">Service Schedule</div>
        <div class="page-sub">Define your recurring service windows for smart alerts</div>
      </div>
      <p class="help-box"><strong>Why set service windows?</strong> Tally uses these time windows to know when your services are live. Alerts only fire during (and around) these windows — so your TDs won't get notified at 3 AM for a test stream. Autopilot features (Pro plan) also use them to auto-start streaming and recording.</p>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
          <div class="card-title" style="margin:0">Weekly Service Windows</div>
          <div id="schedule-campus-picker" style="display:none">
            <label style="font-size:12px;color:#94A3B8;margin-right:6px">Campus:</label>
            <select id="schedule-campus-select" onchange="loadSchedule()" style="background:#09090B;color:#F8FAFC;border:1px solid #1a2e1f;border-radius:6px;padding:5px 8px;font-size:13px;cursor:pointer"></select>
          </div>
        </div>
        <p style="font-size:12px;color:#94A3B8;margin-bottom:14px">Add each recurring service window below. Alerts and automation use these time windows.</p>
        <div id="schedule-empty" class="schedule-empty">No service windows yet. Add your first one.</div>
        <div id="schedule-rows" class="schedule-rows"></div>
        <div class="schedule-actions">
          <button class="btn-secondary" onclick="addScheduleRow()">+ Add Service Window</button>
          <span class="schedule-note">Tip: set separate windows for Saturday rehearsal and Sunday service.</span>
        </div>
        <div style="margin-top:16px">
          <button class="btn-primary" id="btn-save-schedule" onclick="saveSchedule()">Save Schedule</button>
        </div>
      </div>
    </div>

    <!-- NOTIFICATIONS -->
    <div class="page" id="page-notifications">
      <div class="page-header">
        <div class="page-title">Notifications</div>
        <div class="page-sub">Control how and when you receive alerts</div>
      </div>
      <p class="help-box"><strong>Alert Notifications:</strong> Tally classifies alerts by severity — INFO (logged only), WARNING (sent during services), CRITICAL (sent + escalated after 90s), and EMERGENCY (sent immediately). Configure your notification preferences below.</p>
      <div class="card">
        <div class="card-title">Alert Preferences</div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Email alerts</div>
            <div class="toggle-desc">Receive offline + error alerts via email</div>
          </div>
          <label class="toggle"><input type="checkbox" id="notif-email"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Telegram alerts</div>
            <div class="toggle-desc">Receive alerts in Telegram (chat ID required)</div>
          </div>
          <label class="toggle"><input type="checkbox" id="notif-telegram"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">A/V sync alerts</div>
            <div class="toggle-desc">Notify when audio/video drift exceeds threshold</div>
          </div>
          <label class="toggle"><input type="checkbox" id="notif-sync"><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Weekly digest</div>
            <div class="toggle-desc">Summary email every Monday morning</div>
          </div>
          <label class="toggle"><input type="checkbox" id="notif-digest"><span class="slider"></span></label>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Auto-Recovery</div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Automatic issue recovery</div>
            <div class="toggle-desc">Tally Engineer will automatically attempt to fix common issues (stream drops, recording failures, encoder reconnects) before alerting your TD. Recovery actions are always logged in session reports.</div>
          </div>
          <label class="toggle"><input type="checkbox" id="notif-auto-recovery"><span class="slider"></span></label>
        </div>
        <button class="btn-primary" onclick="saveNotifications()" style="margin-top:12px">Save Preferences</button>
      </div>
      <div class="card">
        <div class="card-title">Stream Failover Protection</div>
        <p style="font-size:12px;color:#94A3B8;margin-bottom:12px">When enabled, Tally monitors encoder bitrate and ATEM connection. If an outage is detected, your TD is alerted via Telegram. If no one responds within the ack timeout, Tally automatically switches to your configured safe source.</p>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Enable stream failover</div>
            <div class="toggle-desc">Auto-switch to a safe source on confirmed signal loss</div>
          </div>
          <label class="toggle"><input type="checkbox" id="failover-enabled"><span class="slider"></span></label>
        </div>
        <div id="failover-config" style="margin-top:12px;display:none">
          <div class="field" style="margin-bottom:10px">
            <label>Failover action</label>
            <select id="failover-action-type" onchange="toggleFailoverAction()" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
              <option value="">— Select —</option>
              <option value="atem_switch">Switch ATEM program source</option>
              <option value="videohub_route">Switch VideoHub route</option>
            </select>
          </div>
          <div id="failover-atem-fields" style="display:none">
            <div class="field" style="margin-bottom:10px">
              <label>Safe source (ATEM input)</label>
              <select id="failover-atem-input" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
                <option value="">Connect your ATEM to see inputs</option>
              </select>
            </div>
          </div>
          <div id="failover-videohub-fields" style="display:none">
            <div class="field" style="margin-bottom:10px">
              <label>VideoHub output (destination)</label>
              <select id="failover-vh-output" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
                <option value="">Connect your VideoHub to see outputs</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:10px">
              <label>Safe source (VideoHub input)</label>
              <select id="failover-vh-input" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
                <option value="">Connect your VideoHub to see inputs</option>
              </select>
            </div>
          </div>
          <div style="display:flex;gap:12px;margin-bottom:10px">
            <div class="field" style="flex:1">
              <label>Black threshold (seconds)</label>
              <input type="number" id="failover-black-threshold" value="5" min="3" max="15" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
            </div>
            <div class="field" style="flex:1">
              <label>Ack timeout (seconds)</label>
              <input type="number" id="failover-ack-timeout" value="30" min="10" max="120" style="width:100%;padding:8px;background:#1E293B;border:1px solid #334155;border-radius:6px;color:#F8FAFC;font-size:13px">
            </div>
          </div>
          <p style="font-size:11px;color:#64748B;margin-bottom:12px">Black threshold: how long to wait before confirming an outage. Ack timeout: how long to wait for TD response before auto-failover.</p>
        </div>
        <button class="btn-primary" onclick="saveFailoverSettings()" style="margin-top:8px">Save Failover Settings</button>
      </div>
      <div class="card">
        <div class="card-title">Telegram Integration</div>
        <div class="field">
          <label>Your Telegram Chat ID</label>
          <input type="text" id="telegram-chat-id" placeholder="1234567890">
        </div>
        <p style="font-size:12px;color:#94A3B8;margin-bottom:16px">Message <a href="https://t.me/userinfobot" target="_blank" style="color:#22c55e">@userinfobot</a> on Telegram to get your chat ID.</p>
        <button class="btn-primary" onclick="saveNotifications()">Save Preferences</button>
      </div>
    </div>

    <!-- TALLY ENGINEER -->
    <div class="page" id="page-engineer">
      <div class="page-header">
        <div class="page-title">Train Your Tally Engineer</div>
        <div class="page-sub">Help Tally Engineer understand your setup so it can diagnose problems faster and give better recommendations.</div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div class="card-title" style="margin:0">Training Status</div>
          <span id="engineer-training-badge" class="badge badge-gray">—</span>
        </div>
        <p style="color:#94A3B8;font-size:13px;line-height:1.6;margin:0">
          The more Tally Engineer knows about your setup, the better it can diagnose issues and suggest fixes.
          Fill in as many fields as you can — you can always update them later.
        </p>
      </div>
      <div class="card">
        <div class="card-title">Setup Profile</div>
        <div class="field-row">
          <div class="field">
            <label>Stream Platform</label>
            <select id="eng-stream-platform">
              <option value="">— Select —</option>
              <option value="YouTube">YouTube</option>
              <option value="Facebook">Facebook</option>
              <option value="Vimeo">Vimeo</option>
              <option value="Resi">Resi</option>
              <option value="Boxcast">Boxcast</option>
              <option value="Church Online Platform">Church Online Platform</option>
              <option value="Custom RTMP">Custom RTMP</option>
              <option value="None">None (record only)</option>
            </select>
          </div>
          <div class="field">
            <label>Expected Viewers</label>
            <select id="eng-expected-viewers">
              <option value="">— Select —</option>
              <option value="Under 50">Under 50</option>
              <option value="50-200">50–200</option>
              <option value="200-500">200–500</option>
              <option value="500-1000">500–1,000</option>
              <option value="1000+">1,000+</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Operator Experience</label>
            <select id="eng-operator-level">
              <option value="">— Select —</option>
              <option value="Volunteer (new)">Volunteer (new)</option>
              <option value="Volunteer (experienced)">Volunteer (experienced)</option>
              <option value="Part-time staff">Part-time staff</option>
              <option value="Full-time TD">Full-time TD</option>
            </select>
          </div>
          <div class="field">
            <label>Backup Encoder</label>
            <input type="text" id="eng-backup-encoder" placeholder="e.g. OBS on second laptop, none">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Backup Switcher</label>
            <input type="text" id="eng-backup-switcher" placeholder="e.g. ATEM Mini Pro as backup, none">
          </div>
          <div class="field" style="flex:1"></div>
        </div>
        <div class="field">
          <label><span class="tip" data-tip="Anything special about your AV setup — audio routing, dual streams, unique workflows, known quirks">Special Notes</span></label>
          <textarea id="eng-special-notes" placeholder="e.g. Audio feed comes from FOH board via USB, we run two simultaneous streams to YouTube and Facebook"></textarea>
        </div>
        <button class="btn-primary" onclick="saveEngineerProfile()">Save Profile</button>
      </div>
      <div class="card" id="coaching-card" style="display:none;margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin:0">📊 Weekly Engineer Notes</div>
          <span id="coaching-week" style="font-size:11px;color:#64748b"></span>
        </div>
        <div id="coaching-body">
          <div style="color:#475569;text-align:center;padding:16px;font-size:13px">Loading coaching data…</div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div class="card-title" style="margin:0">💬 Chat with Tally Engineer</div>
          <button class="btn-secondary" style="font-size:11px;padding:4px 10px" onclick="clearEngineerChat()">Clear</button>
        </div>
        <div id="engineer-chat-messages" style="min-height:200px;max-height:500px;overflow-y:auto;border:1px solid #1a2e1f;border-radius:8px;padding:12px;background:#09090B;margin-bottom:12px">
          <div id="engineer-chat-empty" style="text-align:center;padding:24px 16px">
            <div style="color:#94A3B8;font-size:13px;margin-bottom:16px">Ask about your setup, troubleshooting, or available commands</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
              <button class="engineer-pill" onclick="sendEngineerPill(this)" style="background:#0F1613;border:1px solid #1a2e1f;border-radius:999px;padding:6px 14px;color:#94A3B8;font-size:12px;cursor:pointer;transition:border-color 0.2s">What commands can I use?</button>
              <button class="engineer-pill" onclick="sendEngineerPill(this)" style="background:#0F1613;border:1px solid #1a2e1f;border-radius:999px;padding:6px 14px;color:#94A3B8;font-size:12px;cursor:pointer;transition:border-color 0.2s">How does auto-recovery work?</button>
              <button class="engineer-pill" onclick="sendEngineerPill(this)" style="background:#0F1613;border:1px solid #1a2e1f;border-radius:999px;padding:6px 14px;color:#94A3B8;font-size:12px;cursor:pointer;transition:border-color 0.2s">Help me troubleshoot my stream</button>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px">
          <input type="text" id="engineer-chat-input" placeholder="Ask Tally Engineer a question..."
            style="flex:1;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:9px 12px;color:#F8FAFC;font-size:13px;outline:none"
            onkeydown="if(event.key==='Enter')sendEngineerChat()">
          <button class="btn-primary" onclick="sendEngineerChat()" style="min-width:80px">Send</button>
        </div>
      </div>
    </div>

    <!-- GUEST ACCESS -->
    <div class="page" id="page-guests">
      <div class="page-header">
        <div class="page-title">Guest Access</div>
        <div class="page-sub">Temporary tokens for visiting TDs, contractors, or trainers</div>
      </div>
      <p class="help-box"><strong>What are guest tokens?</strong> Generate a temporary access token for visiting tech directors, contractors, or trainers. Share the token — the guest enters it in the Tally app or Telegram bot to get temporary monitoring access. Tokens auto-expire after the time you set (default 7 days). Revoke any token early from the table below.</p>
      <div class="card">
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
          <button class="btn-primary" onclick="generateGuestToken()">+ Generate Token</button>
        </div>
        <div class="table-wrap">
        <table>
          <thead><tr><th><span class="tip" data-tip="Share this code with the guest — they enter it in the Tally app or Telegram bot">Token</span></th><th>Label</th><th><span class="tip" data-tip="Shows whether a guest TD has claimed this token via Telegram">Status</span></th><th>Created</th><th><span class="tip" data-tip="Token stops working after this date. Revoke early if needed.">Expires</span></th><th></th></tr></thead>
          <tbody id="guests-tbody">
            <tr><td colspan="6" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- SESSIONS -->
    <div class="page" id="page-sessions">
      <div class="page-header">
        <div class="page-title">Service Sessions</div>
        <div class="page-sub">History of recent live service sessions</div>
      </div>
      <p class="help-box"><strong>What counts as a session?</strong> A session is recorded each time Tally detects your live stream or recording starting during a service window. Duration, peak viewer count, and any alerts that fired are logged here.</p>
      <div class="card">
        <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Duration</th><th>Peak Viewers</th><th>Status</th></tr></thead>
          <tbody id="sessions-tbody">
            <tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <!-- ANALYTICS -->
    <div class="page" id="page-analytics">
      <div class="page-header">
        <div class="page-title">Analytics</div>
        <div class="page-sub">Stream health, viewer trends, and equipment performance</div>
      </div>

      <div style="margin-bottom:20px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn-secondary analytics-range active" data-days="30" onclick="setAnalyticsRange(30, this)">Last 30 days</button>
        <button class="btn-secondary analytics-range" data-days="90" onclick="setAnalyticsRange(90, this)">Last 90 days</button>
        <button class="btn-secondary analytics-range" data-days="180" onclick="setAnalyticsRange(180, this)">Last 6 months</button>
        <button class="btn-secondary analytics-range" data-days="365" onclick="setAnalyticsRange(365, this)">Last year</button>
        <button class="btn-secondary" onclick="exportAnalyticsCSV()" style="margin-left:auto" title="Download session data as CSV">Export CSV</button>
      </div>

      <div class="stats-row grid-4col" id="analytics-kpi">
        <div class="stat-card">
          <div class="stat-value" id="a-uptime">\u2014</div>
          <div class="stat-label">Stream Uptime</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="a-sessions-count">\u2014</div>
          <div class="stat-label">Total Sessions</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="a-avg-viewers">\u2014</div>
          <div class="stat-label">Avg Peak Viewers</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="a-recovery-rate">\u2014</div>
          <div class="stat-label">Auto-Recovery Rate</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Stream Health & Reliability</div>
        <div id="a-health-content" style="color:#475569;text-align:center;padding:20px">Loading\u2026</div>
      </div>

      <div class="card">
        <div class="card-title">Viewer Trends</div>
        <div id="a-viewer-chart" style="color:#475569;text-align:center;padding:20px">Loading\u2026</div>
      </div>

      <div class="card">
        <div class="card-title">Audience by Platform</div>
        <div class="page-sub" style="margin-bottom:12px">Concurrent viewer counts from YouTube, Facebook, and Vimeo</div>
        <div class="stats-row grid-4col" id="audience-kpi" style="margin-bottom:16px">
          <div class="stat-card" style="border-left:3px solid #ff0000">
            <div class="stat-value" id="aud-yt-peak">\u2014</div>
            <div class="stat-label">YouTube Peak</div>
          </div>
          <div class="stat-card" style="border-left:3px solid #1877f2">
            <div class="stat-value" id="aud-fb-peak">\u2014</div>
            <div class="stat-label">Facebook Peak</div>
          </div>
          <div class="stat-card" style="border-left:3px solid #1ab7ea">
            <div class="stat-value" id="aud-vim-peak">\u2014</div>
            <div class="stat-label">Vimeo Peak</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="aud-total-avg">\u2014</div>
            <div class="stat-label">Avg Total Viewers</div>
          </div>
        </div>
        <div id="aud-platform-chart" style="color:#475569;text-align:center;padding:20px">Loading\u2026</div>
        <div id="aud-live-chart" style="margin-top:16px;color:#475569;text-align:center;padding:12px;display:none">
          <div class="card-title" style="font-size:13px">Live Viewer Count (last 2 hours)</div>
          <div id="aud-live-bars"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Session Duration & Frequency</div>
        <div id="a-session-stats" style="color:#475569;text-align:center;padding:20px">Loading\u2026</div>
      </div>

      <div class="card">
        <div class="card-title">Equipment Performance</div>
        <div id="a-equipment-content" style="color:#475569;text-align:center;padding:20px">Loading\u2026</div>
      </div>
    </div>

    <!-- ALERTS -->
    <div class="page" id="page-alerts">
      <div class="page-header">
        <div class="page-title">Alert History</div>
        <div class="page-sub">Recent alerts from your services</div>
      </div>
      <p class="help-box">Alerts are classified by severity: <span style="color:#22c55e">INFO</span> (logged only), <span style="color:#eab308">WARNING</span> (sent to on-call TD), <span style="color:#ef4444">CRITICAL</span> (sent + escalated after 90s), <span style="color:#ef4444;font-weight:700">EMERGENCY</span> (immediate escalation). Acknowledge alerts via Telegram with <code style="color:#22c55e">/ack_[code]</code>.</p>
      <div id="alerts-content"><p style="color:#475569;text-align:center;padding:20px">Loading alerts...</p></div>
    </div>

    <!-- BILLING -->
    <div class="page" id="page-billing">
      <div class="page-header">
        <div class="page-title">Billing & Subscription</div>
        <div class="page-sub">Manage your plan, payment method, and invoices</div>
      </div>
      <p class="help-box"><strong>Plan tiers:</strong> <strong style="color:#22c55e">Connect</strong> (free — monitoring + alerts), <strong style="color:#22c55e">Plus</strong> (faster response + Telegram bot), <strong style="color:#22c55e">Pro</strong> (AI Autopilot + Planning Center sync), <strong style="color:#22c55e">Enterprise</strong> (dedicated support with 15-min response SLA).</p>
      <div id="billing-content">
        <div style="color:#475569;text-align:center;padding:30px">Loading billing info...</div>
      </div>
    </div>

    <!-- HELP & SUPPORT -->
    <div class="page" id="page-support">
      <div class="page-header">
        <div class="page-title">Help & Support</div>
        <div class="page-sub">Run diagnostics, open tickets, and track platform status</div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Support SLA</div>
        <p id="support-response-time" style="color:#475569;font-size:13px;margin-top:8px"></p>
        <p style="color:#94A3B8;font-size:13px;line-height:1.6;margin-top:8px">
          Direct support: <a href="mailto:support@tallyconnect.app" style="color:#22c55e">support@tallyconnect.app</a>
        </p>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Run Guided Diagnostics</div>
        <div class="field">
          <label>Issue category</label>
          <select id="support-issue">
            <option value="stream_down">Stream down</option>
            <option value="no_audio_stream">No audio on stream</option>
            <option value="slides_issue">Slides / ProPresenter issue</option>
            <option value="atem_connectivity">ATEM connectivity issue</option>
            <option value="recording_issue">Recording issue</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="field">
          <label>Severity</label>
          <select id="support-severity">
            <option value="P1">P1 - Critical outage</option>
            <option value="P2" selected>P2 - High (service impact)</option>
            <option value="P3">P3 - Medium</option>
            <option value="P4">P4 - Low / question</option>
          </select>
        </div>
        <div class="field">
          <label>Summary</label>
          <textarea id="support-summary" rows="3" placeholder="What happened? Include timing and what changed."></textarea>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn-primary" onclick="runSupportTriage()">Run Triage</button>
          <button class="btn-secondary" onclick="createSupportTicket()">Open Ticket</button>
          <button class="btn-secondary" onclick="loadSupportTickets()">Refresh Tickets</button>
        </div>
        <div id="support-triage-result" style="margin-top:12px;color:#94A3B8;font-size:13px;line-height:1.6"></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Platform Status</div>
        <div id="support-status-components" style="display:flex;flex-direction:column;gap:8px;color:#94A3B8;font-size:13px"></div>
        <div style="margin-top:10px">
          <a href="/status" target="_blank" style="color:#22c55e">Open full status page →</a>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Support Tickets</div>
        <div class="table-wrap">
        <table>
          <thead><tr><th>Created</th><th>Status</th><th>Severity</th><th>Title</th><th>Action</th></tr></thead>
          <tbody id="support-tickets-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

  </main>

  <!-- ADD TD MODAL -->
  <div class="modal-backdrop" id="modal-add-td">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Add Tech Director</div>
        <button class="modal-close" onclick="document.getElementById('modal-add-td').classList.remove('open')">×</button>
      </div>
      <div class="field"><label>Name</label><input type="text" id="td-name" placeholder="John Smith"></div>
      <div class="field"><label>Role</label>
        <select id="td-role">
          <option value="td">Tech Director</option>
          <option value="volunteer">Volunteer</option>
          <option value="engineer">Broadcast Engineer</option>
          <option value="supervisor">Supervisor</option>
        </select>
      </div>
      <div class="field"><label>Email</label><input type="email" id="td-email" placeholder="john@yourchurch.org"></div>
      <div class="field"><label>Phone</label><input type="tel" id="td-phone" placeholder="+1 (555) 000-0000"></div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="document.getElementById('modal-add-td').classList.remove('open')">Cancel</button>
        <button class="btn-primary" onclick="addTd()">Add TD</button>
      </div>
    </div>
  </div>

  <!-- Review Modal -->
  <div class="modal-backdrop" id="modal-review">
    <div class="modal" style="max-width:480px">
      <div id="review-form-content">
        <div class="modal-header">
          <div class="modal-title">Share Your Experience</div>
          <button class="modal-close" onclick="closeReviewModal()">&times;</button>
        </div>
        <div style="margin:20px 0 16px;text-align:center">
          <div style="font-size:13px;color:#94A3B8;margin-bottom:8px">How would you rate Tally?</div>
          <div id="star-rating" style="display:flex;justify-content:center;gap:8px"></div>
        </div>
        <div class="field">
          <label>Your review</label>
          <textarea id="review-body" rows="4" maxlength="500" placeholder="What do you love about Tally? How has it helped your production team?" style="resize:vertical"></textarea>
          <div style="font-size:11px;color:#475569;text-align:right;margin-top:4px"><span id="review-char-count">0</span>/500</div>
        </div>
        <div class="field-row">
          <div class="field"><label>Your name</label><input type="text" id="review-name" placeholder="Mike Johnson" maxlength="100"></div>
          <div class="field"><label>Your role <span style="color:#475569">(optional)</span></label><input type="text" id="review-role" placeholder="Production Director" maxlength="100"></div>
        </div>
        <button class="btn-primary" id="btn-submit-review" onclick="submitReview()" style="width:100%;margin-top:8px">Submit Review</button>
      </div>
      <div id="review-thanks-content" style="display:none;text-align:center;padding:24px 20px">
        <div style="font-size:40px;margin-bottom:12px">&#127881;</div>
        <div style="font-size:18px;font-weight:700;color:#F8FAFC;margin-bottom:8px">Thank you!</div>
        <div style="font-size:13px;color:#94A3B8;margin-bottom:20px;line-height:1.5">Your review has been submitted. Want to double the impact?<br>Post it on one of these platforms too:</div>
        <div style="font-size:12px;color:#475569;margin-top:4px">Your review helps other churches discover Tally.</div>
        <button onclick="closeReviewModal()" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-top:16px;padding:8px">Maybe later</button>
      </div>
    </div>
  </div>

  <!-- Async Confirm / Prompt / Alert Modal -->
  <div class="modal-backdrop" id="modal-dialog">
    <div class="modal" style="max-width:420px">
      <div class="modal-header">
        <div class="modal-title" id="dialog-title">Confirm</div>
        <button class="modal-close" id="dialog-close-x">&times;</button>
      </div>
      <div id="dialog-body" style="font-size:13px;color:#CBD5E1;line-height:1.6;padding:4px 0 12px"></div>
      <div id="dialog-input-wrap" style="display:none">
        <input type="text" id="dialog-input" style="width:100%;box-sizing:border-box" />
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="dialog-cancel">Cancel</button>
        <button class="btn-primary" id="dialog-ok">OK</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    const CHURCH_ID = '${church.churchId}';
    let profileData = {};
    let notifData = {};
    let campusData = [];
    let supportTriage = null;
    const SCHEDULE_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const SCHEDULE_DAY_LABELS = {
      sunday: 'Sunday',
      monday: 'Monday',
      tuesday: 'Tuesday',
      wednesday: 'Wednesday',
      thursday: 'Thursday',
      friday: 'Friday',
      saturday: 'Saturday',
    };

    // ── mobile nav ──────────────────────────────────────────────────────────────
    function toggleMobileNav() {
      var sidebar = document.getElementById('sidebar-nav');
      var overlay = document.getElementById('sidebar-overlay');
      var open = sidebar.classList.toggle('open');
      overlay.classList.toggle('open', open);
    }

    // ── navigation ──────────────────────────────────────────────────────────────
    function showPage(id, el) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + id).classList.add('active');
      el.classList.add('active');
      // Close mobile nav on page switch
      var sidebar = document.getElementById('sidebar-nav');
      var overlay = document.getElementById('sidebar-overlay');
      if (sidebar) sidebar.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      if (id === 'overview') { loadOverview(); startOverviewPoll(); } else { stopOverviewPoll(); }
      if (id === 'campuses') loadCampuses();
      if (id === 'tds') loadTds();
      if (id === 'schedule') loadSchedule();
      if (id === 'guests') loadGuests();
      if (id === 'sessions') loadSessions();
      if (id === 'alerts') loadAlerts();
      if (id === 'billing') loadBilling();
      if (id === 'notifications') loadNotifications();
      if (id === 'support') loadSupportInfo();
      if (id === 'analytics') loadAnalytics();
      if (id === 'engineer') startEngineerChatPoll(); else stopEngineerChatPoll();
    }

    // ── toast ──────────────────────────────────────────────────────────────────
    function toast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = isError ? 'error' : '';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    // ── API ───────────────────────────────────────────────────────────────────
    async function api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(30000) };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    // ── Overview ───────────────────────────────────────────────────────────────
    async function loadOverview() {
      try {
        const d = await api('GET', '/api/church/me');
        profileData = d;
        document.getElementById('stat-tds').textContent = (d.tds || []).length;
        document.getElementById('registered-date').textContent = d.registeredAt ? new Date(d.registeredAt).toLocaleDateString() : '—';
        const tierNames = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
        document.getElementById('plan-name').textContent = tierNames[d.billing_tier] || d.billing_tier || 'Connect';
        try {
          const campusPayload = await api('GET', '/api/church/campuses');
          const limits = campusPayload && campusPayload.limits ? campusPayload.limits : null;
          const limitEl = document.getElementById('plan-campus-limit');
          if (limitEl) {
            if (limits) {
              limitEl.textContent = limits.usedTotal + ' / ' + limits.maxTotal;
            } else {
              limitEl.textContent = '1 / 1';
            }
          }
        } catch {
          const limitEl = document.getElementById('plan-campus-limit');
          if (limitEl) limitEl.textContent = '—';
        }

        const tbody = document.getElementById('equipment-tbody');
        const status = d.status || {};
        const enc = (status.encoder && typeof status.encoder === 'object') ? status.encoder : {};
        const atemConnected = status.atem === true || !!(status.atem && status.atem.connected);
        const obsConnected = status.obs === true || !!(status.obs && status.obs.connected);
        const obsStreaming = status.streaming === true || !!(status.obs && status.obs.streaming);
        const atemStreamingFlag = !!(status.atem && status.atem.streaming);
        const vmixStreamingFlag = !!(status.vmix && status.vmix.streaming);
        const encoderConnected = status.encoder === true || !!enc.connected;
        const encoderLive = !!enc.live || !!enc.streaming || obsStreaming || atemStreamingFlag || vmixStreamingFlag;
        const encNames = {
          obs:'OBS', vmix:'vMix', ecamm:'Ecamm', blackmagic:'Blackmagic',
          aja:'AJA HELO', epiphan:'Epiphan', teradek:'Teradek', tricaster:'TriCaster', birddog:'BirdDog', ndi:'NDI Decoder',
          yolobox:'YoloBox', 'tally-encoder':'Tally Encoder', custom:'Custom',
          'custom-rtmp':'Custom RTMP', 'rtmp-generic':'RTMP Encoder',
        };
        const encoderLabel = encNames[enc.type] || (enc.type
          ? ('Encoder (' + enc.type + ')')
          : ((status.obs && (status.obs.connected || status.obs.app)) ? 'OBS Studio' : 'Streaming Encoder'));
        const encoderStatus = encoderConnected
          ? (encoderLive ? 'streaming' : 'connected')
          : (obsConnected ? (obsStreaming ? 'streaming' : 'connected') : 'unknown');
        const mixerConnected = status.mixer && status.mixer.connected;
        const audioViaAtem = !!(d.audio_via_atem);
        const atemAudioSrcs = status.atem?.atemAudioSources || [];
        const audioPortLabel = atemAudioSrcs.length > 0 ? ' (' + atemAudioSrcs[0].portType + ')' : '';
        const audioStatus = (status.mixer && status.mixer.mainMuted) ? 'muted'
          : (status.audio && status.audio.silenceDetected) ? 'warning'
          : (mixerConnected || audioViaAtem)
            ? ((encoderLive || obsStreaming) ? 'ok' : 'connected')
          : 'unknown';
        const audioLabel = 'Audio' + (audioViaAtem && audioPortLabel ? audioPortLabel : '');

        // ── Version checking helpers ──────────────────────────────────────────
        var MIN_VERS = {obs:'30.0',proPresenter:'7.14',vmix:'27.0',atem_protocol:'2.30',encoder_birddog:'6.0',encoder_teradek:'4.0',encoder_epiphan:'4.24',mixer_behringer:'4.0'};
        function cmpVer(a,b){
          if(!a||!b)return null;
          var pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);
          for(var i=0;i<Math.max(pa.length,pb.length);i++){
            var x=pa[i]||0,y=pb[i]||0;
            if(x<y)return -1;if(x>y)return 1;
          }
          return 0;
        }
        function verInfo(ver,type){
          if(!ver)return null;
          var min=MIN_VERS[type];
          var outdated=min?cmpVer(ver,min)<0:false;
          return {text:'v'+ver,outdated:outdated};
        }

        // Extract version strings for each device
        var atemVer = status.atem && status.atem.protocolVersion ? status.atem.protocolVersion : null;
        var encVer = null, encVerType = null;
        if (enc.type === 'obs' || (!enc.type && status.obs)) {
          encVer = status.obs && status.obs.version; encVerType = 'obs';
        } else if (enc.type === 'vmix') {
          encVer = status.vmix && status.vmix.version; encVerType = 'vmix';
        } else if (enc.type) {
          encVer = enc.firmwareVersion; encVerType = 'encoder_' + enc.type;
        }
        var mixerVer = status.mixer && status.mixer.firmware ? status.mixer.firmware : null;
        var mixerVerType = status.mixer && status.mixer.type ? 'mixer_' + status.mixer.type : null;

        // ATEM program/preview detail
        var atemDetail = '';
        if (atemConnected && status.atem) {
          var parts = [];
          if (status.atem.programInput != null) parts.push('PGM: Input ' + status.atem.programInput);
          if (status.atem.previewInput != null) parts.push('PVW: Input ' + status.atem.previewInput);
          if (status.atem.model) parts.push(status.atem.model);
          atemDetail = parts.join(' · ');
        }

        // Stream detail — bitrate + FPS from any source
        var streamDetail = '';
        if (encoderLive || obsStreaming) {
          var sdParts = [];
          var br = null, fp = null;
          if (obsStreaming && status.obs.bitrate > 0) br = status.obs.bitrate;
          else if (atemStreamingFlag && status.atem.streamingBitrate > 0) br = Math.round(status.atem.streamingBitrate / 1000);
          else if (enc.bitrateKbps > 0) br = enc.bitrateKbps;
          if (obsStreaming && status.obs.fps > 0) fp = Math.round(status.obs.fps);
          else if (enc.fps > 0) fp = Math.round(enc.fps);
          if (br) sdParts.push(br.toLocaleString() + ' kbps');
          if (fp) sdParts.push(fp + ' fps');
          streamDetail = sdParts.join(' · ') || '';
        }

        // Recording detail
        var isRecording = !!(status.atem && status.atem.recording) || !!(status.obs && status.obs.recording) || !!(status.vmix && status.vmix.recording);

        const rows = [
          ['ATEM Switcher', atemConnected ? 'connected' : 'unknown', verInfo(atemVer, 'atem_protocol'), atemDetail || null],
          [encoderLabel, encoderStatus, verInfo(encVer, encVerType), null],
          ['Stream', (encoderLive || obsStreaming) ? 'live' : 'offline', null, streamDetail || null],
          ['Recording', isRecording ? 'recording' : 'offline', null, null],
          [audioLabel, audioStatus, null, null],
        ];
        // Dynamic device rows — only show if the device exists in status
        const hd = status.hyperdeck || status.hyperDeck;
        if (hd) {
          const hdSt = hd.recording ? 'recording' : (hd.connected ? 'connected' : 'unknown');
          rows.push(['HyperDeck', hdSt, null, hd.lastSeen || null]);
        }
        if (Array.isArray(status.hyperdecks || status.hyperDecks)) {
          (status.hyperdecks || status.hyperDecks).forEach(function(deck, i) {
            const hdSt = deck.recording ? 'recording' : (deck.connected ? 'connected' : 'unknown');
            rows.push(['HyperDeck ' + (i + 1), hdSt, null, deck.lastSeen || null]);
          });
        }
        const pp = status.proPresenter || status.propresenter;
        if (pp) {
          const ppSt = pp.connected ? 'connected' : 'unknown';
          const ppVer = pp.version || null;
          rows.push(['ProPresenter', ppSt, verInfo(ppVer, 'proPresenter'), pp.lastSeen || null]);
        }
        if (status.ptz || status.cameras) {
          const cams = status.cameras || (status.ptz ? [status.ptz] : []);
          (Array.isArray(cams) ? cams : [cams]).forEach(function(cam, i) {
            if (!cam) return;
            const camSt = cam.connected ? 'connected' : 'unknown';
            const camLabel = cam.name || ('PTZ Camera ' + (i + 1));
            rows.push([camLabel, camSt, null, cam.lastSeen || null]);
          });
        }
        if (status.mixer) {
          const mxSt = status.mixer.connected ? 'connected' : 'unknown';
          const mxName = status.mixer.name || 'Audio Mixer';
          rows.push([mxName, mxSt, verInfo(mixerVer, mixerVerType), status.mixer.lastSeen || null]);
        }

        // Staleness indicator
        const stalenessEl = document.getElementById('equip-staleness');
        if (stalenessEl && d.lastSeenAt) {
          const ago = Math.round((Date.now() - new Date(d.lastSeenAt).getTime()) / 1000);
          if (ago < 60) stalenessEl.textContent = 'Updated just now';
          else if (ago < 3600) stalenessEl.textContent = 'Updated ' + Math.round(ago / 60) + 'm ago';
          else stalenessEl.textContent = 'Updated ' + Math.round(ago / 3600) + 'h ago';
          stalenessEl.style.color = ago > 300 ? '#f59e0b' : '#475569';
        }

        tbody.innerHTML = rows.map(([name, st, ver, ts]) => {
          let badgeCls = 'badge-gray';
          let label = st;
          if (st === 'connected' || st === 'ok') badgeCls = 'badge-green';
          else if (st === 'live' || st === 'streaming') { badgeCls = 'badge-green'; label = st === 'live' ? '🔴 Live' : 'Streaming'; }
          else if (st === 'recording') { badgeCls = 'badge-green'; label = '⏺ Recording'; }
          else if (st === 'warning') badgeCls = 'badge-yellow';
          else if (st === 'muted') { badgeCls = 'badge-yellow'; label = '🔇 Muted'; }
          else if (st === 'offline') { badgeCls = 'badge-gray'; label = 'Offline'; }
          var verHtml = '—';
          if (ver) {
            verHtml = ver.outdated
              ? '<span style="color:#f59e0b">⚠️ ' + ver.text + '</span>'
              : '<span style="color:#22c55e">' + ver.text + '</span>';
          }
          var detailHtml = '—';
          if (typeof ts === 'string' && ts.length > 0 && isNaN(Date.parse(ts))) {
            detailHtml = '<span style="color:#94A3B8">' + ts + '</span>';
          } else if (ts) {
            detailHtml = new Date(ts).toLocaleTimeString();
          }
          return \`<tr>
            <td>\${name}</td>
            <td><span class="badge \${badgeCls}">\${label}</span></td>
            <td style="font-size:12px">\${verHtml}</td>
            <td style="color:#475569;font-size:12px">\${detailHtml}</td>
          </tr>\`;
        }).join('');

        // ── Live Stream Stats card ──────────────────────────────────────────
        updateStreamStats(status, enc);

        var statusText = document.getElementById('stat-status-text');
        var statusDot = document.getElementById('stat-status-dot');
        if (statusText) { statusText.textContent = d.connected ? 'Online' : 'Offline'; statusText.style.color = d.connected ? '#22c55e' : '#94A3B8'; }
        if (statusDot) { statusDot.style.background = d.connected ? '#22c55e' : '#ef4444'; }

        // ── Onboarding checklist ──────────────────────────────────────────────
        renderOnboarding(d);

        // ── Review prompt (after onboarding, after upgrade banner) ───────────
        checkReviewEligibility();
        loadReferralCard();

        // ── Schedule summary on overview ──────────────────────────────────────
        loadScheduleOverview();

        // ── Live incident commander ──────────────────────────────────────────
        loadIncidents();

        // ── ATEM detail card ──────────────────────────────────────────────────
        updateAtemDetailCard(status);

        // ── Audio health card ────────────────────────────────────────────────
        updateAudioHealthCard(status, audioViaAtem);

        // ── Pre-service check card ──────────────────────────────────────────
        loadPreServiceCheck();

        // ── Service rundown ──────────────────────────────────────────────────
        loadRundown();

        // ── Activity feed ────────────────────────────────────────────────────
        loadActivityFeed();

        // ── Tally Engineer diagnostics ──────────────────────────────────────
        populatePfCampusPicker();
        loadProblems('');
      } catch(e) { console.error(e); }
    }

    async function refreshEquipmentStatus() {
      var btn = document.getElementById('btn-refresh-equip');
      if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
      try {
        await loadOverview();
        toast('Equipment status refreshed');
      } catch { toast('Refresh failed', true); }
      finally { if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; } }
    }

    var _streamStartedAt = null;
    function updateStreamStats(status, enc) {
      var card = document.getElementById('stream-stats-card');
      if (!card) return;

      // Determine if any source is streaming
      var obsStreaming = !!(status.obs && status.obs.streaming);
      var atemStreaming = !!(status.atem && status.atem.streaming);
      var vmixStreaming = !!(status.vmix && status.vmix.streaming);
      var encoderLive = !!(enc.live || enc.streaming);
      var isLive = obsStreaming || atemStreaming || vmixStreaming || encoderLive;

      if (!isLive) {
        card.style.display = 'none';
        _streamStartedAt = null;
        return;
      }
      card.style.display = '';
      if (!_streamStartedAt) _streamStartedAt = Date.now();

      // Source label
      var source = 'Unknown';
      var encNames = {obs:'OBS',vmix:'vMix',ecamm:'Ecamm',blackmagic:'Blackmagic',aja:'AJA',epiphan:'Epiphan',teradek:'Teradek',tricaster:'TriCaster',birddog:'BirdDog'};
      if (atemStreaming) source = 'ATEM Encoder' + (status.atem.streamingService ? ' → ' + status.atem.streamingService : '');
      else if (obsStreaming) source = 'OBS Studio';
      else if (vmixStreaming) source = 'vMix';
      else if (encoderLive) source = encNames[enc.type] || enc.type || 'Encoder';
      document.getElementById('stream-source-label').textContent = source;

      // Bitrate — from any source
      var bitrate = null;
      if (obsStreaming && status.obs.bitrate > 0) bitrate = status.obs.bitrate;
      else if (atemStreaming && status.atem.streamingBitrate > 0) bitrate = Math.round(status.atem.streamingBitrate / 1000);
      else if (encoderLive && enc.bitrateKbps > 0) bitrate = enc.bitrateKbps;
      var brEl = document.getElementById('ss-bitrate');
      if (brEl) {
        brEl.textContent = bitrate !== null ? bitrate.toLocaleString() : '—';
        brEl.style.color = bitrate !== null && bitrate < 1000 ? '#ef4444' : '#F8FAFC';
      }

      // FPS — from any source
      var fps = null;
      if (obsStreaming && status.obs.fps > 0) fps = Math.round(status.obs.fps);
      else if (encoderLive && enc.fps > 0) fps = Math.round(enc.fps);
      var fpsEl = document.getElementById('ss-fps');
      if (fpsEl) {
        fpsEl.textContent = fps !== null ? fps : '—';
        fpsEl.style.color = fps !== null && fps < 24 ? '#f59e0b' : '#F8FAFC';
      }

      // Health indicator
      var healthEl = document.getElementById('ss-health');
      if (healthEl) {
        if (bitrate !== null && bitrate < 1000) { healthEl.textContent = '⚠️ Low'; healthEl.style.color = '#ef4444'; }
        else if (fps !== null && fps < 24) { healthEl.textContent = '⚠️ FPS'; healthEl.style.color = '#f59e0b'; }
        else if (bitrate !== null || fps !== null) { healthEl.textContent = '✓ Good'; healthEl.style.color = '#22c55e'; }
        else { healthEl.textContent = '—'; healthEl.style.color = '#F8FAFC'; }
      }

      // Uptime
      var uptimeEl = document.getElementById('ss-uptime');
      if (uptimeEl && _streamStartedAt) {
        var sec = Math.round((Date.now() - _streamStartedAt) / 1000);
        var h = Math.floor(sec / 3600); var m = Math.floor((sec % 3600) / 60); var s = sec % 60;
        uptimeEl.textContent = h > 0 ? h + 'h ' + m + 'm' : m + 'm ' + s + 's';
      }

      // Detail row — extra info
      var details = [];
      if (atemStreaming && status.atem.streamingCacheUsed !== null && status.atem.streamingCacheUsed !== undefined) {
        details.push('ATEM cache: ' + status.atem.streamingCacheUsed + '%');
      }
      if (status.streamHealth && status.streamHealth.baselineBitrate) {
        details.push('Baseline: ' + status.streamHealth.baselineBitrate);
      }
      if (status.streamHealth && status.streamHealth.recentBitrate) {
        details.push('Recent avg: ' + status.streamHealth.recentBitrate);
      }
      var detailEl = document.getElementById('ss-detail-row');
      if (detailEl) detailEl.innerHTML = details.map(function(d) { return '<span>' + d + '</span>'; }).join('');
    }

    // ── ATEM Detail Card ─────────────────────────────────────────────────────
    function updateAtemDetailCard(status) {
      var card = document.getElementById('atem-detail-card');
      if (!card) return;
      var atem = status.atem;
      if (!atem || (!atem.connected && atem !== true)) { card.style.display = 'none'; return; }
      card.style.display = '';

      var modelEl = document.getElementById('atem-model-label');
      if (modelEl) modelEl.textContent = (typeof atem === 'object' && atem.model) ? atem.model : 'ATEM';

      var labels = (typeof atem === 'object' && atem.inputLabels) ? atem.inputLabels : {};
      var pgmEl = document.getElementById('atem-pgm-input');
      var pgmLbl = document.getElementById('atem-pgm-label');
      if (pgmEl) pgmEl.textContent = atem.programInput != null ? 'Input ' + atem.programInput : '—';
      if (pgmLbl) pgmLbl.textContent = labels[atem.programInput] || '';

      var pvwEl = document.getElementById('atem-pvw-input');
      var pvwLbl = document.getElementById('atem-pvw-label');
      if (pvwEl) pvwEl.textContent = atem.previewInput != null ? 'Input ' + atem.previewInput : '—';
      if (pvwLbl) pvwLbl.textContent = labels[atem.previewInput] || '';

      var badges = document.getElementById('atem-status-badges');
      if (badges) {
        var parts = [];
        if (atem.recording) parts.push('<span class="badge badge-green">⏺ Recording</span>');
        if (atem.streaming) parts.push('<span class="badge badge-green">🔴 Streaming</span>');
        if (!atem.recording && !atem.streaming) parts.push('<span class="badge badge-gray">Standby</span>');
        if (atem.streamingCacheUsed > 80) parts.push('<span class="badge badge-yellow">Cache ' + Math.round(atem.streamingCacheUsed) + '%</span>');
        badges.innerHTML = parts.join(' ');
      }
    }

    // ── Audio Health Card ────────────────────────────────────────────────────
    function updateAudioHealthCard(status, audioViaAtem) {
      var card = document.getElementById('audio-health-card');
      if (!card) return;
      var mixer = status.mixer || {};
      var audio = status.audio || {};
      var hasAudio = mixer.connected || audioViaAtem || audio.monitoring;
      if (!hasAudio) { card.style.display = 'none'; return; }
      card.style.display = '';

      var srcEl = document.getElementById('audio-source-label');
      if (srcEl) {
        var src = audioViaAtem ? 'ATEM Audio' : (mixer.name || mixer.type || 'Audio Mixer');
        srcEl.textContent = src;
      }

      var muteEl = document.getElementById('audio-mute-status');
      if (muteEl) {
        if (mixer.mainMuted) { muteEl.textContent = '🔇 MUTED'; muteEl.style.color = '#ef4444'; }
        else { muteEl.textContent = '🔊 OK'; muteEl.style.color = '#22c55e'; }
      }

      var silEl = document.getElementById('audio-silence-status');
      if (silEl) {
        if (audio.silenceDetected) { silEl.textContent = '⚠ Silence'; silEl.style.color = '#eab308'; }
        else { silEl.textContent = '✓ Signal'; silEl.style.color = '#22c55e'; }
      }

      var monEl = document.getElementById('audio-monitoring-status');
      if (monEl) {
        if (audio.monitoring) { monEl.textContent = '✓ Active'; monEl.style.color = '#22c55e'; }
        else { monEl.textContent = '— Off'; monEl.style.color = '#94A3B8'; }
      }

      var detailRow = document.getElementById('audio-detail-row');
      if (detailRow) {
        var parts = [];
        if (mixer.firmware) parts.push('Firmware: ' + mixer.firmware);
        if (audio.lastLevel != null) parts.push('Level: ' + audio.lastLevel + ' dB');
        var atemSrcs = status.atem && status.atem.atemAudioSources;
        if (Array.isArray(atemSrcs) && atemSrcs.length) parts.push('Port: ' + atemSrcs[0].portType);
        detailRow.innerHTML = parts.map(function(p) { return '<span>' + p + '</span>'; }).join('');
      }
    }

    // ── Rundown Card ─────────────────────────────────────────────────────────
    var TRIGGER_ICONS = { manual: '✋', time_absolute: '🕐', time_relative: '⏱', delay: '⏳', event: '⚡' };

    async function loadRundown() {
      var body = document.getElementById('rundown-body');
      var badge = document.getElementById('rundown-status-badge');
      if (!body) return;
      try {
        var status = await api('GET', '/api/church/scheduler/status');
        if (status && status.active) {
          var stateColor = status.state === 'running' ? 'badge-green' : (status.state === 'paused' ? 'badge-yellow' : 'badge-gray');
          badge.className = 'badge ' + stateColor;
          badge.textContent = status.state === 'completed' ? 'Done' : ('Cue ' + (status.currentCue + 1) + '/' + status.totalCues);
          var active = await api('GET', '/api/church/rundown/active');
          renderActiveRundown(body, active, status);
        } else {
          badge.className = 'badge badge-gray';
          badge.textContent = 'Inactive';
          var rundowns = await api('GET', '/api/church/rundowns');
          renderRundownPicker(body, rundowns);
        }
      } catch (e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">Rundown unavailable</div>';
        badge.className = 'badge badge-gray';
        badge.textContent = '—';
      }
    }

    function renderActiveRundown(container, data, schedulerStatus) {
      var steps = data.rundown ? data.rundown.steps : [];
      var currentIdx = schedulerStatus ? schedulerStatus.currentCue : (data.stepIndex || 0);
      var state = schedulerStatus ? schedulerStatus.state : 'running';
      var progress = schedulerStatus ? schedulerStatus.progress : 0;
      var rundownName = schedulerStatus ? schedulerStatus.rundownName : (data.rundownName || 'Rundown');

      var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
      html += '<div style="font-size:14px;font-weight:600;color:#F8FAFC">' + escapeHtml(rundownName) + '</div>';
      var stateIcon = state === 'running' ? '▶️' : (state === 'paused' ? '⏸️' : '✅');
      html += '<span style="font-size:12px;color:#94A3B8">' + stateIcon + ' ' + state.toUpperCase() + '</span>';
      html += '</div>';

      html += '<div style="height:4px;background:#1E293B;border-radius:2px;margin-bottom:12px;overflow:hidden">';
      html += '<div style="height:100%;width:' + progress + '%;background:#22c55e;border-radius:2px;transition:width 0.3s"></div></div>';

      if (schedulerStatus && state !== 'completed') {
        html += '<div style="font-size:11px;color:#94A3B8;margin-bottom:10px">' + escapeHtml(schedulerStatus.nextTriggerInfo) + '</div>';
      }

      html += '<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:14px;max-height:240px;overflow-y:auto">';
      steps.forEach(function(step, i) {
        var isCurrent = i === currentIdx;
        var isPast = i < currentIdx;
        var bg = isCurrent ? 'rgba(34,197,94,0.1)' : '#09090B';
        var border = isCurrent ? '1px solid rgba(34,197,94,0.3)' : '1px solid transparent';
        var nameColor = isCurrent ? '#22c55e' : (isPast ? '#475569' : '#94A3B8');
        var icon = isPast ? '✓' : (isCurrent ? '▶' : (i + 1));
        var iconColor = isPast ? '#22c55e' : (isCurrent ? '#22c55e' : '#475569');
        var stepName = step.label || step.name || ('Cue ' + (i + 1));
        var trigger = step.trigger || { type: 'manual' };
        var triggerIcon = TRIGGER_ICONS[trigger.type] || '✋';
        var cmdCount = (step.commands || []).length;
        var cmdLabel = cmdCount > 0 ? cmdCount + ' cmd' + (cmdCount !== 1 ? 's' : '') : '';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:' + bg + ';border:' + border + ';border-radius:6px;cursor:pointer" onclick="portalJumpToCue(' + i + ')">';
        html += '<span style="color:' + iconColor + ';font-size:13px;width:20px;text-align:center;font-weight:700">' + icon + '</span>';
        html += '<span style="font-size:12px" title="' + trigger.type + '">' + triggerIcon + '</span>';
        html += '<span style="color:' + nameColor + ';font-size:13px;flex:1">' + escapeHtml(stepName) + '</span>';
        if (cmdLabel) html += '<span style="color:#475569;font-size:10px">' + cmdLabel + '</span>';
        html += '</div>';
      });
      html += '</div>';

      html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
      if (state !== 'completed') {
        html += '<button class="btn-primary" onclick="portalSchedulerGo()" style="font-size:12px;padding:6px 14px">Go ▶</button>';
        html += '<button class="btn-secondary" onclick="portalSchedulerSkip()" style="font-size:12px;padding:6px 10px">Skip ⏭</button>';
        html += '<button class="btn-secondary" onclick="portalSchedulerBack()" style="font-size:12px;padding:6px 10px">⏮ Back</button>';
        if (state === 'running') html += '<button class="btn-secondary" onclick="portalSchedulerPause()" style="font-size:12px;padding:6px 10px">⏸ Pause</button>';
        else if (state === 'paused') html += '<button class="btn-secondary" onclick="portalSchedulerResume()" style="font-size:12px;padding:6px 10px;border-color:#22c55e;color:#22c55e">▶ Resume</button>';
      }
      html += '<button class="btn-secondary" onclick="portalEndRundown()" style="font-size:12px;padding:6px 10px;border-color:#ef4444;color:#ef4444">End</button>';
      html += '</div>';

      if (steps[currentIdx] && steps[currentIdx].notes) {
        html += '<div style="margin-top:10px;padding:8px 12px;background:rgba(245,158,11,0.08);border-radius:6px;font-size:12px;color:#f59e0b">💡 ' + escapeHtml(steps[currentIdx].notes) + '</div>';
      }
      container.innerHTML = html;
    }

    function renderRundownPicker(container, rundowns) {
      if (!rundowns || !rundowns.length) {
        container.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">No rundowns yet. Create one via Telegram or the API.</div>';
        return;
      }
      var html = '<div style="display:flex;flex-direction:column;gap:6px">';
      rundowns.forEach(function(r) {
        var stepCount = (r.steps || []).length;
        var autoLabel = r.auto_activate ? ' <span style="color:#f59e0b;font-size:10px">AUTO</span>' : '';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#09090B;border-radius:6px">';
        html += '<div><span style="color:#F8FAFC;font-size:13px">' + escapeHtml(r.name) + '</span>' + autoLabel;
        html += ' <span style="color:#475569;font-size:11px">' + stepCount + ' cues</span></div>';
        html += '<button class="btn-sm" onclick="portalActivateRundown(&apos;' + r.id + '&apos;)">Start</button>';
        html += '</div>';
      });
      html += '</div>';
      container.innerHTML = html;
    }

    async function portalActivateRundown(rundownId) {
      try { await api('POST', '/api/church/scheduler/activate', { rundownId: rundownId }); toast('Rundown started'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerGo() {
      try { await api('POST', '/api/church/scheduler/advance'); toast('Cue fired'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerSkip() {
      try { await api('POST', '/api/church/scheduler/skip'); toast('Cue skipped'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerBack() {
      try { await api('POST', '/api/church/scheduler/back'); toast('Back one cue'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalJumpToCue(index) {
      try { await api('POST', '/api/church/scheduler/jump', { cueIndex: index }); toast('Jumped to cue ' + (index + 1)); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerPause() {
      try { await api('POST', '/api/church/scheduler/pause'); toast('Rundown paused'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalSchedulerResume() {
      try { await api('POST', '/api/church/scheduler/resume'); toast('Rundown resumed'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }
    async function portalEndRundown() {
      try { await api('POST', '/api/church/scheduler/deactivate'); toast('Rundown ended'); loadRundown(); }
      catch (e) { toast(e.message, true); }
    }

    // ── Activity Feed ────────────────────────────────────────────────────────
    async function loadActivityFeed() {
      var body = document.getElementById('activity-feed-body');
      var countEl = document.getElementById('activity-feed-count');
      if (!body) return;
      try {
        var sessionData, alerts;
        try { sessionData = await api('GET', '/api/church/session/active'); } catch { sessionData = { active: false }; }
        try { alerts = await api('GET', '/api/church/alerts'); } catch { alerts = []; }

        var items = [];
        if (sessionData && sessionData.active && sessionData.events) {
          sessionData.events.forEach(function(e) {
            items.push({
              time: new Date(e.timestamp),
              type: (e.event_type || '').replace(/_/g, ' '),
              detail: typeof e.details === 'string' ? e.details.slice(0, 100) : (typeof e.message === 'string' ? e.message.slice(0, 100) : ''),
              severity: e.auto_resolved ? 'auto_fixed' : (e.resolved ? 'resolved' : 'active'),
              source: 'session'
            });
          });
        }
        (alerts || []).slice(0, 15).forEach(function(a) {
          items.push({
            time: new Date(a.created_at),
            type: (a.alert_type || '').replace(/_/g, ' '),
            detail: a.context && a.context.diagnosis ? (a.context.diagnosis.likely_cause || '').slice(0, 100) : '',
            severity: a.resolved ? 'resolved' : (a.severity || 'INFO'),
            source: 'alert'
          });
        });

        items.sort(function(a, b) { return b.time - a.time; });
        // deduplicate by type+minute
        var seen = {};
        items = items.filter(function(it) {
          var key = it.type + '-' + Math.floor(it.time.getTime() / 60000);
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        }).slice(0, 20);

        if (countEl) countEl.textContent = items.length + ' events';
        if (!items.length) {
          body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">No recent activity</div>';
          return;
        }

        body.innerHTML = items.map(function(item) {
          var timeStr = item.time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          var dateStr = item.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          var icon, color;
          if (item.severity === 'auto_fixed') { icon = '🤖'; color = '#22c55e'; }
          else if (item.severity === 'resolved') { icon = '✅'; color = '#22c55e'; }
          else if (item.severity === 'CRITICAL' || item.severity === 'EMERGENCY') { icon = '🔴'; color = '#ef4444'; }
          else if (item.severity === 'WARNING' || item.severity === 'active') { icon = '⚡'; color = '#f59e0b'; }
          else { icon = 'ℹ️'; color = '#94A3B8'; }
          return '<div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">'
            + '<span style="font-size:11px;color:#475569;min-width:72px;flex-shrink:0">' + dateStr + '<br>' + timeStr + '</span>'
            + '<span style="font-size:13px">' + icon + '</span>'
            + '<div style="flex:1;min-width:0">'
            + '<div style="font-size:13px;color:' + color + ';text-transform:capitalize">' + escapeHtml(item.type) + '</div>'
            + (item.detail ? '<div style="font-size:11px;color:#64748B;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.detail) + '</div>' : '')
            + '</div></div>';
        }).join('');
      } catch (e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:16px;font-size:13px">Unable to load activity feed</div>';
      }
    }

    // ── Auto-refresh polling ─────────────────────────────────────────────────
    var _overviewPollTimer = null;
    var OVERVIEW_POLL_MS = 15000;

    function startOverviewPoll() {
      stopOverviewPoll();
      _overviewPollTimer = setInterval(refreshOverviewData, OVERVIEW_POLL_MS);
    }
    function stopOverviewPoll() {
      if (_overviewPollTimer) { clearInterval(_overviewPollTimer); _overviewPollTimer = null; }
    }

    async function refreshOverviewData() {
      try {
        var d = await api('GET', '/api/church/me');
        var status = d.status || {};
        var enc = (status.encoder && typeof status.encoder === 'object') ? status.encoder : {};
        var audioViaAtem = !!(d.audio_via_atem);

        // Connection status
        var statusText = document.getElementById('stat-status-text');
        var statusDot = document.getElementById('stat-status-dot');
        if (statusText) { statusText.textContent = d.connected ? 'Online' : 'Offline'; statusText.style.color = d.connected ? '#22c55e' : '#94A3B8'; }
        if (statusDot) { statusDot.style.background = d.connected ? '#22c55e' : '#ef4444'; }

        // Staleness
        var stalenessEl = document.getElementById('equip-staleness');
        if (stalenessEl && d.lastSeen) {
          var ago = Math.round((Date.now() - new Date(d.lastSeen).getTime()) / 1000);
          if (ago < 60) stalenessEl.textContent = 'Updated just now';
          else if (ago < 3600) stalenessEl.textContent = 'Updated ' + Math.round(ago / 60) + 'm ago';
          else stalenessEl.textContent = 'Updated ' + Math.round(ago / 3600) + 'h ago';
          stalenessEl.style.color = ago > 300 ? '#f59e0b' : '#475569';
        }

        // Cards
        updateStreamStats(status, enc);
        updateAtemDetailCard(status);
        updateAudioHealthCard(status, audioViaAtem);
        loadRundown();
        loadIncidents();
        loadActivityFeed();
      } catch (e) { /* silent fail on poll */ }
    }

    document.addEventListener('visibilitychange', function() {
      if (document.hidden) { stopOverviewPoll(); }
      else {
        var overviewPage = document.getElementById('page-overview');
        if (overviewPage && overviewPage.classList.contains('active')) startOverviewPoll();
      }
    });

    function fmt12(hhmm) {
      var mins = toMinutes(hhmm);
      if (mins === null) return hhmm || '';
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      var ampm = h < 12 ? 'AM' : 'PM';
      var h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
      return h12 + ':' + pad2(m) + ' ' + ampm;
    }

    async function loadScheduleOverview() {
      var body = document.getElementById('schedule-overview-body');
      if (!body) return;
      try {
        var raw = await api('GET', '/api/church/schedule');
        var sched = normalizeSchedulePayload(raw);
        var html = '';
        var hasAny = false;
        SCHEDULE_DAYS.forEach(function(day) {
          var entries = sched[day] || [];
          if (!entries.length) return;
          hasAny = true;
          html += '<div class="schedule-overview-day">';
          html += '<div class="schedule-day-label">' + SCHEDULE_DAY_LABELS[day] + '</div>';
          entries.forEach(function(e) {
            html += '<span class="schedule-window">';
            html += '<span class="sw-time">' + fmt12(e.start) + ' – ' + fmt12(e.end) + '</span>';
            if (e.label) html += '<span class="sw-label">' + escapeHtml(e.label) + '</span>';
            html += '</span>';
          });
          html += '</div>';
        });
        if (!hasAny) {
          body.innerHTML = '<span style="color:#475569">No service windows configured. <a href="#" style="color:#22c55e;text-decoration:none" onclick="event.preventDefault();showPage(\\'schedule\\', document.querySelector(\\'[data-page=schedule]\\'))">Set up your schedule \\u2192</a></span>';
        } else {
          body.innerHTML = html;
        }
      } catch(e) {
        body.innerHTML = '<span style="color:#475569">Unable to load schedule</span>';
      }
    }

    // ── Live Incident Commander ──────────────────────────────────────────

    async function loadIncidents() {
      var card = document.getElementById('incident-card');
      var body = document.getElementById('incident-body');
      var durationEl = document.getElementById('incident-duration');
      var metaEl = document.getElementById('incident-meta');
      var dot = document.getElementById('incident-status-dot');
      if (!card) return;

      try {
        var data = await api('GET', '/api/church/session/active');
        if (!data || !data.active) {
          card.style.display = 'none';
          return;
        }

        card.style.display = '';
        var session = data;

        // Duration
        var startMs = new Date(session.startedAt).getTime();
        var durMin = Math.round((Date.now() - startMs) / 60000);
        var durH = Math.floor(durMin / 60);
        var durM = durMin % 60;
        if (durationEl) durationEl.textContent = durH > 0 ? durH + 'h ' + durM + 'm' : durM + 'm';

        // Meta line
        var parts = [];
        if (session.tdName) parts.push('TD: ' + session.tdName);
        if (session.streaming) parts.push('🔴 Streaming');
        if (session.peakViewers !== null) parts.push('👀 ' + session.peakViewers + ' peak viewers');
        if (metaEl) metaEl.textContent = parts.join(' · ');

        // Status dot color: green=clean, yellow=minor, red=escalated
        if (dot) {
          if (session.escalated > 0) { dot.style.background = '#ef4444'; }
          else if (session.alertCount > 0) { dot.style.background = '#f59e0b'; }
          else { dot.style.background = '#22c55e'; }
        }

        // Events for this session
        var events = data.events || [];
        if (!events.length && session.alertCount === 0) {
          body.innerHTML = '<div style="color:#22c55e;font-size:13px;padding:8px 0">✅ No issues — smooth sailing</div>';
          return;
        }

        var html = events.map(function(e) {
          var t = new Date(e.timestamp);
          var time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          var type = (e.event_type || '').replace(/_/g, ' ');
          var detail = e.details ? ' — ' + escapeHtml(typeof e.details === 'string' ? e.details.slice(0, 80) : '') : '';

          var icon, statusLine;
          if (e.auto_resolved) {
            icon = '🤖';
            statusLine = '<span style="color:#22c55e;font-size:11px;margin-left:8px">(auto-fixed)</span>';
          } else if (e.resolved) {
            icon = '✅';
            statusLine = '<span style="color:#22c55e;font-size:11px;margin-left:8px">(resolved)</span>';
          } else {
            icon = '⚡';
            statusLine = '<span style="color:#f59e0b;font-size:11px;margin-left:8px">(active)</span>';
          }

          // Diagnosis info if available
          var diagHtml = '';
          if (e.diagnosis) {
            var confPct = e.diagnosis.confidence ? ' (' + e.diagnosis.confidence + '%)' : '';
            diagHtml = '<div style="font-size:11px;color:#64748b;margin-top:2px;margin-left:28px">'
              + 'Likely: ' + escapeHtml(e.diagnosis.likely_cause || '') + confPct
              + '</div>';
          }

          return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04)">'
            + '<div style="display:flex;align-items:center;gap:8px">'
            + '<span style="font-size:11px;color:#64748b;min-width:60px">' + time + '</span>'
            + '<span>' + icon + '</span>'
            + '<span style="color:#F8FAFC;font-size:13px">' + escapeHtml(type) + '</span>'
            + statusLine
            + '</div>'
            + (detail ? '<div style="font-size:12px;color:#94A3B8;margin-left:28px">' + detail + '</div>' : '')
            + diagHtml
            + '</div>';
        }).join('');

        if (!html) html = '<div style="color:#22c55e;font-size:13px;padding:8px 0">✅ No incidents recorded yet</div>';
        body.innerHTML = html;
      } catch(e) {
        card.style.display = 'none';
      }
    }

    // ── Pre-Service Check ────────────────────────────────────────────────

    async function loadPreServiceCheck() {
      var card = document.getElementById('preservice-card');
      var body = document.getElementById('preservice-body');
      var timeEl = document.getElementById('preservice-time');
      if (!card || !body) return;

      try {
        var data = await api('GET', '/api/church/preservice-check');
        if (!data || !data.checks_json) {
          card.style.display = 'none';
          return;
        }

        card.style.display = '';
        var checks = [];
        try { checks = JSON.parse(data.checks_json || '[]'); } catch {}
        if (!checks.length) {
          body.innerHTML = '<div style="color:#475569;text-align:center;padding:12px;font-size:13px">No check data available</div>';
          return;
        }

        // Show relative time
        if (data.created_at && timeEl) {
          var ago = Math.round((Date.now() - new Date(data.created_at).getTime()) / 60000);
          if (ago < 1) timeEl.textContent = 'just now';
          else if (ago < 60) timeEl.textContent = ago + ' min ago';
          else if (ago < 1440) timeEl.textContent = Math.round(ago / 60) + 'h ago';
          else timeEl.textContent = Math.round(ago / 1440) + 'd ago';
          if (data.trigger_type === 'manual') timeEl.textContent += ' (manual)';
        }

        // Render checks
        var html = checks.map(function(c) {
          var icon = c.pass ? '✅' : '⚠️';
          var color = c.pass ? '#22c55e' : '#f59e0b';
          var detail = c.detail ? '<span style="color:#64748b;font-size:12px;margin-left:8px">' + escapeHtml(c.detail) + '</span>' : '';
          return '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;align-items:center;gap:8px">'
            + '<span>' + icon + '</span>'
            + '<span style="color:' + color + ';font-size:13px">' + escapeHtml(c.name || 'Check') + '</span>'
            + detail
            + '</div>';
        }).join('');

        var passCount = checks.filter(function(c) { return c.pass; }).length;
        var failCount = checks.length - passCount;
        var summaryColor = failCount === 0 ? '#22c55e' : '#f59e0b';
        var summaryText = failCount === 0 ? 'All systems go' : failCount + ' issue' + (failCount !== 1 ? 's' : '') + ' found';

        body.innerHTML = '<div style="margin-bottom:8px;font-size:13px;font-weight:600;color:' + summaryColor + '">' + summaryText + '</div>' + html;

        // Show fix-all button if there are auto-fixable failures
        var FIXABLE_CHECKS = ['Main Output'];
        var fixableFailures = checks.filter(function(c) { return !c.pass && FIXABLE_CHECKS.indexOf(c.name) !== -1; });
        var fixBtn = document.getElementById('preservice-fix-btn');
        if (fixBtn) {
          fixBtn.style.display = fixableFailures.length > 0 ? '' : 'none';
          fixBtn.textContent = 'Fix ' + fixableFailures.length + ' Safe Issue' + (fixableFailures.length !== 1 ? 's' : '');
        }
      } catch(e) {
        // No results yet — hide the card
        card.style.display = 'none';
      }
    }

    async function runPreServiceCheck() {
      var btn = document.getElementById('preservice-run-btn');
      var body = document.getElementById('preservice-body');
      if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

      try {
        var data = await api('POST', '/api/church/preservice-check/run');
        if (data && data.result) {
          // Reload the card to show new results
          await loadPreServiceCheck();
        } else {
          if (body) body.innerHTML = '<div style="color:#f59e0b;text-align:center;padding:12px;font-size:13px">⚠️ Could not run check — is the Tally app connected?</div>';
        }
      } catch(e) {
        if (body) body.innerHTML = '<div style="color:#ef4444;text-align:center;padding:12px;font-size:13px">Error running check: ' + escapeHtml(e.message || 'unknown') + '</div>';
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Run Check Now'; }
      }
    }

    async function fixAllPreServiceIssues() {
      var btn = document.getElementById('preservice-fix-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }
      try {
        var data = await api('POST', '/api/church/preservice-check/fix-all');
        if (data && data.results) {
          var fixed = data.results.filter(function(r) { return r.success; }).length;
          var failed = data.results.length - fixed;
          toast(fixed + ' issue' + (fixed !== 1 ? 's' : '') + ' fixed' + (failed > 0 ? ', ' + failed + ' could not be fixed' : ''));
        } else {
          toast('No fixable issues or client offline', true);
        }
        // Re-run check to get fresh status
        await new Promise(function(r) { setTimeout(r, 2000); });
        await runPreServiceCheck();
      } catch(e) {
        toast('Fix error: ' + (e.message || 'unknown'), true);
      } finally {
        if (btn) { btn.disabled = false; }
        await loadPreServiceCheck();
      }
    }

    // ── Tally Engineer: campus picker + card rendering ──────────────────────

    async function populatePfCampusPicker() {
      var picker = document.getElementById('pf-campus-picker');
      var sel = document.getElementById('pf-campus-select');
      if (!picker || !sel) return;
      try {
        var payload = await api('GET', '/api/church/campuses');
        var list = Array.isArray(payload) ? payload : (Array.isArray(payload.campuses) ? payload.campuses : []);
        if (!list.length) { picker.style.display = 'none'; return; }
        sel.innerHTML = '<option value="">Main Campus</option>' + list.map(function(c) {
          return '<option value="' + c.churchId + '">' + escapeHtml(c.name || c.churchId) + '</option>';
        }).join('');
        picker.style.display = '';
      } catch { picker.style.display = 'none'; }
    }

    async function loadProblems(campusId) {
      var body = document.getElementById('pf-body');
      var badge = document.getElementById('pf-badge');
      if (!body) return;
      try {
        var url = '/api/church/problems';
        if (campusId) url += '?campusId=' + encodeURIComponent(campusId);
        var data = await api('GET', url);
        renderProblems(data, body, badge);
      } catch(e) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:20px;font-size:13px">No diagnostics data yet — connect the Tally desktop app to see results.</div>';
        if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '—'; }
      }
    }

    function renderProblems(data, body, badge) {
      if (!data || !data.status) {
        body.innerHTML = '<div style="color:#475569;text-align:center;padding:20px;font-size:13px">No diagnostics data yet — connect the Tally desktop app to see results.</div>';
        if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '—'; }
        return;
      }

      // Badge
      if (badge) {
        if (data.status === 'GO') {
          badge.className = 'badge badge-green';
          badge.textContent = 'GO';
        } else {
          badge.className = 'badge badge-red';
          badge.textContent = 'NO GO';
        }
      }

      var html = '';

      // Timestamp + coverage
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;font-size:12px;color:#64748B">';
      html += '<span>Last scan: ' + (data.created_at ? new Date(data.created_at).toLocaleString() : '—') + '</span>';
      if (data.coverage_score !== undefined) {
        html += '<span>Coverage: ' + Math.round(data.coverage_score * 100) + '%</span>';
      }
      html += '</div>';

      // Section: What Tally Found
      var issues = [];
      try { issues = JSON.parse(data.issues_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">What Tally Found</div>';
      if (issues.length === 0) {
        html += '<div style="color:#22c55e;font-size:13px">✓ No issues detected</div>';
      } else {
        var sevCounts = { critical: 0, high: 0, medium: 0, low: 0 };
        issues.forEach(function(i) { if (sevCounts[i.severity] !== undefined) sevCounts[i.severity]++; });
        html += '<div style="display:flex;gap:12px;flex-wrap:wrap">';
        if (sevCounts.critical > 0) html += '<span class="badge badge-red">' + sevCounts.critical + ' Critical</span>';
        if (sevCounts.high > 0) html += '<span class="badge badge-red">' + sevCounts.high + ' High</span>';
        if (sevCounts.medium > 0) html += '<span class="badge badge-yellow">' + sevCounts.medium + ' Medium</span>';
        if (sevCounts.low > 0) html += '<span class="badge badge-gray">' + sevCounts.low + ' Low</span>';
        html += '</div>';
      }
      html += '</div>';

      // Section: What Tally Fixed
      var autoFixed = [];
      try { autoFixed = JSON.parse(data.auto_fixed_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">What Tally Fixed</div>';
      if (autoFixed.length === 0 && data.auto_fixed_count === 0) {
        html += '<div style="color:#64748B;font-size:13px">No auto-fixes applied</div>';
      } else {
        if (autoFixed.length > 0) {
          autoFixed.forEach(function(f) {
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:13px">';
            html += '<span style="color:#22c55e">✓</span>';
            html += '<span style="color:#F8FAFC">' + escapeHtml(f.title || f.id) + '</span>';
            html += '</div>';
          });
        } else {
          html += '<div style="color:#22c55e;font-size:13px">✓ ' + data.auto_fixed_count + ' item(s) auto-resolved</div>';
        }
      }
      html += '</div>';

      // Section: Needs TD Attention
      var needsAttention = [];
      try { needsAttention = JSON.parse(data.needs_attention_json || '[]'); } catch {}
      html += '<div style="margin-bottom:16px">';
      html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Needs TD Attention</div>';
      if (needsAttention.length === 0 && data.blocker_count === 0) {
        html += '<div style="color:#22c55e;font-size:13px">✓ Nothing needs attention</div>';
      } else {
        needsAttention.forEach(function(item) {
          var sevCls = item.severity === 'critical' ? 'badge-red' : 'badge-yellow';
          html += '<div style="background:rgba(15,22,19,0.5);border:1px solid #1a2e1f;border-radius:8px;padding:12px;margin-bottom:8px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
          html += '<span class="badge ' + sevCls + '">' + (item.severity || 'high') + '</span>';
          html += '<span style="font-size:13px;font-weight:600;color:#F8FAFC">' + escapeHtml(item.title || item.id) + '</span>';
          html += '</div>';
          if (item.symptom) {
            html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:4px">' + escapeHtml(item.symptom) + '</div>';
          }
          if (item.fixStep) {
            html += '<div style="font-size:12px;color:#22c55e">→ ' + escapeHtml(item.fixStep) + '</div>';
          }
          html += '</div>';
        });
      }
      html += '</div>';

      // Section: Recommended Actions
      var topActions = [];
      try { topActions = JSON.parse(data.top_actions_json || '[]'); } catch {}
      if (topActions.length > 0) {
        html += '<div>';
        html += '<div style="font-size:12px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Recommended Actions</div>';
        topActions.forEach(function(action, idx) {
          html += '<div style="display:flex;gap:8px;margin-bottom:4px;font-size:13px;color:#F8FAFC">';
          html += '<span style="color:#22c55e;font-weight:700">' + (idx + 1) + '.</span>';
          html += '<span>' + escapeHtml(typeof action === 'string' ? action : (action.step || action.title || '')) + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }

      body.innerHTML = html;
    }

    function renderOnboarding(d) {
      const container = document.getElementById('onboarding-checklist');
      const itemsEl = document.getElementById('onboarding-items');
      const resumeEl = document.getElementById('onboarding-resume');
      if (!container || !itemsEl) return;

      onboardingRegCode = d.registration_code || '';

      const steps = [
        { key: 'account', done: true, label: 'Account created', detail: 'Your Tally account is set up' },
        { key: 'app', done: !!d.onboarding_app_connected_at, label: 'Desktop app connected', detail: 'Download and run the Tally app on your booth computer', action: '<a href="/download" target="_blank" class="onboard-action-btn">⬇ Download App</a>' },
        { key: 'atem', done: !!d.onboarding_atem_connected_at, label: 'ATEM connected', detail: 'The app will auto-discover your ATEM switcher on the network', action: '<span class="onboard-action-btn" onclick="showAtemTip()">💡 Network Tips</span>' },
        { key: 'telegram', done: !!d.onboarding_telegram_registered_at, label: 'Telegram bot registered', detail: 'Send /register ' + escapeHtml(d.registration_code || 'CODE') + ' to @tallybot on Telegram', action: '<span class="onboard-action-btn" onclick="copyOnboardingCode()">📋 Copy Code</span> <a href="https://t.me/tallybot" target="_blank" class="onboard-action-btn">💬 Open Telegram</a>' },
      ];

      const completed = steps.filter(s => s.done).length;
      const allDone = completed >= steps.length;

      // Show celebration banner when all steps complete
      if (allDone) {
        container.style.display = 'block';
        container.style.animation = 'none';
        container.style.borderColor = '#22c55e';
        itemsEl.innerHTML = '<div style="text-align:center;padding:16px 0"><div style="font-size:28px;margin-bottom:8px;animation:onboardCheckPop 0.5s ease-out">🎉</div><div style="font-size:15px;font-weight:700;color:#22c55e">All set!</div><div style="font-size:12px;color:#94A3B8;margin-top:4px">Your Tally system is fully configured</div></div>';
        if (resumeEl) resumeEl.style.display = 'none';
        setTimeout(function() { container.style.display = 'none'; }, 5000);
        return;
      }

      // Show resume link if dismissed but not complete
      if (d.onboarding_dismissed) {
        container.style.display = 'none';
        if (resumeEl) resumeEl.style.display = 'block';
        return;
      }

      // Show checklist
      if (resumeEl) resumeEl.style.display = 'none';
      container.style.display = 'block';
      container.style.animation = completed < 2 ? 'onboardPulse 3s ease-in-out infinite, onboardSlideIn 0.4s ease-out' : 'onboardSlideIn 0.4s ease-out';
      document.getElementById('onboarding-progress-text').textContent = completed + ' of ' + steps.length + ' steps complete';

      itemsEl.innerHTML = steps.map((s, i) => {
        const icon = s.done
          ? '<div style="width:24px;height:24px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#000;font-size:13px;font-weight:700;flex-shrink:0;animation:onboardCheckPop 0.4s ease-out">✓</div>'
          : '<div style="width:24px;height:24px;border-radius:50%;border:2px solid #334155;display:flex;align-items:center;justify-content:center;color:#64748B;font-size:12px;font-weight:700;flex-shrink:0;">' + (i + 1) + '</div>';
        var actionHtml = (!s.done && s.action) ? '<div style="margin-top:4px">' + s.action + '</div>' : '';
        return '<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;' + (i < steps.length - 1 ? 'border-bottom:1px solid #1a2e1f;' : '') + '">'
          + icon
          + '<div style="flex:1">'
          + '<div style="font-size:13px;font-weight:600;color:' + (s.done ? '#22c55e' : '#F8FAFC') + ';">' + s.label + '</div>'
          + (s.done ? '' : '<div style="font-size:12px;color:#64748B;margin-top:2px;">' + s.detail + '</div>')
          + actionHtml
          + '</div>'
          + '</div>';
      }).join('');
    }

    var onboardingRegCode = '';

    function copyOnboardingCode() {
      if (!onboardingRegCode) { toast('No registration code available', true); return; }
      navigator.clipboard.writeText('/register ' + onboardingRegCode).then(function() { toast('Copied: /register ' + onboardingRegCode); }).catch(function() { toast('Code: /register ' + onboardingRegCode); });
    }

    function showAtemTip() {
      toast('Ensure your ATEM and booth computer are on the same network subnet. The app scans automatically.');
    }

    async function dismissOnboarding() {
      try {
        await api('POST', '/api/church/onboarding/dismiss');
        document.getElementById('onboarding-checklist').style.display = 'none';
        var resumeEl = document.getElementById('onboarding-resume');
        if (resumeEl) resumeEl.style.display = 'block';
      } catch(e) { console.error('Dismiss failed:', e); }
    }

    async function undismissOnboarding() {
      try {
        await api('POST', '/api/church/onboarding/undismiss');
        var resumeEl = document.getElementById('onboarding-resume');
        if (resumeEl) resumeEl.style.display = 'none';
        // Reload overview to re-render onboarding
        loadOverview();
      } catch(e) { toast('Failed to restore setup guide', true); }
    }

    // ── Profile ─────────────────────────────────────────────────────────────────
    async function loadProfile() {
      try {
        const d = await api('GET', '/api/church/me');
        profileData = d;
        document.getElementById('profile-name').value = d.name || '';
        document.getElementById('profile-email').value = d.email || '';
        document.getElementById('profile-phone').value = d.phone || '';
        document.getElementById('profile-location').value = d.location || '';
        document.getElementById('profile-notes').value = d.notes || '';
        document.getElementById('profile-leadership-emails').value = d.leadership_emails || '';
      } catch(e) { toast('Failed to load profile', true); }
    }
    loadProfile();

    async function saveProfile() {
      btnLoading('btn-save-profile', 'Saving…');
      try {
        await api('PUT', '/api/church/me', {
          email: document.getElementById('profile-email').value,
          phone: document.getElementById('profile-phone').value,
          location: document.getElementById('profile-location').value,
          notes: document.getElementById('profile-notes').value,
          leadershipEmails: document.getElementById('profile-leadership-emails').value,
        });
        toast('Profile saved');
      } catch(e) { toast(e.message, true); }
      finally { btnReset('btn-save-profile'); }
    }

    async function changePassword() {
      const cur = document.getElementById('current-password').value;
      const np = document.getElementById('new-password').value;
      const cp = document.getElementById('confirm-password').value;
      if (!cur) return toast('Enter your current password', true);
      if (!np) return toast('Enter a new password', true);
      if (np !== cp) return toast('Passwords do not match', true);
      if (np.length < 8) return toast('Password must be at least 8 characters', true);
      try {
        await api('PUT', '/api/church/me', { currentPassword: cur, newPassword: np });
        document.getElementById('current-password').value = '';
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        toast('Password updated');
      } catch(e) { toast(e.message, true); }
    }

    // ── Tally Engineer profile ─────────────────────────────────────────────────
    async function loadEngineerProfile() {
      try {
        const d = await api('GET', '/api/church/me');
        var ep = {};
        try { ep = JSON.parse(d.engineer_profile || '{}'); } catch {}
        document.getElementById('eng-stream-platform').value = ep.streamPlatform || '';
        document.getElementById('eng-expected-viewers').value = ep.expectedViewers || '';
        document.getElementById('eng-operator-level').value = ep.operatorLevel || '';
        document.getElementById('eng-backup-encoder').value = ep.backupEncoder || '';
        document.getElementById('eng-backup-switcher').value = ep.backupSwitcher || '';
        document.getElementById('eng-special-notes').value = ep.specialNotes || '';
        updateTrainingBadge(ep);
      } catch(e) { /* silent — profile may not have loaded yet */ }
    }
    loadEngineerProfile();
    loadCoaching();

    function updateTrainingBadge(ep) {
      var badge = document.getElementById('engineer-training-badge');
      if (!badge) return;
      var fields = [ep.streamPlatform, ep.expectedViewers, ep.operatorLevel, ep.backupEncoder, ep.backupSwitcher, ep.specialNotes];
      var filled = fields.filter(function(f) { return f && f.trim && f.trim().length > 0; }).length;
      if (filled === 0) {
        badge.className = 'badge badge-red'; badge.textContent = 'Not trained';
      } else if (filled < 4) {
        badge.className = 'badge badge-yellow'; badge.textContent = 'Partially trained (' + filled + '/6)';
      } else {
        badge.className = 'badge badge-green'; badge.textContent = 'Fully trained';
      }
    }

    async function saveEngineerProfile() {
      var ep = {
        streamPlatform: document.getElementById('eng-stream-platform').value,
        expectedViewers: document.getElementById('eng-expected-viewers').value,
        operatorLevel: document.getElementById('eng-operator-level').value,
        backupEncoder: document.getElementById('eng-backup-encoder').value.trim(),
        backupSwitcher: document.getElementById('eng-backup-switcher').value.trim(),
        specialNotes: document.getElementById('eng-special-notes').value.trim(),
      };
      try {
        await api('PUT', '/api/church/me', { engineerProfile: ep });
        updateTrainingBadge(ep);
        toast('Tally Engineer profile saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Engineer Chat ──────────────────────────────────────────────────────────

    var engineerChatMsgs = [];
    var engineerChatPollTimer = null;
    var engineerChatLastTs = null;

    async function loadEngineerChat() {
      try {
        var since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        var resp = await api('GET', '/api/church/chat?limit=50&since=' + encodeURIComponent(since));
        if (resp && resp.messages) {
          engineerChatMsgs = resp.messages;
          if (engineerChatMsgs.length > 0) {
            engineerChatLastTs = engineerChatMsgs[engineerChatMsgs.length - 1].timestamp;
          }
          renderEngineerChat();
        }
      } catch(e) { /* silent */ }
    }

    function startEngineerChatPoll() {
      loadEngineerChat();
      if (engineerChatPollTimer) clearInterval(engineerChatPollTimer);
      engineerChatPollTimer = setInterval(pollEngineerChat, 4000);
    }

    function stopEngineerChatPoll() {
      if (engineerChatPollTimer) { clearInterval(engineerChatPollTimer); engineerChatPollTimer = null; }
    }

    async function pollEngineerChat() {
      if (!engineerChatLastTs) return loadEngineerChat();
      try {
        var resp = await api('GET', '/api/church/chat?since=' + encodeURIComponent(engineerChatLastTs));
        if (resp && resp.messages && resp.messages.length > 0) {
          engineerChatMsgs = engineerChatMsgs.concat(resp.messages);
          engineerChatLastTs = resp.messages[resp.messages.length - 1].timestamp;
          hideEngineerThinking();
          renderEngineerChat();
        }
      } catch(e) { /* silent */ }
    }

    function renderEngineerChat() {
      var container = document.getElementById('engineer-chat-messages');
      var empty = document.getElementById('engineer-chat-empty');
      if (!container) return;
      if (engineerChatMsgs.length === 0) {
        if (empty) empty.style.display = '';
        return;
      }
      if (empty) empty.style.display = 'none';
      // Build HTML for all messages
      var html = '';
      for (var i = 0; i < engineerChatMsgs.length; i++) {
        var m = engineerChatMsgs[i];
        var name = m.sender_name || m.senderName || 'Unknown';
        var role = m.sender_role || m.senderRole || 'td';
        var time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        var nameColor = role === 'system' ? '#22c55e' : (role === 'admin' ? '#22c55e' : '#F8FAFC');
        var icon = role === 'system' ? '🤖' : (role === 'admin' ? '🌐' : '💻');
        var msgText = escapeHtml(m.message);
        // Basic markdown: bold
        msgText = msgText.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        // Bullet lists
        msgText = msgText.replace(/^[-•]\\s+/gm, '<span style="color:#22c55e">•</span> ');
        // Newlines
        msgText = msgText.replace(/\\n/g, '<br>');
        html += '<div style="padding:6px 0;margin-bottom:4px;border-bottom:1px solid rgba(26,46,31,0.3)">'
          + '<div style="font-size:10px;color:#475569;font-family:monospace">'
          + icon + ' <span style="color:' + nameColor + ';font-weight:600">' + escapeHtml(name) + '</span>'
          + ' <span style="margin-left:6px">' + time + '</span></div>'
          + '<div style="font-size:13px;color:#F8FAFC;margin-top:2px;line-height:1.5">' + msgText + '</div>'
          + '</div>';
      }
      // Keep only messages, remove empty state
      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }

    async function sendEngineerChat() {
      var input = document.getElementById('engineer-chat-input');
      var msg = (input.value || '').trim();
      if (!msg) return;
      input.value = '';
      try {
        var resp = await api('POST', '/api/church/chat', { message: msg, senderName: 'TD' });
        if (resp && resp.id) {
          engineerChatMsgs.push(resp);
          engineerChatLastTs = resp.timestamp;
          renderEngineerChat();
          // Show thinking indicator while waiting for AI response
          showEngineerThinking();
          // Quick-poll for faster response: check at 1s and 2s instead of waiting for 4s interval
          setTimeout(function() { pollEngineerChat(); }, 1000);
          setTimeout(function() { pollEngineerChat(); }, 2000);
        }
      } catch(e) {
        toast(e.message, true);
        input.value = msg; // restore on failure
      }
    }

    var engineerThinkingTimer = null;
    var engineerThinkingStart = 0;

    function showEngineerThinking() {
      var container = document.getElementById('engineer-chat-messages');
      if (!container) return;
      var existing = document.getElementById('engineer-thinking');
      if (existing) existing.remove();
      if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; }
      engineerThinkingStart = Date.now();
      var div = document.createElement('div');
      div.id = 'engineer-thinking';
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;margin:4px 0;font-size:12px;color:#64748B';
      div.innerHTML = '<span style="display:inline-flex;gap:3px"><span style="animation:thinkBounce 1.2s infinite;width:6px;height:6px;background:#22C55E;border-radius:50%"></span><span style="animation:thinkBounce 1.2s infinite 0.2s;width:6px;height:6px;background:#22C55E;border-radius:50%"></span><span style="animation:thinkBounce 1.2s infinite 0.4s;width:6px;height:6px;background:#22C55E;border-radius:50%"></span></span> <span id="engineer-thinking-text">Tally Engineer is thinking\u2026</span> <span id="engineer-thinking-elapsed" style="color:#475569;font-size:10px;margin-left:4px"></span>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      engineerThinkingTimer = setInterval(function() {
        var el = document.getElementById('engineer-thinking');
        if (!el) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; return; }
        var elapsed = Math.floor((Date.now() - engineerThinkingStart) / 1000);
        var elapsedEl = document.getElementById('engineer-thinking-elapsed');
        if (elapsedEl) elapsedEl.textContent = elapsed + 's';
        var textEl = document.getElementById('engineer-thinking-text');
        if (textEl) {
          if (elapsed >= 15) textEl.textContent = 'Analyzing your system\u2026';
          else if (elapsed >= 5) textEl.textContent = 'Still working on it\u2026';
        }
      }, 1000);
      setTimeout(function() { var el = document.getElementById('engineer-thinking'); if (el) el.remove(); if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; } }, 60000);
    }

    function hideEngineerThinking() {
      var el = document.getElementById('engineer-thinking');
      if (el) el.remove();
      if (engineerThinkingTimer) { clearInterval(engineerThinkingTimer); engineerThinkingTimer = null; }
    }

    function sendEngineerPill(btn) {
      var input = document.getElementById('engineer-chat-input');
      if (input) input.value = btn.textContent;
      sendEngineerChat();
    }

    function clearEngineerChat() {
      engineerChatMsgs = [];
      engineerChatLastTs = null;
      var container = document.getElementById('engineer-chat-messages');
      var empty = document.getElementById('engineer-chat-empty');
      if (container && empty) {
        container.innerHTML = '';
        container.appendChild(empty);
        empty.style.display = '';
      }
    }

    // ── Campuses ───────────────────────────────────────────────────────────────
    function getCampusById(churchId) {
      return campusData.find(function(c) { return c.churchId === churchId; }) || null;
    }

    async function loadCoaching() {
      var card = document.getElementById('coaching-card');
      var body = document.getElementById('coaching-body');
      var weekEl = document.getElementById('coaching-week');
      if (!card || !body) return;

      try {
        var data = await api('GET', '/api/church/coaching');
        if (!data || data.totalEvents === undefined) {
          card.style.display = 'none';
          return;
        }

        card.style.display = '';
        if (weekEl) weekEl.textContent = 'Week of ' + data.weekOf;

        var html = '';

        // Reliability score
        if (data.reliability !== null) {
          var relColor = data.reliability >= 98 ? '#22c55e' : (data.reliability >= 95 ? '#f59e0b' : '#ef4444');
          html += '<div style="margin-bottom:12px;padding:12px;background:rgba(255,255,255,0.03);border-radius:8px">'
            + '<div style="font-size:24px;font-weight:700;color:' + relColor + '">' + data.reliability + '%</div>'
            + '<div style="font-size:11px;color:#64748b">Uptime reliability this week</div>'
            + '</div>';
        }

        // Session count
        if (data.sessions > 0) {
          html += '<div style="font-size:13px;color:#94A3B8;margin-bottom:8px">'
            + data.sessions + ' session' + (data.sessions !== 1 ? 's' : '') + ' this week'
            + (data.autoResolved > 0 ? ' · ' + data.autoResolved + ' auto-recovered' : '')
            + '</div>';
        }

        // Patterns
        if (data.patterns && data.patterns.length > 0) {
          html += '<div style="margin-top:12px;margin-bottom:4px;font-size:12px;font-weight:600;color:#F8FAFC">Recurring Patterns</div>';
          for (var i = 0; i < data.patterns.length; i++) {
            var p = data.patterns[i];
            html += '<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px">'
              + '<span style="color:#f59e0b">⚠️</span> '
              + '<span style="color:#F8FAFC">' + escapeHtml(p.pattern) + '</span>'
              + ' <span style="color:#64748b;font-size:11px">' + escapeHtml(p.timeWindow) + '</span>';
            if (p.recommendation) {
              html += '<div style="font-size:12px;color:#94A3B8;margin-top:2px;margin-left:20px">→ ' + escapeHtml(p.recommendation) + '</div>';
            }
            html += '</div>';
          }
        }

        if (!html) {
          html = '<div style="color:#22c55e;font-size:13px;padding:8px 0">✅ Clean week — no patterns detected</div>';
        }

        body.innerHTML = html;
      } catch(e) {
        card.style.display = 'none';
      }
    }

    async function copyCampusValue(value, okMessage) {
      if (!value) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          toast(okMessage || 'Copied');
          return;
        }
      } catch { /* fallback below */ }
      modalCopyValue('Copy value', value);
    }

    async function loadCampuses() {
      try {
        const payload = await api('GET', '/api/church/campuses');
        campusData = Array.isArray(payload) ? payload : (Array.isArray(payload.campuses) ? payload.campuses : []);
        const limits = (!Array.isArray(payload) && payload && payload.limits) ? payload.limits : null;

        const noteEl = document.getElementById('campus-plan-note');
        const createBtn = document.getElementById('btn-create-campus');
        const nameEl = document.getElementById('campus-name');
        const locEl = document.getElementById('campus-location');
        if (noteEl) {
          if (limits) {
            const tierLabel = String(limits.tier || 'connect').toUpperCase();
            noteEl.innerHTML = '<strong>Room Limit:</strong> ' + tierLabel + ' plan: ' + (limits.maxTotal >= 999 ? 'unlimited' : 'up to ' + limits.maxTotal) + ' room' + (limits.maxTotal === 1 ? '' : 's') + '. You are using ' + limits.usedTotal + '.';
            noteEl.style.display = 'block';
          } else {
            noteEl.style.display = 'none';
            noteEl.textContent = '';
          }
        }
        if (createBtn) {
          const canAdd = !limits || limits.canAdd;
          createBtn.disabled = !canAdd;
          createBtn.style.opacity = canAdd ? '1' : '0.55';
          if (nameEl) nameEl.disabled = !canAdd;
          if (locEl) locEl.disabled = !canAdd;
        }

        const tbody = document.getElementById('campuses-tbody');
        if (!campusData.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">No linked campuses yet.</td></tr>';
          return;
        }

        // Cross-campus summary card
        var summaryEl = document.getElementById('campus-summary');
        if (campusData.length > 0) {
          summaryEl.style.display = '';
          var onlineCount = campusData.filter(function(c) { return c.connected; }).length;
          var totalAlerts = campusData.reduce(function(s, c) { return s + (c.recentAlerts || 0); }, 0);
          document.getElementById('cs-total').textContent = campusData.length + 1;
          document.getElementById('cs-online').textContent = onlineCount;
          document.getElementById('cs-offline').textContent = campusData.length - onlineCount;
          document.getElementById('cs-alerts').textContent = totalAlerts;
          document.getElementById('cs-alerts').style.color = totalAlerts > 0 ? '#eab308' : '#22c55e';
        } else {
          summaryEl.style.display = 'none';
        }

        tbody.innerHTML = campusData.map(function(c) {
          var status = c.connected ? 'Online' : 'Offline';
          var statusClass = c.connected ? 'badge-green' : 'badge-gray';
          var code = c.registrationCode || '\u2014';
          var location = c.location ? ('<div style="color:#64748B;font-size:12px">' + escapeHtml(c.location) + '</div>') : '';

          // Health column
          var healthHtml = '';
          if (c.lastSession) {
            var grade = c.lastSession.grade || '\u2014';
            var gradeColor = grade.startsWith('A') ? '#22c55e' : grade.startsWith('B') ? '#eab308' : '#ef4444';
            healthHtml += '<span style="color:' + gradeColor + ';font-weight:700">' + grade + '</span> ';
          }
          if (c.recentAlerts > 0) {
            healthHtml += '<span style="color:#eab308;font-size:11px">' + c.recentAlerts + ' alert' + (c.recentAlerts !== 1 ? 's' : '') + '</span>';
          } else {
            healthHtml += '<span style="color:#22c55e;font-size:11px">Clean</span>';
          }
          if (c.lastSeen) {
            var ago = timeAgo(c.lastSeen);
            healthHtml += '<div style="color:#475569;font-size:10px">Seen ' + ago + '</div>';
          }

          return '<tr>' +
            '<td>' +
              '<span class="campus-name-display" data-campus-id="' + c.churchId + '" style="cursor:pointer" title="Click to rename">' + escapeHtml(c.name) + '</span>' +
              location +
            '</td>' +
            '<td><span class="badge ' + statusClass + '">' + status + '</span></td>' +
            '<td>' + healthHtml + '</td>' +
            '<td><code style="font-size:12px;color:#22c55e">' + code + '</code><div><button class="btn-sm campus-copy-code-btn" data-campus-id="' + c.churchId + '">Copy</button></div></td>' +
            '<td><button class="btn-sm campus-edit-btn" data-campus-id="' + c.churchId + '" style="margin-bottom:4px">Edit</button> <button class="btn-danger campus-remove-btn" data-campus-id="' + c.churchId + '">Remove</button></td>' +
          '</tr>';
        }).join('');

        // Wire event listeners
        tbody.querySelectorAll('.campus-copy-code-btn').forEach(function(btn) {
          btn.addEventListener('click', function() { copyCampusCode(btn.getAttribute('data-campus-id')); });
        });
        tbody.querySelectorAll('.campus-edit-btn').forEach(function(btn) {
          btn.addEventListener('click', function() { editCampus(btn.getAttribute('data-campus-id')); });
        });
        tbody.querySelectorAll('.campus-remove-btn').forEach(function(btn) {
          btn.addEventListener('click', function() { removeCampus(btn.getAttribute('data-campus-id')); });
        });
      } catch (e) {
        document.getElementById('campuses-tbody').innerHTML = '<tr><td colspan="5" style="color:#ef4444;text-align:center;padding:20px">Failed to load campuses.</td></tr>';
      }
    }

    function copyCampusCode(churchId) {
      const c = getCampusById(churchId);
      copyCampusValue(c && c.registrationCode, 'Registration code copied');
    }

    function copyCampusToken(churchId) {
      const c = getCampusById(churchId);
      copyCampusValue(c && c.token, 'Connection token copied');
    }

    async function addCampus() {
      const createBtn = document.getElementById('btn-create-campus');
      if (createBtn && createBtn.disabled) {
        return toast('Your current plan has reached its campus limit', true);
      }
      const nameEl = document.getElementById('campus-name');
      const locEl = document.getElementById('campus-location');
      const name = String(nameEl.value || '').trim();
      const location = String(locEl.value || '').trim();
      if (!name) return toast('Campus name is required', true);

      try {
        const created = await api('POST', '/api/church/campuses', { name, location });
        nameEl.value = '';
        locEl.value = '';
        toast('Campus created');
        loadCampuses();
        if (created && created.registrationCode) {
          modalCopyValue('Registration Code', created.registrationCode);
        }
      } catch (e) {
        toast(e.message || 'Failed to create campus', true);
      }
    }

    async function removeCampus(churchId) {
      const campus = getCampusById(churchId);
      const label = campus ? campus.name : 'this campus';
      if (!await modalConfirm('Remove ' + label + '? This will disconnect it and delete its campus record.', { title: 'Remove Campus', okLabel: 'Remove', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/campuses/' + churchId);
        toast('Campus removed');
        loadCampuses();
      } catch (e) {
        toast(e.message || 'Failed to remove campus', true);
      }
    }

    async function editCampus(churchId) {
      var campus = getCampusById(churchId);
      if (!campus) return;
      var newName = await modalPrompt('Rename campus', campus.name, { title: 'Edit Campus' });
      if (newName === null) return;
      newName = String(newName).trim();
      if (!newName) return toast('Campus name cannot be empty', true);
      if (newName === campus.name) return;
      try {
        await api('PATCH', '/api/church/campuses/' + churchId, { name: newName });
        toast('Campus renamed');
        loadCampuses();
      } catch (e) {
        toast(e.message || 'Failed to rename campus', true);
      }
    }

    function timeAgo(iso) {
      if (!iso) return '';
      var ms = Date.now() - new Date(iso).getTime();
      if (ms < 60000) return 'just now';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
      if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
      return Math.floor(ms / 86400000) + 'd ago';
    }

    // ── TDs ──────────────────────────────────────────────────────────────────
    async function loadTds() {
      try {
        const tds = await api('GET', '/api/church/tds');
        const tbody = document.getElementById('tds-tbody');
        if (!tds.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">No tech directors yet.</td></tr>';
          return;
        }
        tbody.innerHTML = tds.map(td => \`
          <tr>
            <td>\${escapeHtml(td.name || '')}</td>
            <td><span class="badge badge-gray">\${escapeHtml(td.role || 'td')}</span></td>
            <td style="color:#94A3B8">\${escapeHtml(td.email || '—')}</td>
            <td style="color:#94A3B8;font-size:12px">\${escapeHtml(td.phone || '—')}</td>
            <td><button class="btn-danger" onclick="removeTd('\${escapeHtml(String(td.id || ''))}')">Remove</button></td>
          </tr>\`).join('');
        document.getElementById('stat-tds').textContent = tds.length;
      } catch(e) { toast('Failed to load TDs', true); }
    }

    async function addTd() {
      const name = document.getElementById('td-name').value.trim();
      if (!name) return toast('Name required', true);
      try {
        await api('POST', '/api/church/tds', {
          name,
          role: document.getElementById('td-role').value,
          email: document.getElementById('td-email').value,
          phone: document.getElementById('td-phone').value,
        });
        document.getElementById('modal-add-td').classList.remove('open');
        document.getElementById('td-name').value = '';
        document.getElementById('td-email').value = '';
        document.getElementById('td-phone').value = '';
        loadTds();
        toast('TD added');
      } catch(e) { toast(e.message, true); }
    }

    async function removeTd(id) {
      if (!await modalConfirm('Remove this tech director?', { title: 'Remove TD', okLabel: 'Remove', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/tds/' + id);
        loadTds();
        toast('TD removed');
      } catch(e) { toast(e.message, true); }
    }

    // ── Schedule ─────────────────────────────────────────────────────────────
    function pad2(n) {
      return String(n).padStart(2, '0');
    }

    function toMinutes(hhmm) {
      const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
      return (h * 60) + min;
    }

    function fromMinutes(total) {
      const safe = Math.max(0, Math.min(1439, Number(total) || 0));
      const h = Math.floor(safe / 60);
      const m = safe % 60;
      return pad2(h) + ':' + pad2(m);
    }

    function normalizeTime(value) {
      const mins = toMinutes(value);
      return mins === null ? '' : fromMinutes(mins);
    }

    function defaultEndFor(start) {
      const startMin = toMinutes(start);
      if (startMin === null) return '11:00';
      return fromMinutes(Math.min(1439, startMin + 120));
    }

    function emptyScheduleObject() {
      const out = {};
      SCHEDULE_DAYS.forEach(function(day) { out[day] = []; });
      return out;
    }

    function normalizeSchedulePayload(raw) {
      const out = emptyScheduleObject();

      // Legacy service_times array support (day/startHour/startMin/durationHours)
      if (Array.isArray(raw)) {
        raw.forEach(function(item) {
          const dayNum = Number(item && item.day);
          if (!Number.isInteger(dayNum) || dayNum < 0 || dayNum > 6) return;
          const dayKey = SCHEDULE_DAYS[dayNum];
          const startHour = Number(item && item.startHour);
          const startMin = Number((item && item.startMin) || 0);
          const durationHours = Number((item && item.durationHours) || 2);
          if (!Number.isFinite(startHour) || !Number.isFinite(startMin) || !Number.isFinite(durationHours)) return;
          const start = fromMinutes((startHour * 60) + startMin);
          const end = fromMinutes((startHour * 60) + startMin + Math.max(15, Math.round(durationHours * 60)));
          out[dayKey].push({
            start: start,
            end: end,
            label: String((item && (item.label || item.title)) || '').trim(),
          });
        });
      }

      // Preferred object format: { sunday: [{start,end,label}], ... }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.keys(raw).forEach(function(k) {
          const dayKey = String(k || '').toLowerCase();
          if (!SCHEDULE_DAYS.includes(dayKey)) return;
          const entries = Array.isArray(raw[dayKey]) ? raw[dayKey] : [];
          entries.forEach(function(entry) {
            const start = normalizeTime(entry && (entry.start || entry.startTime));
            const end = normalizeTime(entry && (entry.end || entry.endTime));
            if (!start || !end) return;
            out[dayKey].push({
              start: start,
              end: end,
              label: String((entry && entry.label) || '').trim(),
            });
          });
        });
      }

      SCHEDULE_DAYS.forEach(function(dayKey) {
        out[dayKey].sort(function(a, b) {
          return (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0);
        });
      });

      return out;
    }

    function compactSchedule(scheduleObj) {
      const out = {};
      SCHEDULE_DAYS.forEach(function(day) {
        const entries = Array.isArray(scheduleObj[day]) ? scheduleObj[day] : [];
        if (entries.length) out[day] = entries;
      });
      return out;
    }

    function updateScheduleEmptyState() {
      const emptyEl = document.getElementById('schedule-empty');
      const rowsEl = document.getElementById('schedule-rows');
      if (!emptyEl || !rowsEl) return;
      emptyEl.style.display = rowsEl.children.length ? 'none' : 'block';
    }

    function buildDayOptionsHtml(selectedDay) {
      return SCHEDULE_DAYS.map(function(day) {
        return '<option value="' + day + '"' + (day === selectedDay ? ' selected' : '') + '>' + SCHEDULE_DAY_LABELS[day] + '</option>';
      }).join('');
    }

    function buildTimeSelectHtml(fieldName, value24) {
      var mins = toMinutes(value24);
      if (mins === null) mins = 9 * 60; // default 9:00 AM
      var h24 = Math.floor(mins / 60);
      var m = mins % 60;
      var h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24);
      var ampm = h24 < 12 ? 'AM' : 'PM';
      // Snap minutes to nearest 5
      var snapped = Math.round(m / 5) * 5;
      if (snapped === 60) { snapped = 0; h24++; h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24); ampm = h24 < 12 ? 'AM' : 'PM'; }

      var hourOpts = '';
      for (var i = 1; i <= 12; i++) {
        hourOpts += '<option value="' + i + '"' + (i === h12 ? ' selected' : '') + '>' + i + '</option>';
      }
      var minOpts = '';
      for (var v = 0; v < 60; v += 5) {
        minOpts += '<option value="' + v + '"' + (v === snapped ? ' selected' : '') + '>' + pad2(v) + '</option>';
      }
      var ampmOpts = '<option value="AM"' + (ampm === 'AM' ? ' selected' : '') + '>AM</option>' +
                     '<option value="PM"' + (ampm === 'PM' ? ' selected' : '') + '>PM</option>';

      return '<div class="time-select" data-schedule-field="' + fieldName + '">' +
        '<select class="time-hour">' + hourOpts + '</select>' +
        '<span>:</span>' +
        '<select class="time-min">' + minOpts + '</select>' +
        '<select class="time-ampm">' + ampmOpts + '</select>' +
        '</div>';
    }

    function readTimeSelect(container) {
      var h = parseInt(container.querySelector('.time-hour').value, 10);
      var m = parseInt(container.querySelector('.time-min').value, 10);
      var ampm = container.querySelector('.time-ampm').value;
      if (ampm === 'AM' && h === 12) h = 0;
      else if (ampm === 'PM' && h !== 12) h += 12;
      return pad2(h) + ':' + pad2(m);
    }

    function addScheduleRow(prefill) {
      const rowsEl = document.getElementById('schedule-rows');
      if (!rowsEl) return;

      const day = (prefill && SCHEDULE_DAYS.includes(prefill.day)) ? prefill.day : 'sunday';
      const start = normalizeTime(prefill && prefill.start) || '09:00';
      const end = normalizeTime(prefill && prefill.end) || defaultEndFor(start);
      const label = String((prefill && prefill.label) || '').trim();

      const row = document.createElement('div');
      row.className = 'schedule-row';
      row.innerHTML =
        '<select data-schedule-field="day">' + buildDayOptionsHtml(day) + '</select>' +
        buildTimeSelectHtml('start', start) +
        buildTimeSelectHtml('end', end) +
        '<input data-schedule-field="label" type="text" placeholder="Service label (optional)" value="' + label.replace(/"/g, '&quot;') + '">' +
        '<button class="btn-danger" type="button">Remove</button>';

      const removeBtn = row.querySelector('button');
      removeBtn.addEventListener('click', function() {
        row.remove();
        updateScheduleEmptyState();
      });

      rowsEl.appendChild(row);
      updateScheduleEmptyState();
    }

    function renderScheduleRows(scheduleObj) {
      const rowsEl = document.getElementById('schedule-rows');
      if (!rowsEl) return;
      rowsEl.innerHTML = '';

      let added = 0;
      SCHEDULE_DAYS.forEach(function(day) {
        const entries = Array.isArray(scheduleObj[day]) ? scheduleObj[day] : [];
        entries.forEach(function(entry) {
          addScheduleRow({ day: day, start: entry.start, end: entry.end, label: entry.label });
          added += 1;
        });
      });

      if (!added) {
        updateScheduleEmptyState();
      }
    }

    function collectScheduleFromRows() {
      const out = emptyScheduleObject();
      const rows = Array.from(document.querySelectorAll('#schedule-rows .schedule-row'));

      for (const row of rows) {
        const day = String(row.querySelector('[data-schedule-field="day"]')?.value || '').toLowerCase();
        const startEl = row.querySelector('.time-select[data-schedule-field="start"]');
        const endEl = row.querySelector('.time-select[data-schedule-field="end"]');
        const start = startEl ? normalizeTime(readTimeSelect(startEl)) : '';
        const end = endEl ? normalizeTime(readTimeSelect(endEl)) : '';
        const label = String(row.querySelector('[data-schedule-field="label"]')?.value || '').trim();

        if (!day || !SCHEDULE_DAYS.includes(day)) continue;
        if (!start && !end && !label) continue;
        if (!start || !end) throw new Error('Each service window needs both a start and end time');

        const startMin = toMinutes(start);
        const endMin = toMinutes(end);
        if (startMin === null || endMin === null) {
          throw new Error('Invalid time format');
        }
        // Allow midnight crossing (e.g. 11:00 PM to 1:00 AM)
        if (endMin <= startMin && endMin !== 0) {
          // endMin=0 means midnight, which is valid for crossing
          // Otherwise endMin < startMin means a midnight-crossing service (e.g. 23:00→01:00)
          if (endMin > startMin) throw new Error('End time must be after start time');
          // midnight crossing is OK — duration = (1440 - startMin) + endMin
        }
        if (endMin === startMin) {
          throw new Error('Start and end time cannot be the same');
        }

        out[day].push({ start: start, end: end, label: label });
      }

      SCHEDULE_DAYS.forEach(function(day) {
        out[day].sort(function(a, b) {
          return (toMinutes(a.start) || 0) - (toMinutes(b.start) || 0);
        });
      });

      return compactSchedule(out);
    }

    function getSelectedScheduleCampusId() {
      var sel = document.getElementById('schedule-campus-select');
      return (sel && sel.value) ? sel.value : '';
    }

    async function populateScheduleCampusPicker() {
      var picker = document.getElementById('schedule-campus-picker');
      var sel = document.getElementById('schedule-campus-select');
      if (!picker || !sel) return;
      try {
        var payload = await api('GET', '/api/church/campuses');
        var list = Array.isArray(payload) ? payload : (Array.isArray(payload.campuses) ? payload.campuses : []);
        if (!list.length) { picker.style.display = 'none'; return; }
        var prev = sel.value;
        sel.innerHTML = '<option value="">Main Campus</option>' + list.map(function(c) {
          return '<option value="' + c.churchId + '">' + escapeHtml(c.name || c.churchId) + '</option>';
        }).join('');
        if (prev) sel.value = prev;
        picker.style.display = '';
      } catch { picker.style.display = 'none'; }
    }

    async function loadSchedule() {
      try {
        await populateScheduleCampusPicker();
        var campusId = getSelectedScheduleCampusId();
        var url = '/api/church/schedule' + (campusId ? '?campusId=' + encodeURIComponent(campusId) : '');
        const raw = await api('GET', url);
        const normalized = normalizeSchedulePayload(raw);
        renderScheduleRows(normalized);
      } catch(e) { toast('Failed to load schedule', true); }
    }

    async function saveSchedule() {
      btnLoading('btn-save-schedule', 'Saving…');
      try {
        const schedule = collectScheduleFromRows();
        var campusId = getSelectedScheduleCampusId();
        var url = '/api/church/schedule' + (campusId ? '?campusId=' + encodeURIComponent(campusId) : '');
        await api('PUT', url, schedule);
        toast('Schedule saved');
      } catch(e) { toast(e.message || 'Unable to save schedule', true); }
      finally { btnReset('btn-save-schedule'); }
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    async function loadNotifications() {
      try {
        const d = await api('GET', '/api/church/me');
        notifData = d.notifications || {};
        document.getElementById('notif-email').checked = !!notifData.email;
        document.getElementById('notif-telegram').checked = !!notifData.telegram;
        document.getElementById('notif-sync').checked = notifData.sync !== false;
        document.getElementById('notif-digest').checked = !!notifData.digest;
        document.getElementById('notif-auto-recovery').checked = d.autoRecoveryEnabled !== false && d.autoRecoveryEnabled !== 0;
        document.getElementById('telegram-chat-id').value = d.telegramChatId || '';
        // Populate failover dropdowns from live equipment status
        if (d.status) populateFailoverInputs(d.status);
      } catch(e) { toast('Failed to load notifications', true); }
      // Load failover settings separately
      loadFailoverSettings();
    }

    async function saveNotifications() {
      try {
        await api('PUT', '/api/church/me', {
          notifications: {
            email:    document.getElementById('notif-email').checked,
            telegram: document.getElementById('notif-telegram').checked,
            sync:     document.getElementById('notif-sync').checked,
            digest:   document.getElementById('notif-digest').checked,
          },
          telegramChatId: document.getElementById('telegram-chat-id').value,
          autoRecoveryEnabled: document.getElementById('notif-auto-recovery').checked,
        });
        toast('Notification preferences saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Stream Failover Settings ─────────────────────────────────────────────
    function toggleFailoverAction() {
      var t = document.getElementById('failover-action-type').value;
      document.getElementById('failover-atem-fields').style.display = t === 'atem_switch' ? 'block' : 'none';
      document.getElementById('failover-videohub-fields').style.display = t === 'videohub_route' ? 'block' : 'none';
    }

    async function loadFailoverSettings() {
      try {
        var f = await api('GET', '/api/church/failover');
        document.getElementById('failover-enabled').checked = f.enabled;
        document.getElementById('failover-config').style.display = f.enabled ? 'block' : 'none';
        document.getElementById('failover-black-threshold').value = f.blackThresholdS || 5;
        document.getElementById('failover-ack-timeout').value = f.ackTimeoutS || 30;
        if (f.action) {
          document.getElementById('failover-action-type').value = f.action.type || '';
          toggleFailoverAction();
          if (f.action.type === 'atem_switch') {
            // Set ATEM input after dropdown is populated
            setTimeout(function() {
              var sel = document.getElementById('failover-atem-input');
              if (sel) sel.value = String(f.action.input || '');
            }, 500);
          } else if (f.action.type === 'videohub_route') {
            setTimeout(function() {
              var oSel = document.getElementById('failover-vh-output');
              var iSel = document.getElementById('failover-vh-input');
              if (oSel) oSel.value = String(f.action.output || '');
              if (iSel) iSel.value = String(f.action.input || '');
            }, 500);
          }
        }
      } catch(e) { /* failover not configured yet — use defaults */ }
    }

    // Toggle config visibility when enabled/disabled
    document.getElementById('failover-enabled').addEventListener('change', function() {
      document.getElementById('failover-config').style.display = this.checked ? 'block' : 'none';
    });

    function populateFailoverInputs(status) {
      // Populate ATEM input dropdown
      var atemSel = document.getElementById('failover-atem-input');
      if (atemSel && status && status.atem && status.atem.inputLabels) {
        var labels = status.atem.inputLabels;
        var prevVal = atemSel.value;
        atemSel.innerHTML = '<option value="">— Select safe source —</option>';
        // Standard inputs
        Object.keys(labels).sort(function(a, b) { return Number(a) - Number(b); }).forEach(function(id) {
          var opt = document.createElement('option');
          opt.value = id;
          opt.textContent = id + ' — ' + labels[id];
          atemSel.appendChild(opt);
        });
        // Always add media players (may not be in inputLabels)
        [{ id: 3010, name: 'Media Player 1' }, { id: 3020, name: 'Media Player 2' }].forEach(function(mp) {
          if (!labels[String(mp.id)]) {
            var opt = document.createElement('option');
            opt.value = mp.id;
            opt.textContent = mp.id + ' — ' + mp.name;
            atemSel.appendChild(opt);
          }
        });
        if (prevVal) atemSel.value = prevVal;
      }

      // Populate VideoHub dropdowns
      if (status && status.videoHubs && status.videoHubs.length > 0) {
        var hub = status.videoHubs[0];
        var oSel = document.getElementById('failover-vh-output');
        var iSel = document.getElementById('failover-vh-input');
        if (oSel && hub.outputLabels) {
          var prevO = oSel.value;
          oSel.innerHTML = '<option value="">— Select output —</option>';
          hub.outputLabels.forEach(function(l, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i + ' — ' + (l || 'Output ' + i);
            oSel.appendChild(opt);
          });
          if (prevO) oSel.value = prevO;
        }
        if (iSel && hub.inputLabels) {
          var prevI = iSel.value;
          iSel.innerHTML = '<option value="">— Select safe source —</option>';
          hub.inputLabels.forEach(function(l, i) {
            var opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i + ' — ' + (l || 'Input ' + i);
            iSel.appendChild(opt);
          });
          if (prevI) iSel.value = prevI;
        }
      }
    }

    async function saveFailoverSettings() {
      try {
        var actionType = document.getElementById('failover-action-type').value;
        var action = null;
        if (actionType === 'atem_switch') {
          var input = document.getElementById('failover-atem-input').value;
          if (!input) { toast('Select an ATEM input for failover', true); return; }
          action = { type: 'atem_switch', input: Number(input) };
        } else if (actionType === 'videohub_route') {
          var output = document.getElementById('failover-vh-output').value;
          var vhInput = document.getElementById('failover-vh-input').value;
          if (!output || !vhInput) { toast('Select VideoHub output and input for failover', true); return; }
          action = { type: 'videohub_route', output: Number(output), input: Number(vhInput), hubIndex: 0 };
        }

        var enabled = document.getElementById('failover-enabled').checked;
        if (enabled && !action) { toast('Configure a failover action before enabling', true); return; }

        await api('PUT', '/api/church/failover', {
          enabled: enabled,
          blackThresholdS: Number(document.getElementById('failover-black-threshold').value) || 5,
          ackTimeoutS: Number(document.getElementById('failover-ack-timeout').value) || 30,
          action: action,
        });
        toast('Failover settings saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Guest Tokens ──────────────────────────────────────────────────────────
    async function loadGuests() {
      try {
        const tokens = await api('GET', '/api/church/guest-tokens');
        const tbody = document.getElementById('guests-tbody');
        if (!tokens.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="color:#475569;text-align:center;padding:20px">No guest tokens.</td></tr>';
          return;
        }
        tbody.innerHTML = tokens.map(t => \`
          <tr>
            <td><code style="font-size:11px;color:#22c55e">\${t.token.slice(0,16)}…</code></td>
            <td style="color:#94A3B8">\${t.label || '—'}</td>
            <td style="color:\${t.registered ? '#22c55e' : '#64748B'};font-size:12px">\${t.registered ? '\\u2713 Claimed' : 'Unclaimed'}</td>
            <td style="color:#94A3B8;font-size:12px">\${new Date(t.createdAt).toLocaleDateString()}</td>
            <td style="color:#94A3B8;font-size:12px">\${t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'No expiry'}</td>
            <td><button class="btn-danger" onclick="revokeToken('\${t.token}')">Revoke</button></td>
          </tr>\`).join('');
      } catch(e) { toast('Failed to load tokens', true); }
    }

    async function generateGuestToken() {
      const label = await modalPrompt('Label for this token (e.g. "Visiting TD — March 9")', '', { title: 'New Guest Token' });
      if (label === null) return;
      try {
        const t = await api('POST', '/api/church/guest-tokens', { label });
        toast('Token created');
        loadGuests();
        modalCopyValue('Guest Token (shown once)', t.token);
      } catch(e) { toast(e.message, true); }
    }

    async function revokeToken(token) {
      if (!await modalConfirm('Revoke this guest token? Connected guests will lose access immediately.', { title: 'Revoke Token', okLabel: 'Revoke', dangerOk: true })) return;
      try {
        await api('DELETE', '/api/church/guest-tokens/' + encodeURIComponent(token));
        loadGuests();
        toast('Token revoked');
      } catch(e) { toast(e.message, true); }
    }

    // ── Sessions ──────────────────────────────────────────────────────────────
    async function loadSessions() {
      try {
        const sessions = await api('GET', '/api/church/sessions');
        const tbody = document.getElementById('sessions-tbody');
        if (!sessions.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">No sessions recorded yet.</td></tr>';
          return;
        }
        tbody.innerHTML = sessions.map(s => {
          const start = new Date(s.started_at);
          const end = s.ended_at ? new Date(s.ended_at) : null;
          const dur = end ? Math.round((end - start) / 60000) + 'm' : 'Active';
          return \`<tr>
            <td>\${start.toLocaleDateString()} <span style="color:#475569">\${start.toLocaleTimeString()}</span></td>
            <td>\${dur}</td>
            <td>\${s.peak_viewers || '—'}</td>
            <td><span class="badge \${s.ended_at ? 'badge-gray' : 'badge-green'}">\${s.ended_at ? 'Ended' : 'Live'}</span></td>
          </tr>\`;
        }).join('');
        document.getElementById('stat-sessions').textContent = sessions.length;
      } catch(e) { toast('Failed to load sessions', true); }
    }

    // ── Billing ───────────────────────────────────────────────────────────────
    let billingData = null;
    async function loadBilling() {
      try {
        const b = await api('GET', '/api/church/billing');
        billingData = b;
        const statusColors = { active: '#22c55e', trialing: '#eab308', past_due: '#ef4444', canceled: '#94A3B8', pending: '#94A3B8', trial_expired: '#ef4444', inactive: '#94A3B8' };
        const statusLabels = { active: 'Active', trialing: 'Trial', past_due: 'Past Due', canceled: 'Canceled', pending: 'Pending', trial_expired: 'Expired', inactive: 'Inactive' };
        const tierName = b.tierName || b.tier || 'Connect';
        const intervalName = b.billingIntervalLabel || (b.billingInterval === 'annual' ? 'Annual' : (b.billingInterval === 'one_time' ? 'One-time' : 'Monthly'));
        const statusColor = statusColors[b.status] || '#94A3B8';
        const statusLabel = statusLabels[b.status] || b.status;

        let html = '<div class="card" style="margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">';
        html += '<span style="font-size:20px;font-weight:800;color:#F8FAFC">' + tierName + '</span>';
        html += '<span style="background:#111827;color:#94A3B8;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">' + intervalName + '</span>';
        html += '<span style="background:' + statusColor + ';color:#000;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">' + statusLabel + '</span>';
        html += '</div>';

        if (b.status === 'trialing' && b.trialDaysRemaining != null) {
          const pct = Math.max(0, Math.min(100, ((30 - b.trialDaysRemaining) / 30) * 100));
          html += '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:12px;margin-bottom:16px">';
          html += '<div style="color:#eab308;font-size:13px;font-weight:600;margin-bottom:6px">Trial: ' + b.trialDaysRemaining + ' days remaining</div>';
          html += '<div style="background:#1a2e1f;border-radius:4px;height:6px;overflow:hidden"><div style="background:#eab308;height:100%;width:' + pct + '%;border-radius:4px"></div></div>';
          html += '</div>';
        }

        if (b.status === 'past_due') {
          html += '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;margin-bottom:16px">';
          html += '<div style="color:#ef4444;font-size:13px;font-weight:600">Payment failed — update your card to avoid service interruption.</div></div>';
        }

        html += '<h3 style="font-size:14px;color:#F8FAFC;margin:12px 0 8px">Your Plan Includes</h3>';
        html += '<div class="grid-2col" style="gap:6px;font-size:13px">';
        const features = b.features || {};
        const includedFeatures = [
          ['ATEM + encoder monitoring (OBS, vMix, NDI, hardware)', true],
          ['Pre-service checks', true],
          ['Slack + Telegram alerts', true],
          ['Auto-recovery', true],
          ['ProPresenter control', features.propresenter],
          ['On-call TD rotation', features.oncall],
          ['Live video preview', features.livePreview],
          ['AI Autopilot', features.autopilot],
          ['Planning Center sync', features.planningCenter],
          ['Monthly reports', features.monthlyReport],
        ];
        includedFeatures.forEach(function(f) {
          if (f[1]) html += '<div style="color:#94A3B8">\\u2713 ' + f[0] + '</div>';
        });
        html += '</div></div>';

        // AI Diagnostics usage progress bar
        if (b.aiUsage && b.aiUsage.diagnosticLimit !== Infinity && b.aiUsage.diagnosticLimit !== null) {
          var aiPct = Math.min(100, Math.round((b.aiUsage.diagnosticUsage / b.aiUsage.diagnosticLimit) * 100));
          var aiBarColor = aiPct >= 80 ? '#eab308' : '#22c55e';
          html += '<div class="card" style="margin-bottom:16px">';
          html += '<h3 style="font-size:14px;color:#F8FAFC;margin:0 0 8px">AI Diagnostics</h3>';
          html += '<div style="color:#94A3B8;font-size:13px;margin-bottom:8px">' + b.aiUsage.diagnosticUsage + ' / ' + b.aiUsage.diagnosticLimit + ' messages this month</div>';
          html += '<div style="background:#1F2937;border-radius:4px;height:6px;overflow:hidden">';
          html += '<div style="background:' + aiBarColor + ';height:100%;width:' + aiPct + '%;border-radius:4px;transition:width 0.3s"></div></div>';
          html += '<div style="color:#64748B;font-size:11px;margin-top:4px">Resets ' + (b.aiUsage.diagnosticResetDate || '1st of next month') + '</div>';
          html += '</div>';
        }

        // Upgrade cards for locked features
        var currentTier = (b.tier || 'connect').toLowerCase();

        if (currentTier === 'connect') {
          // Plus upgrade card
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PLUS</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Plus</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">\\u2726 ProPresenter control (looks, timers, stage)</div>';
          html += '<div style="color:#94A3B8">\\u2726 Live video preview stream</div>';
          html += '<div style="color:#94A3B8">\\u2726 On-call TD rotation</div>';
          html += '<div style="color:#94A3B8">\\u2726 Up to 3 rooms / campuses</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\\'plus\\')" id="btn-upgrade-plus" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">Upgrade to Plus \\u2014 $99/mo \\u2192</button>';
          html += '</div>';

          // Pro upgrade card
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PRO</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Pro</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">\\u2726 Everything in Plus</div>';
          html += '<div style="color:#94A3B8">\\u2726 AI Autopilot automation rules</div>';
          html += '<div style="color:#94A3B8">\\u2726 Planning Center sync + write-back</div>';
          html += '<div style="color:#94A3B8">\\u2726 Monthly leadership reports</div>';
          html += '<div style="color:#94A3B8">\\u2726 Up to 10 rooms / campuses</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\\'pro\\')" id="btn-upgrade-pro" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:transparent;color:#22c55e;border:1px solid rgba(34,197,94,0.3);cursor:pointer">Upgrade to Pro \\u2014 $149/mo \\u2192</button>';
          html += '</div>';
        } else if (currentTier === 'plus') {
          // Pro upgrade card only
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PRO</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Pro</span>';
          html += '</div>';
          html += '<div class="grid-2col" style="gap:6px;font-size:13px;margin-bottom:16px">';
          html += '<div style="color:#94A3B8">\\u2726 AI Autopilot automation rules</div>';
          html += '<div style="color:#94A3B8">\\u2726 Planning Center sync + write-back</div>';
          html += '<div style="color:#94A3B8">\\u2726 Monthly leadership reports</div>';
          html += '<div style="color:#94A3B8">\\u2726 Up to 10 rooms / campuses</div>';
          html += '</div>';
          html += '<button onclick="upgradePlan(\\'pro\\')" id="btn-upgrade-pro" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">Upgrade to Pro \\u2014 $149/mo \\u2192</button>';
          html += '</div>';
        }

        if (b.portalUrl) {
          html += '<a href="' + b.portalUrl + '" target="_blank" class="btn-primary" style="display:inline-block;text-decoration:none;margin-bottom:12px">Manage Subscription \\u2192</a>';
          html += '<p style="color:#475569;font-size:12px">Update payment method, view invoices, or cancel your subscription via Stripe\\u2019s secure portal.</p>';
        }

        // Reactivation button for cancelled/expired/inactive churches
        if (['trial_expired','canceled','inactive'].includes(b.status)) {
          html += '<div style="margin-top:16px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="font-size:15px;font-weight:700;color:#22c55e;margin-bottom:8px">Reactivate Your Subscription</div>';
          html += '<div style="font-size:13px;color:#94A3B8;line-height:1.6;margin-bottom:14px">Your settings and data are still here. Reactivate to resume monitoring immediately.</div>';
          html += '<button onclick="reactivateSubscription()" id="btn-reactivate" class="btn-primary" style="cursor:pointer">Reactivate Now \\u2192</button>';
          html += '</div>';
        }

        // Downgrade option (only show for tiers above connect)
        if (['active','trialing'].includes(b.status) && currentTier !== 'connect') {
          html += '<div style="margin-top:16px;background:#0F1613;border:1px solid #1a2e1f;border-radius:12px;padding:16px 24px">';
          html += '<div style="font-size:13px;color:#94A3B8;margin-bottom:8px">Need fewer features?</div>';
          if (currentTier === 'managed' || currentTier === 'pro') {
            html += '<button onclick="downgradePlan(\\'plus\\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer;margin-right:8px">Downgrade to Plus ($99/mo)</button>';
            html += '<button onclick="downgradePlan(\\'connect\\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Downgrade to Connect ($49/mo)</button>';
          } else if (currentTier === 'plus') {
            html += '<button onclick="downgradePlan(\\'connect\\')" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Downgrade to Connect ($49/mo)</button>';
          }
          html += '</div>';
        }

        // Data export & account management
        html += '<div style="margin-top:24px;padding-top:16px;border-top:1px solid #1a2e1f">';
        html += '<div style="font-size:14px;font-weight:700;color:#F8FAFC;margin-bottom:12px">Data & Privacy</div>';
        html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
        html += '<button onclick="exportData()" style="background:none;border:1px solid #1a2e1f;color:#94A3B8;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Export All Data (JSON)</button>';
        html += '<button onclick="deleteAccount()" style="background:none;border:1px solid rgba(239,68,68,0.3);color:#ef4444;font-size:12px;padding:6px 14px;border-radius:6px;cursor:pointer">Delete Account</button>';
        html += '</div>';
        html += '<p style="color:#475569;font-size:11px;margin-top:8px;line-height:1.5">Export downloads a JSON file with all your church data. Deletion is permanent and cannot be undone.</p>';
        html += '</div>';

        html += '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #1a2e1f">';
        html += '<p style="color:#475569;font-size:12px;line-height:1.6">Cancel anytime from the Stripe portal. Service continues through the end of your billing period. No partial-month refunds. Questions? <a href="mailto:support@tallyconnect.app" style="color:#22c55e">support@tallyconnect.app</a></p>';
        html += '</div>';

        document.getElementById('billing-content').innerHTML = html;
        updateBillingBanner(b);
        renderUpgradeBanner(b);
      } catch(e) {
        document.getElementById('billing-content').innerHTML = '<div style="color:#475569;text-align:center;padding:30px">Billing info unavailable. <a href="mailto:support@tallyconnect.app" style="color:#22c55e">Contact support</a></div>';
      }
    }

    function updateBillingBanner(b) {
      var el = document.getElementById('billing-banner');
      if (!el) return;
      if (b.status === 'trialing' && b.trialDaysRemaining != null && b.trialDaysRemaining <= 7) {
        el.innerHTML = '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#eab308">Your trial ends in ' + b.trialDaysRemaining + ' day' + (b.trialDaysRemaining !== 1 ? 's' : '') + '. <a href="https://tallyconnect.app/signup" style="color:#22c55e;font-weight:700">Subscribe now</a> to keep your service running.</div>';
      } else if (b.status === 'past_due') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">Payment failed. <a href="' + (b.portalUrl || 'https://tallyconnect.app/signup') + '" style="color:#22c55e;font-weight:700">Update your card</a> to avoid service interruption.</div>';
      } else if (b.status === 'canceled' || b.status === 'trial_expired') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">Your subscription has ended. <a href="#" onclick="showPage(\\'billing\\',document.querySelector(\\'[data-page=billing]\\'));return false" style="color:#22c55e;font-weight:700">Reactivate</a> to continue monitoring your services.</div>';
      } else if (b.status === 'inactive' || b.status === 'pending') {
        el.innerHTML = '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#eab308">Your subscription is not yet active. <a href="https://tallyconnect.app/signup" style="color:#22c55e;font-weight:700">Complete checkout</a> to start monitoring.</div>';
      } else {
        el.innerHTML = '';
      }
    }

    // ── Upgrade Banner (Overview page) ──────────────────────────────────────
    function renderUpgradeBanner(b) {
      var el = document.getElementById('upgrade-banner');
      if (!el) return;
      var tier = (b.tier || 'connect').toLowerCase();
      var status = b.status || 'inactive';

      // Only show for active/trialing on connect or plus
      if (!['active', 'trialing'].includes(status)) { el.innerHTML = ''; return; }
      if (tier !== 'connect' && tier !== 'plus') { el.innerHTML = ''; return; }

      // Check localStorage dismiss
      var dismissKey = 'tally_upgrade_dismissed_' + tier;
      if (localStorage.getItem(dismissKey) === '1') { el.innerHTML = ''; return; }

      var nextTierSlug = tier === 'connect' ? 'plus' : 'pro';
      var nextTier = tier === 'connect' ? 'Plus' : 'Pro';
      var nextPrice = tier === 'connect' ? '$99' : '$149';
      var headline, body;

      if (tier === 'connect') {
        headline = 'Unlock all 17 integrations';
        body = 'Your Connect plan supports ATEM, OBS, and vMix. Upgrade to Plus for ProPresenter control, live video preview, on-call TD rotation, and 14 more device integrations.';
      } else {
        headline = 'Automate your Sundays';
        body = 'Upgrade to Pro for AI Autopilot (auto-start streaming and recording when your service window opens), Planning Center sync, and monthly leadership reports.';
      }

      el.innerHTML = '<div style="margin-bottom:20px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.25);border-radius:12px;padding:20px 24px;position:relative">' +
        '<button onclick="dismissUpgradeBanner(\\''+dismissKey+'\\')" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#475569;font-size:16px;cursor:pointer;padding:4px" title="Dismiss">\\u2715</button>' +
        '<div style="font-size:15px;font-weight:700;color:#22c55e;margin-bottom:6px">' + headline + '</div>' +
        '<div style="font-size:13px;color:#94A3B8;line-height:1.6;margin-bottom:14px;padding-right:24px">' + body + '</div>' +
        '<button onclick="upgradePlan(\\'' + nextTierSlug + '\\')" id="btn-upgrade-' + nextTierSlug + '-banner" style="display:inline-block;padding:8px 20px;font-size:13px;font-weight:700;border-radius:8px;background:#22c55e;color:#000;border:none;cursor:pointer">Upgrade to ' + nextTier + ' \\u2014 ' + nextPrice + '/mo \\u2192</button>' +
        '</div>';
    }

    function dismissUpgradeBanner(key) {
      localStorage.setItem(key, '1');
      var el = document.getElementById('upgrade-banner');
      if (el) el.innerHTML = '';
    }

    // ── Upgrade Plan ─────────────────────────────────────────────────────────
    async function upgradePlan(tier) {
      var tierNames = { plus: 'Plus', pro: 'Pro', managed: 'Enterprise' };
      var label = tierNames[tier] || tier;

      if (!await modalConfirm('Upgrade to ' + label + '? Your subscription will be updated immediately with prorated billing.', { title: 'Upgrade Plan', okLabel: 'Upgrade' })) return;

      // Disable all upgrade buttons and show loading
      var btns = document.querySelectorAll('[id^="btn-upgrade-"]');
      btns.forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
      var clickedBtn = document.getElementById('btn-upgrade-' + tier);
      var origText = clickedBtn ? clickedBtn.textContent : '';
      if (clickedBtn) clickedBtn.textContent = 'Upgrading…';

      try {
        var data = await api('POST', '/api/church/billing/upgrade', { tier: tier });

        if (data.redirect) {
          // No Stripe subscription yet — redirect to signup
          window.location.href = data.redirect;
          return;
        }

        if (data.success) {
          toast('Plan upgraded to ' + label + '!');
          // Reload billing data to reflect new plan
          await loadBilling();
          // Also update the overview plan badge
          var planEl = document.getElementById('plan-name');
          if (planEl) planEl.textContent = label;
        }
      } catch(e) {
        toast(e.message || 'Upgrade failed', true);
        // Restore buttons
        btns.forEach(function(b) { b.disabled = false; b.style.opacity = '1'; });
        if (clickedBtn) clickedBtn.textContent = origText;
      }
    }

    // ── Reactivate subscription ───────────────────────────────────────────────
    async function reactivateSubscription() {
      if (!await modalConfirm('Reactivate your subscription? You will be redirected to Stripe to complete payment.', { title: 'Reactivate Subscription', okLabel: 'Reactivate' })) return;
      var btn = document.getElementById('btn-reactivate');
      if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
      try {
        var data = await api('POST', '/api/church/billing/reactivate', {});
        if (data.url) {
          window.location.href = data.url;
        } else {
          toast('Reactivation started. Check your email for next steps.');
        }
      } catch(e) {
        toast(e.message || 'Reactivation failed', true);
        if (btn) { btn.disabled = false; btn.textContent = 'Reactivate Now →'; }
      }
    }

    // ── Downgrade plan ──────────────────────────────────────────────────────
    async function downgradePlan(tier) {
      var tierNames = { connect: 'Connect', plus: 'Plus' };
      var label = tierNames[tier] || tier;
      if (!await modalConfirm('Downgrade to ' + label + '? The change takes effect at the end of your current billing period.', { title: 'Downgrade Plan', okLabel: 'Downgrade', dangerOk: true })) return;
      try {
        var data = await api('POST', '/api/church/billing/downgrade', { tier: tier });
        if (data.success) {
          toast(data.message || 'Plan downgraded to ' + label);
          await loadBilling();
        }
      } catch(e) {
        toast(e.message || 'Downgrade failed', true);
      }
    }

    // ── Export data ─────────────────────────────────────────────────────────
    async function exportData() {
      try {
        var resp = await fetch('/api/church/data-export', { credentials: 'include', signal: AbortSignal.timeout(30000) });
        if (!resp.ok) throw new Error('Export failed');
        var blob = await resp.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'tally-data-export.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Data exported successfully');
      } catch(e) {
        toast(e.message || 'Export failed', true);
      }
    }

    // ── Delete account ──────────────────────────────────────────────────────
    async function deleteAccount() {
      var churchName = await modalPrompt('This will permanently delete your account and all data. To confirm, type your church name:', '', { title: '⚠️ Delete Account' });
      if (!churchName) return;
      try {
        var data = await api('DELETE', '/api/church/account', { confirmName: churchName });
        if (data.deleted) {
          await modalAlert('Your account has been deleted. You will be redirected to the homepage.', { title: 'Account Deleted' });
          window.location.href = 'https://tallyconnect.app';
        }
      } catch(e) {
        toast(e.message || 'Deletion failed', true);
      }
    }

    // ── Review system ─────────────────────────────────────────────────────────
    var reviewRating = 0;

    async function checkReviewEligibility() {
      try {
        var data = await api('GET', '/api/church/review');
        var banner = document.getElementById('review-prompt-banner');
        if (!banner) return;

        if (!data.hasReview && data.eligible && localStorage.getItem('tally_review_dismissed') !== '1') {
          banner.style.display = 'block';
          banner.innerHTML = '<div style="margin-bottom:20px;background:#0F1613;border:1px solid #1a3a24;border-radius:12px;padding:20px 24px">' +
            '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap">' +
            '<div style="flex:1;min-width:200px">' +
            '<div style="font-size:15px;font-weight:700;color:#F8FAFC">\\u2B50 Loving Tally? Share your experience</div>' +
            '<div style="font-size:13px;color:#94A3B8;margin-top:4px;line-height:1.5">Your review helps other church production teams discover Tally. Takes 60 seconds.</div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-shrink:0;align-items:center">' +
            '<button class="btn-primary" onclick="openReviewModal()" style="padding:8px 16px;font-size:13px">Leave a Review</button>' +
            '<button onclick="dismissReviewBanner()" style="background:none;border:1px solid #1a2e1f;color:#64748B;font-size:11px;padding:6px 12px;border-radius:6px;cursor:pointer">Later</button>' +
            '</div></div></div>';
        } else {
          banner.style.display = 'none';
        }

        // Auto-open from email link
        var params = new URLSearchParams(window.location.search);
        if (params.get('action') === 'review' && !data.hasReview) {
          openReviewModal();
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch(e) { /* not critical */ }
    }

    function openReviewModal() {
      document.getElementById('review-form-content').style.display = 'block';
      document.getElementById('review-thanks-content').style.display = 'none';
      document.getElementById('modal-review').classList.add('open');
      renderStars();
    }

    function closeReviewModal() {
      document.getElementById('modal-review').classList.remove('open');
    }

    function renderStars() {
      var container = document.getElementById('star-rating');
      if (!container) return;
      container.innerHTML = [1,2,3,4,5].map(function(n) {
        return '<button onclick="setRating(' + n + ')" style="background:none;border:none;font-size:28px;cursor:pointer;color:' + (n <= reviewRating ? '#22c55e' : '#334155') + ';transition:color 0.15s">\\u2605</button>';
      }).join('');
    }

    function setRating(n) {
      reviewRating = n;
      renderStars();
    }

    async function submitReview() {
      var body = (document.getElementById('review-body').value || '').trim();
      var name = (document.getElementById('review-name').value || '').trim();
      var role = (document.getElementById('review-role').value || '').trim();

      if (!reviewRating) return toast('Please select a star rating', true);
      if (!name) return toast('Please enter your name', true);
      if (body.length < 10) return toast('Please write at least a short review (10+ characters)', true);

      var btn = document.getElementById('btn-submit-review');
      var origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Submitting…';

      try {
        await api('POST', '/api/church/review', {
          rating: reviewRating,
          body: body,
          reviewerName: name,
          reviewerRole: role,
        });
        // Show thank-you with external links
        document.getElementById('review-form-content').style.display = 'none';
        document.getElementById('review-thanks-content').style.display = 'block';
        // Hide the banner
        var banner = document.getElementById('review-prompt-banner');
        if (banner) banner.style.display = 'none';
        toast('Review submitted! Thank you');
      } catch(e) {
        toast(e.message || 'Failed to submit review', true);
        btn.disabled = false;
        btn.textContent = origText;
      }
    }

    function dismissReviewBanner() {
      localStorage.setItem('tally_review_dismissed', '1');
      var banner = document.getElementById('review-prompt-banner');
      if (banner) banner.style.display = 'none';
    }

    // Character counter for review textarea
    (function() {
      var ta = document.getElementById('review-body');
      var counter = document.getElementById('review-char-count');
      if (ta && counter) {
        ta.addEventListener('input', function() {
          counter.textContent = ta.value.length;
        });
      }
    })();

    // ── Referral system ──────────────────────────────────────────────────────
    async function loadReferralCard() {
      var card = document.getElementById('referral-card');
      if (!card) return;
      try {
        var data = await api('GET', '/api/church/referrals');
        if (!data.referralCode) { card.style.display = 'none'; return; }

        var statsHtml = '';
        if (data.totalReferred > 0) {
          var creditDollars = data.totalCredits ? '$' + (data.totalCredits / 100).toFixed(0) : '$0';
          statsHtml = '<div style="display:flex;gap:24px;margin-bottom:14px">' +
            '<div><div style="font-size:20px;font-weight:800;color:#F8FAFC">' + data.totalReferred + '</div><div style="font-size:11px;color:#475569">Referred</div></div>' +
            '<div><div style="font-size:20px;font-weight:800;color:#22c55e">' + data.totalConverted + '</div><div style="font-size:11px;color:#475569">Signed up</div></div>' +
            '<div><div style="font-size:20px;font-weight:800;color:#22c55e">' + creditDollars + '</div><div style="font-size:11px;color:#475569">Credits earned</div></div>' +
            '</div>';
        }

        card.style.display = 'block';
        card.innerHTML = '<div style="margin-bottom:20px;background:#0F1613;border:1px solid #1a2e1f;border-radius:12px;padding:20px 24px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
          '<span style="font-size:18px">&#127873;</span>' +
          '<span style="font-size:15px;font-weight:700;color:#F8FAFC">Give a month, get a month</span>' +
          '</div>' +
          '<div style="font-size:13px;color:#94A3B8;line-height:1.5;margin-bottom:14px">' +
          'Share your link with another church. When they create a new account and subscribe, you both get a free month. ' +
          '<span style="color:#475569">Up to 5 free months. New accounts only.</span>' +
          '</div>' +
          statsHtml +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:8px 12px;font-family:ui-monospace,monospace;font-size:13px;color:#F8FAFC;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="referral-link">' + escapeHtml(data.shareUrl || '') + '</div>' +
          '<button onclick="copyReferralLink()" class="btn-primary" style="padding:8px 16px;font-size:13px;flex-shrink:0">Copy Link</button>' +
          '</div>' +
          '</div>';
      } catch(e) { card.style.display = 'none'; }
    }

    function copyReferralLink() {
      var link = document.getElementById('referral-link');
      if (!link) return;
      navigator.clipboard.writeText(link.textContent).then(function() {
        toast('Referral link copied!');
      }).catch(function() {
        // Fallback
        var range = document.createRange();
        range.selectNodeContents(link);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        toast('Referral link copied!');
      });
    }

    // ── Alerts ────────────────────────────────────────────────────────────────
    async function loadAlerts() {
      try {
        const alerts = await api('GET', '/api/church/alerts');
        var container = document.getElementById('alerts-content');
        if (!alerts.length) {
          container.innerHTML = '<p style="color:#475569;text-align:center;padding:20px">No alerts yet. Alerts will appear here during and after your services.</p>';
          return;
        }
        var sevColors = { INFO: '#22c55e', WARNING: '#eab308', CRITICAL: '#ef4444', EMERGENCY: '#ef4444' };
        var html = '<div style="display:flex;flex-direction:column;gap:8px">';
        alerts.forEach(function(a) {
          var color = sevColors[a.severity] || '#94A3B8';
          var time = new Date(a.created_at).toLocaleString();
          var type = (a.alert_type || '').replace(/_/g, ' ');
          var acked = a.acknowledged_at ? '<span style="color:#22c55e;font-size:11px">\\u2713 Acknowledged' + (a.acknowledged_by ? ' by ' + escapeHtml(a.acknowledged_by) : '') + '</span>' : '<span style="color:#475569;font-size:11px">Not acknowledged</span>';
          var ctx = a.context || {};
          var diag = ctx.diagnosis || ctx;

          html += '<div class="card" style="padding:12px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">';
          html += '<span style="background:' + color + ';color:#000;padding:1px 8px;border-radius:10px;font-size:10px;font-weight:700">' + (a.severity || 'INFO') + '</span>';
          html += '<span style="color:#F8FAFC;font-size:13px;font-weight:600">' + type + '</span>';
          html += '<span style="color:#475569;font-size:11px;margin-left:auto">' + time + '</span>';
          html += '</div>';
          html += '<div style="margin-top:4px">' + acked;
          if (a.resolved) html += ' <span style="color:#22c55e;font-size:11px;margin-left:8px">\\u2713 Resolved</span>';
          html += '</div>';

          if (diag.likely_cause || (diag.steps && diag.steps.length)) {
            html += '<div style="margin-top:8px;background:#09090B;border-radius:6px;padding:8px 12px;font-size:12px">';
            if (diag.likely_cause) html += '<div style="color:#94A3B8;margin-bottom:4px"><strong style="color:#F8FAFC">Likely cause:</strong> ' + escapeHtml(diag.likely_cause) + '</div>';
            if (diag.steps && diag.steps.length) {
              html += '<div style="color:#94A3B8"><strong style="color:#F8FAFC">Steps:</strong></div><ol style="margin:4px 0 0;padding-left:20px;color:#94A3B8">';
              diag.steps.forEach(function(s) { html += '<li>' + escapeHtml(s) + '</li>'; });
              html += '</ol>';
            }
            if (diag.canAutoFix) html += '<div style="color:#22c55e;font-size:11px;margin-top:4px">Tally can attempt auto-recovery for this issue.</div>';
            html += '</div>';
          }
          html += '</div>';
        });
        html += '</div>';
        container.innerHTML = html;
      } catch(e) {
        document.getElementById('alerts-content').innerHTML = '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
    }

    // ── Support info ──────────────────────────────────────────────────────────
    function loadSupportInfo() {
      var tier = billingData ? billingData.tier : (profileData.billing_tier || 'connect');
      var times = { connect: '48 hours', plus: '24 hours', pro: '12 hours', managed: '15 minutes (Mon\\u2013Fri 9\\u20135 ET + service windows)' };
      var el = document.getElementById('support-response-time');
      if (el) el.textContent = 'Response time for your plan: ' + (times[tier] || '48 hours');
      loadSupportStatus();
      loadSupportTickets();
    }

    function supportStateChip(state) {
      if (state === 'operational') return '<span style="color:#22c55e;font-weight:700">Operational</span>';
      if (state === 'degraded') return '<span style="color:#eab308;font-weight:700">Degraded</span>';
      return '<span style="color:#ef4444;font-weight:700">Outage</span>';
    }

    // ── Analytics ───────────────────────────────────────────────────────────
    var analyticsRange = 30;

    async function exportAnalyticsCSV() {
      try {
        var blob = await fetch('/api/church/analytics/export?days=' + analyticsRange, {
          headers: { 'Authorization': 'Bearer ' + token }
        }).then(function(r) {
          if (!r.ok) throw new Error('Export failed');
          return r.blob();
        });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'tally-sessions-' + analyticsRange + 'd.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('CSV exported');
      } catch (e) {
        toast(e.message || 'Export failed', true);
      }
    }

    function setAnalyticsRange(days, el) {
      analyticsRange = days;
      document.querySelectorAll('.analytics-range').forEach(function(b) { b.classList.remove('active'); });
      el.classList.add('active');
      loadAnalytics();
    }

    async function loadAnalytics() {
      try {
        var data = await api('GET', '/api/church/analytics?days=' + analyticsRange);
        renderAnalyticsKPI(data);
        renderStreamHealth(data);
        renderViewerChart(data);
        renderSessionStats(data);
        renderEquipmentPerf(data);
      } catch (e) {
        document.getElementById('a-health-content').innerHTML =
          '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
      // Load platform-specific audience data in parallel
      loadAudienceAnalytics();
    }

    function renderAnalyticsKPI(d) {
      var upEl = document.getElementById('a-uptime');
      upEl.textContent = d.uptime_pct.toFixed(1) + '%';
      upEl.style.color = d.uptime_pct >= 99 ? '#22c55e' : d.uptime_pct >= 95 ? '#eab308' : '#ef4444';
      document.getElementById('a-sessions-count').textContent = d.total_sessions;
      document.getElementById('a-avg-viewers').textContent =
        d.avg_peak_viewers !== null ? Math.round(d.avg_peak_viewers) : '\\u2014';
      document.getElementById('a-recovery-rate').textContent =
        d.auto_recovery_rate !== null ? d.auto_recovery_rate.toFixed(0) + '%' : '\\u2014';
      document.getElementById('a-recovery-rate').style.color =
        d.auto_recovery_rate === null ? '#94A3B8' : d.auto_recovery_rate >= 80 ? '#22c55e' : d.auto_recovery_rate >= 50 ? '#eab308' : '#ef4444';
    }

    function renderStreamHealth(d) {
      var el = document.getElementById('a-health-content');
      if (!d.total_sessions) {
        el.innerHTML = '<p style="color:#475569">No sessions in this period.</p>';
        return;
      }
      var html = '<div class="a-metric-grid">';
      html += aMetricBox(d.total_alerts, 'Total Alerts');
      html += aMetricBox(d.auto_recovered_count, 'Auto-Recovered');
      html += aMetricBox(d.escalated_count, 'Escalated');
      html += aMetricBox(d.audio_silence_total, 'Audio Silence Events');
      html += '</div>';

      if (d.top_event_types && d.top_event_types.length) {
        html += '<div style="margin-top:16px">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Most Common Issues</div>';
        var maxCount = d.top_event_types[0].count;
        d.top_event_types.forEach(function(t) {
          var pct = Math.round((t.count / maxCount) * 100);
          var label = t.type.replace(/_/g, ' ');
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label" title="' + escapeHtml(t.type) + '">' + escapeHtml(label) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + t.count + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      el.innerHTML = html;
    }

    function renderViewerChart(d) {
      var el = document.getElementById('a-viewer-chart');
      if (!d.viewer_trend || !d.viewer_trend.length) {
        el.innerHTML = '<p style="color:#475569">No viewer data available.</p>';
        return;
      }
      var maxV = Math.max.apply(null, d.viewer_trend.map(function(v) { return v.peak; }));
      if (maxV === 0) maxV = 1;
      var html = '';
      d.viewer_trend.forEach(function(v) {
        var pct = Math.round((v.peak / maxV) * 100);
        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label">' + escapeHtml(v.label) + '</div>';
        html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
        html += '<div class="a-bar-value">' + v.peak + '</div>';
        html += '</div>';
      });
      el.innerHTML = html;
    }

    // ── Audience (platform) analytics ────────────────────────────────
    async function loadAudienceAnalytics() {
      try {
        var d = await api('GET', '/api/church/analytics/audience?days=' + analyticsRange);
        renderAudienceKPI(d);
        renderPlatformChart(d);
        renderLiveChart(d);
      } catch (e) {
        document.getElementById('aud-platform-chart').innerHTML =
          '<p style="color:#ef4444">' + escapeHtml(e.message) + '</p>';
      }
    }

    function renderAudienceKPI(d) {
      var s = d.platform_summary || {};
      document.getElementById('aud-yt-peak').textContent = s.peak_youtube != null ? s.peak_youtube : '\\u2014';
      document.getElementById('aud-fb-peak').textContent = s.peak_facebook != null ? s.peak_facebook : '\\u2014';
      document.getElementById('aud-vim-peak').textContent = s.peak_vimeo != null ? s.peak_vimeo : '\\u2014';
      document.getElementById('aud-total-avg').textContent = s.avg_total != null ? Math.round(s.avg_total) : '\\u2014';
    }

    function renderPlatformChart(d) {
      var el = document.getElementById('aud-platform-chart');
      var trend = d.weekly_trend || [];
      if (!trend.length) {
        el.innerHTML = '<p style="color:#475569">No platform viewer data yet. Viewer counts are collected during live streams when YouTube, Facebook, or Vimeo API keys are configured.</p>';
        return;
      }
      var maxV = Math.max.apply(null, trend.map(function(w) { return w.peak_total || 0; }));
      if (maxV === 0) maxV = 1;

      var html = '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Weekly Viewers by Platform</div>';
      trend.forEach(function(w) {
        var yt = w.peak_youtube || 0;
        var fb = w.peak_facebook || 0;
        var vim = w.peak_vimeo || 0;
        var total = w.peak_total || 0;
        var pct = Math.round((total / maxV) * 100);

        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label">' + escapeHtml(w.week_key) + '</div>';
        html += '<div class="a-bar-track" style="position:relative">';
        // Stacked bar: YouTube (red) + Facebook (blue) + Vimeo (teal)
        var ytPct = total > 0 ? Math.round((yt / total) * pct) : 0;
        var fbPct = total > 0 ? Math.round((fb / total) * pct) : 0;
        var vimPct = total > 0 ? Math.round((vim / total) * pct) : 0;
        // Ensure at least the total is shown if there's no breakdown
        if (ytPct + fbPct + vimPct === 0 && total > 0) ytPct = pct;
        html += '<div style="position:absolute;left:0;top:0;bottom:0;width:' + (ytPct + fbPct + vimPct) + '%;display:flex">';
        if (ytPct > 0) html += '<div style="width:' + Math.round(ytPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#ff0000;border-radius:3px 0 0 3px;height:100%"></div>';
        if (fbPct > 0) html += '<div style="width:' + Math.round(fbPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#1877f2;height:100%"></div>';
        if (vimPct > 0) html += '<div style="width:' + Math.round(vimPct * 100 / (ytPct + fbPct + vimPct || 1)) + '%;background:#1ab7ea;border-radius:0 3px 3px 0;height:100%"></div>';
        html += '</div>';
        html += '</div>';
        html += '<div class="a-bar-value">' + total + '</div>';
        html += '</div>';
      });

      // Legend
      html += '<div style="display:flex;gap:16px;margin-top:10px;font-size:11px;color:#94A3B8">';
      html += '<span>\\u25cf <span style="color:#ff0000">YouTube</span></span>';
      html += '<span>\\u25cf <span style="color:#1877f2">Facebook</span></span>';
      html += '<span>\\u25cf <span style="color:#1ab7ea">Vimeo</span></span>';
      html += '</div>';
      el.innerHTML = html;
    }

    function renderLiveChart(d) {
      var snaps = d.recent_snapshots || [];
      var container = document.getElementById('aud-live-chart');
      var el = document.getElementById('aud-live-bars');
      if (!snaps.length) {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';
      var maxV = Math.max.apply(null, snaps.map(function(s) { return s.total || 0; }));
      if (maxV === 0) maxV = 1;

      var html = '';
      snaps.forEach(function(s) {
        var pct = Math.round(((s.total || 0) / maxV) * 100);
        var time = s.captured_at ? new Date(s.captured_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">';
        html += '<div style="width:50px;text-align:right;font-size:10px;color:#94A3B8">' + time + '</div>';
        html += '<div style="flex:1;height:6px;background:var(--border,#1e293b);border-radius:3px;overflow:hidden">';
        html += '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#22c55e,#3b82f6);border-radius:3px"></div>';
        html += '</div>';
        html += '<div style="width:35px;font-size:10px;color:#cbd5e1;text-align:right">' + (s.total || 0) + '</div>';
        html += '</div>';
      });
      el.innerHTML = html;
    }

    function renderSessionStats(d) {
      var el = document.getElementById('a-session-stats');
      if (!d.total_sessions) {
        el.innerHTML = '<p style="color:#475569">No sessions in this period.</p>';
        return;
      }
      var html = '<div class="a-metric-grid">';
      html += aMetricBox(aFmtHours(d.total_stream_hours), 'Total Stream Hours');
      html += aMetricBox(d.avg_session_minutes !== null ? d.avg_session_minutes + 'm' : '\\u2014', 'Avg Session Length');
      html += aMetricBox(d.sessions_per_week !== null ? d.sessions_per_week.toFixed(1) : '\\u2014', 'Sessions / Week');
      html += aMetricBox(d.stream_ran_pct !== null ? d.stream_ran_pct.toFixed(0) + '%' : '\\u2014', 'Sessions With Stream');
      html += '</div>';

      if (d.weekly_sessions && d.weekly_sessions.length) {
        html += '<div style="margin-top:16px">';
        html += '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Sessions Per Week</div>';
        var maxW = Math.max.apply(null, d.weekly_sessions.map(function(w) { return w.count; }));
        if (maxW === 0) maxW = 1;
        d.weekly_sessions.forEach(function(w) {
          var pct = Math.round((w.count / maxW) * 100);
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label">' + escapeHtml(w.label) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + w.count + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      el.innerHTML = html;
    }

    function renderEquipmentPerf(d) {
      var el = document.getElementById('a-equipment-content');
      if (!d.equipment_disconnects || !d.equipment_disconnects.length) {
        el.innerHTML = '<p style="color:#475569">No equipment disconnect data available.</p>';
        return;
      }
      var maxC = d.equipment_disconnects[0].count;
      if (maxC === 0) maxC = 1;
      var html = '<div style="font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Disconnects by Device</div>';
      d.equipment_disconnects.forEach(function(eq) {
        var pct = Math.round((eq.count / maxC) * 100);
        var colorClass = eq.count >= 10 ? 'red' : eq.count >= 5 ? 'yellow' : '';
        html += '<div class="a-bar-row">';
        html += '<div class="a-bar-label" title="' + escapeHtml(eq.device) + '">' + escapeHtml(eq.device) + '</div>';
        html += '<div class="a-bar-track"><div class="a-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>';
        html += '<div class="a-bar-value">' + eq.count + '</div>';
        html += '</div>';
      });

      if (d.equipment_auto_resolve_rates && d.equipment_auto_resolve_rates.length) {
        html += '<div style="margin-top:16px;font-size:12px;color:#94A3B8;margin-bottom:8px;font-weight:600">Auto-Resolve Rate by Device</div>';
        d.equipment_auto_resolve_rates.forEach(function(eq) {
          var pct = Math.round(eq.rate);
          var colorClass = pct >= 80 ? '' : pct >= 50 ? 'yellow' : 'red';
          html += '<div class="a-bar-row">';
          html += '<div class="a-bar-label">' + escapeHtml(eq.device) + '</div>';
          html += '<div class="a-bar-track"><div class="a-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>';
          html += '<div class="a-bar-value">' + pct + '%</div>';
          html += '</div>';
        });
      }
      el.innerHTML = html;
    }

    function aMetricBox(val, label) {
      return '<div class="a-metric-item"><div class="a-metric-val">' + val + '</div><div class="a-metric-lbl">' + label + '</div></div>';
    }
    function aFmtHours(h) {
      if (h === null || h === undefined) return '\\u2014';
      return h < 1 ? Math.round(h * 60) + 'm' : h.toFixed(1) + 'h';
    }

    // Client-side mirror of shared escapeHtml in src/auth.js
    // (inline because this runs in the browser, not Node)
    function escapeHtml(v) {
      if (typeof v !== 'string') return '';
      return v.replace(/[<>&"']/g, function(c) {
        return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
      });
    }

    // ── Async modal dialogs (replaces confirm/prompt/alert) ─────────────
    function _showDialog(title, message, { input = false, defaultVal = '', cancelable = true, okLabel = 'OK', dangerOk = false } = {}) {
      return new Promise(resolve => {
        const backdrop = document.getElementById('modal-dialog');
        const bodyEl = document.getElementById('dialog-body');
        const inputWrap = document.getElementById('dialog-input-wrap');
        const inputEl = document.getElementById('dialog-input');
        const cancelBtn = document.getElementById('dialog-cancel');
        const okBtn = document.getElementById('dialog-ok');
        const closeX = document.getElementById('dialog-close-x');
        document.getElementById('dialog-title').textContent = title;
        bodyEl.textContent = message;
        inputWrap.style.display = input ? '' : 'none';
        inputEl.value = defaultVal;
        cancelBtn.style.display = cancelable ? '' : 'none';
        okBtn.textContent = okLabel;
        if (dangerOk) { okBtn.className = 'btn-danger'; } else { okBtn.className = 'btn-primary'; }

        function cleanup(val) {
          backdrop.classList.remove('open');
          okBtn.removeEventListener('click', onOk);
          cancelBtn.removeEventListener('click', onCancel);
          closeX.removeEventListener('click', onCancel);
          backdrop.removeEventListener('click', onBackdrop);
          resolve(val);
        }
        function onOk() { cleanup(input ? inputEl.value : true); }
        function onCancel() { cleanup(input ? null : false); }
        function onBackdrop(e) { if (e.target === backdrop) onCancel(); }

        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        closeX.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onBackdrop);
        backdrop.classList.add('open');
        if (input) { setTimeout(() => { inputEl.focus(); inputEl.select(); }, 100); }
        else { setTimeout(() => okBtn.focus(), 100); }
      });
    }

    function modalConfirm(message, { title = 'Confirm', okLabel = 'Confirm', dangerOk = false } = {}) {
      return _showDialog(title, message, { cancelable: true, okLabel, dangerOk });
    }
    function modalPrompt(message, defaultVal, { title = 'Input' } = {}) {
      return _showDialog(title, message, { input: true, defaultVal: defaultVal || '', cancelable: true });
    }
    function modalAlert(message, { title = 'Notice' } = {}) {
      return _showDialog(title, message, { cancelable: false, okLabel: 'OK' });
    }
    // ── Button loading state helper ───────────────────────────────────────
    function btnLoading(id, loadingText) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn._origText = btn.textContent;
      btn.disabled = true;
      btn.style.opacity = '0.7';
      btn.textContent = loadingText || 'Saving…';
    }
    function btnReset(id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      btn.disabled = false;
      btn.style.opacity = '';
      btn.textContent = btn._origText || 'Save';
    }

    function modalCopyValue(label, value) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(() => toast('Copied to clipboard'));
      } else {
        return _showDialog(label, value, { cancelable: false, okLabel: 'Close' });
      }
    }

    async function loadSupportStatus() {
      var wrap = document.getElementById('support-status-components');
      if (!wrap) return;
      wrap.innerHTML = '<div style="color:#475569">Loading status...</div>';
      try {
        var r = await fetch('/api/status/components', { signal: AbortSignal.timeout(10000) });
        var payload = await r.json();
        var items = payload.components || [];
        if (!items.length) {
          wrap.innerHTML = '<div style="color:#475569">No status data available.</div>';
          return;
        }
        wrap.innerHTML = items.map(function(c) {
          var latency = c.latency_ms == null ? '\\u2014' : (c.latency_ms + ' ms');
          return '<div style=\"display:flex;justify-content:space-between;gap:10px;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:8px 10px\">' +
            '<div><div style=\"color:#F8FAFC;font-size:13px;font-weight:600\">' + escapeHtml(c.name) + '</div><div style=\"color:#64748B;font-size:12px\">' + escapeHtml(c.detail || '') + '</div></div>' +
            '<div style=\"text-align:right;font-size:12px\">' + supportStateChip(c.state) + '<div style=\"color:#64748B;margin-top:3px\">' + latency + '</div></div>' +
          '</div>';
        }).join('');
      } catch (e) {
        wrap.innerHTML = '<div style="color:#ef4444">Unable to load status right now.</div>';
      }
    }

    async function runSupportTriage() {
      try {
        var issue = document.getElementById('support-issue').value;
        var severity = document.getElementById('support-severity').value;
        var summary = document.getElementById('support-summary').value.trim();
        var triage = await api('POST', '/api/church/support/triage', {
          issueCategory: issue,
          severity: severity,
          summary: summary,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        });
        supportTriage = triage;
        var checks = (triage.checks || []).map(function(c) {
          return (c.ok ? '\\u2705 ' : '\\u274C ') + c.note;
        }).join('<br>');
        document.getElementById('support-triage-result').innerHTML =
          '<div style=\"background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:10px\">' +
          '<div style=\"font-weight:700;color:#F8FAFC;margin-bottom:6px\">Triage result: ' + escapeHtml(triage.triageResult || 'monitoring') + '</div>' +
          '<div style=\"color:#94A3B8\">' + checks + '</div>' +
          '</div>';
        toast('Triage complete');
      } catch (e) {
        toast(e.message, true);
      }
    }

    async function createSupportTicket() {
      try {
        if (!supportTriage || !supportTriage.triageId) {
          await runSupportTriage();
        }
        if (!supportTriage || !supportTriage.triageId) {
          throw new Error('Run triage before opening a ticket');
        }
        var issue = document.getElementById('support-issue').value;
        var severity = document.getElementById('support-severity').value;
        var summary = document.getElementById('support-summary').value.trim();
        if (!summary) throw new Error('Please add a short summary before opening a ticket');

        await api('POST', '/api/church/support/tickets', {
          triageId: supportTriage.triageId,
          issueCategory: issue,
          severity: severity,
          title: summary.slice(0, 120),
          description: summary,
        });
        toast('Support ticket opened');
        document.getElementById('support-summary').value = '';
        await loadSupportTickets();
      } catch (e) {
        toast(e.message, true);
      }
    }

    function formatTicketStatus(status) {
      if (status === 'open') return 'Open';
      if (status === 'in_progress') return 'In Progress';
      if (status === 'waiting_customer') return 'Waiting on You';
      if (status === 'resolved') return 'Resolved';
      if (status === 'closed') return 'Closed';
      return status || 'Open';
    }

    async function addSupportUpdate(ticketId) {
      var note = await modalPrompt('Add an update to this ticket:', '', { title: 'Ticket Update' });
      if (!note) return;
      try {
        await api('POST', '/api/church/support/tickets/' + ticketId + '/updates', { message: note, status: 'waiting_customer' });
        toast('Update sent');
        await loadSupportTickets();
      } catch (e) {
        toast(e.message, true);
      }
    }

    async function loadSupportTickets() {
      var tbody = document.getElementById('support-tickets-tbody');
      if (!tbody) return;
      tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#475569;text-align:center;padding:20px\">Loading...</td></tr>';
      try {
        var tickets = await api('GET', '/api/church/support/tickets?limit=25');
        if (!tickets.length) {
          tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#475569;text-align:center;padding:20px\">No tickets yet.</td></tr>';
          return;
        }
        tbody.innerHTML = tickets.map(function(t) {
          return '<tr>' +
            '<td>' + new Date(t.created_at).toLocaleString() + '</td>' +
            '<td>' + escapeHtml(formatTicketStatus(t.status)) + '</td>' +
            '<td>' + escapeHtml(t.severity || 'P3') + '</td>' +
            '<td>' + escapeHtml(t.title || '') + '</td>' +
            '<td><button class=\"btn-secondary support-note-btn\" style=\"padding:6px 10px\" data-ticket-id=\"' + escapeHtml(t.id) + '\">Add note</button></td>' +
          '</tr>';
        }).join('');
        Array.from(tbody.querySelectorAll('.support-note-btn')).forEach(function(btn) {
          btn.addEventListener('click', function() {
            addSupportUpdate(btn.getAttribute('data-ticket-id'));
          });
        });
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan=\"5\" style=\"color:#ef4444;text-align:center;padding:20px\">' + escapeHtml(e.message) + '</td></tr>';
      }
    }

    // ── Logout ────────────────────────────────────────────────────────────────
    async function logout() {
      await fetch('/api/church/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/church-login';
    }

    // Auto-load overview + billing banner on start
    loadOverview();
    startOverviewPoll();
    loadBilling(); // populates billing banner on all pages
  </script>
</body>
</html>`;
}

// ─── Route setup ───────────────────────────────────────────────────────────────

function setupChurchPortal(app, db, churches, jwtSecret, requireAdmin, { billing, lifecycleEmails, preServiceCheck, sessionRecap, weeklyDigest, rundownEngine, scheduler, aiRateLimiter, guestTdMode, signalFailover } = {}) {
  const express = require('express');
  log.info('Setup started');

  // ── Rate limiting for login endpoint ───────────────────────────────────────
  const loginRateLimit = createRateLimit({
    scope: 'church_portal_login',
    maxAttempts: 10,
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
  ];
  for (const m of _portalMigrations) {
    try { db.exec(m); } catch { /* column already exists */ }
  }

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
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/church-portal');
  });

  // ── Logout ────────────────────────────────────────────────────────────────────
  app.post('/api/church/logout', (req, res) => {
    res.clearCookie('tally_church_session');
    res.json({ ok: true });
  });

  // ── Portal HTML ───────────────────────────────────────────────────────────────
  app.get('/church-portal', authMiddleware, (req, res) => {
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

  // ── PUT /api/church/me ────────────────────────────────────────────────────────
  app.put('/api/church/me', authMiddleware, (req, res) => {
    const { email, phone, location, notes, notifications, telegramChatId, engineerProfile, autoRecoveryEnabled, currentPassword, newPassword, leadershipEmails } = req.body;
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
    const allowedColumns = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications', 'engineer_profile', 'auto_recovery_enabled', 'audio_via_atem', 'leadership_emails'];
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
        lifecycleEmails.sendEmailChangeConfirmation(req.church, { oldEmail, newEmail: safePatch.portal_email }).catch(() => {});
      }
    }
    res.json({ ok: true });
  });

  // ── Campus management (multi-campus) ────────────────────────────────────────
  app.get('/api/church/campuses', authMiddleware, (req, res) => {
    try {
      const limits = campusLimitsForChurch(req.church);
      const rows = db.prepare(`
        SELECT churchId, name, location, token, registration_code, registeredAt
        FROM churches
        WHERE parent_church_id = ?
        ORDER BY name ASC
      `).all(req.church.churchId);

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
    const { name, role, email, phone } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active, role, email, phone) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .run(req.church.churchId, `portal_${id}`, `portal_${id}`, name, new Date().toISOString(), role || 'td', email || '', phone || '');
    res.json({ id, name, role, email, phone });
  });

  // ── DELETE /api/church/tds/:tdId ──────────────────────────────────────────────
  app.delete('/api/church/tds/:tdId', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM church_tds WHERE id = ? AND church_id = ?').run(req.params.tdId, req.church.churchId);
    res.json({ ok: true });
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
  app.delete('/api/church/guest-tokens/:tok', authMiddleware, (req, res) => {
    if (!guestTdMode) return res.status(503).json({ error: 'Guest tokens not configured' });
    const existing = db.prepare('SELECT churchId FROM guest_tokens WHERE token = ?').get(req.params.tok);
    if (!existing || existing.churchId !== req.church.churchId) return res.status(404).json({ error: 'Token not found' });
    guestTdMode.revokeToken(req.params.tok);
    res.json({ ok: true });
  });

  // ── GET /api/church/billing ───────────────────────────────────────────────────
  app.get('/api/church/billing', authMiddleware, async (req, res) => {
    try {
      const church = req.church;
      const tier = church.billing_tier || 'connect';
      const billingRow = db.prepare(
        'SELECT stripe_customer_id, billing_interval FROM billing_customers WHERE church_id = ? ORDER BY datetime(updated_at) DESC LIMIT 1'
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
        lifecycleEmails.sendUpgradeConfirmation(church, { oldTier: currentTier, newTier }).catch(() => {});
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
        lifecycleEmails.sendDowngradeConfirmation(church, { oldTier: currentTier, newTier }).catch(() => {});
      }

      res.json({ success: true, tier: newTier, message: 'Plan downgraded to ' + newTier + '. Change takes effect at end of current billing period.' });
    } catch (e) {
      log.error('Billing downgrade: ' + e.message);
      res.status(500).json({ error: safeErrorMessage(e, 'Downgrade failed') });
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

  app.post('/api/church/support/triage', supportAuthMiddleware, (req, res) => {
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

      res.status(201).json({
        triageId,
        triageResult,
        checks,
        diagnostics,
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
