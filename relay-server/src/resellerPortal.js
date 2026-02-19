/**
 * Reseller Portal — self-service management for resellers/integrators
 *
 * Routes:
 *   GET  /reseller-login                    login page
 *   POST /api/reseller-portal/login         validate → JWT cookie → redirect
 *   POST /api/reseller-portal/logout        clear cookie
 *   GET  /reseller-portal                   portal HTML (cookie auth)
 *
 *   GET  /api/reseller-portal/me            reseller info + stats
 *   PUT  /api/reseller-portal/me            update branding/settings
 *   GET  /api/reseller-portal/churches      their churches + status
 *   POST /api/reseller-portal/churches      add a new church
 *   DELETE /api/reseller-portal/churches/:id remove a church
 *
 * Admin helper routes (requireAdmin):
 *   POST /api/resellers/:resellerId/portal-credentials  { email, password }
 */

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');

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

function issueResellerToken(resellerId, jwtSecret) {
  return jwt.sign({ type: 'reseller_portal', resellerId }, jwtSecret, { expiresIn: '7d' });
}

function requireResellerPortalAuth(db, resellerSystem, jwtSecret) {
  return (req, res, next) => {
    const token = req.cookies?.tally_reseller_session;
    if (!token) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
      return res.redirect('/reseller-login');
    }
    try {
      const payload = jwt.verify(token, jwtSecret);
      if (payload.type !== 'reseller_portal') throw new Error('wrong type');
      const reseller = resellerSystem.getResellerById(payload.resellerId);
      if (!reseller) throw new Error('reseller not found');
      if (reseller.active === 0) throw new Error('account inactive');
      req.reseller = reseller;
      next();
    } catch {
      res.clearCookie('tally_reseller_session');
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
      return res.redirect('/reseller-login');
    }
  };
}

// ─── HTML builders ─────────────────────────────────────────────────────────────

