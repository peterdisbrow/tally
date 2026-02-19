/**
 * Multi-Church Dashboard — Admin + Reseller Portal
 *
 * buildDashboardHtml()          → Admin dashboard HTML (served via server.js)
 * buildResellerPortalHtml(r)    → White-labeled reseller portal HTML
 * setupDashboard(app, db, …)    → Optional: register routes via this module
 *
 * setupDashboard(app, db, getChurchStates) → { notifyUpdate }
 */

const ADMIN_KEY = () => process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';

// ─── Shared card/grid CSS + JS helpers ────────────────────────────────────────

const SHARED_STYLES = `
  :root {
    --bg:       #0f1117;
    --surface:  #1a1d27;
    --border:   #2a2d3e;
    --text:     #e2e4ef;
    --muted:    #6b7280;
    --green:    #22c55e;
    --yellow:   #f59e0b;
    --red:      #ef4444;
    --blue:     #3b82f6;
    --radius:   12px;
    --gap:      16px;
    --accent:   var(--green);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    min-height: 100vh;
    padding: 24px;
  }
  header {
    display: flex; align-items: center;
    justify-content: space-between;
    margin-bottom: 28px; flex-wrap: wrap; gap: 12px;
  }
  .logo { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.5px; }
  .logo span { color: var(--accent); }
  .status-bar {
    font-size: 0.8rem; color: var(--muted);
    display: flex; align-items: center; gap: 8px;
  }
  .sse-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--red); transition: background 0.3s;
  }
  .sse-dot.connected { background: var(--accent); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--gap);
  }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px;
    transition: border-color 0.25s;
  }
  .card:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .status-dot {
    width: 12px; height: 12px; border-radius: 50%;
    flex-shrink: 0; transition: background 0.3s;
  }
  .dot-green  { background: var(--green);  box-shadow: 0 0 6px var(--green); }
  .dot-yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .dot-red    { background: var(--red);    box-shadow: 0 0 6px var(--red); }
  .dot-gray   { background: var(--muted); }
  .church-name {
    font-size: 1rem; font-weight: 600; flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .alert-badge {
    background: var(--red); color: white; font-size: 0.7rem;
    font-weight: 700; padding: 2px 7px; border-radius: 99px; display: none;
  }
  .alert-badge.visible { display: inline-block; }
  .card-rows { display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; justify-content: space-between; align-items: center; font-size: 0.82rem; }
  .row-label { color: var(--muted); }
  .row-value { font-weight: 500; }
  .tag { font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 6px; }
  .tag-on  { background: rgba(34,197,94,0.15);  color: var(--green); }
  .tag-off { background: rgba(239,68,68,0.15);  color: var(--red); }
  .tag-na  { background: rgba(107,114,128,0.15); color: var(--muted); }
  .tag-encoder-on  { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .tag-encoder-off { background: rgba(107,114,128,0.15); color: var(--muted); }
  .tag-sync-ok     { background: rgba(34,197,94,0.15);   color: var(--green); }
  .tag-sync-warn   { background: rgba(245,158,11,0.15);  color: var(--yellow); }
  .tag-sync-crit   { background: rgba(239,68,68,0.15);   color: var(--red); }
  .tag-sync-na     { background: rgba(107,114,128,0.15); color: var(--muted); }
  .reseller-tag { font-size: 0.68rem; color: var(--muted); margin-top: 4px; }
  .last-seen { font-size: 0.75rem; color: var(--muted); margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
  .empty { text-align: center; color: var(--muted); padding: 48px; grid-column: 1/-1; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 500; display: none;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 28px; width: 420px;
    max-width: 95vw; max-height: 90vh; overflow-y: auto;
  }
  .modal h3 { font-size: 1.1rem; font-weight: 700; margin-bottom: 18px; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 5px; }
  .form-group input, .form-group select {
    width: 100%; background: rgba(255,255,255,0.04);
    border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-size: 0.85rem; padding: 9px 12px;
    font-family: inherit; transition: border-color 0.15s;
  }
  .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--accent); }
  .modal-actions { display: flex; gap: 10px; margin-top: 18px; justify-content: flex-end; }
  .btn {
    font-size: 0.82rem; font-weight: 700; padding: 9px 18px;
    border-radius: 8px; cursor: pointer; border: none; transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: var(--accent); color: #000; }
  .btn-secondary { background: rgba(255,255,255,0.08); color: var(--text); }
  .btn-danger { background: var(--red); color: white; }

  /* Success box */
  .success-box {
    background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.3);
    border-radius: 8px; padding: 14px; margin-top: 14px; display: none;
  }
  .success-box.visible { display: block; }
  .code-copy {
    font-family: monospace; font-size: 1.1rem; font-weight: 700;
    color: var(--accent); letter-spacing: 2px; cursor: pointer;
    background: rgba(0,0,0,0.3); border-radius: 6px; padding: 8px 14px;
    display: inline-block; margin: 8px 0; border: 1px solid rgba(34,197,94,0.2);
  }
  .code-copy:hover { background: rgba(0,0,0,0.5); }

  /* Collapsible */
  .collapsible { margin-bottom: 24px; }
  .collapsible-header {
    display: flex; align-items: center; justify-content: space-between;
    cursor: pointer; padding: 12px 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); font-weight: 600; font-size: 0.9rem;
    user-select: none;
  }
  .collapsible-header:hover { border-color: var(--accent); }
  .collapsible-header .chevron { transition: transform 0.2s; color: var(--muted); }
  .collapsible-header.open .chevron { transform: rotate(180deg); }
  .collapsible-body {
    background: var(--surface); border: 1px solid var(--border);
    border-top: none; border-radius: 0 0 var(--radius) var(--radius);
    padding: 16px; display: none;
  }
  .collapsible-body.open { display: block; }

  /* Stats bar */
  .stats-bar {
    display: flex; gap: 12px; flex-wrap: wrap;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 14px 20px; flex: 1; min-width: 110px;
  }
  .stat-card .stat-label { font-size: 0.75rem; color: var(--muted); margin-bottom: 4px; }
  .stat-card .stat-value { font-size: 1.4rem; font-weight: 700; color: var(--accent); }

  /* Reseller list */
  .reseller-list { display: flex; flex-direction: column; gap: 8px; }
  .reseller-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 14px; background: var(--bg);
    border: 1px solid var(--border); border-radius: 8px;
    font-size: 0.85rem;
  }
  .reseller-row .reseller-name { font-weight: 600; flex: 1; }
  .reseller-row .reseller-meta { color: var(--muted); font-size: 0.78rem; }
  .reseller-row .reseller-active { font-size: 0.72rem; padding: 2px 8px; border-radius: 99px; }
  .reseller-row .reseller-active.on { background: rgba(34,197,94,0.15); color: var(--green); }
  .reseller-row .reseller-active.off { background: rgba(239,68,68,0.15); color: var(--red); }

  /* API key section */
  .api-key-section {
    margin-top: 24px; padding: 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .api-key-section summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); font-weight: 600; }
  .api-key-section summary:hover { color: var(--text); }
  .api-key-val {
    font-family: monospace; font-size: 0.82rem; word-break: break-all;
    background: rgba(0,0,0,0.3); border-radius: 6px; padding: 10px 14px;
    margin-top: 10px; color: var(--muted); cursor: pointer; border: 1px solid var(--border);
  }
  .api-key-val:hover { color: var(--text); border-color: var(--accent); }

  /* Footer */
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 0.72rem; color: var(--muted); text-align: center; }
`;

