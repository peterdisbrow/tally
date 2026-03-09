const api = window.electronAPI;
const TOTAL_STEPS = 3;
let currentStep = 1;
let isRunning = false;
let alertCount = 0;
let pendingDiscoveryNic = '';
let _audioViaAtem = false; // synced from relay — true if church routes audio directly into ATEM
const DEFAULT_RELAY_URL = 'wss://api.tallyconnect.app';

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
  hint.textContent = 'Please restart the app. If the problem continues, contact your tech director or visit atemschool.com/help.';
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

// ─── INIT ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    if (!api) throw new Error('Desktop bridge unavailable (window.electronAPI missing).');

    if (/^mac/i.test(navigator.platform)) document.body.classList.add('is-mac');
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

    // Listen for mid-session auth invalidation
    api.onAuthInvalid(() => {
      showSignIn();
      showSignInMessage('Session was invalidated by the server. Please sign in again.', 'var(--warn)');
    });

    const config = await api.getConfig();
    isRunning = await api.isRunning();
    _audioViaAtem = !!(config.audioViaAtem);

    if (config.token) {
      // Returning user — validate token silently
      showSignInLoading('Checking your account...');
      document.body.classList.add('ready');

      const result = await api.validateToken();
      // Re-read config after validation — validateToken may sync profile flags from relay
      try { const freshConfig = await api.getConfig(); _audioViaAtem = !!(freshConfig.audioViaAtem); } catch {}
      if (result.valid) {
        // Token is good — go to dashboard
        if (config.name) document.getElementById('church-name').textContent = config.name;
        if (config.setupComplete) {
          showDashboard();
          try { await api.startAgent(); isRunning = true; } catch (e) { addAlert(`❌ Agent start failed: ${e.message}`); }
          updateToggleBtn();
        } else {
          showEquipmentWizard();
        }
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
    // Load pre-service check hero panel
    loadPreServiceCheck();
    // Load rundown panel
    loadRundownPanel();
    // Initialize Problem Finder real-time listener
    if (typeof initProblemFinderListener === 'function') initProblemFinderListener();
  } catch (err) {
    console.error('Init failed:', err);
    showFatalInitError(err?.message || 'Unknown initialization error');
    document.body.classList.add('ready');
  }
}

// ─── WIZARD ────────────────────────────────────────────────────────────────

function hideAllViews() {
  document.getElementById('sign-in').classList.remove('active');
  document.getElementById('wizard').classList.remove('active');
  document.getElementById('dashboard').classList.remove('active');
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
  renderStepIndicator();
  goToStep(1);
  // Auto-start network scan when wizard opens
  wizardAutoScan();
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
      ndi: 'NDI Decoder', yolobox: 'YoloBox', 'tally-encoder': 'Tally Encoder', custom: 'Custom',
      'custom-rtmp': 'Custom RTMP', 'rtmp-generic': 'RTMP', 'atem-streaming': 'ATEM Mini',
    };
    const label = encNames[eq.encoderType] || 'Encoder';
    const dotLabel = document.getElementById('dot-encoder-label');
    if (dotLabel) dotLabel.textContent = label;
    const sectionTitle = document.getElementById('encoder-section-title');
    if (sectionTitle) sectionTitle.textContent = label;
    // Cache for NDI status display
    window._savedEquipment = eq;
    // Show/hide NDI section + dot
    const ndiConfigured = !!(eq.ndiSource && String(eq.ndiSource).trim());
    const ndiSection = document.getElementById('ndi-status-section');
    const ndiChip = document.getElementById('dot-ndi-chip');
    if (ndiSection) ndiSection.style.display = ndiConfigured ? '' : 'none';
    if (ndiChip) ndiChip.style.display = ndiConfigured ? '' : 'none';
  } catch { /* ignore — status updates will set it later */ }
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

async function doSignIn() {
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
      await api.saveConfig({ token, relay, name: churchName });

      // Check if setup is already complete
      const config = await api.getConfig();
      if (config.name) document.getElementById('church-name').textContent = config.name;

      if (config.setupComplete) {
        showDashboard();
        try { await api.startAgent(); isRunning = true; } catch (e) { addAlert(`❌ Agent start failed: ${e.message}`); }
        updateToggleBtn();
      } else {
        showEquipmentWizard();
      }
    } else {
      showSignInMessage(`Sign-in failed: ${result.error || result.data?.error || 'connection issue'}`, 'var(--warn)');
    }
  } catch (e) {
    showSignInMessage(`Sign-in error: ${e.message}`, 'var(--danger)');
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
    addAlert(`❌ Sign-out failed: ${e.message}`);
  }
}

function renderStepIndicator() {
  const el = document.getElementById('step-indicator');
  el.innerHTML = '';
  for (let i = 1; i <= TOTAL_STEPS; i++) {
    const dot = document.createElement('div');
    dot.className = 'step-dot' + (i === currentStep ? ' active' : '') + (i < currentStep ? ' done' : '');
    el.appendChild(dot);
  }
}

function goToStep(n) {
  currentStep = n;
  document.querySelectorAll('.wizard-step').forEach(s => s.classList.remove('active'));
  const step = document.querySelector(`.wizard-step[data-step="${n}"]`);
  if (step) step.classList.add('active');
  renderStepIndicator();

  const back = document.getElementById('wiz-back');
  const next = document.getElementById('wiz-next');
  back.style.display = n > 1 ? '' : 'none';
  next.textContent = n === TOTAL_STEPS ? 'Finish & Connect' : 'Next →';

  // Render dynamic encoder fields when step 1 manual config is visible
  if (n === 1 && typeof onWizEncoderTypeChanged === 'function') {
    onWizEncoderTypeChanged();
  }
}

