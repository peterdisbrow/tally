/**
 * Dashboard shared styles + reseller portal HTML builder.
 *
 * buildResellerPortalHtml(r) → White-labeled reseller portal HTML
 */

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

  /* Health telemetry */
  .health-ok { color: var(--green); }
  .health-warn { color: var(--yellow); }
  .health-crit { color: var(--red); }
  .health-grid { display: flex; flex-direction: column; gap: 0; }
  .health-device { display: grid; grid-template-columns: 120px 80px 60px 110px 60px; align-items: center; gap: 8px; font-size: 0.78rem; padding: 7px 0; border-bottom: 1px solid var(--border); }
  .health-device:last-child { border-bottom: none; }
  .health-device-hdr { font-weight: 700; color: var(--muted); font-size: 0.72rem; }
`;

// ─── Shared JS helpers ────────────────────────────────────────────────────────

const SHARED_JS = `
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function asObj(v) {
  return v && typeof v === 'object' ? v : {};
}

function isConnected(v) {
  if (v === true) return true;
  const o = asObj(v);
  if (!Object.keys(o).length) return false;
  if (o.connected !== undefined) return !!o.connected;
  if (o.online !== undefined) return !!o.online;
  if (o.active !== undefined) return !!o.active;
  if (typeof o.status === 'boolean') return !!o.status;
  return false;
}

function isStreamingStatus(status) {
  const s = status || {};
  const obs = asObj(s.obs);
  const enc = asObj(s.encoder);
  return !!(s.streaming === true || obs.streaming === true || enc.live === true || enc.streaming === true);
}

function atemConfigPresent(status, church) {
  const s = status || {};
  const atem = asObj(s.atem);
  return !!(church && (church.atemActive || church.atemIp) || atem.ip || s.atem === true);
}

function encoderConfigPresent(status, church) {
  const s = status || {};
  const enc = asObj(s.encoder);
  return !!(
    (church && church.encoderActive) ||
    s.encoder === true ||
    enc.type || enc.host || enc.port || enc.source
  );
}