// ─── Shared JS helpers ────────────────────────────────────────────────────────

const SHARED_JS = `
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function statusDotClass(church) {
  if (!church.connected) return 'dot-gray';
  if ((church.activeAlerts || 0) > 0) return 'dot-red';
  const s = church.status || {};
  const obsOk  = s.obs  ? s.obs.connected  : true;
  const atemOk = s.atem ? s.atem.connected : true;
  if (!obsOk || !atemOk) return 'dot-yellow';
  return 'dot-green';
}

function tag(val, truthy, falsy, na) {
  if (val === undefined || val === null) return '<span class="tag tag-na">' + (na || 'N/A') + '</span>';
  return val
    ? '<span class="tag tag-on">' + truthy + '</span>'
    : '<span class="tag tag-off">' + falsy + '</span>';
}

function fmtLastSeen(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  if (diff < 60)   return Math.round(diff) + 's ago';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  return d.toLocaleDateString();
}

function syncBadge(syncStatus) {
  const st = syncStatus && syncStatus.status;
  const ms = syncStatus && syncStatus.avOffsetMs;
  if (!st || st === 'unavailable') return '<span class="tag tag-sync-na">⚫ SYNC</span>';
  if (st === 'ok')       return '<span class="tag tag-sync-ok">🟢 SYNC &lt;33ms</span>';
  if (st === 'warn')     return \`<span class="tag tag-sync-warn">🟡 SYNC ~\${ms !== null && ms !== undefined ? Math.abs(ms) : '?'}ms</span>\`;
  if (st === 'critical') return \`<span class="tag tag-sync-crit">🔴 SYNC \${ms !== null && ms !== undefined ? Math.abs(ms) : '?'}ms</span>\`;
  return '<span class="tag tag-sync-na">⚫ SYNC</span>';
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    const el = event.target.closest ? event.target.closest('.code-copy') : event.target;
    if (el) { const orig = el.textContent; el.textContent = '✅ Copied!'; setTimeout(() => el.textContent = orig, 1500); }
  });
}
`;

// ─── Admin Dashboard HTML ─────────────────────────────────────────────────────