function isValidIpOrHostname(value) {
  if (!value) return true; // empty = skipped, OK
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(value)) {
    return value.split('.').every(n => parseInt(n) >= 0 && parseInt(n) <= 255);
  }
  // Accept hostnames like "localhost", "my-obs.local", etc.
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function showWizardHint(msg) {
  // Non-blocking inline validation hint (replaces alert())
  const existing = document.querySelector('.wizard-hint-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'wizard-hint-toast';
  toast.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;background:rgba(234,179,8,0.15);border:1px solid rgba(234,179,8,0.4);color:#fde68a;padding:8px 18px;border-radius:8px;font-size:12px;font-family:var(--font);max-width:340px;text-align:center;animation:fadeInOut 3s ease forwards;';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function wizardValidateStep(step) {
  if (step === 1) {
    // Validate manual ATEM IP if provided
    const ip = document.getElementById('wiz-atem').value.trim();
    if (ip && !isValidIpOrHostname(ip)) {
      showWizardHint('Please enter a valid IP address (e.g. 192.168.1.10) or leave blank to skip.');
      return false;
    }
    // Validate manual encoder host if provided
    const type = document.getElementById('wiz-encoder-type')?.value;
    const hostEl = document.getElementById('wiz-encoder-host');
    const needsHost = ['obs', 'vmix', 'blackmagic', 'aja', 'epiphan', 'teradek', 'tricaster', 'birddog', 'custom'].includes(type);
    if (needsHost && hostEl) {
      const host = hostEl.value.trim();
      if (host && !isValidIpOrHostname(host)) {
        showWizardHint('Please enter a valid encoder IP or hostname.');
        return false;
      }
    }
  }
  return true;
}

async function wizardNext() {
  if (currentStep < TOTAL_STEPS) {
    if (!wizardValidateStep(currentStep)) return;

    // Step 1 → 2: Apply discovered/manual devices before advancing
    if (currentStep === 1) {
      applyWizardDevices();
    }

    goToStep(currentStep + 1);

    if (currentStep === TOTAL_STEPS) {
      // Step 3 (Done) — save equipment config, engineer profile, mark setup complete
      const encType = document.getElementById('wiz-encoder-type')?.value || '';
      const encHostEl = document.getElementById('wiz-encoder-host');
      const encPortEl = document.getElementById('wiz-encoder-port');
      const encPwEl = document.getElementById('wiz-encoder-password');
      const encLabelEl = document.getElementById('wiz-encoder-label');
      const encStatusUrlEl = document.getElementById('wiz-encoder-status-url');
      const encSourceEl = document.getElementById('wiz-encoder-source');

      const equipConfig = {
        atemIp: document.getElementById('wiz-atem')?.value.trim() || '',
        companionUrl: (() => {
          const h = (document.getElementById('wiz-companion-host')?.value || '').trim();
          const p = (document.getElementById('wiz-companion-port')?.value || '').trim() || '8888';
          return h ? `http://${h}:${p}` : '';
        })(),
        name: (document.getElementById('wiz-name')?.value || '').trim(),
        liveStreamUrl: (document.getElementById('wiz-livestream')?.value || '').trim(),
        encoderType: encType,
        encoderHost: encHostEl ? encHostEl.value.trim() : '',
        encoderPort: encPortEl ? parseInt(encPortEl.value) || 0 : 0,
        encoderPassword: encPwEl ? encPwEl.value : '',
        encoderLabel: encLabelEl ? encLabelEl.value.trim() : '',
        encoderStatusUrl: encStatusUrlEl ? encStatusUrlEl.value.trim() : '',
        encoderSource: encSourceEl ? encSourceEl.value.trim() : '',
        obsPassword: encType === 'obs' && encPwEl ? encPwEl.value : '',
        setupComplete: true,
      };
      await api.saveConfig(equipConfig);

      // Save engineer profile to relay server
      const engineerProfile = {
        streamPlatform: document.getElementById('wiz-stream-platform')?.value || '',
        expectedViewers: document.getElementById('wiz-expected-viewers')?.value || '',
        operatorLevel: document.getElementById('wiz-operator-level')?.value || '',
        backupEncoder: document.getElementById('wiz-backup-encoder')?.value || '',
        backupSwitcher: document.getElementById('wiz-backup-switcher')?.value || '',
        specialNotes: (document.getElementById('wiz-special-notes')?.value || '').trim(),
      };
      api.saveEngineerProfile(engineerProfile).catch(() => {
        console.warn('Engineer profile save failed — will retry on next session');
      });

      // Test connection
      const config = await api.getConfig();
      const el = document.getElementById('test-result');
      el.innerHTML = '<span class="spinner-inline"></span> Testing connection\u2026';
      el.style.color = 'var(--muted)';
      const result = await api.testConnection({ url: config.relay, token: config.token });
      if (result.success) {
        el.innerHTML = '\u25CF Connected to relay server!';
        el.style.color = 'var(--green)';
      } else {
        el.textContent = `\u26A0 Could not reach relay: ${result.error}`;
        el.style.color = 'var(--warn)';
      }
    }
  } else {
    // Finish — go to dashboard and start agent
    showDashboard();
    const config = await api.getConfig();
    if (config.name) document.getElementById('church-name').textContent = config.name;
    try { await api.startAgent(); isRunning = true; } catch (e) { addAlert(`\u274C Agent start failed: ${e.message}`); }
    updateToggleBtn();
  }
}


function wizardBack() {
  if (currentStep > 1) goToStep(currentStep - 1);
}

function onWizEncoderTypeChanged() {
  const type = document.getElementById('wiz-encoder-type').value;
  const container = document.getElementById('wiz-encoder-fields');
  const saved = window._encoderConfig || {};

  const apiTypes = ['obs', 'vmix', 'blackmagic', 'aja', 'epiphan', 'teradek', 'tricaster', 'birddog', 'tally-encoder', 'custom'];

  if (type === 'atem-streaming') {
    container.innerHTML = `<div style="margin-top:10px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:6px; font-size:11px; color:var(--muted); line-height:1.5;">
      Streaming is handled by the ATEM Mini's built-in encoder.<br>Stream status is monitored through your ATEM connection — no extra configuration needed.
    </div>`;
    return;
  }

  if (type === 'ecamm') {
    container.innerHTML = `<div style="margin-top:10px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:6px; font-size:11px; color:var(--muted); line-height:1.5;">
      Ecamm Live runs locally on your Mac. Port is auto-detected via Bonjour (fallback 65194).<br>No configuration needed — just make sure Ecamm Live is running.
    </div>`;
    return;
  }

  if (apiTypes.includes(type)) {
    const defaults = {
      obs:              { host: 'localhost', port: '4455', pw: true, note: 'WebSocket v5 — status, start/stop, scenes' },
      vmix:             { host: 'localhost', port: '8088', note: 'HTTP API — streaming, recording, inputs' },
      blackmagic:       { host: '', port: '80', note: 'REST API — start/stop, platform config, bitrate' },
      aja:              { host: '', port: '80', pw: true, note: 'REST API — stream/record, profiles, inputs, presets' },
      epiphan:          { host: '', port: '80', pw: true, note: 'REST API v2 — channels, publishers, recorders, layouts' },
      teradek:          { host: '', port: '80', pw: true, note: 'CGI API — broadcast, recording, battery, video input' },
      tricaster:        { host: '', port: '5951', pw: true, note: 'Shortcut API — stream/record transport and production state' },
      birddog:          { host: '', port: '8080', source: true, note: 'BirdDog API + optional NDI source monitoring' },
      'tally-encoder':  { host: '', port: '7070', note: 'Streams to relay server for tally monitoring' },
      custom:           { host: '', port: '80', statusUrl: true, note: 'Custom HTTP status endpoint' },
    };
    const d = defaults[type] || { host: '', port: '' };
    const useSaved = (saved._type || '') === type;
    const h = useSaved ? (saved.host || d.host) : d.host;
    const p = useSaved ? (saved.port || d.port) : d.port;
    let html = '';
    if (d.note) {
      html += `<div style="margin-top:8px; font-size:10px; color:var(--dim); font-family:var(--mono);">${d.note}</div>`;
    }
    html += `<div style="display:flex; gap:8px; margin-top:8px;">
      <input type="text" id="wiz-encoder-host" placeholder="${d.host || 'IP address'}" value="${h}" style="flex:1;">
      <input type="text" id="wiz-encoder-port" placeholder="${d.port}" value="${p}" style="max-width:80px;">
    </div>`;
    if (d.pw) {
      html += `<div style="margin-top:6px;">
        <input type="password" id="wiz-encoder-password" placeholder="Password (optional)" value="${saved.password || ''}" style="width:100%;">
      </div>`;
    }
    if (d.statusUrl) {
      html += `<div style="margin-top:6px;">
        <input type="text" id="wiz-encoder-status-url" placeholder="Status endpoint (e.g. /status)" value="${saved.statusUrl || '/status'}" style="width:100%;">
      </div>
      <div style="margin-top:6px;">
        <input type="text" id="wiz-encoder-label" placeholder="Device label (optional)" value="${saved.label || ''}" style="width:100%;">
      </div>`;
    } else if (d.source) {
      html += `<div style="margin-top:6px;">
        <input type="text" id="wiz-encoder-source" placeholder="NDI source name (optional)" value="${saved.source || ''}" style="width:100%;">
      </div>
      <div style="margin-top:6px;">
        <input type="text" id="wiz-encoder-label" placeholder="Device label (optional)" value="${saved.label || ''}" style="width:100%;">
      </div>`;
    }
    container.innerHTML = html;
    return;
  }

  if (type === 'yolobox') {
    container.innerHTML = `<div style="margin-top:10px; padding:10px; background:var(--card); border:1px solid var(--border); border-radius:6px; font-size:11px; color:var(--muted); line-height:1.5;">
      YoloBox streams directly to your CDN and has no public control API.<br>
      Optional: enter YoloBox IP/port for reachability checks (no transport control).
    </div>
    <div style="display:flex; gap:8px; margin-top:8px;">
      <input type="text" id="wiz-encoder-host" placeholder="YoloBox IP (optional)" value="">
      <input type="text" id="wiz-encoder-port" placeholder="80" value="80" style="max-width:80px;">
    </div>
    <div style="margin-top:6px;">
      <input type="text" id="wiz-encoder-label" placeholder="Device label (optional)" style="width:100%;">
    </div>`;
    return;
  }

  container.innerHTML = '';
}

// ─── WIZARD AUTO-DISCOVERY ─────────────────────────────────────────────────

let _wizScanResults = null;
let _wizCheckedDevices = {};

const DEVICE_TYPE_LABELS = {
  atem: 'ATEM Switcher', companion: 'Companion', obs: 'OBS Studio', hyperdeck: 'HyperDeck',
  propresenter: 'ProPresenter', vmix: 'vMix', resolume: 'Resolume', tricaster: 'TriCaster',
  birddog: 'BirdDog', videohub: 'VideoHub', mixers: 'Audio Mixer', encoders: 'Encoder',
  ptz: 'PTZ Camera', ndi: 'NDI Source',
};

async function wizardAutoScan() {
  const fill = document.getElementById('wiz-scan-fill');
  const status = document.getElementById('wiz-scan-status');
  const devicesEl = document.getElementById('wiz-discovered-devices');
  const rescanBtn = document.getElementById('btn-scan');
  const progressEl = document.getElementById('wiz-scan-progress');
  const wizSelect = document.getElementById('wiz-scan-nic');
  const selectedInterface = wizSelect?.value || pendingDiscoveryNic || '';

  if (fill) fill.style.width = '0%';
  if (status) status.textContent = 'Scanning your network for devices...';
  if (progressEl) progressEl.style.display = '';
  if (devicesEl) devicesEl.style.display = 'none';
  if (rescanBtn) rescanBtn.style.display = 'none';

  // Listen for scan progress updates
  const removeScanListener = api.onScanProgress(({ percent, message }) => {
    if (fill) fill.style.width = `${percent}%`;
    if (status) status.textContent = message || `Scanning... ${percent}%`;
  });

  try {
    const options = selectedInterface ? { interfaceName: selectedInterface } : {};
    const results = await api.scanNetwork(options);
    _wizScanResults = results;

    if (fill) fill.style.width = '100%';
    renderDiscoveredDevices(results);
  } catch (err) {
    if (status) status.textContent = `Scan failed: ${err.message}`;
    if (rescanBtn) rescanBtn.style.display = '';
  } finally {
    if (removeScanListener) removeScanListener();
  }
}

function renderDiscoveredDevices(results) {
  const devicesEl = document.getElementById('wiz-discovered-devices');
  const statusEl = document.getElementById('wiz-scan-status');
  const progressEl = document.getElementById('wiz-scan-progress');
  const rescanBtn = document.getElementById('btn-scan');
  if (!devicesEl) return;

  // Count total discovered devices
  let totalDevices = 0;
  const deviceRows = [];

  for (const [category, devices] of Object.entries(results)) {
    if (!Array.isArray(devices) || devices.length === 0) continue;
    for (const device of devices) {
      totalDevices++;
      const label = DEVICE_TYPE_LABELS[category] || category;
      const ip = device.ip || device.host || '';
      const name = device.name || device.model || '';
      const key = `${category}-${ip}-${name}`;
      if (_wizCheckedDevices[key] === undefined) _wizCheckedDevices[key] = true; // default checked
      deviceRows.push({ category, label, ip, name, key, device });
    }
  }

  if (totalDevices === 0) {
    if (statusEl) statusEl.textContent = 'No devices found on this network.';
    devicesEl.style.display = 'none';
    if (rescanBtn) rescanBtn.style.display = '';
    // Open manual config automatically
    const manual = document.getElementById('wiz-manual-config');
    if (manual) manual.open = true;
    return;
  }

  if (progressEl) progressEl.style.display = 'none';
  if (statusEl) statusEl.textContent = `Found ${totalDevices} device${totalDevices !== 1 ? 's' : ''} on your network`;

  let html = '<div style="display:flex; flex-direction:column; gap:4px;">';
  for (const row of deviceRows) {
    const checked = _wizCheckedDevices[row.key] ? 'checked' : '';
    html += `<label style="display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--card); border:1px solid var(--border); border-radius:6px; cursor:pointer; font-family:var(--mono); font-size:12px;">
      <input type="checkbox" ${checked} onchange="toggleWizDevice('${row.key}')" style="accent-color:var(--green);">
      <span style="color:var(--green); font-weight:700; min-width:110px;">${escapeText(row.label)}</span>
      <span style="color:var(--muted);">${escapeText(row.ip)}</span>
      ${row.name ? `<span style="color:var(--dim); font-size:10px;">${escapeText(row.name)}</span>` : ''}
    </label>`;
  }
  html += '</div>';

  devicesEl.innerHTML = html;
  devicesEl.style.display = '';
  if (rescanBtn) rescanBtn.style.display = '';
}

function toggleWizDevice(key) {
  _wizCheckedDevices[key] = !_wizCheckedDevices[key];
}

function wizardRescan() {
  _wizScanResults = null;
  _wizCheckedDevices = {};
  wizardAutoScan();
}

function applyWizardDevices() {
  if (!_wizScanResults) return;
  // Apply checked scan results to manual fields (for config save)
  for (const [category, devices] of Object.entries(_wizScanResults)) {
    if (!Array.isArray(devices) || devices.length === 0) continue;
    for (const device of devices) {
      const ip = device.ip || device.host || '';
      const name = device.name || device.model || '';
      const key = `${category}-${ip}-${name}`;
      if (!_wizCheckedDevices[key]) continue; // unchecked, skip

      // Apply primary device to wizard fields
      if (category === 'atem' && ip) {
        const el = document.getElementById('wiz-atem');
        if (el && !el.value.trim()) el.value = ip;
      }
      if (category === 'companion' && ip) {
        const el = document.getElementById('wiz-companion-host');
        if (el && !el.value.trim()) el.value = ip;
      }
      if (category === 'obs' && ip) {
        const typeEl = document.getElementById('wiz-encoder-type');
        if (typeEl && !typeEl.value) { typeEl.value = 'obs'; onWizEncoderTypeChanged(); }
        const hostEl = document.getElementById('wiz-encoder-host');
        if (hostEl && !hostEl.value.trim()) hostEl.value = ip;
      }

      // Apply to equipment-ui device state (if equipment-ui is loaded)
      if (typeof addFromScan === 'function') {
        addFromScan(category, device);
      }
    }
  }
}

// Legacy alias for backward compat
async function scanForATEM() { wizardRescan(); }

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
    }
    // Reload panel after a short delay (check runs async on server)
    setTimeout(() => loadPreServiceCheck(), 2000);
  } catch (e) {
    console.warn('Pre-service check run failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Run Check Now'; }
  }
}

