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
  .tag-encoder-on  { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .tag-encoder-off { background: rgba(107,114,128,0.15); color: var(--muted); }
  .tag-sync-ok     { background: rgba(34,197,94,0.15);   color: var(--green); }
  .tag-sync-warn   { background: rgba(245,158,11,0.15);  color: var(--yellow); }
  .tag-sync-crit   { background: rgba(239,68,68,0.15);   color: var(--red); }
  .tag-sync-na     { background: rgba(107,114,128,0.15); color: var(--muted); }
  .last-seen { font-size: 0.75rem; color: var(--muted); margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; }
  .empty { text-align: center; color: var(--muted); padding: 48px; grid-column: 1/-1; }

  /* ── AI Chat Panel ─────────────────────────────────────────── */
  .ai-toggle {
    background: rgba(59,130,246,0.14);
    border: 1px solid rgba(59,130,246,0.35);
    color: #60a5fa;
    font-size: 0.78rem;
    font-weight: 700;
    padding: 6px 14px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .ai-toggle:hover { background: rgba(59,130,246,0.24); border-color: rgba(59,130,246,0.6); }
  .ai-toggle.active { background: rgba(59,130,246,0.28); border-color: #3b82f6; color: #93c5fd; }

  .ai-panel {
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 360px;
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    transform: translateX(100%);
    transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1);
    z-index: 200;
    box-shadow: -6px 0 32px rgba(0,0,0,0.5);
  }
  .ai-panel.open { transform: translateX(0); }

  .ai-panel-header {
    padding: 18px 20px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-shrink: 0;
  }
  .ai-panel-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ai-panel-icon { color: #3b82f6; font-size: 1rem; }
  .ai-panel-subtitle { font-size: 0.72rem; color: var(--muted); margin-top: 2px; }

  .ai-close-btn {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 1.3rem;
    padding: 4px 6px;
    line-height: 1;
    border-radius: 6px;
    transition: all 0.15s;
  }
  .ai-close-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }

  .ai-messages {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    scroll-behavior: smooth;
  }
  .ai-greeting {
    background: rgba(59,130,246,0.09);
    border: 1px solid rgba(59,130,246,0.22);
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 0.82rem;
    color: #93c5fd;
    line-height: 1.55;
    margin-bottom: 4px;
  }
  .ai-msg { display: flex; flex-direction: column; gap: 3px; }
  .ai-msg.user { align-items: flex-end; }
  .ai-msg.assistant { align-items: flex-start; }

  .ai-bubble {
    padding: 10px 13px;
    font-size: 0.82rem;
    line-height: 1.55;
    max-width: 90%;
    word-break: break-word;
    border-radius: 10px;
    white-space: pre-wrap;
  }
  .ai-msg.user    .ai-bubble { background: rgba(34,197,94,0.13); border: 1px solid rgba(34,197,94,0.25); color: var(--text); border-radius: 10px 10px 3px 10px; }
  .ai-msg.assistant .ai-bubble { background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.22); color: var(--text); border-radius: 10px 10px 10px 3px; }

  .ai-label { font-size: 0.7rem; color: var(--muted); padding: 0 3px; }

  .ai-thinking {
    padding: 0 16px 8px;
    font-size: 0.78rem;
    color: var(--muted);
    font-style: italic;
    display: none;
    flex-shrink: 0;
  }
  .ai-thinking.visible { display: block; }

  .ai-input-row {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-shrink: 0;
  }
  .ai-input {
    flex: 1;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 0.82rem;
    padding: 9px 12px;
    resize: none;
    font-family: inherit;
    line-height: 1.4;
    transition: border-color 0.15s;
    min-height: 38px;
    max-height: 100px;
    overflow-y: auto;
  }
  .ai-input:focus { outline: none; border-color: #3b82f6; }
  .ai-input::placeholder { color: var(--muted); }
  .ai-send {
    background: #3b82f6;
    border: none;
    border-radius: 8px;
    color: white;
    font-weight: 700;
    padding: 9px 16px;
    cursor: pointer;
    transition: opacity 0.15s;
    font-size: 0.82rem;
    flex-shrink: 0;
    height: 38px;
    white-space: nowrap;
  }
  .ai-send:hover { opacity: 0.85; }
  .ai-send:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 600px) {
    .ai-panel { width: 100%; }
  }
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
    <button class="ai-toggle" id="aiToggle" onclick="toggleAiPanel()">✦ AI</button>
  </div>
</header>

<!-- ── AI Chat Panel ── -->
<div class="ai-panel" id="aiPanel">
  <div class="ai-panel-header">
    <div>
      <div class="ai-panel-title"><span class="ai-panel-icon">✦</span> Tally AI</div>
      <div class="ai-panel-subtitle">Multi-church assistant</div>
    </div>
    <button class="ai-close-btn" onclick="toggleAiPanel()" title="Close">×</button>
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

function syncBadge(syncStatus) {
  const st = syncStatus?.status;
  const ms = syncStatus?.avOffsetMs;
  if (!st || st === 'unavailable') {
    return '<span class="tag tag-sync-na">⚫ SYNC</span>';
  }
  if (st === 'ok') {
    return '<span class="tag tag-sync-ok">🟢 SYNC &lt;33ms</span>';
  }
  if (st === 'warn') {
    const absMs = ms !== null && ms !== undefined ? Math.abs(ms) : '?';
    return \`<span class="tag tag-sync-warn">🟡 SYNC ~\${absMs}ms</span>\`;
  }
  if (st === 'critical') {
    const absMs = ms !== null && ms !== undefined ? Math.abs(ms) : '?';
    return \`<span class="tag tag-sync-crit">🔴 SYNC \${absMs}ms</span>\`;
  }
  return '<span class="tag tag-sync-na">⚫ SYNC</span>';
}

function renderCard(church) {
  const dotCls = statusDotClass(church);
  const alerts = church.activeAlerts || 0;
  const s = church.status || {};
  const atemConnected  = s.atem?.connected;
  const obsStreaming   = s.obs?.streaming;
  const obsConnected   = s.obs?.connected;
  const encoderActive  = church.encoderActive || false;

  const encoderBadge = encoderActive
    ? '<span class="tag tag-encoder-on">📡 Encoder</span>'
    : '<span class="tag tag-encoder-off">📡 Encoder</span>';

  const syncBadgeHtml = syncBadge(church.syncStatus);

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
      <div class="row">
        <span class="row-label">Encoder</span>
        <span class="row-value">\${encoderBadge} \${syncBadgeHtml}</span>
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
        window._churchStates = data.churches;
        renderGrid(data.churches);
      } else if (data.type === 'update' && data.church) {
        if (!window._churchStates) window._churchStates = {};
        window._churchStates[data.church.churchId] = data.church;
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

// ── AI Chat Panel ──────────────────────────────────────────────────────────
function toggleAiPanel() {
  const panel = document.getElementById('aiPanel');
  const toggle = document.getElementById('aiToggle');
  const isOpen = panel.classList.toggle('open');
  toggle.classList.toggle('active', isOpen);
  if (isOpen) {
    setTimeout(() => document.getElementById('aiInput').focus(), 300);
  }
}

async function sendAiMessage() {
  const input = document.getElementById('aiInput');
  const msg = input.value.trim();
  if (!msg) return;

  input.value = '';
  input.style.height = 'auto';
  appendAiMessage('user', msg);

  const sendBtn = document.getElementById('aiSend');
  const thinking = document.getElementById('aiThinking');
  sendBtn.disabled = true;
  thinking.classList.add('visible');

  const states = window._churchStates || {};

  try {
    const res = await fetch('/api/chat?key=' + encodeURIComponent(KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, churchStates: states }),
    });
    const data = await res.json();
    appendAiMessage('assistant', data.reply || data.error || 'No response.');
  } catch (e) {
    appendAiMessage('assistant', 'Connection error: ' + e.message);
  } finally {
    sendBtn.disabled = false;
    thinking.classList.remove('visible');
  }
}

function appendAiMessage(role, text) {
  const msgs = document.getElementById('aiMessages');
  const wrapper = document.createElement('div');
  wrapper.className = 'ai-msg ' + role;
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  bubble.textContent = text;
  const label = document.createElement('div');
  label.className = 'ai-label';
  label.textContent = role === 'user' ? 'You' : 'Tally AI';
  wrapper.appendChild(bubble);
  wrapper.appendChild(label);
  msgs.appendChild(wrapper);
  msgs.scrollTop = msgs.scrollHeight;
}

// Auto-resize textarea and Enter to send
document.getElementById('aiInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});
document.getElementById('aiInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendAiMessage();
  }
});
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

  // ── AI Chat endpoint ──────────────────────────────────────────────────────
  app.post('/api/chat', async (req, res) => {
    if (!checkKey(req, res)) return;

    const { message, churchStates } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message (string) is required' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({
        reply: 'AI assistant is not configured — set ANTHROPIC_API_KEY on the server to enable AI chat.',
      });
    }

    const systemPrompt =
      'You are Tally AI, the admin assistant for a multi-church AV monitoring system. ' +
      'You have real-time visibility into all connected churches. ' +
      'Answer questions about church status, explain alerts, suggest fixes, and help the admin manage their fleet. ' +
      'Be concise. ' +
      'Current church states: ' + JSON.stringify(churchStates || {}) + '. ' +
      'Available commands: status queries, alert summaries, config suggestions.';

    try {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          system: systemPrompt,
          messages: [{ role: 'user', content: message }],
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        console.error('[Dashboard/AI] API error:', aiRes.status, errText);
        return res.status(502).json({ error: 'AI API error', details: errText });
      }

      const data = await aiRes.json();
      const reply = data.content?.[0]?.text || 'No response from AI.';
      res.json({ reply });
    } catch (e) {
      console.error('[Dashboard/AI] fetch error:', e.message);
      res.status(500).json({ error: e.message });
    }
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