function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tally — Church Dashboard</title>
<style>
${SHARED_STYLES}

  /* ── AI Chat Panel ── */
  .ai-toggle {
    background: rgba(59,130,246,0.14); border: 1px solid rgba(59,130,246,0.35);
    color: #60a5fa; font-size: 0.78rem; font-weight: 700; padding: 6px 14px;
    border-radius: 8px; cursor: pointer; transition: all 0.2s;
    letter-spacing: 0.03em; white-space: nowrap;
  }
  .ai-toggle:hover { background: rgba(59,130,246,0.24); border-color: rgba(59,130,246,0.6); }
  .ai-toggle.active { background: rgba(59,130,246,0.28); border-color: #3b82f6; color: #93c5fd; }

  .ai-panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: 360px;
    background: var(--surface); border-left: 1px solid var(--border);
    display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform 0.28s cubic-bezier(0.4,0,0.2,1);
    z-index: 200; box-shadow: -6px 0 32px rgba(0,0,0,0.5);
  }
  .ai-panel.open { transform: translateX(0); }
  .ai-panel-header { padding: 18px 20px 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  .ai-panel-title { font-size: 0.95rem; font-weight: 700; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .ai-panel-icon { color: #3b82f6; font-size: 1rem; }
  .ai-panel-subtitle { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }
  .ai-close-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1.3rem; padding: 4px 6px; line-height: 1; border-radius: 6px; transition: all 0.15s; }
  .ai-close-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }
  .ai-messages { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth; }
  .ai-greeting { background: rgba(59,130,246,0.09); border: 1px solid rgba(59,130,246,0.22); border-radius: 10px; padding: 12px 14px; font-size: 0.82rem; color: #93c5fd; line-height: 1.55; margin-bottom: 4px; }
  .ai-msg { display: flex; flex-direction: column; gap: 3px; }
  .ai-msg.user { align-items: flex-end; }
  .ai-msg.assistant { align-items: flex-start; }
  .ai-bubble { padding: 10px 13px; font-size: 0.82rem; line-height: 1.55; max-width: 90%; word-break: break-word; border-radius: 10px; white-space: pre-wrap; }
  .ai-msg.user .ai-bubble { background: rgba(34,197,94,0.13); border: 1px solid rgba(34,197,94,0.25); color: var(--text); border-radius: 10px 10px 3px 10px; }
  .ai-msg.assistant .ai-bubble { background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.22); color: var(--text); border-radius: 10px 10px 10px 3px; }
  .ai-label { font-size: 0.7rem; color: var(--muted); padding: 0 3px; }
  .ai-thinking { padding: 0 16px 8px; font-size: 0.78rem; color: var(--muted); font-style: italic; display: none; flex-shrink: 0; }
  .ai-thinking.visible { display: block; }
  .ai-input-row { padding: 12px 14px; border-top: 1px solid var(--border); display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0; }
  .ai-input { flex: 1; background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.82rem; padding: 9px 12px; resize: none; font-family: inherit; line-height: 1.4; transition: border-color 0.15s; min-height: 38px; max-height: 100px; overflow-y: auto; }
  .ai-input:focus { outline: none; border-color: #3b82f6; }
  .ai-input::placeholder { color: var(--muted); }
  .ai-send { background: #3b82f6; border: none; border-radius: 8px; color: white; font-weight: 700; padding: 9px 16px; cursor: pointer; transition: opacity 0.15s; font-size: 0.82rem; flex-shrink: 0; height: 38px; }
  .ai-send:hover { opacity: 0.85; }
  .ai-send:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 600px) { .ai-panel { width: 100%; } }
</style>
</head>
<body>
<header>
  <div class="logo">⛪ <span>Tally</span> Dashboard</div>
  <div class="status-bar">
    <div class="sse-dot" id="sseDot"></div>
    <span id="sseStatus">Connecting…</span>
    <span>|</span>
    <span id="lastUpdate">–</span>
    <button style="background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.35);color:#4ade80;font-size:0.78rem;font-weight:700;padding:6px 14px;border-radius:8px;cursor:pointer;margin-left:6px;" onclick="openCreateResellerModal()">+ Reseller</button>
    <button class="ai-toggle" id="aiToggle" onclick="toggleAiPanel()">✦ AI</button>
  </div>
</header>

<!-- ── Resellers Collapsible ── -->
<div class="collapsible" id="resellersSection">
  <div class="collapsible-header" id="resellersHeader" onclick="toggleResellers()">
    <span>🏢 Resellers <span id="resellerCount" style="color:var(--muted);font-weight:400;font-size:0.8rem;margin-left:6px;"></span></span>
    <span class="chevron">▼</span>
  </div>
  <div class="collapsible-body" id="resellersBody">
    <div class="reseller-list" id="resellerList"><div style="color:var(--muted);font-size:0.85rem;">Loading…</div></div>
  </div>
</div>

<!-- ── Church Grid ── -->
<div class="grid" id="grid">
  <div class="empty">Loading churches…</div>
</div>

<!-- ── AI Chat Panel ── -->
<div class="ai-panel" id="aiPanel">
  <div class="ai-panel-header">
    <div>
      <div class="ai-panel-title"><span class="ai-panel-icon">✦</span> Tally AI</div>
      <div class="ai-panel-subtitle">Multi-church assistant</div>
    </div>
    <button class="ai-close-btn" onclick="toggleAiPanel()">×</button>
  </div>
  <div class="ai-messages" id="aiMessages">
    <div class="ai-greeting">Ask me anything about your churches.</div>
  </div>
  <div class="ai-thinking" id="aiThinking">✦ Tally AI is thinking…</div>
  <div class="ai-input-row">
    <textarea class="ai-input" id="aiInput" placeholder="Ask about church status, alerts, fixes…" rows="1"></textarea>
    <button class="ai-send" id="aiSend" onclick="sendAiMessage()">Send</button>
  </div>
</div>

<!-- ── Create Reseller Modal ── -->
<div class="modal-overlay" id="createResellerModal">
  <div class="modal">
    <h3>🏢 Create Reseller</h3>
    <div class="form-group">
      <label>Company Name *</label>
      <input type="text" id="cr_name" placeholder="VideoServ AV">
    </div>
    <div class="form-group">
      <label>Brand Name (shown to churches)</label>
      <input type="text" id="cr_brand" placeholder="VideoServ Monitor">
    </div>
    <div class="form-group">
      <label>Support Email</label>
      <input type="email" id="cr_email" placeholder="support@videoservav.com">
    </div>
    <div class="form-group">
      <label>Primary Color</label>
      <input type="color" id="cr_color" value="#22c55e" style="height:36px;padding:2px;">
    </div>
    <div class="form-group">
      <label>Church Limit</label>
      <input type="number" id="cr_limit" value="10" min="1" max="1000">
    </div>
    <div id="cr_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div id="cr_success" style="display:none;margin-top:12px;">
      <div style="color:var(--green);font-size:0.85rem;font-weight:600;margin-bottom:8px;">✅ Reseller created!</div>
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">API Key (save this — shown once):</div>
      <div class="code-copy" id="cr_apiKey" onclick="copyText(this.textContent)"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeCreateResellerModal()">Close</button>
      <button class="btn btn-primary" id="cr_submit" onclick="submitCreateReseller()">Create</button>
    </div>
  </div>
</div>

<script>
${SHARED_JS}
const KEY = new URLSearchParams(location.search).get('key') || new URLSearchParams(location.search).get('apikey') || '';
let es = null;
let _churchStates = {};
let _resellersMap = {};

// ── Reseller loading ──────────────────────────────────────────────────────────

async function loadResellers() {
  try {
    const resp = await fetch('/api/resellers?apikey=' + encodeURIComponent(KEY));
    if (!resp.ok) return;
    const data = await resp.json();
    if (Array.isArray(data)) {
      _resellersMap = {};
      data.forEach(r => { _resellersMap[r.id] = r; });
      renderResellerList(data);
      document.getElementById('resellerCount').textContent = '(' + data.length + ')';
    }
  } catch(e) { console.warn('Could not load resellers:', e.message); }
}

function renderResellerList(resellers) {
  const list = document.getElementById('resellerList');
  if (!resellers.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;">No resellers yet. Click "+ Reseller" to create one.</div>';
    return;
  }
  list.innerHTML = resellers.map(r => \`
    <div class="reseller-row">
      <div class="reseller-name">\${esc(r.brand_name || r.name)}</div>
      <div class="reseller-meta">\${r.churchCount} / \${r.church_limit} churches</div>
      <div class="reseller-meta" style="margin-left:8px;">\${r.support_email ? esc(r.support_email) : ''}</div>
      <span class="reseller-active \${r.active !== 0 ? 'on' : 'off'}">\${r.active !== 0 ? 'Active' : 'Inactive'}</span>
    </div>
  \`).join('');
}

function toggleResellers() {
  const header = document.getElementById('resellersHeader');
  const body = document.getElementById('resellersBody');
  header.classList.toggle('open');
  body.classList.toggle('open');
}

// ── Create Reseller Modal ──────────────────────────────────────────────────────

function openCreateResellerModal() {
  document.getElementById('createResellerModal').classList.add('open');
  document.getElementById('cr_error').style.display = 'none';
  document.getElementById('cr_success').style.display = 'none';
  document.getElementById('cr_submit').style.display = 'inline-block';
  document.getElementById('cr_name').focus();
}
function closeCreateResellerModal() {
  document.getElementById('createResellerModal').classList.remove('open');
  loadResellers();
}
async function submitCreateReseller() {
  const name  = document.getElementById('cr_name').value.trim();
  const brand = document.getElementById('cr_brand').value.trim();
  const email = document.getElementById('cr_email').value.trim();
  const color = document.getElementById('cr_color').value;
  const limit = parseInt(document.getElementById('cr_limit').value) || 10;
  const errEl = document.getElementById('cr_error');

  if (!name) { errEl.textContent = 'Company name is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  const btn = document.getElementById('cr_submit');
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const resp = await fetch('/api/resellers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
      body: JSON.stringify({ name, brandName: brand || name, supportEmail: email, primaryColor: color, churchLimit: limit }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Unknown error');
    document.getElementById('cr_apiKey').textContent = data.apiKey;
    document.getElementById('cr_success').style.display = 'block';
    btn.style.display = 'none';
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Create';
  }
}

// ── Church card rendering ──────────────────────────────────────────────────────

function renderCard(church) {
  const dotCls = statusDotClass(church);
  const alerts = church.activeAlerts || 0;
  const s = church.status || {};
  const atemConnected = s.atem && s.atem.connected;
  const obsStreaming  = s.obs  && s.obs.streaming;
  const obsConnected  = s.obs  && s.obs.connected;
  const encoderActive = church.encoderActive || false;
  const reseller = church.reseller_id && _resellersMap[church.reseller_id];
  const resellerTag = reseller
    ? \`<div class="reseller-tag">🏢 \${esc(reseller.brand_name || reseller.name)}</div>\`
    : '';

  const encoderBadge = encoderActive
    ? '<span class="tag tag-encoder-on">📡 Encoder</span>'
    : '<span class="tag tag-encoder-off">📡 Encoder</span>';
  const syncBadgeHtml = syncBadge(church.syncStatus);

  return \`<div class="card" id="card-\${esc(church.churchId)}">
    <div class="card-header">
      <div class="status-dot \${dotCls}"></div>
      <div class="church-name">\${esc(church.name)}</div>
      <span class="alert-badge \${alerts > 0 ? 'visible' : ''}">\${alerts} alert\${alerts !== 1 ? 's' : ''}</span>
    </div>
    \${resellerTag}
    <div class="card-rows">
      <div class="row"><span class="row-label">Connection</span><span class="row-value">\${tag(church.connected, 'Online', 'Offline')}</span></div>
      <div class="row"><span class="row-label">ATEM</span><span class="row-value">\${tag(atemConnected, 'Connected', 'Disconnected')}</span></div>
      <div class="row"><span class="row-label">OBS</span><span class="row-value">\${tag(obsConnected, 'Connected', 'Disconnected')}</span></div>
      <div class="row"><span class="row-label">Stream</span><span class="row-value">\${tag(obsStreaming, '🔴 Live', 'Off-air', 'Unknown')}</span></div>
      <div class="row"><span class="row-label">Encoder</span><span class="row-value">\${encoderBadge} \${syncBadgeHtml}</span></div>
    </div>
    <div class="last-seen">Last seen: \${fmtLastSeen(church.lastSeen)}</div>
  </div>\`;
}

function renderGrid(churchMap) {
  const grid = document.getElementById('grid');
  const ids = Object.keys(churchMap);
  if (!ids.length) { grid.innerHTML = '<div class="empty">No churches registered yet.</div>'; return; }
  grid.innerHTML = ids.map(id => renderCard(churchMap[id])).join('');
}

function upsertCard(church) {
  _churchStates[church.churchId] = { ...(_churchStates[church.churchId] || {}), ...church };
  const existing = document.getElementById('card-' + church.churchId);
  const html = renderCard(_churchStates[church.churchId]);
  if (existing) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    existing.replaceWith(tmp.firstElementChild);
  } else {
    const grid = document.getElementById('grid');
    const empty = grid.querySelector('.empty');
    if (empty) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', html);
  }
}

// ── SSE connection ────────────────────────────────────────────────────────────

function connect() {
  const url = '/api/dashboard/stream?key=' + encodeURIComponent(KEY);
  es = new EventSource(url);

  es.onopen = () => {
    document.getElementById('sseDot').classList.add('connected');
    document.getElementById('sseStatus').textContent = 'Live';
  };

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      document.getElementById('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();

      // Handle server.js format (type: initial, status_update, church_connected, church_disconnected)
      if (data.type === 'snapshot' || data.type === 'initial') {
        const arr = Array.isArray(data.churches) ? data.churches : Object.values(data.churches || {});
        _churchStates = {};
        arr.forEach(c => { _churchStates[c.churchId] = c; });
        renderGrid(_churchStates);
      } else if (data.type === 'update' && data.church) {
        upsertCard(data.church);
      } else if (data.type === 'church_connected') {
        upsertCard({ ...data, connected: true });
      } else if (data.type === 'church_disconnected') {
        upsertCard({ ...data, connected: false });
      } else if (data.type === 'status_update') {
        const existing = _churchStates[data.churchId] || {};
        upsertCard({ ...existing, churchId: data.churchId, name: data.name || existing.name, status: data.status || existing.status, lastSeen: data.timestamp || existing.lastSeen });
      } else if (data.type === 'alert') {
        const existing = _churchStates[data.churchId] || {};
        const prev = existing.activeAlerts || 0;
        upsertCard({ ...existing, churchId: data.churchId, activeAlerts: prev + 1 });
      }
    } catch {}
  };

  es.onerror = () => {
    document.getElementById('sseDot').classList.remove('connected');
    document.getElementById('sseStatus').textContent = 'Reconnecting…';
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();
loadResellers();

// ── AI Chat Panel ─────────────────────────────────────────────────────────────

function toggleAiPanel() {
  const panel = document.getElementById('aiPanel');
  const toggle = document.getElementById('aiToggle');
  const isOpen = panel.classList.toggle('open');
  toggle.classList.toggle('active', isOpen);
  if (isOpen) setTimeout(() => document.getElementById('aiInput').focus(), 300);
}

async function sendAiMessage() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = ''; input.style.height = 'auto';
  appendAiMessage('user', msg);
  const sendBtn = document.getElementById('aiSend');
  const thinking = document.getElementById('aiThinking');
  sendBtn.disabled = true; thinking.classList.add('visible');
  try {
    const res = await fetch('/api/chat?key=' + encodeURIComponent(KEY), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, churchStates: _churchStates }),
    });
    const data = await res.json();
    appendAiMessage('assistant', data.reply || data.error || 'No response.');
  } catch (e) { appendAiMessage('assistant', 'Connection error: ' + e.message); }
  finally { sendBtn.disabled = false; thinking.classList.remove('visible'); }
}

function appendAiMessage(role, text) {
  const msgs = document.getElementById('aiMessages');
  const wrapper = document.createElement('div'); wrapper.className = 'ai-msg ' + role;
  const bubble = document.createElement('div'); bubble.className = 'ai-bubble'; bubble.textContent = text;
  const label = document.createElement('div'); label.className = 'ai-label'; label.textContent = role === 'user' ? 'You' : 'Tally AI';
  wrapper.appendChild(bubble); wrapper.appendChild(label);
  msgs.appendChild(wrapper); msgs.scrollTop = msgs.scrollHeight;
}

document.getElementById('aiInput').addEventListener('input', function() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});
document.getElementById('aiInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(); }
});
</script>
</body>
</html>`;
}

// ─── Reseller Portal HTML ─────────────────────────────────────────────────────

/**
 * Build white-labeled reseller portal HTML.
 * @param {object} reseller - Reseller DB row (with api_key)
 * @returns {string} Full HTML page
 */
function buildResellerPortalHtml(reseller) {
  const brandName    = reseller.brand_name || 'Tally';
  const primaryColor = reseller.primary_color || '#22c55e';
  const logoUrl      = reseller.logo_url || null;
  const apiKey       = reseller.api_key || '';

  // Inject the primary_color override as a CSS var override
  const colorOverride = primaryColor !== '#22c55e'
    ? `:root { --accent: ${primaryColor}; --green: ${primaryColor}; }`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${brandName} — Church Monitor</title>
<style>
${SHARED_STYLES}
${colorOverride}
</style>
</head>
<body>

<header>
  <div class="logo">
    ${logoUrl ? `<img src="${logoUrl}" alt="${brandName}" style="height:32px;vertical-align:middle;margin-right:8px;">` : '⛪'}
    <span style="color:var(--accent)">${brandName}</span>
  </div>
  <div class="status-bar">
    <div class="sse-dot" id="sseDot"></div>
    <span id="sseStatus">Connecting…</span>
    <span>|</span>
    <span id="lastUpdate">–</span>
    <button style="background:rgba(255,255,255,0.08);border:1px solid var(--border);color:var(--text);font-size:0.78rem;font-weight:700;padding:6px 14px;border-radius:8px;cursor:pointer;" onclick="openAddChurchModal()">+ Add Church</button>
  </div>
</header>

<!-- Stats bar -->
<div class="stats-bar" id="statsBar">
  <div class="stat-card"><div class="stat-label">Total Churches</div><div class="stat-value" id="stat_total">–</div></div>
  <div class="stat-card"><div class="stat-label">Online Now</div><div class="stat-value" id="stat_online">–</div></div>
  <div class="stat-card"><div class="stat-label">Active Alerts</div><div class="stat-value" id="stat_alerts" style="color:var(--red);">–</div></div>
  <div class="stat-card"><div class="stat-label">Church Limit</div><div class="stat-value" id="stat_limit">–</div></div>
</div>

<!-- Church fleet grid -->
<div class="grid" id="grid">
  <div class="empty">Loading your churches…</div>
</div>

<!-- Add Church Modal -->
<div class="modal-overlay" id="addChurchModal">
  <div class="modal">
    <h3>+ Add Church</h3>
    <div class="form-group">
      <label>Church Name *</label>
      <input type="text" id="ac_name" placeholder="Grace Community Church">
    </div>
    <div class="form-group">
      <label>Contact Email</label>
      <input type="email" id="ac_email" placeholder="td@gracecommunity.org">
    </div>
    <div id="ac_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div class="success-box" id="ac_success">
      <div style="font-weight:600;color:var(--accent);margin-bottom:6px;">✅ Church registered!</div>
      <div style="font-size:0.82rem;color:var(--muted);margin-bottom:8px;">Share this code with your TD. They register with: <code>/register CODE</code></div>
      <div class="code-copy" id="ac_code" onclick="copyText(this.textContent)"></div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:8px;">Click the code to copy it.</div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeAddChurchModal()">Close</button>
      <button class="btn btn-primary" id="ac_submit" onclick="submitAddChurch()">Register Church</button>
    </div>
  </div>
</div>

<!-- API Key Section -->
<details class="api-key-section">
  <summary>🔑 API Key &amp; Integration</summary>
  <p style="font-size:0.78rem;color:var(--muted);margin-top:10px;margin-bottom:6px;">Your reseller API key (keep this secret):</p>
  <div class="api-key-val" onclick="copyText(this.textContent)" title="Click to copy">${apiKey}</div>
  <p style="font-size:0.75rem;color:var(--muted);margin-top:10px;">
    Use header <code style="background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:4px;">x-reseller-key: YOUR_KEY</code>
    to call the reseller API endpoints.
  </p>
</details>

<div class="footer">Powered by <strong>Tally</strong> — AV Monitoring Platform</div>

<script>
${SHARED_JS}

const RESELLER_KEY = '${apiKey.replace(/'/g, "\\'")}';
let es = null;
let _churchStates = {};

// ── Load stats ────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const resp = await fetch('/api/reseller/stats', {
      headers: { 'x-reseller-key': RESELLER_KEY }
    });
    if (!resp.ok) return;
    const data = await resp.json();
    document.getElementById('stat_total').textContent   = data.churchCount  ?? '–';
    document.getElementById('stat_online').textContent  = data.onlineCount  ?? '–';
    document.getElementById('stat_alerts').textContent  = data.alertCount   ?? '–';
    document.getElementById('stat_limit').textContent   = data.church_limit != null
      ? (data.churchCount + ' / ' + data.church_limit)
      : '–';
  } catch(e) { console.warn('Stats load failed:', e.message); }
}

