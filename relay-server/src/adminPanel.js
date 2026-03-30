'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');

const COOKIE_NAME = 'tally_session';
const COOKIE_MAX_AGE = 7200; // 2 hours in seconds

function safeErrorMessage(err, fallback = 'Internal server error') {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}

// ─── SESSION HELPERS ──────────────────────────────────────────────────────────

function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    throw new Error('[CONFIG] SESSION_SECRET environment variable is required. Set a strong random secret (e.g. openssl rand -hex 32).');
  }
  return s;
}

function signSession(payload) {
  const secret = getSessionSecret();
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
  const secret = getSessionSecret();
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
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${secure}`);
}

function clearCookieHeader(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`);
}

// Legacy SHA-256 hash (for verifying old stored hashes)
function hashPortalPasswordLegacy(password) {
  const secret = getSessionSecret();
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

// ─── SERVER-SIDE HELPERS ─────────────────────────────────────────────────────

/** HTML-escape for server-side template interpolation (prevents XSS in rendered HTML) */
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Sanitize a CSS color value — only allow valid hex, rgb(), hsl(), or named colors */
function sanitizeColor(c) {
  const s = String(c || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^(rgb|hsl)a?\(\s*[\d\s%,.\/]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{1,30}$/.test(s)) return s;
  return '#22c55e'; // fallback to default green
}

// ─── HTML: ADMIN LOGIN ────────────────────────────────────────────────────────

function buildAdminLoginHtml(error) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tally Admin — Sign In</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#09090B;--surface:#0F1613;--border:#1a2e1f;--green:#22c55e;--red:#ef4444;--text:#F8FAFC;--muted:#94A3B8}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:40px;width:100%;max-width:380px}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:32px;justify-content:center}
.dot{width:12px;height:12px;background:var(--green);border-radius:50%;box-shadow:0 0 12px var(--green)}
.logo-text{font-size:22px;font-weight:700;letter-spacing:-0.5px}
h1{font-size:18px;font-weight:600;margin-bottom:24px;text-align:center;color:var(--muted)}
.field{margin-bottom:16px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-size:14px;outline:none;transition:border-color .2s}
input:focus{border-color:var(--green)}
.btn{width:100%;background:var(--green);color:#09090B;border:none;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px;transition:opacity .2s}
.btn:hover{opacity:.9}
.error{background:#ef444420;border:1px solid #ef4444;color:#ef4444;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:16px;text-align:center}
</style></head>
<body><div class="card">
<div class="logo"><div class="dot"></div><span class="logo-text">Tally Admin</span></div>
<h1>Sign in to your account</h1>
${error ? '<div class="error">Invalid email or password</div>' : ''}
<form method="POST" action="/admin/login">
<div class="field"><label>Email</label><input type="email" name="email" placeholder="admin@tallyconnect.app" required autocomplete="email"></div>
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
:root{--bg:#09090B;--surface:#0F1613;--border:#1a2e1f;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--text:#F8FAFC;--muted:#94A3B8;--dim:#475569}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif;display:flex;height:100vh;overflow:hidden}
.sidebar{width:220px;min-width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:0;position:fixed;top:0;left:0;bottom:0;z-index:10}
.sidebar-logo{display:flex;align-items:center;gap:10px;padding:24px 20px;border-bottom:1px solid var(--border)}
.dot{width:10px;height:10px;background:var(--green);border-radius:50%;box-shadow:0 0 8px var(--green)}
.sidebar-logo span{font-size:16px;font-weight:700}
.nav{flex:1;padding:12px 0;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 20px;cursor:pointer;border-radius:0;color:var(--muted);font-size:13px;transition:all .15s;user-select:none;border:none;background:none;width:100%;text-align:left}
.nav-item:hover{color:var(--text);background:rgba(34,197,94,.06)}
.nav-item.active{color:var(--green);background:rgba(34,197,94,.08);border-right:2px solid var(--green)}
.nav-item svg{width:16px;height:16px;flex-shrink:0}
.nav-divider{padding:12px 20px 6px;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);font-weight:600}
.sidebar-footer{padding:16px 20px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
.sidebar-footer a{color:var(--red);text-decoration:none;font-size:12px}
.sidebar-footer a:hover{text-decoration:underline}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;margin-left:220px}
.header{padding:16px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface)}
.header-title{font-size:15px;font-weight:600}
.header-right{display:flex;align-items:center;gap:16px;font-size:13px;color:var(--muted)}
.content{flex:1;overflow-y:auto;padding:28px}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;text-align:center}
.stat-card.highlight{border-color:var(--green)}
.stat-num{font-size:28px;font-weight:700;color:var(--green);margin-bottom:4px}
.stat-label{font-size:12px;color:var(--muted)}
/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;margin-bottom:20px}
.card-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}
/* Tables */
.table-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:12px;flex-wrap:wrap}
.search-input{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 14px;color:var(--text);font-size:13px;outline:none;width:240px}
.search-input:focus{border-color:var(--green)}
.filter-tabs{display:flex;gap:4px}
.filter-tab{padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border);color:var(--muted);background:transparent;transition:all .15s}
.filter-tab.active{background:var(--green);color:#000;border-color:var(--green);font-weight:600}
.btn-primary{background:var(--green);color:#09090B;border:none;border-radius:7px;padding:9px 20px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn-primary:hover{opacity:.85}
.btn-secondary{background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:7px;padding:9px 20px;font-size:13px;cursor:pointer;transition:all .15s}
.btn-secondary:hover{border-color:var(--green);color:var(--green)}
.btn-danger{background:transparent;color:#f87171;border:1px solid rgba(239,68,68,.3);border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer}
.btn-danger:hover{background:rgba(239,68,68,.1)}
.btn-sm{padding:5px 10px;font-size:11px;border-radius:6px;cursor:pointer;border:1px solid rgba(34,197,94,.3);background:transparent;color:var(--green);transition:all .15s}
.btn-sm:hover{background:rgba(34,197,94,.1)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:0 0 10px;font-size:11px;color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border)}
td{padding:10px 0;font-size:13px;border-bottom:1px solid rgba(26,46,31,.5);vertical-align:middle}
tr:hover td{background:rgba(34,197,94,.02)}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
.status-online{background:var(--green);box-shadow:0 0 5px var(--green)}
.status-offline{background:var(--muted)}
.color-swatch{display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:middle;margin-right:4px;border:1px solid rgba(255,255,255,.15)}
/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:500}
.badge-green{background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.2)}
.badge-yellow{background:rgba(234,179,8,.1);color:var(--yellow);border:1px solid rgba(234,179,8,.2)}
.badge-red{background:rgba(239,68,68,.1);color:#f87171;border:1px solid rgba(239,68,68,.2)}
.badge-gray{background:rgba(148,163,184,.1);color:var(--muted);border:1px solid rgba(148,163,184,.2)}
.church-name-link{color:var(--text);cursor:pointer;text-decoration:none}
.church-name-link:hover{color:var(--green);text-decoration:underline}
/* Help box */
.help-box{background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.15);border-radius:8px;padding:12px 16px;color:var(--muted);font-size:13px;line-height:1.6;margin-bottom:16px}
.help-box strong{color:var(--text)}
/* Toast */
#toast{position:fixed;bottom:24px;right:24px;background:var(--surface);border:1px solid var(--green);color:var(--green);padding:12px 20px;border-radius:8px;font-size:13px;opacity:0;transform:translateY(10px);transition:all .2s;pointer-events:none;z-index:999}
#toast.show{opacity:1;transform:translateY(0)}
#toast.error{border-color:var(--red);color:#f87171}
/* Activity feed */
.activity-item{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid rgba(26,46,31,.5);font-size:13px;align-items:flex-start}
.activity-item:last-child{border-bottom:none}
.activity-dot{width:8px;height:8px;border-radius:50%;margin-top:5px;flex-shrink:0}
.activity-time{color:var(--dim);font-size:11px;white-space:nowrap}
/* Modals */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto}
.modal h2{font-size:16px;font-weight:600;margin-bottom:20px}
.form-field{margin-bottom:16px}
.form-field label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
.form-field input,.form-field select{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:13px;outline:none;font-family:inherit}
.form-field input:focus,.form-field select:focus{border-color:var(--green)}
.form-field select option{background:var(--surface)}
.modal-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}
.modal-close{position:absolute;top:16px;right:16px;background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;line-height:1}
.modal-close:hover{color:var(--text)}
/* Slide-in panel */
.detail-panel{position:fixed;right:-660px;top:0;height:100vh;width:640px;background:var(--surface);border-left:1px solid var(--border);z-index:90;transition:right .3s ease;overflow-y:auto;padding:28px}
.detail-panel.open{right:0}
.detail-panel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}
.detail-panel-header h2{font-size:16px;font-weight:600}
.detail-section{margin-bottom:20px}
.detail-section-title{font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
.detail-grid .dg-label{font-size:11px;color:var(--dim)}
.detail-grid .dg-value{font-size:13px;color:var(--text);word-break:break-all}
.detail-chips{display:flex;flex-wrap:wrap;gap:6px}
.detail-chip{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500}
.detail-chip.on{background:rgba(34,197,94,.1);color:var(--green);border:1px solid rgba(34,197,94,.2)}
.detail-chip.off{background:rgba(148,163,184,.08);color:var(--dim);border:1px solid rgba(148,163,184,.15)}
.detail-mini-table{width:100%;font-size:12px;border-collapse:collapse}
.detail-mini-table th{text-align:left;padding:4px 6px;font-size:10px;color:var(--dim);font-weight:500;text-transform:uppercase;border-bottom:1px solid var(--border)}
.detail-mini-table td{padding:5px 6px;border-bottom:1px solid rgba(26,46,31,.3);color:var(--muted)}
.detail-checklist{display:flex;flex-direction:column;gap:6px}
.detail-check-item{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.detail-check-item .check-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.detail-check-item .check-dot.done{background:var(--green);box-shadow:0 0 4px var(--green)}
.detail-check-item .check-dot.pending{background:var(--dim)}
.health-badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.health-badge.excellent{background:rgba(34,197,94,.15);color:var(--green)}
.health-badge.good{background:rgba(34,197,94,.1);color:#86efac}
.health-badge.fair{background:rgba(234,179,8,.1);color:var(--yellow)}
.health-badge.poor{background:rgba(239,68,68,.1);color:#f87171}
.detail-chat{max-height:200px;overflow-y:auto;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
.detail-chat-msg{font-size:12px;line-height:1.4}
.detail-chat-msg .sender{font-weight:600;color:var(--green);margin-right:4px}
.detail-chat-msg .time{font-size:10px;color:var(--dim);margin-left:6px}
.detail-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.panel-close{background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer}
.panel-close:hover{color:var(--text)}
.info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(26,46,31,.5);font-size:13px}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:500;margin:2px}
.chip-green{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
.chip-grey{background:rgba(107,114,128,.15);color:var(--muted);border:1px solid rgba(107,114,128,.3)}
.chip-yellow{background:rgba(234,179,8,.15);color:var(--yellow);border:1px solid rgba(234,179,8,.3)}
.token-box{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-family:'Courier New',monospace;font-size:11px;word-break:break-all;margin-top:8px;position:relative}
.copy-btn{background:var(--green);color:#000;border:none;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;margin-top:6px}
/* Settings */
.settings-section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:24px;margin-bottom:20px}
code{font-family:'Courier New',monospace;font-size:12px;background:rgba(255,255,255,.06);padding:1px 5px;border-radius:4px;color:var(--text)}
.settings-section h3{font-size:11px;font-weight:600;margin-bottom:16px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.settings-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(26,46,31,.5);font-size:13px}
.settings-row:last-child{border-bottom:none}
.masked{font-family:monospace;letter-spacing:2px}
/* Alerts */
.alert-box{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:16px}
.alert-error{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.3);color:#f87171}
.alert-success{background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);color:var(--green)}
/* Copy input */
.copy-group{display:flex;gap:8px;align-items:center}
.copy-group input{flex:1;font-family:monospace;font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);outline:none}
/* Summary cards row */
.summary-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
#ai-summary{grid-template-columns:repeat(5,1fr)}
#email-summary{grid-template-columns:repeat(3,1fr)}
.summary-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;text-align:center}
.summary-card .num{font-size:22px;font-weight:700;color:var(--text)}
.summary-card .lbl{font-size:11px;color:var(--muted);margin-top:2px}
/* Hamburger menu */
.hamburger{display:none;position:fixed;top:14px;left:14px;z-index:110;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 10px;cursor:pointer;color:var(--text);font-size:20px;line-height:1}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99}
/* Stream Preview */
@keyframes pulse-live{0%,100%{opacity:1}50%{opacity:.5}}
@media(max-width:768px){
  .sidebar{display:none;position:fixed;z-index:100;top:0;left:0;height:100vh;width:220px}
  .sidebar.open{display:flex;flex-direction:column}
  .sidebar-overlay.open{display:block}
  .hamburger{display:block}
  .main{margin-left:0;padding-top:56px}
  .stats-grid,.summary-row{grid-template-columns:1fr 1fr}
  #ai-summary,#email-summary{grid-template-columns:1fr 1fr}
  .stream-layout{grid-template-columns:1fr !important}
}
</style></head>
<body>

<button class="hamburger" onclick="toggleMobileNav()" aria-label="Menu"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg></button>
<div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleMobileNav()"></div>

