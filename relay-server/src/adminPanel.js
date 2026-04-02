'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { WebSocket } = require('ws');
const { hasOpenSocket } = require('./runtimeSockets');

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
  // Admin SPA is now served as static files from public/admin/ (express.static
  // in server.js) with an SPA fallback route. No redirect needed.

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
    // Trend: previous 24h alerts (24-48h ago)
    let prevAlerts = 0;
    try {
      prevAlerts = db.prepare(
        "SELECT COUNT(*) AS cnt FROM alerts WHERE datetime(created_at) > datetime('now','-48 hours') AND datetime(created_at) <= datetime('now','-24 hours')"
      ).get()?.cnt || 0;
    } catch { /* alerts table may not exist */ }

    // Trend: online count 24h ago approximation (use 7-day avg of churches connected at any point)
    let prevOnline = null;
    try {
      // Use the average of churches that had heartbeats in the 24-48h window
      const prevOnlineCount = db.prepare(
        "SELECT COUNT(DISTINCT church_id) AS cnt FROM service_sessions WHERE datetime(started_at) > datetime('now','-48 hours') AND datetime(started_at) <= datetime('now','-24 hours')"
      ).get()?.cnt;
      if (prevOnlineCount !== undefined) prevOnline = prevOnlineCount;
    } catch { /* table may not exist */ }

    res.json({ totalChurches, onlineNow, totalResellers, activeAlerts, openTickets, mrr, prevAlerts, prevOnline });
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
        connected:        hasOpenSocket(runtime, WebSocket.OPEN),
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
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      const severity = req.query.severity;
      const church = req.query.church;
      const acknowledged = req.query.acknowledged;

      let whereSql = '';
      const conditions = [];
      const params = [];

      if (severity && severity !== 'all') { conditions.push('a.severity = ?'); params.push(severity); }
      if (church) { conditions.push('c.name LIKE ?'); params.push('%' + church + '%'); }
      if (acknowledged === 'false') { conditions.push('a.acknowledged_at IS NULL'); }
      if (conditions.length) whereSql = ' WHERE ' + conditions.join(' AND ');

      const total = db.prepare(`SELECT COUNT(*) AS cnt FROM alerts a LEFT JOIN churches c ON a.church_id = c.churchId${whereSql}`).get(...params).cnt;
      const rows = db.prepare(`SELECT a.*, c.name as church_name FROM alerts a LEFT JOIN churches c ON a.church_id = c.churchId${whereSql} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      res.json({ alerts: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch(e) {
      // alerts table may not exist yet
      res.json({ alerts: [], total: 0, page: 1, limit: 50, pages: 0 });
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
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const total = db.prepare('SELECT COUNT(*) AS cnt FROM support_tickets').get().cnt;
      const rows = db.prepare(
        `SELECT t.*, c.name as church_name FROM support_tickets t LEFT JOIN churches c ON t.church_id = c.churchId ORDER BY t.created_at DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);
      // Try to load updates for each ticket
      rows.forEach(t => {
        try {
          t.updates = db.prepare('SELECT * FROM ticket_updates WHERE ticket_id = ? ORDER BY created_at ASC').all(t.id);
        } catch { t.updates = []; }
      });
      res.json({ tickets: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch(e) {
      // support_tickets table may not exist
      res.json({ tickets: [], total: 0, page: 1, limit: 50, pages: 0 });
    }
  });

  // ── Billing API (proxy for admin) ──────────────────────────────────────────

  app.get('/api/admin/billing', requireAdminSession, (req, res) => {
    try {
      const page  = Math.max(1, parseInt(req.query.page)  || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      const total = db.prepare('SELECT COUNT(*) AS cnt FROM billing').get().cnt;
      const rows = db.prepare(
        `SELECT b.*, c.name as church_name FROM billing b LEFT JOIN churches c ON b.church_id = c.churchId ORDER BY b.created_at DESC LIMIT ? OFFSET ?`
      ).all(limit, offset);
      res.json({ subscriptions: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch(e) {
      // billing table may not exist
      res.json({ subscriptions: [], total: 0, page: 1, limit: 50, pages: 0 });
    }
  });

  // ── Billing Analytics API ─────────────────────────────────────────────────

  app.get('/api/admin/billing/analytics', requireAdminSession, (req, res) => {
    // Monthly prices by tier (cents → dollars happens client-side)
    const TIER_MRR = { connect: 0, plus: 49, pro: 99, managed: 199, event: 0 };
    const ANNUAL_DISCOUNT = 1; // annual prices are already monthly-equivalent

    try {
      // 1. All billing customers with church + reseller info
      const rows = db.prepare(`
        SELECT bc.*, c.name as church_name, r.name as reseller_name
        FROM billing_customers bc
        LEFT JOIN churches c ON bc.church_id = c.churchId
        LEFT JOIN resellers r ON bc.reseller_id = r.id
        ORDER BY bc.created_at DESC
      `).all();

      const now = new Date();
      const nowISO = now.toISOString();

      // 2. Summary metrics
      let totalMRR = 0, activeSubs = 0, pastDueCount = 0, freeCount = 0, canceledCount = 0, trialCount = 0;
      let prevMRR = 0, prevActive = 0, prevPastDue = 0;
      const oneMonthAgo = new Date(now);
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

      // 3. Plan distribution
      const planCounts = { connect: 0, plus: 0, pro: 0, managed: 0, event: 0 };

      // 4. Past-due aging buckets
      const pastDueAging = { '1-7': [], '8-30': [], '30+': [] };

      // 5. Reseller revenue
      const resellerMap = {};

      // 6. MRR history — track by month when subscriptions were created
      const mrrByMonth = {};
      // Initialize last 12 months
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = d.toISOString().slice(0, 7); // YYYY-MM
        mrrByMonth[key] = { month: key, mrr: 0, count: 0 };
      }

      rows.forEach(r => {
        const status = (r.status || '').toLowerCase();
        const tier = (r.tier || 'connect').toLowerCase();
        const monthlyRevenue = TIER_MRR[tier] || 0;

        // Plan distribution
        if (planCounts.hasOwnProperty(tier)) planCounts[tier]++;
        else planCounts[tier] = 1;

        // Status breakdown
        if (status === 'active') {
          activeSubs++;
          totalMRR += monthlyRevenue;
        } else if (status === 'past_due') {
          pastDueCount++;
          totalMRR += monthlyRevenue; // still billing

          // Aging: use grace_ends_at or current_period_end to determine how long overdue
          const overdueStart = r.current_period_end
            ? new Date(typeof r.current_period_end === 'number' ? r.current_period_end * 1000 : r.current_period_end)
            : null;
          if (overdueStart) {
            const daysOverdue = Math.floor((now - overdueStart) / (1000 * 60 * 60 * 24));
            const entry = { church_name: r.church_name || 'Unknown', tier, days: daysOverdue, church_id: r.church_id };
            if (daysOverdue > 30) pastDueAging['30+'].push(entry);
            else if (daysOverdue > 7) pastDueAging['8-30'].push(entry);
            else pastDueAging['1-7'].push(entry);
          }
        } else if (status === 'canceled') {
          canceledCount++;
        } else if (status === 'trialing') {
          trialCount++;
        } else {
          freeCount++;
        }

        // MRR history: attribute revenue to months where subscription was active
        if ((status === 'active' || status === 'past_due') && r.created_at) {
          const createdDate = new Date(r.created_at);
          Object.keys(mrrByMonth).forEach(monthKey => {
            const monthDate = new Date(monthKey + '-01');
            const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
            if (createdDate <= monthEnd) {
              mrrByMonth[monthKey].mrr += monthlyRevenue;
              mrrByMonth[monthKey].count++;
            }
          });
        }

        // Reseller aggregation
        if (r.reseller_id && r.reseller_name) {
          if (!resellerMap[r.reseller_id]) {
            resellerMap[r.reseller_id] = { name: r.reseller_name, churches: 0, mrr: 0 };
          }
          resellerMap[r.reseller_id].churches++;
          if (status === 'active' || status === 'past_due') {
            resellerMap[r.reseller_id].mrr += monthlyRevenue;
          }
        }
      });

      // Compute previous month MRR for trend comparison
      const prevMonthKey = oneMonthAgo.toISOString().slice(0, 7);
      const prevData = mrrByMonth[prevMonthKey];
      if (prevData) {
        prevMRR = prevData.mrr;
        prevActive = prevData.count;
      }

      const totalChurches = activeSubs + pastDueCount + freeCount + canceledCount + trialCount;
      const avgRevenue = totalChurches > 0 ? totalMRR / totalChurches : 0;

      const mrrTrend = Object.values(mrrByMonth);

      res.json({
        summary: {
          totalMRR,
          prevMRR,
          mrrChange: prevMRR > 0 ? ((totalMRR - prevMRR) / prevMRR * 100) : 0,
          activeSubs,
          prevActive,
          pastDueCount,
          canceledCount,
          freeCount,
          trialCount,
          avgRevenue: Math.round(avgRevenue * 100) / 100,
        },
        mrrTrend,
        planDistribution: Object.entries(planCounts).map(([plan, count]) => ({
          plan, count, pct: totalChurches > 0 ? Math.round(count / totalChurches * 100) : 0
        })),
        pastDueAging,
        resellers: Object.values(resellerMap).sort((a, b) => b.mrr - a.mrr),
        tierPrices: TIER_MRR,
      });
    } catch (e) {
      res.json({ summary: null, mrrTrend: [], planDistribution: [], pastDueAging: {}, resellers: [], tierPrices: {} });
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

  // ── Onboarding Funnel ────────────────────────────────────────────────────

  app.get('/api/admin/onboarding/funnel', requireAdminSession, (req, res) => {
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM churches').get().cnt || 0;
    let funnel = { total, app_connected: 0, atem_connected: 0, first_session: 0, telegram: 0, failover_tested: 0, team_invited: 0 };
    try {
      funnel.app_connected = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_app_connected_at IS NOT NULL").get()?.cnt || 0;
      funnel.atem_connected = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_atem_connected_at IS NOT NULL").get()?.cnt || 0;
      funnel.first_session = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_first_session_at IS NOT NULL").get()?.cnt || 0;
      funnel.telegram = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_telegram_registered_at IS NOT NULL").get()?.cnt || 0;
      funnel.failover_tested = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_failover_tested_at IS NOT NULL").get()?.cnt || 0;
      funnel.team_invited = db.prepare("SELECT COUNT(*) AS cnt FROM churches WHERE onboarding_team_invited_at IS NOT NULL").get()?.cnt || 0;
    } catch { /* onboarding columns may not exist */ }

    // Stuck churches: connected app but no ATEM in 7+ days
    let stuck = [];
    try {
      stuck = db.prepare(`
        SELECT churchId, name, portal_email,
               onboarding_app_connected_at, onboarding_atem_connected_at,
               onboarding_first_session_at, onboarding_telegram_registered_at,
               onboarding_failover_tested_at, onboarding_team_invited_at
        FROM churches
        WHERE onboarding_app_connected_at IS NOT NULL
        ORDER BY registeredAt DESC
      `).all().filter(c => {
        // Find the last completed step
        const steps = [
          { key: 'app_connected', at: c.onboarding_app_connected_at },
          { key: 'atem_connected', at: c.onboarding_atem_connected_at },
          { key: 'first_session', at: c.onboarding_first_session_at },
          { key: 'telegram', at: c.onboarding_telegram_registered_at },
          { key: 'failover_tested', at: c.onboarding_failover_tested_at },
          { key: 'team_invited', at: c.onboarding_team_invited_at },
        ];
        // If all steps done, not stuck
        if (steps.every(s => s.at)) return false;
        // Find the last completed step's date
        const completed = steps.filter(s => s.at);
        if (!completed.length) return false;
        const lastCompleted = completed[completed.length - 1];
        const daysSince = Math.floor((Date.now() - new Date(lastCompleted.at).getTime()) / (1000 * 60 * 60 * 24));
        return daysSince >= 7;
      }).map(c => {
        const steps = [
          { key: 'App Connected', at: c.onboarding_app_connected_at },
          { key: 'ATEM Connected', at: c.onboarding_atem_connected_at },
          { key: 'First Session', at: c.onboarding_first_session_at },
          { key: 'Telegram Setup', at: c.onboarding_telegram_registered_at },
          { key: 'Failover Tested', at: c.onboarding_failover_tested_at },
          { key: 'Team Invited', at: c.onboarding_team_invited_at },
        ];
        const completed = steps.filter(s => s.at);
        const lastStep = completed[completed.length - 1];
        const daysSince = Math.floor((Date.now() - new Date(lastStep.at).getTime()) / (1000 * 60 * 60 * 24));
        return {
          churchId: c.churchId,
          name: c.name,
          email: c.portal_email,
          lastStep: lastStep.key,
          lastStepDate: lastStep.at,
          daysStuck: daysSince,
        };
      });
    } catch { /* columns may not exist */ }

    res.json({ funnel, stuck });
  });

  app.post('/api/admin/onboarding/nudge', requireAdminSession, async (req, res) => {
    const { churchId, lastStep } = req.body || {};
    if (!churchId) return res.status(400).json({ error: 'churchId required' });
    const church = db.prepare('SELECT name, portal_email, email FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const recipient = church.portal_email || church.email;
    if (!recipient) return res.status(400).json({ error: 'No email on file for this church' });

    const { lifecycleEmails } = opts;
    if (!lifecycleEmails) return res.status(500).json({ error: 'Email system not available' });

    try {
      const result = await lifecycleEmails.sendManual({
        churchId,
        emailType: 'onboarding_nudge',
        to: recipient,
        subject: `Continue setting up ${church.name} on Tally`,
        html: `<p>Hi there!</p><p>We noticed you've completed <strong>${lastStep || 'initial setup'}</strong> but haven't taken the next step yet. We're here to help!</p><p>Log in to your Tally dashboard to continue onboarding. If you need assistance, just reply to this email.</p><p>— The Tally Team</p>`,
        text: `Hi! We noticed you've completed ${lastStep || 'initial setup'} but haven't taken the next step yet. Log in to continue onboarding.`,
      });
      auditFromReq(req, 'onboarding_nudge_sent', 'church', churchId, { lastStep, to: recipient });
      res.json({ sent: true, to: recipient });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e, 'Failed to send nudge') });
    }
  });

  // ── Church Rooms List (for admin command targeting) ───────────────────────

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

  // ── Admin Room CRUD ──────────────────────────────────────────────────────

  app.get('/api/admin/rooms', requireAdminSession, (req, res) => {
    try {
      const churchId = req.query.churchId || null;
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = (page - 1) * limit;

      let where = 'WHERE r.deleted_at IS NULL';
      const params = [];
      if (churchId) {
        where += ' AND r.campus_id = ?';
        params.push(churchId);
      }

      const total = db.prepare(`SELECT COUNT(*) AS cnt FROM rooms r ${where}`).get(...params).cnt;
      const rows = db.prepare(
        `SELECT r.id, r.campus_id, r.name, r.description, r.created_at,
                c.name AS church_name
         FROM rooms r
         LEFT JOIN churches c ON c.churchId = r.campus_id
         ${where}
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      ).all(...params, limit, offset);

      res.json({ rooms: rows, total, page, limit, pages: Math.ceil(total / limit) });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/admin/rooms', requireAdminSession, (req, res) => {
    const { churchId, name, description } = req.body || {};
    if (!churchId) return res.status(400).json({ error: 'churchId is required' });
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });

    const church = db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });

    try {
      const id = uuidv4();
      const cleanName = String(name).trim();
      const cleanDesc = String(description || '').trim();
      const created_at = new Date().toISOString();
      db.prepare('INSERT INTO rooms (id, campus_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, churchId, cleanName, cleanDesc, created_at);
      auditFromReq(req, 'room_created', 'room', id, { churchId, name: cleanName });
      res.status(201).json({ id, campus_id: churchId, name: cleanName, description: cleanDesc, created_at, church_name: church.name });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.patch('/api/admin/rooms/:roomId', requireAdminSession, (req, res) => {
    const { roomId } = req.params;
    const room = db.prepare('SELECT id, campus_id FROM rooms WHERE id = ? AND deleted_at IS NULL').get(roomId);
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

    try {
      params.push(roomId);
      db.prepare(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      auditFromReq(req, 'room_updated', 'room', roomId, { name, description });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.delete('/api/admin/rooms/:roomId', requireAdminSession, (req, res) => {
    const { roomId } = req.params;
    const room = db.prepare('SELECT id, name, campus_id FROM rooms WHERE id = ? AND deleted_at IS NULL').get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    try {
      const deleteRelated = db.transaction(() => {
        db.prepare('UPDATE rooms SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), roomId);
        try { db.prepare('DELETE FROM room_equipment WHERE room_id = ?').run(roomId); } catch {}
        try { db.prepare('DELETE FROM alerts WHERE church_id = ? AND instance_name = ?').run(room.campus_id, roomId); } catch {}
        try { db.prepare('UPDATE churches SET room_id = NULL, room_name = NULL WHERE room_id = ?').run(roomId); } catch {}
        try { db.prepare('DELETE FROM td_room_assignments WHERE room_id = ?').run(roomId); } catch {}
      });
      deleteRelated();

      // Clean up runtime state
      const runtime = churches.get(room.campus_id);
      if (runtime?.roomInstanceMap?.[roomId]) {
        const instanceName = runtime.roomInstanceMap[roomId];
        if (runtime.instanceStatus?.[instanceName]) delete runtime.instanceStatus[instanceName];
        delete runtime.roomInstanceMap[roomId];
      }

      auditFromReq(req, 'room_deleted', 'room', roomId, { name: room.name, churchId: room.campus_id });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── TD Room Assignments (Admin) ──────────────────────────────────────────

  // GET /api/admin/church/:churchId/td-room-assignments — all assignments for a church
  app.get('/api/admin/church/:churchId/td-room-assignments', requireAdminSession, (req, res) => {
    try {
      const assignments = db.prepare(
        `SELECT tra.id, tra.td_id, tra.room_id, tra.created_at,
                t.name AS td_name, t.email AS td_email,
                r.name AS room_name
         FROM td_room_assignments tra
         JOIN church_tds t ON t.id = tra.td_id
         JOIN rooms r ON r.id = tra.room_id AND r.deleted_at IS NULL
         WHERE tra.church_id = ?
         ORDER BY t.name ASC, r.name ASC`
      ).all(req.params.churchId);
      res.json(assignments);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/admin/church/:churchId/td-room-assignments — assign TD to room
  app.post('/api/admin/church/:churchId/td-room-assignments', requireAdminSession, (req, res) => {
    try {
      const { tdId, roomId } = req.body;
      if (!tdId || !roomId) return res.status(400).json({ error: 'tdId and roomId required' });
      const churchId = req.params.churchId;
      try {
        db.prepare('INSERT INTO td_room_assignments (td_id, room_id, church_id, created_at) VALUES (?, ?, ?, ?)')
          .run(tdId, roomId, churchId, new Date().toISOString());
      } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already assigned' });
        throw e;
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // DELETE /api/admin/church/:churchId/td-room-assignments/:id — remove assignment
  app.delete('/api/admin/church/:churchId/td-room-assignments/:id', requireAdminSession, (req, res) => {
    try {
      const result = db.prepare(
        'DELETE FROM td_room_assignments WHERE id = ? AND church_id = ?'
      ).run(req.params.id, req.params.churchId);
      if (!result.changes) return res.status(404).json({ error: 'Assignment not found' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ── Church Delete Summary ────────────────────────────────────────────────

  app.get('/api/admin/churches/:id/delete-summary', requireAdminSession, (req, res) => {
    const { id } = req.params;
    const row = db.prepare('SELECT churchId FROM churches WHERE churchId=?').get(id);
    if (!row) return res.status(404).json({ error: 'Church not found' });
    const summary = {};
    const counts = [
      { key: 'alerts', sql: 'SELECT COUNT(*) AS cnt FROM alerts WHERE church_id = ?' },
      { key: 'sessions', sql: 'SELECT COUNT(*) AS cnt FROM service_sessions WHERE church_id = ?' },
      { key: 'tickets', sql: 'SELECT COUNT(*) AS cnt FROM support_tickets WHERE church_id = ?' },
      { key: 'messages', sql: 'SELECT COUNT(*) AS cnt FROM chat_messages WHERE churchId = ?' },
      { key: 'rooms', sql: 'SELECT COUNT(*) AS cnt FROM rooms WHERE campus_id = ?' },
    ];
    for (const { key, sql } of counts) {
      try { summary[key] = db.prepare(sql).get(id)?.cnt || 0; } catch { summary[key] = 0; }
    }
    res.json(summary);
  });

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

    // Full device details for the monitor panel
    const deviceDetails = {
      atem: deviceStatus.atem || null,
      obs: deviceStatus.obs || null,
      vmix: deviceStatus.vmix || null,
      companion: deviceStatus.companion || null,
      encoder: deviceStatus.encoder || null,
      backupEncoder: deviceStatus.backupEncoder || null,
      mixer: deviceStatus.mixer || null,
      hyperdeck: deviceStatus.hyperdeck || null,
      proPresenter: deviceStatus.proPresenter || null,
      resolume: deviceStatus.resolume || null,
      ptz: Array.isArray(deviceStatus.ptz) ? deviceStatus.ptz : [],
      hyperdecks: Array.isArray(deviceStatus.hyperdecks) ? deviceStatus.hyperdecks : [],
      videoHubs: Array.isArray(deviceStatus.videoHubs) ? deviceStatus.videoHubs : [],
      smartPlugs: Array.isArray(deviceStatus.smartPlugs) ? deviceStatus.smartPlugs : [],
      audio: deviceStatus.audio || null,
      system: deviceStatus.system || null,
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
      deviceDetails,
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
          deviceDetails: {
            atem: instStatus.atem || null,
            obs: instStatus.obs || null,
            vmix: instStatus.vmix || null,
            companion: instStatus.companion || null,
            encoder: instStatus.encoder || null,
            backupEncoder: instStatus.backupEncoder || null,
            mixer: instStatus.mixer || null,
            hyperdeck: instStatus.hyperdeck || null,
            proPresenter: instStatus.proPresenter || null,
            resolume: instStatus.resolume || null,
            ptz: Array.isArray(instStatus.ptz) ? instStatus.ptz : [],
            hyperdecks: Array.isArray(instStatus.hyperdecks) ? instStatus.hyperdecks : [],
            videoHubs: Array.isArray(instStatus.videoHubs) ? instStatus.videoHubs : [],
            smartPlugs: Array.isArray(instStatus.smartPlugs) ? instStatus.smartPlugs : [],
            audio: instStatus.audio || null,
            system: instStatus.system || null,
          },
          streamActive: !!instStatus.streaming || !!instStatus.obs?.streaming,
        };
      }
    }

    const roomInstanceMap = runtime?.roomInstanceMap || {};

    // ── Room Equipment ──
    const roomEquipment = {};
    try {
      const eqRows = db.prepare('SELECT room_id, equipment FROM room_equipment WHERE church_id = ?').all(churchId);
      for (const row of eqRows) {
        try { roomEquipment[row.room_id] = JSON.parse(row.equipment); } catch { roomEquipment[row.room_id] = {}; }
      }
    } catch { /* table may not exist */ }

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
      roomEquipment,
    });
  });


  // POST /api/admin/church/:churchId/send-command
  // Sends an allowed command to the church client via WebSocket.
  app.post('/api/admin/church/:churchId/send-command', requireAdminSession, (req, res) => {
    const { churchId } = req.params;
    const { command, params, roomId } = req.body || {};

    if (!command) return res.status(400).json({ error: 'command required' });
    if (!ALLOWED_ADMIN_COMMANDS.has(command)) {
      return res.status(400).json({ error: `Unknown command: ${command}. Allowed: ${[...ALLOWED_ADMIN_COMMANDS].join(', ')}` });
    }

    const churchRow = db.prepare('SELECT churchId FROM churches WHERE churchId = ?').get(churchId);
    if (!churchRow) return res.status(404).json({ error: 'Church not found' });

    const runtime = churches.get(churchId);
    const openSockets = [];

    if (roomId && runtime?.roomInstanceMap?.[roomId]) {
      // Room-targeted: find the specific socket for this room's instance
      const instanceName = runtime.roomInstanceMap[roomId];
      if (runtime.sockets?.size) {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === WebSocket.OPEN && sock.instanceName === instanceName) {
            openSockets.push(sock);
          }
        }
      }
      if (openSockets.length === 0) {
        return res.status(409).json({ error: `Room instance "${instanceName}" is not connected` });
      }
    } else {
      // Broadcast to all instances
      if (runtime?.sockets?.size) {
        for (const sock of runtime.sockets.values()) {
          if (sock.readyState === WebSocket.OPEN) openSockets.push(sock);
        }
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
      auditFromReq(req, 'admin_command_sent', 'church', churchId, { command, commandId, roomId: roomId || null });
      res.json({ sent: true, commandId, targetedRoom: roomId || null, instanceCount: openSockets.length });
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
        connected:        hasOpenSocket(runtime, WebSocket.OPEN),
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

module.exports = { setupAdminPanel };