// ── Church card rendering ──────────────────────────────────────────────────────

function renderCard(church) {
  const dotCls = statusDotClass(church);
  const alerts = church.activeAlerts || 0;
  const s = church.status || {};
  const atemConnected = s.atem && s.atem.connected;
  const obsStreaming   = s.obs  && s.obs.streaming;
  const obsConnected   = s.obs  && s.obs.connected;
  const encoderActive  = church.encoderActive || false;
  const encoderBadge = encoderActive
    ? '<span class="tag tag-encoder-on">📡 Encoder</span>'
    : '<span class="tag tag-encoder-off">📡 Encoder</span>';

  return \`<div class="card" id="card-\${esc(church.churchId)}">
    <div class="card-header">
      <div class="status-dot \${dotCls}"></div>
      <div class="church-name">\${esc(church.name)}</div>
      <span class="alert-badge \${alerts > 0 ? 'visible' : ''}">\${alerts} alert\${alerts !== 1 ? 's' : ''}</span>
    </div>
    <div class="card-rows">
      <div class="row"><span class="row-label">Connection</span><span class="row-value">\${tag(church.connected, 'Online', 'Offline')}</span></div>
      <div class="row"><span class="row-label">ATEM</span><span class="row-value">\${tag(atemConnected, 'Connected', 'Disconnected')}</span></div>
      <div class="row"><span class="row-label">OBS</span><span class="row-value">\${tag(obsConnected, 'Connected', 'Disconnected')}</span></div>
      <div class="row"><span class="row-label">Stream</span><span class="row-value">\${tag(obsStreaming, '🔴 Live', 'Off-air', 'Unknown')}</span></div>
    </div>
    <div class="last-seen">Last seen: \${fmtLastSeen(church.lastSeen)}</div>
  </div>\`;
}

function renderGrid(churches) {
  const grid = document.getElementById('grid');
  const arr = Array.isArray(churches) ? churches : Object.values(churches);
  if (!arr.length) { grid.innerHTML = '<div class="empty">No churches yet. Click "+ Add Church" to get started.</div>'; return; }
  grid.innerHTML = arr.map(c => renderCard(c)).join('');
}

function upsertCard(church) {
  _churchStates[church.churchId] = { ...(_churchStates[church.churchId] || {}), ...church };
  const existing = document.getElementById('card-' + church.churchId);
  const html = renderCard(_churchStates[church.churchId]);
  if (existing) {
    const tmp = document.createElement('div'); tmp.innerHTML = html;
    existing.replaceWith(tmp.firstElementChild);
  } else {
    const grid = document.getElementById('grid');
    const empty = grid.querySelector('.empty');
    if (empty) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', html);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connect() {
  const url = '/api/dashboard/stream?resellerKey=' + encodeURIComponent(RESELLER_KEY);
  es = new EventSource(url);

  es.onopen = () => {
    document.getElementById('sseDot').classList.add('connected');
    document.getElementById('sseStatus').textContent = 'Live';
  };

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      document.getElementById('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
      if (data.type === 'snapshot' || data.type === 'initial') {
        const arr = Array.isArray(data.churches) ? data.churches : Object.values(data.churches || {});
        _churchStates = {};
        arr.forEach(c => { _churchStates[c.churchId] = c; });
        renderGrid(Object.values(_churchStates));
        loadStats();
      } else if (data.type === 'update' && data.church) {
        upsertCard(data.church);
      } else if (data.type === 'church_connected') {
        upsertCard({ ...data, connected: true });
        loadStats();
      } else if (data.type === 'church_disconnected') {
        upsertCard({ ...data, connected: false });
        loadStats();
      } else if (data.type === 'status_update') {
        const existing = _churchStates[data.churchId] || {};
        upsertCard({ ...existing, churchId: data.churchId, name: data.name || existing.name, status: data.status || existing.status, lastSeen: data.timestamp || existing.lastSeen });
      }
    } catch {}
  };

  es.onerror = () => {
    document.getElementById('sseDot').classList.remove('connected');
    document.getElementById('sseStatus').textContent = 'Reconnecting…';
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();
loadStats();

// ── Add Church Modal ──────────────────────────────────────────────────────────

function openAddChurchModal() {
  document.getElementById('addChurchModal').classList.add('open');
  document.getElementById('ac_error').style.display = 'none';
  document.getElementById('ac_success').classList.remove('visible');
  document.getElementById('ac_submit').style.display = 'inline-block';
  document.getElementById('ac_name').value = '';
  document.getElementById('ac_email').value = '';
  setTimeout(() => document.getElementById('ac_name').focus(), 100);
}
function closeAddChurchModal() {
  document.getElementById('addChurchModal').classList.remove('open');
  loadStats();
}

async function submitAddChurch() {
  const name  = document.getElementById('ac_name').value.trim();
  const email = document.getElementById('ac_email').value.trim();
  const errEl = document.getElementById('ac_error');
  if (!name) { errEl.textContent = 'Church name is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';

  const btn = document.getElementById('ac_submit');
  btn.disabled = true; btn.textContent = 'Registering…';

  try {
    const resp = await fetch('/api/reseller/churches/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-reseller-key': RESELLER_KEY },
      body: JSON.stringify({ churchName: name, contactEmail: email }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Registration failed');
    document.getElementById('ac_code').textContent = data.registrationCode;
    document.getElementById('ac_success').classList.add('visible');
    btn.style.display = 'none';
    // Add to local state
    if (data.churchId) {
      _churchStates[data.churchId] = { churchId: data.churchId, name, connected: false, status: {}, lastSeen: null, activeAlerts: 0 };
      upsertCard(_churchStates[data.churchId]);
    }
  } catch(e) {
    errEl.textContent = e.message; errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = 'Register Church';
  }
}
</script>
</body>
</html>`;
}

