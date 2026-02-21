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
  .form-group input, .form-group select, .form-group textarea {
    width: 100%; background: rgba(255,255,255,0.04);
    border: 1px solid var(--border); border-radius: 8px;
    color: var(--text); font-size: 0.85rem; padding: 9px 12px;
    font-family: inherit; transition: border-color 0.15s;
  }
  .form-group input:focus, .form-group select:focus, .form-group textarea:focus { outline: none; border-color: var(--accent); }
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
  .stats-bar { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
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
    border: 1px solid var(--border); border-radius: 8px; font-size: 0.85rem;
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

  /* Pulse animation for real-time status changes */
  @keyframes pulse-green {
    0%   { background: rgba(34,197,94,0.35); }
    100% { background: rgba(34,197,94,0.15); }
  }
  @keyframes pulse-red {
    0%   { background: rgba(239,68,68,0.35); }
    100% { background: rgba(239,68,68,0.15); }
  }
  @keyframes pulse-card {
    0%   { border-color: var(--accent); box-shadow: 0 0 12px rgba(34,197,94,0.15); }
    100% { border-color: var(--border); box-shadow: none; }
  }
  @keyframes pulse-dot {
    0%   { transform: scale(1.5); }
    100% { transform: scale(1); }
  }
  .tag.pulse-on  { animation: pulse-green 0.6s ease-out; }
  .tag.pulse-off { animation: pulse-red   0.6s ease-out; }
  .card.pulse     { animation: pulse-card  0.8s ease-out; }
  .status-dot.pulse { animation: pulse-dot 0.6s ease-out; }

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

/* ── Incremental card patching ─────────────────────────────────────────────── */

function triggerPulse(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;            // force reflow to restart animation
  el.classList.add(cls);
  el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/**
 * Patch an existing card in-place — only touches the DOM elements that actually
 * changed, and fires a pulse animation on anything that flipped.
 *
 * Returns false if the card doesn't exist yet (caller should fall back to full render).
 */
function patchCard(church) {
  const card = document.getElementById('card-' + church.churchId);
  if (!card) return false;

  const s = church.status || {};
  const atemConnected = s.atem && s.atem.connected;
  const obsConnected  = s.obs  && s.obs.connected;
  const obsStreaming   = s.obs  && s.obs.streaming;
  const encoderActive  = church.encoderActive || false;
  const alerts = church.activeAlerts || 0;

  // 1) Status dot
  const dot = card.querySelector('.status-dot');
  if (dot) {
    const newDot = statusDotClass(church);
    const old = ['dot-green','dot-yellow','dot-red','dot-gray'].find(c => dot.classList.contains(c));
    if (old !== newDot) {
      if (old) dot.classList.remove(old);
      dot.classList.add(newDot);
      triggerPulse(dot, 'pulse');
    }
  }

  // 2) Row values — Connection, ATEM, OBS, Stream, (Encoder if present)
  const rows = card.querySelectorAll('.card-rows .row');
  const rowDefs = [
    { val: church.connected, on: 'Online',    off: 'Offline' },
    { val: atemConnected,    on: 'Connected',  off: 'Disconnected' },
    { val: obsConnected,     on: 'Connected',  off: 'Disconnected' },
    { val: obsStreaming,     on: '🔴 Live',    off: 'Off-air', na: 'Unknown' },
  ];
  rowDefs.forEach((def, i) => {
    if (i >= rows.length) return;
    const rv = rows[i].querySelector('.row-value');
    if (!rv) return;
    const newHtml = tag(def.val, def.on, def.off, def.na || undefined);
    if (rv.innerHTML !== newHtml) {
      rv.innerHTML = newHtml;
      const t = rv.querySelector('.tag');
      if (t) triggerPulse(t, def.val ? 'pulse-on' : 'pulse-off');
    }
  });

  // 3) Encoder row (5th row) — update encoder badge + sync badge
  if (rows.length >= 5) {
    const rv = rows[4].querySelector('.row-value');
    if (rv) {
      const encoderBadge = encoderActive
        ? '<span class="tag tag-encoder-on">📡 Encoder</span>'
        : '<span class="tag tag-encoder-off">📡 Encoder</span>';
      const newHtml = encoderBadge + ' ' + syncBadge(church.syncStatus);
      if (rv.innerHTML !== newHtml) rv.innerHTML = newHtml;
    }
  }

  // 4) Alert badge
  const badge = card.querySelector('.alert-badge');
  if (badge) {
    const wasVisible = badge.classList.contains('visible');
    const nowVisible = alerts > 0;
    badge.textContent = alerts + ' alert' + (alerts !== 1 ? 's' : '');
    if (nowVisible && !wasVisible)  badge.classList.add('visible');
    if (!nowVisible && wasVisible) badge.classList.remove('visible');
  }

  // 5) Last seen
  const ls = card.querySelector('.last-seen');
  if (ls) ls.textContent = 'Last seen: ' + fmtLastSeen(church.lastSeen);

  // 6) Pulse the card border briefly
  triggerPulse(card, 'pulse');

  return true;
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
  .ai-toggle { background:rgba(59,130,246,0.14);border:1px solid rgba(59,130,246,0.35);color:#60a5fa;font-size:0.78rem;font-weight:700;padding:6px 14px;border-radius:8px;cursor:pointer;transition:all 0.2s;letter-spacing:0.03em;white-space:nowrap; }
  .ai-toggle:hover { background:rgba(59,130,246,0.24);border-color:rgba(59,130,246,0.6); }
  .ai-toggle.active { background:rgba(59,130,246,0.28);border-color:#3b82f6;color:#93c5fd; }
  .ai-panel { position:fixed;top:0;right:0;bottom:0;width:360px;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.28s cubic-bezier(0.4,0,0.2,1);z-index:200;box-shadow:-6px 0 32px rgba(0,0,0,0.5); }
  .ai-panel.open { transform:translateX(0); }
  .ai-panel-header { padding:18px 20px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0; }
  .ai-panel-title { font-size:0.95rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:8px; }
  .ai-panel-icon { color:#3b82f6;font-size:1rem; }
  .ai-panel-subtitle { font-size:0.72rem;color:var(--muted);margin-top:2px; }
  .ai-close-btn { background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.3rem;padding:4px 6px;line-height:1;border-radius:6px;transition:all 0.15s; }
  .ai-close-btn:hover { color:var(--text);background:rgba(255,255,255,0.06); }
  .ai-messages { flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth; }
  .ai-greeting { background:rgba(59,130,246,0.09);border:1px solid rgba(59,130,246,0.22);border-radius:10px;padding:12px 14px;font-size:0.82rem;color:#93c5fd;line-height:1.55;margin-bottom:4px; }
  .ai-msg { display:flex;flex-direction:column;gap:3px; }
  .ai-msg.user { align-items:flex-end; }
  .ai-msg.assistant { align-items:flex-start; }
  .ai-bubble { padding:10px 13px;font-size:0.82rem;line-height:1.55;max-width:90%;word-break:break-word;border-radius:10px;white-space:pre-wrap; }
  .ai-msg.user .ai-bubble { background:rgba(34,197,94,0.13);border:1px solid rgba(34,197,94,0.25);color:var(--text);border-radius:10px 10px 3px 10px; }
  .ai-msg.assistant .ai-bubble { background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.22);color:var(--text);border-radius:10px 10px 10px 3px; }
  .ai-label { font-size:0.7rem;color:var(--muted);padding:0 3px; }
  .ai-thinking { padding:0 16px 8px;font-size:0.78rem;color:var(--muted);font-style:italic;display:none;flex-shrink:0; }
  .ai-thinking.visible { display:block; }
  .ai-input-row { padding:12px 14px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end;flex-shrink:0; }
  .ai-input { flex:1;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.82rem;padding:9px 12px;resize:none;font-family:inherit;line-height:1.4;transition:border-color 0.15s;min-height:38px;max-height:100px;overflow-y:auto; }
  .ai-input:focus { outline:none;border-color:#3b82f6; }
  .ai-input::placeholder { color:var(--muted); }
  .ai-send { background:#3b82f6;border:none;border-radius:8px;color:white;font-weight:700;padding:9px 16px;cursor:pointer;transition:opacity 0.15s;font-size:0.82rem;flex-shrink:0;height:38px; }
  .ai-send:hover { opacity:0.85; }
  .ai-send:disabled { opacity:0.4;cursor:default; }

  /* ── Tab bar ── */
  .tab-bar { display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:20px;flex-wrap:wrap; }
  .tab-btn { background:none;border:none;color:var(--muted);font-size:0.82rem;font-weight:600;padding:10px 16px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.15s;white-space:nowrap; }
  .tab-btn:hover { color:var(--text); }
  .tab-btn.active { color:var(--accent);border-bottom-color:var(--accent); }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; }

  /* ── Church detail drawer ── */
  .drawer-overlay { position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:150;display:none; }
  .drawer-overlay.open { display:block; }
  .drawer { position:fixed;top:0;right:0;bottom:0;width:520px;max-width:95vw;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.28s cubic-bezier(0.4,0,0.2,1);z-index:151;box-shadow:-8px 0 40px rgba(0,0,0,0.6); }
  .drawer.open { transform:translateX(0); }
  .drawer-header { padding:16px 20px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0; }
  .drawer-title { font-size:1rem;font-weight:700; }
  .drawer-subtitle { font-size:0.75rem;color:var(--muted);margin-top:2px; }
  .drawer-tabs { display:flex;gap:1px;padding:8px 16px 0;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto; }
  .drawer-tab { background:none;border:none;color:var(--muted);font-size:0.75rem;font-weight:600;padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:all 0.15s;white-space:nowrap; }
  .drawer-tab:hover { color:var(--text); }
  .drawer-tab.active { color:var(--accent);border-bottom-color:var(--accent); }
  .drawer-body { flex:1;overflow-y:auto;padding:16px; }
  .drawer-item { padding:10px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:8px; }
  .drawer-item:last-child { border-bottom:none; }
  .drawer-item-label { font-size:0.78rem;color:var(--muted);flex-shrink:0; }
  .drawer-item-value { font-size:0.82rem;font-weight:500;text-align:right;word-break:break-all; }
  .drawer-empty { color:var(--muted);font-size:0.85rem;padding:24px 0;text-align:center; }
  .drawer-section-title { font-size:0.72rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin:16px 0 8px; }

  /* ── Action menu ── */
  .card-actions { position:relative;display:inline-flex;align-items:center; }
  .card-action-btn { background:none;border:none;color:var(--muted);cursor:pointer;font-size:1.1rem;padding:2px 7px;border-radius:4px;line-height:1;font-weight:700; }
  .card-action-btn:hover { color:var(--text);background:rgba(255,255,255,0.08); }
  .action-menu { position:absolute;top:calc(100% + 4px);right:0;z-index:50;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);min-width:170px;display:none;overflow:hidden; }
  .action-menu.open { display:block; }
  .action-item { padding:9px 14px;font-size:0.82rem;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background 0.1s;color:var(--text); }
  .action-item:hover { background:rgba(255,255,255,0.07); }
  .action-item.danger { color:var(--red); }

  /* ── Data tables ── */
  .data-table { width:100%;border-collapse:collapse;font-size:0.82rem; }
  .data-table th { text-align:left;padding:8px 12px;color:var(--muted);font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid var(--border); }
  .data-table td { padding:10px 12px;border-bottom:1px solid rgba(42,45,62,0.5);vertical-align:middle; }
  .data-table tr:last-child td { border-bottom:none; }
  .data-table tr:hover td { background:rgba(255,255,255,0.02); }

  /* ── Section helpers ── */
  .section-header { display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px; }
  .section-title { font-size:0.95rem;font-weight:700; }
  .section-empty { color:var(--muted);font-size:0.85rem;padding:32px;text-align:center;border:1px dashed var(--border);border-radius:var(--radius); }
  .section-loading { color:var(--muted);font-size:0.85rem;padding:24px;text-align:center; }
  .digest-meta { font-size:0.72rem;color:var(--muted);margin-bottom:16px; }
  .digest-card { background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:20px; }

  @media (max-width:600px) { .ai-panel { width:100%; } .drawer { width:100%; } }
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

<nav class="tab-bar">
  <button class="tab-btn active" data-tab="churches" onclick="switchTab('churches')">⛪ Churches</button>
  <button class="tab-btn" data-tab="events"   onclick="switchTab('events')">🎬 Events</button>
  <button class="tab-btn" data-tab="billing"  onclick="switchTab('billing')">💳 Billing</button>
  <button class="tab-btn" data-tab="digest"   onclick="switchTab('digest')">📋 Digest</button>
  <button class="tab-btn" data-tab="guests"   onclick="switchTab('guests')">👥 Guest TDs</button>
</nav>

<!-- ── Churches tab ── -->
<div class="tab-panel active" id="tab-churches">
  <div class="collapsible" id="resellersSection">
    <div class="collapsible-header" id="resellersHeader" onclick="toggleResellers()">
      <span>🏢 Resellers <span id="resellerCount" style="color:var(--muted);font-weight:400;font-size:0.8rem;margin-left:6px;"></span></span>
      <span class="chevron">▼</span>
    </div>
    <div class="collapsible-body" id="resellersBody">
      <div class="reseller-list" id="resellerList"><div style="color:var(--muted);font-size:0.85rem;">Loading…</div></div>
    </div>
  </div>
  <div class="grid" id="grid"><div class="empty">Loading churches…</div></div>
</div>

<!-- ── Events tab ── -->
<div class="tab-panel" id="tab-events">
  <div class="section-header">
    <div class="section-title">🎬 Events</div>
    <button class="btn btn-primary" onclick="openCreateEventModal()">+ Create Event</button>
  </div>
  <div id="eventsContent"><div class="section-loading">Loading…</div></div>
</div>

<!-- ── Billing tab ── -->
<div class="tab-panel" id="tab-billing">
  <div class="section-header">
    <div class="section-title">💳 Billing</div>
    <button class="btn btn-secondary" onclick="loadBilling()">↻ Refresh</button>
  </div>
  <div id="billingContent"><div class="section-loading">Loading…</div></div>
</div>

<!-- ── Digest tab ── -->
<div class="tab-panel" id="tab-digest">
  <div class="section-header">
    <div class="section-title">📋 Weekly Digest</div>
    <button class="btn btn-secondary" id="generateDigestBtn" onclick="generateDigest()">⚡ Generate Now</button>
  </div>
  <div id="digestContent"><div class="section-loading">Loading…</div></div>
</div>

<!-- ── Guest TDs tab ── -->
<div class="tab-panel" id="tab-guests">
  <div class="section-header">
    <div class="section-title">👥 Guest TDs</div>
    <button class="btn btn-primary" onclick="openIssueGuestModal()">+ Issue Token</button>
  </div>
  <div id="guestsContent"><div class="section-loading">Loading…</div></div>
</div>

<!-- ── Church detail drawer ── -->
<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
<div class="drawer" id="churchDrawer">
  <div class="drawer-header">
    <div>
      <div class="drawer-title" id="drawerTitle">Church Details</div>
      <div class="drawer-subtitle" id="drawerSubtitle"></div>
    </div>
    <button class="ai-close-btn" onclick="closeDrawer()">×</button>
  </div>
  <div class="drawer-tabs">
    <button class="drawer-tab active" data-dtab="overview"     onclick="switchDrawerTab('overview')">Overview</button>
    <button class="drawer-tab" data-dtab="tds"         onclick="switchDrawerTab('tds')">TDs</button>
    <button class="drawer-tab" data-dtab="schedule"    onclick="switchDrawerTab('schedule')">Schedule</button>
    <button class="drawer-tab" data-dtab="sessions"    onclick="switchDrawerTab('sessions')">Sessions</button>
    <button class="drawer-tab" data-dtab="presets"     onclick="switchDrawerTab('presets')">Presets</button>
    <button class="drawer-tab" data-dtab="maintenance" onclick="switchDrawerTab('maintenance')">Maintenance</button>
  </div>
  <div class="drawer-body" id="drawerBody"><div class="drawer-empty">Select a church to view details.</div></div>
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

<!-- ── Modal: Create Reseller ── -->
<div class="modal-overlay" id="createResellerModal">
  <div class="modal">
    <h3>🏢 Create Reseller</h3>
    <div class="form-group"><label>Company Name *</label><input type="text" id="cr_name" placeholder="VideoServ AV"></div>
    <div class="form-group"><label>Brand Name</label><input type="text" id="cr_brand" placeholder="VideoServ Monitor"></div>
    <div class="form-group"><label>Support Email</label><input type="email" id="cr_email" placeholder="support@videoservav.com"></div>
    <div class="form-group"><label>Primary Color</label><input type="color" id="cr_color" value="#22c55e" style="height:36px;padding:2px;"></div>
    <div class="form-group"><label>Church Limit</label><input type="number" id="cr_limit" value="10" min="1" max="1000"></div>
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

<!-- ── Modal: Create Event ── -->
<div class="modal-overlay" id="createEventModal">
  <div class="modal">
    <h3>🎬 Create Event</h3>
    <div class="form-group"><label>Church *</label><select id="ce_church"></select></div>
    <div class="form-group"><label>Event Name *</label><input type="text" id="ce_name" placeholder="Sunday Morning Service"></div>
    <div class="form-group"><label>Duration (hours)</label><input type="number" id="ce_duration" value="4" min="1" max="72"></div>
    <div id="ce_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal('createEventModal')">Cancel</button>
      <button class="btn btn-primary" id="ce_submit" onclick="submitCreateEvent()">Create</button>
    </div>
  </div>
</div>

<!-- ── Modal: Send Command ── -->
<div class="modal-overlay" id="commandModal">
  <div class="modal">
    <h3>💬 Send Command</h3>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:14px;">To: <strong id="cmd_churchName" style="color:var(--text)"></strong></div>
    <div class="form-group"><label>Command</label><textarea id="cmd_text" rows="3" placeholder="e.g. cut, cam1, stream.start"></textarea></div>
    <div id="cmd_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div id="cmd_success" style="color:var(--green);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal('commandModal')">Close</button>
      <button class="btn btn-primary" id="cmd_submit" onclick="submitCommand()">Send</button>
    </div>
  </div>
</div>

<!-- ── Modal: Broadcast ── -->
<div class="modal-overlay" id="broadcastModal">
  <div class="modal">
    <h3>📢 Broadcast Message</h3>
    <div style="font-size:0.82rem;color:var(--muted);margin-bottom:14px;">To: <strong id="bc_churchName" style="color:var(--text)"></strong></div>
    <div class="form-group"><label>Message</label><textarea id="bc_text" rows="3" placeholder="Message to display on all TD screens…"></textarea></div>
    <div id="bc_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div id="bc_success" style="color:var(--green);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal('broadcastModal')">Close</button>
      <button class="btn btn-primary" id="bc_submit" onclick="submitBroadcast()">Broadcast</button>
    </div>
  </div>
</div>

<!-- ── Modal: Billing Status ── -->
<div class="modal-overlay" id="billingStatusModal">
  <div class="modal">
    <h3>💳 Billing Status</h3>
    <div id="billingStatusContent" style="font-size:0.85rem;color:var(--muted);">Loading…</div>
    <div class="modal-actions"><button class="btn btn-secondary" onclick="closeModal('billingStatusModal')">Close</button></div>
  </div>
</div>

<!-- ── Modal: Issue Guest Token ── -->
<div class="modal-overlay" id="guestTokenModal">
  <div class="modal">
    <h3>👥 Issue Guest TD Token</h3>
    <div class="form-group"><label>Church *</label><select id="gt_church"></select></div>
    <div id="gt_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div id="gt_success" style="display:none;margin-top:12px;">
      <div style="color:var(--green);font-size:0.85rem;font-weight:600;margin-bottom:8px;">✅ Token issued!</div>
      <div style="font-size:0.78rem;color:var(--muted);margin-bottom:4px;">Share with the guest TD:</div>
      <div class="code-copy" id="gt_token" onclick="copyText(this.textContent)" style="word-break:break-all;font-size:0.78rem;letter-spacing:0;"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" onclick="closeModal('guestTokenModal')">Close</button>
      <button class="btn btn-primary" id="gt_submit" onclick="submitIssueGuest()">Issue</button>
    </div>
  </div>
</div>

<script>
${SHARED_JS}
let KEY = new URLSearchParams(location.search).get('key') || new URLSearchParams(location.search).get('apikey') || '';
// KEY is kept for backward-compatible one-time logins only. Normal operation uses
// cookie/session auth; header fallback keeps existing behavior for direct URL login URLs.
let es = null;
let _churchStates = {};
let _resellersMap = {};
let _drawerChurchId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function adminFetch(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (KEY) headers['x-api-key'] = KEY; // optional fallback only for URL-based one-time sessions
  return fetch(url, { ...opts, headers });
}
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function populateChurchSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const opts = Object.values(_churchStates);
  sel.innerHTML = opts.length
    ? opts.map(c => \`<option value="\${esc(c.churchId)}">\${esc(c.name)}</option>\`).join('')
    : '<option value="">No churches available</option>';
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'events')  loadEvents();
  if (tab === 'billing') loadBilling();
  if (tab === 'digest')  loadDigest();
  if (tab === 'guests')  loadGuests();
}

// ── Resellers ─────────────────────────────────────────────────────────────────

async function loadResellers() {
  try {
    const resp = await adminFetch('/api/resellers');
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
  if (!resellers.length) { list.innerHTML = '<div style="color:var(--muted);font-size:0.85rem;">No resellers yet.</div>'; return; }
  list.innerHTML = resellers.map(r => \`
    <div class="reseller-row">
      <div class="reseller-name">\${esc(r.brand_name || r.name)}</div>
      <div class="reseller-meta">\${r.churchCount} / \${r.church_limit} churches</div>
      <div class="reseller-meta" style="margin-left:8px;">\${r.support_email ? esc(r.support_email) : ''}</div>
      <span class="reseller-active \${r.active !== 0 ? 'on' : 'off'}">\${r.active !== 0 ? 'Active' : 'Inactive'}</span>
    </div>\`).join('');
}

function toggleResellers() {
  document.getElementById('resellersHeader').classList.toggle('open');
  document.getElementById('resellersBody').classList.toggle('open');
}

function openCreateResellerModal() {
  openModal('createResellerModal');
  document.getElementById('cr_error').style.display = 'none';
  document.getElementById('cr_success').style.display = 'none';
  const btn = document.getElementById('cr_submit');
  btn.style.display = 'inline-block'; btn.disabled = false; btn.textContent = 'Create';
  setTimeout(() => document.getElementById('cr_name').focus(), 100);
}
function closeCreateResellerModal() { closeModal('createResellerModal'); loadResellers(); }

async function submitCreateReseller() {
  const name  = document.getElementById('cr_name').value.trim();
  const brand = document.getElementById('cr_brand').value.trim();
  const email = document.getElementById('cr_email').value.trim();
  const color = document.getElementById('cr_color').value;
  const limit = parseInt(document.getElementById('cr_limit').value) || 10;
  const errEl = document.getElementById('cr_error');
  if (!name) { errEl.textContent = 'Company name is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  const btn = document.getElementById('cr_submit'); btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const resp = await adminFetch('/api/resellers', { method: 'POST', body: JSON.stringify({ name, brandName: brand || name, supportEmail: email, primaryColor: color, churchLimit: limit }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Unknown error');
    document.getElementById('cr_apiKey').textContent = data.apiKey;
    document.getElementById('cr_success').style.display = 'block';
    btn.style.display = 'none';
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create'; }
}

// ── Church cards ──────────────────────────────────────────────────────────────

function renderCard(church) {
  const dotCls = statusDotClass(church);
  const alerts = church.activeAlerts || 0;
  const s = church.status || {};
  const atemConnected = s.atem && s.atem.connected;
  const obsStreaming   = s.obs  && s.obs.streaming;
  const obsConnected   = s.obs  && s.obs.connected;
  const encoderActive  = church.encoderActive || false;
  const reseller = church.reseller_id && _resellersMap[church.reseller_id];
  const resellerTag = reseller ? \`<div class="reseller-tag">🏢 \${esc(reseller.brand_name || reseller.name)}</div>\` : '';
  const encoderBadge = encoderActive ? '<span class="tag tag-encoder-on">📡 Encoder</span>' : '<span class="tag tag-encoder-off">📡 Encoder</span>';
  const cid   = esc(church.churchId);
  const cname = esc(church.name);

  return \`<div class="card" id="card-\${cid}">
    <div class="card-header">
      <div class="status-dot \${dotCls}"></div>
      <div class="church-name" style="cursor:pointer;" onclick="openDrawer('\${cid}')">\${cname}</div>
      <span class="alert-badge \${alerts > 0 ? 'visible' : ''}">\${alerts} alert\${alerts !== 1 ? 's' : ''}</span>
      <div class="card-actions">
        <button class="card-action-btn" onclick="toggleActionMenu(event,'\${cid}')">⋮</button>
        <div class="action-menu" id="menu-\${cid}">
          <div class="action-item" onclick="openDrawer('\${cid}');hideAllMenus()">📋 Details</div>
          <div class="action-item" onclick="openCommandModal('\${cid}','\${cname}');hideAllMenus()">💬 Send Command</div>
          <div class="action-item" onclick="openBroadcastModal('\${cid}','\${cname}');hideAllMenus()">📢 Broadcast</div>
          <div class="action-item danger" onclick="confirmDeleteChurch('\${cid}','\${cname}');hideAllMenus()">🗑️ Delete</div>
        </div>
      </div>
    </div>
    \${resellerTag}
    <div class="card-rows">
      <div class="row"><span class="row-label">Connection</span><span class="row-value">\${tag(church.connected,'Online','Offline')}</span></div>
      <div class="row"><span class="row-label">ATEM</span><span class="row-value">\${tag(atemConnected,'Connected','Disconnected')}</span></div>
      <div class="row"><span class="row-label">OBS</span><span class="row-value">\${tag(obsConnected,'Connected','Disconnected')}</span></div>
      <div class="row"><span class="row-label">Stream</span><span class="row-value">\${tag(obsStreaming,'🔴 Live','Off-air','Unknown')}</span></div>
      <div class="row"><span class="row-label">Encoder</span><span class="row-value">\${encoderBadge} \${syncBadge(church.syncStatus)}</span></div>
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
  const merged = _churchStates[church.churchId];
  // Try incremental patch first — falls back to full render for new cards
  if (patchCard(merged)) return;
  // New card — full render & insert
  const grid = document.getElementById('grid');
  if (grid.querySelector('.empty')) grid.innerHTML = '';
  grid.insertAdjacentHTML('beforeend', renderCard(merged));
}

// ── Action menu ───────────────────────────────────────────────────────────────

function toggleActionMenu(e, churchId) {
  e.stopPropagation();
  const menu = document.getElementById('menu-' + churchId);
  if (!menu) return;
  const isOpen = menu.classList.contains('open');
  hideAllMenus();
  if (!isOpen) menu.classList.add('open');
}
function hideAllMenus() {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}
document.addEventListener('click', hideAllMenus);

// ── Command / Broadcast / Delete ──────────────────────────────────────────────

function openCommandModal(churchId, churchName) {
  document.getElementById('cmd_churchName').textContent = churchName;
  document.getElementById('cmd_text').value = '';
  document.getElementById('cmd_error').style.display = 'none';
  document.getElementById('cmd_success').style.display = 'none';
  const btn = document.getElementById('cmd_submit'); btn.disabled = false; btn.textContent = 'Send';
  document.getElementById('commandModal').dataset.churchId = churchId;
  openModal('commandModal');
  setTimeout(() => document.getElementById('cmd_text').focus(), 100);
}
async function submitCommand() {
  const churchId = document.getElementById('commandModal').dataset.churchId;
  const command  = document.getElementById('cmd_text').value.trim();
  const errEl = document.getElementById('cmd_error'), okEl = document.getElementById('cmd_success');
  if (!command) { errEl.textContent = 'Command is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none'; okEl.style.display = 'none';
  const btn = document.getElementById('cmd_submit'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const resp = await adminFetch('/api/command', { method: 'POST', body: JSON.stringify({ churchId, command }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    okEl.textContent = '✅ Command sent.'; okEl.style.display = 'block';
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = 'Send'; }
}

function openBroadcastModal(churchId, churchName) {
  document.getElementById('bc_churchName').textContent = churchName;
  document.getElementById('bc_text').value = '';
  document.getElementById('bc_error').style.display = 'none';
  document.getElementById('bc_success').style.display = 'none';
  const btn = document.getElementById('bc_submit'); btn.disabled = false; btn.textContent = 'Broadcast';
  document.getElementById('broadcastModal').dataset.churchId = churchId;
  openModal('broadcastModal');
  setTimeout(() => document.getElementById('bc_text').focus(), 100);
}
async function submitBroadcast() {
  const churchId = document.getElementById('broadcastModal').dataset.churchId;
  const message  = document.getElementById('bc_text').value.trim();
  const errEl = document.getElementById('bc_error'), okEl = document.getElementById('bc_success');
  if (!message) { errEl.textContent = 'Message is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none'; okEl.style.display = 'none';
  const btn = document.getElementById('bc_submit'); btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const resp = await adminFetch('/api/broadcast', { method: 'POST', body: JSON.stringify({ churchId, message }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    okEl.textContent = '✅ Broadcast sent.'; okEl.style.display = 'block';
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  finally { btn.disabled = false; btn.textContent = 'Broadcast'; }
}

async function confirmDeleteChurch(churchId, churchName) {
  if (!confirm(\`Delete "\${churchName}"? This cannot be undone.\`)) return;
  try {
    const resp = await adminFetch('/api/churches/' + churchId, { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Delete failed'); }
    const card = document.getElementById('card-' + churchId);
    if (card) card.remove();
    delete _churchStates[churchId];
    if (!Object.keys(_churchStates).length) document.getElementById('grid').innerHTML = '<div class="empty">No churches registered yet.</div>';
  } catch(e) { alert('Error: ' + e.message); }
}

// ── SSE ───────────────────────────────────────────────────────────────────────

function connect() {
  const url = '/api/dashboard/stream';
  es = new EventSource(url);
  es.onopen = () => { document.getElementById('sseDot').classList.add('connected'); document.getElementById('sseStatus').textContent = 'Live'; };
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      document.getElementById('lastUpdate').textContent = 'Updated ' + new Date().toLocaleTimeString();
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
        upsertCard({ ...data, connected: false, status: { connected: false, atem: null, obs: null } });
      } else if (data.type === 'status_update') {
        const ex = _churchStates[data.churchId] || {};
        upsertCard({ ...ex, churchId: data.churchId, name: data.name || ex.name, status: data.status || ex.status, lastSeen: data.timestamp || ex.lastSeen });
      } else if (data.type === 'alert') {
        const ex = _churchStates[data.churchId] || {};
        upsertCard({ ...ex, churchId: data.churchId, activeAlerts: (ex.activeAlerts || 0) + 1 });
      } else if (data.type === 'sync_update') {
        const ex = _churchStates[data.churchId] || {};
        if (data.syncStatus) upsertCard({ ...ex, churchId: data.churchId, syncStatus: data.syncStatus });
      }
    } catch {}
  };
  es.onerror = () => {
    document.getElementById('sseDot').classList.remove('connected');
    document.getElementById('sseStatus').textContent = 'Reconnecting…';
    es.close(); setTimeout(connect, 3000);
  };
}
connect();
loadResellers();

// Refresh "last seen" timestamps every 10s so they stay current
setInterval(() => {
  document.querySelectorAll('.card').forEach(card => {
    const id = card.id.replace('card-', '');
    const ch = _churchStates[id];
    if (!ch) return;
    const ls = card.querySelector('.last-seen');
    if (ls) ls.textContent = 'Last seen: ' + fmtLastSeen(ch.lastSeen);
  });
}, 10000);

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
    const res = await adminFetch('/api/chat', {
      method: 'POST',
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
  const label  = document.createElement('div'); label.className  = 'ai-label';  label.textContent  = role === 'user' ? 'You' : 'Tally AI';
  wrapper.appendChild(bubble); wrapper.appendChild(label);
  msgs.appendChild(wrapper); msgs.scrollTop = msgs.scrollHeight;
}
document.getElementById('aiInput').addEventListener('input', function() {
  this.style.height = 'auto'; this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});
document.getElementById('aiInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiMessage(); }
});

// ── Events tab ────────────────────────────────────────────────────────────────

async function loadEvents() {
  const el = document.getElementById('eventsContent');
  el.innerHTML = '<div class="section-loading">Loading…</div>';
  try {
    const resp = await adminFetch('/api/events');
    if (!resp.ok) throw new Error('Failed to load events');
    const data = await resp.json();
    const events = Array.isArray(data) ? data : (data.events || []);
    if (!events.length) { el.innerHTML = '<div class="section-empty">No events yet. Create one to put a church into event mode.</div>'; return; }
    el.innerHTML = \`<div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Church</th><th>Event Name</th><th>Type</th><th>Expires</th><th>Created</th></tr></thead>
      <tbody>\${events.map(ev => \`<tr>
        <td>\${esc(ev.churchId || ev.church_id || '–')}</td>
        <td style="font-weight:500;">\${esc(ev.name || '–')}</td>
        <td><span class="tag tag-na">\${esc(ev.church_type || 'event')}</span></td>
        <td style="color:var(--muted);font-size:0.78rem;">\${ev.event_expires_at ? new Date(ev.event_expires_at).toLocaleString() : '–'}</td>
        <td style="color:var(--muted);font-size:0.78rem;">\${ev.created_at ? new Date(ev.created_at).toLocaleString() : '–'}</td>
      </tr>\`).join('')}</tbody>
    </table></div>\`;
  } catch(e) { el.innerHTML = \`<div class="section-empty" style="color:var(--red);">\${esc(e.message)}</div>\`; }
}

function openCreateEventModal() {
  populateChurchSelect('ce_church');
  document.getElementById('ce_name').value = '';
  document.getElementById('ce_duration').value = '4';
  document.getElementById('ce_error').style.display = 'none';
  const btn = document.getElementById('ce_submit'); btn.disabled = false; btn.textContent = 'Create';
  openModal('createEventModal');
  setTimeout(() => document.getElementById('ce_name').focus(), 100);
}
async function submitCreateEvent() {
  const churchId      = document.getElementById('ce_church').value;
  const name          = document.getElementById('ce_name').value.trim();
  const durationHours = parseInt(document.getElementById('ce_duration').value) || 4;
  const errEl = document.getElementById('ce_error');
  if (!churchId) { errEl.textContent = 'Select a church.'; errEl.style.display = 'block'; return; }
  if (!name)     { errEl.textContent = 'Event name is required.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  const btn = document.getElementById('ce_submit'); btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const resp = await adminFetch('/api/events/create', { method: 'POST', body: JSON.stringify({ churchId, name, durationHours }) });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    closeModal('createEventModal');
    loadEvents();
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Create'; }
}

// ── Billing tab ───────────────────────────────────────────────────────────────

async function loadBilling() {
  const el = document.getElementById('billingContent');
  el.innerHTML = '<div class="section-loading">Loading…</div>';
  try {
    const resp = await adminFetch('/api/billing');
    if (!resp.ok) throw new Error('Failed to load billing');
    const data = await resp.json();
    const items = Array.isArray(data) ? data : (data.churches || data.items || []);
    if (!items.length) { el.innerHTML = '<div class="section-empty">No billing records. Connect Stripe to enable billing.</div>'; return; }
    el.innerHTML = \`<div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Church</th><th>Plan</th><th>Status</th><th>Renewal</th><th></th></tr></thead>
      <tbody>\${items.map(b => \`<tr>
        <td>\${esc(b.name || b.churchId || b.church_id || '–')}</td>
        <td><span class="tag tag-na">\${esc(b.plan || b.price_id || 'N/A')}</span></td>
        <td><span class="tag \${b.status === 'active' ? 'tag-on' : 'tag-off'}">\${esc(b.status || 'unknown')}</span></td>
        <td style="color:var(--muted);font-size:0.78rem;">\${b.current_period_end ? new Date(b.current_period_end * 1000).toLocaleDateString() : '–'}</td>
        <td><button class="btn btn-secondary" style="font-size:0.72rem;padding:4px 10px;" onclick="viewBillingStatus('\${esc(b.churchId || b.church_id || '')}')">View</button></td>
      </tr>\`).join('')}</tbody>
    </table></div>\`;
  } catch(e) { el.innerHTML = \`<div class="section-empty" style="color:var(--red);">\${esc(e.message)}</div>\`; }
}

async function viewBillingStatus(churchId) {
  if (!churchId) return;
  document.getElementById('billingStatusContent').innerHTML = 'Loading…';
  openModal('billingStatusModal');
  try {
    const resp = await adminFetch('/api/billing/status/' + churchId);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    document.getElementById('billingStatusContent').innerHTML =
      '<pre style="font-size:0.78rem;color:var(--muted);white-space:pre-wrap;word-break:break-all;">' + esc(JSON.stringify(data, null, 2)) + '</pre>';
  } catch(e) { document.getElementById('billingStatusContent').innerHTML = '<span style="color:var(--red);">' + esc(e.message) + '</span>'; }
}

// ── Digest tab ────────────────────────────────────────────────────────────────

async function loadDigest() {
  const el = document.getElementById('digestContent');
  el.innerHTML = '<div class="section-loading">Loading…</div>';
  try {
    const resp = await adminFetch('/api/digest/latest');
    if (!resp.ok) throw new Error('Failed to load digest');
    const data = await resp.json();
    renderDigestContent(data);
  } catch(e) { el.innerHTML = \`<div class="section-empty" style="color:var(--red);">\${esc(e.message)}</div>\`; }
}
function renderDigestContent(data) {
  const el = document.getElementById('digestContent');
  if (!data || (!data.summary && !data.content && !data.text)) {
    el.innerHTML = '<div class="section-empty">No digest yet. Click Generate Now to create one.</div>'; return;
  }
  const ts      = data.generatedAt || data.created_at || data.timestamp;
  const content = data.summary || data.content || data.text || JSON.stringify(data, null, 2);
  el.innerHTML = \`
    <div class="digest-meta">Generated: \${ts ? new Date(ts).toLocaleString() : 'Unknown'}</div>
    <div class="digest-card">
      <pre style="white-space:pre-wrap;font-size:0.82rem;color:var(--muted);font-family:inherit;line-height:1.7;">\${esc(typeof content === 'string' ? content : JSON.stringify(content, null, 2))}</pre>
    </div>\`;
}
async function generateDigest() {
  const btn = document.getElementById('generateDigestBtn');
  const el  = document.getElementById('digestContent');
  btn.disabled = true; btn.textContent = '⚡ Generating…';
  el.innerHTML = '<div class="section-loading">Generating digest, this may take a moment…</div>';
  try {
    const resp = await adminFetch('/api/digest/generate');
    if (!resp.ok) throw new Error('Generation failed');
    renderDigestContent(await resp.json());
  } catch(e) { el.innerHTML = \`<div class="section-empty" style="color:var(--red);">\${esc(e.message)}</div>\`; }
  finally { btn.disabled = false; btn.textContent = '⚡ Generate Now'; }
}

// ── Guest TDs tab ─────────────────────────────────────────────────────────────

async function loadGuests() {
  const el = document.getElementById('guestsContent');
  el.innerHTML = '<div class="section-loading">Loading…</div>';
  try {
    const resp = await adminFetch('/api/guest-tokens');
    if (!resp.ok) throw new Error('Failed to load guest tokens');
    const data   = await resp.json();
    const tokens = Array.isArray(data) ? data : (data.tokens || []);
    if (!tokens.length) { el.innerHTML = '<div class="section-empty">No guest tokens. Issue one to give temporary access to a guest TD.</div>'; return; }
    el.innerHTML = \`<div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Church</th><th>Token</th><th>Issued</th><th>Expires</th><th></th></tr></thead>
      <tbody>\${tokens.map(t => \`<tr>
        <td>\${esc(t.churchName || t.church_id || t.churchId || '–')}</td>
        <td style="font-family:monospace;font-size:0.75rem;color:var(--muted);">\${esc((t.token || t.id || '').slice(0,16))}…</td>
        <td style="color:var(--muted);font-size:0.78rem;">\${t.created_at ? new Date(t.created_at).toLocaleDateString() : '–'}</td>
        <td style="color:var(--muted);font-size:0.78rem;">\${t.expires_at ? new Date(t.expires_at).toLocaleString() : '–'}</td>
        <td><button class="btn btn-danger" style="font-size:0.72rem;padding:4px 10px;" onclick="revokeGuestToken('\${esc(t.token || t.id || '')}',this)">Revoke</button></td>
      </tr>\`).join('')}</tbody>
    </table></div>\`;
  } catch(e) { el.innerHTML = \`<div class="section-empty" style="color:var(--red);">\${esc(e.message)}</div>\`; }
}
async function revokeGuestToken(token, btn) {
  if (!token || !confirm('Revoke this guest token?')) return;
  btn.disabled = true; btn.textContent = '…';
  try {
    const resp = await adminFetch('/api/guest-token/' + encodeURIComponent(token), { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    loadGuests();
  } catch(e) { alert('Error: ' + e.message); btn.disabled = false; btn.textContent = 'Revoke'; }
}
function openIssueGuestModal() {
  populateChurchSelect('gt_church');
  document.getElementById('gt_error').style.display = 'none';
  document.getElementById('gt_success').style.display = 'none';
  const btn = document.getElementById('gt_submit'); btn.disabled = false; btn.textContent = 'Issue'; btn.style.display = 'inline-block';
  openModal('guestTokenModal');
}
async function submitIssueGuest() {
  const churchId = document.getElementById('gt_church').value;
  const errEl = document.getElementById('gt_error');
  if (!churchId) { errEl.textContent = 'Select a church.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  const btn = document.getElementById('gt_submit'); btn.disabled = true; btn.textContent = 'Issuing…';
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/guest-token', { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    document.getElementById('gt_token').textContent = data.token || data.guestToken || JSON.stringify(data);
    document.getElementById('gt_success').style.display = 'block';
    btn.style.display = 'none';
    loadGuests();
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Issue'; }
}

// ── Church detail drawer ──────────────────────────────────────────────────────

function openDrawer(churchId) {
  _drawerChurchId = churchId;
  const church = _churchStates[churchId] || {};
  document.getElementById('drawerTitle').textContent    = church.name || churchId;
  document.getElementById('drawerSubtitle').textContent = church.connected ? '🟢 Online' : '⚫ Offline';
  document.getElementById('churchDrawer').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.querySelectorAll('.drawer-tab').forEach(b => b.classList.toggle('active', b.dataset.dtab === 'overview'));
  loadDrawerTab('overview');
}
function closeDrawer() {
  document.getElementById('churchDrawer').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  _drawerChurchId = null;
}
function switchDrawerTab(tab) {
  document.querySelectorAll('.drawer-tab').forEach(b => b.classList.toggle('active', b.dataset.dtab === tab));
  loadDrawerTab(tab);
}

async function loadDrawerTab(tab) {
  const body = document.getElementById('drawerBody');
  const id   = _drawerChurchId;
  if (!id) return;

  if (tab === 'overview') {
    const church = _churchStates[id] || {};
    const s = church.status || {};
    body.innerHTML = \`
      <div class="drawer-section-title">Connection</div>
      <div class="drawer-item"><span class="drawer-item-label">Status</span><span class="drawer-item-value">\${church.connected ? '<span class="tag tag-on">Online</span>' : '<span class="tag tag-off">Offline</span>'}</span></div>
      <div class="drawer-item"><span class="drawer-item-label">Last Seen</span><span class="drawer-item-value" style="color:var(--muted);">\${fmtLastSeen(church.lastSeen)}</span></div>
      <div class="drawer-section-title">Equipment</div>
      <div class="drawer-item"><span class="drawer-item-label">ATEM</span><span class="drawer-item-value">\${tag(s.atem && s.atem.connected,'Connected','Disconnected')}\${s.atem && s.atem.programInput != null ? ' <small style="color:var(--muted);">Cam '+s.atem.programInput+'</small>' : ''}</span></div>
      <div class="drawer-item"><span class="drawer-item-label">OBS</span><span class="drawer-item-value">\${!s.obs ? '–' : s.obs.streaming ? '<span class="tag tag-on">🔴 Streaming</span>' : s.obs.connected ? '<span class="tag tag-na">Idle</span>' : '<span class="tag tag-off">Offline</span>'}</span></div>
      <div class="drawer-item"><span class="drawer-item-label">Companion</span><span class="drawer-item-value">\${tag(s.companion && s.companion.connected,'Online','Offline')}</span></div>
      <div class="drawer-item"><span class="drawer-item-label">ProPresenter</span><span class="drawer-item-value">\${tag(s.proPresenter && s.proPresenter.connected,'Online','Offline')}</span></div>
      <div class="drawer-item"><span class="drawer-item-label">A/V Sync</span><span class="drawer-item-value">\${syncBadge(church.syncStatus)}</span></div>
      \${church.activeAlerts ? '<div class="drawer-item"><span class="drawer-item-label">Active Alerts</span><span class="drawer-item-value" style="color:var(--red);">'+church.activeAlerts+'</span></div>' : ''}
      <div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-secondary" style="font-size:0.78rem;" onclick="openCommandModal('\${esc(id)}','\${esc(church.name||id)}');closeDrawer()">💬 Command</button>
        <button class="btn btn-secondary" style="font-size:0.78rem;" onclick="openBroadcastModal('\${esc(id)}','\${esc(church.name||id)}');closeDrawer()">📢 Broadcast</button>
      </div>\`;
    return;
  }

  body.innerHTML = '<div class="section-loading">Loading…</div>';
  try {
    if (tab === 'tds') {
      const data = await adminFetch('/api/churches/' + id + '/tds').then(r => r.json());
      const tds  = Array.isArray(data) ? data : (data.tds || []);
      if (!tds.length) { body.innerHTML = '<div class="drawer-empty">No TDs registered.</div>'; return; }
      body.innerHTML = \`<table class="data-table">
        <thead><tr><th>Name</th><th>User ID</th><th></th></tr></thead>
        <tbody>\${tds.map(td => \`<tr>
          <td>\${esc(td.name || td.username || '–')}</td>
          <td style="color:var(--muted);font-size:0.78rem;">\${esc(td.userId || td.user_id || '–')}</td>
          <td><button class="btn btn-danger" style="font-size:0.72rem;padding:3px 8px;" onclick="removeTd('\${esc(id)}','\${esc(td.userId||td.user_id||'')}',this)">Remove</button></td>
        </tr>\`).join('')}</tbody>
      </table>\`;

    } else if (tab === 'schedule') {
      const data = await adminFetch('/api/churches/' + id + '/schedule').then(r => r.json());
      body.innerHTML = \`
        <div class="drawer-section-title">Service Schedule (JSON)</div>
        <textarea id="scheduleEditor" style="width:100%;min-height:220px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.78rem;padding:10px;font-family:monospace;resize:vertical;">\${esc(JSON.stringify(data, null, 2))}</textarea>
        <div style="margin-top:10px;display:flex;gap:8px;">
          <button class="btn btn-primary" style="font-size:0.78rem;" onclick="saveSchedule('\${esc(id)}')">Save Schedule</button>
        </div>
        <div id="scheduleMsg" style="margin-top:8px;font-size:0.78rem;display:none;"></div>\`;

    } else if (tab === 'sessions') {
      const [sessData, currData] = await Promise.all([
        adminFetch('/api/churches/' + id + '/sessions').then(r => r.json()),
        adminFetch('/api/churches/' + id + '/sessions/current').then(r => r.json()),
      ]);
      const sessions = Array.isArray(sessData) ? sessData : (sessData.sessions || []);
      let html = '';
      if (currData && currData.sessionId) {
        html += \`<div class="drawer-section-title">Current Session</div>
          <div class="drawer-item"><span class="drawer-item-label">Session ID</span><span class="drawer-item-value" style="font-family:monospace;font-size:0.72rem;">\${esc(currData.sessionId)}</span></div>
          <div class="drawer-item"><span class="drawer-item-label">Started</span><span class="drawer-item-value" style="color:var(--muted);">\${currData.startedAt ? new Date(currData.startedAt).toLocaleString() : '–'}</span></div>\`;
      }
      html += '<div class="drawer-section-title">Past Sessions</div>';
      html += !sessions.length ? '<div class="drawer-empty">No past sessions.</div>'
        : sessions.slice(0,20).map(s => \`<div class="drawer-item">
            <span class="drawer-item-label" style="font-family:monospace;font-size:0.72rem;">\${esc(s.sessionId || '–')}</span>
            <span class="drawer-item-value" style="color:var(--muted);font-size:0.75rem;">\${s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '–'}</span>
          </div>\`).join('');
      body.innerHTML = html;

    } else if (tab === 'presets') {
      const data    = await adminFetch('/api/churches/' + id + '/presets').then(r => r.json());
      const presets = Array.isArray(data) ? data : (data.presets || []);
      if (!presets.length) { body.innerHTML = '<div class="drawer-empty">No presets saved.</div>'; return; }
      body.innerHTML = \`<table class="data-table">
        <thead><tr><th>Name</th><th>Created</th><th></th></tr></thead>
        <tbody>\${presets.map(p => \`<tr>
          <td>\${esc(p.name || '–')}</td>
          <td style="color:var(--muted);font-size:0.78rem;">\${p.created_at ? new Date(p.created_at).toLocaleDateString() : '–'}</td>
          <td style="display:flex;gap:6px;">
            <button class="btn btn-primary" style="font-size:0.72rem;padding:3px 8px;" onclick="recallPreset('\${esc(id)}','\${esc(p.name)}',this)">Recall</button>
            <button class="btn btn-danger"  style="font-size:0.72rem;padding:3px 8px;" onclick="deletePreset('\${esc(id)}','\${esc(p.name)}',this)">Del</button>
          </td>
        </tr>\`).join('')}</tbody>
      </table>\`;

    } else if (tab === 'maintenance') {
      const data    = await adminFetch('/api/churches/' + id + '/maintenance').then(r => r.json());
      const windows = Array.isArray(data) ? data : (data.windows || data.maintenance || []);
      body.innerHTML = \`
        <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
          <button class="btn btn-primary" style="font-size:0.78rem;" onclick="showMaintenanceForm('\${esc(id)}')">+ Add Window</button>
        </div>
        \${!windows.length ? '<div class="drawer-empty">No maintenance windows scheduled.</div>'
          : windows.map(w => \`<div class="drawer-item">
              <div>
                <div style="font-size:0.82rem;font-weight:600;">\${esc(w.title || 'Maintenance')}</div>
                <div style="font-size:0.75rem;color:var(--muted);">\${w.starts_at ? new Date(w.starts_at).toLocaleString() : '?'} → \${w.ends_at ? new Date(w.ends_at).toLocaleString() : '?'}</div>
              </div>
              <button class="btn btn-danger" style="font-size:0.72rem;padding:3px 8px;" onclick="deleteMaintenance('\${esc(w.id)}',this)">Del</button>
            </div>\`).join('')}
        <div id="maintenanceForm" style="display:none;margin-top:16px;padding-top:16px;border-top:1px solid var(--border);">
          <div class="form-group"><label>Title</label><input type="text" id="mw_title" placeholder="Cable replacement"></div>
          <div class="form-group"><label>Start (ISO 8601)</label><input type="text" id="mw_start" placeholder="2026-03-01T08:00:00Z"></div>
          <div class="form-group"><label>End (ISO 8601)</label><input type="text" id="mw_end" placeholder="2026-03-01T10:00:00Z"></div>
          <div id="mw_error" style="color:var(--red);font-size:0.78rem;display:none;margin-bottom:8px;"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-primary" style="font-size:0.78rem;" onclick="submitMaintenance('\${esc(id)}')">Save</button>
            <button class="btn btn-secondary" style="font-size:0.78rem;" onclick="document.getElementById('maintenanceForm').style.display='none'">Cancel</button>
          </div>
        </div>\`;
    }
  } catch(e) { body.innerHTML = \`<div class="drawer-empty" style="color:var(--red);">Error: \${esc(e.message)}</div>\`; }
}

// ── Drawer sub-actions ────────────────────────────────────────────────────────

async function removeTd(churchId, userId, btn) {
  if (!userId || !confirm('Remove this TD?')) return;
  btn.disabled = true;
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/tds/' + encodeURIComponent(userId), { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    loadDrawerTab('tds');
  } catch(e) { alert('Error: ' + e.message); btn.disabled = false; }
}

async function saveSchedule(churchId) {
  const raw = document.getElementById('scheduleEditor').value;
  const msgEl = document.getElementById('scheduleMsg');
  let schedule;
  try { schedule = JSON.parse(raw); } catch { msgEl.textContent = '⚠️ Invalid JSON.'; msgEl.style.color = 'var(--red)'; msgEl.style.display = 'block'; return; }
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/schedule', { method: 'PUT', body: JSON.stringify({ schedule }) });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    msgEl.textContent = '✅ Schedule saved.'; msgEl.style.color = 'var(--green)'; msgEl.style.display = 'block';
  } catch(e) { msgEl.textContent = '❌ ' + e.message; msgEl.style.color = 'var(--red)'; msgEl.style.display = 'block'; }
}

async function recallPreset(churchId, name, btn) {
  btn.disabled = true; btn.textContent = '…';
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/presets/' + encodeURIComponent(name) + '/recall', { method: 'POST' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    btn.textContent = '✅'; setTimeout(() => { btn.textContent = 'Recall'; btn.disabled = false; }, 1500);
  } catch(e) { alert('Recall failed: ' + e.message); btn.textContent = 'Recall'; btn.disabled = false; }
}

async function deletePreset(churchId, name, btn) {
  if (!confirm(\`Delete preset "\${name}"?\`)) return;
  btn.disabled = true;
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/presets/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    loadDrawerTab('presets');
  } catch(e) { alert('Error: ' + e.message); btn.disabled = false; }
}

function showMaintenanceForm(churchId) {
  document.getElementById('mw_title').value = '';
  document.getElementById('mw_start').value = '';
  document.getElementById('mw_end').value = '';
  document.getElementById('mw_error').style.display = 'none';
  document.getElementById('maintenanceForm').style.display = 'block';
}

async function submitMaintenance(churchId) {
  const title    = document.getElementById('mw_title').value.trim();
  const startsAt = document.getElementById('mw_start').value.trim();
  const endsAt   = document.getElementById('mw_end').value.trim();
  const errEl    = document.getElementById('mw_error');
  if (!title || !startsAt || !endsAt) { errEl.textContent = 'All fields required.'; errEl.style.display = 'block'; return; }
  try {
    const resp = await adminFetch('/api/churches/' + churchId + '/maintenance', { method: 'POST', body: JSON.stringify({ title, startsAt, endsAt }) });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    loadDrawerTab('maintenance');
  } catch(e) { errEl.textContent = e.message; errEl.style.display = 'block'; }
}

async function deleteMaintenance(windowId, btn) {
  if (!windowId || !confirm('Delete this maintenance window?')) return;
  btn.disabled = true;
  try {
    const resp = await adminFetch('/api/maintenance/' + encodeURIComponent(windowId), { method: 'DELETE' });
    if (!resp.ok) { const d = await resp.json(); throw new Error(d.error || 'Failed'); }
    loadDrawerTab('maintenance');
  } catch(e) { alert('Error: ' + e.message); btn.disabled = false; }
}
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
    <div class="form-group">
      <label>Portal Login Email (optional)</label>
      <input type="email" id="ac_portal_email" placeholder="admin@gracecommunity.org">
    </div>
    <div class="form-group">
      <label>Portal Password (optional)</label>
      <input type="password" id="ac_portal_password" placeholder="At least 8 characters">
    </div>
    <div style="font-size:0.75rem;color:var(--muted);margin-top:-2px;">Set both portal fields to create app login credentials now.</div>
    <div id="ac_error" style="color:var(--red);font-size:0.82rem;display:none;margin-top:8px;"></div>
    <div class="success-box" id="ac_success">
      <div style="font-weight:600;color:var(--accent);margin-bottom:6px;">✅ Church registered!</div>
      <div style="font-size:0.82rem;color:var(--muted);margin-bottom:8px;">Share this code with your TD. They register with: <code>/register CODE</code></div>
      <div class="code-copy" id="ac_code" onclick="copyText(this.textContent)"></div>
      <div id="ac_portal_notice" style="display:none;font-size:0.78rem;color:var(--green);margin-top:8px;"></div>
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
  const merged = _churchStates[church.churchId];
  // Try incremental patch first — falls back to full render for new cards
  if (patchCard(merged)) return;
  // New card — full render & insert
  const grid = document.getElementById('grid');
  const empty = grid.querySelector('.empty');
  if (empty) grid.innerHTML = '';
  grid.insertAdjacentHTML('beforeend', renderCard(merged));
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
        upsertCard({ ...data, connected: false, status: { connected: false, atem: null, obs: null } });
        loadStats();
      } else if (data.type === 'status_update') {
        const existing = _churchStates[data.churchId] || {};
        upsertCard({ ...existing, churchId: data.churchId, name: data.name || existing.name, status: data.status || existing.status, lastSeen: data.timestamp || existing.lastSeen });
      } else if (data.type === 'sync_update') {
        const existing = _churchStates[data.churchId] || {};
        if (data.syncStatus) upsertCard({ ...existing, churchId: data.churchId, syncStatus: data.syncStatus });
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
  document.getElementById('ac_portal_email').value = '';
  document.getElementById('ac_portal_password').value = '';
  document.getElementById('ac_portal_notice').style.display = 'none';
  setTimeout(() => document.getElementById('ac_name').focus(), 100);
}
function closeAddChurchModal() {
  document.getElementById('addChurchModal').classList.remove('open');
  loadStats();
}

async function submitAddChurch() {
  const name  = document.getElementById('ac_name').value.trim();
  const email = document.getElementById('ac_email').value.trim();
  const portalEmail = document.getElementById('ac_portal_email').value.trim().toLowerCase();
  const portalPassword = document.getElementById('ac_portal_password').value;
  const portalNotice = document.getElementById('ac_portal_notice');
  const errEl = document.getElementById('ac_error');
  if (!name) { errEl.textContent = 'Church name is required.'; errEl.style.display = 'block'; return; }
  if (portalPassword && !portalEmail) { errEl.textContent = 'Portal login email is required when a password is provided.'; errEl.style.display = 'block'; return; }
  if (portalEmail && !portalPassword) { errEl.textContent = 'Portal password is required when a portal login email is provided.'; errEl.style.display = 'block'; return; }
  if (portalPassword && portalPassword.length < 8) { errEl.textContent = 'Portal password must be at least 8 characters.'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  portalNotice.style.display = 'none';

  const btn = document.getElementById('ac_submit');
  btn.disabled = true; btn.textContent = 'Registering…';

  try {
    const resp = await fetch('/api/reseller/churches/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-reseller-key': RESELLER_KEY },
      body: JSON.stringify({ churchName: name, contactEmail: email, portalEmail, password: portalPassword }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Registration failed');
    document.getElementById('ac_code').textContent = data.registrationCode;
    document.getElementById('ac_success').classList.add('visible');
    if (data.appLoginCreated && data.portalEmail) {
      portalNotice.textContent = 'Portal login created for ' + data.portalEmail;
      portalNotice.style.display = 'block';
    } else {
      portalNotice.style.display = 'none';
    }
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

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not configured.' });

    const systemPrompt = 'You are Tally AI, admin assistant for a multi-church AV monitoring system. Church states: ' + JSON.stringify(churchStates || {});

    try {
      console.log('[Dashboard Chat] Processing with gpt-4o-mini...');
      const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          temperature: 0.7,
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        throw new Error(`OpenAI ${aiRes.status}: ${errBody.slice(0, 100)}`);
      }

      const data = await aiRes.json();
      const reply = data?.choices?.[0]?.message?.content || 'No response.';
      console.log('[Dashboard Chat] ✓ Success');
      res.json({ reply });

    } catch (err) {
      console.error(`[Dashboard Chat] Error: ${err.message}`);
      res.status(503).json({ error: `AI unavailable: ${err.message}` });
    }
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