<!-- SIDEBAR -->
<div class="sidebar" id="admin-sidebar">
  <div class="sidebar-logo">
    <div class="dot"></div>
    <span>Tally Admin</span>
  </div>
  <nav class="nav">
    <div class="nav-item active" onclick="showPage('overview')" id="nav-overview">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"/></svg>
      Overview
    </div>
    <div class="nav-item" onclick="showPage('churches')" id="nav-churches">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 21h16.5M4.5 3h15M5.25 3v18m13.5-18v18M9 6.75h1.5m-1.5 3h1.5m-1.5 3h1.5m3-6H15m-1.5 3H15m-1.5 3H15M9 21v-3.375c0-.621.504-1.125 1.125-1.125h3.75c.621 0 1.125.504 1.125 1.125V21"/></svg>
      Churches
    </div>
    <div class="nav-item" onclick="showPage('resellers')" id="nav-resellers">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z"/></svg>
      Resellers
    </div>
    <div class="nav-divider">Operations</div>
    <div class="nav-item" onclick="showPage('alerts')" id="nav-alerts">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>
      Alerts
    </div>
    <div class="nav-item" onclick="showPage('tickets')" id="nav-tickets">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"/></svg>
      Tickets
    </div>
    <div class="nav-item" onclick="showPage('billing')" id="nav-billing">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z"/></svg>
      Billing
    </div>
    <div class="nav-item" onclick="showPage('aiusage')" id="nav-aiusage">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z"/></svg>
      AI Usage
    </div>
    <div class="nav-item" onclick="showPage('emails')" id="nav-emails">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"/></svg>
      Emails
    </div>
    <div class="nav-item" onclick="showPage('streams')" id="nav-streams">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>
      Stream Preview
    </div>
    <div class="nav-item" onclick="showPage('auditlog')" id="nav-auditlog">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z"/></svg>
      Audit Log
    </div>
    <div style="flex:1"></div>
    <div class="nav-item" onclick="showPage('settings')" id="nav-settings">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>
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
        <div class="stat-card highlight"><div class="stat-num" id="stat-online">—</div><div class="stat-label">Online Now</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-resellers">—</div><div class="stat-label">Total Resellers</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-tickets">—</div><div class="stat-label">Open Tickets</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-alerts">—</div><div class="stat-label">Active Alerts (24h)</div></div>
        <div class="stat-card"><div class="stat-num" id="stat-mrr">—</div><div class="stat-label">MRR</div></div>
      </div>
      <div class="card">
        <div class="card-title">Recent Activity</div>
        <div id="activity-feed"><div style="color:var(--muted);font-size:13px;padding:12px 0">Loading recent activity...</div></div>
      </div>
      <div style="color:var(--muted);font-size:12px;margin-top:8px" id="overview-status">Loading overview data...</div>
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
          <th>Name</th><th>Reseller</th><th>Status</th><th>Type</th><th>Rooms</th><th>Registered</th><th>Last Seen</th><th>Actions</th>
        </tr></thead>
        <tbody id="churches-tbody"><tr><td colspan="8" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
      <div id="churches-pagination" style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;font-size:13px;color:var(--muted)">
        <span id="churches-count"></span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn-secondary" id="churches-prev" onclick="churchesChangePage(-1)" style="padding:5px 12px;font-size:12px;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg> Prev</button>
          <span id="churches-page-label"></span>
          <button class="btn-secondary" id="churches-next" onclick="churchesChangePage(1)" style="padding:5px 12px;font-size:12px;display:flex;align-items:center;gap:4px">Next <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg></button>
        </div>
      </div>
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
        <div class="form-field"><label>Current Password</label><input type="password" id="current-pw" placeholder="Current password"></div>
        <div class="form-field"><label>New Password</label><input type="password" id="new-pw" placeholder="New password (min 8 chars)"></div>
        <button class="btn-primary" onclick="changeAdminPassword(this)">Change Password</button>
      </div>
      <div class="settings-section">
        <h3>Admin API Key</h3>
        <div class="help-box">API keys are stored in Railway environment variables (<code>ADMIN_API_KEY</code>) and are not exposed through the browser for security.</div>
      </div>
    </div>

    <!-- ALERTS PAGE -->
    <div id="page-alerts" style="display:none">
      <div class="table-toolbar">
        <div style="display:flex;gap:10px;align-items:center">
          <input class="search-input" id="alert-search" placeholder="Search by church..." oninput="filterAlerts()">
          <div class="filter-tabs">
            <button class="filter-tab active" onclick="setAlertFilter('all',this)">All</button>
            <button class="filter-tab" onclick="setAlertFilter('critical',this)">Critical</button>
            <button class="filter-tab" onclick="setAlertFilter('warning',this)">Warning</button>
            <button class="filter-tab" onclick="setAlertFilter('info',this)">Info</button>
          </div>
        </div>
        <div class="filter-tabs">
          <button class="filter-tab active" onclick="setAlertAckFilter('unack',this)">Unacknowledged</button>
          <button class="filter-tab" onclick="setAlertAckFilter('all',this)">All</button>
        </div>
      </div>
      <table id="alerts-table">
        <thead><tr>
          <th>Time</th><th>Church</th><th>Room</th><th>Type</th><th>Severity</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="alerts-tbody"><tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
    </div>

    <!-- TICKETS PAGE -->
    <div id="page-tickets" style="display:none">
      <div class="table-toolbar">
        <div style="display:flex;gap:10px;align-items:center">
          <input class="search-input" id="ticket-search" placeholder="Search tickets..." oninput="filterTickets()">
          <div class="filter-tabs" id="ticket-status-tabs">
            <button class="filter-tab active" onclick="setTicketFilter('all',this)">All</button>
            <button class="filter-tab" onclick="setTicketFilter('open',this)">Open</button>
            <button class="filter-tab" onclick="setTicketFilter('in_progress',this)">In Progress</button>
            <button class="filter-tab" onclick="setTicketFilter('resolved',this)">Resolved</button>
          </div>
        </div>
      </div>
      <table id="tickets-table">
        <thead><tr>
          <th>Created</th><th>Church</th><th>Severity</th><th>Category</th><th>Title</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody id="tickets-tbody"><tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
    </div>

    <!-- AI USAGE PAGE -->
    <div id="page-aiusage" style="display:none">
      <div class="table-toolbar" style="margin-bottom:16px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <span style="color:var(--muted);font-size:13px">Date Range:</span>
          <input type="date" class="search-input" id="ai-date-from" style="width:150px" title="From date">
          <span style="color:var(--muted)">to</span>
          <input type="date" class="search-input" id="ai-date-to" style="width:150px" title="To date">
          <button class="btn-primary" onclick="loadAIUsage()" style="padding:7px 16px">Apply</button>
          <button class="btn-secondary" onclick="clearAIDateRange()" style="padding:7px 12px;font-size:12px">Reset (30d)</button>
        </div>
      </div>
      <div class="summary-row" id="ai-summary">
        <div class="summary-card"><div class="stat-num" id="ai-requests">—</div><div class="stat-label">Requests (30d)</div></div>
        <div class="summary-card"><div class="stat-num" id="ai-input-tok">—</div><div class="stat-label">Input Tokens</div></div>
        <div class="summary-card"><div class="stat-num" id="ai-output-tok">—</div><div class="stat-label">Output Tokens</div></div>
        <div class="summary-card highlight"><div class="stat-num" id="ai-cost">—</div><div class="stat-label">Est. Cost (30d)</div></div>
        <div class="summary-card"><div class="stat-num" id="ai-cache">—</div><div class="stat-label">Cache Hits</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-title">Usage by Church</div>
          <table><thead><tr><th>Church</th><th>Requests</th><th>Input Tok</th><th>Output Tok</th><th>Cost</th></tr></thead>
          <tbody id="ai-by-church"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody></table>
        </div>
        <div class="card">
          <div class="card-title">Usage by Feature</div>
          <table><thead><tr><th>Feature</th><th>Requests</th><th>Input Tok</th><th>Output Tok</th><th>Cost</th></tr></thead>
          <tbody id="ai-by-feature"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody></table>
        </div>
      </div>
    </div>

    <!-- BILLING PAGE -->
    <div id="page-billing" style="display:none">
      <div class="summary-row" id="billing-summary">
        <div class="summary-card"><div class="stat-num" id="billing-mrr">—</div><div class="stat-label">Monthly Revenue</div></div>
        <div class="summary-card"><div class="stat-num" id="billing-active">—</div><div class="stat-label">Active</div></div>
        <div class="summary-card"><div class="stat-num" id="billing-past-due">—</div><div class="stat-label">Past Due</div></div>
        <div class="summary-card"><div class="stat-num" id="billing-free">—</div><div class="stat-label">Free (Connect)</div></div>
      </div>
      <div class="card">
        <div class="card-title">Subscriptions</div>
        <table id="billing-table">
          <thead><tr>
            <th>Church</th><th>Plan</th><th>Interval</th><th>Status</th><th>Period End</th><th>Actions</th>
          </tr></thead>
          <tbody id="billing-tbody"><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>

    <!-- EMAILS PAGE -->
    <div id="page-emails" style="display:none">
      <div class="summary-row" id="email-summary">
        <div class="summary-card"><div class="stat-num" id="email-total">—</div><div class="stat-label">Total Sent</div></div>
        <div class="summary-card"><div class="stat-num" id="email-today">—</div><div class="stat-label">Sent Today</div></div>
        <div class="summary-card"><div class="stat-num" id="email-week">—</div><div class="stat-label">This Week</div></div>
      </div>

      <div class="filter-tabs" id="email-sub-tabs" style="margin-bottom:16px">
        <button class="filter-tab active" onclick="showEmailTab('history',this)">Send History</button>
        <button class="filter-tab" onclick="showEmailTab('templates',this)">Templates</button>
        <button class="filter-tab" onclick="showEmailTab('custom',this)">Send Custom</button>
      </div>

      <!-- History Sub-tab -->
      <div id="email-tab-history">
        <div class="table-toolbar">
          <div style="display:flex;gap:10px;align-items:center">
            <select id="email-type-filter" class="search-input" style="width:200px" onchange="loadEmailHistory()">
              <option value="">All Types</option>
            </select>
            <input class="search-input" id="email-search" placeholder="Search by church..." oninput="loadEmailHistory()">
          </div>
        </div>
        <table id="emails-table">
          <thead><tr>
            <th>Sent</th><th>Church</th><th>Type</th><th>Recipient</th><th>Subject</th><th>Actions</th>
          </tr></thead>
          <tbody id="emails-tbody"><tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
        </table>
        <div style="text-align:center;padding:16px">
          <button class="btn-secondary" id="email-load-more" onclick="loadMoreEmails()" style="display:none">Load More</button>
        </div>
      </div>

      <!-- Templates Sub-tab -->
      <div id="email-tab-templates" style="display:none">
        <div id="templates-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
          <div style="color:var(--muted);text-align:center;padding:24px">Loading templates...</div>
        </div>
      </div>

      <!-- Send Custom Sub-tab -->
      <div id="email-tab-custom" style="display:none">
        <div class="card" style="max-width:640px">
          <div class="card-title">Compose Email</div>
          <div id="custom-email-msg"></div>
          <div class="form-field">
            <label>Recipient</label>
            <div style="display:flex;gap:8px">
              <select id="custom-church-select" class="search-input" style="flex:1" onchange="onCustomChurchSelect()">
                <option value="">— Select a church —</option>
              </select>
              <span style="color:var(--muted);line-height:36px">or</span>
              <input id="custom-email-to" class="search-input" style="flex:1" placeholder="email@example.com">
            </div>
          </div>
          <div class="form-field">
            <label>Subject</label>
            <input id="custom-email-subject" type="text" placeholder="Email subject line">
          </div>
          <div class="form-field">
            <label>HTML Body</label>
            <textarea id="custom-email-html" rows="12" style="font-family:monospace;font-size:12px;width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:12px;resize:vertical"></textarea>
          </div>
          <div style="display:flex;gap:10px;margin-top:16px">
            <button class="btn-secondary" onclick="previewCustomEmail()">Preview</button>
            <button class="btn-primary" onclick="sendCustomEmail(this)">Send Email</button>
          </div>
        </div>
      </div>
    </div>

    <!-- STREAM PREVIEW PAGE -->
    <div id="page-streams" style="display:none">
      <div class="stream-toolbar" style="display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap">
        <select id="stream-church-select" class="search-input" style="width:280px" onchange="onStreamChurchSelect()">
          <option value="">— Select a church —</option>
        </select>
        <select id="stream-room-select" class="search-input" style="width:200px;display:none" onchange="onStreamRoomSelect()">
          <option value="">All Rooms</option>
        </select>
        <div id="stream-live-badge" style="display:none;background:#e53e3e;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.5px;animation:pulse-live 1.5s ease-in-out infinite">LIVE</div>
        <div id="stream-offline-badge" style="display:none;background:var(--border);color:var(--muted);font-size:11px;font-weight:600;padding:3px 10px;border-radius:12px">OFFLINE</div>
        <div style="flex:1"></div>
        <span id="stream-active-count" style="color:var(--muted);font-size:13px"></span>
      </div>

      <div class="stream-layout" style="display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:start">
        <!-- Video Player -->
        <div>
          <div class="stream-player-wrap" style="position:relative;width:100%;padding-top:56.25%;background:#000;border-radius:10px;overflow:hidden">
            <video id="stream-video" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain" autoplay muted playsinline></video>
            <div id="stream-placeholder" style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px">
              Select a church to preview their stream
            </div>
          </div>

          <!-- Stream Key Info Card -->
          <div id="stream-key-card" class="card" style="margin-top:16px;display:none">
            <div class="card-title" style="margin-bottom:12px">RTMP Ingest Details</div>
            <div style="display:grid;grid-template-columns:auto 1fr auto;gap:8px 12px;align-items:center;font-size:13px">
              <span style="color:var(--muted)">RTMP URL</span>
              <code id="stream-rtmp-url" style="background:var(--bg);padding:6px 10px;border-radius:6px;font-size:12px;word-break:break-all"></code>
              <button class="btn-sm" onclick="copyStreamUrl()" title="Copy">Copy</button>

              <span style="color:var(--muted)">Stream Key</span>
              <code id="stream-key-display" style="background:var(--bg);padding:6px 10px;border-radius:6px;font-size:12px;font-family:monospace"></code>
              <button class="btn-sm" onclick="copyStreamKey()" title="Copy">Copy</button>
            </div>
            <div style="margin-top:12px;display:flex;gap:8px">
              <button class="btn-sm" onclick="regenerateStreamKey()" style="color:var(--red)">Regenerate Key</button>
            </div>
          </div>
        </div>

        <!-- Tally / Equipment Status Sidebar -->
        <div id="stream-status-panel" style="display:none">
          <div class="card" style="margin-bottom:12px">
            <div class="card-title" style="margin-bottom:10px">Equipment Status</div>
            <div id="stream-equipment-list" style="font-size:13px">
              <div style="color:var(--muted);padding:12px 0;text-align:center">No data yet</div>
            </div>
          </div>

          <div class="card" style="margin-bottom:12px">
            <div class="card-title" style="margin-bottom:10px">Tally Indicators</div>
            <div id="stream-tally-indicators" style="display:flex;flex-wrap:wrap;gap:6px">
              <div style="color:var(--muted);font-size:13px;padding:8px 0">No tally data</div>
            </div>
          </div>

          <div class="card">
            <div class="card-title" style="margin-bottom:10px">Stream Info</div>
            <div id="stream-meta-info" style="font-size:13px">
              <div style="color:var(--muted);padding:8px 0">Stream not active</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- AUDIT LOG PAGE -->
    <div id="page-auditlog" style="display:none">
      <div class="table-toolbar" style="flex-wrap:wrap;gap:10px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <select id="audit-action-filter" class="search-input" style="width:180px">
            <option value="">All Actions</option>
          </select>
          <input class="search-input" id="audit-email-search" placeholder="Admin email..." style="width:200px">
          <input type="date" class="search-input" id="audit-date-from" style="width:150px" title="From date">
          <input type="date" class="search-input" id="audit-date-to" style="width:150px" title="To date">
          <button class="btn-primary" onclick="loadAuditLog(1)" style="padding:7px 16px">Search</button>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted);cursor:pointer">
            <input type="checkbox" id="audit-auto-refresh" onchange="toggleAuditAutoRefresh()"> Auto-refresh
          </label>
        </div>
      </div>
      <table id="auditlog-table">
        <thead><tr>
          <th>Timestamp</th><th>Admin</th><th>Action</th><th>Details</th><th>IP Address</th>
        </tr></thead>
        <tbody id="auditlog-tbody"><tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">Loading...</td></tr></tbody>
      </table>
      <div id="auditlog-pagination" style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;font-size:13px;color:var(--muted)">
        <span id="auditlog-count"></span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="btn-secondary" id="auditlog-prev" onclick="auditLogChangePage(-1)" style="padding:5px 12px;font-size:12px;display:flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5"/></svg> Prev</button>
          <span id="auditlog-page-label"></span>
          <button class="btn-secondary" id="auditlog-next" onclick="auditLogChangePage(1)" style="padding:5px 12px;font-size:12px;display:flex;align-items:center;gap:4px">Next <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg></button>
        </div>
      </div>
    </div>

  </div>
</div>

<!-- EMAIL PREVIEW MODAL -->
<div class="modal-overlay" id="modal-email-preview">
  <div class="modal" style="max-width:700px;max-height:90vh;overflow:auto;position:relative">
    <button class="modal-close" onclick="closeModal('modal-email-preview')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
    <h2 id="email-preview-title">Email Preview</h2>
    <div style="margin:12px 0;padding:8px 12px;background:var(--bg);border-radius:6px;font-size:13px">
      <strong>Subject:</strong> <span id="email-preview-subject"></span>
    </div>
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#fff">
      <iframe id="email-preview-frame" style="width:100%;height:500px;border:none" sandbox="allow-same-origin"></iframe>
    </div>
  </div>
</div>

<!-- TEMPLATE EDIT MODAL -->
<div class="modal-overlay" id="modal-template-edit">
  <div class="modal" style="max-width:800px;max-height:90vh;overflow:auto;position:relative">
    <button class="modal-close" onclick="closeModal('modal-template-edit')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
    <h2 id="template-edit-title">Edit Template</h2>
    <div id="template-edit-msg"></div>
    <input type="hidden" id="template-edit-type">
    <div class="form-field">
      <label>Subject Line</label>
      <input id="template-edit-subject" type="text" placeholder="Email subject">
    </div>
    <div class="form-field">
      <label>HTML Body <span style="color:var(--muted);font-weight:400">(overrides default template)</span></label>
      <textarea id="template-edit-html" rows="16" style="font-family:monospace;font-size:12px;width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:12px;resize:vertical"></textarea>
    </div>
    <div class="modal-actions" style="display:flex;gap:10px;justify-content:space-between">
      <button class="btn-danger" onclick="revertTemplate()" id="template-revert-btn" style="display:none">Revert to Default</button>
      <div style="display:flex;gap:10px">
        <button class="btn-secondary" onclick="previewEditTemplate()">Preview</button>
        <button class="btn-secondary" onclick="closeModal('modal-template-edit')">Cancel</button>
        <button class="btn-primary" onclick="saveTemplateOverride(this)">Save Override</button>
      </div>
    </div>
  </div>
</div>

<!-- CHURCH DETAIL PANEL -->
<div class="detail-panel" id="church-detail">
  <div class="detail-panel-header">
    <h2 id="detail-name">Church Details</h2>
    <button class="panel-close" onclick="closeDetail()"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
  </div>
  <div id="detail-content"></div>
</div>

<!-- TICKET DETAIL PANEL -->
<div class="detail-panel" id="ticket-detail">
  <div class="detail-panel-header">
    <h2 id="ticket-detail-title">Ticket Details</h2>
    <button class="panel-close" onclick="closeTicketDetail()"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
  </div>
  <div id="ticket-detail-content"></div>
</div>

<!-- MODALS -->

<!-- Add/Edit Church Modal -->
<div class="modal-overlay" id="modal-church">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-church')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
    <h2 id="church-modal-title">Add Church</h2>
    <div id="church-modal-msg"></div>
    <input type="hidden" id="church-modal-id">
    <div class="form-field"><label>Church Name</label><input id="cm-name" type="text" placeholder="Grace Community Church"></div>
    <div class="form-field"><label>Email</label><input id="cm-email" type="email" placeholder="td@church.com"></div>
    <div class="form-field"><label>Type</label><select id="cm-type"><option value="recurring">Recurring</option><option value="event">Event</option></select></div>
    <div class="form-field"><label>Reseller</label><select id="cm-reseller"><option value="">None (Direct)</option></select></div>
    <div class="form-field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="cm-audio-via-atem"> Audio routed directly into ATEM (no external mixer)</label></div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal('modal-church')">Cancel</button>
      <button class="btn-primary" onclick="submitChurch(this)">Save</button>
    </div>
  </div>
</div>

<!-- Regen Token Modal -->
<div class="modal-overlay" id="modal-token">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-token')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
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
    <button class="modal-close" onclick="closeModal('modal-reseller')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
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
      <button class="btn-primary" onclick="submitReseller(this)">Save</button>
    </div>
  </div>
</div>

<!-- API Key "COPY NOW" Modal -->
<div class="modal-overlay" id="modal-apikey">
  <div class="modal" style="position:relative;text-align:center">
    <button class="modal-close" onclick="closeModal('modal-apikey')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
    <h2 style="margin-bottom:12px">API Key — Copy Now!</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px">This key will not be shown again.</p>
    <div class="token-box" id="apikey-display" style="font-size:13px;cursor:pointer" onclick="copyNewApiKey()"></div>
    <button class="copy-btn" style="margin-top:12px;padding:8px 20px;font-size:13px" onclick="copyNewApiKey()">Copy API Key</button>
  </div>
</div>

<!-- Set Password Modal -->
<div class="modal-overlay" id="modal-setpw">
  <div class="modal" style="position:relative">
    <button class="modal-close" onclick="closeModal('modal-setpw')"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
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

<div id="toast"></div>

<!-- Async Dialog Modal -->
<div id="dialog-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;width:90%;max-width:400px">
    <div id="dialog-title" style="font-size:15px;font-weight:600;margin-bottom:12px"></div>
    <div id="dialog-body" style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.5"></div>
    <div id="dialog-input-wrap" style="display:none;margin-bottom:16px"><input id="dialog-input" style="width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-size:14px;outline:none"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="dialog-cancel" class="btn-sm" style="display:none">Cancel</button>
      <button id="dialog-ok" class="btn-sm" style="background:var(--green);color:#000;border:none;padding:8px 18px;font-weight:600">OK</button>
    </div>
  </div>
</div>

<script src="/portal/hls.min.js"></script>
<script>
// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'overview';
let allChurches = [];
let churchesTotal = 0;
let churchesPage = 1;
const CHURCHES_PAGE_SIZE = 50;
let allResellers = [];
let churchFilter = 'all';
let regenChurchId = null;
let currentApiKey = '';
let allAlerts = [];
let alertFilter = 'all';
let alertAckFilter = 'unack';
let allTickets = [];
let ticketFilter = 'all';
let allBilling = [];