// ─── setupDashboard (kept for backward compatibility) ─────────────────────────

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {function} getChurchStates
 * @returns {{ notifyUpdate: function }}
 */
function setupDashboard(app, db, getChurchStates) {
  const sseClients = new Set();

  function checkKey(req, res) {
    const key = req.query.key || req.query.apikey;
    if (key !== ADMIN_KEY()) {
      res.status(401).send('Unauthorized — add ?key=ADMIN_KEY to the URL');
      return false;
    }
    return true;
  }

  app.get('/dashboard', (req, res) => {
    if (!checkKey(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildDashboardHtml());
  });

  app.get('/api/dashboard/stream', (req, res) => {
    if (!checkKey(req, res)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    try {
      const states = getChurchStates();
      res.write(`data: ${JSON.stringify({ type: 'snapshot', churches: states })}\n\n`);
    } catch (e) { console.error('[Dashboard] Initial snapshot error:', e.message); }
    sseClients.add(res);
    const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 30_000);
    req.on('close', () => { sseClients.delete(res); clearInterval(keepalive); });
  });

  app.post('/api/chat', async (req, res) => {
    if (!checkKey(req, res)) return;
    const { message, churchStates } = req.body || {};
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message (string) required' });
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.json({ reply: 'AI assistant not configured — set ANTHROPIC_API_KEY.' });
    const systemPrompt = 'You are Tally AI, admin assistant for a multi-church AV monitoring system. Church states: ' + JSON.stringify(churchStates || {});
    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 512, system: systemPrompt, messages: [{ role: 'user', content: message }] }),
      });
      const data = await aiRes.json();
      res.json({ reply: data.content?.[0]?.text || 'No response.' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  function notifyUpdate(changedChurchId = null) {
    if (!sseClients.size) return;
    try {
      const states = getChurchStates();
      if (changedChurchId) {
        const church = states[changedChurchId];
        if (church) {
          const payload = JSON.stringify({ type: 'update', church });
          for (const res of sseClients) { try { res.write(`data: ${payload}\n\n`); } catch {} }
          return;
        }
      }
      const payload = JSON.stringify({ type: 'snapshot', churches: states });
      for (const res of sseClients) { try { res.write(`data: ${payload}\n\n`); } catch {} }
    } catch (e) { console.error('[Dashboard] notifyUpdate error:', e.message); }
  }

  console.log('[Dashboard] Routes registered — /dashboard and /api/dashboard/stream');
  return { notifyUpdate };
}

module.exports = { setupDashboard, buildDashboardHtml, buildResellerPortalHtml };