function buildResellerLoginHtml(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reseller Portal — Tally</title>
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
    .logo-dot { width: 10px; height: 10px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 8px #22c55e; }
    .logo-text { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .logo-sub { font-size: 12px; color: #94A3B8; margin-left: auto; }
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
    .partner-badge {
      background: rgba(34,197,94,0.08);
      border: 1px solid rgba(34,197,94,0.2);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      color: #22c55e;
      display: inline-block;
      margin-bottom: 24px;
      font-family: 'Courier New', monospace;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-dot"></div>
      <span class="logo-text">Tally</span>
      <span class="logo-sub">Partner Portal</span>
    </div>
    <div class="partner-badge">RESELLER / INTEGRATOR</div>
    <h1>Sign in</h1>
    <p class="subtitle">Manage your churches and account settings</p>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/api/reseller-portal/login">
      <label>Email address</label>
      <input type="email" name="email" placeholder="you@yourcompany.com" required autocomplete="email">
      <label>Password</label>
      <input type="password" name="password" placeholder="••••••••" required autocomplete="current-password">
      <button type="submit" class="btn">Sign in</button>
    </form>
    <div class="footer">Tally by Atem School — <a href="https://tally.atemschool.com" style="color:#22c55e;text-decoration:none">tally.atemschool.com</a></div>
  </div>
</body>
</html>`;
}

function buildResellerPortalHtml(reseller) {
  const brandName = reseller.brand_name || reseller.name || 'Your Company';
  const accent    = reseller.primary_color || '#22c55e';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brandName} — Partner Portal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --accent: ${accent}; --accent-dim: ${accent}22; --accent-border: ${accent}44; }
    body {
      background: #09090B;
      color: #F8FAFC;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', sans-serif;
      display: flex;
      min-height: 100vh;
    }
    .sidebar {
      width: 220px; min-width: 220px;
      background: #0F1613;
      border-right: 1px solid #1a2e1f;
      display: flex; flex-direction: column;
      padding: 24px 0;
      position: fixed; top: 0; left: 0; bottom: 0;
      z-index: 10;
    }
    .sidebar-logo {
      display: flex; align-items: center; gap: 8px;
      padding: 0 20px 24px;
      border-bottom: 1px solid #1a2e1f;
      margin-bottom: 16px;
    }
    .sidebar-dot {
      width: 8px; height: 8px;
      background: var(--accent);
      border-radius: 50%;
      box-shadow: 0 0 6px var(--accent);
      flex-shrink: 0;
    }
    .sidebar-brand { font-size: 15px; font-weight: 700; }
    .sidebar-sub { font-size: 11px; color: #94A3B8; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 20px;
      font-size: 13px; color: #94A3B8;
      cursor: pointer;
      border: none; background: none;
      width: 100%; text-align: left;
      transition: all 0.15s;
    }
    .nav-item:hover, .nav-item.active {
      background: var(--accent-dim);
      color: var(--accent);
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
      color: #94A3B8; border-radius: 7px;
      padding: 8px; font-size: 12px; cursor: pointer;
      transition: all 0.15s;
    }
    .btn-logout:hover { border-color: #ef4444; color: #ef4444; }
    .main { margin-left: 220px; flex: 1; padding: 32px; max-width: 960px; }
    .page { display: none; }
    .page.active { display: block; }
    .page-header { margin-bottom: 24px; }
    .page-title { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
    .page-sub { font-size: 13px; color: #94A3B8; }
    .card {
      background: #0F1613; border: 1px solid #1a2e1f;
      border-radius: 10px; padding: 24px; margin-bottom: 20px;
    }
    .card-title {
      font-size: 11px; font-weight: 600; color: #94A3B8;
      text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 16px;
    }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px; }
    .stat-card {
      background: #0F1613; border: 1px solid #1a2e1f;
      border-radius: 10px; padding: 20px; text-align: center;
    }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 12px; color: #94A3B8; margin-top: 4px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 12px; color: #94A3B8; margin-bottom: 6px; }
    .field input, .field textarea, .field select {
      width: 100%; background: #09090B; border: 1px solid #1a2e1f;
      border-radius: 8px; padding: 9px 12px; color: #F8FAFC;
      font-size: 13px; outline: none; font-family: inherit;
      transition: border-color 0.15s;
    }
    .field input:focus, .field textarea:focus { border-color: var(--accent); }
    .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .btn-primary {
      background: var(--accent); color: #09090B;
      border: none; border-radius: 7px; padding: 9px 20px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: opacity 0.15s;
    }
    .btn-primary:hover { opacity: 0.85; }
    .btn-secondary {
      background: transparent; color: #94A3B8;
      border: 1px solid #1a2e1f; border-radius: 7px; padding: 9px 20px;
      font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .btn-secondary:hover { border-color: var(--accent); color: var(--accent); }
    .btn-danger {
      background: transparent; color: #f87171;
      border: 1px solid rgba(239,68,68,0.3); border-radius: 7px; padding: 6px 12px;
      font-size: 12px; cursor: pointer; transition: all 0.15s;
    }
    .btn-danger:hover { background: rgba(239,68,68,0.1); }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 11px; color: #94A3B8; text-transform: uppercase; letter-spacing: 0.5px; padding: 0 0 10px; border-bottom: 1px solid #1a2e1f; }
    td { padding: 10px 0; font-size: 13px; border-bottom: 1px solid rgba(26,46,31,0.5); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 500; font-family: 'Courier New', monospace; }
    .badge-green { background: rgba(34,197,94,0.1); color: #22c55e; border: 1px solid rgba(34,197,94,0.2); }
    .badge-yellow { background: rgba(234,179,8,0.1); color: #eab308; border: 1px solid rgba(234,179,8,0.2); }
    .badge-gray { background: rgba(148,163,184,0.1); color: #94A3B8; border: 1px solid rgba(148,163,184,0.2); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .status-dot.online { background: #22c55e; box-shadow: 0 0 5px #22c55e; }
    .status-dot.offline { background: #475569; }
    .color-preview { width: 24px; height: 24px; border-radius: 6px; display: inline-block; vertical-align: middle; border: 1px solid #1a2e1f; margin-right: 8px; }
    .api-key-display {
      background: #09090B; border: 1px solid #1a2e1f; border-radius: 6px;
      padding: 10px 14px; font-family: 'Courier New', monospace; font-size: 12px;
      color: #22c55e; display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
    }
    .api-key-val { word-break: break-all; flex: 1; filter: blur(5px); transition: filter 0.2s; }
    .api-key-val.revealed { filter: none; }
    .btn-sm {
      background: transparent; color: var(--accent);
      border: 1px solid var(--accent-border); border-radius: 6px; padding: 5px 10px;
      font-size: 11px; cursor: pointer; transition: all 0.15s; white-space: nowrap;
    }
    .btn-sm:hover { background: var(--accent-dim); }
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      display: none; align-items: center; justify-content: center; z-index: 100;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: #0F1613; border: 1px solid #1a2e1f;
      border-radius: 12px; padding: 28px; width: 480px; max-width: 95vw;
    }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    .modal-title { font-size: 16px; font-weight: 600; }
    .modal-close { background: none; border: none; color: #94A3B8; font-size: 20px; cursor: pointer; }
    .modal-close:hover { color: #F8FAFC; }
    .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
    #toast {
      position: fixed; bottom: 24px; right: 24px;
      background: #0F1613; border: 1px solid var(--accent); color: var(--accent);
      padding: 12px 20px; border-radius: 8px; font-size: 13px;
      opacity: 0; transform: translateY(10px); transition: all 0.2s;
      pointer-events: none; z-index: 999;
    }
    #toast.show { opacity: 1; transform: translateY(0); }
    #toast.error { border-color: #ef4444; color: #f87171; }
    .church-card {
      background: #09090B; border: 1px solid #1a2e1f; border-radius: 8px;
      padding: 14px 16px; display: flex; align-items: center; gap: 12px;
      margin-bottom: 8px; transition: border-color 0.15s;
    }
    .church-card:hover { border-color: var(--accent-border); }
    .church-card-name { font-size: 14px; font-weight: 500; flex: 1; }
    .church-card-meta { font-size: 12px; color: #94A3B8; }
    @media (max-width: 640px) {
      .sidebar { display: none; }
      .main { margin-left: 0; padding: 20px; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="sidebar-logo">
      <div class="sidebar-dot"></div>
      <div>
        <div class="sidebar-brand" id="sidebar-brand">${brandName}</div>
        <div class="sidebar-sub">Partner Portal</div>
      </div>
    </div>
    <button class="nav-item active" data-page="dashboard" onclick="showPage('dashboard', this)">
      <span class="icon">⊙</span> Dashboard
    </button>
    <button class="nav-item" data-page="churches" onclick="showPage('churches', this)">
      <span class="icon">⊞</span> Churches
    </button>
    <button class="nav-item" data-page="branding" onclick="showPage('branding', this)">
      <span class="icon">⊛</span> Branding
    </button>
    <button class="nav-item" data-page="settings" onclick="showPage('settings', this)">
      <span class="icon">⊡</span> Settings
    </button>
    <div class="sidebar-footer">
      <button class="btn-logout" onclick="logout()">Sign out</button>
    </div>
  </nav>

  <main class="main">

    <!-- DASHBOARD -->
    <div class="page active" id="page-dashboard">
      <div class="page-header">
        <div class="page-title" id="dash-brand">${brandName}</div>
        <div class="page-sub">Partner overview</div>
      </div>
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="stat-churches">—</div>
          <div class="stat-label">Total Churches</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-online">—</div>
          <div class="stat-label">Online Now</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-alerts">—</div>
          <div class="stat-label">Active Alerts</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="stat-limit">—</div>
          <div class="stat-label">Church Limit</div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Church Status</div>
        <div id="church-status-list"><div style="color:#475569;text-align:center;padding:20px">Loading…</div></div>
      </div>
    </div>

    <!-- CHURCHES -->
    <div class="page" id="page-churches">
      <div class="page-header">
        <div class="page-title">Churches</div>
        <div class="page-sub">Manage the churches in your account</div>
      </div>
      <div class="card">
        <div style="display:flex;justify-content:flex-end;margin-bottom:16px">
          <button class="btn-primary" onclick="document.getElementById('modal-add-church').classList.add('open')">+ Add Church</button>
        </div>
        <table>
          <thead><tr><th>Church</th><th>Status</th><th>Registered</th><th>Portal</th><th></th></tr></thead>
          <tbody id="churches-tbody">
            <tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- BRANDING -->
    <div class="page" id="page-branding">
      <div class="page-header">
        <div class="page-title">Branding</div>
        <div class="page-sub">Customize how Tally appears to your churches</div>
      </div>
      <div class="card">
        <div class="card-title">Brand Identity</div>
        <div class="field-row">
          <div class="field">
            <label>Brand Name</label>
            <input type="text" id="brand-name" placeholder="AV Solutions Pro">
          </div>
          <div class="field">
            <label>Support Email</label>
            <input type="email" id="brand-email" placeholder="support@yourcompany.com">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Logo URL</label>
            <input type="url" id="brand-logo" placeholder="https://yourcompany.com/logo.png">
          </div>
          <div class="field">
            <label>Accent Color</label>
            <div style="display:flex;align-items:center;gap:8px">
              <span class="color-preview" id="color-preview" style="background:${accent}"></span>
              <input type="text" id="brand-color" placeholder="#22c55e" value="${accent}" oninput="updateColorPreview(this.value)" style="flex:1">
              <input type="color" id="brand-color-picker" value="${accent}" oninput="document.getElementById('brand-color').value=this.value;updateColorPreview(this.value)" style="width:36px;height:36px;padding:2px;border-radius:6px;cursor:pointer;background:#09090B;border:1px solid #1a2e1f">
            </div>
          </div>
        </div>
        <div class="field">
          <label>Custom Domain (optional)</label>
          <input type="text" id="brand-domain" placeholder="monitor.yourcompany.com">
          <p style="font-size:11px;color:#475569;margin-top:6px">Contact support to configure DNS for custom domain access.</p>
        </div>
        <button class="btn-primary" onclick="saveBranding()">Save Branding</button>
      </div>
      <div class="card" id="brand-preview-card" style="border-color:rgba(34,197,94,0.2)">
        <div class="card-title">Live Preview</div>
        <div style="display:flex;align-items:center;gap:10px;padding:16px;background:#09090B;border-radius:8px">
          <div id="preview-dot" style="width:10px;height:10px;border-radius:50%;background:${accent};box-shadow:0 0 8px ${accent}"></div>
          <span id="preview-brand" style="font-size:16px;font-weight:700">${brandName}</span>
          <span style="font-size:12px;color:#94A3B8;margin-left:auto">Powered by Tally</span>
        </div>
      </div>
    </div>

    <!-- SETTINGS -->
    <div class="page" id="page-settings">
      <div class="page-header">
        <div class="page-title">Account Settings</div>
        <div class="page-sub">API access and account configuration</div>
      </div>
      <div class="card">
        <div class="card-title">Webhook</div>
        <div class="field">
          <label>Webhook URL</label>
          <input type="url" id="webhook-url" placeholder="https://yourcompany.com/webhooks/tally">
          <p style="font-size:11px;color:#475569;margin-top:6px">Receive POST notifications when churches go offline or trigger alerts.</p>
        </div>
        <button class="btn-primary" onclick="saveWebhook()">Save Webhook</button>
      </div>
      <div class="card">
        <div class="card-title">API Key</div>
        <p style="font-size:13px;color:#94A3B8;margin-bottom:14px">Use this key to authenticate programmatic API calls.</p>
        <div class="api-key-display">
          <span class="api-key-val" id="api-key-val">Loading…</span>
          <button class="btn-sm" onclick="revealApiKey()">Reveal</button>
          <button class="btn-sm" onclick="copyApiKey()">Copy</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">Change Password</div>
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

  </main>

  <!-- ADD CHURCH MODAL -->
  <div class="modal-backdrop" id="modal-add-church">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Add Church</div>
        <button class="modal-close" onclick="document.getElementById('modal-add-church').classList.remove('open')">×</button>
      </div>
      <div class="field">
        <label>Church Name</label>
        <input type="text" id="new-church-name" placeholder="Grace Community Church">
      </div>
      <div class="field">
        <label>Contact Email</label>
        <input type="email" id="new-church-email" placeholder="td@gracechurch.org">
      </div>
      <p style="font-size:12px;color:#475569;margin-top:4px">A registration code will be generated for the church to connect their app.</p>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="document.getElementById('modal-add-church').classList.remove('open')">Cancel</button>
        <button class="btn-primary" onclick="addChurch()">Create Church</button>
      </div>
    </div>
  </div>

  <!-- CHURCH CREDENTIALS MODAL -->
  <div class="modal-backdrop" id="modal-church-creds">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Set Portal Login</div>
        <button class="modal-close" onclick="document.getElementById('modal-church-creds').classList.remove('open')">×</button>
      </div>
      <p style="font-size:13px;color:#94A3B8;margin-bottom:16px">Set login credentials for <strong id="creds-church-name" style="color:#F8FAFC"></strong>'s church portal.</p>
      <input type="hidden" id="creds-church-id">
      <div class="field">
        <label>Portal Email</label>
        <input type="email" id="creds-email" placeholder="td@theirchurch.org">
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" id="creds-password" placeholder="Min 8 characters">
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" onclick="document.getElementById('modal-church-creds').classList.remove('open')">Cancel</button>
        <button class="btn-primary" onclick="saveChurchCreds()">Set Credentials</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    let meData = {};
    let apiKeyRaw = '';

    function showPage(id, el) {
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('page-' + id).classList.add('active');
      el.classList.add('active');
      if (id === 'dashboard') loadDashboard();
      if (id === 'churches') loadChurches();
      if (id === 'branding') loadBranding();
      if (id === 'settings') loadSettings();
    }

    function toast(msg, isError = false) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = isError ? 'error' : '';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    async function api(method, path, body) {
      const opts = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────
    async function loadDashboard() {
      try {
        const me = await api('GET', '/api/reseller-portal/me');
        meData = me;
        document.getElementById('stat-churches').textContent = me.churchCount ?? '—';
        document.getElementById('stat-online').textContent = me.onlineCount ?? '—';
        document.getElementById('stat-alerts').textContent = me.alertCount ?? '—';
        document.getElementById('stat-limit').textContent = me.church_limit ?? '—';

        const churches = await api('GET', '/api/reseller-portal/churches');
        const list = document.getElementById('church-status-list');
        if (!churches.length) {
          list.innerHTML = '<div style="color:#475569;text-align:center;padding:20px">No churches yet. Add your first church →</div>';
          return;
        }
        list.innerHTML = churches.map(c => \`
          <div class="church-card">
            <span class="status-dot \${c.connected ? 'online' : 'offline'}"></span>
            <div class="church-card-name">\${c.name}</div>
            <div class="church-card-meta">\${c.connected ? 'Online' : 'Offline'}\${c.lastSeen ? ' · ' + new Date(c.lastSeen).toLocaleTimeString() : ''}</div>
          </div>
        \`).join('');
      } catch(e) { console.error(e); }
    }

    // ── Churches ──────────────────────────────────────────────────────────────
    async function loadChurches() {
      try {
        const churches = await api('GET', '/api/reseller-portal/churches');
        const tbody = document.getElementById('churches-tbody');
        if (!churches.length) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#475569;text-align:center;padding:20px">No churches yet.</td></tr>';
          return;
        }
        tbody.innerHTML = churches.map(c => \`
          <tr>
            <td>
              <div style="font-weight:500">\${c.name}</div>
              <div style="font-size:11px;color:#475569">\${c.email || ''}</div>
            </td>
            <td><span class="status-dot \${c.connected ? 'online' : 'offline'}"></span><span style="color:\${c.connected?'#22c55e':'#94A3B8'}">\${c.connected ? 'Online' : 'Offline'}</span></td>
            <td style="color:#94A3B8;font-size:12px">\${c.registeredAt ? new Date(c.registeredAt).toLocaleDateString() : '—'}</td>
            <td>
              \${c.portal_email ? \`<span class="badge badge-green">✓ \${c.portal_email}</span>\` : \`<span class="badge badge-gray">No login</span>\`}
            </td>
            <td style="display:flex;gap:8px;align-items:center">
              <button class="btn-sm" onclick="openChurchCreds('\${c.churchId}', '\${c.name.replace(/'/g,'\\\\'')}')">Set Login</button>
              <button class="btn-danger" onclick="removeChurch('\${c.churchId}', '\${c.name.replace(/'/g,'\\\\'')}')">Remove</button>
            </td>
          </tr>
        \`).join('');
      } catch(e) { toast('Failed to load churches', true); }
    }

    async function addChurch() {
      const name = document.getElementById('new-church-name').value.trim();
      const email = document.getElementById('new-church-email').value.trim();
      if (!name) return toast('Church name required', true);
      try {
        const result = await api('POST', '/api/reseller-portal/churches', { name, email });
        document.getElementById('modal-add-church').classList.remove('open');
        document.getElementById('new-church-name').value = '';
        document.getElementById('new-church-email').value = '';
        toast('Church added — registration code: ' + result.registrationCode);
        loadChurches();
        loadDashboard();
      } catch(e) { toast(e.message, true); }
    }

    async function removeChurch(id, name) {
      if (!confirm(\`Remove "\${name}" from your account? This cannot be undone.\`)) return;
      try {
        await api('DELETE', '/api/reseller-portal/churches/' + id);
        loadChurches();
        loadDashboard();
        toast('Church removed');
      } catch(e) { toast(e.message, true); }
    }

    function openChurchCreds(id, name) {
      document.getElementById('creds-church-id').value = id;
      document.getElementById('creds-church-name').textContent = name;
      document.getElementById('creds-email').value = '';
      document.getElementById('creds-password').value = '';
      document.getElementById('modal-church-creds').classList.add('open');
    }

    async function saveChurchCreds() {
      const churchId  = document.getElementById('creds-church-id').value;
      const email     = document.getElementById('creds-email').value.trim();
      const password  = document.getElementById('creds-password').value;
      if (!email || !password) return toast('Email and password required', true);
      try {
        await api('POST', '/api/reseller-portal/churches/' + churchId + '/credentials', { email, password });
        document.getElementById('modal-church-creds').classList.remove('open');
        loadChurches();
        toast('Church portal login set');
      } catch(e) { toast(e.message, true); }
    }

    // ── Branding ──────────────────────────────────────────────────────────────
    async function loadBranding() {
      try {
        const me = await api('GET', '/api/reseller-portal/me');
        document.getElementById('brand-name').value = me.brand_name || '';
        document.getElementById('brand-email').value = me.support_email || '';
        document.getElementById('brand-logo').value = me.logo_url || '';
        document.getElementById('brand-color').value = me.primary_color || '#22c55e';
        document.getElementById('brand-domain').value = me.custom_domain || '';
        updateColorPreview(me.primary_color || '#22c55e');
      } catch(e) { toast('Failed to load branding', true); }
    }

    function updateColorPreview(color) {
      const isValid = /^#[0-9A-Fa-f]{6}$/.test(color);
      if (!isValid) return;
      document.getElementById('color-preview').style.background = color;
      document.getElementById('preview-dot').style.background = color;
      document.getElementById('preview-dot').style.boxShadow = '0 0 8px ' + color;
      document.getElementById('brand-color-picker').value = color;
    }

    async function saveBranding() {
      try {
        await api('PUT', '/api/reseller-portal/me', {
          brand_name:    document.getElementById('brand-name').value,
          support_email: document.getElementById('brand-email').value,
          logo_url:      document.getElementById('brand-logo').value,
          primary_color: document.getElementById('brand-color').value,
          custom_domain: document.getElementById('brand-domain').value,
        });
        const newBrand = document.getElementById('brand-name').value || 'Your Company';
        document.getElementById('preview-brand').textContent = newBrand;
        document.getElementById('sidebar-brand').textContent = newBrand;
        document.getElementById('dash-brand').textContent = newBrand;
        toast('Branding saved');
      } catch(e) { toast(e.message, true); }
    }

    // ── Settings ──────────────────────────────────────────────────────────────
    async function loadSettings() {
      try {
        const me = await api('GET', '/api/reseller-portal/me');
        document.getElementById('webhook-url').value = me.webhook_url || '';
        apiKeyRaw = me.api_key || '';
        document.getElementById('api-key-val').textContent = apiKeyRaw ? apiKeyRaw.slice(0,8) + '…' + apiKeyRaw.slice(-4) : 'Not available';
      } catch(e) { toast('Failed to load settings', true); }
    }

    async function saveWebhook() {
      try {
        await api('PUT', '/api/reseller-portal/me', { webhook_url: document.getElementById('webhook-url').value });
        toast('Webhook saved');
      } catch(e) { toast(e.message, true); }
    }

    function revealApiKey() {
      const el = document.getElementById('api-key-val');
      el.textContent = apiKeyRaw;
      el.classList.add('revealed');
    }

    async function copyApiKey() {
      try {
        await navigator.clipboard.writeText(apiKeyRaw);
        toast('API key copied');
      } catch { toast('Copy failed', true); }
    }

    async function changePassword() {
      const np = document.getElementById('new-password').value;
      const cp = document.getElementById('confirm-password').value;
      if (!np) return toast('Enter a new password', true);
      if (np !== cp) return toast('Passwords do not match', true);
      if (np.length < 8) return toast('Password must be at least 8 characters', true);
      try {
        await api('PUT', '/api/reseller-portal/me', { newPassword: np });
        document.getElementById('new-password').value = '';
        document.getElementById('confirm-password').value = '';
        toast('Password updated');
      } catch(e) { toast(e.message, true); }
    }

    // ── Logout ────────────────────────────────────────────────────────────────
    async function logout() {
      await fetch('/api/reseller-portal/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/reseller-login';
    }

    // Auto-load dashboard
    loadDashboard();
  </script>
</body>
</html>`;
}

// ─── Route setup ───────────────────────────────────────────────────────────────

function setupResellerPortal(app, db, churches, resellerSystem, jwtSecret, requireAdmin) {
  const express = require('express');
  const { v4: uuidv4 } = require('uuid');
  const crypto = require('crypto');
  console.log('[ResellerPortal] Setup started');

  // ── Schema migration ────────────────────────────────────────────────────────
  const migrations = [
    "ALTER TABLE resellers ADD COLUMN portal_email TEXT",
    "ALTER TABLE resellers ADD COLUMN portal_password_hash TEXT",
  ];
  for (const m of migrations) {
    try { db.exec(m); } catch { /* already exists */ }
  }

  const authMiddleware = requireResellerPortalAuth(db, resellerSystem, jwtSecret);

  // ── Login page ───────────────────────────────────────────────────────────────
  app.get('/reseller-login', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildResellerLoginHtml());
  });

  // ── Login POST ────────────────────────────────────────────────────────────────
  app.post('/api/reseller-portal/login', express.urlencoded({ extended: false }), (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(400).send(buildResellerLoginHtml('Email and password are required.'));
    }
    const reseller = db.prepare('SELECT * FROM resellers WHERE portal_email = ?').get(email.trim().toLowerCase());
    if (!reseller || !reseller.portal_password_hash || !verifyPassword(password, reseller.portal_password_hash)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(401).send(buildResellerLoginHtml('Invalid email or password.'));
    }
    if (reseller.active === 0) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(403).send(buildResellerLoginHtml('This account has been deactivated.'));
    }
    const token = issueResellerToken(reseller.id, jwtSecret);
    res.cookie('tally_reseller_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.redirect('/reseller-portal');
  });

  // ── Logout ────────────────────────────────────────────────────────────────────
  app.post('/api/reseller-portal/logout', (req, res) => {
    res.clearCookie('tally_reseller_session');
    res.json({ ok: true });
  });

  // ── Portal HTML ───────────────────────────────────────────────────────────────
  app.get('/reseller-portal', authMiddleware, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildResellerPortalHtml(req.reseller));
  });

  // ── GET /api/reseller-portal/me ───────────────────────────────────────────────
  app.get('/api/reseller-portal/me', authMiddleware, (req, res) => {
    const stats = resellerSystem.getResellerStats(req.reseller.id, churches);
    const { portal_password_hash, ...safe } = req.reseller;
    res.json({ ...safe, ...stats });
  });

  // ── PUT /api/reseller-portal/me ───────────────────────────────────────────────
  app.put('/api/reseller-portal/me', authMiddleware, (req, res) => {
    const { brand_name, support_email, logo_url, primary_color, custom_domain, webhook_url, newPassword } = req.body;
    const resellerId = req.reseller.id;

    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
      db.prepare('UPDATE resellers SET portal_password_hash = ? WHERE id = ?').run(hashPassword(newPassword), resellerId);
    }

    const allowed = { brand_name, support_email, logo_url, primary_color, custom_domain, webhook_url };
    const patch = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));

    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map(k => `${k} = ?`).join(', ');
      db.prepare(`UPDATE resellers SET ${sets} WHERE id = ?`).run(...Object.values(patch), resellerId);
    }
    res.json({ ok: true });
  });

  // ── GET /api/reseller-portal/churches ─────────────────────────────────────────
  app.get('/api/reseller-portal/churches', authMiddleware, (req, res) => {
    const dbChurches = resellerSystem.getResellerChurches(req.reseller.id);
    const result = dbChurches.map(c => {
      const runtime = churches.get(c.churchId);
      const { token, portal_password_hash, ...safe } = c;
      return {
        ...safe,
        connected: runtime?.ws?.readyState === 1,
        lastSeen: runtime?.lastSeen || null,
      };
    });
    res.json(result);
  });

  // ── POST /api/reseller-portal/churches ────────────────────────────────────────
  app.post('/api/reseller-portal/churches', authMiddleware, (req, res) => {
    try {
      const { name, email } = req.body;
      if (!name) return res.status(400).json({ error: 'name required' });

      if (!resellerSystem.canAddChurch(req.reseller.id)) {
        return res.status(403).json({ error: `Church limit reached (${req.reseller.church_limit}). Contact support.` });
      }

      const result = resellerSystem.generateChurchToken(req.reseller.id, name);

      churches.set(result.churchId, {
        churchId: result.churchId,
        name: result.churchName,
        email: email || '',
        token: result.token,
        ws: null,
        status: { connected: false, atem: null, obs: null },
        lastSeen: null,
        lastHeartbeat: null,
        registeredAt: new Date().toISOString(),
        disconnectedAt: null,
        _offlineAlertSent: false,
        church_type: 'recurring',
        event_expires_at: null,
        event_label: null,
        reseller_id: req.reseller.id,
      });

      res.json({
        churchId: result.churchId,
        churchName: result.churchName,
        registrationCode: result.registrationCode,
      });
    } catch(e) {
      const status = e.message.includes('limit') ? 403 : e.message.includes('already exists') ? 409 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── DELETE /api/reseller-portal/churches/:id ──────────────────────────────────
  app.delete('/api/reseller-portal/churches/:churchId', authMiddleware, (req, res) => {
    const { churchId } = req.params;
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ? AND reseller_id = ?').get(churchId, req.reseller.id);
    if (!church) return res.status(404).json({ error: 'Church not found in your account' });

    // Disconnect WS if connected
    const runtime = churches.get(churchId);
    if (runtime?.ws) { try { runtime.ws.close(); } catch {} }
    churches.delete(churchId);
    db.prepare('DELETE FROM churches WHERE churchId = ?').run(churchId);

    console.log(`[ResellerPortal] Reseller ${req.reseller.id} removed church ${churchId}`);
    res.json({ ok: true });
  });

  // ── POST /api/reseller-portal/churches/:id/credentials ────────────────────────
  // Resellers can set church portal credentials for their own churches
  app.post('/api/reseller-portal/churches/:churchId/credentials', authMiddleware, (req, res) => {
    const { churchId } = req.params;
    const { email, password } = req.body;

    const church = db.prepare('SELECT * FROM churches WHERE churchId = ? AND reseller_id = ?').get(churchId, req.reseller.id);
    if (!church) return res.status(404).json({ error: 'Church not found in your account' });
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const conflict = db.prepare('SELECT churchId FROM churches WHERE portal_email = ? AND churchId != ?').get(email.toLowerCase(), churchId);
    if (conflict) return res.status(409).json({ error: 'Email already in use by another church' });

    db.prepare('UPDATE churches SET portal_email = ?, portal_password_hash = ? WHERE churchId = ?')
      .run(email.trim().toLowerCase(), hashPassword(password), churchId);

    res.json({ ok: true, email: email.trim().toLowerCase(), loginUrl: '/church-login' });
  });

  // ── Admin: set reseller portal credentials ────────────────────────────────────
  app.post('/api/resellers/:resellerId/portal-credentials', requireAdmin, (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = db.prepare('SELECT id FROM resellers WHERE portal_email = ? AND id != ?').get(email.toLowerCase(), req.params.resellerId);
    if (existing) return res.status(409).json({ error: 'Email already used by another reseller' });

    db.prepare('UPDATE resellers SET portal_email = ?, portal_password_hash = ? WHERE id = ?')
      .run(email.trim().toLowerCase(), hashPassword(password), req.params.resellerId);

    console.log(`[ResellerPortal] Set portal credentials for reseller ${req.params.resellerId}: ${email}`);
    res.json({ ok: true, email: email.trim().toLowerCase(), loginUrl: '/reseller-login' });
  });

  console.log('[ResellerPortal] ✓ Setup complete — routes registered');
}

module.exports = { setupResellerPortal };