// ─── Navigation ───────────────────────────────────────────────────────────────
const allPages = ['overview','churches','resellers','alerts','tickets','billing','aiusage','emails','streams','auditlog','settings'];
function showPage(page) {
  allPages.forEach(p => {
    const el = document.getElementById('page-'+p);
    if (el) el.style.display = p === page ? '' : 'none';
    const nav = document.getElementById('nav-'+p);
    if (nav) nav.classList.toggle('active', p === page);
  });
  const titles = {overview:'Overview',churches:'Churches',resellers:'Resellers',alerts:'Alerts',tickets:'Tickets',billing:'Billing',aiusage:'AI Usage',emails:'Emails',streams:'Stream Preview',auditlog:'Audit Log',settings:'Settings'};
  document.getElementById('page-title').textContent = titles[page]||page;
  currentPage = page;
  // Close mobile nav on page switch
  const sb = document.getElementById('admin-sidebar');
  const ov = document.getElementById('sidebar-overlay');
  if (sb) sb.classList.remove('open');
  if (ov) ov.classList.remove('open');
  if (page === 'overview') loadOverview();
  else if (page === 'churches') loadChurches();
  else if (page === 'resellers') loadResellers();
  else if (page === 'alerts') loadAlerts();
  else if (page === 'tickets') loadTickets();
  else if (page === 'billing') loadBilling();
  else if (page === 'aiusage') loadAIUsage();
  else if (page === 'emails') loadEmails();
  else if (page === 'streams') loadStreamPreview();
  else if (page === 'auditlog') loadAuditLog();
  else if (page === 'settings') loadSettings();
}

function toggleMobileNav() {
  const sb = document.getElementById('admin-sidebar');
  const ov = document.getElementById('sidebar-overlay');
  sb.classList.toggle('open');
  ov.classList.toggle('open');
}

