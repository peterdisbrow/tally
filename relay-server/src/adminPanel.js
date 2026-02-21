'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');

const COOKIE_NAME = 'tally_session';
const COOKIE_MAX_AGE = 28800; // 8 hours in seconds

// ─── SESSION HELPERS ──────────────────────────────────────────────────────────

function signSession(payload) {
  const secret = process.env.SESSION_SECRET || 'fallback-secret';
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
  return `${payloadB64}.${sig}`;
}

function verifySession(cookie) {
  if (!cookie) return null;
  const lastDot = cookie.lastIndexOf('.');
  if (lastDot === -1) return null;
  const payloadB64 = cookie.slice(0, lastDot);
  const sig = cookie.slice(lastDot + 1);
  const secret = process.env.SESSION_SECRET || 'fallback-secret';
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
  try {
    const eSigBuf = Buffer.from(expectedSig);
    const sigBuf = Buffer.from(sig);
    if (eSigBuf.length !== sigBuf.length) return null;
    if (!crypto.timingSafeEqual(eSigBuf, sigBuf)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function setCookieHeader(res, payload) {
  const value = encodeURIComponent(signSession(payload));
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
}

function clearCookieHeader(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

// Legacy SHA-256 hash (for verifying old stored hashes)
function hashPortalPasswordLegacy(password) {
  const secret = process.env.SESSION_SECRET || 'fallback-secret';
  return crypto.createHash('sha256').update(secret + password).digest('hex');
}

// New scrypt-based hash (salt:hash format)
function hashPortalPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Verify password against either scrypt (salt:hash) or legacy SHA-256 (plain hex)
function verifyPortalPassword(password, stored) {
  if (!stored) return false;
  if (stored.includes(':')) {
    // scrypt format: salt:hash
    try {
      const [salt, hash] = stored.split(':');
      const check = crypto.scryptSync(password, salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
    } catch { return false; }
  }
  // Legacy SHA-256 format
  return stored === hashPortalPasswordLegacy(password);
}

function getSession(req) {
  const raw = req.cookies && req.cookies[COOKIE_NAME];
  if (!raw) return null;
  try { return verifySession(decodeURIComponent(raw)); } catch { return null; }
}

// ─── HTML: ADMIN LOGIN ────────────────────────────────────────────────────────

function buildAdminLoginHtml(error) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tally Admin — Sign In</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--red:#ef4444;--text:#e2e4ef;--muted:#6b7280}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:40px;width:100%;max-width:380px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:32px;justify-content:center}
.dot{width:12px;height:12px;background:var(--green);border-radius:50%;box-shadow:0 0 12px var(--green)}
.logo-text{font-size:22px;font-weight:700;letter-spacing:-0.5px}
h1{font-size:18px;font-weight:600;margin-bottom:24px;text-align:center;color:var(--muted)}
.field{margin-bottom:16px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;transition:border-color .2s}
input:focus{border-color:var(--green)}
.btn{width:100%;background:var(--green);color:#000;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px;transition:opacity .2s}
.btn:hover{opacity:.9}
.error{background:#ef444420;border:1px solid #ef4444;color:#ef4444;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px;text-align:center}
</style></head>
<body><div class="card">
<div class="logo"><div class="dot"></div><span class="logo-text">Tally Admin</span></div>
<h1>Sign in to your account</h1>
${error ? '<div class="error">Invalid email or password</div>' : ''}
<form method="POST" action="/admin/login">
<div class="field"><label>Email</label><input type="email" name="email" placeholder="andrew@atemschool.com" required autocomplete="email"></div>
<div class="field"><label>Password</label><input type="password" name="password" placeholder="••••••••" required autocomplete="current-password"></div>
<button class="btn" type="submit">Sign In</button>
</form>
</div></body></html>`;
}

// ─── HTML: ADMIN DASHBOARD ────────────────────────────────────────────────────

function buildAdminDashboardHtml() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tally Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--text:#e2e4ef;--muted:#6b7280;--dim:#374151}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;min-width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:0}
.sidebar-logo{display:flex;align-items:center;gap:10px;padding:24px 20px;border-bottom:1px solid var(--border)}
.dot{width:10px;height:10px;background:var(--green);border-radius:50%;box-shadow:0 0 8px var(--green)}
.sidebar-logo span{font-size:16px;font-weight:700}
.nav{flex:1;padding:12px 0}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;cursor:pointer;border-radius:0;color:var(--muted);font-size:14px;transition:all .15s;user-select:none}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,.04)}
.nav-item.active{color:var(--text);background:rgba(34,197,94,.08);border-right:2px solid var(--green)}
.nav-item svg{width:16px;height:16px;flex-shrink:0}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
.sidebar-footer a{color:var(--red);text-decoration:none;font-size:12px}
.sidebar-footer a:hover{text-decoration:underline}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.header{padding:16px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface)}
.header-title{font-size:15px;font-weight:600}
.header-right{display:flex;align-items:center;gap:16px;font-size:13px;color:var(--muted)}
.content{flex:1;overflow-y:auto;padding:28px}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.stat-card.online{border-color:var(--green)}
.stat-num{font-size:32px;font-weight:700;margin-bottom:4px}
.stat-card.online .stat-num{color:var(--green)}
.stat-label{font-size:13px;color:var(--muted)}
/* Tables */
.table-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px}
.search-input{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 14px;color:var(--text);font-size:13px;outline:none;width:240px}
.search-input:focus{border-color:var(--green)}
.filter-tabs{display:flex;gap:4px}
.filter-tab{padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border);color:var(--muted);background:transparent;transition:all .15s}
.filter-tab.active{background:var(--green);color:#000;border-color:var(--green);font-weight:600}
.btn-primary{background:var(--green);color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-primary:hover{opacity:.9}
.btn-secondary{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;transition:all .15s}
.btn-secondary:hover{border-color:var(--text)}
.btn-danger{background:transparent;color:var(--red);border:1px solid var(--red);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
.btn-danger:hover{background:var(--red);color:#fff}
.btn-sm{padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:all .15s}
.btn-sm:hover{color:var(--text);border-color:var(--text)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid rgba(42,45,62,.5)}
tr:hover td{background:rgba(255,255,255,.02)}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.status-online{background:var(--green);box-shadow:0 0 6px var(--green)}
.status-offline{background:var(--muted)}
.color-swatch{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;margin-right:4px;border:1px solid rgba(255,255,255,.15)}
.badge-active{color:var(--green);font-size:12px}
.badge-inactive{color:var(--muted);font-size:12px}
.church-name-link{color:var(--text);cursor:pointer;text-decoration:none}
.church-name-link:hover{color:var(--green);text-decoration:underline}
/* Modals */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto}
.modal h2{font-size:16px;font-weight:600;margin-bottom:20px}
.form-field{margin-bottom:16px}
.form-field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.form-field input,.form-field select{width:100%;background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px;outline:none}
.form-field input:focus,.form-field select:focus{border-color:var(--green)}
.form-field select option{background:#1a1d27}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.modal-close{position:absolute;top:16px;right:16px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.modal-close:hover{color:var(--text)}
/* Slide-in panel */
.detail-panel{position:fixed;right:-480px;top:0;height:100vh;width:460px;background:var(--surface);border-left:1px solid var(--border);z-index:90;transition:right .3s ease;overflow-y:auto;padding:28px}
.detail-panel.open{right:0}
.detail-panel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.detail-panel-header h2{font-size:16px;font-weight:600}
.panel-close{background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer}
.panel-close:hover{color:var(--text)}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(42,45,62,.5);font-size:13px}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500;margin:2px}
.chip-green{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.chip-grey{background:rgba(107,114,128,.15);color:var(--muted);border:1px solid rgba(107,114,128,.3)}
.chip-yellow{background:rgba(245,158,11,.15);color:var(--yellow);border:1px solid rgba(245,158,11,.3)}
.token-box{background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:12px;font-family:monospace;font-size:11px;word-break:break-all;margin-top:8px;position:relative}
.copy-btn{background:var(--green);color:#000;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;margin-top:6px}
/* Settings */
.settings-section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;margin-bottom:20px}
.settings-section h3{font-size:14px;font-weight:600;margin-bottom:16px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.settings-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(42,45,62,.5);font-size:13px}
.settings-row:last-child{border-bottom:none}
.masked{font-family:monospace;letter-spacing:2px}
/* Alerts */
.alert-box{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:16px}
.alert-error{background:#ef444420;border:1px solid #ef4444;color:#ef4444}
.alert-success{background:#22c55e20;border:1px solid #22c55e;color:#22c55e}
/* Copy input */
.copy-group{display:flex;gap:8px;align-items:center}
.copy-group input{flex:1;font-family:monospace;font-size:12px}
</style></head>
<body>

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="dot"></div>
    <span>Tally Admin</span>
  </div>
  <nav class="nav">
    <div class="nav-item active" onclick="showPage('overview')" id="nav-overview">
      <svg viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
      Overview
    </div>
    <div class="nav-item" onclick="showPage('churches')" id="nav-churches">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1L1 5v10h14V5L8 1zm0 2.2L13 6.4V13H3V6.4L8 3.2z"/><rect x="6" y="9" width="4" height="4"/></svg>
      Churches
    </div>
    <div class="nav-item" onclick="showPage('resellers')" id="nav-resellers">
      <svg viewBox="0 0 16 16" fill="currentColor"><circle cx="6" cy="5" r="3"/><path d="M1 14c0-3 2-5 5-5s5 2 5 5"/><circle cx="13" cy="6" r="2"/><path d="M11 14c0-2 .9-3 2-3"/></svg>
      Resellers
    </div>
    <div class="nav-item" onclick="showPage('settings')" id="nav-settings">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm5.5-2.5a5.5 5.5 0 01-.1 1l1.4 1.1-1.5 2.6-1.7-.5A5.5 5.5 0 019 12.9V15H7v-2.1a5.5 5.5 0 01-1.6-.7l-1.7.5-1.5-2.6L3.6 9A5.5 5.5 0 013.5 8c0-.4 0-.7.1-1L2.2 5.9l1.5-2.6 1.7.5A5.5 5.5 0 017 3.1V1h2v2.1a5.5 5.5 0 011.6.7l1.7-.5 1.5 2.6L12.4 7c.1.3.1.7.1 1z"/></svg>
      Settings
    </div>
  </nav>
  <div class="sidebar-footer">
    <div style="margin-bottom:6px">${adminEmail}</div>
    <a href="/admin/login" onclick="signOut(event)">Sign Out</a>
  </div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="header">
    <div class="header-title" id="page-title">Overview</div>
    <div class="header-right">
      <div class="dot" style="width:8px;height:8px"></div>
      <span>Tally Admin</span>
    </div>
  </div>
  <div class="content" id="content">

    <!-- OVERVIEW PAGE -->
    <div id="page-overview">
      <div class="stats-grid" id="stats-grid">
        <div class="stat-card"><div class="stat-num" id="stat-churches">—</div><div class="stat-label">Total Churches</div></div>
        <div class="stat-card online"><div class="stat-num" id="stat-online">—</div><div class="stat-label">Online Now</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-resellers">—</div><div class="stat-label">Total Resellers</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-alerts">—</div><div class="stat-label">Active Alerts</div></div>
      </div>
      <div style="color:var(--muted);font-size:13px" id="overview-status">Loading overview data...</div>
    </div>

    <!-- CHURCHES PAGE -->
    <div id="page-churches" style="display:none">
      <div class="table-toolbar">
        <div style="display:flex;gap:10px;align-items:center">
          <input class="search-input" id="church-search" placeholder="Search churches..." oninput="filterChurches()">
          <div class="filter-tabs">
            <button class="filter-tab active" onclick="setChurchFilter('all',this)">All</button>
            <button class="filter-tab" onclick="setChurchFilter('online',this)">Online</button>
            <button class="filter-tab" onclick="setChurchFilter('offline',this)">Offline</button>
          </div>
        </div>
        <button class="btn-primary" onclick="openAddChurch()">+ Add Church</button>
      </div>
      <table id="churches-table">
        <thead><tr>
          <th>Name</th><th>Reseller</th><th>Status</th><th>Type</th><th>Registered</th><th>Last Seen</th><th>Actions</th>
        </tr></thead>
        <tbody id="churches-tbody"><tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
    </div>

    <!-- RESELLERS PAGE -->
    <div id="page-resellers" style="display:none">
      <div class="table-toolbar">
        <div></div>
        <button class="btn-primary" onclick="openAddReseller()">+ Add Reseller</button>
      </div>
      <table id="resellers-table">
        <thead><tr>
          <th>Brand Name</th><th>Slug</th><th>Email</th><th>Churches</th><th>Color</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="resellers-tbody"><tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
    </div>

    <!-- SETTINGS PAGE -->
    <div id="page-settings" style="display:none">
      <div class="settings-section">
        <h3>Server</h3>
        <div class="settings-row"><span class="info-label">Admin Email</span><span>${adminEmail}</span></div>
        <div class="settings-row"><span class="info-label">Database Path</span><span id="set-db-path" style="font-family:monospace;font-size:12px">—</span></div>
        <div class="settings-row"><span class="info-label">Uptime</span><span id="set-uptime">—</span></div>
      </div>
      <div class="settings-section">
        <h3>Admin Password</h3>
        <div id="pw-msg"></div>
        <div class="form-field"><label>New Password</label><input type="password" id="new-pw" placeholder="New password"></div>
        <button class="btn-primary" onclick="changeAdminPassword()">Change Password</button>
      </div>
      <div class="settings-section">
        <h3>Admin API Key</h3>
        <div class="copy-group">
          <input type="password" id="api-key-display" value="tally-admin-••••••••" readonly>
          <button class="btn-sm" onclick="toggleApiKey()">Reveal</button>
          <button class="btn-sm" onclick="copyApiKey()">Copy</button>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- CHURCH DETAIL PANEL -->
<div class="detail-panel" id="church-detail">
  <div class="detail-panel-header">
    <h2 id="detail-name">Church Details</h2>
    <button class="panel-close" onclick="closeDetail()">×</button>
  </div>
  <div id="detail-content"></div>
</div>

<!-- MODALS -->

<!-- Add/Edit Church Modal -->
<div class="modal-overlay" id="modal-church">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-church')">×</button>
    <h2 id="church-modal-title">Add Church</h2>
    <div id="church-modal-msg"></div>
    <input type="hidden" id="church-modal-id">
    <div class="form-field"><label>Church Name</label><input id="cm-name" type="text" placeholder="Grace Community Church"></div>
    <div class="form-field"><label>Email</label><input id="cm-email" type="email" placeholder="td@church.com"></div>
    <div class="form-field"><label>Type</label><select id="cm-type"><option value="recurring">Recurring</option><option value="event">Event</option></select></div>
    <div class="form-field"><label>Reseller</label><select id="cm-reseller"><option value="">None (Direct)</option></select></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal('modal-church')">Cancel</button>
      <button class="btn-primary" onclick="submitChurch()">Save</button>
    </div>
  </div>
</div>

<!-- Regen Token Modal -->
<div class="modal-overlay" id="modal-token">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-token')">×</button>
    <h2>Regenerate Token</h2>
    <div id="regen-msg"></div>
    <div id="regen-token-display" style="display:none">
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px">New token generated. Share this with the church client:</p>
      <div class="token-box" id="regen-token-value"></div>
      <button class="copy-btn" onclick="copyRegenToken()">Copy Token</button>
    </div>
    <div id="regen-confirm">
      <p style="color:var(--muted);font-size:13px;margin-bottom:16px">This will invalidate the current token. The church client will need to be reconfigured.</p>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeModal('modal-token')">Cancel</button>
        <button class="btn-primary" onclick="doRegenToken()">Regenerate</button>
      </div>
    </div>
  </div>
</div>

<!-- Add/Edit Reseller Modal -->
<div class="modal-overlay" id="modal-reseller">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-reseller')">×</button>
    <h2 id="reseller-modal-title">Add Reseller</h2>
    <div id="reseller-modal-msg"></div>
    <input type="hidden" id="rm-id">
    <div class="form-field"><label>Internal Name</label><input id="rm-name" type="text" placeholder="AV Solutions Inc"></div>
    <div class="form-field"><label>Brand Name</label><input id="rm-brand" type="text" placeholder="AV Solutions Pro"></div>
    <div class="form-field"><label>Support Email</label><input id="rm-email" type="email" placeholder="support@avsolutions.com"></div>
    <div class="form-field"><label>Logo URL</label><input id="rm-logo" type="url" placeholder="https://..."></div>
    <div class="form-field"><label>Primary Color</label><input id="rm-color" type="color" value="#22c55e"></div>
    <div class="form-field"><label>Church Limit</label><input id="rm-limit" type="number" value="10" min="1"></div>
    <div class="form-field" id="rm-pw-field"><label>Portal Password <span style="color:var(--red)">*</span></label><input id="rm-password" type="password" placeholder="Create portal password"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal('modal-reseller')">Cancel</button>
      <button class="btn-primary" onclick="submitReseller()">Save</button>
    </div>
  </div>
</div>

<!-- API Key "COPY NOW" Modal -->
<div class="modal-overlay" id="modal-apikey">
  <div class="modal" style="position:relative;text-align:center">
    <button class="modal-close" onclick="closeModal('modal-apikey')">×</button>
    <h2 style="margin-bottom:12px">🔑 API Key — Copy Now!</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px">This key will not be shown again.</p>
    <div class="token-box" id="apikey-display" style="font-size:13px;cursor:pointer" onclick="copyNewApiKey()"></div>
    <button class="copy-btn" style="margin-top:12px;padding:8px 20px;font-size:13px" onclick="copyNewApiKey()">Copy API Key</button>
  </div>
</div>

<!-- Set Password Modal -->
<div class="modal-overlay" id="modal-setpw">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-setpw')">×</button>
    <h2>Set Portal Password</h2>
    <div id="setpw-msg"></div>
    <input type="hidden" id="setpw-id">
    <div class="form-field"><label>New Password</label><input id="setpw-pw" type="password" placeholder="New portal password"></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal('modal-setpw')">Cancel</button>
      <button class="btn-primary" onclick="submitSetPassword()">Set Password</button>
    </div>
  </div>
</div>

<script>
// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'overview';
let allChurches = [];
let allResellers = [];
let churchFilter = 'all';
let regenChurchId = null;
let currentApiKey = '';

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(page) {
  ['overview','churches','resellers','settings'].forEach(p => {
    document.getElementById('page-'+p).style.display = p === page ? '' : 'none';
    document.getElementById('nav-'+p).classList.toggle('active', p === page);
  });
  document.getElementById('page-title').textContent = page.charAt(0).toUpperCase() + page.slice(1);
  currentPage = page;
  if (page === 'overview') loadOverview();
  else if (page === 'churches') loadChurches();
  else if (page === 'resellers') loadResellers();
  else if (page === 'settings') loadSettings();
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const r = await fetch('/api/admin/overview');
    const d = await r.json();
    document.getElementById('stat-churches').textContent = d.totalChurches ?? 0;
    document.getElementById('stat-online').textContent = d.onlineNow ?? 0;
    document.getElementById('stat-resellers').textContent = d.totalResellers ?? 0;
    document.getElementById('stat-alerts').textContent = d.activeAlerts ?? 0;
    document.getElementById('overview-status').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('overview-status').textContent = 'Failed to load overview data.';
  }
}

// ─── Churches ─────────────────────────────────────────────────────────────────
async function loadChurches() {
  try {
    const [cr, rr] = await Promise.all([fetch('/api/admin/churches'), fetch('/api/resellers')]);
    allChurches = await cr.json();
    allResellers = await rr.json();
    populateResellerDropdown('cm-reseller');
    renderChurches();
  } catch(e) {
    document.getElementById('churches-tbody').innerHTML = '<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px">Failed to load churches</td></tr>';
  }
}

function renderChurches() {
  const search = document.getElementById('church-search').value.toLowerCase();
  let list = allChurches;
  if (churchFilter === 'online') list = list.filter(c => c.connected);
  else if (churchFilter === 'offline') list = list.filter(c => !c.connected);
  if (search) list = list.filter(c => c.name.toLowerCase().includes(search) || (c.email||'').toLowerCase().includes(search));
  const tbody = document.getElementById('churches-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">No churches found</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => {
    const reseller = allResellers.find(r => r.id === c.reseller_id);
    const statusHtml = c.connected
      ? '<span class="status-dot status-online"></span>Online'
      : '<span class="status-dot status-offline"></span>Offline';
    const lastSeen = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'Never';
    const reg = c.registeredAt ? new Date(c.registeredAt).toLocaleDateString() : '—';
    return \`<tr>
      <td><a class="church-name-link" onclick="openDetail(\${JSON.stringify(c.churchId)})">\${esc(c.name)}</a></td>
      <td>\${reseller ? esc(reseller.brand_name || reseller.name) : '<span style="color:var(--muted)">Direct</span>'}</td>
      <td>\${statusHtml}</td>
      <td>\${c.church_type||'recurring'}</td>
      <td>\${reg}</td>
      <td>\${lastSeen}</td>
      <td>
        <button class="btn-sm" onclick="openEditChurch(\${JSON.stringify(c.churchId)})">Edit</button>
        <button class="btn-sm" onclick="openRegenToken(\${JSON.stringify(c.churchId)})">Regen Token</button>
        <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteChurch(\${JSON.stringify(c.churchId)},\${JSON.stringify(c.name)})">Delete</button>
      </td>
    </tr>\`;
  }).join('');
}

function filterChurches() { renderChurches(); }
function setChurchFilter(f, el) {
  churchFilter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderChurches();
}

function openAddChurch() {
  document.getElementById('church-modal-title').textContent = 'Add Church';
  document.getElementById('church-modal-id').value = '';
  document.getElementById('cm-name').value = '';
  document.getElementById('cm-email').value = '';
  document.getElementById('cm-type').value = 'recurring';
  document.getElementById('cm-reseller').value = '';
  document.getElementById('church-modal-msg').innerHTML = '';
  openModal('modal-church');
}

function openEditChurch(id) {
  const c = allChurches.find(x => x.churchId === id);
  if (!c) return;
  document.getElementById('church-modal-title').textContent = 'Edit Church';
  document.getElementById('church-modal-id').value = id;
  document.getElementById('cm-name').value = c.name;
  document.getElementById('cm-email').value = c.email||'';
  document.getElementById('cm-type').value = c.church_type||'recurring';
  document.getElementById('cm-reseller').value = c.reseller_id||'';
  document.getElementById('church-modal-msg').innerHTML = '';
  openModal('modal-church');
}

async function submitChurch() {
  const id = document.getElementById('church-modal-id').value;
  const body = {
    name: document.getElementById('cm-name').value,
    email: document.getElementById('cm-email').value,
    type: document.getElementById('cm-type').value,
    resellerId: document.getElementById('cm-reseller').value || null,
  };
  try {
    const url = id ? \`/api/admin/churches/\${id}\` : '/api/admin/churches';
    const method = id ? 'PUT' : 'POST';
    const r = await fetch(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await r.json();
    if (!r.ok) { showModalMsg('church-modal-msg', d.error||'Error', 'error'); return; }
    closeModal('modal-church');
    loadChurches();
  } catch(e) { showModalMsg('church-modal-msg', 'Request failed', 'error'); }
}

async function deleteChurch(id, name) {
  if (!confirm(\`Delete "\${name}"? This cannot be undone.\`)) return;
  const r = await fetch(\`/api/admin/churches/\${id}\`, {method:'DELETE'});
  const d = await r.json();
  if (r.ok) loadChurches();
  else alert(d.error||'Delete failed');
}

function openRegenToken(id) {
  regenChurchId = id;
  document.getElementById('regen-confirm').style.display = '';
  document.getElementById('regen-token-display').style.display = 'none';
  document.getElementById('regen-msg').innerHTML = '';
  openModal('modal-token');
}

async function doRegenToken() {
  if (!regenChurchId) return;
  const r = await fetch(\`/api/admin/churches/\${regenChurchId}/token\`, {method:'POST'});
  const d = await r.json();
  if (!r.ok) { showModalMsg('regen-msg', d.error||'Error', 'error'); return; }
  document.getElementById('regen-confirm').style.display = 'none';
  document.getElementById('regen-token-value').textContent = d.token;
  document.getElementById('regen-token-display').style.display = '';
}

function copyRegenToken() {
  const t = document.getElementById('regen-token-value').textContent;
  navigator.clipboard.writeText(t).then(() => alert('Token copied!'));
}

// ─── Church Detail Panel ──────────────────────────────────────────────────────
async function openDetail(id) {
  const c = allChurches.find(x => x.churchId === id);
  if (!c) return;
  const reseller = allResellers.find(r => r.id === c.reseller_id);
  const status = c.status || {};
  const atem = status.atem;
  const obs = status.obs;
  const companion = status.companion;

  function chip(label, ok) {
    return \`<span class="chip \${ok ? 'chip-green' : 'chip-grey'}">\${label}: \${ok ? 'OK' : 'N/A'}</span>\`;
  }

  document.getElementById('detail-name').textContent = c.name;
  document.getElementById('detail-content').innerHTML = \`
    <div class="info-row"><span class="info-label">Status</span><span>\${c.connected ? '<span class="status-dot status-online"></span>Online' : '<span class="status-dot status-offline"></span>Offline'}</span></div>
    <div class="info-row"><span class="info-label">Type</span><span>\${c.church_type||'recurring'}</span></div>
    <div class="info-row"><span class="info-label">Reseller</span><span>\${reseller ? esc(reseller.brand_name||reseller.name) : 'Direct'}</span></div>
    <div class="info-row"><span class="info-label">Registered</span><span>\${c.registeredAt ? new Date(c.registeredAt).toLocaleString() : '—'}</span></div>
    <div class="info-row"><span class="info-label">Last Seen</span><span>\${c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'Never'}</span></div>
    <div class="info-row" style="flex-direction:column;align-items:flex-start;gap:6px">
      <span class="info-label">Devices</span>
      <div>\${chip('ATEM', !!atem)}\${chip('OBS', !!obs)}\${chip('Companion', !!companion)}</div>
    </div>
    <div class="info-row" style="flex-direction:column;align-items:flex-start;gap:6px">
      <span class="info-label">Token</span>
      <div class="token-box" id="detail-token" style="font-size:11px;filter:blur(4px);cursor:pointer" onclick="revealToken()">
        \${esc((c.token||'').substring(0,60))}...
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn-sm" onclick="revealToken()">Reveal</button>
        <button class="btn-sm" onclick="copyToken(\${JSON.stringify(c.token||'')})">Copy</button>
      </div>
    </div>
  \`;
  document.getElementById('church-detail').classList.add('open');
}

function revealToken() {
  const el = document.getElementById('detail-token');
  if (el) el.style.filter = 'none';
}
function copyToken(t) { navigator.clipboard.writeText(t).then(() => alert('Token copied!')); }
function closeDetail() { document.getElementById('church-detail').classList.remove('open'); }

// ─── Resellers ────────────────────────────────────────────────────────────────
async function loadResellers() {
  try {
    const r = await fetch('/api/resellers');
    allResellers = await r.json();
    renderResellers();
  } catch(e) {
    document.getElementById('resellers-tbody').innerHTML = '<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px">Failed to load resellers</td></tr>';
  }
}

function renderResellers() {
  const tbody = document.getElementById('resellers-tbody');
  if (!allResellers.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">No resellers yet</td></tr>';
    return;
  }
  tbody.innerHTML = allResellers.map(r => {
    const color = r.primary_color||'#22c55e';
    const status = r.active ? '<span class="badge-active">● Active</span>' : '<span class="badge-inactive">● Inactive</span>';
    const churches = \`\${r.churchCount||0} / \${r.church_limit||10}\`;
    return \`<tr>
      <td>\${esc(r.brand_name||r.name)}</td>
      <td><span style="font-family:monospace;font-size:12px">\${esc(r.slug||'')}</span></td>
      <td>\${esc(r.support_email||'—')}</td>
      <td>\${churches}</td>
      <td><span class="color-swatch" style="background:\${color}"></span>\${color}</td>
      <td>\${status}</td>
      <td>
        <button class="btn-sm" onclick="openEditReseller(\${JSON.stringify(r.id)})">Edit</button>
        <button class="btn-sm" onclick="openSetPassword(\${JSON.stringify(r.id)})">Set Password</button>
        <button class="btn-sm" onclick="window.open('/portal','_blank')">View Portal</button>
        <button class="btn-sm" onclick="toggleReseller(\${JSON.stringify(r.id)},\${r.active})">\${r.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteReseller(\${JSON.stringify(r.id)},\${JSON.stringify(r.brand_name||r.name)})">Delete</button>
      </td>
    </tr>\`;
  }).join('');
}

function openAddReseller() {
  document.getElementById('reseller-modal-title').textContent = 'Add Reseller';
  document.getElementById('rm-id').value = '';
  document.getElementById('rm-name').value = '';
  document.getElementById('rm-brand').value = '';
  document.getElementById('rm-email').value = '';
  document.getElementById('rm-logo').value = '';
  document.getElementById('rm-color').value = '#22c55e';
  document.getElementById('rm-limit').value = '10';
  document.getElementById('rm-password').value = '';
  document.getElementById('rm-pw-field').style.display = '';
  document.getElementById('reseller-modal-msg').innerHTML = '';
  openModal('modal-reseller');
}

function openEditReseller(id) {
  const r = allResellers.find(x => x.id === id);
  if (!r) return;
  document.getElementById('reseller-modal-title').textContent = 'Edit Reseller';
  document.getElementById('rm-id').value = id;
  document.getElementById('rm-name').value = r.name||'';
  document.getElementById('rm-brand').value = r.brand_name||'';
  document.getElementById('rm-email').value = r.support_email||'';
  document.getElementById('rm-logo').value = r.logo_url||'';
  document.getElementById('rm-color').value = r.primary_color||'#22c55e';
  document.getElementById('rm-limit').value = r.church_limit||10;
  document.getElementById('rm-password').value = '';
  document.getElementById('rm-pw-field').style.display = 'none';
  document.getElementById('reseller-modal-msg').innerHTML = '';
  openModal('modal-reseller');
}

async function submitReseller() {
  const id = document.getElementById('rm-id').value;
  const body = {
    name: document.getElementById('rm-name').value,
    brandName: document.getElementById('rm-brand').value,
    supportEmail: document.getElementById('rm-email').value,
    logoUrl: document.getElementById('rm-logo').value,
    primaryColor: document.getElementById('rm-color').value,
    churchLimit: parseInt(document.getElementById('rm-limit').value)||10,
  };
  if (!id) {
    const pw = document.getElementById('rm-password').value;
    if (!pw) { showModalMsg('reseller-modal-msg', 'Portal password is required', 'error'); return; }
    body.password = pw;
  }
  try {
    const url = id ? \`/api/admin/resellers/\${id}\` : '/api/resellers';
    const method = id ? 'PUT' : 'POST';
    const r = await fetch(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await r.json();
    if (!r.ok) { showModalMsg('reseller-modal-msg', d.error||'Error', 'error'); return; }
    if (!id && d.resellerId) {
      // Set password and show API key
      const newId = d.resellerId;
      await fetch(\`/api/admin/resellers/\${newId}/password\`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({password: body.password})
      });
      closeModal('modal-reseller');
      document.getElementById('apikey-display').textContent = d.apiKey||'(see DB)';
      currentApiKey = d.apiKey||'';
      openModal('modal-apikey');
    } else {
      closeModal('modal-reseller');
    }
    loadResellers();
  } catch(e) { showModalMsg('reseller-modal-msg', 'Request failed', 'error'); }
}

function copyNewApiKey() {
  navigator.clipboard.writeText(currentApiKey).then(() => alert('API key copied!'));
}

function openSetPassword(id) {
  document.getElementById('setpw-id').value = id;
  document.getElementById('setpw-pw').value = '';
  document.getElementById('setpw-msg').innerHTML = '';
  openModal('modal-setpw');
}

async function submitSetPassword() {
  const id = document.getElementById('setpw-id').value;
  const pw = document.getElementById('setpw-pw').value;
  if (!pw) { showModalMsg('setpw-msg', 'Password required', 'error'); return; }
  const r = await fetch(\`/api/admin/resellers/\${id}/password\`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw})
  });
  const d = await r.json();
  if (r.ok) { closeModal('modal-setpw'); alert('Password updated'); }
  else showModalMsg('setpw-msg', d.error||'Error', 'error');
}

async function toggleReseller(id, active) {
  const r = await fetch(\`/api/admin/resellers/\${id}\`, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({active: active ? 0 : 1})
  });
  if (r.ok) loadResellers();
}

async function deleteReseller(id, name) {
  if (!confirm(\`Delete reseller "\${name}"?\`)) return;
  const r = await fetch(\`/api/admin/resellers/\${id}\`, {method:'DELETE'});
  if (r.ok) loadResellers();
  else alert('Delete failed');
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    document.getElementById('set-uptime').textContent = formatUptime(d.uptime||0);
  } catch {}
  document.getElementById('set-db-path').textContent = '(configured on server)';
}

async function changeAdminPassword() {
  const pw = document.getElementById('new-pw').value;
  if (!pw) return;
  const r = await fetch('/api/admin/change-password', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw})
  });
  const d = await r.json();
  const el = document.getElementById('pw-msg');
  if (r.ok) {
    el.innerHTML = '<div class="alert-box alert-success">Password changed successfully</div>';
    document.getElementById('new-pw').value = '';
  } else {
    el.innerHTML = \`<div class="alert-box alert-error">\${esc(d.error||'Error')}</div>\`;
  }
}

let apiKeyRevealed = false;
function toggleApiKey() {
  const el = document.getElementById('api-key-display');
  apiKeyRevealed = !apiKeyRevealed;
  el.type = 'password';
  el.value = 'tally-admin-••••••••';
  alert('For security, API keys are no longer displayed in the browser. Use the RBAC admin dashboard at /admin or check your Railway environment variables.');
}
function copyApiKey() {
  alert('For security, API keys are no longer exposed in the browser. Check your Railway environment variables directly.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function populateResellerDropdown(id) {
  const sel = document.getElementById(id);
  const current = sel.value;
  sel.innerHTML = '<option value="">None (Direct)</option>' +
    allResellers.map(r => \`<option value="\${r.id}">\${esc(r.brand_name||r.name)}</option>\`).join('');
  sel.value = current;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showModalMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = \`<div class="alert-box alert-\${type==='error'?'error':'success'}">\${esc(msg)}</div>\`;
}

function formatUptime(s) {
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return h + 'h ' + m + 'm';
}

async function signOut(e) {
  e.preventDefault();
  await fetch('/admin/logout', {method:'POST'});
  window.location.href = '/admin/login';
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadOverview();
</script>
</body></html>`;
}

// ─── HTML: PORTAL LOGIN ───────────────────────────────────────────────────────

function buildPortalLoginHtml(error, resellerBrand) {
  const brand = resellerBrand || 'Tally Partner Portal';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} — Sign In</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:#22c55e;--red:#ef4444;--text:#e2e4ef;--muted:#6b7280}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:40px;width:100%;max-width:380px}
.logo{font-size:20px;font-weight:700;text-align:center;margin-bottom:32px;letter-spacing:-0.5px}
h1{font-size:16px;font-weight:600;margin-bottom:24px;text-align:center;color:var(--muted)}
.field{margin-bottom:16px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;transition:border-color .2s}
input:focus{border-color:var(--green)}
.btn{width:100%;background:var(--green);color:#000;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px;transition:opacity .2s}
.btn:hover{opacity:.9}
.error{background:#ef444420;border:1px solid #ef4444;color:#ef4444;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px;text-align:center}
.notice{background:#22c55e15;border:1px solid #22c55e40;color:var(--muted);border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:16px;text-align:center}
</style></head>
<body><div class="card">
<div class="logo">${brand}</div>
<h1>Sign in to your account</h1>
${error === 'nopw' ? '<div class="notice">Contact your administrator to activate portal access.</div>' : ''}
${error === '1' ? '<div class="error">Invalid email or password</div>' : ''}
<form method="POST" action="/portal/login">
<div class="field"><label>Email</label><input type="email" name="email" placeholder="you@company.com" required autocomplete="email"></div>
<div class="field"><label>Password</label><input type="password" name="password" placeholder="••••••••" required autocomplete="current-password"></div>
<button class="btn" type="submit">Sign In</button>
</form>
</div></body></html>`;
}

// ─── HTML: RESELLER PORTAL ────────────────────────────────────────────────────

function buildPortalHtml(reseller) {
  const brand = reseller.brand_name || 'Tally';
  const color = reseller.primary_color || '#22c55e';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${brand} Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f1117;--surface:#1a1d27;--border:#2a2d3e;--green:${color};--red:#ef4444;--yellow:#f59e0b;--text:#e2e4ef;--muted:#6b7280;--dim:#374151}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;min-height:100vh}
.portal-header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 28px;display:flex;align-items:center;justify-content:space-between}
.portal-brand{font-size:17px;font-weight:700;color:var(--green)}
.portal-header a{color:var(--muted);font-size:13px;text-decoration:none}
.portal-header a:hover{color:var(--red)}
.stats-bar{background:var(--surface);border-bottom:1px solid var(--border);display:flex;padding:12px 28px;gap:32px}
.stat-item{text-align:center}
.stat-item .num{font-size:20px;font-weight:700;color:var(--green)}
.stat-item .lbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.tabs-bar{display:flex;padding:0 28px;border-bottom:1px solid var(--border);background:var(--surface)}
.tab{padding:12px 20px;cursor:pointer;font-size:14px;color:var(--muted);border-bottom:2px solid transparent;transition:all .15s}
.tab.active{color:var(--text);border-bottom-color:var(--green)}
.tab:hover{color:var(--text)}
.tab-content{display:none;padding:28px;flex:1}
.tab-content.active{display:block}
/* Table */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid rgba(42,45,62,.5)}
tr:hover td{background:rgba(255,255,255,.02)}
.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
.status-online{background:var(--green);box-shadow:0 0 5px var(--green)}
.status-offline{background:var(--muted)}
.chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:500}
.chip-green{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.chip-grey{background:rgba(107,114,128,.15);color:var(--muted);border:1px solid rgba(107,114,128,.3)}
.btn-sm{padding:5px 10px;font-size:12px;border-radius:6px;cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--muted);transition:all .15s}
.btn-sm:hover{color:var(--text);border-color:var(--text)}
.btn-primary{background:var(--green);color:#000;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn-primary:hover{opacity:.9}
/* Add church form */
.form-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:28px;max-width:480px}
.form-field{margin-bottom:16px}
.form-field label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
.form-field input,.form-field select{width:100%;background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px;outline:none}
.form-field input:focus{border-color:var(--green)}
/* Success card */
.success-card{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:12px;padding:24px;max-width:520px;margin-top:20px}
.reg-code{font-family:monospace;font-size:28px;font-weight:700;letter-spacing:4px;color:var(--green);text-align:center;margin:16px 0;background:#0f1117;border-radius:8px;padding:16px}
/* Slide-in panel */
.detail-panel{position:fixed;right:-460px;top:0;height:100vh;width:440px;background:var(--surface);border-left:1px solid var(--border);z-index:90;transition:right .3s ease;overflow-y:auto;padding:28px}
.detail-panel.open{right:0}
.detail-panel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.detail-panel-header h2{font-size:16px;font-weight:600}
.panel-close{background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(42,45,62,.5);font-size:13px}
.info-label{color:var(--muted)}
.info-row:last-child{border-bottom:none}
/* Account */
.account-section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;margin-bottom:20px;max-width:600px}
.account-section h3{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}
.copy-group{display:flex;gap:8px;align-items:center}
.copy-group input{flex:1;background:#0f1117;border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;font-family:monospace;outline:none}
.alert-box{padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:12px}
.alert-error{background:#ef444420;border:1px solid #ef4444;color:#ef4444}
.alert-success{background:#22c55e20;border:1px solid #22c55e;color:#22c55e}
</style></head>
<body>

<div class="portal-header">
  <div class="portal-brand">${brand}</div>
  <a href="/portal/login" onclick="signOut(event)">Sign Out</a>
</div>

<div class="stats-bar" id="stats-bar">
  <div class="stat-item"><div class="num" id="s-total">—</div><div class="lbl">Churches</div></div>
  <div class="stat-item"><div class="num" id="s-online">—</div><div class="lbl">Online</div></div>
  <div class="stat-item"><div class="num" id="s-alerts">—</div><div class="lbl">Alerts</div></div>
  <div class="stat-item"><div class="num" id="s-limit">—</div><div class="lbl">Limit</div></div>
</div>

<div class="tabs-bar">
  <div class="tab active" onclick="showTab('fleet',this)">Fleet</div>
  <div class="tab" onclick="showTab('add',this)">Add Church</div>
  <div class="tab" onclick="showTab('account',this)">Account</div>
</div>

<!-- FLEET TAB -->
<div class="tab-content active" id="tab-fleet">
  <table>
    <thead><tr><th>Name</th><th>Status</th><th>ATEM</th><th>OBS</th><th>Companion</th><th>Last Seen</th><th>Actions</th></tr></thead>
    <tbody id="fleet-tbody"><tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
  </table>
</div>

<!-- ADD CHURCH TAB -->
<div class="tab-content" id="tab-add">
  <div class="form-card">
    <h2 style="font-size:15px;font-weight:600;margin-bottom:20px">Register New Church</h2>
    <div id="add-msg"></div>
    <div class="form-field"><label>Church Name</label><input id="ac-name" type="text" placeholder="Grace Community Church"></div>
    <div class="form-field"><label>Contact Email</label><input id="ac-email" type="email" placeholder="td@church.com"></div>
    <div class="form-field"><label>Portal Login Email (optional)</label><input id="ac-portal-email" type="email" placeholder="admin@church.com"></div>
    <div class="form-field"><label>Portal Password (optional)</label><input id="ac-portal-password" type="password" placeholder="At least 8 characters"></div>
    <div style="font-size:12px;color:var(--muted);margin-top:-6px;margin-bottom:10px;">Set both portal fields to create app login credentials now.</div>
    <button class="btn-primary" onclick="addChurch()">Create Registration Code</button>
  </div>
  <div class="success-card" id="add-success" style="display:none">
    <p style="font-size:14px;font-weight:600;margin-bottom:4px" id="add-church-name"></p>
    <p style="font-size:13px;color:var(--muted);margin-bottom:12px">Share this code with your TD. They install the Tally app and enter:</p>
    <div class="reg-code" id="add-reg-code"></div>
    <button class="btn-primary" style="width:100%;margin-top:8px" onclick="copyRegCode()">Copy Code</button>
    <div style="margin-top:12px;font-size:12px;color:var(--muted)">
      <div>Created: <span id="add-created"></span></div>
      <div id="add-portal-created" style="display:none;color:var(--green);margin-top:4px;"></div>
    </div>
  </div>
</div>

<!-- ACCOUNT TAB -->
<div class="tab-content" id="tab-account">
  <div class="account-section">
    <h3>Branding</h3>
    <div id="acct-msg"></div>
    <div class="form-field"><label>Brand Name</label><input id="acct-brand" type="text" value="${brand}"></div>
    <div class="form-field"><label>Support Email</label><input id="acct-email" type="email" value="${reseller.support_email||''}"></div>
    <div class="form-field"><label>Logo URL</label><input id="acct-logo" type="url" value="${reseller.logo_url||''}"></div>
    <div class="form-field"><label>Primary Color</label><input id="acct-color" type="color" value="${color}"></div>
    <button class="btn-primary" onclick="saveAccount()">Save Changes</button>
  </div>
  <div class="account-section">
    <h3>API Key</h3>
    <div class="copy-group">
      <input type="password" id="portal-apikey" value="${reseller.api_key||''}" readonly>
      <button class="btn-sm" onclick="togglePortalApiKey()">Reveal</button>
      <button class="btn-sm" onclick="copyPortalApiKey()">Copy</button>
    </div>
  </div>
  <div class="account-section">
    <h3>Change Portal Password</h3>
    <div id="pw-msg"></div>
    <div class="form-field"><label>Current Password</label><input id="pw-current" type="password" placeholder="Current password"></div>
    <div class="form-field"><label>New Password</label><input id="pw-new" type="password" placeholder="New password"></div>
    <button class="btn-primary" onclick="changePortalPw()">Update Password</button>
  </div>
</div>

<!-- DETAIL PANEL -->
<div class="detail-panel" id="fleet-detail">
  <div class="detail-panel-header">
    <h2 id="fd-name">Church Details</h2>
    <button class="panel-close" onclick="closeFleetDetail()">×</button>
  </div>
  <div id="fd-content"></div>
</div>

<script>
let fleetChurches = [];
let lastRegCode = '';

function showTab(name, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
  el.classList.add('active');
  if (name === 'fleet') loadFleet();
}

async function loadStats() {
  try {
    const r = await fetch('/api/portal/stats');
    const d = await r.json();
    document.getElementById('s-total').textContent = d.churchCount||0;
    document.getElementById('s-online').textContent = d.onlineCount||0;
    document.getElementById('s-alerts').textContent = d.alertCount||0;
    document.getElementById('s-limit').textContent = (d.churchCount||0) + ' / ' + (d.church_limit||0);
  } catch {}
}

async function loadFleet() {
  try {
    const r = await fetch('/api/portal/churches');
    fleetChurches = await r.json();
    renderFleet();
  } catch(e) {
    document.getElementById('fleet-tbody').innerHTML = '<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px">Failed to load fleet</td></tr>';
  }
}

function renderFleet() {
  const tbody = document.getElementById('fleet-tbody');
  if (!fleetChurches.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">No churches yet. Add one in the Fleet tab.</td></tr>';
    return;
  }
  tbody.innerHTML = fleetChurches.map(c => {
    const s = c.status || {};
    const lastSeen = c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'Never';
    return \`<tr>
      <td>\${esc(c.name)}</td>
      <td>\${c.connected ? '<span class="status-dot status-online"></span>Online' : '<span class="status-dot status-offline"></span>Offline'}</td>
      <td>\${s.atem ? '<span class="chip chip-green">OK</span>' : '<span class="chip chip-grey">N/A</span>'}</td>
      <td>\${s.obs ? '<span class="chip chip-green">OK</span>' : '<span class="chip chip-grey">N/A</span>'}</td>
      <td>\${s.companion ? '<span class="chip chip-green">OK</span>' : '<span class="chip chip-grey">N/A</span>'}</td>
      <td>\${lastSeen}</td>
      <td><button class="btn-sm" onclick="openFleetDetail(\${JSON.stringify(c.churchId)})">Details</button></td>
    </tr>\`;
  }).join('');
}

function openFleetDetail(id) {
  const c = fleetChurches.find(x => x.churchId === id);
  if (!c) return;
  const s = c.status || {};
  document.getElementById('fd-name').textContent = c.name;
  document.getElementById('fd-content').innerHTML = \`
    <div class="info-row"><span class="info-label">Status</span><span>\${c.connected ? '<span class="status-dot status-online"></span>Online' : '<span class="status-dot status-offline"></span>Offline'}</span></div>
    <div class="info-row"><span class="info-label">ATEM</span><span>\${s.atem ? '<span class="chip chip-green">Connected</span>' : '<span class="chip chip-grey">N/A</span>'}</span></div>
    <div class="info-row"><span class="info-label">OBS</span><span>\${s.obs ? '<span class="chip chip-green">Connected</span>' : '<span class="chip chip-grey">N/A</span>'}</span></div>
    <div class="info-row"><span class="info-label">Companion</span><span>\${s.companion ? '<span class="chip chip-green">Connected</span>' : '<span class="chip chip-grey">N/A</span>'}</span></div>
    <div class="info-row"><span class="info-label">Last Seen</span><span>\${c.lastSeen ? new Date(c.lastSeen).toLocaleString() : 'Never'}</span></div>
    \${c.registrationCode ? \`<div class="info-row" style="flex-direction:column;gap:6px"><span class="info-label">Registration Code</span><div style="font-family:monospace;font-size:18px;font-weight:700;letter-spacing:3px;color:var(--green)">\${c.registrationCode}</div></div>\` : ''}
    \${c.lastAlert ? \`<div class="info-row"><span class="info-label">Last Alert</span><span style="color:var(--yellow)">\${esc(c.lastAlert)}</span></div>\` : ''}
  \`;
  document.getElementById('fleet-detail').classList.add('open');
}

function closeFleetDetail() { document.getElementById('fleet-detail').classList.remove('open'); }

async function addChurch() {
  const name = document.getElementById('ac-name').value.trim();
  const email = document.getElementById('ac-email').value.trim();
  const portalEmail = document.getElementById('ac-portal-email').value.trim().toLowerCase();
  const portalPassword = document.getElementById('ac-portal-password').value;
  const portalCreatedEl = document.getElementById('add-portal-created');
  if (!name) { showMsg('add-msg', 'Church name required', 'error'); return; }
  if (portalPassword && !portalEmail) { showMsg('add-msg', 'Portal login email is required when password is provided', 'error'); return; }
  if (portalEmail && !portalPassword) { showMsg('add-msg', 'Portal password is required when portal login email is provided', 'error'); return; }
  if (portalPassword && portalPassword.length < 8) { showMsg('add-msg', 'Portal password must be at least 8 characters', 'error'); return; }
  try {
    const r = await fetch('/api/reseller/churches/token', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({churchName: name, contactEmail: email, portalEmail, password: portalPassword})
    });
    const d = await r.json();
    if (!r.ok) { showMsg('add-msg', d.error||'Error', 'error'); return; }
    lastRegCode = d.registrationCode || '';
    document.getElementById('add-church-name').textContent = d.churchName || name;
    document.getElementById('add-reg-code').textContent = lastRegCode;
    document.getElementById('add-created').textContent = new Date().toLocaleString();
    if (d.appLoginCreated && d.portalEmail) {
      portalCreatedEl.textContent = 'Portal login created for ' + d.portalEmail;
      portalCreatedEl.style.display = '';
    } else {
      portalCreatedEl.textContent = '';
      portalCreatedEl.style.display = 'none';
    }
    document.getElementById('add-success').style.display = '';
    document.getElementById('ac-name').value = '';
    document.getElementById('ac-email').value = '';
    document.getElementById('ac-portal-email').value = '';
    document.getElementById('ac-portal-password').value = '';
    document.getElementById('add-msg').innerHTML = '';
    loadStats();
    loadFleet();
  } catch(e) { showMsg('add-msg', 'Request failed', 'error'); }
}

function copyRegCode() {
  navigator.clipboard.writeText(lastRegCode).then(() => alert('Code copied!'));
}

async function saveAccount() {
  const body = {
    brand_name: document.getElementById('acct-brand').value,
    support_email: document.getElementById('acct-email').value,
    logo_url: document.getElementById('acct-logo').value,
    primary_color: document.getElementById('acct-color').value,
  };
  const r = await fetch('/api/reseller/me', {
    method:'PUT', headers:{'Content-Type':'application/json','x-reseller-key':'${reseller.api_key}'},
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (r.ok) showMsg('acct-msg', 'Saved!', 'success');
  else showMsg('acct-msg', d.error||'Error', 'error');
}

let portalApiKeyRevealed = false;
function togglePortalApiKey() {
  const el = document.getElementById('portal-apikey');
  portalApiKeyRevealed = !portalApiKeyRevealed;
  el.type = portalApiKeyRevealed ? 'text' : 'password';
}
function copyPortalApiKey() {
  const el = document.getElementById('portal-apikey');
  const v = el.value;
  navigator.clipboard.writeText(v).then(() => alert('API key copied!'));
}

async function changePortalPw() {
  const current = document.getElementById('pw-current').value;
  const newPw = document.getElementById('pw-new').value;
  if (!current || !newPw) { showMsg('pw-msg', 'Both fields required', 'error'); return; }
  const r = await fetch('/portal/change-password', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({currentPassword: current, newPassword: newPw})
  });
  const d = await r.json();
  if (r.ok) {
    showMsg('pw-msg', 'Password updated', 'success');
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
  } else showMsg('pw-msg', d.error||'Error', 'error');
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = \`<div class="alert-box alert-\${type==='error'?'error':'success'}">\${esc(msg)}</div>\`;
}

async function signOut(e) {
  e.preventDefault();
  await fetch('/portal/logout', {method:'POST'});
  window.location.href = '/portal/login';
}

// Init
loadStats();
loadFleet();
</script>
</body></html>`;
}

// ─── MAIN SETUP ───────────────────────────────────────────────────────────────

function setupAdminPanel(app, db, churches, resellerSystem) {

  // ── Session middleware ────────────────────────────────────────────────────

  function requireAdminSession(req, res, next) {
    // Allow programmatic access via x-api-key or ADMIN_API_KEY query param
    const apiKey = req.headers['x-api-key'] || req.query.apikey || req.query.key;
    if (apiKey && apiKey === (process.env.ADMIN_API_KEY || '')) return next();

    const payload = getSession(req);
    if (payload && payload.role === 'admin') return next();

    const isApi = req.path.startsWith('/api/');
    if (isApi) return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/admin/login');
  }

  function requireResellerSession(req, res, next) {
    const payload = getSession(req);
    if (!payload || payload.role !== 'reseller') {
      const isApi = req.path.startsWith('/api/');
      if (isApi) return res.status(401).json({ error: 'unauthorized' });
      return res.redirect('/portal/login');
    }
    const reseller = resellerSystem.getResellerById(payload.resellerId);
    if (!reseller || !reseller.active) {
      const isApi = req.path.startsWith('/api/');
      if (isApi) return res.status(403).json({ error: 'reseller inactive or not found' });
      return res.redirect('/portal/login');
    }
    req.reseller = reseller;
    next();
  }

  // ── Admin Portal ──────────────────────────────────────────────────────────

  app.get('/admin/login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildAdminLoginHtml(req.query.error));
  });

  app.post('/admin/login', express_urlencoded_middleware, (req, res) => {
    const { email, password } = req.body || {};
    const adminEmail = process.env.ADMIN_EMAIL || '';
    const adminPw = process.env.ADMIN_PASSWORD || '';
    if (email === adminEmail && password === adminPw) {
      const payload = { role: 'admin', exp: Date.now() + 8 * 60 * 60 * 1000 };
      setCookieHeader(res, payload);
      return res.redirect('/admin');
    }
    res.redirect('/admin/login?error=1');
  });

  app.get('/admin', requireAdminSession, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildAdminDashboardHtml());
  });

  app.post('/admin/logout', (req, res) => {
    clearCookieHeader(res);
    res.redirect('/admin/login');
  });

  // ── Admin API ─────────────────────────────────────────────────────────────

  app.get('/api/admin/overview', requireAdminSession, (req, res) => {
    const totalChurches = db.prepare('SELECT COUNT(*) AS cnt FROM churches').get().cnt;
    const totalResellers = db.prepare('SELECT COUNT(*) AS cnt FROM resellers WHERE active=1').get().cnt;
    const onlineNow = Array.from(churches.values()).filter(c => c.ws?.readyState === WebSocket.OPEN).length;
    let activeAlerts = 0;
    try {
      activeAlerts = db.prepare(
        "SELECT COUNT(*) AS cnt FROM alerts WHERE datetime(created_at) > datetime('now','-24 hours')"
      ).get()?.cnt || 0;
    } catch { /* alerts table may not exist */ }
    res.json({ totalChurches, onlineNow, totalResellers, activeAlerts });
  });

  app.get('/api/admin/churches', requireAdminSession, (req, res) => {
    const rows = db.prepare('SELECT * FROM churches').all();
    const list = rows.map(row => {
      const runtime = churches.get(row.churchId);
      return {
        churchId:         row.churchId,
        name:             row.name,
        email:            row.email || '',
        token:            row.token,
        church_type:      row.church_type || 'recurring',
        reseller_id:      row.reseller_id || null,
        registeredAt:     row.registeredAt,
        connected:        runtime?.ws?.readyState === WebSocket.OPEN,
        status:           runtime?.status || { connected: false },
        lastSeen:         runtime?.lastSeen || null,
        registrationCode: row.registration_code || null,
      };
    });
    res.json(list);
  });

  app.post('/api/admin/churches', requireAdminSession, (req, res) => {
    const { name, email, type, resellerId } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const existing = db.prepare('SELECT churchId FROM churches WHERE name = ?').get(name);
    if (existing) return res.status(409).json({ error: `Church "${name}" already exists` });
    try {
      const churchId = uuidv4();
      const jwtSecret = process.env.JWT_SECRET || 'dev-jwt-secret';
      const token = jwt.sign({ churchId, name }, jwtSecret, { expiresIn: '365d' });
      const registeredAt = new Date().toISOString();
      db.prepare(
        'INSERT INTO churches (churchId, name, email, token, registeredAt, church_type, reseller_id) VALUES (?,?,?,?,?,?,?)'
      ).run(churchId, name, email || '', token, registeredAt, type || 'recurring', resellerId || null);
      // Add to in-memory map
      churches.set(churchId, {
        churchId, name, email: email || '', token, ws: null,
        status: { connected: false, atem: null, obs: null },
        lastSeen: null, lastHeartbeat: null, registeredAt, disconnectedAt: null,
        _offlineAlertSent: false, church_type: type || 'recurring',
        event_expires_at: null, event_label: null, reseller_id: resellerId || null,
      });
      res.json({ churchId, name, token, registeredAt });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/admin/churches/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const church = churches.get(id);
    if (!church && !db.prepare('SELECT churchId FROM churches WHERE churchId=?').get(id)) {
      return res.status(404).json({ error: 'Church not found' });
    }
    const { name, email, type, resellerId } = req.body;
    const updates = [];
    const vals = [];
    if (name !== undefined) { updates.push('name=?'); vals.push(name); }
    if (email !== undefined) { updates.push('email=?'); vals.push(email); }
    if (type !== undefined) { updates.push('church_type=?'); vals.push(type); }
    if (resellerId !== undefined) { updates.push('reseller_id=?'); vals.push(resellerId || null); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    db.prepare(`UPDATE churches SET ${updates.join(',')} WHERE churchId=?`).run(...vals);
    if (church) {
      if (name !== undefined) church.name = name;
      if (email !== undefined) church.email = email;
      if (type !== undefined) church.church_type = type;
      if (resellerId !== undefined) church.reseller_id = resellerId || null;
    }
    res.json({ updated: true });
  });

  app.post('/api/admin/churches/:id/token', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM churches WHERE churchId=?').get(id);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    try {
      const jwtSecret = process.env.JWT_SECRET || 'dev-jwt-secret';
      const token = jwt.sign({ churchId: id, name: row.name }, jwtSecret, { expiresIn: '365d' });
      db.prepare('UPDATE churches SET token=? WHERE churchId=?').run(token, id);
      const church = churches.get(id);
      if (church) church.token = token;
      res.json({ token });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/admin/churches/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM churches WHERE churchId=?').get(id);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    const church = churches.get(id);
    if (church?.ws?.readyState === WebSocket.OPEN) church.ws.close(1000, 'deleted by admin');
    db.prepare('DELETE FROM churches WHERE churchId=?').run(id);
    churches.delete(id);
    res.json({ deleted: true, name: row.name });
  });

  app.put('/api/admin/resellers/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = resellerSystem.getResellerById(id);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    const allowed = ['name', 'brand_name', 'support_email', 'logo_url', 'primary_color', 'church_limit', 'active'];
    // Map camelCase from request body to snake_case
    const map = { brandName: 'brand_name', supportEmail: 'support_email', logoUrl: 'logo_url', primaryColor: 'primary_color', churchLimit: 'church_limit' };
    const patch = {};
    for (const [k, v] of Object.entries(req.body)) {
      const key = map[k] || k;
      if (allowed.includes(key)) patch[key] = v;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    try {
      const fields = Object.keys(patch);
      const setClauses = fields.map(f => `${f}=?`).join(',');
      const vals = [...fields.map(f => patch[f]), id];
      db.prepare(`UPDATE resellers SET ${setClauses} WHERE id=?`).run(...vals);
      res.json({ updated: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/resellers/:id/password', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = resellerSystem.getResellerById(id);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'password required' });
    // Ensure column exists
    try { db.exec('ALTER TABLE resellers ADD COLUMN portal_password TEXT'); } catch {}
    const hashed = hashPortalPassword(password);
    db.prepare('UPDATE resellers SET portal_password=? WHERE id=?').run(hashed, id);
    res.json({ updated: true });
  });

  app.delete('/api/admin/resellers/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = resellerSystem.getResellerById(id);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    db.prepare('UPDATE resellers SET active=0 WHERE id=?').run(id);
    res.json({ deactivated: true });
  });

  app.post('/api/admin/change-password', requireAdminSession, (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    // Note: This updates the ENV var at runtime (process.env) but won't persist across restarts.
    // For persistence, user must update .env file.
    process.env.ADMIN_PASSWORD = password;
    res.json({ updated: true, note: 'Password changed for this session. Update .env to persist.' });
  });

  // ── Reseller Portal ───────────────────────────────────────────────────────

  app.get('/portal/login', (req, res) => {
    const { error, slug } = req.query;
    let brand = null;
    if (slug) {
      const r = resellerSystem.getResellerBySlug(slug);
      if (r) brand = r.brand_name || 'Tally Partner Portal';
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPortalLoginHtml(error, brand));
  });

  app.post('/portal/login', express_urlencoded_middleware, (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.redirect('/portal/login?error=1');
    // Find reseller by support_email
    const reseller = db.prepare('SELECT * FROM resellers WHERE support_email=? AND active=1').get(email);
    if (!reseller) return res.redirect('/portal/login?error=1');
    // Ensure portal_password column
    try { db.exec('ALTER TABLE resellers ADD COLUMN portal_password TEXT'); } catch {}
    if (!reseller.portal_password) {
      return res.redirect('/portal/login?error=nopw');
    }
    if (!verifyPortalPassword(password, reseller.portal_password)) return res.redirect('/portal/login?error=1');
    // Transparently upgrade legacy SHA-256 hash to scrypt on successful login
    if (!reseller.portal_password.includes(':')) {
      const upgraded = hashPortalPassword(password);
      db.prepare('UPDATE resellers SET portal_password=? WHERE id=?').run(upgraded, reseller.id);
    }
    const payload = { role: 'reseller', resellerId: reseller.id, exp: Date.now() + 8 * 60 * 60 * 1000 };
    setCookieHeader(res, payload);
    res.redirect('/portal');
  });

  app.get('/portal', requireResellerSession, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildPortalHtml(req.reseller));
  });

  app.post('/portal/logout', (req, res) => {
    clearCookieHeader(res);
    res.redirect('/portal/login');
  });

  app.post('/portal/change-password', requireResellerSession, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short (min 6 chars)' });
    const reseller = req.reseller;
    if (!verifyPortalPassword(currentPassword, reseller.portal_password)) return res.status(403).json({ error: 'Current password incorrect' });
    const newHashed = hashPortalPassword(newPassword);
    db.prepare('UPDATE resellers SET portal_password=? WHERE id=?').run(newHashed, reseller.id);
    res.json({ updated: true });
  });

  // ── Reseller Portal API ───────────────────────────────────────────────────

  app.get('/api/portal/churches', requireResellerSession, (req, res) => {
    const rows = db.prepare('SELECT * FROM churches WHERE reseller_id=?').all(req.reseller.id);
    const list = rows.map(row => {
      const runtime = churches.get(row.churchId);
      return {
        churchId:         row.churchId,
        name:             row.name,
        connected:        runtime?.ws?.readyState === WebSocket.OPEN,
        status:           runtime?.status || null,
        lastSeen:         runtime?.lastSeen || null,
        registrationCode: row.registration_code || null,
        lastAlert:        null, // could be populated from alerts table if needed
      };
    });
    res.json(list);
  });

  app.get('/api/portal/stats', requireResellerSession, (req, res) => {
    try {
      const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
      res.json(stats);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

// Inline URL-encoded body parser (avoids requiring extra middleware for login forms)
function express_urlencoded_middleware(req, res, next) {
  if (req.body && typeof req.body === 'object') return next(); // already parsed
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    try {
      req.body = Object.fromEntries(new URLSearchParams(data));
    } catch { req.body = {}; }
    next();
  });
}

module.exports = { setupAdminPanel };
