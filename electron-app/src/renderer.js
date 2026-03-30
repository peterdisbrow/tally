const api = window.electronAPI;
let _onboardingScanResults = {};
let _onboardingSending = false;
let isRunning = false;
let alertCount = 0;
let _activityCount = 0;
let _hasReceivedRelayStatus = false; // true after first real status from relay SSE

// ─── COLLAPSIBLE SECTIONS ────────────────────────────────────────────────────
// Persist open/closed state in localStorage
function toggleCollapsible(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('collapsed');
  const states = JSON.parse(localStorage.getItem('collapsedSections') || '{}');
  states[id] = el.classList.contains('collapsed');
  localStorage.setItem('collapsedSections', JSON.stringify(states));
}

function restoreCollapsibleStates() {
  const states = JSON.parse(localStorage.getItem('collapsedSections') || '{}');
  // Default collapsed sections (if no saved preference)
  const defaults = {
    'section-device-identity': true,
    'section-activity': true,
    'section-raw-logs': true,
    'section-atem': false,
    'encoder-status-section': false,
    'failover-status-section': false,
    'section-propresenter': false,
    'rundown-panel': false,
  };
  const merged = { ...defaults, ...states };
  for (const [id, collapsed] of Object.entries(merged)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (collapsed) el.classList.add('collapsed');
    else el.classList.remove('collapsed');
  }
}

// ─── THEME TOGGLE ────────────────────────────────────────────────────────────
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = isLight ? '🌙' : '☀️';
}

function restoreTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light') {
    document.body.classList.add('light-theme');
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = '🌙';
  }
}

function updateActivityBadge() {
  const badge = document.getElementById('activity-badge');
  if (!badge) return;
  if (_activityCount > 0) {
    badge.textContent = _activityCount > 99 ? '99+' : _activityCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}
let pendingDiscoveryNic = '';
let _audioViaAtem = false; // synced from relay — true if church routes audio directly into ATEM
const DEFAULT_RELAY_URL = 'wss://api.tallyconnect.app';

// ─── OFFLINE MODE CACHING ──────────────────────────────────────────────────
let _cachedStatus = null;         // last-known status snapshot
let _cachedStatusTime = null;     // Date when status was last received
let _relayDisconnectedAt = null;  // Date when relay went offline
let _reconnectAttempt = 0;        // exponential backoff counter
let _reconnectCountdownTimer = null;

// ─── OFFLINE ACTION QUEUE ──────────────────────────────────────────────────
// Queue actions attempted while offline; replay when relay reconnects.
const _offlineQueue = [];
const MAX_QUEUE_SIZE = 50;

// ─── BITRATE HISTORY ───────────────────────────────────────────────────────
// Rolling 30-sample buffer (~2.5 min at 5s update interval).
// Only populated while streaming so the graph reflects live sessions.
const _bitrateHistory = [];
const BITRATE_HISTORY_MAX = 30;

function _pushBitrateHistory(bitrate, streaming) {
  if (!streaming || typeof bitrate !== 'number') return;
  _bitrateHistory.push(bitrate);
  if (_bitrateHistory.length > BITRATE_HISTORY_MAX) _bitrateHistory.shift();
}

/**
 * Render a compact SVG sparkline from _bitrateHistory.
 * Returns an SVG string, or '' if fewer than 2 samples.
 */
function _renderBitrateSparkline() {
  if (_bitrateHistory.length < 2) return '';
  const W = 56, H = 18, PAD = 1;
  const min = Math.min(..._bitrateHistory);
  const max = Math.max(..._bitrateHistory);
  const range = max - min || 1;
  const pts = _bitrateHistory.map((v, i) => {
    const x = PAD + (i / (_bitrateHistory.length - 1)) * (W - PAD * 2);
    const y = PAD + (1 - (v - min) / range) * (H - PAD * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // Color: green if latest >= 4000 Kbps, yellow if >= 2000, red below
  const latest = _bitrateHistory[_bitrateHistory.length - 1];
  const color = latest >= 4000 ? '#22c55e' : latest >= 2000 ? '#f59e0b' : '#ef4444';
  const latestKbps = Math.round(latest);
  const trendLabel = `Bitrate trend: ${latestKbps} Kbps (${latest >= 4000 ? 'healthy' : latest >= 2000 ? 'marginal' : 'low'})`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${trendLabel}" style="display:inline-block;vertical-align:middle;margin-right:5px;flex-shrink:0;"><title>${trendLabel}</title><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function queueOfflineAction(action) {
  if (_offlineQueue.length >= MAX_QUEUE_SIZE) _offlineQueue.shift();
  _offlineQueue.push({ ...action, queuedAt: Date.now() });
  updateOfflineQueueBadge();
}

async function flushOfflineQueue() {
  if (!_offlineQueue.length) return;
  const items = _offlineQueue.splice(0);
  let replayed = 0;
  for (const item of items) {
    try {
      if (item.type === 'chat' && item.message) {
        await api.sendChat({ message: item.message, senderName: item.senderName || 'TD' });
        replayed++;
      }
    } catch {
      // If still offline, re-queue
      _offlineQueue.unshift(item);
      break;
    }
  }
  updateOfflineQueueBadge();
  if (replayed > 0) {
    addAlert(`Sent ${replayed} queued message${replayed !== 1 ? 's' : ''} from offline.`);
  }
}

function updateOfflineQueueBadge() {
  const el = document.getElementById('offline-queue-count');
  if (el) {
    el.textContent = _offlineQueue.length || '';
    el.style.display = _offlineQueue.length ? '' : 'none';
  }
}

// ─── JWT EXPIRY WARNING ────────────────────────────────────────────────────
function checkJwtExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (!payload.exp) return;
    const expiresAt = new Date(payload.exp * 1000);
    const msUntilExpiry = expiresAt - Date.now();
    const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry <= 0) return; // Already expired — auth flow handles this
    if (daysUntilExpiry <= 7) {
      const daysText = daysUntilExpiry < 1 ? 'today' : `in ${Math.ceil(daysUntilExpiry)} day${Math.ceil(daysUntilExpiry) !== 1 ? 's' : ''}`;
      const banner = document.getElementById('jwt-expiry-banner');
      if (banner) {
        banner.textContent = `⚠ Your session expires ${daysText}. Sign out and sign in again to renew.`;
        banner.style.display = '';
      }
    }
  } catch { /* ignore — malformed token */ }
}

// ─── PROBLEM FINDER AUTO-RUN ───────────────────────────────────────────────
let _pfAutoRunDone = false;       // only auto-run once per session
let _pfAutoRunIssueCount = 0;     // cached count for badge

// ─── FRIENDLY ERROR MESSAGES ───────────────────────────────────────────────
function _friendlyWithPrefix(raw, friendly) {
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0 && colonIdx < 40) {
    const prefix = raw.substring(0, colonIdx).trim();
    // Only keep the prefix if it looks like device context (not "Error")
    if (!/^error$/i.test(prefix)) return `${prefix}: ${friendly}`;
  }
  return friendly;
}

function friendlyError(err) {
  const msg = typeof err === 'string' ? err : (err?.message || err?.error || String(err));
  const lower = msg.toLowerCase();

  // Connection refused patterns
  if (lower.includes('connection refused') || lower.includes('econnrefused')) {
    if (lower.includes('9910') || lower.includes('atem') || lower.includes('switcher')) {
      return _friendlyWithPrefix(msg, "Can't reach your ATEM switcher. Make sure it's powered on and connected to the same network.");
    }
    return _friendlyWithPrefix(msg, "Connection failed -- is the device powered on?");
  }

  // Timeout patterns
  if (lower.includes('etimedout') || lower.includes('timed out') || lower.includes('timeout')) {
    return _friendlyWithPrefix(msg, "Device didn't respond -- check the network cable and make sure it's on the same subnet.");
  }

  // WebSocket errors
  if (lower.includes('websocket') || lower.includes('ws error') || lower.includes('ws close')) {
    return _friendlyWithPrefix(msg, "Lost connection to relay server -- reconnecting...");
  }

  // DNS / host not found
  if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    return _friendlyWithPrefix(msg, "Can't find that address -- check the hostname or IP is correct.");
  }

  // Network unreachable
  if (lower.includes('enetunreach') || lower.includes('network is unreachable')) {
    return _friendlyWithPrefix(msg, "Network unreachable -- check your Wi-Fi or Ethernet connection.");
  }

  // Connection reset
  if (lower.includes('econnreset') || lower.includes('connection reset')) {
    return _friendlyWithPrefix(msg, "Connection was interrupted -- the device may have restarted.");
  }

  // Permission / auth
  if (lower.includes('eacces') || lower.includes('permission denied')) {
    return _friendlyWithPrefix(msg, "Permission denied -- check your credentials or firewall settings.");
  }

  // Generic fallback: clean up technical prefix
  return msg.replace(/^Error:\s*/i, '');
}

// Well-known ATEM input IDs → human-readable fallback names
const ATEM_INPUT_NAMES = {
  0: 'Black', 1000: 'Color Bars', 2001: 'Color 1', 2002: 'Color 2',
  3010: 'MP 1', 3011: 'MP 1 Key', 3020: 'MP 2', 3021: 'MP 2 Key',
  6000: 'Super Source', 7001: 'Clean Feed 1', 7002: 'Clean Feed 2',
  10010: 'ME 1 Pgm', 10011: 'ME 1 Pvw', 10020: 'ME 2 Pgm', 10021: 'ME 2 Pvw',
};

/**
 * Get a human-readable name for an ATEM input ID.
 * Uses stored labels first, then well-known IDs, then "Input N".
 */
function getInputName(inputId, inputLabels) {
  if (inputId === null || inputId === undefined) return null;
  // Check user-assigned labels from ATEM
  if (inputLabels && inputLabels[String(inputId)]) {
    return inputLabels[String(inputId)];
  }
  // Check well-known ATEM special input IDs
  if (ATEM_INPUT_NAMES[inputId]) return ATEM_INPUT_NAMES[inputId];
  // Fallback — "Cam N" for standard inputs (1-20), "Input N" for unknowns
  if (inputId >= 1 && inputId <= 20) return `Cam ${inputId}`;
  return `Input ${inputId}`;
}

function showFatalInitError(message) {
  const wizard = document.getElementById('wizard');
  const dashboard = document.getElementById('dashboard');
  if (dashboard) dashboard.classList.remove('active');
  if (wizard) wizard.classList.add('active');

  const content = wizard?.querySelector('.content');
  if (!content) return;
  content.innerHTML = '';
  const box = document.createElement('div');
  box.style.cssText = 'max-width:460px;margin:30px auto;padding:16px;border-radius:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);color:#fca5a5;font-size:13px;line-height:1.6;';
  const title = document.createElement('div');
  title.style.cssText = 'font-weight:700;margin-bottom:8px;';
  title.textContent = 'Tally failed to initialize';
  const msg = document.createElement('div');
  msg.textContent = message;
  const hint = document.createElement('div');
  hint.style.cssText = 'margin-top:10px;color:#94A3B8;';
  hint.textContent = 'Please restart the app. If the problem continues, contact your tech director or visit tallyconnect.app/help.';
  box.appendChild(title);
  box.appendChild(msg);
  box.appendChild(hint);
  content.appendChild(box);
}

// ─── NON-BLOCKING CONFIRM ───────────────────────────────────────────────────
// Replaces window.confirm() which freezes the renderer (blocks status updates, chat, etc.)

function asyncConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.dataset.asyncOverlay = '1'; // allow hideAllViews() to remove stuck overlays
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--card,#1e293b);border:1px solid var(--border,#334155);border-radius:10px;padding:20px 24px;max-width:360px;color:var(--white,#f1f5f9);font-size:13px;line-height:1.5;text-align:center;';
    const msg = document.createElement('div');
    msg.textContent = message;
    msg.style.marginBottom = '16px';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:10px;justify-content:center;';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel';
    btnCancel.style.cssText = 'padding:6px 18px;border-radius:6px;border:1px solid var(--border,#334155);background:transparent;color:var(--muted,#94a3b8);cursor:pointer;font-size:12px;';
    const btnOk = document.createElement('button');
    btnOk.textContent = 'OK';
    btnOk.style.cssText = 'padding:6px 18px;border-radius:6px;border:none;background:var(--danger,#ef4444);color:#fff;cursor:pointer;font-size:12px;font-weight:600;';
    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);
    box.appendChild(msg);
    box.appendChild(btnRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const cleanup = (val) => { overlay.remove(); resolve(val); };
    btnOk.addEventListener('click', () => cleanup(true));
    btnCancel.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
  });
}

// ─── STREAM GUARD CONFIRM ────────────────────────────────────────────────────
// Purpose-built danger dialog for commands that could kill the live broadcast.
// Cancel is the primary/prominent action — proceeding requires deliberate effort.
//
// Usage:
//   const go = await asyncStreamGuardConfirm('stop the OBS stream', 'critical');
//   if (!go) return;
//
// @param {string} action   - Short description of what will happen
// @param {string} severity - 'critical' | 'high'
// @returns {Promise<boolean>}

function asyncStreamGuardConfirm(action, severity = 'critical') {
  return new Promise((resolve) => {
    const isCritical = severity === 'critical';
    const accentColor = isCritical ? '#ef4444' : '#f59e0b';
    const accentDim   = isCritical ? 'rgba(239,68,68,0.12)' : 'rgba(245,158,11,0.12)';

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:10000;display:flex;align-items:center;justify-content:center;';
    overlay.dataset.asyncOverlay = '1'; // allow hideAllViews() to remove stuck overlays

    const box = document.createElement('div');
    box.style.cssText = `background:var(--card,#1e293b);border:2px solid ${accentColor};border-radius:12px;padding:0;max-width:380px;width:90%;color:var(--white,#f1f5f9);font-size:13px;line-height:1.5;overflow:hidden;box-shadow:0 0 40px rgba(0,0,0,0.6);`;

    // Header banner
    const header = document.createElement('div');
    header.style.cssText = `background:${accentDim};border-bottom:1px solid ${accentColor};padding:10px 18px;display:flex;align-items:center;gap:8px;`;
    const icon = document.createElement('span');
    icon.innerHTML = isCritical ? '<span style="color:#ef4444">&#9679;</span>' : '<span style="color:#f59e0b">&#9679;</span>';
    icon.style.cssText = 'font-size:16px;flex-shrink:0;';
    const headerText = document.createElement('span');
    headerText.textContent = isCritical ? 'STREAM IS LIVE' : 'CAUTION — IN PRODUCTION';
    headerText.style.cssText = `font-weight:700;font-size:12px;letter-spacing:0.08em;color:${accentColor};text-transform:uppercase;`;
    header.appendChild(icon);
    header.appendChild(headerText);

    // Body
    const body = document.createElement('div');
    body.style.cssText = 'padding:18px;';
    const desc = document.createElement('div');
    desc.style.cssText = 'margin-bottom:6px;font-size:14px;';
    desc.innerHTML = `You're about to <strong>${action}</strong>.`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--muted,#94a3b8);margin-bottom:20px;';
    sub.textContent = isCritical
      ? 'This will immediately affect your live broadcast.'
      : 'This will disrupt your active recording or broadcast.';

    // Buttons — Cancel is visually dominant; proceed is muted secondary
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    const btnCancel = document.createElement('button');
    btnCancel.textContent = 'Cancel — Keep Stream Running';
    btnCancel.style.cssText = `padding:10px 18px;border-radius:8px;border:none;background:var(--green,#22c55e);color:#fff;cursor:pointer;font-size:13px;font-weight:700;width:100%;`;
    const btnOk = document.createElement('button');
    btnOk.textContent = `Proceed anyway`;
    btnOk.style.cssText = `padding:8px 18px;border-radius:8px;border:1px solid ${accentColor};background:transparent;color:${accentColor};cursor:pointer;font-size:12px;width:100%;`;

    btnRow.appendChild(btnCancel);
    btnRow.appendChild(btnOk);
    body.appendChild(desc);
    body.appendChild(sub);
    body.appendChild(btnRow);
    box.appendChild(header);
    box.appendChild(body);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = (val) => { overlay.remove(); resolve(val); };
    btnCancel.addEventListener('click', () => cleanup(false));
    btnOk.addEventListener('click', () => cleanup(true));
    // Clicking outside dismisses as cancel (safe default)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    // ESC key = cancel
    const onKey = (e) => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); cleanup(false); } };
    document.addEventListener('keydown', onKey);
  });
}

// ─── INIT ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    if (!api) throw new Error('Desktop bridge unavailable (window.electronAPI missing).');

    // Use process.platform (via preload bridge) for reliable macOS detection on Apple Silicon.
    // navigator.platform returns "" on arm64 in Electron 35+, breaking is-mac CSS.
    const isMac = api.getPlatform ? api.getPlatform() === 'darwin' : /^mac/i.test(navigator.platform);
    if (isMac) document.body.classList.add('is-mac');
    await hydrateNetworkInterfaceSelect();
    const wizNic = document.getElementById('wiz-scan-nic');
    if (wizNic) {
      pendingDiscoveryNic = wizNic.value || '';
      wizNic.addEventListener('change', () => {
        const selected = wizNic.value || '';
        pendingDiscoveryNic = selected;
        const scanNic = document.getElementById('scan-nic');
        if (scanNic) scanNic.value = selected;
      });
    }

    const scanNic = document.getElementById('scan-nic');
    if (scanNic) {
      scanNic.addEventListener('change', () => {
        const selected = scanNic.value || '';
        pendingDiscoveryNic = selected;
        if (wizNic) wizNic.value = selected;
      });
    }

    // Enter key on sign-in password field triggers sign-in
    const siPassword = document.getElementById('si-password');
    if (siPassword) {
      siPassword.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSignIn();
      });
    }

    // Enter key on room name field triggers create
    const rsRoomName = document.getElementById('rs-room-name');
    if (rsRoomName) {
      rsRoomName.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doCreateRoom();
      });
    }

    // Listen for mid-session auth invalidation
    api.onAuthInvalid(() => {
      isRunning = false;
      if (typeof resetDeviceState === 'function') resetDeviceState();
      _cachedStatus = null;
      showSignIn();
      showSignInMessage('Session was invalidated by the server. Please sign in again.', 'var(--warn)');
    });

    // Listen for sign-out triggered from the system tray or factory reset
    api.onSignedOut(() => {
      isRunning = false;
      updateToggleBtn();

      // Clear all in-memory device/equipment state so stale data doesn't persist
      if (typeof resetDeviceState === 'function') resetDeviceState();
      _cachedStatus = null;
      _audioViaAtem = false;
      _failoverConfigLoaded = false;
      _failoverSources = { atem: [], videohub: [], obs: [] };
      _preServiceData = null;
      _rundownData = null;
      _obScanDone = false;

      // Clear chat state and stop polling
      stopChatPolling();
      chatMessages = [];
      chatLastTimestamp = null;
      _chatRenderedCount = 0;
      _chatIdSet.clear();
      const chatContainer = document.getElementById('chat-messages');
      if (chatContainer) chatContainer.innerHTML = '';

      // Clear all activity logs, raw logs, and counters
      alertCount = 0;
      _activityCount = 0;
      const alertsLog = document.getElementById('alerts-log');
      if (alertsLog) alertsLog.innerHTML = '<div class="empty-state">No activity yet.</div>';
      if (typeof clearRawLogs === 'function') clearRawLogs();
      updateActivityBadge();

      showSignIn();
      showSignInMessage('Signed out.', 'var(--muted)');
    });

    const config = await api.getConfig();
    isRunning = await api.isRunning();
    _audioViaAtem = !!(config.audioViaAtem);

    if (config.token) {
      // Check JWT expiry and warn if within 7 days (P2 item 12)
      checkJwtExpiry(config.token);

      // Returning user — validate token silently
      showSignInLoading('Checking your account...');
      document.body.classList.add('ready');

      const result = await api.validateToken();
      // Re-read config after validation — validateToken may sync profile flags from relay
      const freshConfig = await api.getConfig();
      try { _audioViaAtem = !!(freshConfig.audioViaAtem); } catch {}
      if (result.valid) {
        // Always show room selector on fresh launch — never auto-jump into a room.
        // This ensures the user explicitly picks which room to monitor each session.
        await showRoomSelector(freshConfig.name || config.name);
      } else {
        // Token invalid or expired
        const reason = result.reason || 'unknown';
        let msg = 'Session expired. Please sign in again.';
        if (reason === 'expired') msg = 'Session expired. Please sign in again.';
        else if (reason.includes('reach') || reason.includes('timeout') || reason.includes('Timeout')) msg = 'Could not reach relay server. Please try again.';
        else if (reason !== 'invalid' && reason !== 'expired') msg = `Authentication failed: ${reason}`;
        showSignIn();
        showSignInMessage(msg, 'var(--warn)');
      }
    } else {
      // No token — new user, show sign-in form
      showSignIn();
      document.body.classList.add('ready');
    }

    updateToggleBtn();
    const status = await api.getStatus();
    updateStatusUI(status);
    updateMultiEncoderUI(status);
    // Load pre-service check hero panel
    loadPreServiceCheck();
    // Load pre-service readiness widget
    loadPreServiceReadiness();
    // Load session recap card
    loadSessionRecap();
    // Load rundown panel
    loadRundownPanel();
    // Load auto-start setting
    loadAutoStartSetting();
    // Initialize Problem Finder real-time listener
    if (typeof initProblemFinderListener === 'function') initProblemFinderListener();
    // Auto-run problem finder after agent connects (background, delayed)
    if (isRunning && getStatusActive(status.relay)) {
      setTimeout(() => pfAutoRun(), 15000);
    }
  } catch (err) {
    console.error('Init failed:', err);
    showFatalInitError(err?.message || 'Unknown initialization error');
    document.body.classList.add('ready');
  }
}

