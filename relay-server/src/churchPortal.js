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

// ─── password helpers ──────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ─── JWT helpers ───────────────────────────────────────────────────────────────

function issueChurchToken(churchId, jwtSecret) {
  return jwt.sign({ type: 'church_portal', churchId }, jwtSecret, { expiresIn: '7d' });
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
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/api/church/login">
      <label>Email address</label>
      <input type="email" name="email" placeholder="td@yourchurch.org" required autocomplete="email">
      <label>Password</label>
      <input type="password" name="password" placeholder="••••••••" required autocomplete="current-password">
      <button type="submit" class="btn">Sign in</button>
    </form>
    <div class="footer">Tally by Atem School — <a href="https://tally.atemschool.com" style="color:#22c55e;text-decoration:none">tally.atemschool.com</a></div>
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
    @media (max-width: 640px) {
      .sidebar { display: none; }
      .main { margin-left: 0; padding: 20px; }
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
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="stat-status">—</div>
          <div class="stat-label">Connection</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-sessions">—</div>
          <div class="stat-label">Sessions (30d)</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-tds">—</div>
          <div class="stat-label">Tech Directors</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Equipment Status</div>
        <table>
          <thead><tr><th>System</th><th>Status</th><th>Last Seen</th></tr></thead>
          <tbody id="equipment-tbody">
            <tr><td colspan="3" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="card-title">Quick Info</div>
        <table>
          <tbody>
            <tr><td style="color:#94A3B8;width:160px">Church ID</td><td><code style="font-size:12px;color:#475569">${church.churchId}</code></td></tr>
            <tr><td style="color:#94A3B8">Registered</td><td id="registered-date" style="color:#F8FAFC">—</td></tr>
            <tr><td style="color:#94A3B8">Plan</td><td id="plan-name" style="color:#F8FAFC">—</td></tr>
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
            <label>Church Name</label>
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
          <label>Notes for Support Team</label>
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
          <thead><tr><th>Name</th><th>Role</th><th>Contact</th><th></th></tr></thead>
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
      <div class="card">
        <div class="card-title">Schedule Configuration (JSON)</div>
        <p style="font-size:12px;color:#94A3B8;margin-bottom:14px">Format: <code style="color:#22c55e">{ "sunday": [{"start":"09:00","end":"11:30","label":"Morning Service"}] }</code></p>
        <div class="field">
          <textarea id="schedule-json" style="min-height:200px;font-size:12px" placeholder='{"sunday":[{"start":"09:00","end":"11:30","label":"Morning Service"}]}'></textarea>
        </div>
        <button class="btn-primary" onclick="saveSchedule()">Save Schedule</button>
        <button class="btn-secondary" style="margin-left:10px" onclick="formatScheduleJson()">Format JSON</button>
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
      <div class="card">
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
          <button class="btn-primary" onclick="generateGuestToken()">+ Generate Token</button>
        </div>
        <table>
          <thead><tr><th>Token</th><th>Label</th><th>Created</th><th>Expires</th><th></th></tr></thead>
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
      <div id="billing-content">
        <div style="color:#475569;text-align:center;padding:30px">Loading billing info...</div>
      </div>
    </div>

    <!-- HELP & SUPPORT -->
    <div class="page" id="page-support">
      <div class="page-header">
        <div class="page-title">Help & Support</div>
        <div class="page-sub">Get help, view docs, and contact support</div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Contact Support</div>
        <p style="color:#94A3B8;font-size:14px;line-height:1.6;margin:8px 0">
          Email us at <a href="mailto:support@atemschool.com" style="color:#22c55e">support@atemschool.com</a>
        </p>
        <p id="support-response-time" style="color:#475569;font-size:13px;margin-top:8px"></p>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">Help Center</div>
        <p style="color:#94A3B8;font-size:14px;line-height:1.6;margin:8px 0">
          Visit our <a href="https://tally.atemschool.com/help" target="_blank" style="color:#22c55e">Help & FAQ page</a> for getting started guides, troubleshooting, feature explainers, and answers to common questions.
        </p>
      </div>
      <div class="card">
        <div class="card-title">Links</div>
        <ul style="color:#94A3B8;font-size:14px;line-height:1.9;padding-left:20px;margin:8px 0">
          <li><a href="https://tally.atemschool.com/help" target="_blank" style="color:#22c55e">Getting Started Guide</a></li>
          <li><a href="https://tally.atemschool.com/terms" target="_blank" style="color:#22c55e">Terms of Service</a></li>
          <li><a href="https://tally.atemschool.com/privacy" target="_blank" style="color:#22c55e">Privacy Policy</a></li>
        </ul>
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

  <div id="toast"></div>

  <script>
    const CHURCH_ID = '${church.churchId}';
    let profileData = {};
    let notifData = {};

    // ── navigation ──────────────────────────────────────────────────────────────
    function showPage(id, el) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + id).classList.add('active');
      el.classList.add('active');
      if (id === 'overview') loadOverview();
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
      const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
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
        const tierNames = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Managed', event: 'Event' };
        document.getElementById('plan-name').textContent = tierNames[d.billing_tier] || d.billing_tier || 'Connect';

        const tbody = document.getElementById('equipment-tbody');
        const status = d.status || {};
        const enc = status.encoder || {};
        const encNames = { obs:'OBS', vmix:'vMix', ecamm:'Ecamm', blackmagic:'Blackmagic', aja:'AJA HELO', epiphan:'Epiphan', teradek:'Teradek', yolobox:'YoloBox', 'tally-encoder':'Tally Encoder', custom:'Custom' };
        const encoderLabel = encNames[enc.type] || (status.obs ? 'OBS Studio' : 'Encoder');
        const encoderStatus = enc.connected ? (enc.live ? 'streaming' : 'connected') : (status.obs && status.obs.connected ? (status.obs.streaming ? 'streaming' : 'connected') : 'unknown');
        const audioStatus = (status.mixer && status.mixer.mainMuted) ? 'muted' : (status.audio && status.audio.silenceDetected) ? 'warning' : (enc.live || (status.obs && status.obs.streaming)) ? 'ok' : 'unknown';
        const rows = [
          ['ATEM Switcher', status.atem ? 'connected' : 'unknown', status.atemLastSeen],
          [encoderLabel, encoderStatus, null],
          ['Stream', (enc.live || (status.obs && status.obs.streaming)) ? 'live' : 'offline', null],
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
      } catch(e) { console.error(e); }
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
    async function loadSchedule() {
      try {
        const d = await api('GET', '/api/church/schedule');
        document.getElementById('schedule-json').value = JSON.stringify(d, null, 2);
      } catch(e) { toast('Failed to load schedule', true); }
    }

    async function saveSchedule() {
      try {
        const raw = document.getElementById('schedule-json').value;
        const parsed = JSON.parse(raw);
        await api('PUT', '/api/church/schedule', parsed);
        toast('Schedule saved');
      } catch(e) { toast(e.message.includes('JSON') ? 'Invalid JSON' : e.message, true); }
    }

    function formatScheduleJson() {
      try {
        const raw = document.getElementById('schedule-json').value;
        document.getElementById('schedule-json').value = JSON.stringify(JSON.parse(raw), null, 2);
      } catch { toast('Invalid JSON', true); }
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
        const statusColor = statusColors[b.status] || '#94A3B8';
        const statusLabel = statusLabels[b.status] || b.status;

        let html = '<div class="card" style="margin-bottom:16px">';
        html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">';
        html += '<span style="font-size:20px;font-weight:800;color:#F8FAFC">' + tierName + '</span>';
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
        const featureList = [
          ['ATEM, OBS, vMix monitoring', true],
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
        featureList.forEach(function(f) {
          html += '<div style="color:' + (f[1] ? '#94A3B8' : '#475569') + '">' + (f[1] ? '\\u2713 ' : '\\u2717 ') + f[0] + '</div>';
        });
        html += '</div></div>';

        if (b.portalUrl) {
          html += '<a href="' + b.portalUrl + '" target="_blank" class="btn-primary" style="display:inline-block;text-decoration:none;margin-bottom:12px">Manage Subscription \\u2192</a>';
          html += '<p style="color:#475569;font-size:12px">Update payment method, view invoices, or cancel your subscription via Stripe\\u2019s secure portal.</p>';
        } else if (['trialing','trial_expired','canceled','inactive'].includes(b.status)) {
          html += '<a href="https://tally.atemschool.com/signup" target="_blank" class="btn-primary" style="display:inline-block;text-decoration:none;margin-bottom:12px">Subscribe Now \\u2192</a>';
        }

        html += '<div style="margin-top:20px;padding-top:16px;border-top:1px solid #1a2e1f">';
        html += '<p style="color:#475569;font-size:12px;line-height:1.6">Cancel anytime from the Stripe portal. Service continues through the end of your billing period. No partial-month refunds. Questions? <a href="mailto:support@atemschool.com" style="color:#22c55e">support@atemschool.com</a></p>';
        html += '</div>';

        document.getElementById('billing-content').innerHTML = html;
        updateBillingBanner(b);
      } catch(e) {
        document.getElementById('billing-content').innerHTML = '<div style="color:#475569;text-align:center;padding:30px">Billing info unavailable. <a href="mailto:support@atemschool.com" style="color:#22c55e">Contact support</a></div>';
      }
    }

    function updateBillingBanner(b) {
      var el = document.getElementById('billing-banner');
      if (!el) return;
      if (b.status === 'trialing' && b.trialDaysRemaining != null && b.trialDaysRemaining <= 7) {
        el.innerHTML = '<div style="background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#eab308">Your trial ends in ' + b.trialDaysRemaining + ' day' + (b.trialDaysRemaining !== 1 ? 's' : '') + '. <a href="https://tally.atemschool.com/signup" style="color:#22c55e;font-weight:700">Subscribe now</a> to keep your service running.</div>';
      } else if (b.status === 'past_due') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">Payment failed. <a href="' + (b.portalUrl || 'https://tally.atemschool.com/signup') + '" style="color:#22c55e;font-weight:700">Update your card</a> to avoid service interruption.</div>';
      } else if (b.status === 'canceled' || b.status === 'trial_expired') {
        el.innerHTML = '<div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#ef4444">Your subscription has ended. <a href="https://tally.atemschool.com/signup" style="color:#22c55e;font-weight:700">Resubscribe</a> to continue monitoring your services.</div>';
      } else {
        el.innerHTML = '';
      }
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
        document.getElementById('alerts-content').innerHTML = '<p style="color:#ef4444">' + e.message + '</p>';
      }
    }

    // ── Support info ──────────────────────────────────────────────────────────
    function loadSupportInfo() {
      var tier = billingData ? billingData.tier : (profileData.billing_tier || 'connect');
      var times = { connect: '48 hours', plus: '24 hours', pro: '12 hours', managed: '15 minutes (Mon\\u2013Fri 9\\u20135 ET + service windows)' };
      var el = document.getElementById('support-response-time');
      if (el) el.textContent = 'Response time for your plan: ' + (times[tier] || '48 hours');
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

function setupChurchPortal(app, db, churches, jwtSecret, requireAdmin) {
  const express = require('express');
  console.log('[ChurchPortal] Setup started');

  // ── Rate limiting for login endpoint ───────────────────────────────────────
  const loginAttempts = new Map();
  function loginRateLimit(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000; // 15 minutes
    const maxAttempts = 10;
    let entry = loginAttempts.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { windowStart: now, count: 0 };
      loginAttempts.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxAttempts) {
      const retryAfter = Math.ceil((entry.windowStart + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(429).send(buildChurchLoginHtml('Too many login attempts. Please try again later.'));
    }
    next();
  }
  // Cleanup stale entries every 10 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of loginAttempts) {
      if (now - entry.windowStart > 15 * 60 * 1000) loginAttempts.delete(key);
    }
  }, 10 * 60 * 1000).unref();

  // ── Schema ──────────────────────────────────────────────────────────────────
  const migrations = [
    "ALTER TABLE churches ADD COLUMN portal_email TEXT",
    "ALTER TABLE churches ADD COLUMN portal_password_hash TEXT",
    "ALTER TABLE churches ADD COLUMN phone TEXT",
    "ALTER TABLE churches ADD COLUMN location TEXT",
    "ALTER TABLE churches ADD COLUMN notes TEXT",
    "ALTER TABLE churches ADD COLUMN notifications TEXT DEFAULT '{}'",
    "ALTER TABLE churches ADD COLUMN telegram_chat_id TEXT",
  ];
  for (const m of migrations) {
    try { db.exec(m); } catch { /* already exists */ }
  }

  // Ensure portal-specific columns exist on church_tds (table created by telegramBot)
  const _portalMigrations = [
    "ALTER TABLE church_tds ADD COLUMN role TEXT DEFAULT 'td'",
    "ALTER TABLE church_tds ADD COLUMN email TEXT",
    "ALTER TABLE church_tds ADD COLUMN phone TEXT",
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

  const authMiddleware = requireChurchPortalAuth(db, jwtSecret);

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

    const patch = {};
    if (email          !== undefined) patch.email            = email;
    if (phone          !== undefined) patch.phone            = phone;
    if (location       !== undefined) patch.location         = location;
    if (notes          !== undefined) patch.notes            = notes;
    if (telegramChatId !== undefined) patch.telegram_chat_id = telegramChatId;
    if (notifications  !== undefined) patch.notifications    = JSON.stringify(notifications);

    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE churches SET ${sets} WHERE churchId = ?`).run(...Object.values(patch), churchId);
    }
    res.json({ ok: true });
  });

  // ── GET /api/church/schedule ──────────────────────────────────────────────────
  app.get('/api/church/schedule', authMiddleware, (req, res) => {
    const c = req.church;
    try {
      const sched = c.schedule ? JSON.parse(c.schedule) : {};
      res.json(sched);
    } catch { res.json({}); }
  });

  // ── PUT /api/church/schedule ──────────────────────────────────────────────────
  app.put('/api/church/schedule', authMiddleware, (req, res) => {
    try {
      db.prepare('UPDATE churches SET schedule = ? WHERE churchId = ?')
        .run(JSON.stringify(req.body), req.church.churchId);
      // Update in-memory map
      const runtime = churches.get(req.church.churchId);
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
      const status = church.billing_status || 'inactive';
      const trialEnds = church.billing_trial_ends;
      const trialDaysRemaining = trialEnds ? Math.max(0, Math.ceil((new Date(trialEnds) - Date.now()) / (1000 * 60 * 60 * 24))) : null;
      const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Managed', event: 'Event' };

      let portalUrl = null;
      try {
        const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
        if (STRIPE_KEY && church.stripe_customer_id) {
          const Stripe = require('stripe');
          const stripe = Stripe(STRIPE_KEY);
          const session = await stripe.billingPortal.sessions.create({
            customer: church.stripe_customer_id,
            return_url: req.headers.origin || 'https://tally.atemschool.com',
          });
          portalUrl = session.url;
        }
      } catch (e) { console.error('[billing portal session]', e.message); }

      res.json({
        tier,
        tierName: TIER_NAMES[tier] || tier,
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

  // ── Admin: set portal credentials ─────────────────────────────────────────────
  app.post('/api/churches/:churchId/portal-credentials', requireAdmin, (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = db.prepare('SELECT churchId FROM churches WHERE portal_email = ? AND churchId != ?').get(email.toLowerCase(), req.params.churchId);
    if (existing) return res.status(409).json({ error: 'Email already used by another church' });

    db.prepare('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?')
      .run(email.trim().toLowerCase(), hashPassword(password), req.params.churchId);

    console.log(`[ChurchPortal] Set portal credentials for church ${req.params.churchId}: ${email}`);
    res.json({ ok: true, email: email.trim().toLowerCase(), loginUrl: '/church-login' });
  });

  console.log('[ChurchPortal] ✓ Setup complete — routes registered');
}

module.exports = { setupChurchPortal };