// ─── Overview ─────────────────────────────────────────────────────────────────
async function loadOverview() {
  try {
    const r = await fetch('/api/admin/overview');
    if (!r.ok) throw new Error('Overview failed: ' + r.status);
    const d = await r.json();
    document.getElementById('stat-churches').textContent = d.totalChurches ?? 0;
    document.getElementById('stat-online').textContent = d.onlineNow ?? 0;
    document.getElementById('stat-resellers').textContent = d.totalResellers ?? 0;
    document.getElementById('stat-alerts').textContent = d.activeAlerts ?? 0;
    document.getElementById('stat-tickets').textContent = d.openTickets ?? 0;
    const mrr = d.mrr ?? 0;
    document.getElementById('stat-mrr').textContent = '$' + mrr.toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0});
    document.getElementById('overview-status').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
  } catch(e) {
    document.getElementById('overview-status').textContent = 'Failed to load overview data.';
  }
  // Load recent activity
  try {
    const r2 = await fetch('/api/admin/alerts?limit=10');
    const alerts = await r2.json();
    const feed = document.getElementById('activity-feed');
    if (!alerts.length) {
      feed.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:12px 0">No recent activity</div>';
    } else {
      feed.innerHTML = alerts.map(a => {
        const color = a.severity === 'critical' ? 'var(--red)' : a.severity === 'warning' ? 'var(--yellow)' : 'var(--green)';
        const time = new Date(a.created_at).toLocaleString();
        return \`<div class="activity-item">
          <div class="activity-dot" style="background:\${color}"></div>
          <div style="flex:1"><strong>\${esc(a.church_name||'Unknown')}</strong> — \${esc(a.alert_type||a.type||'Alert')}<br><span style="color:var(--muted);font-size:12px">\${time}</span></div>
          <span class="badge badge-\${a.severity==='critical'?'red':a.severity==='warning'?'yellow':'green'}">\${esc(a.severity||'info')}</span>
        </div>\`;
      }).join('');
    }
  } catch { /* alerts endpoint may not be ready */ }
}

// ─── Churches ─────────────────────────────────────────────────────────────────
async function loadChurches(page) {
  if (page !== undefined) churchesPage = page;
  try {
    const url = \`/api/admin/churches?page=\${churchesPage}&limit=\${CHURCHES_PAGE_SIZE}\`;
    const [cr, rr] = await Promise.all([fetch(url), fetch('/api/resellers')]);
    const data = await cr.json();
    // Support both paginated ({ churches, total, page }) and legacy array responses
    if (Array.isArray(data)) {
      allChurches = data;
      churchesTotal = data.length;
    } else {
      allChurches = data.churches || [];
      churchesTotal = data.total || allChurches.length;
      churchesPage = data.page || churchesPage;
    }
    allResellers = await rr.json();
    populateResellerDropdown('cm-reseller');
    renderChurches();
  } catch(e) {
    document.getElementById('churches-tbody').innerHTML = '<tr><td colspan="8" style="color:var(--red);text-align:center;padding:24px">Failed to load churches</td></tr>';
  }
}

function churchesChangePage(delta) {
  const totalPages = Math.ceil(churchesTotal / CHURCHES_PAGE_SIZE);
  const newPage = Math.max(1, Math.min(totalPages, churchesPage + delta));
  if (newPage !== churchesPage) loadChurches(newPage);
}

function renderChurches() {
  const search = document.getElementById('church-search').value.toLowerCase();
  let list = allChurches;
  if (churchFilter === 'online') list = list.filter(c => c.connected);
  else if (churchFilter === 'offline') list = list.filter(c => !c.connected);
  if (search) list = list.filter(c => c.name.toLowerCase().includes(search) || (c.email||'').toLowerCase().includes(search));
  const tbody = document.getElementById('churches-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="color:var(--muted);text-align:center;padding:24px">No churches found</td></tr>';
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
      <td><a class="church-name-link" onclick="openDetail(\${esc(JSON.stringify(c.churchId))})">\${esc(c.name)}</a></td>
      <td>\${reseller ? esc(reseller.brand_name || reseller.name) : '<span style="color:var(--muted)">Direct</span>'}</td>
      <td>\${statusHtml}</td>
      <td>\${esc(c.church_type||'recurring')}</td>
      <td>\${c.roomCount ?? '—'}</td>
      <td>\${reg}</td>
      <td>\${lastSeen}</td>
      <td>
        <button class="btn-sm" onclick="openEditChurch(\${esc(JSON.stringify(c.churchId))})">Edit</button>
        <button class="btn-sm" onclick="openRegenToken(\${esc(JSON.stringify(c.churchId))})">Regen Token</button>
        <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteChurch(\${esc(JSON.stringify(c.churchId))},\${esc(JSON.stringify(c.name))})">Delete</button>
      </td>
    </tr>\`;
  }).join('');

  // Update pagination controls
  const totalPages = Math.ceil(churchesTotal / CHURCHES_PAGE_SIZE);
  const countEl = document.getElementById('churches-count');
  const pageEl  = document.getElementById('churches-page-label');
  const prevBtn  = document.getElementById('churches-prev');
  const nextBtn  = document.getElementById('churches-next');
  if (countEl) countEl.textContent = \`\${churchesTotal} churches\`;
  if (pageEl)  pageEl.textContent  = totalPages > 1 ? \`Page \${churchesPage} of \${totalPages}\` : '';
  if (prevBtn) prevBtn.disabled    = churchesPage <= 1;
  if (nextBtn) nextBtn.disabled    = churchesPage >= totalPages;
  const pag = document.getElementById('churches-pagination');
  if (pag) pag.style.display = totalPages > 1 ? 'flex' : 'none';
}

function filterChurches() { renderChurches(); }
function setChurchFilter(f, el) {
  churchFilter = f;
  el.closest('.filter-tabs').querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
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
  document.getElementById('cm-audio-via-atem').checked = false;
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
  document.getElementById('cm-audio-via-atem').checked = !!(c.audio_via_atem);
  document.getElementById('church-modal-msg').innerHTML = '';
  openModal('modal-church');
}

async function submitChurch(btn) {
  const id = document.getElementById('church-modal-id').value;
  const body = {
    name: document.getElementById('cm-name').value,
    email: document.getElementById('cm-email').value,
    type: document.getElementById('cm-type').value,
    resellerId: document.getElementById('cm-reseller').value || null,
    audioViaAtem: document.getElementById('cm-audio-via-atem').checked ? 1 : 0,
  };
  btnLoading(btn);
  try {
    const url = id ? \`/api/admin/churches/\${id}\` : '/api/admin/churches';
    const method = id ? 'PUT' : 'POST';
    const r = await fetchTimeout(url, {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    const d = await r.json();
    if (!r.ok) { showModalMsg('church-modal-msg', d.error||'Error', 'error'); return; }
    closeModal('modal-church');
    loadChurches();
  } catch(e) { showModalMsg('church-modal-msg', 'Request failed', 'error'); }
  finally { btnReset(btn); }
}

async function deleteChurch(id, name) {
  if (!await modalConfirm('Delete Church', \`Delete "\${esc(name)}"? This cannot be undone.\`)) return;
  const r = await fetchTimeout(\`/api/admin/churches/\${id}\`, {method:'DELETE'});
  const d = await r.json();
  if (r.ok) { showToast('Church deleted'); loadChurches(); }
  else await modalAlert('Error', esc(d.error||'Delete failed'));
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
  copyToClipboard(t, 'Token');
}

// ─── Church Detail Panel ──────────────────────────────────────────────────────
let detailSupportView = null; // cached support-view data for room filtering
let detailChurchId = null;
let detailSelectedRoom = ''; // '' = all rooms

async function openDetail(id) {
  const c = allChurches.find(x => x.churchId === id);
  if (!c) return;
  const reseller = allResellers.find(r => r.id === c.reseller_id);

  detailChurchId = id;
  detailSelectedRoom = '';
  document.getElementById('detail-name').textContent = c.name;
  document.getElementById('detail-content').innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading...</div>';
  document.getElementById('church-detail').classList.add('open');

  // Fetch comprehensive data
  let sv = {};
  try {
    const r = await fetch('/api/admin/church/' + encodeURIComponent(id) + '/support-view', { headers: { 'Cookie': document.cookie } });
    sv = await r.json();
  } catch { sv = {}; }

  detailSupportView = sv;
  renderDetailPanel(c, reseller);
}

function onDetailRoomChange() {
  detailSelectedRoom = document.getElementById('detail-room-select')?.value || '';
  const c = allChurches.find(x => x.churchId === detailChurchId);
  if (!c) return;
  const reseller = allResellers.find(r => r.id === c.reseller_id);
  renderDetailPanel(c, reseller);
}

function getDevicesForRoom(sv, roomId) {
  if (!roomId) return (sv.status || {}).connectedDevices || {};
  const roomInstanceMap = sv.roomInstanceMap || {};
  const instanceName = roomInstanceMap[roomId];
  if (!instanceName) return {};
  const instData = (sv.instanceStatusMap || {})[instanceName];
  if (!instData) return {};
  return instData.connectedDevices || {};
}

function renderDetailPanel(c, reseller) {
  const sv = detailSupportView || {};
  const ch = sv.church || {};
  const st = sv.status || {};
  const hs = sv.healthScore || { score: 100, trend: 'stable' };
  const bill = sv.billing || {};
  const onb = sv.onboarding || {};
  const integ = sv.integrations || {};
  const cfg = sv.config || {};
  const alerts = sv.recentAlerts || [];
  const sessions = sv.recentSessions || [];
  const tickets = sv.recentTickets || [];
  const chat = sv.chatHistory || [];
  const tds = sv.tds || [];
  const rooms = sv.rooms || [];
  const devs = getDevicesForRoom(sv, detailSelectedRoom);

  function chip(label, ok) { return '<span class="detail-chip ' + (ok ? 'on' : 'off') + '">' + esc(label) + '</span>'; }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }
  function fmtTime(d) { return d ? new Date(d).toLocaleString() : '—'; }
  function healthClass(s) { return s >= 90 ? 'excellent' : s >= 75 ? 'good' : s >= 50 ? 'fair' : 'poor'; }
  function gradeBadge(g) {
    if (!g) return '<span class="badge badge-gray">—</span>';
    const cls = g === 'A' || g === 'A+' ? 'badge-green' : g === 'B' ? 'badge-green' : g === 'C' ? 'badge-yellow' : 'badge-red';
    return '<span class="badge ' + cls + '">' + esc(g) + '</span>';
  }
  function sevBadge(s) {
    const cls = s === 'critical' ? 'badge-red' : s === 'warning' ? 'badge-yellow' : 'badge-gray';
    return '<span class="badge ' + cls + '">' + esc(s || 'info') + '</span>';
  }
  function checkItem(label, val) {
    return '<div class="detail-check-item"><span class="check-dot ' + (val ? 'done' : 'pending') + '"></span>' + esc(label) + (val ? ' <span style="color:var(--dim);font-size:10px">' + fmtDate(val) + '</span>' : '') + '</div>';
  }

  const tierLabel = bill.tier || ch.plan || 'Free';
  const billingStatus = bill.status || ch.billing_status || '—';

  let html = '';

  // ── Room Selector (only for multi-room churches) ──
  if (rooms.length >= 2) {
    html += '<div style="margin-bottom:16px;display:flex;align-items:center;gap:10px">';
    html += '<label style="font-size:12px;color:var(--muted);font-weight:500">Room:</label>';
    html += '<select id="detail-room-select" class="search-input" style="width:200px;padding:6px 10px;font-size:13px" onchange="onDetailRoomChange()">';
    html += '<option value="">All Rooms</option>';
    rooms.forEach(function(rm) {
      html += '<option value="' + esc(rm.id) + '"' + (detailSelectedRoom === rm.id ? ' selected' : '') + '>' + esc(rm.name) + '</option>';
    });
    html += '</select></div>';
  }

  // ── Overview ──
  html += '<div class="detail-section"><div class="detail-section-title">Overview</div><div class="detail-grid">';
  html += '<div class="dg-label">Status</div><div class="dg-value">' + (st.online ? '<span class="status-dot status-online"></span>Online' : '<span class="status-dot status-offline"></span>Offline') + '</div>';
  html += '<div class="dg-label">Type</div><div class="dg-value">' + esc(ch.church_type || 'recurring') + '</div>';
  html += '<div class="dg-label">Tier</div><div class="dg-value"><span class="badge badge-green">' + esc(tierLabel) + '</span></div>';
  html += '<div class="dg-label">Billing</div><div class="dg-value">' + esc(billingStatus) + (bill.billing_interval ? ' (' + esc(bill.billing_interval) + ')' : '') + '</div>';
  if (bill.trial_ends_at) html += '<div class="dg-label">Trial Ends</div><div class="dg-value">' + fmtDate(bill.trial_ends_at) + '</div>';
  if (bill.stripe_customer_id) html += '<div class="dg-label">Stripe</div><div class="dg-value"><a href="https://dashboard.stripe.com/customers/' + esc(bill.stripe_customer_id) + '" target="_blank" style="color:var(--green);font-size:12px">View in Stripe</a></div>';
  html += '<div class="dg-label">Portal Email</div><div class="dg-value">' + esc(ch.portal_email || ch.email || '—') + '</div>';
  html += '<div class="dg-label">Reg Code</div><div class="dg-value" style="font-family:monospace">' + esc(ch.registration_code || '—') + '</div>';
  html += '<div class="dg-label">Referral Code</div><div class="dg-value" style="font-family:monospace">' + esc(ch.referral_code || '—') + '</div>';
  if (ch.referred_by) html += '<div class="dg-label">Referred By</div><div class="dg-value">' + esc(ch.referred_by) + '</div>';
  html += '<div class="dg-label">Reseller</div><div class="dg-value">' + (reseller ? esc(reseller.brand_name || reseller.name) : 'Direct') + '</div>';
  html += '<div class="dg-label">Timezone</div><div class="dg-value">' + esc(ch.timezone || '—') + '</div>';
  html += '<div class="dg-label">Registered</div><div class="dg-value">' + fmtTime(ch.registeredAt) + '</div>';
  html += '<div class="dg-label">Last Seen</div><div class="dg-value">' + fmtTime(st.lastHeartbeat) + '</div>';
  if (rooms.length >= 2) html += '<div class="dg-label">Rooms</div><div class="dg-value">' + rooms.length + ' rooms</div>';
  html += '</div></div>';

  // ── Health ──
  html += '<div class="detail-section"><div class="detail-section-title">Health</div>';
  html += '<span class="health-badge ' + healthClass(hs.score) + '">' + hs.score + '/100</span> ';
  html += '<span style="font-size:12px;color:var(--muted)">Trend: ' + esc(hs.trend || 'stable') + '</span>';
  if (st.currentSession) {
    html += '<div style="margin-top:8px;font-size:12px;color:var(--green)">Active session ��� ' + Math.floor(st.currentSession.duration / 60) + ' min</div>';
  }
  if (st.streamActive) html += '<div style="font-size:12px;color:var(--green);margin-top:4px">Stream active</div>';
  html += '</div>';

  // ── Devices ��─
  html += '<div class="detail-section"><div class="detail-section-title">Devices' + (detailSelectedRoom && rooms.length >= 2 ? ' <span style="font-size:10px;color:var(--dim);font-weight:400">(filtered by room)</span>' : '') + '</div><div class="detail-chips">';
  html += chip('ATEM', devs.atem) + chip('OBS', devs.obs) + chip('vMix', devs.vmix) + chip('Companion', devs.companion);
  if (devs.encoders?.length) devs.encoders.forEach(function(e) { html += chip(e.name || 'Encoder', true); });
  if (devs.mixers?.length) devs.mixers.forEach(function(m) { html += chip(m.name || 'Mixer', true); });
  if (devs.ptz?.length) devs.ptz.forEach(function(p) { html += chip(p.name || 'PTZ', true); });
  if (devs.hyperdecks?.length) devs.hyperdecks.forEach(function(h) { html += chip(h.name || 'HyperDeck', true); });
  if (devs.videoHubs?.length) devs.videoHubs.forEach(function(h) { html += chip(h.name || 'VideoHub', h.connected); });
  html += '</div>';
  if (ch.audio_via_atem) html += '<div style="font-size:11px;color:var(--dim);margin-top:6px">Audio via ATEM</div>';
  html += '</div>';

  // ── Integrations ──
  html += '<div class="detail-section"><div class="detail-section-title">Integrations</div><div class="detail-chips">';
  html += chip('Planning Center', integ.planningCenter) + chip('YouTube', integ.youtube) + chip('Facebook', integ.facebook) + chip('Vimeo', integ.vimeo);
  if (ch.slack_channel) html += chip('Slack', true);
  html += '</div></div>';

  // ── Onboarding ──
  html += '<div class="detail-section"><div class="detail-section-title">Onboarding</div><div class="detail-checklist">';
  html += checkItem('App Connected', onb.app_connected);
  html += checkItem('ATEM Connected', onb.atem_connected);
  html += checkItem('First Session', onb.first_session);
  html += checkItem('Telegram Setup', onb.telegram);
  html += checkItem('Failover Tested', onb.failover_tested);
  html += checkItem('Team Invited', onb.team_invited);
  html += '</div></div>';

  // ── Config ──
  html += '<div class="detail-section"><div class="detail-section-title">Configuration</div><div class="detail-chips">';
  html += chip('Auto-Recovery', cfg.autoRecovery) + chip('Failover', cfg.failover);
  if (cfg.failoverAction) html += '<span style="font-size:11px;color:var(--dim);margin-left:4px">(' + esc(cfg.failoverAction) + ')</span>';
  html += '</div>';
  if (cfg.autoPilotRulesCount > 0) html += '<div style="font-size:12px;color:var(--muted);margin-top:6px">' + cfg.autoPilotRulesCount + ' AutoPilot rule' + (cfg.autoPilotRulesCount !== 1 ? 's' : '') + '</div>';
  html += '</div>';

  // ── TDs ──
  if (tds.length) {
    html += '<div class="detail-section"><div class="detail-section-title">Tech Directors (' + tds.length + ')</div><table class="detail-mini-table"><thead><tr><th>Name</th><th>Email</th><th>Access</th></tr></thead><tbody>';
    tds.forEach(function(td) {
      html += '<tr><td style="color:var(--text)">' + esc(td.name || '—') + '</td><td>' + esc(td.email || '—') + '</td><td>' + esc(td.access_level || 'full') + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── Recent Sessions ──
  if (sessions.length) {
    html += '<div class="detail-section"><div class="detail-section-title">Recent Sessions</div><table class="detail-mini-table"><thead><tr><th>Date</th><th>Duration</th><th>Grade</th><th>Alerts</th></tr></thead><tbody>';
    sessions.forEach(function(s) {
      html += '<tr><td style="color:var(--text)">' + fmtDate(s.startedAt) + '</td><td>' + (s.duration || '—') + ' min</td><td>' + gradeBadge(s.grade) + '</td><td>' + (s.alerts || 0) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── Recent Alerts ──
  if (alerts.length) {
    html += '<div class="detail-section"><div class="detail-section-title">Recent Alerts (' + alerts.length + ')</div><table class="detail-mini-table"><thead><tr><th>Type</th><th>Severity</th><th>Time</th><th>Status</th></tr></thead><tbody>';
    alerts.slice(0, 10).forEach(function(a) {
      html += '<tr><td style="color:var(--text)">' + esc(a.type || '—') + '</td><td>' + sevBadge(a.severity) + '</td><td>' + fmtTime(a.timestamp) + '</td><td>' + (a.resolved ? '<span class="badge badge-green">Resolved</span>' : '<span class="badge badge-red">Open</span>') + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── Tickets ──
  if (tickets.length) {
    html += '<div class="detail-section"><div class="detail-section-title">Support Tickets</div><table class="detail-mini-table"><thead><tr><th>Title</th><th>Severity</th><th>Status</th><th>Created</th></tr></thead><tbody>';
    tickets.forEach(function(t) {
      html += '<tr><td style="color:var(--text)">' + esc(t.title || '—') + '</td><td>' + sevBadge(t.severity) + '</td><td><span class="badge badge-gray">' + esc(t.status || '—') + '</span></td><td>' + fmtDate(t.created_at) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── Chat History ──
  if (chat.length) {
    html += '<div class="detail-section"><div class="detail-section-title">Chat History</div><div class="detail-chat">';
    chat.forEach(function(m) {
      html += '<div class="detail-chat-msg"><span class="sender">' + esc(m.sender_name || m.source || 'System') + '</span>' + esc(m.message || m.text || '') + '<span class="time">' + fmtTime(m.timestamp || m.created_at) + '</span></div>';
    });
    html += '</div></div>';
  }

  // ── Token ──
  html += '<div class="detail-section"><div class="detail-section-title">Token</div>';
  html += '<div class="token-box" id="detail-token" style="font-size:11px;filter:blur(4px);cursor:pointer" onclick="revealToken()">' + esc((c.token || '').substring(0, 60)) + '...</div>';
  html += '<div style="display:flex;gap:8px;margin-top:6px"><button class="btn-sm" onclick="revealToken()">Reveal</button><button class="btn-sm" onclick="copyToken(' + esc(JSON.stringify(c.token || '')) + ')">Copy</button></div>';
  html += '</div>';

  // ── Actions ──
  const detId = detailChurchId;
  html += '<div class="detail-actions">';
  html += '<button class="btn-primary" onclick="openSendCommand(\\\'' + esc(detId) + '\\\')">Send Command</button>';
  html += '<button class="btn-secondary" onclick="openSendMessage(\\\'' + esc(detId) + '\\\')">Send Message</button>';
  html += '<button class="btn-secondary" onclick="openRegenToken(\\\'' + esc(detId) + '\\\')">Regen Token</button>';
  html += '</div>';

  document.getElementById('detail-content').innerHTML = html;
}

function revealToken() {
  const el = document.getElementById('detail-token');
  if (el) el.style.filter = 'none';
}
function copyToken(t) { copyToClipboard(t, 'Token'); }
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
    const status = r.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>';
    const churches = \`\${r.churchCount||0} / \${r.church_limit||10}\`;
    return \`<tr>
      <td>\${esc(r.brand_name||r.name)}</td>
      <td><span style="font-family:monospace;font-size:12px">\${esc(r.slug||'')}</span></td>
      <td>\${esc(r.support_email||'—')}</td>
      <td>\${churches}</td>
      <td><span class="color-swatch" style="background:\${sanitizeColor(color)}"></span>\${esc(color)}</td>
      <td>\${status}</td>
      <td>
        <button class="btn-sm" onclick="openEditReseller(\${esc(JSON.stringify(r.id))})">Edit</button>
        <button class="btn-sm" onclick="openSetPassword(\${esc(JSON.stringify(r.id))})">Set Password</button>
        <button class="btn-sm" onclick="window.open('/portal','_blank')">View Portal</button>
        <button class="btn-sm" onclick="toggleReseller(\${esc(JSON.stringify(r.id))},\${r.active})">\${r.active ? 'Deactivate' : 'Activate'}</button>
        <button class="btn-sm" style="color:var(--red);border-color:var(--red)" onclick="deleteReseller(\${esc(JSON.stringify(r.id))},\${esc(JSON.stringify(r.brand_name||r.name))})">Delete</button>
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

async function submitReseller(btn) {
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
  btnLoading(btn);
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
  finally { btnReset(btn); }
}

function copyNewApiKey() {
  copyToClipboard(currentApiKey, 'API key');
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
  if (r.ok) { closeModal('modal-setpw'); showToast('Password updated'); }
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
  if (!await modalConfirm('Delete Reseller', \`Delete reseller "\${esc(name)}"? This will deactivate the account.\`)) return;
  const r = await fetchTimeout(\`/api/admin/resellers/\${id}\`, {method:'DELETE'});
  if (r.ok) { showToast('Reseller deactivated'); loadResellers(); }
  else await modalAlert('Error', 'Delete failed');
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

async function changeAdminPassword(btn) {
  const currentPw = document.getElementById('current-pw').value;
  const newPw = document.getElementById('new-pw').value;
  if (!currentPw) { showModalMsg('pw-msg', 'Current password required', 'error'); return; }
  if (!newPw) { showModalMsg('pw-msg', 'New password required', 'error'); return; }
  if (newPw.length < 8) { showModalMsg('pw-msg', 'New password must be at least 8 characters', 'error'); return; }
  btnLoading(btn);
  try {
    const r = await fetchTimeout('/api/admin/change-password', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({currentPassword: currentPw, newPassword: newPw})
    });
    const d = await r.json();
    if (r.ok) {
      showModalMsg('pw-msg', 'Password changed successfully.', 'success');
      document.getElementById('current-pw').value = '';
      document.getElementById('new-pw').value = '';
    } else {
      showModalMsg('pw-msg', d.error||'Error', 'error');
    }
  } finally { btnReset(btn); }
}

let apiKeyRevealed = false;
function toggleApiKey() {
  const el = document.getElementById('api-key-display');
  apiKeyRevealed = !apiKeyRevealed;
  el.type = 'password';
  el.value = 'tally-admin-••••••••';
  modalAlert('API Key', 'For security, API keys are no longer displayed in the browser. Check your Railway environment variables.');
}
function copyApiKey() {
  modalAlert('API Key', 'For security, API keys are no longer exposed in the browser. Check your Railway environment variables directly.');
}

// ─── Alerts ──────────────────────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const r = await fetch('/api/admin/alerts?limit=100');
    allAlerts = await r.json();
    renderAlerts();
  } catch(e) {
    document.getElementById('alerts-tbody').innerHTML = '<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px">Failed to load alerts</td></tr>';
  }
}

function renderAlerts() {
  const search = (document.getElementById('alert-search').value||'').toLowerCase();
  let list = allAlerts;
  if (alertFilter !== 'all') list = list.filter(a => (a.severity||'info') === alertFilter);
  if (alertAckFilter === 'unack') list = list.filter(a => !a.acknowledged_at);
  if (search) list = list.filter(a => (a.church_name||'').toLowerCase().includes(search) || (a.instance_name||'').toLowerCase().includes(search));
  const tbody = document.getElementById('alerts-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">No alerts found</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(a => {
    const sevClass = a.severity==='critical'?'red':a.severity==='warning'?'yellow':'green';
    const time = new Date(a.created_at).toLocaleString();
    const acked = a.acknowledged_at ? '<span class="badge badge-gray">Acknowledged</span>' : '<span class="badge badge-red">Active</span>';
    const ackBtn = a.acknowledged_at ? '' : \`<button class="btn-sm" onclick="acknowledgeAlert('\${a.id}')">Acknowledge</button>\`;
    const roomName = a.instance_name ? a.instance_name.split('::')[0] : '';
    return \`<tr>
      <td>\${time}</td>
      <td>\${esc(a.church_name||'Unknown')}</td>
      <td style="color:var(--muted);font-size:12px">\${roomName ? esc(roomName) : '—'}</td>
      <td>\${esc(a.alert_type||a.type||'—')}</td>
      <td><span class="badge badge-\${sevClass}">\${esc(a.severity||'info')}</span></td>
      <td>\${acked}</td>
      <td>\${ackBtn}</td>
    </tr>\`;
  }).join('');
}

function filterAlerts() { renderAlerts(); }
function setAlertFilter(f, el) {
  alertFilter = f;
  el.closest('.filter-tabs').querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderAlerts();
}
function setAlertAckFilter(f, el) {
  alertAckFilter = f;
  el.closest('.filter-tabs').querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderAlerts();
}

async function acknowledgeAlert(id) {
  try {
    const r = await fetch(\`/api/admin/alerts/\${id}/acknowledge\`, {method:'POST'});
    if (r.ok) { showToast('Alert acknowledged'); loadAlerts(); }
    else { const d = await r.json(); showToast(d.error||'Error', true); }
  } catch { showToast('Failed to acknowledge alert', true); }
}

// ─── Tickets ─────────────────────────────────────────────────────────────────
async function loadTickets() {
  try {
    const r = await fetch('/api/admin/tickets');
    allTickets = await r.json();
    renderTickets();
  } catch(e) {
    document.getElementById('tickets-tbody').innerHTML = '<tr><td colspan="7" style="color:var(--red);text-align:center;padding:24px">Failed to load tickets</td></tr>';
  }
}

function renderTickets() {
  const search = (document.getElementById('ticket-search').value||'').toLowerCase();
  let list = allTickets;
  if (ticketFilter !== 'all') list = list.filter(t => t.status === ticketFilter);
  if (search) list = list.filter(t => (t.title||'').toLowerCase().includes(search) || (t.church_name||'').toLowerCase().includes(search));
  const tbody = document.getElementById('tickets-tbody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--muted);text-align:center;padding:24px">No tickets found</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(t => {
    const created = new Date(t.created_at).toLocaleString();
    const sevClass = t.severity==='critical'?'red':t.severity==='high'?'red':t.severity==='medium'?'yellow':'green';
    const statusClass = t.status==='open'?'red':t.status==='in_progress'?'yellow':'green';
    const statusLabel = (t.status||'open').replace('_',' ');
    return \`<tr style="cursor:pointer" onclick="openTicketDetail('\${t.id}')">
      <td>\${created}</td>
      <td>\${esc(t.church_name||'Unknown')}</td>
      <td><span class="badge badge-\${sevClass}">\${t.severity||'low'}</span></td>
      <td>\${esc(t.category||'—')}</td>
      <td>\${esc(t.title||'Untitled')}</td>
      <td><span class="badge badge-\${statusClass}">\${esc(statusLabel)}</span></td>
      <td><button class="btn-sm" onclick="event.stopPropagation();openTicketDetail('\${t.id}')">View</button></td>
    </tr>\`;
  }).join('');
}

function filterTickets() { renderTickets(); }
function setTicketFilter(f, el) {
  ticketFilter = f;
  document.querySelectorAll('#ticket-status-tabs .filter-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderTickets();
}

function openTicketDetail(id) {
  const t = allTickets.find(x => String(x.id) === String(id));
  if (!t) return;
  document.getElementById('ticket-detail-title').textContent = t.title||'Ticket Details';
  const created = new Date(t.created_at).toLocaleString();
  const statusClass = t.status==='open'?'red':t.status==='in_progress'?'yellow':'green';
  const statusLabel = (t.status||'open').replace('_',' ');
  let html = \`
    <div class="info-row"><span class="info-label">Status</span><span class="badge badge-\${statusClass}">\${esc(statusLabel)}</span></div>
    <div class="info-row"><span class="info-label">Church</span><span>\${esc(t.church_name||'Unknown')}</span></div>
    <div class="info-row"><span class="info-label">Category</span><span>\${esc(t.category||'—')}</span></div>
    <div class="info-row"><span class="info-label">Severity</span><span>\${esc(t.severity||'low')}</span></div>
    <div class="info-row"><span class="info-label">Created</span><span>\${created}</span></div>
  \`;
  if (t.description) {
    html += \`<div style="margin-top:16px"><div class="card-title">Description</div><p style="font-size:13px;color:var(--muted);line-height:1.6">\${esc(t.description)}</p></div>\`;
  }
  if (t.updates && t.updates.length) {
    html += '<div style="margin-top:16px"><div class="card-title">Updates</div>';
    t.updates.forEach(u => {
      const uTime = new Date(u.created_at).toLocaleString();
      html += \`<div class="activity-item"><div class="activity-dot" style="background:var(--green)"></div><div style="flex:1"><strong>\${esc(u.author||'System')}</strong><br><span style="font-size:13px;color:var(--muted)">\${esc(u.message||'')}</span><br><span style="font-size:11px;color:var(--dim)">\${uTime}</span></div></div>\`;
    });
    html += '</div>';
  }
  document.getElementById('ticket-detail-content').innerHTML = html;
  document.getElementById('ticket-detail').classList.add('open');
}

function closeTicketDetail() { document.getElementById('ticket-detail').classList.remove('open'); }

// ─── Billing ─────────────────────────────────────────────────────────────────
async function loadBilling() {
  try {
    const r = await fetch('/api/admin/billing');
    const d = await r.json();
    allBilling = Array.isArray(d) ? d : (d.subscriptions || []);
    renderBilling();
    renderBillingSummary();
  } catch(e) {
    document.getElementById('billing-tbody').innerHTML = '<tr><td colspan="6" style="color:var(--red);text-align:center;padding:24px">Failed to load billing data</td></tr>';
  }
}

function renderBillingSummary() {
  let mrr = 0, active = 0, pastDue = 0, free = 0;
  allBilling.forEach(b => {
    const status = (b.status||'').toLowerCase();
    if (status === 'active') { active++; mrr += (b.amount||0); }
    else if (status === 'past_due') { pastDue++; mrr += (b.amount||0); }
    else if (status === 'free' || status === 'connect' || !b.plan || b.plan === 'connect') { free++; }
  });
  document.getElementById('billing-mrr').textContent = '$' + mrr.toLocaleString(undefined, {minimumFractionDigits:0, maximumFractionDigits:0});
  document.getElementById('billing-active').textContent = active;
  document.getElementById('billing-past-due').textContent = pastDue;
  document.getElementById('billing-free').textContent = free;
}

function renderBilling() {
  const tbody = document.getElementById('billing-tbody');
  if (!allBilling.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">No billing records</td></tr>';
    return;
  }
  tbody.innerHTML = allBilling.map(b => {
    const status = (b.status||'inactive').toLowerCase();
    const statusClass = status==='active'?'green':status==='past_due'?'yellow':status==='canceled'?'red':'gray';
    const periodEnd = b.current_period_end ? new Date(b.current_period_end * 1000).toLocaleDateString() : '—';
    return \`<tr>
      <td>\${esc(b.church_name||b.churchName||'Unknown')}</td>
      <td>\${esc(b.plan||b.tier||'—')}</td>
      <td>\${esc(b.interval||'month')}</td>
      <td><span class="badge badge-\${statusClass}">\${esc(status)}</span></td>
      <td>\${periodEnd}</td>
      <td>\${b.stripe_customer_id ? '<button class="btn-sm" onclick="window.open(\\'https://dashboard.stripe.com/customers/'+esc(b.stripe_customer_id)+'\\',\\'_blank\\')">Stripe</button>' : '—'}</td>
    </tr>\`;
  }).join('');
}

// ─── AI Usage ────────────────────────────────────────────────────────────────
function clearAIDateRange() {
  document.getElementById('ai-date-from').value = '';
  document.getElementById('ai-date-to').value = '';
  loadAIUsage();
}

async function loadAIUsage() {
  try {
    const fromVal = document.getElementById('ai-date-from')?.value;
    const toVal   = document.getElementById('ai-date-to')?.value;
    const params  = new URLSearchParams();
    if (fromVal) params.set('from', fromVal + 'T00:00:00');
    if (toVal)   params.set('to', toVal + 'T23:59:59');
    const qs = params.toString();
    const r = await fetch('/api/admin/ai-usage' + (qs ? '?' + qs : ''));
    if (!r.ok) throw new Error('Failed to load AI usage');
    const { totals, byChurch, byFeature } = await r.json();
    document.getElementById('ai-requests').textContent = (totals.total_requests||0).toLocaleString();
    document.getElementById('ai-input-tok').textContent = (totals.total_input_tokens||0).toLocaleString();
    document.getElementById('ai-output-tok').textContent = (totals.total_output_tokens||0).toLocaleString();
    document.getElementById('ai-cost').textContent = '$' + (totals.total_cost||0).toFixed(4);
    document.getElementById('ai-cache').textContent = (totals.cache_hits||0).toLocaleString();

    const featureLabels = {command_parser:'Command Parser',setup_assistant:'Setup Assistant',dashboard_chat:'Dashboard Chat',church_chat:'Church Chat'};
    const churchTbody = document.getElementById('ai-by-church');
    const featureTbody = document.getElementById('ai-by-feature');

    if (!byChurch.length) {
      churchTbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">No usage data yet</td></tr>';
    } else {
      churchTbody.innerHTML = byChurch.map(r => '<tr>' +
        '<td>' + esc(r.church_name||r.church_id||'Admin / Dashboard') + '</td>' +
        '<td>' + (r.requests||0).toLocaleString() + '</td>' +
        '<td>' + (r.input_tokens||0).toLocaleString() + '</td>' +
        '<td>' + (r.output_tokens||0).toLocaleString() + '</td>' +
        '<td>$' + (r.cost||0).toFixed(4) + '</td></tr>').join('');
    }

    if (!byFeature.length) {
      featureTbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">No usage data yet</td></tr>';
    } else {
      featureTbody.innerHTML = byFeature.map(r => '<tr>' +
        '<td>' + (featureLabels[r.feature]||esc(r.feature)) + '</td>' +
        '<td>' + (r.requests||0).toLocaleString() + '</td>' +
        '<td>' + (r.input_tokens||0).toLocaleString() + '</td>' +
        '<td>' + (r.output_tokens||0).toLocaleString() + '</td>' +
        '<td>$' + (r.cost||0).toFixed(4) + '</td></tr>').join('');
    }
  } catch(e) {
    document.getElementById('ai-by-church').innerHTML = '<tr><td colspan="5" style="color:var(--red);text-align:center;padding:24px">Failed to load AI usage</td></tr>';
    document.getElementById('ai-by-feature').innerHTML = '';
  }
}

// ─── Audit Log ──────────────────────────────────────────────────────────────
let auditLogPage = 1;
let auditLogTotal = 0;
const AUDIT_PAGE_SIZE = 50;
let auditAutoRefreshTimer = null;

async function loadAuditLog(page) {
  if (page !== undefined) auditLogPage = page;
  try {
    const action = document.getElementById('audit-action-filter').value;
    const email  = document.getElementById('audit-email-search').value.trim();
    const from   = document.getElementById('audit-date-from').value;
    const to     = document.getElementById('audit-date-to').value;

    const params = new URLSearchParams({ page: auditLogPage, limit: AUDIT_PAGE_SIZE });
    if (action) params.set('action', action);
    if (email)  params.set('adminEmail', email);
    if (from)   params.set('from', from + 'T00:00:00');
    if (to)     params.set('to', to + 'T23:59:59');

    const r = await fetch('/api/admin/audit-log?' + params);
    if (!r.ok) throw new Error('Failed: ' + r.status);
    const data = await r.json();

    auditLogTotal = data.total || 0;
    auditLogPage  = data.page  || auditLogPage;
    const logs    = data.logs  || [];

    // Populate action type dropdown if empty (first load)
    const actionSelect = document.getElementById('audit-action-filter');
    if (actionSelect.options.length <= 1) {
      const actions = [...new Set(logs.map(l => l.action).filter(Boolean))].sort();
      actions.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a; opt.textContent = a.replace(/_/g,' ');
        actionSelect.appendChild(opt);
      });
    }

    const tbody = document.getElementById('auditlog-tbody');
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:24px">No audit log entries found</td></tr>';
    } else {
      tbody.innerHTML = logs.map(l => {
        const time = new Date(l.created_at).toLocaleString();
        const details = l.target_type ? (esc(l.target_type) + (l.target_id ? ': ' + esc(l.target_id) : '')) : (l.details ? esc(l.details).substring(0,80) : '—');
        return '<tr>' +
          '<td style="white-space:nowrap">' + time + '</td>' +
          '<td>' + esc(l.admin_email||'—') + '</td>' +
          '<td><span class="badge badge-green" style="font-size:11px">' + esc(l.action||'—').replace(/_/g,' ') + '</span></td>' +
          '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(l.details||'') + '">' + details + '</td>' +
          '<td style="font-family:monospace;font-size:12px">' + esc(l.ip||'—') + '</td>' +
          '</tr>';
      }).join('');
    }

    // Update pagination
    const totalPages = Math.ceil(auditLogTotal / AUDIT_PAGE_SIZE);
    const countEl = document.getElementById('auditlog-count');
    const pageEl  = document.getElementById('auditlog-page-label');
    const prevBtn = document.getElementById('auditlog-prev');
    const nextBtn = document.getElementById('auditlog-next');
    if (countEl) countEl.textContent = auditLogTotal + ' entries';
    if (pageEl)  pageEl.textContent  = totalPages > 1 ? 'Page ' + auditLogPage + ' of ' + totalPages : '';
    if (prevBtn) prevBtn.disabled    = auditLogPage <= 1;
    if (nextBtn) nextBtn.disabled    = auditLogPage >= totalPages;
    const pag = document.getElementById('auditlog-pagination');
    if (pag) pag.style.display = totalPages > 1 ? 'flex' : 'none';
  } catch(e) {
    document.getElementById('auditlog-tbody').innerHTML = '<tr><td colspan="5" style="color:var(--red);text-align:center;padding:24px">Failed to load audit log</td></tr>';
  }
}

function auditLogChangePage(delta) {
  const totalPages = Math.ceil(auditLogTotal / AUDIT_PAGE_SIZE);
  const newPage = Math.max(1, Math.min(totalPages, auditLogPage + delta));
  if (newPage !== auditLogPage) loadAuditLog(newPage);
}

function toggleAuditAutoRefresh() {
  const on = document.getElementById('audit-auto-refresh').checked;
  if (auditAutoRefreshTimer) { clearInterval(auditAutoRefreshTimer); auditAutoRefreshTimer = null; }
  if (on) {
    auditAutoRefreshTimer = setInterval(() => {
      if (currentPage === 'auditlog') loadAuditLog();
    }, 30000);
  }
}

// ─── Emails ──────────────────────────────────────────────────────────────────
let emailHistoryRows = [];
let emailHistoryOffset = 0;
let emailTemplates = [];
let emailCurrentSubTab = 'history';

function showEmailTab(tab, el) {
  emailCurrentSubTab = tab;
  ['history','templates','custom'].forEach(t => {
    const panel = document.getElementById('email-tab-'+t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#email-sub-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  if (tab === 'templates') loadEmailTemplates();
  if (tab === 'custom') populateCustomEmailForm();
}

async function loadEmails() {
  emailHistoryOffset = 0;
  emailHistoryRows = [];
  await Promise.all([loadEmailStats(), loadEmailHistory(), populateEmailTypeFilter()]);
}

async function loadEmailStats() {
  try {
    const r = await fetchTimeout('/api/admin/emails/stats');
    const d = await r.json();
    document.getElementById('email-total').textContent = (d.total||0).toLocaleString();
    document.getElementById('email-today').textContent = (d.today||0).toLocaleString();
    document.getElementById('email-week').textContent = (d.thisWeek||0).toLocaleString();
  } catch { }
}

async function populateEmailTypeFilter() {
  try {
    const r = await fetchTimeout('/api/admin/emails/templates');
    const templates = await r.json();
    const sel = document.getElementById('email-type-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All Types</option>' +
      templates.map(t => \`<option value="\${t.type}">\${esc(t.name)}</option>\`).join('');
    sel.value = current;
  } catch { }
}

async function loadEmailHistory() {
  emailHistoryOffset = 0;
  emailHistoryRows = [];
  const type = document.getElementById('email-type-filter').value;
  const search = document.getElementById('email-search').value.trim();
  let url = '/api/admin/emails?limit=50&offset=0';
  if (type) url += '&type=' + encodeURIComponent(type);
  if (search) url += '&search=' + encodeURIComponent(search);

  try {
    const r = await fetchTimeout(url);
    const d = await r.json();
    emailHistoryRows = d.rows || [];
    renderEmailHistory(d.rows, d.total);
  } catch {
    document.getElementById('emails-tbody').innerHTML = '<tr><td colspan="6" style="color:var(--red);text-align:center;padding:24px">Failed to load emails</td></tr>';
  }
}

async function loadMoreEmails() {
  emailHistoryOffset += 50;
  const type = document.getElementById('email-type-filter').value;
  const search = document.getElementById('email-search').value.trim();
  let url = '/api/admin/emails?limit=50&offset=' + emailHistoryOffset;
  if (type) url += '&type=' + encodeURIComponent(type);
  if (search) url += '&search=' + encodeURIComponent(search);

  try {
    const r = await fetchTimeout(url);
    const d = await r.json();
    emailHistoryRows = emailHistoryRows.concat(d.rows || []);
    renderEmailHistory(emailHistoryRows, d.total);
  } catch { }
}

function renderEmailHistory(rows, total) {
  const tbody = document.getElementById('emails-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:24px">No emails sent yet</td></tr>';
    document.getElementById('email-load-more').style.display = 'none';
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const date = new Date(r.sent_at);
    const dateStr = date.toLocaleDateString('en-US', {month:'short',day:'numeric'}) + ' ' + date.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'});
    const typeBadge = r.email_type.startsWith('manual:') ? 'badge-yellow' : r.email_type === 'custom' ? 'badge-yellow' : 'badge-green';
    return '<tr>' +
      '<td style="white-space:nowrap;font-size:12px;color:var(--muted)">' + esc(dateStr) + '</td>' +
      '<td>' + esc(r.church_name || r.church_id || '—') + '</td>' +
      '<td><span class="badge ' + typeBadge + '">' + esc(r.email_type) + '</span></td>' +
      '<td style="font-size:12px">' + esc(r.recipient || '—') + '</td>' +
      '<td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(r.subject || '—') + '</td>' +
      '<td><button class="btn-sm" onclick="previewSentEmail(' + i + ')">Preview</button>' +
      ' <button class="btn-sm" onclick="resendEmailByIndex(' + i + ')">Resend</button></td>' +
      '</tr>';
  }).join('');

  const btn = document.getElementById('email-load-more');
  btn.style.display = rows.length < (total || 0) ? '' : 'none';
}

async function previewSentEmail(idx) {
  const row = emailHistoryRows[idx];
  if (!row) return;
  // Try to get the template preview if it's a known type
  const baseType = row.email_type.replace(/^manual:/, '').replace(/-\\d{4}-W\\d+$/, '').replace(/^upgrade-.*/, 'upgrade');
  try {
    const r = await fetchTimeout('/api/admin/emails/templates/' + encodeURIComponent(baseType) + '/preview');
    if (r.ok) {
      const d = await r.json();
      showEmailPreview(row.subject || d.subject, d.html);
      return;
    }
  } catch { }
  showEmailPreview(row.subject || '(no subject)', '<div style="padding:40px;text-align:center;color:#999">Preview not available for this email type</div>');
}

function showEmailPreview(subject, html) {
  document.getElementById('email-preview-subject').textContent = subject || '';
  const frame = document.getElementById('email-preview-frame');
  frame.srcdoc = html || '<p>No preview</p>';
  openModal('modal-email-preview');
}

function resendEmailByIndex(idx) {
  const row = emailHistoryRows[idx];
  if (row) resendEmail(row);
}

async function resendEmail(row) {
  if (!await modalConfirm('Resend Email', \`Resend "\${esc(row.email_type)}" to \${esc(row.recipient)}?\`)) return;
  try {
    const r = await fetchTimeout('/api/admin/emails/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ churchId: row.church_id, emailType: row.email_type.replace(/^manual:/, ''), to: row.recipient }),
    });
    const d = await r.json();
    if (d.sent) showToast('Email resent');
    else showToast(d.reason || 'Send failed', true);
    loadEmailHistory();
  } catch { showToast('Failed to resend', true); }
}

// ── Templates Sub-tab ──
async function loadEmailTemplates() {
  try {
    const r = await fetchTimeout('/api/admin/emails/templates');
    emailTemplates = await r.json();
    renderTemplateGrid(emailTemplates);
  } catch {
    document.getElementById('templates-grid').innerHTML = '<div style="color:var(--red);text-align:center;padding:24px">Failed to load templates</div>';
  }
}

function renderTemplateGrid(templates) {
  const grid = document.getElementById('templates-grid');
  grid.innerHTML = templates.map(t => \`
    <div class="card" style="padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
        <strong style="font-size:14px">\${esc(t.name)}</strong>
        \${t.hasOverride ? '<span class="badge badge-yellow" style="font-size:10px">Override</span>' : ''}
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:16px">\${esc(t.trigger)}</div>
      <div style="display:flex;gap:8px">
        <button class="btn-sm" onclick="previewTemplate(\${esc(JSON.stringify(t.type))})">Preview</button>
        <button class="btn-sm" onclick="editTemplate(\${esc(JSON.stringify(t.type))})">Edit</button>
      </div>
    </div>
  \`).join('');
}

async function previewTemplate(type) {
  try {
    const r = await fetchTimeout('/api/admin/emails/templates/' + encodeURIComponent(type) + '/preview');
    const d = await r.json();
    showEmailPreview(d.subject, d.html);
  } catch { showToast('Failed to load preview', true); }
}

async function editTemplate(type) {
  try {
    const r = await fetchTimeout('/api/admin/emails/templates/' + encodeURIComponent(type) + '/preview');
    const d = await r.json();
    document.getElementById('template-edit-type').value = type;
    const tmpl = emailTemplates.find(t => t.type === type);
    document.getElementById('template-edit-title').textContent = 'Edit: ' + (tmpl ? tmpl.name : type);
    document.getElementById('template-edit-subject').value = d.subject || '';
    document.getElementById('template-edit-html').value = d.html || '';
    document.getElementById('template-edit-msg').innerHTML = '';
    document.getElementById('template-revert-btn').style.display = d.hasOverride ? '' : 'none';
    openModal('modal-template-edit');
  } catch { showToast('Failed to load template', true); }
}

function previewEditTemplate() {
  const subject = document.getElementById('template-edit-subject').value;
  const html = document.getElementById('template-edit-html').value;
  showEmailPreview(subject, html);
}

async function saveTemplateOverride(btn) {
  const type = document.getElementById('template-edit-type').value;
  const subject = document.getElementById('template-edit-subject').value.trim();
  const html = document.getElementById('template-edit-html').value.trim();
  if (!subject && !html) { showModalMsg('template-edit-msg', 'Subject or HTML required', 'error'); return; }
  btnLoading(btn);
  try {
    const r = await fetchTimeout('/api/admin/emails/templates/' + encodeURIComponent(type), {
      method: 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ subject: subject || null, html: html || null }),
    });
    const d = await r.json();
    if (!r.ok) { showModalMsg('template-edit-msg', d.error || 'Save failed', 'error'); return; }
    showToast('Template override saved');
    closeModal('modal-template-edit');
    loadEmailTemplates();
  } catch { showModalMsg('template-edit-msg', 'Request failed', 'error'); }
  finally { btnReset(btn); }
}

async function revertTemplate() {
  const type = document.getElementById('template-edit-type').value;
  if (!await modalConfirm('Revert Template', 'Remove the override and revert to the default template?')) return;
  try {
    await fetchTimeout('/api/admin/emails/templates/' + encodeURIComponent(type), { method: 'DELETE' });
    showToast('Reverted to default');
    closeModal('modal-template-edit');
    loadEmailTemplates();
  } catch { showToast('Failed to revert', true); }
}

// ── Send Custom Sub-tab ──
function populateCustomEmailForm() {
  const sel = document.getElementById('custom-church-select');
  if (sel.options.length <= 1 && allChurches.length) {
    sel.innerHTML = '<option value="">— Select a church —</option>' +
      allChurches.map(c => \`<option value="\${c.churchId}" data-email="\${esc(c.portal_email||'')}">\${esc(c.name)}\${c.portal_email ? ' (' + esc(c.portal_email) + ')' : ''}</option>\`).join('');
  }
  // Pre-fill wrapper HTML if empty
  const ta = document.getElementById('custom-email-html');
  if (!ta.value) {
    ta.value = '<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 0;">\\n' +
      '  <div style="margin-bottom: 24px;">\\n    <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #22c55e; margin-right: 8px;"></span>\\n    <strong style="font-size: 16px; color: #111;">Tally</strong>\\n  </div>\\n\\n' +
      '  <h1 style="font-size: 22px; color: #111; margin: 0 0 8px;">Your heading here</h1>\\n' +
      '  <p style="font-size: 15px; color: #333; line-height: 1.6;">Your message here.</p>\\n\\n' +
      '  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0 16px;" />\\n' +
      '  <p style="font-size: 12px; color: #999;">Tally</p>\\n' +
      '</div>';
  }
}

function onCustomChurchSelect() {
  const sel = document.getElementById('custom-church-select');
  const opt = sel.selectedOptions[0];
  if (opt && opt.dataset.email) {
    document.getElementById('custom-email-to').value = opt.dataset.email;
  }
}

function previewCustomEmail() {
  const subject = document.getElementById('custom-email-subject').value;
  const html = document.getElementById('custom-email-html').value;
  showEmailPreview(subject, html);
}

async function sendCustomEmail(btn) {
  const to = document.getElementById('custom-email-to').value.trim();
  const subject = document.getElementById('custom-email-subject').value.trim();
  const html = document.getElementById('custom-email-html').value.trim();
  const sel = document.getElementById('custom-church-select');
  const churchId = sel.value || null;

  if (!to) { showModalMsg('custom-email-msg', 'Recipient email required', 'error'); return; }
  if (!subject) { showModalMsg('custom-email-msg', 'Subject required', 'error'); return; }
  if (!html) { showModalMsg('custom-email-msg', 'HTML body required', 'error'); return; }
  if (!await modalConfirm('Send Email', \`Send to \${esc(to)}?\`)) return;

  btnLoading(btn);
  try {
    const r = await fetchTimeout('/api/admin/emails/send', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ to, subject, html, churchId }),
    });
    const d = await r.json();
    if (d.sent) {
      showToast('Email sent');
      document.getElementById('custom-email-msg').innerHTML = '<div class="alert-box alert-success">Email sent to ' + esc(to) + '</div>';
    } else {
      showModalMsg('custom-email-msg', d.reason || 'Send failed', 'error');
    }
  } catch { showModalMsg('custom-email-msg', 'Request failed', 'error'); }
  finally { btnReset(btn); }
}

// ─── Toast ───────────────────────────────────────────────────────────────────
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isError ? 'show error' : 'show';
  setTimeout(() => { t.className = ''; }, 3000);
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

function sanitizeColor(c) {
  const s = String(c||'').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[a-zA-Z]{1,30}$/.test(s)) return s;
  return '#22c55e';
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

// ─── Async Dialog System ─────────────────────────────────────────────────────
function _showDialog(title, body, {showCancel=false, showInput=false, inputVal=''}={}) {
  return new Promise(resolve => {
    const ov = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const inputWrap = document.getElementById('dialog-input-wrap');
    const inputEl = document.getElementById('dialog-input');
    const okBtn = document.getElementById('dialog-ok');
    const cancelBtn = document.getElementById('dialog-cancel');
    titleEl.textContent = title;
    bodyEl.innerHTML = body;
    inputWrap.style.display = showInput ? '' : 'none';
    cancelBtn.style.display = showCancel ? '' : 'none';
    if (showInput) { inputEl.value = inputVal; }
    ov.style.display = 'flex';
    if (showInput) inputEl.focus();
    function cleanup() { ov.style.display = 'none'; okBtn.onclick = null; cancelBtn.onclick = null; }
    okBtn.onclick = () => { cleanup(); resolve(showInput ? inputEl.value : true); };
    cancelBtn.onclick = () => { cleanup(); resolve(showInput ? null : false); };
  });
}
function modalAlert(title, body) { return _showDialog(title, body); }
function modalConfirm(title, body) { return _showDialog(title, body, {showCancel:true}); }

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  showToast((label||'Value') + ' copied!');
}

// ─── Fetch with timeout ──────────────────────────────────────────────────────
function fetchTimeout(url, opts={}, ms=30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, {...opts, signal: ctrl.signal}).finally(() => clearTimeout(id));
}

// ─── Button loading states ───────────────────────────────────────────────────
function btnLoading(btn) {
  if (!btn) return;
  btn._origText = btn.textContent;
  btn.disabled = true;
  btn.style.opacity = '0.6';
  btn.textContent = btn._origText.replace(/^(Save|Submit|Create|Update|Delete|Add|Change|Deactivate|Activate)/, '$1ing').replace(/eing$/, 'ing');
}
function btnReset(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.style.opacity = '';
  if (btn._origText) btn.textContent = btn._origText;
}

async function signOut(e) {
  e.preventDefault();
  await fetch('/admin/logout', {method:'POST'});
  window.location.href = '/admin/login';
}

// ─── Stream Preview ────────────────────────────────────────────────────────────
let streamHls = null;
let streamChurchId = null;
let streamKeyData = null;
let streamChurchStatus = {}; // churchId → latest status from SSE
let streamSelectedRoom = ''; // '' = all rooms
let streamRooms = []; // rooms for selected church
let streamRoomInstanceMap = {}; // roomId → instanceName
let streamInstanceStatusMap = {}; // instanceName → status

async function loadStreamPreview() {
  // Populate church selector
  try {
    const r = await fetch('/api/admin/churches');
    const data = await r.json();
    const sel = document.getElementById('stream-church-select');
    const current = sel.value;
    sel.innerHTML = '<option value="">— Select a church —</option>';
    (data.churches || data).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.churchId;
      opt.textContent = c.name + (c.connected ? ' (online)' : '');
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  } catch(e) { console.error('Failed to load churches for stream select', e); }

  // Fetch active streams count
  try {
    const r = await fetch('/api/admin/streams');
    const data = await r.json();
    const count = (data.streams || []).length;
    document.getElementById('stream-active-count').textContent = count > 0 ? count + ' active stream' + (count > 1 ? 's' : '') : 'No active streams';

    // If a stream is active and no church is selected, auto-select the first one
    if (!streamChurchId && count > 0) {
      const first = data.streams[0];
      document.getElementById('stream-church-select').value = first.churchId;
      onStreamChurchSelect();
      return;
    }
  } catch(e) {}

  // If church already selected, refresh its state
  if (streamChurchId) {
    refreshStreamState(streamChurchId);
  }
}

async function onStreamChurchSelect() {
  const sel = document.getElementById('stream-church-select');
  const churchId = sel.value;
  const roomSel = document.getElementById('stream-room-select');

  // Cleanup previous HLS player
  destroyStreamPlayer();
  streamSelectedRoom = '';
  streamRooms = [];
  streamRoomInstanceMap = {};
  streamInstanceStatusMap = {};
  roomSel.style.display = 'none';

  if (!churchId) {
    streamChurchId = null;
    document.getElementById('stream-key-card').style.display = 'none';
    document.getElementById('stream-status-panel').style.display = 'none';
    document.getElementById('stream-live-badge').style.display = 'none';
    document.getElementById('stream-offline-badge').style.display = 'none';
    document.getElementById('stream-placeholder').style.display = 'flex';
    return;
  }

  streamChurchId = churchId;
  document.getElementById('stream-status-panel').style.display = '';

  // Fetch rooms for this church
  try {
    const rr = await fetch('/api/admin/church/' + encodeURIComponent(churchId) + '/rooms');
    if (rr.ok) {
      const rd = await rr.json();
      streamRooms = rd.rooms || [];
      streamRoomInstanceMap = rd.roomInstanceMap || {};
      if (streamRooms.length >= 2) {
        roomSel.innerHTML = '<option value="">All Rooms</option>' + streamRooms.map(function(rm) {
          return '<option value="' + esc(rm.id) + '">' + esc(rm.name) + '</option>';
        }).join('');
        roomSel.style.display = '';
      }
    }
  } catch { /* rooms endpoint may not be available */ }

  // Load stream key + status
  await refreshStreamState(churchId);
  // Render equipment status from SSE data
  renderStreamEquipmentStatus(churchId);
}

function onStreamRoomSelect() {
  streamSelectedRoom = document.getElementById('stream-room-select').value;
  if (streamChurchId) renderStreamEquipmentStatus(streamChurchId);
}

async function refreshStreamState(churchId) {
  try {
    const r = await fetch('/api/admin/stream/' + churchId + '/key');
    if (!r.ok) throw new Error('Failed: ' + r.status);
    streamKeyData = await r.json();

    // Show stream key card
    const card = document.getElementById('stream-key-card');
    card.style.display = '';
    document.getElementById('stream-rtmp-url').textContent = streamKeyData.rtmpUrl.replace(streamKeyData.streamKey, '{STREAM_KEY}');
    document.getElementById('stream-key-display').textContent = streamKeyData.streamKey;

    // Update badges
    if (streamKeyData.active) {
      document.getElementById('stream-live-badge').style.display = '';
      document.getElementById('stream-offline-badge').style.display = 'none';
      document.getElementById('stream-placeholder').style.display = 'none';
      startStreamPlayer(churchId);
    } else {
      document.getElementById('stream-live-badge').style.display = 'none';
      document.getElementById('stream-offline-badge').style.display = '';
      document.getElementById('stream-placeholder').style.display = 'flex';
      document.getElementById('stream-placeholder').textContent = 'Stream offline — waiting for RTMP input';
    }
  } catch(e) {
    console.error('Failed to fetch stream key', e);
  }
}

function startStreamPlayer(churchId) {
  const video = document.getElementById('stream-video');
  const src = '/api/admin/stream/' + churchId + '/live.m3u8';

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    streamHls = new Hls({
      liveDurationInfinity: true,
      liveBackBufferLength: 0,
      maxBufferLength: 6,
      maxMaxBufferLength: 12,
      xhrSetup: function(xhr) {
        // Admin auth cookie is sent automatically (same origin)
      }
    });
    streamHls.loadSource(src);
    streamHls.attachMedia(video);
    streamHls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    streamHls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        console.error('[HLS] Fatal error', data);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          // Stream may have ended, retry in 3s
          setTimeout(() => {
            if (streamChurchId === churchId) streamHls.loadSource(src);
          }, 3000);
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    video.src = src;
    video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
  }
}

function destroyStreamPlayer() {
  if (streamHls) {
    streamHls.destroy();
    streamHls = null;
  }
  const video = document.getElementById('stream-video');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function copyStreamUrl() {
  if (!streamKeyData) return;
  navigator.clipboard.writeText(streamKeyData.rtmpUrl).then(() => {
    showToast('RTMP URL copied');
  });
}

function copyStreamKey() {
  if (!streamKeyData) return;
  navigator.clipboard.writeText(streamKeyData.streamKey).then(() => {
    showToast('Stream key copied');
  });
}

async function regenerateStreamKey() {
  if (!streamChurchId) return;
  if (!confirm('Regenerate stream key? This will disconnect any active stream.')) return;
  try {
    const r = await fetch('/api/admin/stream/' + streamChurchId + '/key/regenerate', { method: 'POST' });
    if (!r.ok) throw new Error('Failed: ' + r.status);
    const data = await r.json();
    streamKeyData = { ...streamKeyData, ...data };
    document.getElementById('stream-key-display').textContent = data.streamKey;
    document.getElementById('stream-rtmp-url').textContent = data.rtmpUrl.replace(data.streamKey, '{STREAM_KEY}');
    destroyStreamPlayer();
    document.getElementById('stream-live-badge').style.display = 'none';
    document.getElementById('stream-offline-badge').style.display = '';
    document.getElementById('stream-placeholder').style.display = 'flex';
    document.getElementById('stream-placeholder').textContent = 'Key regenerated — stream disconnected';
    showToast('Stream key regenerated');
  } catch(e) {
    showToast('Failed to regenerate key');
  }
}

// Fetch and render equipment/tally status from support-view API
async function renderStreamEquipmentStatus(churchId) {
  const eqEl = document.getElementById('stream-equipment-list');
  const tallyEl = document.getElementById('stream-tally-indicators');
  const metaEl = document.getElementById('stream-meta-info');

  try {
    const r = await fetch('/api/admin/church/' + encodeURIComponent(churchId) + '/support-view');
    if (!r.ok) throw new Error('Failed');
    const data = await r.json();

    // Cache instance data for room switching without re-fetching
    streamInstanceStatusMap = data.instanceStatusMap || {};
    if (data.roomInstanceMap) streamRoomInstanceMap = data.roomInstanceMap;

    let st = data.status || {};
    let devices = st.connectedDevices || {};
    let online = st.online;
    let streamActive = st.streamActive;

    // If a specific room is selected, use that room's instance status
    if (streamSelectedRoom && streamRoomInstanceMap[streamSelectedRoom]) {
      const instName = streamRoomInstanceMap[streamSelectedRoom];
      const instData = streamInstanceStatusMap[instName];
      if (instData) {
        devices = instData.connectedDevices || {};
        online = instData.online;
        streamActive = instData.streamActive;
      } else {
        devices = {};
        online = false;
        streamActive = false;
      }
    }

    // Equipment list
    const items = [];
    const dot = (ok) => '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + (ok ? 'var(--green)' : '#555') + ';margin-right:8px"></span>';

    items.push(dot(online) + 'App ' + (online ? '(Connected)' : '(Offline)'));
    if (devices.atem !== undefined) items.push(dot(devices.atem) + 'ATEM');
    if (devices.obs !== undefined) items.push(dot(devices.obs) + 'OBS');
    if (devices.vmix !== undefined) items.push(dot(devices.vmix) + 'vMix');
    if (devices.companion !== undefined) items.push(dot(devices.companion) + 'Companion');
    if (devices.encoders) {
      const encs = Array.isArray(devices.encoders) ? devices.encoders : [];
      encs.forEach((e, i) => items.push(dot(e.connected || e.active) + 'Encoder' + (encs.length > 1 ? ' ' + (i+1) : '') + (e.name ? ' (' + e.name + ')' : '')));
    }
    if (devices.mixers) {
      const mixers = Array.isArray(devices.mixers) ? devices.mixers : [];
      mixers.forEach((m, i) => items.push(dot(m.connected) + 'Audio' + (m.name ? ' (' + m.name + ')' : '')));
    }
    if (devices.ptz) {
      const cams = Array.isArray(devices.ptz) ? devices.ptz : [];
      items.push(dot(cams.length > 0) + 'PTZ Cameras (' + cams.length + ')');
    }
    if (devices.hyperdecks) {
      const hds = Array.isArray(devices.hyperdecks) ? devices.hyperdecks : [];
      hds.forEach(h => items.push(dot(h.connected) + 'HyperDeck' + (h.name ? ' (' + h.name + ')' : '')));
    }
    if (devices.videoHubs) {
      const vhs = Array.isArray(devices.videoHubs) ? devices.videoHubs : [];
      vhs.forEach(h => items.push(dot(h.connected) + 'VideoHub' + (h.name ? ' (' + h.name + ')' : '')));
    }

    const roomLabel = streamSelectedRoom ? ' <span style="font-size:10px;color:var(--dim)">(filtered)</span>' : '';
    eqEl.innerHTML = items.length ? items.map(i => '<div style="padding:4px 0">' + i + '</div>').join('') : '<div style="color:var(--muted);padding:8px 0;text-align:center">No equipment detected' + roomLabel + '</div>';

    // Tally indicators — not available from support-view (would need raw WebSocket status)
    tallyEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Tally data available when streaming</div>';

    // Stream meta
    const meta = [];
    if (streamActive !== undefined) meta.push('Stream Active: ' + (streamActive ? 'Yes' : 'No'));
    if (st.currentSession) {
      meta.push('Session: Active');
      if (st.currentSession.duration) {
        const mins = Math.floor(st.currentSession.duration / 60);
        meta.push('Duration: ' + mins + ' min');
      }
    }
    metaEl.innerHTML = meta.length ? meta.map(m => '<div style="padding:3px 0">' + m + '</div>').join('') : '<div style="color:var(--muted);padding:8px 0">No stream metadata</div>';
  } catch(e) {
    eqEl.innerHTML = '<div style="color:var(--muted);padding:8px 0;text-align:center">Failed to load status</div>';
  }
}

function showToast(msg) {
  // Simple toast notification
  let toast = document.getElementById('stream-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'stream-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;z-index:10000;border:1px solid var(--border);opacity:0;transition:opacity 0.3s';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadOverview();
// Auto-refresh every 30 seconds for the active page
setInterval(() => {
  if (currentPage === 'overview') loadOverview();
  else if (currentPage === 'churches') loadChurches();
}, 30000);
// Stream preview refreshes more frequently (every 10s) for live status
setInterval(() => {
  if (currentPage === 'streams' && streamChurchId) {
    refreshStreamState(streamChurchId);
    renderStreamEquipmentStatus(streamChurchId);
  }
}, 10000);
</script>
</body></html>`;
}

// ─── HTML: PORTAL LOGIN ───────────────────────────────────────────────────────

function buildPortalLoginHtml(error, resellerBrand) {
  const brand = escHtml(resellerBrand || 'Tally Partner Portal');
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
  const brand = escHtml(reseller.brand_name || 'Tally');
  const color = sanitizeColor(reseller.primary_color || '#22c55e');
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
    <button class="btn-primary" onclick="addChurch(this)">Create Registration Code</button>
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
    <div class="form-field"><label>Support Email</label><input id="acct-email" type="email" value="${escHtml(reseller.support_email||'')}"></div>
    <div class="form-field"><label>Logo URL</label><input id="acct-logo" type="url" value="${escHtml(reseller.logo_url||'')}"></div>
    <div class="form-field"><label>Primary Color</label><input id="acct-color" type="color" value="${color}"></div>
    <button class="btn-primary" onclick="saveAccount(this)">Save Changes</button>
  </div>
  <div class="account-section">
    <h3>API Key</h3>
    <div class="copy-group">
      <input type="password" id="portal-apikey" value="${escHtml(reseller.api_key||'')}" readonly>
      <button class="btn-sm" onclick="togglePortalApiKey()">Reveal</button>
      <button class="btn-sm" onclick="copyPortalApiKey()">Copy</button>
    </div>
  </div>
  <div class="account-section">
    <h3>Change Portal Password</h3>
    <div id="pw-msg"></div>
    <div class="form-field"><label>Current Password</label><input id="pw-current" type="password" placeholder="Current password"></div>
    <div class="form-field"><label>New Password</label><input id="pw-new" type="password" placeholder="New password"></div>
    <button class="btn-primary" onclick="changePortalPw(this)">Update Password</button>
  </div>
</div>

<!-- DETAIL PANEL -->
<div class="detail-panel" id="fleet-detail">
  <div class="detail-panel-header">
    <h2 id="fd-name">Church Details</h2>
    <button class="panel-close" onclick="closeFleetDetail()"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button>
  </div>
  <div id="fd-content"></div>
</div>

<!-- Toast -->
<div id="portal-toast" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#22c55e;color:#000;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:9999"></div>

<!-- Async Dialog Modal -->
<div id="dialog-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center">
  <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px;width:90%;max-width:400px">
    <div id="dialog-title" style="font-size:15px;font-weight:600;margin-bottom:12px"></div>
    <div id="dialog-body" style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.5"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end">
      <button id="dialog-cancel" class="btn-sm" style="display:none">Cancel</button>
      <button id="dialog-ok" class="btn-sm" style="background:var(--green);color:#000;border:none;padding:8px 18px;font-weight:600">OK</button>
    </div>
  </div>
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
      <td><button class="btn-sm" onclick="openFleetDetail(\${esc(JSON.stringify(c.churchId))})">Details</button></td>
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

async function addChurch(btn) {
  const name = document.getElementById('ac-name').value.trim();
  const email = document.getElementById('ac-email').value.trim();
  const portalEmail = document.getElementById('ac-portal-email').value.trim().toLowerCase();
  const portalPassword = document.getElementById('ac-portal-password').value;
  const portalCreatedEl = document.getElementById('add-portal-created');
  if (!name) { showMsg('add-msg', 'Church name required', 'error'); return; }
  if (portalPassword && !portalEmail) { showMsg('add-msg', 'Portal login email is required when password is provided', 'error'); return; }
  if (portalEmail && !portalPassword) { showMsg('add-msg', 'Portal password is required when portal login email is provided', 'error'); return; }
  if (portalPassword && portalPassword.length < 8) { showMsg('add-msg', 'Portal password must be at least 8 characters', 'error'); return; }
  btnLoading(btn);
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
  finally { btnReset(btn); }
}

function copyRegCode() {
  copyToClipboard(lastRegCode, 'Registration code');
}

async function saveAccount(btn) {
  const body = {
    brand_name: document.getElementById('acct-brand').value,
    support_email: document.getElementById('acct-email').value,
    logo_url: document.getElementById('acct-logo').value,
    primary_color: document.getElementById('acct-color').value,
  };
  btnLoading(btn);
  try {
    const r = await fetch('/api/portal/account', {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (r.ok) showMsg('acct-msg', 'Saved!', 'success');
    else showMsg('acct-msg', d.error||'Error', 'error');
  } catch { showMsg('acct-msg', 'Request failed', 'error'); }
  finally { btnReset(btn); }
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
  copyToClipboard(v, 'API key');
}

async function changePortalPw(btn) {
  const current = document.getElementById('pw-current').value;
  const newPw = document.getElementById('pw-new').value;
  if (!current || !newPw) { showMsg('pw-msg', 'Both fields required', 'error'); return; }
  btnLoading(btn);
  try {
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
  } catch { showMsg('pw-msg', 'Request failed', 'error'); }
  finally { btnReset(btn); }
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = \`<div class="alert-box alert-\${type==='error'?'error':'success'}">\${esc(msg)}</div>\`;
}

function showToast(msg) {
  const t = document.getElementById('portal-toast');
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

function _showDialog(title, body, {showCancel=false}={}) {
  return new Promise(resolve => {
    const ov = document.getElementById('dialog-overlay');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const okBtn = document.getElementById('dialog-ok');
    const cancelBtn = document.getElementById('dialog-cancel');
    titleEl.textContent = title;
    bodyEl.innerHTML = body;
    cancelBtn.style.display = showCancel ? '' : 'none';
    ov.style.display = 'flex';
    function cleanup() { ov.style.display = 'none'; okBtn.onclick = null; cancelBtn.onclick = null; }
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}
function modalAlert(title, body) { return _showDialog(title, body); }

async function copyToClipboard(text, label) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  showToast((label||'Value') + ' copied!');
}

function btnLoading(btn) {
  if (!btn) return;
  btn._origText = btn.textContent; btn.disabled = true; btn.style.opacity = '0.6';
}
function btnReset(btn) {
  if (!btn) return;
  btn.disabled = false; btn.style.opacity = '';
  if (btn._origText) btn.textContent = btn._origText;
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

function setupAdminPanel(app, db, churches, resellerSystem, opts = {}) {
  const ADMIN_UI_URL = (process.env.ADMIN_UI_URL || 'https://tallyconnect.app/admin').trim();

  // ── Session middleware ────────────────────────────────────────────────────

  function requireAdminSession(req, res, next) {
    // Allow programmatic access via x-api-key header (timing-safe comparison to prevent brute-force timing attacks)
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const expected = process.env.ADMIN_API_KEY || '';
      if (expected) {
        // Use HMAC to normalize both values to equal length before timingSafeEqual
        const hmac = k => crypto.createHmac('sha256', 'admin-key-compare').update(k).digest();
        if (crypto.timingSafeEqual(hmac(apiKey), hmac(expected))) return next();
      }
    }

    const payload = getSession(req);
    if (payload && payload.role === 'admin') {
      // Verify the admin is still active in the DB; reject if userId is absent (can't verify)
      if (!payload.userId) {
        const isApi = req.path.startsWith('/api/');
        if (isApi) return res.status(401).json({ error: 'Session missing user identity — re-authenticate' });
        return res.redirect('/admin/login');
      }
      const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ? AND active = 1').get(payload.userId);
      if (!user) {
        const isApi = req.path.startsWith('/api/');
        if (isApi) return res.status(401).json({ error: 'Account deactivated or not found' });
        return res.redirect('/admin/login');
      }
      req.adminUser = { id: user.id, email: user.email, name: user.name, role: user.role };
      return next();
    }

    // JWT Bearer token fallback (tally-landing proxy sends this)
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ') && opts.jwt && opts.JWT_SECRET) {
      try {
        const jwtPayload = opts.jwt.verify(authHeader.slice(7), opts.JWT_SECRET);
        if (jwtPayload.type === 'admin') {
          // Verify still active in DB
          const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ? AND active = 1').get(jwtPayload.userId);
          if (!user) {
            const isApi = req.path.startsWith('/api/');
            if (isApi) return res.status(401).json({ error: 'Account deactivated or not found' });
            return res.redirect('/admin/login');
          }
          req.adminUser = { id: user.id, email: user.email, name: user.name, role: user.role };
          return next();
        }
      } catch { /* fall through to 401 */ }
    }

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

  // Canonical admin UI is hosted on Vercel. Relay serves APIs only.
  app.all(['/admin', '/admin/*'], (req, res) => {
    res.redirect(302, ADMIN_UI_URL);
  });

  // ── Audit helper ─────────────────────────────────────────────────────────
  const _logAudit = opts.logAudit || (() => {});
  function auditFromReq(req, action, targetType, targetId, details) {
    const session = getSession(req);
    const admin = req.adminUser || session || {};
    _logAudit({
      adminUserId: admin.userId || admin.id || null,
      adminEmail: admin.email || 'api-key',
      action, targetType, targetId, details,
      ip: req.ip,
    });
  }

  // ── Admin API ─────────────────────────────────────────────────────────────

  app.get('/api/admin/overview', requireAdminSession, (req, res) => {
    const totalChurches = db.prepare('SELECT COUNT(*) AS cnt FROM churches').get().cnt;
    const totalResellers = db.prepare('SELECT COUNT(*) AS cnt FROM resellers WHERE active=1').get().cnt;
    const onlineNow = Array.from(churches.values()).filter(c => c.sockets?.size && [...c.sockets.values()].some(s => s.readyState === WebSocket.OPEN)).length;
    let activeAlerts = 0;
    try {
      activeAlerts = db.prepare(
        "SELECT COUNT(*) AS cnt FROM alerts WHERE datetime(created_at) > datetime('now','-24 hours')"
      ).get()?.cnt || 0;
    } catch { /* alerts table may not exist */ }
    let openTickets = 0;
    try {
      openTickets = db.prepare(
        "SELECT COUNT(*) AS cnt FROM support_tickets WHERE status IN ('open','in_progress')"
      ).get()?.cnt || 0;
    } catch { /* support_tickets table may not exist */ }
    let mrr = 0;
    try {
      mrr = db.prepare(
        "SELECT COALESCE(SUM(amount),0) AS total FROM billing WHERE status='active'"
      ).get()?.total || 0;
    } catch { /* billing table may not exist */ }
    res.json({ totalChurches, onlineNow, totalResellers, activeAlerts, openTickets, mrr });
  });

  app.get('/api/admin/churches', requireAdminSession, (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const total = db.prepare('SELECT COUNT(*) AS cnt FROM churches').get().cnt;
    const rows  = db.prepare('SELECT * FROM churches ORDER BY registeredAt DESC LIMIT ? OFFSET ?').all(limit, offset);

    // Pre-fetch room counts for all churches in this page
    const roomCountStmt = db.prepare('SELECT COUNT(*) AS cnt FROM rooms WHERE campus_id = ? AND deleted_at IS NULL');

    const list = rows.map(row => {
      const runtime = churches.get(row.churchId);
      let roomCount = 0;
      try { roomCount = roomCountStmt.get(row.churchId)?.cnt || 0; } catch { /* rooms table may not exist */ }
      return {
        churchId:         row.churchId,
        name:             row.name,
        email:            row.email || '',
        token:            row.token,
        church_type:      row.church_type || 'recurring',
        reseller_id:      row.reseller_id || null,
        audio_via_atem:   row.audio_via_atem || 0,
        registeredAt:     row.registeredAt,
        connected:        runtime?.ws?.readyState === WebSocket.OPEN,
        status:           runtime?.status || { connected: false },
        lastSeen:         runtime?.lastSeen || null,
        registrationCode: row.registration_code || null,
        roomCount,
      };
    });
    res.json({ churches: list, total, page, limit, pages: Math.ceil(total / limit) });
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
        status: {},
        lastSeen: null, lastHeartbeat: null, registeredAt, disconnectedAt: null,
        _offlineAlertSent: false, church_type: type || 'recurring',
        event_expires_at: null, event_label: null, reseller_id: resellerId || null,
      });
      auditFromReq(req, 'church_created', 'church', churchId, { name, type: type || 'recurring' });
      res.json({ churchId, name, token, registeredAt });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.put('/api/admin/churches/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const church = churches.get(id);
    if (!church && !db.prepare('SELECT churchId FROM churches WHERE churchId=?').get(id)) {
      return res.status(404).json({ error: 'Church not found' });
    }
    const allowedColumns = ['name', 'email', 'church_type', 'reseller_id', 'audio_via_atem'];
    const { name, email, type, resellerId, audioViaAtem } = req.body;
    const updates = [];
    const vals = [];
    if (name !== undefined && allowedColumns.includes('name')) { updates.push('name=?'); vals.push(name); }
    if (email !== undefined && allowedColumns.includes('email')) { updates.push('email=?'); vals.push(email); }
    if (type !== undefined && allowedColumns.includes('church_type')) { updates.push('church_type=?'); vals.push(type); }
    if (resellerId !== undefined && allowedColumns.includes('reseller_id')) { updates.push('reseller_id=?'); vals.push(resellerId || null); }
    if (audioViaAtem !== undefined && allowedColumns.includes('audio_via_atem')) { updates.push('audio_via_atem=?'); vals.push(audioViaAtem ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(id);
    db.prepare(`UPDATE churches SET ${updates.join(',')} WHERE churchId=?`).run(...vals);
    if (church) {
      if (name !== undefined) church.name = name;
      if (email !== undefined) church.email = email;
      if (type !== undefined) church.church_type = type;
      if (resellerId !== undefined) church.reseller_id = resellerId || null;
      if (audioViaAtem !== undefined) church.audio_via_atem = audioViaAtem ? 1 : 0;
    }
    auditFromReq(req, 'church_updated', 'church', id, { name, email, type, resellerId, audioViaAtem });
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
      auditFromReq(req, 'token_regenerated', 'church', id, { name: row.name });
      res.json({ token });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  app.delete('/api/admin/churches/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = db.prepare('SELECT * FROM churches WHERE churchId=?').get(id);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    const church = churches.get(id);
    if (church?.sockets?.size) {
      for (const sock of church.sockets.values()) {
        if (sock.readyState === WebSocket.OPEN) sock.close(1000, 'deleted by admin');
      }
    }

    // Cascade-delete all related records via explicit allowlist (no dynamic SQL)
    const ALLOWED_CASCADE_DELETES = [
      { table: 'chat_messages', column: 'churchId' },
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
      { table: 'viewer_snapshots', column: 'church_id' },
      { table: 'audit_log', column: 'target_id' },
      { table: 'ai_usage_log', column: 'church_id' },
      { table: 'onboarding_sessions', column: 'church_id' },
      { table: 'automation_rules', column: 'church_id' },
      { table: 'church_documents', column: 'church_id' },
      { table: 'church_macros', column: 'church_id' },
      { table: 'rooms', column: 'campus_id' },
      { table: 'billing_customers', column: 'church_id' },
      { table: 'billing_disputes', column: 'church_id' },
      { table: 'service_sessions', column: 'church_id' },
      { table: 'service_events', column: 'church_id' },
      { table: 'diagnostic_bundles', column: 'church_id' },
      { table: 'rundowns', column: 'church_id' },
      { table: 'rundown_items', column: 'church_id' },
    ];
    try {
      const tx = db.transaction((churchId) => {
        for (const { table, column } of ALLOWED_CASCADE_DELETES) {
          try {
            db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(churchId);
          } catch { /* table may not exist */ }
        }
        db.prepare('DELETE FROM churches WHERE churchId = ?').run(churchId);
      });
      tx(id);
    } catch (e) {
      return res.status(500).json({ error: safeErrorMessage(e, 'Failed to delete church') });
    }

    churches.delete(id);
    auditFromReq(req, 'church_deleted', 'church', id, { name: row.name });
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
      auditFromReq(req, 'reseller_updated', 'reseller', id, { fields: Object.keys(patch) });
      res.json({ updated: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
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
    auditFromReq(req, 'reseller_password_reset', 'reseller', id, {});
    res.json({ updated: true });
  });

  app.delete('/api/admin/resellers/:id', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = resellerSystem.getResellerById(id);
    if (!row) return res.status(404).json({ error: 'Reseller not found' });
    db.prepare('UPDATE resellers SET active=0 WHERE id=?').run(id);
    auditFromReq(req, 'reseller_deactivated', 'reseller', id, { name: row.name });
    res.json({ deactivated: true });
  });

  app.post('/api/admin/change-password', requireAdminSession, (req, res) => {
    const { currentPassword, newPassword, password } = req.body;
    const newPw = newPassword || password;
    if (!newPw || newPw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Require a known user ID — only available when authenticated via JWT Bearer
    const userId = req.adminUser?.id;
    if (!userId) return res.status(400).json({ error: 'Cannot identify admin user. Authenticate with a JWT Bearer token.' });

    const user = db.prepare('SELECT password_hash FROM admin_users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: 'Admin user not found' });

    // Verify current password before allowing a change
    if (!currentPassword) return res.status(400).json({ error: 'currentPassword required' });
    if (!verifyPortalPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const newHash = hashPortalPassword(newPw);
    db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(newHash, new Date().toISOString(), userId);

    auditFromReq(req, 'admin_password_changed', 'admin_user', userId, {});
    res.json({ updated: true });
  });

  // ── Alerts API ─────────────────────────────────────────────────────────────

  app.get('/api/admin/alerts', requireAdminSession, (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const severity = req.query.severity;
      const church = req.query.church;
      const acknowledged = req.query.acknowledged;

      let sql = `SELECT a.*, c.name as church_name FROM alerts a LEFT JOIN churches c ON a.church_id = c.churchId`;
      const conditions = [];
      const params = [];

      if (severity && severity !== 'all') { conditions.push('a.severity = ?'); params.push(severity); }
      if (church) { conditions.push('c.name LIKE ?'); params.push('%' + church + '%'); }
      if (acknowledged === 'false') { conditions.push('a.acknowledged_at IS NULL'); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY a.created_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      res.json(rows);
    } catch(e) {
      // alerts table may not exist yet
      res.json([]);
    }
  });

  app.post('/api/admin/alerts/:id/acknowledge', requireAdminSession, (req, res) => {
    try {
      const { id } = req.params;
      const ackBy = req.adminUser?.name || req.adminUser?.email || 'admin';
      db.prepare('UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ?')
        .run(new Date().toISOString(), ackBy, id);
      auditFromReq(req, 'alert_acknowledged', 'alert', id, {});
      res.json({ acknowledged: true });
    } catch(e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Tickets API (proxy for admin) ──────────────────────────────────────────

  app.get('/api/admin/tickets', requireAdminSession, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT t.*, c.name as church_name FROM support_tickets t LEFT JOIN churches c ON t.church_id = c.churchId ORDER BY t.created_at DESC LIMIT 200`
      ).all();
      // Try to load updates for each ticket
      rows.forEach(t => {
        try {
          t.updates = db.prepare('SELECT * FROM ticket_updates WHERE ticket_id = ? ORDER BY created_at ASC').all(t.id);
        } catch { t.updates = []; }
      });
      res.json(rows);
    } catch(e) {
      // support_tickets table may not exist
      res.json([]);
    }
  });

  // ── Billing API (proxy for admin) ──────────────────────────────────────────

  app.get('/api/admin/billing', requireAdminSession, (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT b.*, c.name as church_name FROM billing b LEFT JOIN churches c ON b.church_id = c.churchId ORDER BY b.created_at DESC`
      ).all();
      res.json(rows);
    } catch(e) {
      // billing table may not exist
      res.json([]);
    }
  });

  // ── Audit Log API ──────────────────────────────────────────────────────────

  app.get('/api/admin/audit-log', requireAdminSession, (req, res) => {
    try {
      const page       = Math.max(1, parseInt(req.query.page)  || 1);
      const limit      = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset     = (page - 1) * limit;
      const action     = req.query.action     || null;
      const adminEmail = req.query.adminEmail || null;
      const from       = req.query.from       || null;
      const to         = req.query.to         || null;

      let where = [];
      const params = [];
      if (action)     { where.push('action = ?');           params.push(action); }
      if (adminEmail) { where.push('admin_email LIKE ?');   params.push('%' + adminEmail + '%'); }
      if (from)       { where.push('created_at >= ?');      params.push(from); }
      if (to)         { where.push('created_at <= ?');      params.push(to); }

      const whereClause = where.length ? ' WHERE ' + where.join(' AND ') : '';
      const total = db.prepare(`SELECT COUNT(*) AS cnt FROM audit_log${whereClause}`).get(...params).cnt;
      const logs  = db.prepare(`SELECT * FROM audit_log${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
                      .all(...params, limit, offset);

      res.json({ logs, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e, 'Failed to load audit log') });
    }
  });

  // AI usage endpoint moved to server.js (uses requireAdminJwt for tally-landing proxy compatibility)

  // ── Admin Church Support View (Quick Actions) ─────────────────────────────

  const { computeHealthScore } = require('./healthScore');
  const chatEngine = opts.chatEngine || null;

  const ALLOWED_ADMIN_COMMANDS = new Set([
    'restart_stream', 'stop_stream', 'start_recording', 'stop_recording',
    'reconnect_obs', 'reconnect_atem', 'reconnect_encoder', 'restart_encoder',
    'system.diagnosticBundle', 'system.preServiceCheck',
  ]);

  // GET /api/admin/church/:churchId/support-view
  // Returns a comprehensive support view for a single church.
  app.get('/api/admin/church/:churchId/support-view', requireAdminSession, (req, res) => {
    const { churchId } = req.params;
    const churchRow = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!churchRow) return res.status(404).json({ error: 'Church not found' });

    const runtime = churches.get(churchId);
    const online = !!(runtime?.sockets?.size && [...runtime.sockets.values()].some(s => s.readyState === WebSocket.OPEN));

    // ── Church info ──
    const church = {
      id: churchRow.churchId,
      name: churchRow.name,
      plan: churchRow.plan || null,
      billing_status: churchRow.billing_status || null,
      timezone: churchRow.timezone || null,
      setup_complete: !!churchRow.setup_complete,
      church_type: churchRow.church_type || 'recurring',
      event_expires_at: churchRow.event_expires_at || null,
      event_label: churchRow.event_label || null,
      portal_email: churchRow.portal_email || null,
      registration_code: churchRow.registration_code || null,
      referral_code: churchRow.referral_code || null,
      referred_by: churchRow.referred_by || null,
      registeredAt: churchRow.registeredAt || null,
      email: churchRow.email || null,
      reseller_id: churchRow.reseller_id || null,
      slack_channel: churchRow.slack_channel || null,
      audio_via_atem: !!churchRow.audio_via_atem,
      schedule: churchRow.schedule ? JSON.parse(churchRow.schedule) : null,
    };

    // ── Billing ──
    let billing = null;
    try {
      billing = db.prepare(
        `SELECT tier, status, billing_interval, trial_ends_at, current_period_end,
                cancel_at_period_end, stripe_customer_id, stripe_subscription_id, created_at
         FROM billing_customers WHERE church_id = ? LIMIT 1`
      ).get(churchId) || null;
    } catch { /* table may not exist */ }

    // ── Onboarding milestones ──
    const onboarding = {
      app_connected: churchRow.onboarding_app_connected_at || null,
      atem_connected: churchRow.onboarding_atem_connected_at || null,
      first_session: churchRow.onboarding_first_session_at || null,
      telegram: churchRow.onboarding_telegram_registered_at || null,
      failover_tested: churchRow.onboarding_failover_tested_at || null,
      team_invited: churchRow.onboarding_team_invited_at || null,
    };

    // ── Integrations ──
    const integrations = {
      planningCenter: !!churchRow.planning_center_token,
      youtube: !!churchRow.youtube_refresh_token,
      facebook: !!churchRow.facebook_page_token,
      vimeo: !!churchRow.vimeo_access_token,
    };

    // ── Status ──
    const deviceStatus = runtime?.status || {};
    const connectedDevices = {
      atem: !!deviceStatus.atem?.connected,
      obs: !!deviceStatus.obs?.connected,
      vmix: !!deviceStatus.vmix?.connected,
      companion: !!deviceStatus.companion?.connected,
      encoders: Array.isArray(deviceStatus.encoders) ? deviceStatus.encoders : [],
      mixers: Array.isArray(deviceStatus.mixers) ? deviceStatus.mixers : [],
      ptz: Array.isArray(deviceStatus.ptz) ? deviceStatus.ptz : [],
      hyperdecks: Array.isArray(deviceStatus.hyperdecks) ? deviceStatus.hyperdecks : [],
      videoHubs: Array.isArray(deviceStatus.videoHubs) ? deviceStatus.videoHubs : [],
    };

    let currentSession = null;
    try {
      const activeSession = db.prepare(
        "SELECT * FROM service_sessions WHERE church_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
      ).get(churchId);
      if (activeSession) {
        const startTime = new Date(activeSession.started_at).getTime();
        currentSession = {
          active: true,
          startTime: activeSession.started_at,
          duration: Math.floor((Date.now() - startTime) / 1000),
        };
      }
    } catch { /* table may not exist */ }

    const streamActive = !!deviceStatus.streaming || !!deviceStatus.obs?.streaming;

    const status = {
      online,
      lastHeartbeat: runtime?.lastHeartbeat || null,
      connectedDevices,
      currentSession,
      streamActive,
    };

    // ── Health Score ──
    let healthScore = { score: 100, breakdown: {}, trend: 'stable' };
    try {
      healthScore = computeHealthScore(db, churchId);
    } catch { /* tables may not exist */ }

    // ── Recent Alerts (last 20) ──
    let recentAlerts = [];
    try {
      recentAlerts = db.prepare(
        `SELECT id, alert_type, severity, created_at, acknowledged_at, resolved
         FROM alerts WHERE church_id = ?
         ORDER BY created_at DESC LIMIT 20`
      ).all(churchId).map(row => ({
        id: row.id,
        type: row.alert_type,
        severity: row.severity,
        timestamp: row.created_at,
        resolved: !!row.resolved,
      }));
    } catch { /* alerts table may not exist */ }

    // ── Recent Sessions (last 5) ──
    let recentSessions = [];
    try {
      recentSessions = db.prepare(
        `SELECT id, started_at, ended_at, duration_minutes, alert_count, grade
         FROM service_sessions WHERE church_id = ?
         ORDER BY started_at DESC LIMIT 5`
      ).all(churchId).map(row => ({
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        duration: row.duration_minutes,
        alerts: row.alert_count || 0,
        grade: row.grade || null,
      }));
    } catch { /* table may not exist */ }

    // ── Recent Tickets (last 5) ──
    let recentTickets = [];
    try {
      recentTickets = db.prepare(
        `SELECT id, title, status, severity, issue_category, created_at
         FROM support_tickets WHERE church_id = ?
         ORDER BY created_at DESC LIMIT 5`
      ).all(churchId);
    } catch { /* table may not exist */ }

    // ── Last Diagnostic Bundle ──
    let lastDiagnosticBundle = null;
    try {
      const bundle = db.prepare(
        `SELECT created_at, summary FROM diagnostic_bundles WHERE church_id = ? ORDER BY created_at DESC LIMIT 1`
      ).get(churchId);
      if (bundle) {
        lastDiagnosticBundle = { timestamp: bundle.created_at, summary: bundle.summary || null };
      }
    } catch { /* table may not exist */ }

    // ── Chat History (last 20 messages) ──
    let chatHistory = [];
    try {
      if (chatEngine) {
        chatHistory = chatEngine.getMessages(churchId, { limit: 20 });
      } else {
        chatHistory = db.prepare(
          `SELECT * FROM chat_messages WHERE church_id = ? ORDER BY timestamp DESC LIMIT 20`
        ).all(churchId).reverse();
      }
    } catch { /* table may not exist */ }

    // ── Config summary ──
    let config = { autoRecovery: false, failover: false, failoverAction: null, autoPilotRulesCount: 0 };
    try {
      config.autoRecovery = churchRow.auto_recovery_enabled === 1 || churchRow.auto_recovery_enabled === '1';
      config.failover = churchRow.failover_enabled === 1 || churchRow.failover_enabled === '1';
      config.failoverAction = churchRow.failover_action || null;
    } catch { /* column may not exist */ }
    try {
      const apCount = db.prepare('SELECT COUNT(*) as cnt FROM automation_rules WHERE church_id = ?').get(churchId);
      config.autoPilotRulesCount = apCount?.cnt || 0;
    } catch { /* table may not exist */ }

    // ── TDs ──
    let tds = [];
    try {
      tds = db.prepare('SELECT id, name, email, access_level, created_at FROM church_tds WHERE church_id = ?').all(churchId);
    } catch { /* table may not exist */ }

    // ── Rooms + per-instance status ──
    let rooms = [];
    try {
      rooms = db.prepare(
        'SELECT id, name FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name'
      ).all(churchId);
    } catch { /* rooms table may not exist */ }

    // Build per-instance status map for multi-room support
    const instanceStatusMap = {};
    if (runtime?.instanceStatus) {
      for (const [instName, instStatus] of Object.entries(runtime.instanceStatus)) {
        instanceStatusMap[instName] = {
          online: true,
          connectedDevices: {
            atem: !!instStatus.atem?.connected,
            obs: !!instStatus.obs?.connected,
            vmix: !!instStatus.vmix?.connected,
            companion: !!instStatus.companion?.connected,
            encoders: Array.isArray(instStatus.encoders) ? instStatus.encoders : [],
            mixers: Array.isArray(instStatus.mixers) ? instStatus.mixers : [],
            ptz: Array.isArray(instStatus.ptz) ? instStatus.ptz : [],
            hyperdecks: Array.isArray(instStatus.hyperdecks) ? instStatus.hyperdecks : [],
            videoHubs: Array.isArray(instStatus.videoHubs) ? instStatus.videoHubs : [],
          },
          streamActive: !!instStatus.streaming || !!instStatus.obs?.streaming,
        };
      }
    }

    const roomInstanceMap = runtime?.roomInstanceMap || {};

    res.json({
      church,
      status,
      healthScore,
      billing,
      onboarding,
      integrations,
      recentAlerts,
      recentSessions,
      recentTickets,
      lastDiagnosticBundle,
      chatHistory,
      config,
      tds,
      rooms,
      instanceStatusMap,
      roomInstanceMap,
    });
  });

  // GET /api/admin/church/:churchId/rooms
  // Returns rooms for a church plus runtime instance mapping.
  app.get('/api/admin/church/:churchId/rooms', requireAdminSession, (req, res) => {
    const { churchId } = req.params;
    let rooms = [];
    try {
      rooms = db.prepare(
        'SELECT id, name FROM rooms WHERE campus_id = ? AND deleted_at IS NULL ORDER BY name'
      ).all(churchId);
    } catch { /* rooms table may not exist */ }
    const runtime = churches.get(churchId);
    const roomInstanceMap = runtime?.roomInstanceMap || {};
    res.json({ rooms, roomInstanceMap });
  });

  // POST /api/admin/church/:churchId/send-command
  // Sends an allowed command to the church client via WebSocket.
  app.post('/api/admin/church/:churchId/send-command', requireAdminSession, (req, res) => {
    const { churchId } = req.params;
    const { command, params } = req.body || {};

    if (!command) return res.status(400).json({ error: 'command required' });
    if (!ALLOWED_ADMIN_COMMANDS.has(command)) {
      return res.status(400).json({ error: `Unknown command: ${command}. Allowed: ${[...ALLOWED_ADMIN_COMMANDS].join(', ')}` });
    }

    const churchRow = db.prepare('SELECT churchId FROM churches WHERE churchId = ?').get(churchId);
    if (!churchRow) return res.status(404).json({ error: 'Church not found' });

    const runtime = churches.get(churchId);
    const openSockets = [];
    if (runtime?.sockets?.size) {
      for (const sock of runtime.sockets.values()) {
        if (sock.readyState === WebSocket.OPEN) openSockets.push(sock);
      }
    }
    if (openSockets.length === 0) {
      return res.status(409).json({ error: 'Church client is not connected' });
    }

    const commandId = uuidv4();
    const payload = JSON.stringify({
      type: 'command',
      id: commandId,
      command,
      params: params || {},
      source: 'admin',
    });
    try {
      for (const sock of openSockets) sock.send(payload);
      auditFromReq(req, 'admin_command_sent', 'church', churchId, { command, commandId });
      res.json({ sent: true, commandId });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e, 'Failed to send command') });
    }
  });

  // POST /api/admin/church/:churchId/send-message
  // Pushes a support message to the church's app and/or Telegram.
  app.post('/api/admin/church/:churchId/send-message', requireAdminSession, (req, res) => {
    const { churchId } = req.params;
    const { message, targets } = req.body || {};

    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const churchRow = db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(churchId);
    if (!churchRow) return res.status(404).json({ error: 'Church not found' });

    const targetList = Array.isArray(targets) ? targets : ['app'];
    const adminName = req.adminUser?.name || req.adminUser?.email || 'Admin';

    // Save to chat via chatEngine if available
    let savedMessage = null;
    try {
      if (chatEngine) {
        savedMessage = chatEngine.saveMessage({
          churchId,
          senderName: adminName,
          senderRole: 'admin',
          source: 'dashboard',
          message: message.trim(),
        });
        // Broadcast to app & telegram via chatEngine broadcasters
        chatEngine.broadcastChat(savedMessage);
      } else {
        // Fallback: send directly via WebSocket to all church instances
        const runtime = churches.get(churchId);
        if (targetList.includes('app') && runtime?.sockets?.size) {
          const payload = JSON.stringify({
            type: 'admin_message',
            message: message.trim(),
            senderName: adminName,
            timestamp: new Date().toISOString(),
          });
          for (const sock of runtime.sockets.values()) {
            if (sock.readyState === WebSocket.OPEN) sock.send(payload);
          }
        }
      }
    } catch (e) {
      return res.status(500).json({ error: safeErrorMessage(e, 'Failed to send message') });
    }

    auditFromReq(req, 'admin_message_sent', 'church', churchId, { targets: targetList });
    res.json({ sent: true, messageId: savedMessage?.id || null, targets: targetList });
  });

  // GET /api/admin/churches/support-overview
  // Quick dashboard of all churches sorted by "needs attention".
  app.get('/api/admin/churches/support-overview', requireAdminSession, (req, res) => {
    const rows = db.prepare('SELECT * FROM churches').all();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const now = Date.now();

    const churchList = rows.map(row => {
      const runtime = churches.get(row.churchId);
      const online = !!(runtime?.sockets?.size && [...runtime.sockets.values()].some(s => s.readyState === WebSocket.OPEN));

      // Health score
      let score = null;
      try {
        const hs = computeHealthScore(db, row.churchId);
        score = hs.score;
      } catch { /* tables may not exist */ }

      // Active alerts count
      let activeAlerts = 0;
      try {
        activeAlerts = db.prepare(
          "SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND resolved = 0"
        ).get(row.churchId)?.cnt || 0;
      } catch { /* table may not exist */ }

      // Has unresolved critical alerts
      let hasCriticalAlerts = false;
      try {
        const crit = db.prepare(
          "SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND resolved = 0 AND severity = 'critical'"
        ).get(row.churchId);
        hasCriticalAlerts = (crit?.cnt || 0) > 0;
      } catch { /* table may not exist */ }

      // Open support tickets
      let hasOpenTickets = false;
      try {
        const ot = db.prepare(
          "SELECT COUNT(*) as cnt FROM support_tickets WHERE church_id = ? AND status IN ('open','in_progress')"
        ).get(row.churchId);
        hasOpenTickets = (ot?.cnt || 0) > 0;
      } catch { /* table may not exist */ }

      // Last session
      let lastSession = null;
      try {
        const ls = db.prepare(
          'SELECT started_at FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 1'
        ).get(row.churchId);
        lastSession = ls?.started_at || null;
      } catch { /* table may not exist */ }

      // Offline duration check
      const offlineTooLong = !online && runtime?.lastSeen
        ? (now - new Date(runtime.lastSeen).getTime()) > TWO_HOURS_MS
        : !online;

      // Determine needsAttention
      let needsAttention = false;
      let attentionReason = '';
      if (offlineTooLong) {
        needsAttention = true;
        attentionReason = 'Offline for more than 2 hours';
      } else if (score !== null && score < 70) {
        needsAttention = true;
        attentionReason = `Low health score: ${score}`;
      } else if (hasCriticalAlerts) {
        needsAttention = true;
        attentionReason = 'Unresolved critical alerts';
      } else if (hasOpenTickets) {
        needsAttention = true;
        attentionReason = 'Open support tickets';
      }

      return {
        id: row.churchId,
        name: row.name,
        online,
        healthScore: score,
        activeAlerts,
        lastSession,
        needsAttention,
        attentionReason,
      };
    });

    // Sort: offline first, then lowest health score, then most active alerts
    churchList.sort((a, b) => {
      // Offline first
      if (a.online !== b.online) return a.online ? 1 : -1;
      // Lowest health score first
      if (a.healthScore !== b.healthScore) return a.healthScore - b.healthScore;
      // Most active alerts first
      return b.activeAlerts - a.activeAlerts;
    });

    res.json({ churches: churchList });
  });

  // ── Email Dashboard API ────────────────────────────────────────────────────

  const { lifecycleEmails } = opts;

  app.get('/api/admin/emails', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.json({ rows: [], total: 0 });
    const { limit, offset, type, search } = req.query;
    const result = lifecycleEmails.getEmailHistory({
      limit: Math.min(parseInt(limit) || 50, 200),
      offset: parseInt(offset) || 0,
      emailType: type || undefined,
      churchId: undefined,
    });

    // Client-side search filter by church name
    if (search) {
      const q = String(search).toLowerCase();
      result.rows = result.rows.filter(r => (r.church_name || '').toLowerCase().includes(q) || (r.recipient || '').toLowerCase().includes(q));
      result.total = result.rows.length;
    }

    res.json(result);
  });

  app.get('/api/admin/emails/stats', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.json({ total: 0, today: 0, thisWeek: 0, byType: [] });
    res.json(lifecycleEmails.getEmailStats());
  });

  app.get('/api/admin/emails/templates', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.json([]);
    res.json(lifecycleEmails.getTemplateList());
  });

  app.get('/api/admin/emails/templates/:type/preview', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.status(500).json({ error: 'Email system not available' });
    const result = lifecycleEmails.getPreview(req.params.type);
    if (result.error) return res.status(404).json(result);
    res.json(result);
  });

  app.put('/api/admin/emails/templates/:type', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.status(500).json({ error: 'Email system not available' });
    const { subject, html } = req.body || {};
    if (!subject && !html) return res.status(400).json({ error: 'subject or html required' });
    const result = lifecycleEmails.applyOverride(req.params.type, { subject, html });
    res.json(result);
  });

  app.delete('/api/admin/emails/templates/:type', requireAdminSession, (req, res) => {
    if (!lifecycleEmails) return res.status(500).json({ error: 'Email system not available' });
    lifecycleEmails.removeOverride(req.params.type);
    res.json({ reverted: true });
  });

  app.post('/api/admin/emails/send', requireAdminSession, async (req, res) => {
    if (!lifecycleEmails) return res.status(500).json({ error: 'Email system not available' });
    const { churchId, emailType, to, subject, html } = req.body || {};

    // If emailType provided, get the template preview for that type
    if (emailType && !html) {
      const preview = lifecycleEmails.getPreview(emailType.replace(/^manual:/, ''));
      const recipient = to || (() => {
        if (!churchId) return null;
        const c = db.prepare('SELECT portal_email FROM churches WHERE churchId = ?').get(churchId);
        return c?.portal_email;
      })();

      if (!recipient) return res.json({ sent: false, reason: 'no-recipient' });

      const result = await lifecycleEmails.sendManual({
        churchId: churchId || 'admin',
        emailType: emailType.replace(/^manual:/, ''),
        to: recipient,
        subject: preview.subject,
        html: preview.html,
        text: preview.text || '',
      });
      if (result?.sent) auditFromReq(req, 'email_sent', 'church', churchId || null, { emailType, to: recipient });
      return res.json(result);
    }

    // Custom email
    if (!to) return res.status(400).json({ error: 'recipient (to) required' });
    if (!subject) return res.status(400).json({ error: 'subject required' });
    if (!html) return res.status(400).json({ error: 'html body required' });

    const result = await lifecycleEmails.sendManual({
      churchId: churchId || 'admin',
      emailType: 'custom',
      to,
      subject,
      html,
      text: '',
    });
    if (result?.sent) auditFromReq(req, 'email_sent', 'church', churchId || null, { emailType: 'custom', to, subject });
    res.json(result);
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
    const payload = { role: 'reseller', resellerId: reseller.id, exp: Date.now() + COOKIE_MAX_AGE * 1000 };
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
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Portal account update — uses cookie auth, no API key needed in client-side JS
  app.put('/api/portal/account', requireResellerSession, (req, res) => {
    try {
      const { brand_name, support_email, logo_url, primary_color } = req.body;
      const patch = {};
      if (brand_name !== undefined) patch.brand_name = brand_name;
      if (support_email !== undefined) patch.support_email = support_email;
      if (logo_url !== undefined) patch.logo_url = logo_url;
      if (primary_color !== undefined) patch.primary_color = sanitizeColor(primary_color);
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
      const fields = Object.keys(patch);
      const setClauses = fields.map(f => `${f}=?`).join(',');
      const vals = [...fields.map(f => patch[f]), req.reseller.id];
      db.prepare(`UPDATE resellers SET ${setClauses} WHERE id=?`).run(...vals);
      res.json({ updated: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
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

module.exports = { setupAdminPanel, _buildAdminDashboardHtml: buildAdminDashboardHtml, _buildAdminLoginHtml: buildAdminLoginHtml };