// ─── WIZARD ────────────────────────────────────────────────────────────────

function hideAllViews() {
  document.getElementById('sign-in').classList.remove('active');
  document.getElementById('room-selector').classList.remove('active');
  document.getElementById('wizard').classList.remove('active');
  document.getElementById('dashboard').classList.remove('active');
  // Remove any stuck confirm/prompt overlays that would block all clicks.
  document.querySelectorAll('[data-async-overlay]').forEach(el => el.remove());
}

function showSignIn() {
  hideAllViews();
  document.getElementById('sign-in').classList.add('active');
  document.getElementById('sign-in-loading').classList.remove('active');
  document.getElementById('sign-in-form').classList.remove('hidden');
}

function showSignInLoading(text) {
  hideAllViews();
  document.getElementById('sign-in').classList.add('active');
  document.getElementById('sign-in-loading').classList.add('active');
  document.getElementById('sign-in-loading-text').textContent = text || 'Checking your account...';
  document.getElementById('sign-in-form').classList.add('hidden');
}

function showSignInMessage(msg, color) {
  const el = document.getElementById('si-message');
  if (el) {
    el.textContent = msg;
    el.style.color = color || 'var(--muted)';
  }
}

function showEquipmentWizard() {
  hideAllViews();
  document.getElementById('wizard').classList.add('active');
  initOnboarding();
}

function showWizard() {
  showEquipmentWizard();
}

async function showDashboard() {
  hideAllViews();
  document.getElementById('dashboard').classList.add('active');

  // Set encoder label from saved config so it shows immediately (before agent status arrives)
  try {
    const eq = await api.getEquipment();
    const encNames = {
      obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Blackmagic',
      aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek', tricaster: 'TriCaster', birddog: 'BirdDog',
      yolobox: 'YoloBox', 'tally-encoder': 'Tally Encoder', custom: 'Custom',
      'custom-rtmp': 'Custom RTMP', 'rtmp-generic': 'RTMP', 'atem-streaming': 'ATEM Mini',
    };
    const label = encNames[eq.encoderType] || 'Encoder';
    const dotLabel = document.getElementById('dot-encoder-label');
    if (dotLabel) dotLabel.textContent = label;
    const sectionTitle = document.getElementById('encoder-section-title');
    if (sectionTitle) sectionTitle.textContent = label;
    window._savedEquipment = eq;
  } catch { /* ignore — status updates will set it later */ }

  // Restore collapsible section states + theme
  restoreCollapsibleStates();
  restoreTheme();
  loadRoomPicker();
}

// ─── ROOM SELECTOR ─────────────��────────────────────────────────────────────

// Show the room selector screen and fetch rooms from relay.
// After user selects (or creates) a room, calls proceedAfterRoomSelection().
async function showRoomSelector(churchName) {
  hideAllViews();
  document.getElementById('room-selector').classList.add('active');
  document.body.classList.add('ready');

  const nameEl = document.getElementById('rs-church-name');
  if (nameEl && churchName) nameEl.textContent = churchName;

  const loading = document.getElementById('rs-loading');
  const roomList = document.getElementById('rs-room-list');
  const createForm = document.getElementById('rs-create-form');
  const addLink = document.getElementById('rs-add-link');
  const headline = document.getElementById('rs-headline');
  const subtitle = document.getElementById('rs-subtitle');
  const msg = document.getElementById('rs-message');

  loading.style.display = '';
  roomList.style.display = 'none';
  createForm.style.display = 'none';
  addLink.style.display = 'none';
  if (msg) msg.textContent = '';

  try {
    const result = await api.getRooms();
    loading.style.display = 'none';

    if (!result.success) {
      if (msg) { msg.textContent = result.error || 'Failed to load rooms.'; msg.style.color = 'var(--warn)'; }
      return;
    }

    const rooms = result.rooms || [];

    if (rooms.length === 0) {
      // No rooms — force creation
      headline.textContent = 'Create Your First Room';
      subtitle.textContent = 'Every Tally instance monitors a room. Create one to get started.';
      createForm.style.display = '';
      document.getElementById('rs-room-name').focus();
    } else {
      // Show room buttons
      headline.textContent = 'Select a Room';
      subtitle.textContent = 'Choose which room this computer will monitor.';
      roomList.innerHTML = '';
      for (const room of rooms) {
        const btn = document.createElement('button');
        btn.className = 'rs-room-btn';
        btn.innerHTML = `<div class="rs-room-icon">${roomIconForName(room.name)}</div><div><div class="rs-room-name">${escapeHtml(room.name)}</div>${room.description ? '<div class="rs-room-desc">' + escapeHtml(room.description) + '</div>' : ''}</div>`;
        btn.addEventListener('click', () => selectRoom(room.id, room.name));
        roomList.appendChild(btn);
      }
      roomList.style.display = '';
      addLink.style.display = '';
    }
  } catch (e) {
    loading.style.display = 'none';
    if (msg) { msg.textContent = 'Network error loading rooms.'; msg.style.color = 'var(--danger)'; }
  }
}

function roomIconForName(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('sanctuary') || lower.includes('worship') || lower.includes('chapel')) return '\u26EA';
  if (lower.includes('gym') || lower.includes('hall') || lower.includes('multi')) return '\uD83C\uDFDB';
  if (lower.includes('youth') || lower.includes('kids') || lower.includes('children')) return '\u2B50';
  if (lower.includes('outdoor') || lower.includes('tent')) return '\u26FA';
  return '\uD83C\uDFA5';
}

function showRoomCreateForm() {
  document.getElementById('rs-room-list').style.display = 'none';
  document.getElementById('rs-add-link').style.display = 'none';
  document.getElementById('rs-create-form').style.display = '';
  document.getElementById('rs-room-name').focus();
  document.getElementById('rs-headline').textContent = 'Add a New Room';
  document.getElementById('rs-subtitle').textContent = 'Give this room a name.';
}

async function doCreateRoom() {
  const nameInput = document.getElementById('rs-room-name');
  const name = nameInput.value.trim();
  const msg = document.getElementById('rs-message');
  const btn = document.getElementById('rs-create-btn');

  if (!name) {
    if (msg) { msg.textContent = 'Enter a room name.'; msg.style.color = 'var(--warn)'; }
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating...';
  if (msg) msg.textContent = '';

  try {
    const result = await api.createRoom(name);
    if (result.success && result.room) {
      // Auto-select the newly created room
      await selectRoom(result.room.id, result.room.name);
    } else {
      if (msg) { msg.textContent = result.error || 'Failed to create room.'; msg.style.color = 'var(--warn)'; }
    }
  } catch (e) {
    if (msg) { msg.textContent = 'Network error creating room.'; msg.style.color = 'var(--danger)'; }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Room';
  }
}

async function selectRoom(roomId, roomName) {
  const msg = document.getElementById('rs-message');
  if (msg) { msg.textContent = 'Assigning room...'; msg.style.color = 'var(--muted)'; }

  // Disable all room buttons to prevent double-click
  document.querySelectorAll('.rs-room-btn').forEach(b => { b.disabled = true; });

  try {
    // Clear any stale in-memory device state from a previous session
    if (typeof resetDeviceState === 'function') resetDeviceState();

    // Check if there's a previous room configured (returning user picking a room on startup)
    const prevConfig = await api.getConfig();
    const oldRoom = prevConfig.roomName || '';

    if (oldRoom) {
      // Use full room switch to properly swap equipment configs and fetch from relay
      const result = await api.fullRoomSwitch(oldRoom, roomName, roomId);
      if (result.ok) {
        isRunning = true;
        updateToggleBtn();
        setAllDotsConnecting();
        await proceedAfterRoomSelection(result.roomName || roomName);
      } else {
        if (msg) { msg.textContent = 'Failed to switch room.'; msg.style.color = 'var(--warn)'; }
        document.querySelectorAll('.rs-room-btn').forEach(b => { b.disabled = false; });
      }
    } else {
      // First-time room assignment — no previous room to switch from
      const result = await api.assignRoom(roomId);
      if (result.success) {
        await api.saveConfig({ roomId: result.roomId, roomName: result.roomName });
        // Fetch equipment config from relay (server-authoritative)
        await api.fetchRoomEquipment(result.roomId);
        await proceedAfterRoomSelection(result.roomName);
      } else {
        if (msg) { msg.textContent = result.error || 'Failed to assign room.'; msg.style.color = 'var(--warn)'; }
        document.querySelectorAll('.rs-room-btn').forEach(b => { b.disabled = false; });
      }
    }
  } catch (e) {
    if (msg) { msg.textContent = 'Network error.'; msg.style.color = 'var(--danger)'; }
    document.querySelectorAll('.rs-room-btn').forEach(b => { b.disabled = false; });
  }
}

// After a room is chosen, proceed to dashboard or equipment wizard
async function proceedAfterRoomSelection(roomName) {
  const config = await api.getConfig();
  const roomSuffix = roomName ? ' \u00b7 ' + roomName : '';
  const nameEl = document.getElementById('church-name');
  if (nameEl && config.name) nameEl.textContent = config.name + roomSuffix;

  if (config.setupComplete) {
    showDashboard();
    const autoStartResult = await api.getAutoStart();
    const shouldAutoStart = autoStartResult.enabled !== false;
    if (shouldAutoStart) {
      setAllDotsConnecting();
      try { await api.startAgent(); isRunning = true; } catch (e) { addAlert(`Agent start failed: ${e.message}`); }
    }
    updateToggleBtn();
  } else {
    showEquipmentWizard();
  }
}

function shouldRetryLoginOnDefaultRelay(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.success && result.data?.token) return false;
  const errorText = String(result.error || result.data?.error || '').toLowerCase();
  if (!errorText) return true;
  return [
    'timeout',
    'timed out',
    'network',
    'fetch',
    'econnrefused',
    'enotfound',
    'connection',
    'unreachable',
    'closed',
    'failed',
    'invalid email or password',
  ].some((needle) => errorText.includes(needle));
}

/**
 * Classify a failed login API response into a specific, actionable message.
 * Maps HTTP status codes and error strings to human-readable explanations.
 */
function classifySignInError(result) {
  const status = result?.status;
  const errText = String(result?.error || result?.data?.error || result?.data?.message || '').toLowerCase();

  // HTTP 401 Unauthorized → wrong credentials
  if (status === 401 || errText.includes('invalid password') || errText.includes('incorrect password') || errText.includes('wrong password') || errText.includes('invalid credentials')) {
    return 'Wrong password. Please check your password and try again.';
  }
  // HTTP 404 Not Found → account doesn't exist
  if (status === 404 || errText.includes('not found') || errText.includes('no account') || errText.includes('does not exist') || errText.includes('user not found')) {
    return 'Account not found. Check your email address or create an account at tallyconnect.app.';
  }
  // HTTP 429 Rate Limited
  if (status === 429 || errText.includes('too many') || errText.includes('rate limit')) {
    return 'Too many sign-in attempts. Please wait a few minutes and try again.';
  }
  // Network / relay unreachable
  if (!status && (errText.includes('timeout') || errText.includes('timed out') || errText.includes('network') || errText.includes('fetch') || errText.includes('enotfound') || errText.includes('econnrefused'))) {
    return 'Could not reach the Tally Connect server. Check your internet connection.';
  }
  // Generic 5xx server error
  if (status >= 500) {
    return `Server error (${status}). Please try again in a moment.`;
  }
  // Fallback with raw error for debugging
  return `Sign-in failed: ${friendlyError(result?.error || result?.data?.error || 'unknown error')}`;
}