function statusDotClass(church) {
  if (!church.connected) return 'dot-gray';
  if ((church.activeAlerts || 0) > 0) return 'dot-red';
  const s = church.status || {};
  const atemConfigured = atemConfigPresent(s, church);
  const atemOk = !atemConfigured || isConnected(s.atem);
  const encoderConfigured = encoderConfigPresent(s, church);
  const encoderOk = !encoderConfigured || isConnected(s.encoder);

  if (!atemOk || !encoderOk) return 'dot-yellow';
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

function healthSummary(health) {
  if (!health) return '<span class="tag tag-na">—</span>';
  const lat = health.relay?.latencyMs;
  const devKeys = ['atem','obs','ptz','companion','proPresenter','resolume','vmix','mixer','hyperdeck','encoder','camera'];
  let totalCmd = 0, okCmd = 0, reconn = 0;
  for (const k of devKeys) {
    const d = health[k];
    if (!d) continue;
    totalCmd += d.commandsTotal || 0;
    okCmd += d.commandsOk || 0;
    reconn += d.reconnects || 0;
  }
  reconn += health.relay?.reconnects || 0;
  const rate = totalCmd > 0 ? ((okCmd / totalCmd) * 100).toFixed(1) : null;
  let cls = 'health-ok';
  if ((lat != null && lat > 1000) || (rate !== null && parseFloat(rate) < 95) || reconn > 5) cls = 'health-crit';
  else if ((lat != null && lat > 200) || (rate !== null && parseFloat(rate) < 99) || reconn > 2) cls = 'health-warn';
  const parts = [];
  if (lat != null) parts.push(lat + 'ms');
  if (rate !== null) parts.push(rate + '%');
  parts.push(reconn + ' reconn');
  return '<span class="' + cls + '" style="font-size:0.72rem;font-weight:500;">' + parts.join(' · ') + '</span>';
}

function encoderTypeName(type) {
  const names = {
    obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Blackmagic',
    aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek', tricaster: 'TriCaster', birddog: 'BirdDog',
    ndi: 'NDI Decoder', yolobox: 'YoloBox', 'youtube-live': 'YouTube Live', 'facebook-live': 'Facebook Live', 'vimeo-live': 'Vimeo Live',
    'tally-encoder': 'Tally Enc', custom: 'Custom', 'custom-rtmp': 'RTMP', 'rtmp-generic': 'RTMP',
  };
  return names[type] || 'Encoder';
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
  const atemConnected = isConnected(s.atem);
  const obsConnected  = isConnected(s.obs);
  const obsStreaming  = isStreamingStatus({ obs: s.obs, encoder: {}, streaming: s.streaming });
  const encoderActive = church.encoderActive || isConnected(s.encoder);
  const encoderData   = asObj(s.encoder);
  const encoderName    = encoderTypeName(encoderData.type);
  const encoderLive    = encoderData.live || obsStreaming || false;
  const audioData      = s.audio || {};
  const mixerData      = s.mixer || {};
  const audioMuted     = mixerData.mainMuted || false;
  const audioSilence   = audioData.silenceDetected || false;
  const mixerConnected = mixerData.connected || false;
  const audioViaAtem = !!(church.audio_via_atem);
  const atemAudioSources = s.atem?.atemAudioSources || [];
  const audioPortLabel = atemAudioSources.length > 0 ? ' (' + esc(atemAudioSources[0].portType) + ')' : '';
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

  // 2) Row values — Connection, ATEM, Stream, Encoder, Audio
  const rows = card.querySelectorAll('.card-rows .row');
  const rowDefs = [
    { val: church.connected, on: 'Online',    off: 'Offline' },
    { val: atemConnected,    on: 'Connected',  off: 'Disconnected' },
    { val: encoderLive,      on: '🔴 Live',    off: 'Off-air', na: 'Unknown' },
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

  // 3) Encoder row (4th row) — update encoder badge + sync badge
  if (rows.length >= 4) {
    const rv = rows[3].querySelector('.row-value');
    if (rv) {
      const encoderBadge = encoderActive
        ? \`<span class="tag tag-encoder-on">📡 \${encoderName}</span>\`
        : \`<span class="tag tag-encoder-off">📡 \${encoderName}</span>\`;
      const newHtml = encoderBadge + ' ' + syncBadge(church.syncStatus);
      if (rv.innerHTML !== newHtml) rv.innerHTML = newHtml;
    }
  }

  // 4) Audio row (5th row)
  if (rows.length >= 5) {
    const rv = rows[4].querySelector('.row-value');
    if (rv) {
      const audioBadge = audioMuted
        ? '<span class="tag tag-off">🔇 Muted</span>'
        : audioSilence
          ? '<span class="tag" style="background:rgba(245,158,11,0.15);color:var(--yellow);">⚠ Silence</span>'
          : (mixerConnected || audioViaAtem)
            ? (encoderLive ? '<span class="tag tag-on">🔊 OK' + audioPortLabel + '</span>' : '<span class="tag tag-na">🔊 Standby</span>')
            : '<span class="tag tag-na">🔊 —</span>';
      if (rv.innerHTML !== audioBadge) rv.innerHTML = audioBadge;
    }
  }

  // 5b) Health row (6th row)
  if (rows.length >= 6) {
    const rv = rows[5].querySelector('.row-value');
    if (rv) {
      const newHtml = healthSummary(s.health);
      if (rv.innerHTML !== newHtml) rv.innerHTML = newHtml;
    }
  }

  // 5) Alert badge
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
      headers: { 'x-reseller-key': RESELLER_KEY },
      signal: AbortSignal.timeout(10000),
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
  const atemConnected = isConnected(s.atem);
  const obsStreaming  = isStreamingStatus({ obs: s.obs, encoder: {}, streaming: s.streaming });
  const encoderActive = church.encoderActive || isConnected(s.encoder);
  const encoderData   = asObj(s.encoder);
  const encoderName    = encoderTypeName(encoderData.type);
  const encoderLive    = encoderData.live || obsStreaming || false;
  const encoderBadge = encoderActive
    ? \`<span class="tag tag-encoder-on">📡 \${encoderName}</span>\`
    : \`<span class="tag tag-encoder-off">📡 \${encoderName}</span>\`;
  const audioData  = s.audio || {};
  const mixerData  = s.mixer || {};
  const audioMuted = mixerData.mainMuted || false;
  const mixerConnected = mixerData.connected || false;
  const audioViaAtem = !!(church.audio_via_atem);
  const atemAudioSrcs3 = s.atem?.atemAudioSources || [];
  const audioPort3 = atemAudioSrcs3.length > 0 ? ' (' + esc(atemAudioSrcs3[0].portType) + ')' : '';
  const audioBadge = audioMuted
    ? '<span class="tag tag-off">🔇 Muted</span>'
    : audioData.silenceDetected
      ? '<span class="tag" style="background:rgba(245,158,11,0.15);color:var(--yellow);">⚠ Silence</span>'
      : (mixerConnected || audioViaAtem)
        ? (encoderLive ? '<span class="tag tag-on">🔊 OK' + audioPort3 + '</span>' : '<span class="tag tag-na">🔊 Standby</span>')
        : '<span class="tag tag-na">🔊 —</span>';

  return \`<div class="card" id="card-\${esc(church.churchId)}">
    <div class="card-header">
      <div class="status-dot \${dotCls}"></div>
      <div class="church-name">\${esc(church.name)}</div>
      <span class="alert-badge \${alerts > 0 ? 'visible' : ''}">\${alerts} alert\${alerts !== 1 ? 's' : ''}</span>
    </div>
    <div class="card-rows">
      <div class="row"><span class="row-label">Connection</span><span class="row-value">\${tag(church.connected, 'Online', 'Offline')}</span></div>
      <div class="row"><span class="row-label">ATEM</span><span class="row-value">\${tag(atemConnected, 'Connected', 'Disconnected')}</span></div>
      <div class="row"><span class="row-label">Stream</span><span class="row-value">\${tag(encoderLive, '🔴 Live', 'Off-air', 'Unknown')}</span></div>
      <div class="row"><span class="row-label">Encoder</span><span class="row-value">\${encoderBadge}</span></div>
      <div class="row"><span class="row-label">Audio</span><span class="row-value">\${audioBadge}</span></div>
      <div class="row"><span class="row-label">Health</span><span class="row-value">\${healthSummary(s.health)}</span></div>
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
      signal: AbortSignal.timeout(10000),
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

module.exports = { buildResellerPortalHtml };
