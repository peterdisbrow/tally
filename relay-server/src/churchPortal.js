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
    <div class="footer">Tally by Atem School — <a href="https://tallyconnect.app" style="color:#22c55e;text-decoration:none">tallyconnect.app</a></div>
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
  <title>${name} — Tally Portal</title>
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
    @media (max-width: 640px) {
      .sidebar { display: none; }
      .main { margin-left: 0; padding: 20px; }
      .schedule-row {
        grid-template-columns: 1fr 1fr;
      }
    }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="sidebar-logo">
      <div class="sidebar-dot"></div>
      <div>
        <div class="sidebar-brand">Tally</div>
        <div class="sidebar-church" id="sidebar-church-name">${name}</div>
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
    <button class="nav-item" data-page="guests" onclick="showPage('guests', this)">
      <span class="icon">⊝</span> Guest Access
    </button>
    <button class="nav-item" data-page="sessions" onclick="showPage('sessions', this)">
      <span class="icon">⊟</span> Sessions
    </button>
    <button class="nav-item" data-page="alerts" onclick="showPage('alerts',this)">
      <span class="icon">⊡</span> Alerts
    </button>
    <button class="nav-item" data-page="billing" onclick="showPage('billing', this)">
      <span class="icon">⊠</span> Billing
    </button>
    <button class="nav-item" data-page="support" onclick="showPage('support',this)">
      <span class="icon">⊜</span> Help & Support
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
        <div class="page-title" id="overview-church-name">${name}</div>
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

      <!-- Upgrade Banner -->
      <div id="upgrade-banner"></div>

      <!-- Review Prompt Banner -->
      <div id="review-prompt-banner" style="display:none"></div>

      <!-- Referral Card -->
      <div id="referral-card" style="display:none"></div>

      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="stat-status">—</div>
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
      <div class="card">
        <div class="card-title"><span class="tip" data-tip="Real-time status of each AV device Tally monitors (ATEM, OBS, HyperDeck, etc.)">Equipment Status</span></div>
        <table>
          <thead><tr><th>System</th><th>Status</th><th>Last Seen</th></tr></thead>
          <tbody id="equipment-tbody">
            <tr><td colspan="3" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
      <!-- Campus Selector (multi-campus only) -->
      <div id="pf-campus-picker" style="display:none; margin-bottom:16px;">
        <label style="font-size:12px;color:#94A3B8;margin-right:8px;">Viewing:</label>
        <select id="pf-campus-select" onchange="loadProblems(this.value)" style="background:#0F1613;color:#F8FAFC;border:1px solid #1a2e1f;border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer;">
          <option value="">Main Campus</option>
        </select>
      </div>

      <!-- Problem Finder Card -->
      <div class="card" id="pf-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div class="card-title" style="margin:0"><span class="tip" data-tip="Automated diagnostics from Tally's Problem Finder — shows what was found, what was auto-fixed, and what still needs attention">Tally Diagnostics</span></div>
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
        <button class="btn-primary" onclick="saveProfile()">Save Changes</button>
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
        <table>
          <thead><tr><th>Campus</th><th>Status</th><th>Registration Code</th><th>Connection Token</th><th></th></tr></thead>
          <tbody id="campuses-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
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
        <table>
          <thead><tr><th>Name</th><th><span class="tip" data-tip="Primary TD gets escalations. On-call TD receives first alerts.">Role</span></th><th>Contact</th><th></th></tr></thead>
          <tbody id="tds-tbody">
            <tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
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
          <button class="btn-primary" onclick="saveSchedule()">Save Schedule</button>
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
        <div class="card-title">Telegram Integration</div>
        <div class="field">
          <label>Your Telegram Chat ID</label>
          <input type="text" id="telegram-chat-id" placeholder="1234567890">
        </div>
        <p style="font-size:12px;color:#94A3B8;margin-bottom:16px">Message <a href="https://t.me/userinfobot" target="_blank" style="color:#22c55e">@userinfobot</a> on Telegram to get your chat ID.</p>
        <button class="btn-primary" onclick="saveNotifications()">Save Preferences</button>
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
        <table>
          <thead><tr><th><span class="tip" data-tip="Share this code with the guest — they enter it in the Tally app or Telegram bot">Token</span></th><th>Label</th><th>Created</th><th><span class="tip" data-tip="Token stops working after this date. Revoke early if needed.">Expires</span></th><th></th></tr></thead>
          <tbody id="guests-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
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
        <table>
          <thead><tr><th>Date</th><th>Duration</th><th>Peak Viewers</th><th>Status</th></tr></thead>
          <tbody id="sessions-tbody">
            <tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
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
          Direct support: <a href="mailto:support@atemschool.com" style="color:#22c55e">support@atemschool.com</a>
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
            <option value="P2">P2 - High (service impact)</option>
            <option value="P3">P3 - Medium</option>
            <option value="P4">P4 - Low / question</option>
            <option value="P1">P1 - Critical outage</option>
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
        <table>
          <thead><tr><th>Created</th><th>Status</th><th>Severity</th><th>Title</th><th>Action</th></tr></thead>
          <tbody id="support-tickets-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
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
        <div style="display:flex;flex-direction:column;gap:10px">
          <a href="https://g.page/r/YOUR_GOOGLE_REVIEW_LINK" target="_blank" rel="noopener" style="display:block;padding:10px 16px;border-radius:8px;border:1px solid #1a2e1f;color:#F8FAFC;text-decoration:none;font-size:13px;font-weight:600;background:#0F1613;text-align:center;transition:border-color .2s">&#11088; Post on Google</a>
          <a href="https://www.capterra.com/reviews/new/YOUR_CAPTERRA_ID" target="_blank" rel="noopener" style="display:block;padding:10px 16px;border-radius:8px;border:1px solid #1a2e1f;color:#F8FAFC;text-decoration:none;font-size:13px;font-weight:600;background:#0F1613;text-align:center;transition:border-color .2s">&#128221; Post on Capterra</a>
          <a href="https://www.g2.com/products/tally-connect/reviews" target="_blank" rel="noopener" style="display:block;padding:10px 16px;border-radius:8px;border:1px solid #1a2e1f;color:#F8FAFC;text-decoration:none;font-size:13px;font-weight:600;background:#0F1613;text-align:center;transition:border-color .2s">&#128172; Post on G2</a>
        </div>
        <button onclick="closeReviewModal()" style="background:none;border:none;color:#475569;font-size:12px;cursor:pointer;margin-top:16px;padding:8px">Maybe later</button>
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

    // ── navigation ──────────────────────────────────────────────────────────────
    function showPage(id, el) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + id).classList.add('active');
      el.classList.add('active');
      if (id === 'overview') loadOverview();
      if (id === 'campuses') loadCampuses();
      if (id === 'tds') loadTds();
      if (id === 'schedule') loadSchedule();
      if (id === 'guests') loadGuests();
      if (id === 'sessions') loadSessions();
      if (id === 'alerts') loadAlerts();
      if (id === 'billing') loadBilling();
      if (id === 'notifications') loadNotifications();
      if (id === 'support') loadSupportInfo();
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
      const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', signal: AbortSignal.timeout(15000) };
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
        const encoderConnected = status.encoder === true || !!enc.connected;
        const encoderLive = !!enc.live || obsStreaming;
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
        const audioStatus = (status.mixer && status.mixer.mainMuted) ? 'muted'
          : (status.audio && status.audio.silenceDetected) ? 'warning'
          : (encoderLive || obsStreaming) ? 'ok'
          : 'unknown';
        const rows = [
          ['ATEM Switcher', atemConnected ? 'connected' : 'unknown', status.atemLastSeen],
          [encoderLabel, encoderStatus, null],
          ['Stream', (encoderLive || obsStreaming) ? 'live' : 'offline', null],
          ['Audio', audioStatus, null],
          ['A/V Sync', status.syncOk === false ? 'warning' : (status.syncOk ? 'ok' : 'unknown'), null],
        ];
        tbody.innerHTML = rows.map(([name, st, ts]) => {
          let badgeCls = 'badge-gray';
          let label = st;
          if (st === 'connected' || st === 'ok') badgeCls = 'badge-green';
          else if (st === 'live' || st === 'streaming') { badgeCls = 'badge-green'; label = st === 'live' ? '🔴 Live' : 'Streaming'; }
          else if (st === 'warning') badgeCls = 'badge-yellow';
          else if (st === 'muted') { badgeCls = 'badge-yellow'; label = '🔇 Muted'; }
          return \`<tr>
            <td>\${name}</td>
            <td><span class="badge \${badgeCls}">\${label}</span></td>
            <td style="color:#475569;font-size:12px">\${ts ? new Date(ts).toLocaleTimeString() : '—'}</td>
          </tr>\`;
        }).join('');

        document.getElementById('stat-status').textContent = d.connected ? 'Online' : 'Offline';
        document.getElementById('stat-status').style.color = d.connected ? '#22c55e' : '#94A3B8';

        // ── Onboarding checklist ──────────────────────────────────────────────
        renderOnboarding(d);

        // ── Review prompt (after onboarding, after upgrade banner) ───────────
        checkReviewEligibility();
        loadReferralCard();

        // ── Schedule summary on overview ──────────────────────────────────────
        loadScheduleOverview();

        // ── Problem Finder diagnostics ──────────────────────────────────────
        populatePfCampusPicker();
        loadProblems('');
      } catch(e) { console.error(e); }
    }

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

    // ── Problem Finder: campus picker + card rendering ──────────────────────

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
      if (!container || !itemsEl) return;

      // Hide if dismissed or all milestones complete
      if (d.onboarding_dismissed) { container.style.display = 'none'; return; }

      const steps = [
        { done: true, label: 'Account created', detail: 'Your Tally account is set up' },
        { done: !!d.onboarding_app_connected_at, label: 'Desktop app connected', detail: 'Download and run the Tally app on your booth computer' },
        { done: !!d.onboarding_atem_connected_at, label: 'ATEM connected', detail: 'The app will auto-discover your ATEM switcher on the network' },
        { done: !!d.onboarding_telegram_registered_at, label: 'Telegram bot registered', detail: 'Have a TD send /register ' + (d.registration_code || 'CODE') + ' to @tallybot' },
      ];

      const completed = steps.filter(s => s.done).length;
      if (completed >= steps.length) { container.style.display = 'none'; return; }

      container.style.display = 'block';
      document.getElementById('onboarding-progress-text').textContent = completed + ' of ' + steps.length + ' steps complete';

      itemsEl.innerHTML = steps.map((s, i) => {
        const icon = s.done
          ? '<div style="width:24px;height:24px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#000;font-size:13px;font-weight:700;flex-shrink:0;">✓</div>'
          : '<div style="width:24px;height:24px;border-radius:50%;border:2px solid #334155;display:flex;align-items:center;justify-content:center;color:#64748B;font-size:12px;font-weight:700;flex-shrink:0;">' + (i + 1) + '</div>';
        return '<div style="display:flex;align-items:flex-start;gap:12px;padding:10px 0;' + (i < steps.length - 1 ? 'border-bottom:1px solid #1a2e1f;' : '') + '">'
          + icon
          + '<div>'
          + '<div style="font-size:13px;font-weight:600;color:' + (s.done ? '#22c55e' : '#F8FAFC') + ';">' + s.label + '</div>'
          + (s.done ? '' : '<div style="font-size:12px;color:#64748B;margin-top:2px;">' + s.detail + '</div>')
          + '</div>'
          + '</div>';
      }).join('');
    }

    async function dismissOnboarding() {
      try {
        await api('POST', '/api/church/onboarding/dismiss');
        document.getElementById('onboarding-checklist').style.display = 'none';
      } catch(e) { console.error('Dismiss failed:', e); }
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
      } catch(e) { toast('Failed to load profile', true); }
    }
    loadProfile();

    async function saveProfile() {
      try {
        await api('PUT', '/api/church/me', {
          email: document.getElementById('profile-email').value,
          phone: document.getElementById('profile-phone').value,
          location: document.getElementById('profile-location').value,
          notes: document.getElementById('profile-notes').value,
        });
        toast('Profile saved');
      } catch(e) { toast(e.message, true); }
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

    // ── Campuses ───────────────────────────────────────────────────────────────
    function getCampusById(churchId) {
      return campusData.find(function(c) { return c.churchId === churchId; }) || null;
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
      prompt('Copy value:', value);
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
            noteEl.innerHTML = '<strong>Campus Limits:</strong> Plan ' + tierLabel + ': up to ' + limits.maxTotal + ' total campus/room setup' + (limits.maxTotal === 1 ? '' : 's') + '. You are using ' + limits.usedTotal + '.';
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

        tbody.innerHTML = campusData.map(function(c) {
          const status = c.connected ? 'Online' : 'Offline';
          const statusClass = c.connected ? 'badge-green' : 'badge-gray';
          const code = c.registrationCode || '—';
          const tokenPreview = c.token ? (c.token.slice(0, 16) + '…') : '—';
          const location = c.location ? ('<div style="color:#64748B;font-size:12px">' + c.location + '</div>') : '';
          return '<tr>' +
            '<td>' + c.name + location + '</td>' +
            '<td><span class="badge ' + statusClass + '">' + status + '</span></td>' +
            '<td><code style="font-size:12px;color:#22c55e">' + code + '</code><div><button class="btn-sm campus-copy-code-btn" data-campus-id="' + c.churchId + '">Copy</button></div></td>' +
            '<td><code style="font-size:12px;color:#94A3B8">' + tokenPreview + '</code><div><button class="btn-sm campus-copy-token-btn" data-campus-id="' + c.churchId + '">Copy</button></div></td>' +
            '<td><button class="btn-danger campus-remove-btn" data-campus-id="' + c.churchId + '">Remove</button></td>' +
          '</tr>';
        }).join('');
        Array.from(tbody.querySelectorAll('.campus-copy-code-btn')).forEach(function(btn) {
          btn.addEventListener('click', function() {
            copyCampusCode(btn.getAttribute('data-campus-id'));
          });
        });
        Array.from(tbody.querySelectorAll('.campus-copy-token-btn')).forEach(function(btn) {
          btn.addEventListener('click', function() {
            copyCampusToken(btn.getAttribute('data-campus-id'));
          });
        });
        Array.from(tbody.querySelectorAll('.campus-remove-btn')).forEach(function(btn) {
          btn.addEventListener('click', function() {
            removeCampus(btn.getAttribute('data-campus-id'));
          });
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
          prompt('Campus created. Save this registration code:', created.registrationCode);
        }
      } catch (e) {
        toast(e.message || 'Failed to create campus', true);
      }
    }

    async function removeCampus(churchId) {
      const campus = getCampusById(churchId);
      const label = campus ? campus.name : 'this campus';
      if (!confirm('Remove ' + label + '? This will disconnect it and delete its campus record.')) return;
      try {
        await api('DELETE', '/api/church/campuses/' + churchId);
        toast('Campus removed');
        loadCampuses();
      } catch (e) {
        toast(e.message || 'Failed to remove campus', true);
      }
    }

    // ── TDs ──────────────────────────────────────────────────────────────────
    async function loadTds() {
      try {
        const tds = await api('GET', '/api/church/tds');
        const tbody = document.getElementById('tds-tbody');
        if (!tds.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="color:#475569;text-align:center;padding:20px">No tech directors yet.</td></tr>';
          return;
        }
        tbody.innerHTML = tds.map(td => \`
          <tr>
            <td>\${td.name}</td>
            <td><span class="badge badge-gray">\${td.role || 'td'}</span></td>
            <td style="color:#94A3B8">\${td.email || '—'}</td>
            <td><button class="btn-danger" onclick="removeTd('\${td.id}')">Remove</button></td>
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
      if (!confirm('Remove this tech director?')) return;
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
      // Snap minutes to nearest 15
      var snapped = Math.round(m / 15) * 15;
      if (snapped === 60) { snapped = 0; h24++; h12 = h24 === 0 ? 12 : (h24 > 12 ? h24 - 12 : h24); ampm = h24 < 12 ? 'AM' : 'PM'; }

      var hourOpts = '';
      for (var i = 1; i <= 12; i++) {
        hourOpts += '<option value="' + i + '"' + (i === h12 ? ' selected' : '') + '>' + i + '</option>';
      }
      var minOpts = '';
      [0, 15, 30, 45].forEach(function(v) {
        minOpts += '<option value="' + v + '"' + (v === snapped ? ' selected' : '') + '>' + pad2(v) + '</option>';
      });
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
        if (startMin === null || endMin === null || endMin <= startMin) {
          throw new Error('End time must be after start time');
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
          return '<option value="' + c.churchId + '">' + c.name + '</option>';
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
      try {
        const schedule = collectScheduleFromRows();
        var campusId = getSelectedScheduleCampusId();
        var url = '/api/church/schedule' + (campusId ? '?campusId=' + encodeURIComponent(campusId) : '');
        await api('PUT', url, schedule);
        toast('Schedule saved');
      } catch(e) { toast(e.message || 'Unable to save schedule', true); }
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
        document.getElementById('telegram-chat-id').value = d.telegramChatId || '';
      } catch(e) { toast('Failed to load notifications', true); }
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
        });
        toast('Notification preferences saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Guest Tokens ──────────────────────────────────────────────────────────
    async function loadGuests() {
      try {
        const tokens = await api('GET', '/api/church/guest-tokens');
        const tbody = document.getElementById('guests-tbody');
        if (!tokens.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">No guest tokens.</td></tr>';
          return;
        }
        tbody.innerHTML = tokens.map(t => \`
          <tr>
            <td><code style="font-size:11px;color:#22c55e">\${t.token.slice(0,16)}…</code></td>
            <td style="color:#94A3B8">\${t.label || '—'}</td>
            <td style="color:#94A3B8;font-size:12px">\${new Date(t.createdAt).toLocaleDateString()}</td>
            <td style="color:#94A3B8;font-size:12px">\${t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'No expiry'}</td>
            <td><button class="btn-danger" onclick="revokeToken('\${t.token}')">Revoke</button></td>
          </tr>\`).join('');
      } catch(e) { toast('Failed to load tokens', true); }
    }

    async function generateGuestToken() {
      const label = prompt('Label for this token (e.g. "Visiting TD — March 9")');
      if (label === null) return;
      try {
        const t = await api('POST', '/api/church/guest-tokens', { label });
        toast('Token created');
        loadGuests();
        prompt('Copy this token (shown once):', t.token);
      } catch(e) { toast(e.message, true); }
    }

    async function revokeToken(token) {
      if (!confirm('Revoke this guest token?')) return;
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
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px">';
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

        // Upgrade cards for locked features
        var currentTier = (b.tier || 'connect').toLowerCase();

        if (currentTier === 'connect') {
          // Plus upgrade card
          html += '<div style="margin-bottom:16px;background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.2);border-radius:12px;padding:20px 24px">';
          html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">';
          html += '<span style="background:rgba(34,197,94,0.12);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:800;letter-spacing:0.08em;font-family:ui-monospace,monospace">PLUS</span>';
          html += '<span style="color:#F8FAFC;font-size:14px;font-weight:700">Unlock with Plus</span>';
          html += '</div>';
          html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;margin-bottom:16px">';
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
          html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;margin-bottom:16px">';
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
          html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;margin-bottom:16px">';
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
        html += '<p style="color:#475569;font-size:12px;line-height:1.6">Cancel anytime from the Stripe portal. Service continues through the end of your billing period. No partial-month refunds. Questions? <a href="mailto:support@atemschool.com" style="color:#22c55e">support@atemschool.com</a></p>';
        html += '</div>';

        document.getElementById('billing-content').innerHTML = html;
        updateBillingBanner(b);
        renderUpgradeBanner(b);
      } catch(e) {
        document.getElementById('billing-content').innerHTML = '<div style="color:#475569;text-align:center;padding:30px">Billing info unavailable. <a href="mailto:support@atemschool.com" style="color:#22c55e">Contact support</a></div>';
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

      if (!confirm('Upgrade to ' + label + '? Your subscription will be updated immediately with prorated billing.')) return;

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
      if (!confirm('Reactivate your subscription? You\\'ll be redirected to Stripe to complete payment.')) return;
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
      if (!confirm('Downgrade to ' + label + '? The change will take effect at the end of your current billing period.')) return;
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
        var resp = await fetch('/api/church/data-export', { credentials: 'include', signal: AbortSignal.timeout(15000) });
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
      var churchName = prompt('This will permanently delete your account and all data.\\n\\nTo confirm, type your church name:');
      if (!churchName) return;
      try {
        var data = await api('DELETE', '/api/church/account', { confirmName: churchName });
        if (data.deleted) {
          alert('Your account has been deleted. You will be redirected to the homepage.');
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
          '<div style="flex:1;min-width:200px;background:#09090B;border:1px solid #1a2e1f;border-radius:8px;padding:8px 12px;font-family:ui-monospace,monospace;font-size:13px;color:#F8FAFC;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" id="referral-link">' + data.shareUrl + '</div>' +
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
          var acked = a.acknowledged_at ? '<span style="color:#22c55e;font-size:11px">\\u2713 Acknowledged' + (a.acknowledged_by ? ' by ' + a.acknowledged_by : '') + '</span>' : '<span style="color:#475569;font-size:11px">Not acknowledged</span>';
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
            if (diag.likely_cause) html += '<div style="color:#94A3B8;margin-bottom:4px"><strong style="color:#F8FAFC">Likely cause:</strong> ' + diag.likely_cause + '</div>';
            if (diag.steps && diag.steps.length) {
              html += '<div style="color:#94A3B8"><strong style="color:#F8FAFC">Steps:</strong></div><ol style="margin:4px 0 0;padding-left:20px;color:#94A3B8">';
              diag.steps.forEach(function(s) { html += '<li>' + s + '</li>'; });
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

    // Client-side mirror of shared escapeHtml in src/auth.js
    // (inline because this runs in the browser, not Node)
    function escapeHtml(v) {
      if (typeof v !== 'string') return '';
      return v.replace(/[<>&"']/g, function(c) {
        return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c];
      });
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
      var note = prompt('Add an update to this ticket:');
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
    loadBilling(); // populates billing banner on all pages
  </script>
</body>
</html>`;
}

// ─── Route setup ───────────────────────────────────────────────────────────────

function setupChurchPortal(app, db, churches, jwtSecret, requireAdmin, { billing, lifecycleEmails } = {}) {
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
      connect: 1, // single room/campus total
      plus: 3,
      pro: 10,
      managed: 50,
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

  // ── PUT /api/church/me ────────────────────────────────────────────────────────
  app.put('/api/church/me', authMiddleware, (req, res) => {
    const { email, phone, location, notes, notifications, telegramChatId, currentPassword, newPassword } = req.body;
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

    const allowedColumns = ['portal_email', 'phone', 'location', 'notes', 'telegram_chat_id', 'notifications'];
    const patch = {};
    if (email          !== undefined) patch.portal_email     = email.trim().toLowerCase();
    if (phone          !== undefined) patch.phone            = phone;
    if (location       !== undefined) patch.location         = location;
    if (notes          !== undefined) patch.notes            = notes;
    if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
    if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);

    const safePatch = Object.fromEntries(Object.entries(patch).filter(([k]) => allowedColumns.includes(k)));
    if (Object.keys(safePatch).length) {
      const sets = Object.keys(safePatch).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE churches SET ${sets} WHERE churchId = ?`).run(...Object.values(safePatch), churchId);
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
        return {
          churchId: row.churchId,
          name: row.name,
          location: row.location || '',
          token: row.token || '',
          registrationCode: row.registration_code || '',
          registeredAt: row.registeredAt || null,
          connected,
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
      res.status(500).json({ error: e.message });
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
          error: `Your ${String(limits.tier).toUpperCase()} plan allows ${limits.maxTotal} total campus/room setup${limits.maxTotal === 1 ? '' : 's'}.`,
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/church/problems ─────────────────────────────────────────────────
  // Returns latest Problem Finder report. Accepts optional ?campusId=xxx.
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
      res.status(500).json({ error: e.message });
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
    } catch(e) { res.status(500).json({ error: e.message }); }
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
  app.get('/api/church/guest-tokens', authMiddleware, (req, res) => {
    res.json(db.prepare('SELECT * FROM guest_tokens WHERE churchId = ? ORDER BY createdAt DESC').all(req.church.churchId));
  });

  // ── POST /api/church/guest-tokens ─────────────────────────────────────────────
  app.post('/api/church/guest-tokens', authMiddleware, (req, res) => {
    const { label, expiresInDays } = req.body;
    const { v4: uuidv4 } = require('uuid');
    const token = 'gtd_' + require('crypto').randomBytes(20).toString('hex');
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
      : null;
    db.prepare('INSERT INTO guest_tokens (token, churchId, label, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)')
      .run(token, req.church.churchId, label || null, new Date().toISOString(), expiresAt);
    res.json({ token, label, expiresAt });
  });

  // ── DELETE /api/church/guest-tokens/:token ────────────────────────────────────
  app.delete('/api/church/guest-tokens/:tok', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM guest_tokens WHERE token = ? AND churchId = ?').run(req.params.tok, req.church.churchId);
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

      res.json({
        tier,
        tierName: TIER_NAMES[tier] || tier,
        billingInterval,
        billingIntervalLabel: INTERVAL_NAMES[billingInterval] || billingInterval,
        status,
        trialEndsAt: trialEnds,
        trialDaysRemaining,
        portalUrl,
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
  app.post('/api/church/billing/upgrade', authMiddleware, async (req, res) => {
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
      res.status(500).json({ error: 'Upgrade failed: ' + e.message });
    }
  });

  // ── POST /api/church/billing/reactivate ─────────────────────────────────────
  // Reactivation path for cancelled/expired/inactive churches.
  app.post('/api/church/billing/reactivate', authMiddleware, async (req, res) => {
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
      res.status(400).json({ error: e.message });
    }
  });

  // ── POST /api/church/billing/downgrade ─────────────────────────────────────
  // Downgrade to a lower tier (same billing interval).
  app.post('/api/church/billing/downgrade', authMiddleware, async (req, res) => {
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

      const now = new Date().toISOString();
      db.prepare('UPDATE churches SET billing_tier = ? WHERE churchId = ?').run(newTier, church.churchId);
      db.prepare('UPDATE billing_customers SET tier = ?, updated_at = ? WHERE church_id = ?').run(newTier, now, church.churchId);

      log.info('Downgraded church ' + church.churchId + ' from ' + currentTier + ' to ' + newTier);
      res.json({ success: true, tier: newTier, message: 'Plan downgraded to ' + newTier + '. Change takes effect at end of current billing period.' });
    } catch (e) {
      log.error('Billing downgrade: ' + e.message);
      res.status(500).json({ error: 'Downgrade failed: ' + e.message });
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
        const sched = db.prepare('SELECT schedule_json FROM church_schedules WHERE church_id = ?').get(churchId);
        if (sched) exportData.schedule = JSON.parse(sched.schedule_json);
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
      res.status(500).json({ error: 'Export failed: ' + e.message });
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
        { table: 'guest_tokens', column: 'church_id' },
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
      res.status(500).json({ error: 'Deletion failed: ' + e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
    try {
      const result = db.prepare('DELETE FROM church_reviews WHERE id = ?').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Review not found' });
      log.info('Deleted review ' + req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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
      res.status(500).json({ error: e.message });
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

module.exports = { setupChurchPortal, _buildChurchPortalHtml: buildChurchPortalHtml };