async function doSignIn() {
  if (document.getElementById('si-btn').disabled) return;
  const email = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-password').value;
  const savedConfig = await api.getConfig();
  const preferredRelay = savedConfig.relay || DEFAULT_RELAY_URL;
  const btn = document.getElementById('si-btn');

  if (!email || !password) {
    showSignInMessage('Enter your email and password.', 'var(--warn)');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  showSignInMessage('Signing in...', 'var(--muted)');

  try {
    let relay = preferredRelay;
    let result = await api.churchAuthLogin({ relay, email, password });

    const canFallbackToDefault = preferredRelay !== DEFAULT_RELAY_URL;
    const needsFallback = canFallbackToDefault && shouldRetryLoginOnDefaultRelay(result);
    if (needsFallback) {
      showSignInMessage('Retrying on primary relay...', 'var(--muted)');
      relay = DEFAULT_RELAY_URL;
      result = await api.churchAuthLogin({ relay, email, password });
    }

    if (result.success && result.data?.token) {
      const token = result.data.token;
      const churchName = result.data?.church?.name || '';

      // Wipe local data if a different user/church is logging in
      await api.prepareForLogin(token);

      await api.saveConfig({ token, relay, name: churchName });

      // Always go to room selector after fresh login
      await showRoomSelector(churchName);
    } else {
      showSignInMessage(classifySignInError(result), 'var(--warn)');
    }
  } catch (e) {
    const lower = (e?.message || '').toLowerCase();
    if (lower.includes('fetch') || lower.includes('network') || lower.includes('failed to fetch') || lower.includes('enotfound')) {
      showSignInMessage('Network unreachable. Check your internet connection and try again.', 'var(--warn)');
    } else {
      showSignInMessage(`Sign-in error: ${friendlyError(e)}`, 'var(--danger)');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function doSignOut() {
  if (!(await asyncConfirm('Sign out? This will stop all monitoring.'))) return;
  try {
    await api.signOut();
    isRunning = false;
    updateToggleBtn();
    showSignIn();
    showSignInMessage('Signed out.', 'var(--muted)');
  } catch (e) {
    addAlert(`Sign-out failed: ${e.message}`);
  }
}

async function exportPortableConfig() {
  try {
    const result = await api.exportPortableConfig();
    if (result.canceled) return;
    if (result.error) { addAlert(`Config export failed: ${result.error}`); return; }
    addAlert(`Config exported to ${result.filePath}`);
  } catch (e) {
    addAlert(`Config export error: ${e.message}`);
  }
}

async function importPortableConfig() {
  if (!(await asyncConfirm('Import a config? This will overwrite your current equipment settings (but not your sign-in token).'))) return;
  try {
    const result = await api.importPortableConfig();
    if (result.canceled) return;
    if (result.error) { addAlert(`Config import failed: ${result.error}`); return; }
    addAlert('Config imported successfully. Reloading settings...');
    // Reload equipment UI to reflect new settings
    const config = await api.getConfig();
    if (config.name) document.getElementById('church-name').textContent = config.name;
  } catch (e) {
    addAlert(`Config import error: ${e.message}`);
  }
}

function renderStepIndicator() {
  // Legacy — no-op (replaced by onboarding chat progress)
}

function goToStep(n) {
  // Legacy — no-op, replaced by onboarding chat
  if (n === 1 && typeof onWizEncoderTypeChanged === 'function') {
    onWizEncoderTypeChanged();
  }
}

// ─── ONBOARDING CHAT ────────────────────────────────────────────────────────

let _obScanDone = false;

async function initOnboarding() {
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return;
  messagesEl.innerHTML = '';
  _obScanDone = false;

  // Check for resume state — rebuild previous conversation (#8, #9)
  try {
    const state = await api.onboardingState();
    if (state && state.state && state.state !== 'complete' && state.state !== 'intro') {
      // Restore previous messages (#9)
      if (state.messages?.length > 0) {
        for (const msg of state.messages) {
          appendObBubble(msg.role, msg.text);
        }
      }
      updateOnboardingProgress(state.progress);
      // Smart resume message based on collected data (#8)
      const done = state.progress?.completed || [];
      const left = state.progress?.remaining || [];
      const doneStr = done.length > 0 ? done.join(', ') : 'nothing yet';
      const leftStr = left.length > 0 ? left.join(', ') : 'nothing';
      appendObBubble('ai', `Welcome back! You've set up: ${doneStr}. Still need: ${leftStr}. What's next?`);
      renderQuickReplies(left.map(s => {
        const labels = { gear: 'Set up gear', schedule: 'Set service times', tds: 'Add team', stream: 'Configure streaming' };
        return labels[s] || s;
      }).concat(['Skip to dashboard']));
      return;
    }
  } catch (obErr) {
    console.warn('Onboarding state check failed:', obErr);
    const messagesEl2 = document.getElementById('ob-messages');
    if (messagesEl2) {
      appendObBubble('ai', "Couldn't connect to Tally's setup assistant. You can set up your equipment manually in the Equipment tab.");
    }
    return;
  }

  // Scan network FIRST, then greet — fixes race condition (#2)
  scanNetworkForOnboarding().then(() => {
    _obScanDone = true;
  });
  // Show a scan indicator while we wait
  appendObBubble('ai', 'Scanning your network for production gear...');
  const scanTyping = showObTyping();

  // Wait for scan (max 8 seconds, then proceed anyway)
  const scanStart = Date.now();
  while (!_obScanDone && Date.now() - scanStart < 8000) {
    await new Promise(r => setTimeout(r, 200));
  }
  removeObTyping(scanTyping);

  // Remove the "scanning" bubble and replace with real greeting
  const firstBubble = messagesEl.querySelector('.ob-bubble');
  if (firstBubble) firstBubble.remove();

  // Send initial greeting — now with scan results available
  await sendOnboardingMessage('hi');
}

async function scanNetworkForOnboarding() {
  try {
    const results = await api.scanNetwork({});
    _onboardingScanResults = results || {};
  } catch {
    _onboardingScanResults = {};
  }
}

function setObInputEnabled(enabled) {
  const input = document.getElementById('ob-input');
  const btn = document.getElementById('ob-send');
  if (input) { input.disabled = !enabled; input.classList.toggle('ob-disabled', !enabled); }
  if (btn) { btn.disabled = !enabled; btn.classList.toggle('ob-disabled', !enabled); }
}

async function sendOnboardingMessage(msgOverride) {
  if (_onboardingSending) return;
  const input = document.getElementById('ob-input');
  const message = msgOverride || (input?.value || '').trim();
  if (!message) return;

  _onboardingSending = true;
  setObInputEnabled(false); // (#6) visually disable
  if (input && !msgOverride) { input.value = ''; }

  // Clear any existing quick-reply chips
  clearQuickReplies();

  // Show user bubble (except for initial 'hi')
  if (message !== 'hi') {
    appendObBubble('user', message);
  }

  // Show typing indicator
  const typing = showObTyping();

  try {
    // Only send scan results during gear phase (#15)
    const payload = { message };
    if (_onboardingScanResults && Object.keys(_onboardingScanResults).length > 0) {
      payload.scanResults = _onboardingScanResults;
    }

    const result = await api.onboardingChat(payload);

    removeObTyping(typing);

    if (result.error) {
      appendObBubble('ai', 'Sorry, I had trouble processing that. Could you try again?');
      _onboardingSending = false;
      setObInputEnabled(true);
      return;
    }

    // Show AI reply
    appendObBubble('ai', result.reply);

    // Show quick-reply chips (#7)
    if (result.quickReplies?.length > 0) {
      renderQuickReplies(result.quickReplies);
    }

    // Show action cards
    if (result.actions?.length > 0) {
      for (const action of result.actions) {
        renderActionCard(action);
      }
    }

    // Update progress
    if (result.progress) {
      updateOnboardingProgress(result.progress);
    }

    // After gear phase is done, stop sending scan results (#15)
    if (result.progress?.completed?.includes('gear')) {
      _onboardingScanResults = {};
    }

    // Check if onboarding complete
    if (result.state === 'complete' || result.state === 'review') {
      showCompletionControls(); // (#12) show button instead of auto-redirect
    }
  } catch (err) {
    removeObTyping(typing);
    appendObBubble('ai', 'Connection issue. Please check your internet and try again.');
  }

  _onboardingSending = false;
  setObInputEnabled(true);
  // Refocus input for quick typing
  const inp = document.getElementById('ob-input');
  if (inp && !inp.disabled) inp.focus();
}

function appendObBubble(type, text) {
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return;
  const bubble = document.createElement('div');
  bubble.className = `ob-bubble ${type}`;
  bubble.textContent = text;
  messagesEl.appendChild(bubble);
  scrollObToBottom();
}

function showObTyping() {
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return null;
  const typing = document.createElement('div');
  typing.className = 'ob-typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  messagesEl.appendChild(typing);
  scrollObToBottom();
  return typing;
}

function removeObTyping(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function scrollObToBottom() {
  const scroll = document.getElementById('ob-scroll');
  if (scroll) setTimeout(() => { scroll.scrollTop = scroll.scrollHeight; }, 50);
}

// ─── QUICK-REPLY CHIPS (#7) ─────────────────────────────────────────────────

function renderQuickReplies(options) {
  if (!options || options.length === 0) return;
  clearQuickReplies();
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return;
  const container = document.createElement('div');
  container.className = 'ob-quick-replies';
  for (const text of options) {
    const chip = document.createElement('button');
    chip.className = 'ob-chip';
    chip.textContent = text;
    chip.onclick = () => {
      clearQuickReplies();
      if (text === 'Skip to dashboard') {
        skipToManualSetup();
      } else {
        sendOnboardingMessage(text);
      }
    };
    container.appendChild(chip);
  }
  messagesEl.appendChild(container);
  scrollObToBottom();
}

function clearQuickReplies() {
  const existing = document.querySelectorAll('.ob-quick-replies');
  existing.forEach(el => el.remove());
}

// ─── ACTION CARDS ────────────────────────────────────────────────────────────

function renderActionCard(action) {
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return;

  const card = document.createElement('div');
  card.className = 'ob-action-card';

  const title = document.createElement('h4');
  title.textContent = action.confirmLabel || action.type;
  card.appendChild(title);

  if (action.confirmItems?.length > 0) {
    const ul = document.createElement('ul');
    for (const item of action.confirmItems) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }

  const btns = document.createElement('div');
  btns.className = 'ob-action-btns';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'ob-confirm-btn';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.onclick = () => confirmAction(action, card);

  const skipBtn = document.createElement('button');
  skipBtn.className = 'ob-skip-btn';
  skipBtn.textContent = 'Skip';
  skipBtn.onclick = () => {
    card.style.opacity = '0.5';
    card.querySelector('.ob-action-btns').innerHTML = '<span style="color:var(--dim);font-size:11px;">Skipped</span>';
    // Notify the AI that the user skipped (#10)
    sendOnboardingMessage('I want to skip that for now');
  };

  btns.appendChild(confirmBtn);
  btns.appendChild(skipBtn);
  card.appendChild(btns);

  messagesEl.appendChild(card);
  scrollObToBottom();
}

async function confirmAction(action, cardEl) {
  const btnsEl = cardEl.querySelector('.ob-action-btns');
  if (btnsEl) btnsEl.innerHTML = '<span style="color:var(--muted);font-size:11px;">Saving...</span>';

  try {
    const result = await api.onboardingConfirm({ action });
    if (result.ok) {
      if (btnsEl) btnsEl.innerHTML = '<span style="color:var(--green);font-size:11px;">\u2713 Saved</span>';
      cardEl.style.borderColor = 'var(--border)';

      // Write local config for Electron agent (#5)
      if (result.localConfig && Object.keys(result.localConfig).length > 0) {
        api.saveConfig(result.localConfig).catch(() => {});
      }
    } else {
      if (btnsEl) btnsEl.innerHTML = `<span style="color:var(--danger);font-size:11px;">${escapeText(result.message || 'Failed')}</span>`;
    }
  } catch {
    if (btnsEl) btnsEl.innerHTML = '<span style="color:var(--danger);font-size:11px;">Error saving</span>';
  }
}

function updateOnboardingProgress(progress) {
  if (!progress) return;
  const stages = document.querySelectorAll('.ob-stage');
  stages.forEach(el => {
    const stage = el.dataset.stage;
    el.classList.remove('active', 'done');
    if (progress.completed?.includes(stage)) {
      el.classList.add('done');
    } else if (progress.remaining?.[0] === stage) {
      el.classList.add('active');
    }
  });
}

const _OB_STAGE_LABELS = { gear: 'Set up gear', schedule: 'Set service times', tds: 'Add team', stream: 'Configure streaming' };

function jumpToOnboardingStage(stage) {
  if (_onboardingSending) return;
  const label = _OB_STAGE_LABELS[stage];
  if (!label) return;
  sendOnboardingMessage(label);
}

// ─── COMPLETION (#12, #13) ──────────────────────────────────────────────────

function showCompletionControls() {
  const messagesEl = document.getElementById('ob-messages');
  if (!messagesEl) return;

  // Hide input area — they're done chatting
  const inputArea = document.querySelector('.ob-input-area');
  if (inputArea) inputArea.style.display = 'none';

  const card = document.createElement('div');
  card.className = 'ob-action-card';
  card.style.textAlign = 'center';

  const heading = document.createElement('h4');
  heading.textContent = 'SETUP COMPLETE';
  heading.style.marginBottom = '8px';
  card.appendChild(heading);

  const msg = document.createElement('p');
  msg.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:12px;';
  msg.textContent = 'Your system is configured and ready to go. Tally will run in your system tray and connect automatically on startup.';
  card.appendChild(msg);

  // Connection test result area (#13)
  const testResult = document.createElement('div');
  testResult.id = 'ob-test-result';
  testResult.style.cssText = 'font-size:11px;font-family:var(--mono);margin-bottom:12px;color:var(--muted);';
  testResult.textContent = 'Testing connection...';
  card.appendChild(testResult);

  const btn = document.createElement('button');
  btn.className = 'ob-confirm-btn';
  btn.style.cssText = 'width:100%;padding:10px;font-size:14px;border-radius:8px;cursor:pointer;';
  btn.textContent = 'Go to Dashboard \u2192';
  btn.onclick = () => finishOnboarding();
  card.appendChild(btn);

  messagesEl.appendChild(card);
  scrollObToBottom();

  // Run connection test (#13)
  runOnboardingConnectionTest(testResult);
}

async function runOnboardingConnectionTest(el) {
  try {
    const config = await api.getConfig();
    const result = await api.testConnection({ url: config.relay, token: config.token });
    if (result.success) {
      el.innerHTML = '<span style="color:var(--green);">\u25CF Connected to relay server</span>';
    } else {
      el.innerHTML = `<span style="color:var(--warn);">\u26A0 ${escapeText(result.error || 'Could not reach relay')}</span>`;
    }
  } catch {
    el.innerHTML = '<span style="color:var(--dim);">Could not test connection</span>';
  }
}

async function finishOnboarding() {
  await api.saveConfig({ setupComplete: true });
  showDashboard();
  const config = await api.getConfig();
  if (config.name) document.getElementById('church-name').textContent = config.name;
  setAllDotsConnecting();
  try { await api.startAgent(); isRunning = true; } catch {}
  updateToggleBtn();
}

// Keep old name as alias
async function completeOnboarding() {
  showCompletionControls();
}

function skipToManualSetup() {
  api.saveConfig({ setupComplete: true }).then(async () => {
    showDashboard();
    switchTab('equipment');
    setAllDotsConnecting();
    try { await api.startAgent(); isRunning = true; } catch {}
    updateToggleBtn();
  });
}

// Legacy stubs for backward compat
function wizardNext() {}
function wizardBack() {}
function wizardRescan() {}
function onWizEncoderTypeChanged() {}
async function scanForATEM() {}
function wizardAutoScan() {}
function wizardValidateStep() { return true; }

// ─── PRE-SERVICE CHECK HERO ────────────────────────────────────────────────

let _preServiceData = null;

async function loadPreServiceCheck() {
  try {
    const data = await api.getPreServiceCheck();
    if (data && data.checks_json) {
      _preServiceData = data;
      renderPreServicePanel(data);
    } else {
      // No check data yet — hide the panel
      const panel = document.getElementById('preservice-panel');
      if (panel) panel.style.display = 'none';
    }
  } catch (e) {
    console.warn('Pre-service check load failed:', e);
  }
}

function renderPreServicePanel(data) {
  const panel = document.getElementById('preservice-panel');
  if (!panel) return;

  let checks;
  try {
    checks = typeof data.checks_json === 'string' ? JSON.parse(data.checks_json) : data.checks_json;
  } catch {
    panel.style.display = 'none';
    return;
  }

  if (!Array.isArray(checks) || checks.length === 0) {
    panel.style.display = 'none';
    return;
  }

  const failures = checks.filter(c => c.status === 'fail');
  const warnings = checks.filter(c => c.status === 'warn');
  const passes = checks.filter(c => c.status === 'pass');
  const fixable = checks.filter(c => c.status === 'fail' && c.fixable);

  // Determine hero state
  const allPass = failures.length === 0 && warnings.length === 0;
  const hasFailures = failures.length > 0;

  panel.classList.remove('pass', 'fail', 'warn');
  panel.classList.add(allPass ? 'pass' : hasFailures ? 'fail' : 'warn');
  panel.style.display = '';

  // Badge
  const icon = document.getElementById('preservice-icon');
  const title = document.getElementById('preservice-title');
  if (allPass) {
    icon.textContent = '\u2705';
    title.textContent = 'All Systems Go';
  } else {
    const issueCount = failures.length + warnings.length;
    icon.textContent = hasFailures ? '\u26A0\uFE0F' : '\u26A0\uFE0F';
    title.textContent = `${issueCount} Issue${issueCount !== 1 ? 's' : ''} Found`;
  }

  // Meta (timestamp)
  const meta = document.getElementById('preservice-meta');
  if (data.created_at) {
    const d = new Date(data.created_at);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 1) meta.textContent = 'Just now';
    else if (diffMin < 60) meta.textContent = `${diffMin}m ago`;
    else if (diffMin < 1440) meta.textContent = `${Math.round(diffMin / 60)}h ago`;
    else meta.textContent = d.toLocaleDateString();
  } else {
    meta.textContent = '';
  }

  // Checklist rows
  const container = document.getElementById('preservice-checks');
  container.innerHTML = '';

  // Show failures first, then warnings, then passes
  const sorted = [...failures, ...warnings, ...passes];
  for (const check of sorted) {
    const status = check.status || 'skip';
    const row = document.createElement('div');
    row.className = `preservice-check-row ${status}`;
    row.innerHTML = `<div class="check-dot ${status}"></div>`
      + `<span class="check-name">${escapeText(check.name || check.type || 'Check')}</span>`
      + `<span class="check-detail">${escapeText(check.detail || check.message || '')}</span>`;
    container.appendChild(row);
  }

  // Fix All button visibility
  const fixBtn = document.getElementById('preservice-fix-btn');
  if (fixBtn) {
    fixBtn.style.display = fixable.length > 0 ? '' : 'none';
    fixBtn.textContent = `Fix All (${fixable.length})`;
    fixBtn.disabled = false;
  }

  // Run button reset
  const runBtn = document.getElementById('preservice-run-btn');
  if (runBtn) { runBtn.disabled = false; runBtn.textContent = 'Run Check Now'; }
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

async function runPreServiceCheck() {
  const btn = document.getElementById('preservice-run-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Running\u2026'; }
  try {
    const result = await api.runPreServiceCheck();
    if (result && result.error) {
      console.warn('Pre-service check run error:', result.error);
      if (btn) { btn.textContent = 'Check failed \u2014 try again'; }
    } else {
      if (btn) { btn.textContent = '\u2713 Check complete'; }
    }
    // Reload panel after a short delay (check runs async on server)
    try {
      await new Promise(r => setTimeout(r, 2000));
      await loadPreServiceCheck();
    } catch (reloadErr) {
      console.warn('Pre-service reload failed:', reloadErr);
    }
  } catch (e) {
    console.warn('Pre-service check run failed:', e);
    if (btn) { btn.textContent = 'Check failed \u2014 try again'; }
  } finally {
    if (btn) { btn.disabled = false; }
    // Reset button text after brief feedback
    setTimeout(() => { if (btn) btn.textContent = 'Run Check Now'; }, 3000);
  }
}

async function fixAllPreService() {
  const btn = document.getElementById('preservice-fix-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }

  // Show progress modal (P2 item 13)
  const modal = document.getElementById('fix-all-modal');
  const modalLog = document.getElementById('fix-all-modal-log');
  if (modal) {
    modal.style.display = 'flex';
    modal.style.pointerEvents = '';
    modal.setAttribute('aria-modal', 'true');
    if (modalLog) modalLog.innerHTML = '<div style="color:var(--muted)">Running fixes…</div>';
  }

  try {
    const result = await api.fixAllPreService();
    if (result && result.results) {
      const fixed = result.results.filter(r => r.success).length;
      const failed = result.results.length - fixed;
      if (btn) btn.textContent = failed > 0 ? `${fixed} fixed, ${failed} failed` : `${fixed} fixed`;
      // Populate modal with per-fix results
      if (modalLog) {
        modalLog.innerHTML = result.results.map(r => {
          const icon = r.success ? '✓' : '✗';
          const color = r.success ? 'var(--green)' : 'var(--danger)';
          return `<div style="padding:4px 0; color:${color}; font-size:12px; font-family:var(--mono);">${icon} ${escapeText(r.label || r.check || '?')}: ${escapeText(r.message || (r.success ? 'Fixed' : 'Failed'))}</div>`;
        }).join('');
        const summary = document.createElement('div');
        summary.style.cssText = 'margin-top:10px; font-size:12px; color:var(--muted);';
        summary.textContent = `${fixed} of ${result.results.length} fix${result.results.length !== 1 ? 'es' : ''} applied.`;
        modalLog.appendChild(summary);
      }
    } else if (result && result.error) {
      if (modalLog) modalLog.innerHTML = `<div style="color:var(--danger); font-family:var(--mono); font-size:12px;">Error: ${escapeText(result.error)}</div>`;
    }
    // Reload panel after fixes
    setTimeout(() => loadPreServiceCheck(), 3000);
  } catch (e) {
    console.warn('Pre-service fix-all failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Fix All'; }
    if (modalLog) modalLog.innerHTML = `<div style="color:var(--danger); font-family:var(--mono); font-size:12px;">Error: ${escapeText(e.message)}</div>`;
  }
}

function closeFixAllModal() {
  const modal = document.getElementById('fix-all-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.style.pointerEvents = 'none';
    modal.removeAttribute('aria-modal');
  }
}

// ─── RUNDOWN PANEL ─────────────────────────────────────────────────────────

let _rundownData = null;

async function loadRundownPanel() {
  try {
    const data = await api.getActiveRundown();
    _rundownData = data;
    renderRundownPanel(data);
  } catch (e) {
    console.warn('Rundown load failed:', e);
  }
}

// Step type icon lookup for rundown
const RUNDOWN_STEP_ICONS = {
  camera: '[cam]',
  'camera-switch': '[cam]',
  'camera_switch': '[cam]',
  audio: '[aud]',
  'audio-cue': '[aud]',
  'audio_cue': '[aud]',
  graphics: '[gfx]',
  graphic: '[gfx]',
  lower_third: '[gfx]',
  'lower-third': '[gfx]',
  video: '[vid]',
  playback: '[play]',
  music: '[mus]',
  lighting: '[light]',
  light: '[light]',
  transition: '[fx]',
  prayer: '[pry]',
  sermon: '[srv]',
  worship: '[wsp]',
  announcement: '[ann]',
  offering: '[$]',
  scripture: '[scr]',
  baptism: '[bpt]',
  communion: '[com]',
  welcome: '[hi]',
  stream: '[str]',
  recording: '[rec]',
  default: '▪',
};

function getRundownStepIcon(step) {
  if (!step) return RUNDOWN_STEP_ICONS.default;
  const type = (step.type || step.action || '').toLowerCase().replace(/\s+/g, '-');
  return RUNDOWN_STEP_ICONS[type] || RUNDOWN_STEP_ICONS.default;
}

function renderRundownPanel(data) {
  const panel = document.getElementById('rundown-panel');
  if (!panel) return;

  if (!data || !data.active) {
    panel.style.display = '';
    document.getElementById('rundown-inactive').style.display = '';
    document.getElementById('rundown-active').style.display = 'none';
    return;
  }

  panel.style.display = '';
  document.getElementById('rundown-inactive').style.display = 'none';
  document.getElementById('rundown-active').style.display = '';

  const steps = data.rundown?.steps || [];
  const currentIdx = data.currentStep || 0;
  const currentStep = steps[currentIdx] || null;
  const nextStep = steps[currentIdx + 1] || null;

  // Progress text
  const progressEl = document.getElementById('rundown-progress');
  if (progressEl) {
    progressEl.textContent = `${escapeText(data.rundownName || data.rundown?.name || 'Rundown')} \u2014 Step ${currentIdx + 1} of ${steps.length}`;
  }

  // Visual progress indicator (pip dots)
  const indicatorEl = document.getElementById('rundown-progress-indicator');
  if (indicatorEl) {
    indicatorEl.innerHTML = steps.map((_, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      return `<div class="rundown-pip ${cls}"></div>`;
    }).join('');
  }

  // Current step card with icon
  const currentEl = document.getElementById('rundown-current-step');
  if (currentEl && currentStep) {
    const icon = getRundownStepIcon(currentStep);
    currentEl.innerHTML = `<div class="step-label">${icon} ${escapeText(currentStep.label || 'Step ' + (currentIdx + 1))}</div>`
      + (currentStep.notes ? `<div class="step-notes">${escapeText(currentStep.notes)}</div>` : '');
  }

  // Next up preview
  const nextEl = document.getElementById('rundown-next');
  if (nextEl) {
    if (nextStep) {
      const nextIcon = getRundownStepIcon(nextStep);
      nextEl.textContent = `Next: ${nextIcon} ${nextStep.label || 'Step ' + (currentIdx + 2)}`;
    } else {
      nextEl.textContent = 'Last step';
    }
  }

  // Disable advance on last step
  const advBtn = document.getElementById('rundown-advance-btn');
  if (advBtn) advBtn.disabled = currentIdx >= steps.length - 1;

  // Steps list with icons, click-to-jump, and checked state
  const listEl = document.getElementById('rundown-steps-list');
  if (listEl) {
    listEl.innerHTML = steps.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      const icon = getRundownStepIcon(s);
      const checkMark = i < currentIdx ? '<span class="rundown-step-check">\u2713</span>' : '';
      return `<div class="rundown-step-item ${cls}" onclick="jumpToRundownStep(${i})" title="Jump to step ${i + 1}">
        <span class="rundown-step-icon">${icon}</span>
        <span class="rundown-step-label">${escapeText(s.label || 'Step ' + (i + 1))}</span>
        ${checkMark}
      </div>`;
    }).join('');
  }
}

async function jumpToRundownStep(idx) {
  try {
    if (api.jumpToRundownStep) {
      await api.jumpToRundownStep(idx);
    } else {
      // Fallback: advance step by step
      await api.advanceRundownStep();
    }
    loadRundownPanel();
  } catch (e) {
    console.warn('Jump to rundown step failed:', e);
  }
}

async function executeRundownStep() {
  const btn = document.getElementById('rundown-exec-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Executing\u2026'; }
  try {
    const result = await api.executeRundownStep();
    if (result.error) console.warn('Execute step error:', result.error);
    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Execute'; }
      loadRundownPanel();
    }, 1000);
  } catch (e) {
    console.warn('Execute step failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Execute'; }
  }
}

async function advanceRundownStep() {
  const btn = document.getElementById('rundown-advance-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Advancing\u2026'; }
  try {
    await api.advanceRundownStep();
    loadRundownPanel();
  } catch (e) {
    console.warn('Advance step failed:', e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Next Step'; }
  }
}

async function endRundown() {
  if (!(await asyncConfirm('End this rundown? This cannot be undone.'))) return;
  try {
    await api.deactivateRundown();
    loadRundownPanel();
  } catch (e) {
    console.warn('Deactivate rundown failed:', e);
  }
}

// ─── QUICK SYSTEM CHECK ───────────────────────────────────────────────────
async function runQuickSystemCheck() {
  const btn = document.getElementById('btn-system-check');
  const result = document.getElementById('system-check-result');
  if (btn) { btn.disabled = true; btn.textContent = 'Checking...'; }
  if (result) result.textContent = '';
  try {
    const api = window.electronAPI;
    if (!api?.pfAnalyze) { if (result) result.textContent = 'Not available'; return; }
    const report = await api.pfAnalyze();
    const issues = (report?.report?.diagnostics?.issues || []).filter(i => i.id !== 'no_issues_detected');
    if (issues.length === 0) {
      if (result) { result.textContent = 'All clear'; result.style.color = 'var(--green)'; }
    } else {
      if (result) {
        result.innerHTML = `<span style="color:var(--warn);">${issues.length} issue${issues.length !== 1 ? 's' : ''} found</span> <a href="#" onclick="switchTab('engineer'); return false;" style="color:var(--green); margin-left:6px;">View in Tally Engineer</a>`;
      }
    }
  } catch {
    if (result) { result.textContent = 'Check failed'; result.style.color = 'var(--red, #f44)'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Run System Check'; }
  }
}

// ─── CLEAR ACTIVE ISSUES ──────────────────────────────────────────────────
function clearActiveIssues() {
  const el = document.getElementById('pf-issues-list');
  if (el) el.innerHTML = '<p style="color:var(--green); font-size:12px;">All systems go — issues marked as fixed.</p>';
  const clearBtn = document.getElementById('btn-clear-issues');
  if (clearBtn) clearBtn.style.display = 'none';
  // Clear the issue badge on the Status tab
  if (typeof _pfAutoRunIssueCount !== 'undefined') _pfAutoRunIssueCount = 0;
  if (typeof updatePfBadge === 'function') updatePfBadge();
  // Update Go/No-Go badge to GO
  if (typeof renderPfGoStatus === 'function') {
    renderPfGoStatus({ status: 'GO', triggerType: 'manual', decisionAt: new Date().toISOString(), notes: 'Issues marked as fixed by operator' });
  }
  // Update KPIs to zero
  const critEl = document.getElementById('pf-critical-count');
  if (critEl) { critEl.textContent = '0'; critEl.style.color = 'var(--green)'; }
  const issueEl = document.getElementById('pf-issue-count');
  if (issueEl) issueEl.textContent = '0';
}

// ─── ATEM RECORDING CONTROLS ──────────────────────────────────────────────
async function atemRecordStart() {
  const btn = document.getElementById('btn-atem-rec-start');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }
  try { await api.sendCommand('atem.startRecording'); }
  catch { /* ignore */ }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Start'; } }
}
async function atemRecordStop() {
  const btn = document.getElementById('btn-atem-rec-stop');
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping...'; }
  try { await api.sendCommand('atem.stopRecording'); }
  catch { /* ignore */ }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Stop'; } }
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────────

function updateStatusUI(status) {
  // ── Cache status for offline mode ─────────────────────────────────────
  const relayOk = getStatusActive(status.relay);
  if (relayOk) {
    _hasReceivedRelayStatus = true;
    const wasOffline = !!_relayDisconnectedAt;
    _cachedStatus = JSON.parse(JSON.stringify(status));
    _cachedStatusTime = new Date();
    _relayDisconnectedAt = null;
    _reconnectAttempt = 0;
    clearReconnectCountdown();
    document.getElementById('dashboard')?.classList.remove('dashboard-stale');
    // Flush any queued offline actions on reconnect
    if (wasOffline) flushOfflineQueue();
  } else if (!relayOk && _cachedStatus && !_relayDisconnectedAt) {
    // Relay just went offline — start tracking
    _relayDisconnectedAt = new Date();
    _reconnectAttempt++;
    startReconnectCountdown();
    document.getElementById('dashboard')?.classList.add('dashboard-stale');
  }

  setDot('relay', status.relay);

  // Only show ATEM chip if configured (null = not configured)
  const atemChip = document.getElementById('dot-atem')?.closest('.status-chip');
  if (atemChip) {
    if (status.atem === null) {
      atemChip.style.display = 'none';
    } else {
      atemChip.style.display = '';
      setDot('atem', status.atem);
    }
  } else {
    setDot('atem', status.atem);
  }

  // Only show companion chip if configured (null = not configured)
  const companionChip = document.getElementById('dot-companion')?.closest('.status-chip');
  if (companionChip) {
    if (status.companion === undefined || status.companion === null) {
      companionChip.style.display = 'none';
    } else {
      companionChip.style.display = '';
      setDot('companion', status.companion);
    }
  }

  // Only show Resolume chip if configured (null = not configured)
  const resolumeChip = document.getElementById('dot-resolume-chip');
  if (resolumeChip) {
    if (!status.resolume) {
      resolumeChip.style.display = 'none';
    } else {
      resolumeChip.style.display = '';
      setDot('resolume', status.resolume);
    }
  }

  // Only show ProPresenter chip if configured (null = not configured)
  const ppChip = document.getElementById('dot-propresenter-chip');
  if (ppChip) {
    if (!status.proPresenter) {
      ppChip.style.display = 'none';
    } else {
      ppChip.style.display = '';
      setDot('propresenter', status.proPresenter);
    }
  }

  // ── Offline / disconnection banner ──────────────────────────────────────
  const offlineBanner = document.getElementById('offline-banner');
  const offlineBannerText = document.getElementById('offline-banner-text');
  const offlineBannerStale = document.getElementById('offline-banner-stale');
  if (offlineBanner) {
    if (!relayOk && !navigator.onLine) {
      if (offlineBannerText) offlineBannerText.textContent = 'No internet -- check your Wi-Fi or network cable';
      offlineBanner.style.display = '';
      if (offlineBannerStale && _cachedStatusTime) {
        const agoText = formatTimeAgo(_cachedStatusTime);
        offlineBannerStale.textContent = `Showing cached data. Last update: ${agoText}`;
        offlineBannerStale.style.display = '';
      }
    } else if (!relayOk) {
      if (offlineBannerText) offlineBannerText.textContent = friendlyError('WebSocket error');
      offlineBanner.style.display = '';
      if (offlineBannerStale && _cachedStatusTime) {
        const agoText = formatTimeAgo(_cachedStatusTime);
        offlineBannerStale.textContent = `Showing cached data. Last update: ${agoText}`;
        offlineBannerStale.style.display = '';
      }
    } else {
      offlineBanner.style.display = 'none';
      if (offlineBannerStale) offlineBannerStale.style.display = 'none';
    }
  }

  // ── Dynamic encoder dot + label ─────────────────────────────────────────
  const encoderLabel = status.encoderType || 'Encoder';
  const encoderLabelEl = document.getElementById('dot-encoder-label');
  if (encoderLabelEl) encoderLabelEl.textContent = encoderLabel;

  const encoderTitleEl = document.getElementById('encoder-section-title');
  if (encoderTitleEl) encoderTitleEl.textContent = encoderLabel;

  // Encoder dot: use encoder status if managed, fallback to OBS — hide if not configured
  const encoderChip = document.getElementById('dot-encoder')?.closest('.status-chip');
  const encoderConnected = getStatusActive(status.encoder) || getStatusActive(status.obs);
  if (encoderChip) {
    if (status.encoder === null || (status.encoder === undefined && status.obs === undefined && !status.encoderType)) {
      encoderChip.style.display = 'none';
    } else {
      encoderChip.style.display = '';
      setDot('encoder', encoderConnected);
    }
  }

  const atemConnected = getStatusActive(status.atem);
  const companionConnected = getStatusActive(status.companion);
  const relayConnected = getStatusActive(status.relay);

  const obsData = status.obs && typeof status.obs === 'object' ? status.obs : {};
  const atemData = status.atem && typeof status.atem === 'object' ? status.atem : {};
  const encoderData = status.encoder && typeof status.encoder === 'object' ? status.encoder : {};
  const streaming = status.streaming ?? encoderData.live ?? encoderData.streaming ?? obsData.streaming;
  const fps = status.fps ?? encoderData.fps ?? obsData.fps;
  const bitrate = status.bitrate ?? encoderData.bitrateKbps ?? obsData.bitrate ?? null;

  // Keep rolling history for the sparkline graph
  _pushBitrateHistory(bitrate, streaming);

  const liveBadge = document.getElementById('live-badge');
  liveBadge.classList.toggle('active', streaming === true);

  if (atemData.model) {
    setStatusValue('val-atem-model', atemData.model, atemConnected);
  } else if (atemConnected) {
    setStatusValue('val-atem-model', 'Detecting...', null);
  } else {
    setStatusValue('val-atem-model', '—', false);
  }

  // ── ATEM program/preview input display ──────────────────────────────────
  const inputLabels = atemData.inputLabels || {};
  if (atemData.programInput !== null && atemData.programInput !== undefined) {
    setStatusValue('val-program', getInputName(atemData.programInput, inputLabels), true);
  } else {
    setStatusValue('val-program', atemConnected ? 'Detecting...' : '—', false);
  }

  if (atemData.previewInput !== null && atemData.previewInput !== undefined) {
    setStatusValue('val-preview', getInputName(atemData.previewInput, inputLabels), true);
  } else {
    setStatusValue('val-preview', atemConnected ? 'Detecting...' : '—', false);
  }

  // ATEM recording status
  const recDetail = document.getElementById('atem-rec-detail');
  if (atemData.recording !== undefined) {
    const isRec = atemData.recording === true;
    setStatusValue('val-recording', isRec ? '● Recording' : 'Stopped', isRec);
    if (recDetail) {
      const parts = [];
      if (isRec && atemData.recordingDuration) {
        const d = atemData.recordingDuration;
        parts.push(`${d.hours || 0}h ${d.minutes || 0}m ${d.seconds || 0}s`);
      }
      if (atemData.recordingTimeAvailable > 0) {
        const mins = Math.floor(atemData.recordingTimeAvailable / 60);
        const hrs = Math.floor(mins / 60);
        parts.push(`${hrs}h ${mins % 60}m remaining`);
      }
      if (atemData.recordingError && atemData.recordingError !== 2) {
        const errMap = { 0: 'No Media', 1: 'No Media', 4: 'Media Full', 8: 'Disk Error' };
        parts.push(`Error: ${errMap[atemData.recordingError] || 'Unknown'}`);
      }
      recDetail.textContent = parts.join(' · ');
      recDetail.style.display = parts.length > 0 ? 'block' : 'none';
    }
  } else if (!atemConnected) {
    setStatusValue('val-recording', '—', false);
    if (recDetail) recDetail.style.display = 'none';
  }

  if (typeof companionConnected === 'boolean') {
    setStatusValue('val-companion', companionConnected ? 'Connected' : 'Disconnected', companionConnected);
  } else if (!relayConnected) {
    setStatusValue('val-companion', '—', false);
  }

  // ── Streaming encoder status cards (Stream Health Indicator) ────────────
  if (typeof streaming === 'boolean' && streaming) {
    // Color-coded stream health based on bitrate
    const br = typeof bitrate === 'number' ? bitrate : 0;
    const brMbps = br / 1000;
    let healthLabel, healthClass;
    if (br >= 4000) { healthLabel = 'Excellent'; healthClass = 'excellent'; }
    else if (br >= 2000) { healthLabel = 'Fair'; healthClass = 'fair'; }
    else if (br > 0) { healthLabel = 'Poor'; healthClass = 'poor'; }
    else { healthLabel = 'LIVE'; healthClass = 'excellent'; }
    const brDisplay = br > 0 ? ` ${brMbps.toFixed(1)} Mbps` : '';
    const streamEl = document.getElementById('val-stream');
    if (streamEl) {
      streamEl.innerHTML = `<span class="stream-health-dot ${healthClass}"></span>${healthLabel}${brDisplay}`;
      streamEl.classList.toggle('active', true);
      streamEl.classList.toggle('muted', false);
    }
  } else if (encoderConnected) {
    setStatusValue('val-stream', 'Standby', null);
  } else {
    setStatusValue('val-stream', '—', false);
  }

  if (typeof fps === 'number' && Number.isFinite(fps)) {
    const fpsValue = Math.round(fps);
    const fpsHealthy = fpsValue >= 24;
    setStatusValue('val-fps', String(fpsValue), fpsHealthy);
  } else if (encoderConnected) {
    setStatusValue('val-fps', 'Idle', null);
  } else {
    setStatusValue('val-fps', '—', false);
  }

  // Bitrate card — shows current value + sparkline history graph while streaming
  {
    const brEl = document.getElementById('val-bitrate');
    if (brEl) {
      if (typeof bitrate === 'number' && bitrate > 0) {
        const brText = bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)} Mbps` : `${bitrate} Kbps`;
        const spark = _renderBitrateSparkline();
        brEl.innerHTML = spark
          ? `<span style="display:flex;align-items:center;gap:0;">${_renderBitrateSparkline()}<span>${brText}</span></span>`
          : brText;
        brEl.classList.add('active');
        brEl.classList.remove('muted');
      } else if (encoderConnected) {
        brEl.textContent = 'Idle';
        brEl.classList.remove('active', 'muted');
      } else {
        brEl.textContent = '—';
        brEl.classList.remove('active');
        brEl.classList.add('muted');
      }
    }
  }

  // CDN verification status
  const cdnEl = document.getElementById('cdn-verify-status');
  if (cdnEl) {
    const sv = status.streamVerification;
    if (sv && (sv.youtube || sv.facebook)) {
      const parts = [];
      if (sv.youtube?.checked) {
        parts.push(sv.youtube.live
          ? `<span style="color:var(--green);">YouTube: LIVE${sv.youtube.viewerCount ? ` (${sv.youtube.viewerCount} viewers)` : ''}</span>`
          : '<span style="color:var(--red, #f44);">YouTube: NOT receiving</span>');
      }
      if (sv.facebook?.checked) {
        parts.push(sv.facebook.live
          ? `<span style="color:var(--green);">Facebook: LIVE${sv.facebook.viewerCount ? ` (${sv.facebook.viewerCount} viewers)` : ''}</span>`
          : '<span style="color:var(--red, #f44);">Facebook: NOT receiving</span>');
      }
      if (parts.length) {
        const allLive = (!sv.youtube?.checked || sv.youtube.live) && (!sv.facebook?.checked || sv.facebook.live);
        cdnEl.innerHTML = parts.join(' &middot; ');
        cdnEl.style.display = '';
        cdnEl.style.background = allLive ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
        cdnEl.style.border = `1px solid ${allLive ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`;
      } else {
        cdnEl.style.display = 'none';
      }
    } else if (!streaming) {
      cdnEl.style.display = 'none';
    }
  }

  // Audio status card
  const audio = status.audio || {};
  const mixerData = status.mixer && typeof status.mixer === 'object' ? status.mixer : {};
  const mixerConnected = mixerData.connected || false;
  if (audio.masterMuted || mixerData.mainMuted) {
    setStatusValue('val-audio', 'MUTED', false);
  } else if (audio.silenceDetected) {
    setStatusValue('val-audio', 'Silence', false);
  } else if (mixerConnected || _audioViaAtem) {
    const atemSources = atemData.atemAudioSources || [];
    const portLabel = atemSources.length > 0 ? ` (${atemSources[0].portType})` : '';
    setStatusValue('val-audio', streaming ? `● OK${portLabel}` : 'Standby', streaming ? true : null);
  } else if (encoderConnected || atemConnected) {
    setStatusValue('val-audio', '—', false);
  } else {
    setStatusValue('val-audio', '—', false);
  }

  // ── ATEM audio delay warning ─────────────────────────────────────────────
  const delayEl = document.getElementById('val-audio-delay');
  const audioDelays = atemData.audioDelays || {};
  const progInput = atemData.programInput;
  if (delayEl) {
    const progDelay = progInput !== null && progInput !== undefined
      ? (audioDelays[progInput] ?? audioDelays[String(progInput)] ?? 0)
      : 0;
    if (progDelay && progDelay !== 0) {
      delayEl.style.display = 'block';
      delayEl.textContent = `Cam ${progInput}: ${progDelay}ms audio delay`;
    } else {
      delayEl.style.display = 'none';
    }
  }

  const encoderIdentity = (status.encoder && typeof status.encoder === 'object' && status.encoder.details)
    ? String(status.encoder.details)
    : '';
  if (encoderIdentity) setStatusValue('val-id-encoder', encoderIdentity, encoderConnected);
  else if (encoderConnected) setStatusValue('val-id-encoder', encoderLabel || 'Connected', true);
  else setStatusValue('val-id-encoder', '—', false);

  const ppIdentity = (status.proPresenter && typeof status.proPresenter === 'object' && status.proPresenter.version)
    ? `ProPresenter ${status.proPresenter.version}`
    : '';
  if (ppIdentity) setStatusValue('val-id-propresenter', ppIdentity, getStatusActive(status.proPresenter));
  else setStatusValue('val-id-propresenter', '—', false);

  // ProPresenter detail section
  updateProPresenterSection(status.proPresenter);

  const vmixData = status.vmix && typeof status.vmix === 'object' ? status.vmix : {};
  const vmixIdentity = vmixData.edition ? `${vmixData.edition}${vmixData.version ? ` ${vmixData.version}` : ''}` : '';
  if (vmixIdentity) setStatusValue('val-id-vmix', vmixIdentity, getStatusActive(vmixData));
  else setStatusValue('val-id-vmix', '—', false);

  const resolumeData = status.resolume && typeof status.resolume === 'object' ? status.resolume : {};
  const resolumeIdentity = resolumeData.version
    ? String(resolumeData.version)
    : (resolumeData.host ? `${resolumeData.host}:${resolumeData.port || 8080}` : '');
  if (resolumeIdentity) setStatusValue('val-id-resolume', resolumeIdentity, getStatusActive(resolumeData));
  else setStatusValue('val-id-resolume', '—', false);

  const mixerData2 = status.mixer && typeof status.mixer === 'object' ? status.mixer : {};
  const mixerIdentity = mixerData2.model
    ? `${String(mixerData2.type || 'Mixer').toUpperCase()} ${mixerData2.model}`
    : '';
  if (mixerIdentity) setStatusValue('val-id-mixer', mixerIdentity, getStatusActive(mixerData2));
  else setStatusValue('val-id-mixer', '—', false);

  const companionData = status.companion && typeof status.companion === 'object' ? status.companion : {};
  const companionIdentity = companionData.endpoint ? String(companionData.endpoint) : '';
  if (companionIdentity) setStatusValue('val-id-companion', companionIdentity, getStatusActive(companionData));
  else setStatusValue('val-id-companion', '—', false);

  // Signal Failover status
  if (status.failover) updateFailoverUI(status.failover);
}

// ─── SIGNAL FAILOVER UI ──────────────────────────────────────────────────────

const FAILOVER_STATE_LABELS = {
  HEALTHY: 'Healthy',
  SUSPECTED_BLACK: 'Suspected',
  CONFIRMED_OUTAGE: 'Confirmed Outage',
  FAILOVER_ACTIVE: 'Failover Active',
  ATEM_LOST: 'ATEM Lost',
};

const FAILOVER_STATE_CSS = {
  HEALTHY: '',
  SUSPECTED_BLACK: 'suspected',
  CONFIRMED_OUTAGE: 'confirmed',
  FAILOVER_ACTIVE: 'active-failover',
  ATEM_LOST: 'atem-lost',
};

const FAILOVER_STATE_DOT = {
  HEALTHY: 'green',
  SUSPECTED_BLACK: 'yellow',
  CONFIRMED_OUTAGE: 'red',
  FAILOVER_ACTIVE: 'yellow',
  ATEM_LOST: 'red',
};

function updateProPresenterSection(pp) {
  const section = document.getElementById('section-propresenter');
  if (!section) return;
  if (!pp || (!pp.connected && !pp.running)) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  setStatusValue('val-pp-presentation', pp.currentSlide || '—', pp.connected);
  setStatusValue('val-pp-slide', pp.slideIndex != null ? `${pp.slideIndex + 1} / ${pp.slideTotal}` : '—', pp.connected);
  setStatusValue('val-pp-look', pp.activeLook?.name || '—', !!pp.activeLook);

  // Timers: show name + countdown for running timers
  const timerText = (pp.timers || [])
    .filter(t => t.state === 'Running' || t.state === 'Overrun')
    .map(t => `${t.name}: ${t.time}${t.state === 'Overrun' ? ' (OVERRUN)' : ''}`)
    .join('\n') || 'None running';
  setStatusValue('val-pp-timers', timerText, (pp.timers || []).some(t => t.state === 'Running'));

  setStatusValue('val-pp-screen', pp.screens?.audience ? 'ON' : 'OFF', pp.screens?.audience);

  const notes = pp.slideNotes || '—';
  setStatusValue('val-pp-notes', notes.length > 300 ? notes.substring(0, 300) + '...' : notes, !!pp.slideNotes);
}

function updateFailoverUI(fo) {
  const section = document.getElementById('failover-status-section');
  const chip = document.getElementById('failover-chip');
  if (!section || !chip) return;

  // Show section and chip
  section.style.display = '';
  chip.style.display = '';

  const state = fo.state || 'HEALTHY';
  const isHealthy = state === 'HEALTHY';

  // Status bar chip
  const dotEl = document.getElementById('dot-failover');
  if (dotEl) dotEl.className = `dot ${FAILOVER_STATE_DOT[state] || ''}`;
  chip.classList.remove('active', 'ok', 'warn', 'err');
  if (state === 'HEALTHY') chip.classList.add('active', 'ok');
  else if (state === 'SUSPECTED_BLACK') chip.classList.add('warn');
  else chip.classList.add('err');

  // State badge
  const badge = document.getElementById('failover-state-badge');
  if (badge) {
    badge.textContent = FAILOVER_STATE_LABELS[state] || state;
    badge.className = `failover-state-badge ${FAILOVER_STATE_CSS[state] || ''}`;
  }

  // Info cards
  setStatusValue('val-failover-state', FAILOVER_STATE_LABELS[state] || state, isHealthy);
  setStatusValue('val-failover-auto-recover', fo.autoRecover ? 'On' : 'Off', fo.autoRecover);

  // Safe source
  if (fo.safeSource) {
    setStatusValue('val-failover-safe-source', `Input ${fo.safeSource}`, true);
  } else {
    setStatusValue('val-failover-safe-source', '—', false);
  }

  // Outage duration
  if (fo.outageStartedAt && !isHealthy) {
    const elapsed = Math.round((Date.now() - new Date(fo.outageStartedAt).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    setStatusValue('val-failover-outage-duration', mins > 0 ? `${mins}m ${secs}s` : `${secs}s`, false);
  } else {
    setStatusValue('val-failover-outage-duration', '—', true);
  }

  // Diagnosis card
  const diagEl = document.getElementById('failover-diagnosis');
  if (diagEl) {
    if (fo.diagnosisMessage && !isHealthy) {
      diagEl.textContent = fo.diagnosisMessage;
      diagEl.className = `failover-diagnosis ${state === 'SUSPECTED_BLACK' ? 'warn' : ''}`;
      diagEl.style.display = '';
    } else {
      diagEl.style.display = 'none';
    }
  }

  // Countdown
  const countdownEl = document.getElementById('failover-countdown');
  if (countdownEl) {
    if (state === 'CONFIRMED_OUTAGE') {
      countdownEl.style.display = '';
      countdownEl.textContent = 'Waiting for TD acknowledgment before auto-switch...';
    } else {
      countdownEl.style.display = 'none';
    }
  }

  // Timeline (last 5 transitions)
  const timelineEl = document.getElementById('failover-timeline');
  if (timelineEl && fo.transitions && fo.transitions.length > 0) {
    timelineEl.innerHTML = fo.transitions.map(t => {
      const time = new Date(t.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dotColor = FAILOVER_STATE_DOT[t.to] || '';
      return `<div class="failover-timeline-entry">
        <div class="failover-timeline-dot ${dotColor}"></div>
        <span>${escapeHtml(time)}</span>
        <span style="color:var(--muted);">${escapeHtml(FAILOVER_STATE_LABELS[t.from] || t.from)} \u2192 ${escapeHtml(FAILOVER_STATE_LABELS[t.to] || t.to)}</span>
        <span style="color:var(--dim);">(${escapeHtml(t.trigger)})</span>
      </div>`;
    }).join('');
  } else if (timelineEl) {
    timelineEl.innerHTML = '';
  }
}

// ─── FAILOVER EQUIPMENT CONFIG ──────────────────────────────────────────────

let _failoverConfigLoaded = false;
let _failoverSources = { atem: [], videohub: [], obs: [] };

async function loadFailoverSources(selectedValue) {
  if (!api.getFailoverSources) return;
  try {
    _failoverSources = await api.getFailoverSources();
  } catch {
    _failoverSources = { atem: [], videohub: [], obs: [] };
  }
  populateFailoverSourceDropdown(selectedValue);
}

function populateFailoverSourceDropdown(selectedValue) {
  const select = document.getElementById('failover-safe-input');
  if (!select) return;
  const actionType = document.getElementById('failover-action-type')?.value || 'atem_switch';
  select.innerHTML = '';

  if (actionType === 'atem_switch') {
    const sources = _failoverSources.atem || [];
    if (sources.length === 0) {
      select.innerHTML = '<option value="">No ATEM inputs found</option>';
    } else {
      for (const src of sources) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = `${src.id}: ${src.name}`;
        select.appendChild(opt);
      }
    }
  } else if (actionType === 'videohub_route') {
    const sources = _failoverSources.videohub || [];
    if (sources.length === 0) {
      select.innerHTML = '<option value="">No VideoHub inputs found</option>';
    } else {
      for (const src of sources) {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.textContent = `${src.id}: ${src.name}${src.hub ? ` (${src.hub})` : ''}`;
        select.appendChild(opt);
      }
    }
  } else if (actionType === 'obs_scene') {
    const sources = _failoverSources.obs || [];
    if (sources.length === 0) {
      select.innerHTML = '<option value="">No OBS scenes found</option>';
    } else {
      for (const src of sources) {
        const opt = document.createElement('option');
        opt.value = src.name;
        opt.textContent = src.name;
        select.appendChild(opt);
      }
    }
  }

  if (selectedValue != null) select.value = String(selectedValue);
}

async function loadFailoverConfig() {
  if (!api.getFailoverConfig) return;
  try {
    const config = await api.getFailoverConfig();
    const enabledCb = document.getElementById('failover-enabled');
    if (enabledCb) enabledCb.checked = !!config.enabled;

    const fieldsDiv = document.getElementById('failover-config-fields');
    if (fieldsDiv) fieldsDiv.style.display = config.enabled ? '' : 'none';

    const actionType = document.getElementById('failover-action-type');
    if (actionType && config.action?.type) actionType.value = config.action.type;

    // Load sources then select the saved value
    await loadFailoverSources(config.action?.input);

    const threshold = document.getElementById('failover-black-threshold');
    if (threshold && config.blackThresholdS) {
      threshold.value = config.blackThresholdS;
      const label = document.getElementById('failover-threshold-val');
      if (label) label.textContent = config.blackThresholdS + 's';
    }

    const ackTimeout = document.getElementById('failover-ack-timeout');
    if (ackTimeout && config.ackTimeoutS) {
      ackTimeout.value = config.ackTimeoutS;
      const label = document.getElementById('failover-ack-val');
      if (label) label.textContent = config.ackTimeoutS + 's';
    }

    const autoRecover = document.getElementById('failover-auto-recover');
    if (autoRecover) autoRecover.checked = !!config.autoRecover;

    const audioTrigger = document.getElementById('failover-audio-trigger');
    if (audioTrigger) audioTrigger.checked = !!config.audioTrigger;

    _failoverConfigLoaded = true;
  } catch { /* ignore — failover may not be available */ }
}

function getFailoverConfigFromUI() {
  const enabled = document.getElementById('failover-enabled')?.checked || false;
  const actionType = document.getElementById('failover-action-type')?.value || 'atem_switch';
  const safeRaw = document.getElementById('failover-safe-input')?.value || '';
  const safeInput = actionType === 'obs_scene' ? safeRaw : (parseInt(safeRaw) || 0);
  const blackThresholdS = parseInt(document.getElementById('failover-black-threshold')?.value) || 5;
  const ackTimeoutS = parseInt(document.getElementById('failover-ack-timeout')?.value) || 30;
  const autoRecover = document.getElementById('failover-auto-recover')?.checked || false;
  const audioTrigger = document.getElementById('failover-audio-trigger')?.checked || false;
  return { enabled, action: { type: actionType, input: safeInput }, blackThresholdS, ackTimeoutS, autoRecover, audioTrigger };
}

function initFailoverConfigUI() {
  const enabledCb = document.getElementById('failover-enabled');
  if (enabledCb) {
    enabledCb.addEventListener('change', () => {
      const fieldsDiv = document.getElementById('failover-config-fields');
      if (fieldsDiv) fieldsDiv.style.display = enabledCb.checked ? '' : 'none';
    });
  }
  // Re-populate sources when action type changes
  const actionType = document.getElementById('failover-action-type');
  if (actionType) {
    actionType.addEventListener('change', () => {
      populateFailoverSourceDropdown(null);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function setStatusValue(id, text, active) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('active', !!active);
  el.classList.toggle('muted', !active);
}

function getStatusActive(active) {
  if (typeof active === 'boolean') return active;
  if (typeof active === 'number') return active > 0;
  if (active && typeof active === 'object') {
    if (active.connected !== undefined) return !!active.connected;
    if (active.online !== undefined) return !!active.online;
    if (active.active !== undefined) return !!active.active;
    if (active.streaming !== undefined) return !!active.streaming;
    if (active.status !== undefined && typeof active.status === 'boolean') return !!active.status;
  }
  return null;
}

function getDotState(active) {
  // Before first relay status, show connecting (yellow pulse) when running
  if (!_hasReceivedRelayStatus) {
    if (active === true) return 'green';
    if (active && typeof active === 'object' && (active.connected === true || active.online === true)) return 'green';
    return isRunning ? 'yellow' : '';
  }

  if (typeof active === 'boolean') return active ? 'green' : 'red';
  if (typeof active === 'number') return active > 0 ? 'green' : 'red';

  if (active && typeof active === 'object') {
    const rawStatus = typeof active.status === 'string' ? active.status.toLowerCase() : '';

    // If explicitly connected/online, that's green — don't let unrelated false flags override
    if (active.connected === true || active.online === true) return 'green';

    if (
      active.connected === false ||
      active.online === false ||
      active.error ||
      rawStatus.includes('error') ||
      rawStatus.includes('fail') ||
      rawStatus.includes('offline') ||
      rawStatus.includes('disconnect')
    ) {
      return 'red';
    }

    if (
      active.connecting ||
      rawStatus.includes('connect') ||
      rawStatus.includes('retry') ||
      rawStatus.includes('degrad') ||
      rawStatus.includes('warn')
    ) {
      return 'yellow';
    }

    if (
      active.active === true ||
      active.streaming === true ||
      active.status === true
    ) {
      return 'green';
    }
  }

  return '';
}

function setDot(name, active) {
  const dot = document.getElementById('dot-' + name);
  if (!dot) return;
  const chip = dot.closest('.status-chip');
  const state = getDotState(active);

  dot.className = `dot${state ? ' ' + state : ''}`;

  if (!chip) return;
  chip.classList.remove('ok', 'warn', 'err', 'active', 'connecting');
  if (state === 'green') chip.classList.add('active', 'ok');
  else if (state === 'yellow') { chip.classList.add('warn', 'connecting'); }
  else if (state === 'red') chip.classList.add('err');
}

function setAllDotsConnecting() {
  _hasReceivedRelayStatus = false;
  const dotNames = ['relay', 'atem', 'companion', 'resolume', 'propresenter', 'encoder'];
  for (const name of dotNames) {
    const dot = document.getElementById('dot-' + name);
    if (!dot) continue;
    const chip = dot.closest('.status-chip');
    // Skip chips that are hidden (not configured)
    if (chip && chip.style.display === 'none') continue;
    setDot(name, { connecting: true });
  }
}

function updateToggleBtn() {
  const btn = document.getElementById('btn-toggle');
  btn.textContent = isRunning ? 'Stop Monitoring' : 'Start Monitoring';
  btn.className = isRunning ? 'btn-primary' : 'btn-start';
}

async function toggleAgent() {
  if (isRunning) {
    if (!(await asyncConfirm('Stop monitoring? Tally will no longer track your stream or equipment until you start it again.'))) return;
  }
  const btn = document.getElementById('btn-toggle');
  btn.disabled = true;
  btn.textContent = isRunning ? 'Stopping…' : 'Starting…';
  try {
    if (isRunning) {
      await api.stopAgent();
      isRunning = false;
    } else {
      setAllDotsConnecting();
      await api.startAgent();
      isRunning = true;
    }
  } catch (e) {
    addAlert(`Agent ${isRunning ? 'stop' : 'start'} failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    updateToggleBtn();
  }
}

async function testConn() {
  const config = await api.getConfig();
  const relay = config.relay || DEFAULT_RELAY_URL;
  const token = config.token || '';
  try {
    const result = await api.testConnection({ url: relay, token });
    addAlert(result.success ? 'Relay connection OK' : `${friendlyError(result.error)}`);
  } catch (e) {
    addAlert(`${friendlyError(e)}`);
  }
}

async function sendDiagnosticBundle() {
  const btn = document.getElementById('btn-diagnostic-bundle');
  const statusEl = document.getElementById('diagnostic-bundle-status');
  if (!btn || !statusEl) return;

  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = 'Collecting diagnostics...';
  statusEl.style.color = 'var(--muted)';

  try {
    const result = await api.sendDiagnosticBundle();
    if (result?.error) {
      statusEl.textContent = `Failed: ${friendlyError(result.error)}`;
      statusEl.style.color = 'var(--danger)';
    } else if (result?.id) {
      statusEl.textContent = `Report sent! Reference: #${result.id.slice(0, 8)}`;
      statusEl.style.color = 'var(--green)';
      addAlert(`Diagnostic report sent (#${result.id.slice(0, 8)})`);
    } else {
      statusEl.textContent = 'Report sent!';
      statusEl.style.color = 'var(--green)';
    }
  } catch (e) {
    statusEl.textContent = `Failed: ${friendlyError(e)}`;
    statusEl.style.color = 'var(--danger)';
  }

  btn.disabled = false;
  // Auto-hide status after 10 seconds
  setTimeout(() => { statusEl.style.display = 'none'; }, 10000);
}

async function exportLogs() {
  if (!api?.exportTestLogs) {
    addAlert('Export logs is unavailable in this build.');
    return;
  }

  try {
    const result = await api.exportTestLogs();
    if (result?.canceled) {
      addAlert('Log export canceled');
      return;
    }
    if (result?.error) {
      addAlert(`Log export failed: ${result.error}`);
      return;
    }
    addAlert(`Logs exported: ${result.filePath || 'saved'}`);
  } catch (e) {
    addAlert(`Log export failed: ${e.message}`);
  }
}

function detectActivityType(text) {
  const t = text.toLowerCase();
  // AI commands / Telegram executed
  if (t.includes('[ai]') || t.includes('telegram') || t.includes('command executed') || t.includes('ai parsed') || t.includes('via telegram')) return 'ai';
  // Hard alerts / errors
  if (t.includes('alert') || t.includes('silence') || t.includes('drop') || t.includes('disconnect') || t.includes('unreachable') || t.includes('failed') || t.includes('error') || t.includes('offline') || t.includes('no audio')) return 'alert';
  // Confirmations / OK
  if (t.includes('ok') || t.includes('connected') || t.includes('recording started') || t.includes('stream started') || t.includes('started') || t.includes('confirmed') || t.includes('saved') || t.includes('complete') || t.includes('preview requested')) return 'ok';
  // System events (default)
  return 'sys';
}

function addActivity(type, text) {
  const log = document.getElementById('alerts-log');
  if (alertCount === 0) log.innerHTML = '';
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const labels = { ai: 'AI', sys: 'SYS', alert: 'ALERT', ok: 'OK' };
  const entry = document.createElement('div');
  entry.className = 'activity-entry ' + (type || 'sys');
  const badge = document.createElement('span');
  badge.className = 'activity-badge';
  badge.textContent = labels[type] || 'SYS';
  const textEl = document.createElement('span');
  textEl.className = 'activity-text';
  textEl.textContent = text.trim();
  const tsEl = document.createElement('span');
  tsEl.className = 'activity-ts';
  tsEl.textContent = ts;
  entry.appendChild(badge);
  entry.appendChild(textEl);
  entry.appendChild(tsEl);
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  alertCount++;
  _activityCount++;
  updateActivityBadge();
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

function addAlert(text) {
  // Apply friendly error transformation to error/alert messages
  const type = detectActivityType(text);
  const friendlyText = type === 'alert' ? friendlyError(text) : text;
  addActivity(type, friendlyText);
}

// ─── OFFLINE MODE HELPERS ───────────────────────────────────────────────────

function formatTimeAgo(date) {
  if (!date) return 'unknown';
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

function getReconnectDelay() {
  // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
  const base = 2000;
  const delay = Math.min(base * Math.pow(2, _reconnectAttempt - 1), 30000);
  return delay;
}

function startReconnectCountdown() {
  clearReconnectCountdown();
  const countdownEl = document.getElementById('offline-banner-countdown');
  if (!countdownEl) return;

  const delay = getReconnectDelay();
  const endTime = Date.now() + delay;

  countdownEl.style.display = 'inline';
  const update = () => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    if (remaining > 0) {
      countdownEl.textContent = `Reconnecting in ${remaining}s...`;
    } else {
      countdownEl.textContent = 'Reconnecting...';
      clearReconnectCountdown();
    }
  };
  update();
  _reconnectCountdownTimer = setInterval(update, 1000);
}

function clearReconnectCountdown() {
  if (_reconnectCountdownTimer) {
    clearInterval(_reconnectCountdownTimer);
    _reconnectCountdownTimer = null;
  }
  const countdownEl = document.getElementById('offline-banner-countdown');
  if (countdownEl) countdownEl.style.display = 'none';
}

// ─── MULTI-ENCODER VISIBILITY ──────────────────────────────────────────────

function updateMultiEncoderUI(status) {
  const eq = window._savedEquipment || {};
  const encoders = Array.isArray(eq.encoders) ? eq.encoders : [];
  const multiBar = document.getElementById('multi-encoder-bar');
  const multiCards = document.getElementById('multi-encoder-cards');
  const encoderDotLabel = document.getElementById('dot-encoder-label');

  // If only one or zero encoders, keep existing layout
  if (encoders.length <= 1) {
    if (multiBar) multiBar.style.display = 'none';
    if (multiCards) multiCards.style.display = 'none';
    return;
  }

  // Multiple encoders: show status chips and mini cards
  if (multiBar) {
    multiBar.style.display = 'flex';
    multiBar.innerHTML = encoders.map((enc, i) => {
      const label = enc.label || enc.type || `Encoder ${i + 1}`;
      // Try to derive connected state from status
      const connected = getEncoderConnected(status, enc, i);
      const dotClass = connected ? 'green' : 'red';
      const chipClass = connected ? 'active' : '';
      const statusSymbol = connected ? '\u2713' : '\u2717';
      return `<div class="encoder-status-chip ${chipClass}" title="${escapeHtml(label)}">
        <span class="enc-dot ${dotClass}"></span>
        <span>${escapeHtml(label)} ${statusSymbol}</span>
      </div>`;
    }).join('');
  }

  // Update the top status bar encoder dot label
  if (encoderDotLabel && encoders.length > 1) {
    const connectedCount = encoders.filter((enc, i) => getEncoderConnected(status, enc, i)).length;
    encoderDotLabel.textContent = `Encoders (${connectedCount}/${encoders.length})`;
  }

  if (multiCards) {
    multiCards.style.display = 'block';
    multiCards.innerHTML = encoders.map((enc, i) => {
      const label = enc.label || enc.type || `Encoder ${i + 1}`;
      const connected = getEncoderConnected(status, enc, i);
      const dotClass = connected ? 'green' : 'red';
      const encType = enc.type || 'Unknown';
      // Extract per-encoder bitrate/health if available
      const encStatus = getEncoderStatus(status, enc, i);
      return `<div class="encoder-mini-card">
        <div class="enc-card-header">
          <span class="enc-dot ${dotClass}" style="width:7px;height:7px;border-radius:50%;display:inline-block;"></span>
          <span class="enc-card-name">${escapeHtml(label)}</span>
        </div>
        <div class="enc-card-row">
          <span>Type: <span class="enc-card-val">${escapeHtml(encType)}</span></span>
          <span>Bitrate: <span class="enc-card-val">${encStatus.bitrate || '--'}</span></span>
          <span>Health: <span class="enc-card-val" style="color:${encStatus.healthColor};">${encStatus.health || '--'}</span></span>
        </div>
      </div>`;
    }).join('');
  }
}

function getEncoderConnected(status, enc, idx) {
  // Check if this encoder is connected based on status data
  if (status.encoders && Array.isArray(status.encoders) && status.encoders[idx]) {
    return getStatusActive(status.encoders[idx]);
  }
  // Fallback: if only primary encoder status exists
  if (idx === 0) {
    return !!(status.encoder || getStatusActive(status.obs));
  }
  return false;
}

function getEncoderStatus(status, enc, idx) {
  const result = { bitrate: '--', health: '--', healthColor: 'var(--dim)' };
  let encData = null;
  if (status.encoders && Array.isArray(status.encoders) && status.encoders[idx]) {
    encData = status.encoders[idx];
  } else if (idx === 0) {
    encData = status;
  }
  if (!encData) return result;
  const br = encData.bitrate ?? null;
  if (typeof br === 'number' && br > 0) {
    result.bitrate = br >= 1000 ? `${(br / 1000).toFixed(1)} Mbps` : `${br} Kbps`;
  }
  if (typeof br === 'number') {
    if (br >= 4000) { result.health = 'Excellent'; result.healthColor = 'var(--green)'; }
    else if (br >= 2000) { result.health = 'Fair'; result.healthColor = 'var(--warn)'; }
    else if (br > 0) { result.health = 'Poor'; result.healthColor = 'var(--danger)'; }
    else { result.health = 'Idle'; result.healthColor = 'var(--dim)'; }
  }
  return result;
}

// ─── PROBLEM FINDER AUTO-RUN ───────────────────────────────────────────────

async function pfAutoRun() {
  if (_pfAutoRunDone) return;
  _pfAutoRunDone = true;

  try {
    const api = window.electronAPI;
    if (!api || !api.pfAvailable || !api.pfAnalyze) return;
    const available = await api.pfAvailable();
    if (!available) return;

    // Run in background — don't block the UI
    const result = await api.pfAnalyze();
    if (result?.report) {
      const issues = result.report.diagnostics?.issues || [];
      const realIssues = issues.filter(i => i.id !== 'no_issues_detected');
      _pfAutoRunIssueCount = realIssues.length;

      // Update problem finder state
      if (typeof _pfLastReport !== 'undefined') {
        _pfLastReport = result.report;
        _pfLastGoNoGo = result.goNoGo || null;
      }

      // Show badge on Status tab if issues found
      updatePfBadge();
    }
  } catch {
    // Silent fail — auto-run should never block the user
  }
}

function updatePfBadge() {
  const badge = document.getElementById('status-issue-badge');
  if (!badge) return;
  if (_pfAutoRunIssueCount > 0) {
    badge.textContent = `${_pfAutoRunIssueCount} issue${_pfAutoRunIssueCount !== 1 ? 's' : ''}`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ─── IPC listeners ─────────────────────────────────────────────────────────

api.onStatus((status) => {
  updateStatusUI(status);

  // Multi-encoder update
  updateMultiEncoderUI(status);

  // Trigger auto-run after first successful relay connection
  if (getStatusActive(status.relay) && !_pfAutoRunDone && isRunning) {
    // Delay to let all devices connect before scanning for issues
    setTimeout(() => pfAutoRun(), 15000);
  }
});

// Signal Failover state listener
if (api.onFailoverStateChange) {
  api.onFailoverStateChange((fo) => updateFailoverUI(fo));
}
initFailoverConfigUI();

// Periodically refresh pre-service panel (every 5 minutes when dashboard is visible)
let _preServiceRefreshTimer = null;
function startPreServiceRefresh() {
  if (_preServiceRefreshTimer) return;
  _preServiceRefreshTimer = setInterval(() => {
    const panel = document.getElementById('preservice-panel');
    if (panel) loadPreServiceCheck();
    loadPreServiceReadiness();
  }, 5 * 60 * 1000);
}
startPreServiceRefresh();

// Update stale timestamp display every 30s while disconnected
let _staleDisplayTimer = setInterval(() => {
  if (_relayDisconnectedAt && _cachedStatusTime) {
    const staleEl = document.getElementById('offline-banner-stale');
    if (staleEl && staleEl.style.display !== 'none') {
      staleEl.textContent = `Showing cached data. Last update: ${formatTimeAgo(_cachedStatusTime)}`;
    }
  }
}, 30000);

api.onLog((text) => {
  const t = text.trim();
  // Show important operational events in the activity feed
  if (
    t.includes('ALERT') ||
    t.includes('Stream') || t.includes('Recording') ||
    t.includes('connected') || t.includes('disconnected') || t.includes('Connected') || t.includes('Disconnected') ||
    t.includes('MUTED') || t.includes('silence') || t.includes('Audio') ||
    t.includes('Encoder') || t.includes('Companion') || t.includes('ATEM') ||
    t.includes('Relay') || t.includes('error') || t.includes('failed') ||
    t.includes('[AI]') || t.includes('Telegram') ||
    t.includes('Low FPS') || t.includes('bitrate')
  ) {
    addAlert(t);
  }

  // Append to raw-log output section (P2 item 14 — Show/Hide Logs)
  const rawLog = document.getElementById('raw-log-output');
  if (rawLog) {
    const line = document.createElement('div');
    line.textContent = t;
    rawLog.appendChild(line);
    // Cap at 500 lines to avoid memory growth
    while (rawLog.children.length > 500) rawLog.removeChild(rawLog.firstChild);
    // Only scroll if the section is visible
    const section = document.getElementById('section-raw-logs');
    if (section && !section.classList.contains('collapsed')) {
      rawLog.scrollTop = rawLog.scrollHeight;
    }
  }

  // Status UI is driven by onStatus() — log handler only feeds the activity log.
});

function clearRawLogs() {
  const rawLog = document.getElementById('raw-log-output');
  if (rawLog) rawLog.innerHTML = '';
}

// ─── PREVIEW ───────────────────────────────────────────────────────────────


// Live stream URL
async function setupLiveStreamLink() {
  const config = await api.getConfig();
  const el = document.getElementById('live-stream-link');
  if (!el) return; // element may not exist in current layout
  if (config.liveStreamUrl) {
    const link = document.createElement('a');
    link.href = '#';
    link.style.cssText = 'color:var(--green); font-size:12px; font-family:var(--mono); text-decoration:none;';
    link.textContent = '● Watch Live →';
    link.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(config.liveStreamUrl); });
    el.innerHTML = '';
    el.appendChild(link);
  }
}
// setupLiveStreamLink() — disabled: no 'live-stream-link' element exists in index.html

api.onUpdateReady(() => {
  addAlert('Update downloaded — restart to install');
});

// Surface update-not-available and error to user (P1 item 4)
if (api.onUpdateNotAvailable) {
  api.onUpdateNotAvailable(() => {
    const updateStatusEl = document.getElementById('update-status-msg');
    if (updateStatusEl) {
      updateStatusEl.textContent = "You're up to date.";
      updateStatusEl.style.display = '';
      setTimeout(() => { updateStatusEl.style.display = 'none'; }, 4000);
    }
  });
}

if (api.onUpdateError) {
  api.onUpdateError((msg) => {
    addAlert(`Update check failed: ${msg}`);
  });
}

if (api.onUpdateProgress) {
  api.onUpdateProgress((data) => {
    const updateStatusEl = document.getElementById('update-status-msg');
    if (updateStatusEl) {
      updateStatusEl.textContent = `Downloading update: ${data.percent}%`;
      updateStatusEl.style.display = '';
    }
  });
}

// What's New splash on first launch after update (P2 item 8)
if (api.onWhatsNew) {
  api.onWhatsNew(({ version }) => {
    addAlert(`Updated to v${version} — see Changelog for What's New.`);
    // Show a brief banner at top of activity feed
    const whatsNew = document.createElement('div');
    whatsNew.style.cssText = 'padding:8px 12px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);border-radius:6px;margin-bottom:8px;font-size:12px;color:var(--green);';
    whatsNew.innerHTML = `<strong>Updated to v${version}</strong> — check the <a href="#" onclick="event.preventDefault();api.openExternal('https://tallyconnect.app/changelog')" style="color:var(--green);">Changelog</a> for what's new.`;
    const log = document.getElementById('alerts-log');
    if (log) log.prepend(whatsNew);
  });
}

// Connection quality indicator (P2 item 11)
if (api.onConnectionQuality) {
  api.onConnectionQuality(({ latencyMs, lastPingTime }) => {
    const chip = document.getElementById('relay-latency-chip');
    if (!chip) return;
    const color = latencyMs < 100 ? 'var(--green)' : latencyMs < 300 ? '#f59e0b' : 'var(--danger)';
    chip.textContent = `${latencyMs}ms`;
    chip.style.color = color;
    chip.style.display = '';
    chip.title = `Last ping: ${lastPingTime ? new Date(lastPingTime).toLocaleTimeString() : '—'} · ${latencyMs}ms round-trip`;
  });
}

// Pause chat polling when window is hidden to tray
api.onWindowVisibility?.((visible) => {
  if (!visible) {
    stopChatPolling();
  } else {
    // Resume only if engineer tab is active
    const engineerTab = document.getElementById('tab-engineer');
    if (engineerTab?.classList.contains('active')) startChatPolling();
  }
});

// ─── TABS ──────────────────────────────────────────────────────────────────

let _equipDirty = false;

function markEquipDirty() { _equipDirty = true; }

// Listen for field changes inside the equipment tab
document.addEventListener('input', (e) => {
  if (e.target.closest('#tab-equipment')) markEquipDirty();
});
document.addEventListener('change', (e) => {
  if (e.target.closest('#tab-equipment')) markEquipDirty();
});

async function switchTab(name) {
  // Warn about unsaved equipment changes when leaving equipment tab
  const equipTab = document.getElementById('tab-equipment');
  if (_equipDirty && equipTab?.classList.contains('active') && name !== 'equipment') {
    if (!(await asyncConfirm('You have unsaved equipment changes. Leave without saving?'))) return;
    _equipDirty = false;
  }
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab-btn[onclick="switchTab('${name}')"]`)?.classList.add('active');
  document.getElementById('tab-' + name)?.classList.add('active');
  if (name === 'equipment') { loadEquipment(); updateOAuthUI(); }
  if (name === 'engineer') { loadProblemFinder(); startChatPolling(); }
  else stopChatPolling();
  // Clear issue badge when user views the Status tab
  if (name === 'status') {
    _pfAutoRunIssueCount = 0;
    updatePfBadge();
  }
}

// ─── CHAT ───────────────────────────────────────────────────────────────────

let chatMessages = [];
let chatLastTimestamp = null;
let chatPollInterval = null;
// Session start timestamp — chat only loads messages sent after this point.
// Ensures each session starts with a clean chat (no historical messages).
const _chatSessionStart = new Date().toISOString();
const MAX_CHAT_MESSAGES = 200;
let _chatRenderedCount = 0; // track how many messages are already in the DOM
const _chatIdSet = new Set();  // O(1) dedup instead of .some() scan

function startChatPolling() {
  loadChatHistory();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(pollChat, 4000);
}

function stopChatPolling() {
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function loadChatHistory() {
  // Only load messages sent after this session started — each launch starts fresh.
  // Historical chat is preserved server-side for the portal, not the electron app.
  const resp = await api.getChat({ since: _chatSessionStart, latest: true, limit: 200 });
  if (resp?.messages) {
    chatMessages = resp.messages;
    _chatIdSet.clear();
    for (const m of chatMessages) if (m.id) _chatIdSet.add(m.id);
    if (chatMessages.length > 0) chatLastTimestamp = chatMessages[chatMessages.length - 1].timestamp;
    _chatRenderedCount = 0; // force full rebuild
    renderChat();
  }
}

async function pollChat() {
  if (!chatLastTimestamp) return loadChatHistory();
  const resp = await api.getChat({ since: chatLastTimestamp });
  if (resp?.messages?.length > 0) {
    for (const m of resp.messages) {
      if (m.id && _chatIdSet.has(m.id)) continue; // dedup
      chatMessages.push(m);
      if (m.id) _chatIdSet.add(m.id);
    }
    chatLastTimestamp = resp.messages[resp.messages.length - 1].timestamp;
    renderChat();
  }
}

// Real-time inbound via WebSocket → stdout → IPC
api.onChatMessage((msg) => {
  if (msg.id && _chatIdSet.has(msg.id)) return; // O(1) dedup
  chatMessages.push(msg);
  if (msg.id) _chatIdSet.add(msg.id);
  chatLastTimestamp = msg.timestamp || chatLastTimestamp;
  renderChat();
});

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function _buildChatEl(m) {
  const sourceIcon = { telegram: '\u{1F4F1}', app: '\u{1F4BB}', dashboard: '\u{1F310}' };
  const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const icon = sourceIcon[m.source] || '\u{1F4AC}';
  const roleColor = m.sender_role === 'admin' ? 'var(--green)' : 'var(--white)';
  const name = m.sender_name || m.senderName || 'Unknown';

  const row = document.createElement('div');
  row.style.cssText = 'padding:6px 12px; margin-bottom:2px;';
  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:10px; color:var(--dim); font-family:var(--mono);';
  const nameSpan = document.createElement('span');
  nameSpan.style.cssText = `color:${roleColor}; font-weight:600;`;
  nameSpan.textContent = name;
  const timeSpan = document.createElement('span');
  timeSpan.style.marginLeft = '6px';
  timeSpan.textContent = time;
  meta.appendChild(document.createTextNode(icon + ' '));
  meta.appendChild(nameSpan);
  meta.appendChild(timeSpan);
  const body = document.createElement('div');
  body.style.cssText = 'font-size:13px; color:var(--white); margin-top:2px; line-height:1.4;';
  body.textContent = m.message;
  row.appendChild(meta);
  row.appendChild(body);
  return row;
}

function renderChat() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  // Cap messages to prevent unbounded memory growth
  if (chatMessages.length > MAX_CHAT_MESSAGES) {
    chatMessages = chatMessages.slice(-MAX_CHAT_MESSAGES);
    _chatIdSet.clear();
    for (const m of chatMessages) if (m.id) _chatIdSet.add(m.id);
    _chatRenderedCount = 0; // array was sliced, need full rebuild
  }
  // Full rebuild when reset or first render
  if (_chatRenderedCount === 0) {
    container.innerHTML = '';
    for (const m of chatMessages) container.appendChild(_buildChatEl(m));
  } else {
    // Incremental: only append new messages
    const newMessages = chatMessages.slice(_chatRenderedCount);
    for (const m of newMessages) container.appendChild(_buildChatEl(m));
  }
  _chatRenderedCount = chatMessages.length;
  // Scroll the parent overflow container, not #chat-messages itself
  const scrollArea = document.getElementById('chat-scroll-area');
  if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
}

// ─── CHAT FILE ATTACHMENT ──────────────────────────────────────────────────

let pendingAttachment = null; // { filePath, fileName, mimeType }

async function pickChatFile() {
  const result = await api.pickFile();
  if (!result) return;
  pendingAttachment = result;
  document.getElementById('chat-attachment-badge').style.display = 'block';
  document.getElementById('chat-attachment-name').textContent = result.fileName;
}

function clearChatAttachment() {
  pendingAttachment = null;
  document.getElementById('chat-attachment-badge').style.display = 'none';
  document.getElementById('chat-attachment-name').textContent = '';
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();

  // If there's an attachment, use the upload path
  if (pendingAttachment) {
    if (!message && !pendingAttachment.filePath) return;
    input.value = '';
    const attachment = pendingAttachment;
    clearChatAttachment();
    const resp = await api.uploadChatFile({
      message,
      filePath: attachment.filePath,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    if (resp?.id) {
      chatMessages.push(resp);
      chatLastTimestamp = resp.timestamp;
      renderChat();
    } else if (resp?.error) {
      chatMessages.push({ id: Date.now(), senderName: 'System', senderRole: 'system', message: resp.error, timestamp: new Date().toISOString() });
      renderChat();
    }
    return;
  }

  if (!message) return;
  input.value = '';

  // If relay is disconnected, queue message for later
  if (_relayDisconnectedAt) {
    queueOfflineAction({ type: 'chat', message });
    addAlert(`Queued: "${message}" — will send when reconnected.`);
    return;
  }

  try {
    const resp = await api.sendChat({ message });
    if (resp?.error) {
      input.value = message; // Restore so user can retry
      addAlert(`Message failed: ${resp.error}`);
    } else if (resp?.id) {
      chatMessages.push(resp);
      chatLastTimestamp = resp.timestamp;
      renderChat();
    }
  } catch (e) {
    // Network error — queue for offline replay
    queueOfflineAction({ type: 'chat', message });
    addAlert(`Queued: "${message}" — will send when reconnected.`);
  }
}


// ─── EQUIPMENT ─────────────────────────────────────────────────────────────

// Equipment state is managed by deviceState in equipment-ui.js

// ─── ROOM PICKER (header) ──────────────────────────────────────────
async function loadRoomPicker() {
  const picker = document.getElementById('room-picker');
  const select = document.getElementById('room-picker-select');
  if (!picker || !select) return;

  try {
    const config = await api.getConfig();
    if (!config.token) return; // not signed in
    const relayUrl = (config.relay || DEFAULT_RELAY_URL).replace('wss://', 'https://').replace('ws://', 'http://');
    const resp = await fetch(`${relayUrl}/api/church/app/rooms`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return;
    const data = await resp.json();

    if (!data.rooms || data.rooms.length === 0) {
      picker.style.display = 'none';
      return;
    }

    select.innerHTML = '<option value="">Select a room\u2026</option>';
    for (const room of data.rooms) {
      const opt = document.createElement('option');
      opt.value = room.id;
      opt.textContent = room.name;
      if (room.id === data.currentRoomId) opt.selected = true;
      select.appendChild(opt);
    }

    picker.style.display = '';
  } catch (e) {
    console.warn('[Room] Failed to load room picker:', e.message);
  }
}

async function assignRoomFromPicker(roomId) {
  if (!roomId) return;
  const config = await api.getConfig();
  const oldRoom = config.roomName || '';

  // Find the new room name from the picker select
  const select = document.getElementById('room-picker-select');
  const newRoom = select ? (select.options[select.selectedIndex]?.textContent || '') : '';

  if (oldRoom === newRoom) return; // same room, no-op

  // Confirm before switching — this restarts the agent
  if (!(await asyncConfirm(`Switch to room "${newRoom}"? This will restart monitoring.`))) {
    // Reset the dropdown to the previous value
    if (select) {
      for (const opt of select.options) {
        if (opt.textContent === oldRoom) { opt.selected = true; break; }
      }
    }
    return;
  }

  addAlert(`Switching to room: ${newRoom}...`);

  try {
    // Full room switch: stop agent → swap equipment → reassign → clear status → restart
    const result = await api.fullRoomSwitch(oldRoom, newRoom, roomId);

    if (result.ok) {
      isRunning = true;
      updateToggleBtn();

      // Update header
      const nameEl = document.getElementById('church-name');
      if (nameEl) {
        const baseName = nameEl.textContent.split(' \u00b7 ')[0];
        nameEl.textContent = baseName + ' \u00b7 ' + (result.roomName || newRoom);
      }

      // Show connecting (yellow pulse) while agent reconnects to new room
      setAllDotsConnecting();

      // Clear ALL in-memory device state before reloading new room's equipment
      if (typeof resetDeviceState === 'function') resetDeviceState();
      _cachedStatus = null;
      _failoverConfigLoaded = false;
      _failoverSources = { atem: [], videohub: [], obs: [] };

      // Reload equipment from config (now reflects new room's data)
      if (typeof loadEquipment === 'function') {
        try { await loadEquipment(); } catch { /* ignore */ }
      }

      // Reset chat for new room context
      chatMessages = [];
      chatLastTimestamp = null;
      _chatRenderedCount = 0;
      _chatIdSet.clear();
      renderChat();
      loadChatHistory(); // reload room-scoped history

      addAlert(`Now monitoring room: ${result.roomName || newRoom}`);
    }
  } catch (e) {
    console.warn('[Room] Failed to switch room:', e.message);
    addAlert('Failed to switch room: ' + e.message);
  }
}

async function confirmFactoryReset() {
  const confirmed = await asyncConfirm('Reset all settings to factory defaults? This will sign you out, erase all equipment configuration, and return to the initial setup screen. A backup of your config will be saved.');
  if (!confirmed) return;
  try {
    await api.factoryReset();
  } catch (e) {
    addAlert('Factory reset failed: ' + e.message);
  }
}

function setEquipMode(mode) {
  const simplePane = document.getElementById('equip-simple-mode');
  const advancedPane = document.getElementById('equip-advanced-mode');
  const btnSimple = document.getElementById('mode-btn-simple');
  const btnAdvanced = document.getElementById('mode-btn-advanced');
  if (mode === 'advanced') {
    simplePane.style.display = 'none';
    advancedPane.style.display = 'block';
    btnSimple.classList.remove('active');
    btnAdvanced.classList.add('active');
  } else {
    simplePane.style.display = 'block';
    advancedPane.style.display = 'none';
    btnSimple.classList.add('active');
    btnAdvanced.classList.remove('active');
  }
}

function renderSimpleDeviceList(eq) {
  const container = document.getElementById('simple-device-list');
  if (!container) return;
  const items = [];
  if (eq.atemIp) items.push({ icon: '\uD83C\uDFAC', name: 'ATEM Switcher', detail: eq.atemIp });
  // Encoder — check both single encoder and multi-encoder formats
  const encType = eq.encoderType || '';
  const encHost = eq.encoderHost || '';
  if (encHost || encType) {
    const nameMap = { blackmagic: 'Streaming Encoder', obs: 'OBS Studio', vmix: 'vMix Encoder', ecamm: 'Ecamm Live', teradek: 'Teradek', aja: 'AJA HELO', epiphan: 'Epiphan', birddog: 'BirdDog', tricaster: 'TriCaster', 'tally-encoder': 'Tally Encoder', 'atem-streaming': 'ATEM Mini' };
    items.push({ icon: '\uD83D\uDCE1', name: nameMap[encType] || 'Encoder', detail: encHost || encType });
  }
  if (eq.companionUrl) items.push({ icon: '\uD83C\uDFAE', name: 'Companion', detail: eq.companionUrl.replace(/^https?:\/\//, '') });
  if (eq.proPresenterHost) items.push({ icon: '\u26EA', name: 'ProPresenter', detail: `${eq.proPresenterHost}:${eq.proPresenterPort || 1025}` });
  if (eq.vmixHost) items.push({ icon: '\uD83C\uDFAC', name: 'vMix', detail: `${eq.vmixHost}:${eq.vmixPort || 8088}` });
  if (eq.resolumeHost) items.push({ icon: '\uD83C\uDF1F', name: 'Resolume Arena', detail: `${eq.resolumeHost}:${eq.resolumePort || 8080}` });
  if (eq.mixerHost) items.push({ icon: '\uD83C\uDFA4', name: `${(eq.mixerType || 'Mixer').toUpperCase()} Console`, detail: `${eq.mixerHost}:${eq.mixerPort || ''}` });
  (eq.hyperdecks || []).forEach((h, i) => { const ip = typeof h === 'string' ? h : h.ip; if (ip) items.push({ icon: '\u23FA', name: `HyperDeck ${i + 1}`, detail: ip }); });
  (eq.ptz || []).forEach((c, i) => { if (c.ip) items.push({ icon: '\uD83C\uDFA5', name: c.name || `PTZ ${i + 1}`, detail: c.ip }); });
  if (items.length === 0) {
    container.innerHTML = '<div style="color:var(--muted); font-size:12px; padding:12px;">No devices configured yet. Scan your network to get started.</div>';
    return;
  }
  container.innerHTML = items.map(d => `
    <div class="simple-device-item">
      <span class="device-icon">${escapeHtml(d.icon)}</span>
      <div class="device-info"><div class="device-name">${escapeHtml(d.name)}</div><div class="device-ip">${escapeHtml(d.detail)}</div></div>
      <span class="device-dot"></span>
    </div>`).join('');
}

async function loadEquipment() {
  const eq = await api.getEquipment();

  // ── Populate deviceState from API response ──
  deviceState.atem.ip = eq.atemIp || '';
  // Parse companion URL → host + port (e.g. "http://localhost:8888" → "localhost", "8888")
  if (eq.companionUrl) {
    try {
      const u = new URL(eq.companionUrl);
      deviceState.companion.host = u.hostname || 'localhost';
      deviceState.companion.port = u.port || '8888';
    } catch {
      deviceState.companion.host = eq.companionUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '') || '';
      deviceState.companion.port = '8888';
    }
  } else {
    deviceState.companion.host = '';
    deviceState.companion.port = '8888';
  }
  // Load encoders — prefer array format, fall back to single encoder flat fields
  if (Array.isArray(eq.encoders) && eq.encoders.length > 0) {
    deviceState.encoder = eq.encoders.map(e => ({
      encoderType: e.type || e.encoderType || '',
      host: e.host || '', port: e.port ? String(e.port) : '',
      password: e.password || '', label: e.label || '',
      statusUrl: e.statusUrl || '', source: e.source || '',
    }));
  } else if (eq.encoderType) {
    deviceState.encoder = [{
      encoderType: eq.encoderType || '', host: eq.encoderHost || '',
      port: eq.encoderPort ? String(eq.encoderPort) : '', password: eq.encoderPassword || '',
      label: eq.encoderLabel || '', statusUrl: eq.encoderStatusUrl || '', source: eq.encoderSource || '',
    }];
  } else {
    deviceState.encoder = [];
  }
  // Keep _encoderConfig for backwards compat (primary encoder)
  const primaryEnc = deviceState.encoder[0] || {};
  window._encoderConfig = { _type: primaryEnc.encoderType || '', ...primaryEnc };

  const ppConfigured = !!eq.proPresenterConfigured || !!(eq.proPresenterHost && String(eq.proPresenterHost).trim());
  deviceState.propresenter = {
    host: eq.proPresenterHost || '', port: String(eq.proPresenterPort || '1025'), configured: ppConfigured,
    triggerMode: eq.proPresenterTriggerMode || 'presentation',
    backupHost: eq.proPresenterBackupHost || '', backupPort: String(eq.proPresenterBackupPort || '1025'),
  };
  const vmixConfigured = !!eq.vmixConfigured || !!(eq.vmixHost && String(eq.vmixHost).trim());
  deviceState.vmix = { host: eq.vmixHost || '', port: String(eq.vmixPort || '8088'), configured: vmixConfigured };
  const resolumeConfigured = !!eq.resolumeConfigured || !!(eq.resolumeHost && String(eq.resolumeHost).trim());
  deviceState.resolume = { host: eq.resolumeHost || '', port: String(eq.resolumePort || '8080'), configured: resolumeConfigured };

  // Restore mixer type dropdown from audioViaAtem + override flags
  const mixerType = eq.audioViaAtemOverride === 'on' ? 'atem-direct'
    : eq.audioViaAtemOverride === 'off' ? 'atem-none'
    : eq.audioViaAtem ? 'atem-auto'
    : (eq.mixerType || '');
  deviceState.mixer = { type: mixerType, host: eq.mixerHost || '', port: eq.mixerPort ? String(eq.mixerPort) : '' };
  deviceState['atem-recording'] = { autoRecord: !!eq.atemAutoRecord };
  deviceState.hyperdeck = (eq.hyperdecks || []).map(ip => ({ ip: typeof ip === 'string' ? ip : (ip.ip || '') }));
  deviceState.ptz = (eq.ptz || []).map((cam, i) => ({
    ip: cam.ip || '', name: cam.name || `PTZ ${i + 1}`,
    protocol: cam.protocol || 'auto', port: cam.port ? String(cam.port) : '',
    username: cam.username || '', password: cam.password || '',
    profileToken: cam.profileToken || '',
  }));
  deviceState.videohub = (eq.videoHubs || []).map(h => ({ ip: h.ip || '', name: h.name || '' }));

  // ── Auto-expand configured devices ──
  expandedDevices.clear();
  if (deviceState.atem.ip) { expandedDevices.add('atem'); expandedDevices.add('atem-recording'); }
  if (deviceState.encoder.length > 0 && deviceState.encoder.some(e => e.encoderType)) expandedDevices.add('encoder');
  if (deviceState.companion.host) expandedDevices.add('companion');
  if (deviceState.hyperdeck.length > 0) expandedDevices.add('hyperdeck');
  if (deviceState.ptz.length > 0) expandedDevices.add('ptz');
  if (ppConfigured) expandedDevices.add('propresenter');
  if (vmixConfigured) expandedDevices.add('vmix');
  if (resolumeConfigured) expandedDevices.add('resolume');
  if (deviceState.videohub.length > 0) expandedDevices.add('videohub');
  if (deviceState.mixer.type || deviceState.mixer.host) expandedDevices.add('mixer');

  // ── Render dynamic catalog + summary ──
  renderDeviceCatalog();
  renderActiveSummary();
  renderSimpleDeviceList(eq);
  loadFailoverConfig();
  _equipDirty = false; // fresh load from server — nothing unsaved

  // ── Streaming keys (static DOM — not in catalog) ──
  document.getElementById('equip-youtube-key').placeholder = eq.youtubeKeySet ? '(saved \u2014 enter new to change)' : 'AIzaSy\u2026';
  document.getElementById('equip-facebook-token').placeholder = eq.facebookTokenSet ? '(saved \u2014 enter new to change)' : 'EAAxxxxxx\u2026';
  document.getElementById('equip-rtmp-url').value = eq.rtmpUrl || '';
  document.getElementById('equip-rtmp-key').placeholder = eq.rtmpKeySet ? '(saved \u2014 enter new to change)' : 'live_xxxxxxxx';

}


function setEquipDot(id, status) {
  const dot = document.getElementById(id);
  if (dot) dot.className = 'equip-status ' + (status === true ? 'green' : status === false ? 'red' : '');
}

function showHideKey(id) {
  const el = document.getElementById(id);
  el.type = el.type === 'password' ? 'text' : 'password';
}

// ─── STREAM PLATFORM OAUTH UI ──────────────────────────────────────────────

async function connectYouTube() {
  const isSimple = document.getElementById('equip-simple-mode')?.style.display !== 'none';
  const btn = document.getElementById(isSimple ? 'btn-oauth-yt-simple' : 'btn-oauth-yt');
  const status = document.getElementById(isSimple ? 'oauth-yt-status-simple' : 'oauth-yt-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }
  if (status) { status.textContent = 'Opening browser...'; status.style.color = 'var(--yellow)'; }
  try {
    const result = await api.oauthYouTubeConnect();
    if (result.success) {
      updateOAuthUI();
    } else {
      if (status) { status.textContent = result.error || 'Connection failed'; status.style.color = 'var(--red, #f44)'; }
      if (btn) btn.textContent = 'Connect YouTube';
    }
  } catch (e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red, #f44)'; }
    if (btn) btn.textContent = 'Connect YouTube';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function connectFacebook() {
  const isSimple = document.getElementById('equip-simple-mode')?.style.display !== 'none';
  const btn = document.getElementById(isSimple ? 'btn-oauth-fb-simple' : 'btn-oauth-fb');
  const status = document.getElementById(isSimple ? 'oauth-fb-status-simple' : 'oauth-fb-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Connecting...'; }
  if (status) { status.textContent = 'Opening browser...'; status.style.color = 'var(--yellow)'; }
  try {
    const result = await api.oauthFacebookConnect();
    if (result.success && result.pages?.length) {
      // Show page selector in both Advanced and Simple mode
      const pagesHtml = result.pages.map(p => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name)}</option>`).join('');
      const selector = document.getElementById('fb-page-selector');
      const select = document.getElementById('fb-page-select');
      if (select) select.innerHTML = pagesHtml;
      if (selector) selector.style.display = 'block';
      const selectorSimple = document.getElementById('fb-page-selector-simple');
      const selectSimple = document.getElementById('fb-page-select-simple');
      if (selectSimple) selectSimple.innerHTML = pagesHtml;
      if (selectorSimple) selectorSimple.style.display = 'block';
      if (status) { status.textContent = 'Select a page below'; status.style.color = 'var(--yellow)'; }
      if (btn) btn.textContent = 'Connect Facebook';
    } else if (result.success && result.pages?.length === 0) {
      if (status) { status.textContent = 'No Facebook Pages found'; status.style.color = 'var(--red, #f44)'; }
      if (btn) btn.textContent = 'Connect Facebook';
    } else {
      if (status) { status.textContent = result.error || 'Connection failed'; status.style.color = 'var(--red, #f44)'; }
      if (btn) btn.textContent = 'Connect Facebook';
    }
  } catch (e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red, #f44)'; }
    if (btn) btn.textContent = 'Connect Facebook';
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function selectFbPage() {
  const isSimple = document.getElementById('equip-simple-mode')?.style.display !== 'none';
  const select = document.getElementById(isSimple ? 'fb-page-select-simple' : 'fb-page-select');
  const pageId = select?.value;
  if (!pageId) return;

  const status = document.getElementById(isSimple ? 'oauth-fb-status-simple' : 'oauth-fb-status');
  if (status) status.textContent = 'Setting up...';
  try {
    const result = await api.oauthFacebookSelectPage({ pageId });
    if (result.success) {
      const selector = document.getElementById('fb-page-selector');
      if (selector) selector.style.display = 'none';
      const selectorSimple = document.getElementById('fb-page-selector-simple');
      if (selectorSimple) selectorSimple.style.display = 'none';
      updateOAuthUI();
    } else {
      if (status) { status.textContent = result.error || 'Failed to select page'; status.style.color = 'var(--red, #f44)'; }
    }
  } catch (e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red, #f44)'; }
  }
}

function _ensureChangeBtn(afterBtnId, key, handler) {
  const existingId = `btn-change-${key}`;
  if (document.getElementById(existingId)) return;
  const afterBtn = document.getElementById(afterBtnId);
  if (!afterBtn) return;
  const btn = document.createElement('button');
  btn.id = existingId;
  btn.className = 'btn-oauth';
  btn.textContent = 'Change';
  btn.style.marginLeft = '6px';
  btn.onclick = handler;
  afterBtn.parentElement.insertBefore(btn, afterBtn.nextSibling);
}

async function changeFbPage() {
  const isSimple = document.getElementById('equip-simple-mode')?.style.display !== 'none';
  const status = document.getElementById(isSimple ? 'oauth-fb-status-simple' : 'oauth-fb-status');
  if (status) status.textContent = 'Loading pages...';
  try {
    const result = await api.oauthFacebookListPages();
    if (!result.success || !result.pages?.length) {
      if (status) { status.textContent = result.error || 'No pages found'; status.style.color = 'var(--red, #f44)'; }
      return;
    }
    const pagesHtml = result.pages.map(p => `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name)}</option>`).join('');
    const selector = document.getElementById(isSimple ? 'fb-page-selector-simple' : 'fb-page-selector');
    const select = document.getElementById(isSimple ? 'fb-page-select-simple' : 'fb-page-select');
    if (select) select.innerHTML = pagesHtml;
    if (selector) selector.style.display = 'block';
    if (status) { status.textContent = 'Select a destination below'; status.style.color = 'var(--yellow)'; }
  } catch (e) {
    if (status) { status.textContent = e.message; status.style.color = 'var(--red, #f44)'; }
  }
}

async function disconnectYouTube() {
  if (!(await asyncConfirm('Disconnect YouTube? Stream keys will be removed.'))) return;
  await api.oauthYouTubeDisconnect();
  updateOAuthUI();
}

async function disconnectFacebook() {
  if (!(await asyncConfirm('Disconnect Facebook? Stream keys will be removed.'))) return;
  await api.oauthFacebookDisconnect();
  updateOAuthUI();
}

async function updateOAuthUI() {
  try {
    const status = await api.oauthStatus();

    // YouTube
    const ytStatus = document.getElementById('oauth-yt-status');
    const ytBtn = document.getElementById('btn-oauth-yt');
    if (status?.youtube?.connected) {
      const name = status.youtube.channelName || 'Connected';
      ytStatus.textContent = name + (status.youtube.streamKeySet ? ' — key ready' : '');
      ytStatus.style.color = 'var(--green)';
      ytBtn.textContent = 'Disconnect';
      ytBtn.className = 'btn-oauth connected';
      ytBtn.onclick = disconnectYouTube;
      _ensureChangeBtn('btn-oauth-yt', 'yt', connectYouTube);
      _ensureChangeBtn('btn-oauth-yt-simple', 'yt-simple', connectYouTube);
    } else {
      ytStatus.textContent = 'Not connected';
      ytStatus.style.color = 'var(--muted)';
      ytBtn.textContent = 'Connect YouTube';
      ytBtn.className = 'btn-oauth';
      ytBtn.onclick = connectYouTube;
      document.getElementById('btn-change-yt')?.remove();
      document.getElementById('btn-change-yt-simple')?.remove();
    }
    // Sync to simple mode
    const ytSimple = document.getElementById('oauth-yt-status-simple');
    if (ytSimple) { ytSimple.textContent = ytStatus.textContent; ytSimple.style.color = ytStatus.style.color; }

    // Facebook
    const fbStatus = document.getElementById('oauth-fb-status');
    const fbBtn = document.getElementById('btn-oauth-fb');
    if (status?.facebook?.connected) {
      const name = status.facebook.pageName || 'Connected';
      fbStatus.textContent = name + (status.facebook.streamKeySet ? ' — key ready' : '');
      fbStatus.style.color = 'var(--green)';
      fbBtn.textContent = 'Disconnect';
      fbBtn.className = 'btn-oauth connected';
      fbBtn.onclick = disconnectFacebook;
      // Show "Change" button
      _ensureChangeBtn('btn-oauth-fb', 'fb', changeFbPage);
      _ensureChangeBtn('btn-oauth-fb-simple', 'fb-simple', changeFbPage);
    } else {
      fbStatus.textContent = 'Not connected';
      fbStatus.style.color = 'var(--muted)';
      fbBtn.textContent = 'Connect Facebook';
      fbBtn.className = 'btn-oauth';
      fbBtn.onclick = connectFacebook;
      // Remove "Change" buttons
      document.getElementById('btn-change-fb')?.remove();
      document.getElementById('btn-change-fb-simple')?.remove();
    }
    // Sync to simple mode
    const fbSimple = document.getElementById('oauth-fb-status-simple');
    if (fbSimple) { fbSimple.textContent = fbStatus.textContent; fbSimple.style.color = fbStatus.style.color; }
  } catch { /* relay may be unreachable */ }
}

// Listen for OAuth updates from main process
api.onOauthUpdate?.((data) => {
  updateOAuthUI();
});

async function testEquip(type) {
  syncDomToState();
  const detailEl = document.getElementById(`equip-${type}-detail`);
  const dotId = `equip-dot-${type}`;
  const state = deviceState[type] || {};
  let params = { type };

  if (type === 'atem') {
    params.ip = (state.ip || '').trim();
    if (!params.ip) { if (detailEl) detailEl.textContent = 'Enter an IP address'; setEquipDot(dotId, false); return; }
  } else if (type === 'companion') {
    params.url = (state.url || '').trim();
    if (!params.url) { if (detailEl) detailEl.textContent = 'Enter a URL'; setEquipDot(dotId, false); return; }
  } else if (type === 'propresenter') {
    params.ip = (state.host || '').trim() || 'localhost';
    params.port = parseInt(state.port) || 1025;
  } else if (type === 'vmix') {
    params.ip = (state.host || '').trim() || 'localhost';
    params.port = parseInt(state.port) || 8088;
  } else if (type === 'resolume') {
    params.ip = (state.host || '').trim() || 'localhost';
    params.port = parseInt(state.port) || 8080;
  } else if (type === 'encoder') {
    // Encoder is multi-instance — redirect to testEquipIdx for primary
    return testEquipIdx('encoder', 0);
  } else if (type === 'mixer') {
    params.mixerType = state.type;
    params.ip = (state.host || '').trim();
    params.port = parseInt(state.port) || 0;
    if (!params.ip) { if (detailEl) detailEl.textContent = 'Enter console IP address'; setEquipDot(dotId, false); return; }
    if (!params.mixerType) { if (detailEl) detailEl.textContent = 'Select console type first'; setEquipDot(dotId, false); return; }
  }

  if (detailEl) detailEl.textContent = 'Testing\u2026';
  const result = await api.testEquipmentConnection(params);
  if (detailEl) detailEl.textContent = result.details;
  setEquipDot(dotId, result.success);
}

async function testEquipIdx(type, idx) {
  syncDomToState();
  const entries = deviceState[type];
  if (!entries || !entries[idx]) return;
  const entry = entries[idx];
  let params = { type };

  if (type === 'encoder') {
    params.type = 'encoder';
    params.encoderType = entry.encoderType;
    params.ip = (entry.host || '').trim();
    params.port = parseInt(entry.port) || 80;
    params.password = entry.password || '';
    params.source = (entry.source || '').trim();
    if (!params.encoderType) return;
    if (params.encoderType === 'ecamm') { params.ip = '127.0.0.1'; params.port = 65194; }
    else if (!params.ip && !['yolobox', 'custom-rtmp', 'rtmp-generic', 'atem-streaming'].includes(params.encoderType)) return;
  } else if (type === 'hyperdeck') {
    params.ip = (entry.ip || '').trim();
  } else if (type === 'videohub') {
    params.ip = (entry.ip || '').trim();
    params.port = 9990;
  } else if (type === 'ptz') {
    params.ip = (entry.ip || '').trim();
    params.protocol = entry.protocol || 'auto';
    params.port = parseInt(entry.port) || 0;
    params.username = entry.username || '';
    params.password = entry.password || '';
  }
  if (type !== 'encoder' && !params.ip) return;

  const dotId = `equip-dot-${type}-${idx}`;
  const detailId = `equip-${type}-detail-${idx}`;
  const detailEl = document.getElementById(detailId);
  if (detailEl) detailEl.textContent = 'Testing\u2026';

  const result = await api.testEquipmentConnection(params);
  if (detailEl) detailEl.textContent = result.details;
  setEquipDot(dotId, result.success);
}

// ── EQUIPMENT GROUP TOGGLE ──────────────────────────────────────────────────

function toggleEquipGroup(groupName) {
  const group = document.querySelector(`.equip-group[data-group="${groupName}"]`);
  if (!group) return;
  const header = group.querySelector('.equip-group-header');
  const body = group.querySelector('.equip-group-body');
  if (!header || !body) return;
  const isOpen = header.classList.contains('open');
  header.classList.toggle('open', !isOpen);
  body.classList.toggle('open', !isOpen);
}

// ── SAVE EQUIPMENT ─────────────────────────────────────────────────────────

async function saveEquipment() {
  const saveBtn = document.getElementById('btn-save-equip');
  if (saveBtn?.disabled) return; // Prevent double-click
  if (isRunning) {
    if (!(await asyncConfirm('Saving will briefly restart monitoring. Continue?'))) return;
  }
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  try { await _doSaveEquipment(); _equipDirty = false; } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Equipment Config'; }
  }
}

async function _doSaveEquipment() {
  // Flush DOM inputs into deviceState
  syncDomToState();

  // Build encoders array (all configured encoders)
  const encoders = deviceState.encoder.filter(e => e.encoderType).map(e => ({
    type: e.encoderType, host: (e.host || '').trim(),
    port: parseInt(e.port) || null,
    password: (e.password && e.password !== '••••••••') ? e.password : undefined,
    label: (e.label || '').trim(), statusUrl: (e.statusUrl || '').trim(),
    source: (e.source || '').trim(),
  }));
  // Primary encoder (first in list) — backward compat with church-client
  const enc = deviceState.encoder[0] || {};
  const encType = enc.encoderType || '';

  const config = {
    atemIp: (deviceState.atem.ip || '').trim(),
    companionUrl: deviceState.companion.host ? `http://${(deviceState.companion.host || 'localhost').trim()}:${deviceState.companion.port || '8888'}` : '',
    // Encoders array (new format)
    encoders,
    // Primary encoder flat fields (backward compat)
    encoderType: encType,
    encoderHost: (enc.host || '').trim(),
    encoderPort: parseInt(enc.port) || 0,
    encoderPassword: (enc.password && enc.password !== '••••••••') ? enc.password : undefined,
    encoderLabel: (enc.label || '').trim(),
    encoderStatusUrl: (enc.statusUrl || '').trim(),
    encoderSource: (enc.source || '').trim(),
    obsUrl: encType === 'obs' ? `ws://${(enc.host || 'localhost').trim()}:${enc.port || '4455'}` : '',
    // Don't overwrite the real password if user didn't change the masked placeholder
    obsPassword: encType === 'obs' && enc.password && enc.password !== '••••••••' ? enc.password : undefined,
    // Multi-instance
    atemAutoRecord: !!deviceState['atem-recording']?.autoRecord,
    hyperdecks: deviceState.hyperdeck.map(h => (h.ip || '').trim()).filter(Boolean),
    videoHubs: deviceState.videohub.filter(h => (h.ip || '').trim()),
    ptz: deviceState.ptz.filter(c => (c.ip || '').trim()),
    // Optional single devices
    proPresenterHost: deviceState.propresenter.configured ? ((deviceState.propresenter.host || '').trim() || 'localhost') : '',
    proPresenterPort: parseInt(deviceState.propresenter.port) || 1025,
    proPresenterTriggerMode: deviceState.propresenter.triggerMode || 'presentation',
    proPresenterBackupHost: (deviceState.propresenter.backupHost || '').trim(),
    proPresenterBackupPort: parseInt(deviceState.propresenter.backupPort) || 1025,
    vmixHost: (deviceState.vmix.configured || deviceState.vmix.host) ? (deviceState.vmix.host || '').trim() : '',
    vmixPort: parseInt(deviceState.vmix.port) || 8088,
    resolumeHost: deviceState.resolume.configured ? (deviceState.resolume.host || '').trim() : '',
    resolumePort: parseInt(deviceState.resolume.port) || 8080,
    // Audio
    mixerType: ['atem-auto', 'atem-direct', 'atem-none'].includes(deviceState.mixer.type) ? '' : (deviceState.mixer.type || ''),
    mixerHost: (deviceState.mixer.host || '').trim(),
    mixerPort: parseInt(deviceState.mixer.port) || 0,
    audioViaAtem: deviceState.mixer.type === 'atem-auto' || deviceState.mixer.type === 'atem-direct' ? 1 : 0,
    audioViaAtemOverride: deviceState.mixer.type === 'atem-direct' ? 'on'
      : deviceState.mixer.type === 'atem-none' ? 'off'
      : null,
    // Streaming keys (read from static DOM section)
    youtubeApiKey: document.getElementById('equip-youtube-key').value.trim(),
    facebookAccessToken: document.getElementById('equip-facebook-token').value.trim(),
    vimeoAccessToken: document.getElementById('equip-vimeo-token').value.trim(),
    rtmpUrl: document.getElementById('equip-rtmp-url').value.trim(),
    rtmpStreamKey: document.getElementById('equip-rtmp-key').value.trim(),
  };

  const confirmEl = document.getElementById('save-confirm');
  const errorEl = document.getElementById('save-error');

  try {
    await api.saveEquipment(config);
    // Save failover config separately (stored on relay server)
    if (_failoverConfigLoaded && api.saveFailoverConfig) {
      await api.saveFailoverConfig(getFailoverConfigFromUI()).catch(() => {});
    }
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
    if (confirmEl) {
      confirmEl.style.display = 'inline';
      setTimeout(() => { confirmEl.style.display = 'none'; }, 2000);
    }
    // Update dashboard encoder label
    const newLabel = ENCODER_DISPLAY_NAMES[encType] || 'Encoder';
    const dotLabel = document.getElementById('dot-encoder-label');
    if (dotLabel) dotLabel.textContent = newLabel;
    const sectionTitle = document.getElementById('encoder-section-title');
    if (sectionTitle) sectionTitle.textContent = newLabel;
    // Update audio-via-ATEM flag for dashboard status rendering
    _audioViaAtem = !!(config.audioViaAtem);
    window._savedEquipment = config;
    window._encoderConfig = { _type: encType, host: (enc.host || '').trim(), port: enc.port || '', password: enc.password || '', label: (enc.label || '').trim(), statusUrl: (enc.statusUrl || '').trim(), source: (enc.source || '').trim() };
    // Refresh summary chips
    renderActiveSummary();
    // Auto-restart agent so new equipment config takes effect immediately
    if (isRunning) {
      addAlert('Restarting agent with updated config…');
      try {
        await api.stopAgent();
        await new Promise(r => setTimeout(r, 1000));
        await api.startAgent();
        addAlert('Agent restarted with new config');
      } catch (e2) {
        addAlert(`Agent restart failed: ${e2.message}. Stop and start manually.`);
      }
    }
  } catch (e) {
    if (errorEl) {
      errorEl.textContent = 'Save failed: ' + (e.message || 'unknown error');
      errorEl.style.display = 'inline';
    }
    if (confirmEl) confirmEl.style.display = 'none';
  }
}

// ─── NETWORK SCAN ──────────────────────────────────────────────────────────


async function hydrateNetworkInterfaceSelect() {
  const selects = [document.getElementById('scan-nic'), document.getElementById('wiz-scan-nic')];

  const interfaces = await api.getNetworkInterfaces();
  const hasInterfaces = Array.isArray(interfaces) && interfaces.length > 0;

  const defaultLabel = hasInterfaces ? 'Select interface' : 'No interfaces found';

  selects.forEach((select) => {
    if (!select) return;
    select.innerHTML = '';

    if (!hasInterfaces) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = defaultLabel;
      select.appendChild(opt);
      return;
    }

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = defaultLabel;
    select.appendChild(emptyOpt);

    interfaces.forEach((iface) => {
      const label = `${iface.name} (${iface.ip})`;
      const option = document.createElement('option');
      option.value = iface.name;
      option.textContent = label;
      select.appendChild(option);
    });
  });

  const target = pendingDiscoveryNic || (hasInterfaces ? interfaces[0].name : '');
  if (!target) return;
  const scanSelect = document.getElementById('scan-nic');
  const wizSelect = document.getElementById('wiz-scan-nic');
  if (scanSelect) scanSelect.value = target;
  if (wizSelect) wizSelect.value = target;
  pendingDiscoveryNic = target;
}

async function startNetworkScan() {
  const btn = document.getElementById('scan-btn');
  const panel = document.getElementById('equip-scan-panel');
  const progress = document.getElementById('scan-progress');
  const fill = document.getElementById('scan-fill');
  const status = document.getElementById('scan-status');
  const resultsEl = document.getElementById('scan-results');

  btn.disabled = true;
  btn.textContent = '\u{1F50D} Scanning\u2026';
  if (panel) panel.style.display = '';
  progress.style.display = 'block';
  resultsEl.innerHTML = '';
  fill.style.width = '0%';

  const off = api.onScanProgress(({ percent, message }) => {
    if (percent !== null && percent !== undefined) fill.style.width = percent + '%';
    if (message) {
      status.textContent = message;
      if (message.includes('Found')) {
        const item = document.createElement('div');
        item.className = 'scan-result-item';
        item.textContent = message;
        resultsEl.appendChild(item);
      }
    }
  });

  try {
    const scanNic = document.getElementById('scan-nic');
    const options = scanNic?.value ? { interfaceName: scanNic.value } : {};
    const results = await api.scanNetwork(options);
    fill.style.width = '100%';

    resultsEl.innerHTML = '';
    const total =
      (results.atem || []).length +
      (results.companion || []).length +
      (results.obs || []).length +
      (results.hyperdeck || []).length +
      (results.videohub || []).length +
      (results.propresenter || []).length +
      (results.vmix || []).length +
      (results.resolume || []).length +
      (results.tricaster || []).length +
      (results.birddog || []).length +
      (results.encoders || []).length +
      (results.mixers || []).length;
    status.textContent = `Scan complete: ${total} device${total !== 1 ? 's' : ''} found`;

    // Use addFromScan() to populate deviceState and re-render catalog
    (results.atem || []).forEach(d => addScanResult(resultsEl, `ATEM at ${d.ip}`, () => {
      addFromScan('atem', d);
    }));
    (results.companion || []).forEach(d => addScanResult(resultsEl, `Companion at ${d.ip} (${d.connections} connections)`, () => {
      addFromScan('companion', { ...d, host: d.ip, port: String(d.port || '8888') });
    }));
    (results.obs || []).forEach(d => addScanResult(resultsEl, `OBS at ${d.ip}:${d.port}`, () => {
      addFromScan('obs', d);
    }));
    (results.hyperdeck || []).forEach(d => addScanResult(resultsEl, `HyperDeck at ${d.ip}`, () => {
      addFromScan('hyperdeck', d);
    }));
    (results.videohub || []).forEach(d => addScanResult(resultsEl, `VideoHub at ${d.ip}`, () => {
      addFromScan('videohub', d);
    }));
    (results.propresenter || []).forEach(d => addScanResult(resultsEl, `ProPresenter at ${d.ip}:${d.port}`, () => {
      addFromScan('propresenter', d);
    }));
    (results.vmix || []).forEach(d => addScanResult(resultsEl, `vMix ${d.edition || ''} at ${d.ip}:${d.port}`, () => {
      addFromScan('vmix', d);
    }));
    (results.resolume || []).forEach(d => addScanResult(resultsEl, `${d.version || 'Resolume'} at ${d.ip}:${d.port}`, () => {
      addFromScan('resolume', d);
    }));
    (results.tricaster || []).forEach(d => addScanResult(resultsEl, `TriCaster at ${d.ip}:${d.port}`, () => {
      addFromScan('tricaster', d);
    }));
    (results.birddog || []).forEach(d => addScanResult(resultsEl, `BirdDog at ${d.ip}:${d.port}`, () => {
      addFromScan('birddog', d);
    }));
    (results.mixers || []).forEach(d => addScanResult(resultsEl, `Possible audio console at ${d.ip}:${d.port} (${d.type})`, () => {
      addFromScan('mixers', { ...d, mixerType: d.type });
    }));
  } catch (e) {
    status.textContent = 'Scan failed: ' + e.message;
  } finally {
    if (typeof off === 'function') off();
    btn.disabled = false;
    btn.textContent = '\u{1F50D} Scan Network';
  }
}

function addScanResult(container, label, useFn) {
  const item = document.createElement('div');
  item.className = 'scan-result-item';
  item.innerHTML = `<span style="color:var(--green)">&#10003; ${escapeHtml(label)}</span>`;
  const btn = document.createElement('button');
  btn.className = 'btn-use';
  btn.textContent = 'Add';
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;

    btn.disabled = true;
    btn.textContent = 'Adding…';

    try {
      const maybePromise = useFn && useFn();
      if (maybePromise && typeof maybePromise.then === 'function') {
        await maybePromise;
      }
      item.classList.add('added');
      btn.classList.add('added');
      btn.textContent = 'Added ✓';
      addAlert(`Added ${label}`);
    } catch (e) {
      btn.disabled = false;
      btn.classList.remove('added');
      btn.textContent = 'Retry';
      addAlert(`Failed to add ${label}: ${e.message || 'unknown error'}`);
    }
  });
  item.appendChild(btn);
  container.appendChild(item);
}

// ─── PRE-SERVICE READINESS WIDGET ────────────────────────────────────────────

async function loadPreServiceReadiness() {
  try {
    const data = await api.getPreServiceStatus();
    const widget = document.getElementById('preservice-readiness');
    if (!widget) return;

    if (!data || data.error) {
      widget.style.display = 'none';
      return;
    }

    if (!data.nextServiceMinutes) {
      // No schedule configured
      widget.style.display = '';
      widget.style.opacity = '0.5';
      const text = document.getElementById('readiness-text');
      const icon = document.getElementById('readiness-icon');
      if (icon) icon.textContent = '\u2014';
      if (text) text.textContent = 'No service schedule set \u2014 configure in Equipment tab';
      return;
    }

    if (data.nextServiceMinutes > 60) {
      // Show collapsed/minimal state instead of hiding
      widget.style.display = '';
      widget.style.opacity = '0.6';
      const text = document.getElementById('readiness-text');
      const icon = document.getElementById('readiness-icon');
      const hrs = Math.floor(data.nextServiceMinutes / 60);
      const mins = Math.round(data.nextServiceMinutes % 60);
      const timeStr = mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
      if (icon) icon.textContent = '\u23F0';
      if (text) text.textContent = `Next service in ${timeStr}`;
      return;
    }

    widget.style.opacity = '1';

    const bar = document.getElementById('readiness-bar');
    const icon = document.getElementById('readiness-icon');
    const text = document.getElementById('readiness-text');

    const mins = Math.round(data.nextServiceMinutes);
    const hasIssues = data.issues && data.issues > 0;

    bar.classList.remove('go', 'issues');

    if (hasIssues) {
      bar.classList.add('issues');
      icon.textContent = '\u26A0\uFE0F';
      text.textContent = `Next Service in ${mins}m \u2014 ${data.issues} Issue${data.issues !== 1 ? 's' : ''} Found`;
    } else {
      bar.classList.add('go');
      icon.textContent = '\u2705';
      text.textContent = `Next Service in ${mins}m \u2014 All Systems Go`;
    }

    widget.style.display = '';
  } catch (e) {
    console.warn('Pre-service readiness load failed:', e);
    const widget = document.getElementById('preservice-readiness');
    if (widget) widget.style.display = 'none';
  }
}

// ─── SESSION RECAP CARD ─────────────────────────────────────────────────────

async function loadSessionRecap() {
  try {
    const data = await api.getSessionLatest();
    const card = document.getElementById('session-recap');
    if (!card) return;

    if (data.error || !data.duration) {
      card.style.display = 'none';
      return;
    }

    // Duration formatting
    const durMins = Math.round((data.duration || 0) / 60);
    const durText = durMins >= 60 ? `${Math.floor(durMins / 60)}h ${durMins % 60}m` : `${durMins}m`;
    setStatusValue('val-recap-duration', durText, true);

    // Alerts
    const alerts = data.alerts || 0;
    setStatusValue('val-recap-alerts', String(alerts), alerts === 0);

    // Auto-recoveries
    const recoveries = data.autoRecoveries || 0;
    setStatusValue('val-recap-recoveries', String(recoveries), true);

    // Grade
    const grade = data.grade || '--';
    const gradeEl = document.getElementById('val-recap-grade');
    if (gradeEl) {
      gradeEl.textContent = grade;
      gradeEl.className = 'value';
      const g = grade.toUpperCase().charAt(0);
      if (g === 'A') gradeEl.classList.add('active', 'grade-a');
      else if (g === 'B') gradeEl.classList.add('active', 'grade-b');
      else if (g === 'C') gradeEl.classList.add('grade-c');
      else if (g === 'D') gradeEl.classList.add('grade-d');
      else if (g === 'F') gradeEl.classList.add('grade-f');
      else gradeEl.classList.add('muted');
    }

    // Peak viewers
    const viewers = data.peakViewers || 0;
    setStatusValue('val-recap-viewers', String(viewers), viewers > 0);

    card.style.display = '';
  } catch (e) {
    console.warn('Session recap load failed:', e);
  }
}

function toggleSessionRecap() {
  const body = document.getElementById('session-recap-body');
  const chevron = document.getElementById('session-recap-chevron');
  if (!body) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : '';
  if (chevron) chevron.classList.toggle('open', !isOpen);
}

// ─── AUTO-START TOGGLE ──────────────────────────────────────────────────────

async function loadAutoStartSetting() {
  try {
    const result = await api.getAutoStart();
    const cb = document.getElementById('autostart-checkbox');
    if (cb) cb.checked = !!result.enabled;
  } catch {}
}

async function toggleAutoStart(enabled) {
  try {
    await api.setAutoStart(enabled);
  } catch (e) {
    addAlert(`Auto-start save failed: ${e.message}`);
  }
}

// ─── KEYBOARD SHORTCUTS ─────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Don't fire when input fields, textareas, or selects are focused
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (document.activeElement?.isContentEditable) return;

  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;

  if (e.key === '1') { e.preventDefault(); switchTab('status'); }
  else if (e.key === '2') { e.preventDefault(); switchTab('equipment'); }
  else if (e.key === '3') { e.preventDefault(); switchTab('engineer'); }
});

// External link handler
document.addEventListener('click', (e) => {
  const link = e.target.closest('.ext-link');
  if (link) { e.preventDefault(); api.openExternal(link.dataset.url); }
});

// ─── CLEANUP ON UNLOAD ──────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (_reconnectCountdownTimer) { clearInterval(_reconnectCountdownTimer); _reconnectCountdownTimer = null; }
  if (_preServiceRefreshTimer) { clearInterval(_preServiceRefreshTimer); _preServiceRefreshTimer = null; }
  if (_staleDisplayTimer) { clearInterval(_staleDisplayTimer); _staleDisplayTimer = null; }
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
});

init();