async function fixAllPreService() {
  const btn = document.getElementById('preservice-fix-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fixing\u2026'; }
  try {
    const result = await api.fixAllPreService();
    if (result && result.results) {
      const fixed = result.results.filter(r => r.success).length;
      const failed = result.results.length - fixed;
      if (btn) btn.textContent = failed > 0 ? `${fixed} fixed, ${failed} failed` : `${fixed} fixed`;
    }
    // Reload panel after fixes
    setTimeout(() => loadPreServiceCheck(), 3000);
  } catch (e) {
    console.warn('Pre-service fix-all failed:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Fix All'; }
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

  // Progress
  const progressEl = document.getElementById('rundown-progress');
  if (progressEl) {
    progressEl.textContent = `${escapeText(data.rundownName || data.rundown?.name || 'Rundown')} \u2014 Step ${currentIdx + 1} of ${steps.length}`;
  }

  // Current step card
  const currentEl = document.getElementById('rundown-current-step');
  if (currentEl && currentStep) {
    currentEl.innerHTML = `<div class="step-label">${escapeText(currentStep.label || 'Step ' + (currentIdx + 1))}</div>`
      + (currentStep.notes ? `<div class="step-notes">${escapeText(currentStep.notes)}</div>` : '');
  }

  // Next up preview
  const nextEl = document.getElementById('rundown-next');
  if (nextEl) {
    nextEl.textContent = nextStep ? `Next: ${nextStep.label || 'Step ' + (currentIdx + 2)}` : 'Last step';
  }

  // Disable advance on last step
  const advBtn = document.getElementById('rundown-advance-btn');
  if (advBtn) advBtn.disabled = currentIdx >= steps.length - 1;

  // Steps sidebar list
  const listEl = document.getElementById('rundown-steps-list');
  if (listEl) {
    listEl.innerHTML = steps.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
      const icon = i < currentIdx ? '\u2713' : i === currentIdx ? '\u25B6' : '\u25CB';
      return `<div class="rundown-step-item ${cls}">${icon} ${escapeText(s.label || 'Step ' + (i + 1))}</div>`;
    }).join('');
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
  try {
    await api.deactivateRundown();
    loadRundownPanel();
  } catch (e) {
    console.warn('Deactivate rundown failed:', e);
  }
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────────

function updateStatusUI(status) {
  setDot('relay', status.relay);
  setDot('atem', status.atem);
  setDot('companion', status.companion);

  // ── Offline / disconnection banner ──────────────────────────────────────
  const relayOk = getStatusActive(status.relay);
  const offlineBanner = document.getElementById('offline-banner');
  if (offlineBanner) {
    if (!relayOk && !navigator.onLine) {
      offlineBanner.textContent = '⚠ No internet — check your Wi-Fi or network cable. Monitoring is paused.';
      offlineBanner.style.display = '';
    } else if (!relayOk) {
      offlineBanner.textContent = '⚠ Can\'t reach the server — this usually resolves on its own. Monitoring is paused.';
      offlineBanner.style.display = '';
    } else {
      offlineBanner.style.display = 'none';
    }
  }

  // ── Dynamic encoder dot + label ─────────────────────────────────────────
  const encoderLabel = status.encoderType || 'Encoder';
  const encoderLabelEl = document.getElementById('dot-encoder-label');
  if (encoderLabelEl) encoderLabelEl.textContent = encoderLabel;

  const encoderTitleEl = document.getElementById('encoder-section-title');
  if (encoderTitleEl) encoderTitleEl.textContent = encoderLabel;

  // Encoder dot: use encoder status if managed, fallback to OBS
  const encoderConnected = status.encoder || getStatusActive(status.obs);
  setDot('encoder', encoderConnected);

  const atemConnected = getStatusActive(status.atem);
  const companionConnected = getStatusActive(status.companion);
  const relayConnected = getStatusActive(status.relay);

  const obsData = status.obs && typeof status.obs === 'object' ? status.obs : {};
  const atemData = status.atem && typeof status.atem === 'object' ? status.atem : {};
  const streaming = status.streaming ?? obsData.streaming;
  const fps = status.fps ?? obsData.fps;
  const bitrate = status.bitrate ?? obsData.bitrate ?? null;

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

  if (atemData.recording !== undefined) {
    setStatusValue('val-recording', atemData.recording ? '● Recording' : 'Stopped', atemData.recording === true);
  } else if (!atemConnected) {
    setStatusValue('val-recording', '—', false);
  }

  if (typeof companionConnected === 'boolean') {
    setStatusValue('val-companion', companionConnected ? 'Connected' : 'Disconnected', companionConnected);
  } else if (!relayConnected) {
    setStatusValue('val-companion', '—', false);
  }

  // ── Streaming encoder status cards ──────────────────────────────────────
  if (typeof streaming === 'boolean') {
    setStatusValue('val-stream', streaming ? '● LIVE' : 'Off', streaming);
  } else if (!encoderConnected) {
    setStatusValue('val-stream', '—', false);
  }

  if (typeof fps === 'number' && Number.isFinite(fps)) {
    const fpsValue = Math.round(fps);
    const fpsHealthy = fpsValue >= 24;
    setStatusValue('val-fps', String(fpsValue), fpsHealthy);
  } else if (!encoderConnected) {
    setStatusValue('val-fps', '—', false);
  }

  // Bitrate card
  if (typeof bitrate === 'number' && bitrate > 0) {
    const brText = bitrate >= 1000 ? `${(bitrate / 1000).toFixed(1)} Mbps` : `${bitrate} Kbps`;
    setStatusValue('val-bitrate', brText, true);
  } else {
    setStatusValue('val-bitrate', '—', false);
  }

  // Audio status card
  const audio = status.audio || {};
  const mixerData = status.mixer && typeof status.mixer === 'object' ? status.mixer : {};
  const mixerConnected = mixerData.connected || false;
  if (audio.masterMuted || mixerData.mainMuted) {
    setStatusValue('val-audio', '🔇 MUTED', false);
  } else if (audio.silenceDetected) {
    setStatusValue('val-audio', '⚠ Silence', false);
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
      delayEl.textContent = `⚠ Cam ${progInput}: ${progDelay}ms audio delay`;
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

  const vmixData = status.vmix && typeof status.vmix === 'object' ? status.vmix : {};
  const vmixIdentity = vmixData.edition ? `${vmixData.edition}${vmixData.version ? ` ${vmixData.version}` : ''}` : '';
  if (vmixIdentity) setStatusValue('val-id-vmix', vmixIdentity, getStatusActive(vmixData));
  else setStatusValue('val-id-vmix', '—', false);

  const resolumeData = status.resolume && typeof status.resolume === 'object' ? status.resolume : {};
  const resolumeIdentity = resolumeData.version ? String(resolumeData.version) : '';
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

  // NDI Decoder status (independent of encoder)
  updateNdiStatus(status);
}

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
  if (typeof active === 'boolean') return active ? 'green' : 'red';
  if (typeof active === 'number') return active > 0 ? 'green' : 'red';

  if (active && typeof active === 'object') {
    const rawStatus = typeof active.status === 'string' ? active.status.toLowerCase() : '';

    if (
      active.connected === false ||
      active.online === false ||
      active.active === false ||
      active.streaming === false ||
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
      active.connected === true ||
      active.online === true ||
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
  chip.classList.remove('ok', 'warn', 'err', 'active');
  if (state === 'green') chip.classList.add('active', 'ok');
  else if (state === 'yellow') chip.classList.add('warn');
  else if (state === 'red') chip.classList.add('err');
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
      await api.startAgent();
      isRunning = true;
    }
  } catch (e) {
    addAlert(`❌ Agent ${isRunning ? 'stop' : 'start'} failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    updateToggleBtn();
  }
}

async function testConn() {
  const config = await api.getConfig();
  const relay = config.relay || DEFAULT_RELAY_URL;
  const token = config.token || '';
  const result = await api.testConnection({ url: relay, token });
  addAlert(result.success ? '✅ Relay connection OK' : `❌ Relay unreachable: ${result.error}`);
}

async function exportLogs() {
  if (!api?.exportTestLogs) {
    addAlert('❌ Export logs is unavailable in this build.');
    return;
  }

  try {
    const result = await api.exportTestLogs();
    if (result?.canceled) {
      addAlert('Log export canceled');
      return;
    }
    if (result?.error) {
      addAlert(`❌ Log export failed: ${result.error}`);
      return;
    }
    addAlert(`✅ Logs exported: ${result.filePath || 'saved'}`);
  } catch (e) {
    addAlert(`❌ Log export failed: ${e.message}`);
  }
}

function detectActivityType(text) {
  const t = text.toLowerCase();
  // AI commands / Telegram executed
  if (t.includes('🤖') || t.includes('[ai]') || t.includes('telegram') || t.includes('command executed') || t.includes('ai parsed') || t.includes('via telegram')) return 'ai';
  // Hard alerts / errors
  if (t.includes('❌') || t.includes('⚠️') || t.includes('alert') || t.includes('silence') || t.includes('drop') || t.includes('disconnect') || t.includes('unreachable') || t.includes('failed') || t.includes('error') || t.includes('offline') || t.includes('no audio')) return 'alert';
  // Confirmations / OK
  if (t.includes('✅') || t.includes('ok') || t.includes('connected') || t.includes('recording started') || t.includes('stream started') || t.includes('started') || t.includes('confirmed') || t.includes('saved ✓') || t.includes('complete') || t.includes('preview requested')) return 'ok';
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
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

function addAlert(text) {
  addActivity(detectActivityType(text), text);
}

// ─── IPC listeners ─────────────────────────────────────────────────────────

api.onStatus((status) => {
  updateStatusUI(status);
});

// Periodically refresh pre-service panel (every 5 minutes when dashboard is visible)
let _preServiceRefreshTimer = null;
function startPreServiceRefresh() {
  if (_preServiceRefreshTimer) return;
  _preServiceRefreshTimer = setInterval(() => {
    const panel = document.getElementById('preservice-panel');
    if (panel) loadPreServiceCheck();
  }, 5 * 60 * 1000);
}
startPreServiceRefresh();

api.onLog((text) => {
  const t = text.trim();
  // Show important operational events in the activity feed
  if (
    t.includes('ALERT') || t.includes('✅') || t.includes('⚠️') || t.includes('❌') ||
    t.includes('Stream') || t.includes('Recording') ||
    t.includes('connected') || t.includes('disconnected') || t.includes('Connected') || t.includes('Disconnected') ||
    t.includes('MUTED') || t.includes('silence') || t.includes('Audio') ||
    t.includes('Encoder') || t.includes('Companion') || t.includes('ATEM') ||
    t.includes('Relay') || t.includes('error') || t.includes('failed') ||
    t.includes('🤖') || t.includes('[AI]') || t.includes('Telegram') ||
    t.includes('Low FPS') || t.includes('bitrate')
  ) {
    addAlert(t);
  }

  // Status UI is driven by onStatus() — log handler only feeds the activity log.
});

// ─── PREVIEW ───────────────────────────────────────────────────────────────

let lastPreviewTime = 0;
let previewTimeout = null;

async function requestPreview() {
  addAlert('📸 Preview requested');
  addAlert('Waiting for preview frames…');
  try {
    const result = await api.requestPreview('start');
    if (!result?.success) throw new Error(result?.error || 'preview command failed');
  } catch (e) {
    addAlert(`⚠ Preview request failed: ${e.message}`);
  }
}

async function stopPreview() {
  const container = document.getElementById('preview-container');
  container.classList.remove('has-image');
  document.getElementById('preview-img').style.display = 'none';
  document.getElementById('preview-placeholder').style.display = 'flex';
  document.getElementById('preview-placeholder').textContent = 'No preview yet';
  document.getElementById('preview-ts').textContent = '';
  addAlert('⏹ Preview stopped');
  try {
    await api.requestPreview('stop');
  } catch (e) {
    // no-op: UI-level best effort
  }
}

function handlePreviewFrame(data) {
  const img = document.getElementById('preview-img');
  const placeholder = document.getElementById('preview-placeholder');
  const tsEl = document.getElementById('preview-ts');
  const container = document.getElementById('preview-container');

  img.src = 'data:image/jpeg;base64,' + data.data;
  img.style.display = 'block';
  placeholder.style.display = 'none';
  container.classList.add('has-image');
  lastPreviewTime = Date.now();
  tsEl.textContent = new Date(data.timestamp).toLocaleTimeString();

  clearTimeout(previewTimeout);
  previewTimeout = setTimeout(() => {
    if (Date.now() - lastPreviewTime > 14000) {
      img.style.display = 'none';
      placeholder.style.display = 'flex';
      placeholder.textContent = 'Preview unavailable (timeout)';
      container.classList.remove('has-image');
    }
  }, 15000);
}

// Live stream URL
async function setupLiveStreamLink() {
  const config = await api.getConfig();
  const el = document.getElementById('live-stream-link');
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
setupLiveStreamLink();

api.onPreviewFrame((data) => {
  handlePreviewFrame(data);
});

api.onUpdateReady(() => {
  addAlert('🔄 Update downloaded — restart to install');
});

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
}

// ─── CHAT ───────────────────────────────────────────────────────────────────

let chatMessages = [];
let chatLastTimestamp = null;
let chatPollInterval = null;
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
  // Only load today's messages (since midnight local) — latest 200 so we
  // show the most recent conversation, not stale messages from hours ago.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const resp = await api.getChat({ since: today.toISOString(), latest: true, limit: 200 });
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
      chatMessages.push({ id: Date.now(), senderName: 'System', senderRole: 'system', message: `❌ ${resp.error}`, timestamp: new Date().toISOString() });
      renderChat();
    }
    return;
  }

  if (!message) return;
  input.value = '';
  try {
    const resp = await api.sendChat({ message });
    if (resp?.error) {
      input.value = message; // Restore so user can retry
      addAlert(`❌ Message failed: ${resp.error}`);
    } else if (resp?.id) {
      chatMessages.push(resp);
      chatLastTimestamp = resp.timestamp;
      renderChat();
    }
  } catch (e) {
    input.value = message; // Restore so user can retry
    addAlert(`❌ Message failed: ${e.message}`);
  }
}

// ─── QUICK CHAT (Status tab) ───────────────────────────────────────────────

async function sendQuickChat() {
  const input = document.getElementById('quick-chat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  const responseEl = document.getElementById('quick-chat-response');
  responseEl.style.display = 'block';
  responseEl.innerHTML = '<div class="chat-label">Tally</div>Thinking…';
  try {
    const resp = await api.sendChat({ message });
    if (resp?.error) {
      responseEl.innerHTML = `<div class="chat-label">Tally</div>❌ ${resp.error}`;
      input.value = message;
    } else if (resp?.message) {
      responseEl.innerHTML = `<div class="chat-label">Tally</div>${resp.message}`;
      // Also push into engineer chat so it stays in history
      chatMessages.push(resp);
      chatLastTimestamp = resp.timestamp;
    }
  } catch (e) {
    responseEl.innerHTML = `<div class="chat-label">Tally</div>❌ ${e.message}`;
    input.value = message;
  }
}

// ─── EQUIPMENT ─────────────────────────────────────────────────────────────

// Equipment state is managed by deviceState in equipment-ui.js

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
  if (eq.atemIp) items.push({ icon: '🎛️', name: 'ATEM Switcher', detail: eq.atemIp });
  const encType = eq.encoderType || eq.encoder_type || '';
  const encIp = eq.encoderIp || eq.encoder_ip || '';
  if (encIp) {
    const nameMap = { blackmagic: 'Blackmagic Encoder', obs: 'OBS Studio', vmix_encoder: 'vMix Encoder' };
    items.push({ icon: '📡', name: nameMap[encType] || 'Encoder', detail: encIp });
  }
  if (eq.companionUrl) items.push({ icon: '🎮', name: 'Companion', detail: eq.companionUrl.replace(/^https?:\/\//, '') });
  if (eq.propresenterIp) items.push({ icon: '⛪', name: 'ProPresenter', detail: eq.propresenterIp });
  if (eq.vmixIp) items.push({ icon: '🎬', name: 'vMix', detail: eq.vmixIp });
  if (eq.ndiSource) items.push({ icon: '📺', name: 'NDI Source', detail: eq.ndiSource });
  if (eq.audioMixerIp) items.push({ icon: '🔊', name: 'Audio Mixer', detail: eq.audioMixerIp });
  if (items.length === 0) {
    container.innerHTML = '<div style="color:var(--muted); font-size:12px; padding:12px;">No devices configured yet. Scan your network to get started.</div>';
    return;
  }
  container.innerHTML = items.map(d => `
    <div class="simple-device-item">
      <span class="device-icon">${d.icon}</span>
      <div class="device-info"><div class="device-name">${d.name}</div><div class="device-ip">${d.detail}</div></div>
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
  deviceState.propresenter = { host: eq.proPresenterHost || '', port: String(eq.proPresenterPort || '1025'), configured: ppConfigured };
  const vmixConfigured = !!eq.vmixConfigured || !!(eq.vmixHost && String(eq.vmixHost).trim());
  deviceState.vmix = { host: eq.vmixHost || '', port: String(eq.vmixPort || '8088'), configured: vmixConfigured };
  const resolumeConfigured = !!eq.resolumeConfigured || !!(eq.resolumeHost && String(eq.resolumeHost).trim());
  deviceState.resolume = { host: eq.resolumeHost || '', port: String(eq.resolumePort || '8080'), configured: resolumeConfigured };

  const ndiConfigured = !!(eq.ndiSource && String(eq.ndiSource).trim());
  deviceState.ndi = { source: eq.ndiSource || '', label: eq.ndiLabel || '', configured: ndiConfigured };

  // Restore mixer type dropdown from audioViaAtem + override flags
  const mixerType = eq.audioViaAtemOverride === 'on' ? 'atem-direct'
    : eq.audioViaAtemOverride === 'off' ? 'atem-none'
    : eq.audioViaAtem ? 'atem-auto'
    : (eq.mixerType || '');
  deviceState.mixer = { type: mixerType, host: eq.mixerHost || '', port: eq.mixerPort ? String(eq.mixerPort) : '' };
  deviceState.dante = { host: eq.danteNmosHost || '', port: String(eq.danteNmosPort || '8080') };

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
  if (deviceState.atem.ip) expandedDevices.add('atem');
  if (deviceState.encoder.length > 0 && deviceState.encoder.some(e => e.encoderType)) expandedDevices.add('encoder');
  if (deviceState.companion.host) expandedDevices.add('companion');
  if (deviceState.hyperdeck.length > 0) expandedDevices.add('hyperdeck');
  if (deviceState.ptz.length > 0) expandedDevices.add('ptz');
  if (ppConfigured) expandedDevices.add('propresenter');
  if (vmixConfigured) expandedDevices.add('vmix');
  if (resolumeConfigured) expandedDevices.add('resolume');
  if (deviceState.videohub.length > 0) expandedDevices.add('videohub');
  if (ndiConfigured) expandedDevices.add('ndi');
  if (deviceState.mixer.type || deviceState.mixer.host) expandedDevices.add('mixer');
  if (deviceState.dante.host) expandedDevices.add('dante');

  // ── Render dynamic catalog + summary ──
  renderDeviceCatalog();
  renderActiveSummary();
  renderSimpleDeviceList(eq);
  _equipDirty = false; // fresh load from server — nothing unsaved

  // ── Streaming keys (static DOM — not in catalog) ──
  document.getElementById('equip-youtube-key').placeholder = eq.youtubeKeySet ? '(saved \u2014 enter new to change)' : 'AIzaSy\u2026';
  document.getElementById('equip-facebook-token').placeholder = eq.facebookTokenSet ? '(saved \u2014 enter new to change)' : 'EAAxxxxxx\u2026';
  document.getElementById('equip-rtmp-url').value = eq.rtmpUrl || '';
  document.getElementById('equip-rtmp-key').placeholder = eq.rtmpKeySet ? '(saved \u2014 enter new to change)' : 'live_xxxxxxxx';

  // ── Dashboard NDI visibility ──
  const ndiSection = document.getElementById('ndi-status-section');
  const ndiChip = document.getElementById('dot-ndi-chip');
  if (ndiSection) ndiSection.style.display = ndiConfigured ? '' : 'none';
  if (ndiChip) ndiChip.style.display = ndiConfigured ? '' : 'none';
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
  const btn = document.getElementById('btn-oauth-yt');
  const status = document.getElementById('oauth-yt-status');
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  status.textContent = 'Opening browser...';
  status.style.color = 'var(--yellow)';
  try {
    const result = await api.oauthYouTubeConnect();
    if (result.success) {
      updateOAuthUI();
    } else {
      status.textContent = result.error || 'Connection failed';
      status.style.color = 'var(--red, #f44)';
      btn.textContent = 'Connect YouTube';
    }
  } catch (e) {
    status.textContent = e.message;
    status.style.color = 'var(--red, #f44)';
    btn.textContent = 'Connect YouTube';
  } finally {
    btn.disabled = false;
  }
}

async function connectFacebook() {
  const btn = document.getElementById('btn-oauth-fb');
  const status = document.getElementById('oauth-fb-status');
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  status.textContent = 'Opening browser...';
  status.style.color = 'var(--yellow)';
  try {
    const result = await api.oauthFacebookConnect();
    if (result.success && result.pages?.length) {
      // Show page selector
      const selector = document.getElementById('fb-page-selector');
      const select = document.getElementById('fb-page-select');
      select.innerHTML = result.pages.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
      selector.style.display = 'block';
      status.textContent = 'Select a page below';
      status.style.color = 'var(--yellow)';
      btn.textContent = 'Connect Facebook';
    } else if (result.success && result.pages?.length === 0) {
      status.textContent = 'No Facebook Pages found';
      status.style.color = 'var(--red, #f44)';
      btn.textContent = 'Connect Facebook';
    } else {
      status.textContent = result.error || 'Connection failed';
      status.style.color = 'var(--red, #f44)';
      btn.textContent = 'Connect Facebook';
    }
  } catch (e) {
    status.textContent = e.message;
    status.style.color = 'var(--red, #f44)';
    btn.textContent = 'Connect Facebook';
  } finally {
    btn.disabled = false;
  }
}

async function selectFbPage() {
  const select = document.getElementById('fb-page-select');
  const pageId = select.value;
  if (!pageId) return;

  const status = document.getElementById('oauth-fb-status');
  status.textContent = 'Setting up...';
  try {
    const result = await api.oauthFacebookSelectPage({ pageId });
    if (result.success) {
      document.getElementById('fb-page-selector').style.display = 'none';
      updateOAuthUI();
    } else {
      status.textContent = result.error || 'Failed to select page';
      status.style.color = 'var(--red, #f44)';
    }
  } catch (e) {
    status.textContent = e.message;
    status.style.color = 'var(--red, #f44)';
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
    } else {
      ytStatus.textContent = 'Not connected';
      ytStatus.style.color = 'var(--muted)';
      ytBtn.textContent = 'Connect YouTube';
      ytBtn.className = 'btn-oauth';
      ytBtn.onclick = connectYouTube;
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
    } else {
      fbStatus.textContent = 'Not connected';
      fbStatus.style.color = 'var(--muted)';
      fbBtn.textContent = 'Connect Facebook';
      fbBtn.className = 'btn-oauth';
      fbBtn.onclick = connectFacebook;
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
  } else if (type === 'dante') {
    params.ip = (state.host || '').trim();
    params.port = parseInt(state.port) || 8080;
    if (!params.ip) { if (detailEl) detailEl.textContent = 'Enter NMOS registry IP to test'; setEquipDot(dotId, false); return; }
  } else if (type === 'encoder') {
    // Encoder is multi-instance — redirect to testEquipIdx for primary
    return testEquipIdx('encoder', 0);
  } else if (type === 'mixer') {
    params.mixerType = state.type;
    params.ip = (state.host || '').trim();
    params.port = parseInt(state.port) || 0;
    if (!params.ip) { if (detailEl) detailEl.textContent = 'Enter console IP address'; setEquipDot(dotId, false); return; }
    if (!params.mixerType) { if (detailEl) detailEl.textContent = 'Select console type first'; setEquipDot(dotId, false); return; }
  } else if (type === 'ndi') {
    params.type = 'ndi';
    params.source = (state.source || '').trim();
    if (!params.source) { if (detailEl) detailEl.textContent = 'Enter NDI source name'; setEquipDot(dotId, false); return; }
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
    else if (params.encoderType === 'ndi' && !params.ip) return;
    else if (params.encoderType === 'ndi') { params.source = params.source || params.ip; }
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

// ── NDI MONITORING ──────────────────────────────────────────────────────────

async function testNdi() {
  const source = (document.getElementById('equip-ndi-source')?.value || '').trim();
  const detailEl = document.getElementById('equip-ndi-detail');
  const dotId = 'equip-dot-ndi-active';
  if (!source) {
    if (detailEl) detailEl.textContent = 'Enter an NDI source name first';
    setEquipDot(dotId, false);
    return;
  }
  if (detailEl) detailEl.textContent = 'Probing NDI source…';
  setEquipDot(dotId, null);
  try {
    const result = await api.probeNdi(source);
    if (detailEl) detailEl.textContent = result.details || (result.success ? 'Connected' : 'Failed');
    setEquipDot(dotId, result.success);
  } catch (e) {
    if (detailEl) detailEl.textContent = e.message;
    setEquipDot(dotId, false);
  }
}

async function captureNdiFrame() {
  const eq = await api.getEquipment();
  const source = (eq.ndiSource || '').trim();
  if (!source) return;
  const tsEl = document.getElementById('ndi-preview-ts');
  if (tsEl) tsEl.textContent = 'Capturing…';
  try {
    const result = await api.captureNdiFrame(source);
    const imgEl = document.getElementById('ndi-preview-img');
    const placeholderEl = document.getElementById('ndi-preview-placeholder');
    if (result.success && result.frame) {
      if (imgEl) { imgEl.src = `data:image/jpeg;base64,${result.frame}`; imgEl.style.display = ''; }
      if (placeholderEl) placeholderEl.style.display = 'none';
      if (tsEl) tsEl.textContent = new Date().toLocaleTimeString();
    } else {
      if (tsEl) tsEl.textContent = result.details || 'Capture failed';
    }
  } catch (e) {
    if (tsEl) tsEl.textContent = e.message;
  }
}

function updateNdiStatus(status) {
  const ndiData = status.ndi && typeof status.ndi === 'object' ? status.ndi : null;
  const eq = window._savedEquipment || {};
  const ndiConfigured = !!(eq.ndiSource && String(eq.ndiSource).trim());

  // Show/hide NDI section + dot
  const section = document.getElementById('ndi-status-section');
  const chip = document.getElementById('dot-ndi-chip');
  if (section) section.style.display = ndiConfigured ? '' : 'none';
  if (chip) chip.style.display = ndiConfigured ? '' : 'none';

  if (!ndiConfigured) return;

  if (ndiData) {
    setDot('ndi', ndiData.connected);
    setStatusValue('val-ndi-source', ndiData.ndiSource || eq.ndiSource || '—', ndiData.connected);
    const res = ndiData.width && ndiData.height ? `${ndiData.width}x${ndiData.height}` : '—';
    setStatusValue('val-ndi-resolution', res, ndiData.connected);
    setStatusValue('val-ndi-fps', ndiData.fps ? String(ndiData.fps) : '—', ndiData.connected);
    setStatusValue('val-ndi-codec', ndiData.codec || '—', ndiData.connected);
  } else {
    setDot('ndi', false);
    setStatusValue('val-ndi-source', eq.ndiSource || '—', false);
    setStatusValue('val-ndi-resolution', '—', false);
    setStatusValue('val-ndi-fps', '—', false);
    setStatusValue('val-ndi-codec', '—', false);
  }
}

// ── SAVE EQUIPMENT ─────────────────────────────────────────────────────────

async function saveEquipment() {
  const saveBtn = document.getElementById('btn-save-equip');
  if (saveBtn?.disabled) return; // Prevent double-click
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
    hyperdecks: deviceState.hyperdeck.map(h => (h.ip || '').trim()).filter(Boolean),
    videoHubs: deviceState.videohub.filter(h => (h.ip || '').trim()),
    ptz: deviceState.ptz.filter(c => (c.ip || '').trim()),
    // Optional single devices
    proPresenterHost: deviceState.propresenter.configured ? ((deviceState.propresenter.host || '').trim() || 'localhost') : '',
    proPresenterPort: parseInt(deviceState.propresenter.port) || 1025,
    vmixHost: deviceState.vmix.configured ? (deviceState.vmix.host || '').trim() : '',
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
    danteNmosHost: (deviceState.dante.host || '').trim(),
    danteNmosPort: parseInt(deviceState.dante.port) || 8080,
    // NDI
    ndiSource: deviceState.ndi.configured ? (deviceState.ndi.source || '').trim() : '',
    ndiLabel: deviceState.ndi.configured ? (deviceState.ndi.label || '').trim() : '',
    // Streaming keys (read from static DOM section)
    youtubeApiKey: document.getElementById('equip-youtube-key').value.trim(),
    facebookAccessToken: document.getElementById('equip-facebook-token').value.trim(),
    rtmpUrl: document.getElementById('equip-rtmp-url').value.trim(),
    rtmpStreamKey: document.getElementById('equip-rtmp-key').value.trim(),
  };

  const confirmEl = document.getElementById('save-confirm');
  const errorEl = document.getElementById('save-error');

  try {
    await api.saveEquipment(config);
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
    // Cache + NDI visibility
    window._savedEquipment = config;
    window._encoderConfig = { _type: encType, host: (enc.host || '').trim(), port: enc.port || '', password: enc.password || '', label: (enc.label || '').trim(), statusUrl: (enc.statusUrl || '').trim(), source: (enc.source || '').trim() };
    const ndiConfigured = !!(config.ndiSource && config.ndiSource.trim());
    const ndiSection = document.getElementById('ndi-status-section');
    const ndiChip = document.getElementById('dot-ndi-chip');
    if (ndiSection) ndiSection.style.display = ndiConfigured ? '' : 'none';
    if (ndiChip) ndiChip.style.display = ndiConfigured ? '' : 'none';
    // Refresh summary chips
    renderActiveSummary();
    // Auto-restart agent so new equipment config takes effect immediately
    if (isRunning) {
      addAlert('🔄 Restarting agent with updated config…');
      try {
        await api.stopAgent();
        await new Promise(r => setTimeout(r, 1000));
        await api.startAgent();
        addAlert('✅ Agent restarted with new config');
      } catch (e2) {
        addAlert(`⚠ Agent restart failed: ${e2.message}. Stop and start manually.`);
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
  item.innerHTML = `<span>✅ ${label}</span>`;
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
      addAlert(`✅ Added ${label}`);
    } catch (e) {
      btn.disabled = false;
      btn.classList.remove('added');
      btn.textContent = 'Retry';
      addAlert(`❌ Failed to add ${label}: ${e.message || 'unknown error'}`);
    }
  });
  item.appendChild(btn);
  container.appendChild(item);
}

// External link handler
document.addEventListener('click', (e) => {
  const link = e.target.closest('.ext-link');
  if (link) { e.preventDefault(); api.openExternal(link.dataset.url); }
});

init();
