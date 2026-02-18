/**
 * Multi-Church Dashboard
 *
 * Serves a dark-theme HTML dashboard at GET /dashboard?key=ADMIN_KEY
 * SSE endpoint at GET /api/dashboard/stream?key=ADMIN_KEY
 *
 * setupDashboard(app, db, getChurchStates) → { notifyUpdate }
 *   - getChurchStates() returns { [churchId]: { name, connected, status, lastSeen, activeAlerts } }
 *   - notifyUpdate() should be called from server.js whenever church state changes
 */

const ADMIN_KEY = () => process.env.ADMIN_API_KEY || 'dev-admin-key-change-me';

function buildDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tally — Church Dashboard</title>
<style>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
    flex-wrap: wrap;
    gap: 12px;
  }
  .logo { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.5px; }
  .logo span { color: var(--blue); }
  .status-bar {
    font-size: 0.8rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sse-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--red);
    transition: background 0.3s;
  }
  .sse-dot.connected { background: var(--green); }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--gap);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    transition: border-color 0.25s;
  }
  .card:hover { border-color: var(--blue); }
  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .status-dot {
    width: 12px; height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background 0.3s;
  }
  .dot-green  { background: var(--green);  box-shadow: 0 0 6px var(--green); }
  .dot-yellow { background: var(--yellow); box-shadow: 0 0 6px var(--yellow); }
  .dot-red    { background: var(--red);    box-shadow: 0 0 6px var(--red); }
  .dot-gray   { background: var(--muted); }
  .church-name {
    font-size: 1rem;
    font-weight: 600;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .alert-badge {
    background: var(--red);
    color: white;
    font-size: 0.7rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 99px;
    display: none;
  }
  .alert-badge.visible { display: inline-block; }
  .card-rows { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.82rem;
  }
  .row-label { color: var(--muted); }
  .row-value { font-weight: 500; }
  .tag {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
  }
  .tag-on  { background: rgba(34,197,94,0.15);  color: var(--green); }
  .tag-off { background: rgba(239,68,68,0.15);  color: var(--red); }
  .tag-na  { background: rgba(107,114,128,0.15); color: var(--muted); }
  .last-seen { font-size: 0.75rem; color: var(--muted); margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
  .empty { text-align: center; color: var(--muted); padding: 48px; grid-column: 1/-1; }
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
  </div>
</header>
<div class="grid" id="grid">
  <div class="empty">Loading churches…</div>
</div>

<script>
const KEY = new URLSearchParams(location.search).get('key') || '';
let es = null;

function statusDotClass(church) {
  if (!church.connected) return 'dot-gray';
  if ((church.activeAlerts || 0) > 0) return 'dot-red';
  const s = church.status || {};
  const obsOk = s.obs ? s.obs.connected : true;
  const atemOk = s.atem ? s.atem.connected : true;
  if (!obsOk || !atemOk) return 'dot-yellow';
  return 'dot-green';
}

function statusEmoji(church) {
  const cls = statusDotClass(church);
  return cls === 'dot-green' ? '🟢' : cls === 'dot-yellow' ? '🟡' : cls === 'dot-red' ? '🔴' : '⚫';
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
  if (diff < 60)  return Math.round(diff) + 's ago';
  if (diff < 3600) return Math.round(diff / 60) + 'm ago';
  if (diff < 86400) return Math.round(diff / 3600) + 'h ago';
  return d.toLocaleDateString();
}

function renderCard(church) {
  const dotCls = statusDotClass(church);
  const alerts = church.activeAlerts || 0;
  const s = church.status || {};
  const atemConnected = s.atem?.connected;
  const obsStreaming  = s.obs?.streaming;
  const obsConnected  = s.obs?.connected;

  return \`<div class="card" id="card-\${church.churchId}">
    <div class="card-header">
      <div class="status-dot \${dotCls}"></div>
      <div class="church-name">\${esc(church.name)}</div>
      <span class="alert-badge \${alerts > 0 ? 'visible' : ''}">\${alerts} alert\${alerts !== 1 ? 's' : ''}</span>
    </div>
    <div class="card-rows">
      <div class="row">
        <span class="row-label">Connection</span>
        <span class="row-value">\${tag(church.connected, 'Online', 'Offline')}</span>
      </div>
      <div class="row">
        <span class="row-label">ATEM</span>
        <span class="row-value">\${tag(atemConnected, 'Connected', 'Disconnected')}</span>
      </div>
      <div class="row">
        <span class="row-label">OBS</span>
        <span class="row-value">\${tag(obsConnected, 'Connected', 'Disconnected')}</span>
      </div>
      <div class="row">
        <span class="row-label">Stream</span>
        <span class="row-value">\${tag(obsStreaming, '🔴 Live', 'Off-air', 'Unknown')}</span>
      </div>
    </div>
    <div class="last-seen">Last seen: \${fmtLastSeen(church.lastSeen)}</div>
  </div>\`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderGrid(churches) {
  const grid = document.getElementById('grid');
  const ids = Object.keys(churches);
  if (ids.length === 0) {
    grid.innerHTML = '<div class="empty">No churches registered yet.</div>';
    return;
  }
  grid.innerHTML = ids.map(id => renderCard(churches[id])).join('');
}

function updateCard(church) {
  const existing = document.getElementById('card-' + church.churchId);
  const html = renderCard(church);
  if (existing) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    existing.replaceWith(tmp.firstElementChild);
  } else {
    const grid = document.getElementById('grid');
    const empty = grid.querySelector('.empty');
    if (empty) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', html);
  }
}

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
      document.getElementById('lastUpdate').textContent =
        'Updated ' + new Date().toLocaleTimeString();

      if (data.type === 'snapshot') {
        renderGrid(data.churches);
      } else if (data.type === 'update' && data.church) {
        updateCard(data.church);
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

// Refresh last-seen times every 30s
setInterval(() => {
  document.querySelectorAll('[data-lastseen]').forEach(el => {
    el.textContent = 'Last seen: ' + fmtLastSeen(el.dataset.lastseen);
  });
}, 30000);
</script>
</body>
</html>`;
}

/**
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {function} getChurchStates - () => { [churchId]: churchState }
 * @returns {{ notifyUpdate: function }}
 */
function setupDashboard(app, db, getChurchStates) {
  const sseClients = new Set(); // Set of response objects

  function checkKey(req, res) {
    const key = req.query.key || req.query.apikey;
    if (key !== ADMIN_KEY()) {
      res.status(401).send('Unauthorized — add ?key=ADMIN_KEY to the URL');
      return false;
    }
    return true;
  }

  // ── Serve dashboard HTML ──────────────────────────────────────────────────
  app.get('/dashboard', (req, res) => {
    if (!checkKey(req, res)) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildDashboardHtml());
  });

  // ── SSE stream ────────────────────────────────────────────────────────────
  app.get('/api/dashboard/stream', (req, res) => {
    if (!checkKey(req, res)) return;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    // Send initial snapshot
    try {
      const states = getChurchStates();
      res.write(`data: ${JSON.stringify({ type: 'snapshot', churches: states })}\n\n`);
    } catch (e) {
      console.error('[Dashboard] Initial snapshot error:', e.message);
    }

    sseClients.add(res);

    // Keepalive ping every 30s
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 30_000);

    req.on('close', () => {
      sseClients.delete(res);
      clearInterval(keepalive);
    });
  });

  // ── Notify function — call this from server.js on status updates ──────────
  function notifyUpdate(changedChurchId = null) {
    if (!sseClients.size) return;

    try {
      if (changedChurchId) {
        const states = getChurchStates();
        const church = states[changedChurchId];
        if (church) {
          const payload = JSON.stringify({ type: 'update', church });
          for (const res of sseClients) {
            try { res.write(`data: ${payload}\n\n`); } catch {}
          }
          return;
        }
      }

      // Full snapshot
      const states = getChurchStates();
      const payload = JSON.stringify({ type: 'snapshot', churches: states });
      for (const res of sseClients) {
        try { res.write(`data: ${payload}\n\n`); } catch {}
      }
    } catch (e) {
      console.error('[Dashboard] notifyUpdate error:', e.message);
    }
  }

  console.log('[Dashboard] Routes registered — /dashboard and /api/dashboard/stream');
  return { notifyUpdate };
}

module.exports = { setupDashboard };
