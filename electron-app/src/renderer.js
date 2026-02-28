const api = window.electronAPI;
const TOTAL_STEPS = 5;
let currentStep = 1;
let isRunning = false;
let alertCount = 0;
let pendingDiscoveryNic = '';
const DEFAULT_RELAY_URL = 'wss://tally-production-cde2.up.railway.app';

function showFatalInitError(message) {
  const wizard = document.getElementById('wizard');
  const dashboard = document.getElementById('dashboard');
  if (dashboard) dashboard.classList.remove('active');
  if (wizard) wizard.classList.add('active');

  const content = wizard?.querySelector('.content');
  if (!content) return;
  content.innerHTML = `
    <div style="max-width:460px;margin:30px auto;padding:16px;border-radius:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);color:#fca5a5;font-size:13px;line-height:1.6;">
      <div style="font-weight:700;margin-bottom:8px;">Tally failed to initialize</div>
      <div>${message}</div>
      <div style="margin-top:10px;color:#94A3B8;">Try restarting the app. If it persists, open Terminal and run <code>npm run start</code> in <code>electron-app</code>.</div>
    </div>
  `;
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

    if (config.token) {
      // Returning user — validate token silently
      showSignInLoading('Validating session...');
      document.body.classList.add('ready');

      const result = await api.validateToken();
      if (result.valid) {
        // Token is good — go to dashboard
        if (config.name) document.getElementById('church-name').textContent = config.name;
        if (config.setupComplete) {
          showDashboard();
          await api.startAgent();
          isRunning = true;
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
  document.getElementById('sign-in-loading-text').textContent = text || 'Validating session...';
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

async function doSignIn() {
  const email = document.getElementById('si-email').value.trim();
  const password = document.getElementById('si-password').value;
  const relay = DEFAULT_RELAY_URL;
  const btn = document.getElementById('si-btn');

  if (!email || !password) {
    showSignInMessage('Enter your email and password.', 'var(--warn)');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Signing in...';
  showSignInMessage('Signing in and validating membership...', 'var(--muted)');

  try {
    const result = await api.churchAuthLogin({ relay, email, password });
    if (result.success && result.data?.token) {
      const token = result.data.token;
      const churchName = result.data?.church?.name || '';
      await api.saveConfig({ token, relay, name: churchName });

      // Check if setup is already complete
      const config = await api.getConfig();
      if (config.name) document.getElementById('church-name').textContent = config.name;

      if (config.setupComplete) {
        showDashboard();
        await api.startAgent();
        isRunning = true;
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

  // Render dynamic encoder fields when entering step 2
  if (n === 2 && typeof onWizEncoderTypeChanged === 'function') {
    onWizEncoderTypeChanged();
  }
}

async function wizardNext() {
  if (currentStep < TOTAL_STEPS) {
    goToStep(currentStep + 1);
    if (currentStep === TOTAL_STEPS) {
      // Step 5 (Done) — save equipment config, engineer profile, mark setup complete
      const encType = document.getElementById('wiz-encoder-type').value;
      const encHostEl = document.getElementById('wiz-encoder-host');
      const encPortEl = document.getElementById('wiz-encoder-port');
      const encPwEl = document.getElementById('wiz-encoder-password');
      const encLabelEl = document.getElementById('wiz-encoder-label');
      const encStatusUrlEl = document.getElementById('wiz-encoder-status-url');
      const encSourceEl = document.getElementById('wiz-encoder-source');

      const equipConfig = {
        atemIp: document.getElementById('wiz-atem').value.trim(),
        companionUrl: document.getElementById('wiz-companion').value.trim(),
        name: document.getElementById('wiz-name').value.trim(),
        liveStreamUrl: document.getElementById('wiz-livestream').value.trim(),
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
        streamPlatform: document.getElementById('wiz-stream-platform').value,
        expectedViewers: document.getElementById('wiz-expected-viewers').value,
        operatorLevel: document.getElementById('wiz-operator-level').value,
        backupEncoder: document.getElementById('wiz-backup-encoder').value,
        backupSwitcher: document.getElementById('wiz-backup-switcher').value,
        specialNotes: document.getElementById('wiz-special-notes').value.trim(),
      };
      // Fire and forget — don't block wizard on network issues
      api.saveEngineerProfile(engineerProfile).catch(() => {});

      // Test connection
      const config = await api.getConfig();
      const el = document.getElementById('test-result');
      el.innerHTML = '<span class="spinner-inline"></span> Testing connection…';
      el.style.color = 'var(--muted)';
      const result = await api.testConnection({ url: config.relay, token: config.token });
      if (result.success) {
        el.innerHTML = '● Connected to relay server!';
        el.style.color = 'var(--green)';
      } else {
        el.textContent = `⚠ Could not reach relay: ${result.error}`;
        el.style.color = 'var(--warn)';
      }
    }
  } else {
    // Finish — go to dashboard and start agent
    showDashboard();
    const config = await api.getConfig();
    if (config.name) document.getElementById('church-name').textContent = config.name;
    await api.startAgent();
    isRunning = true;
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

async function scanForATEM() {
  const el = document.getElementById('scan-result');
  const scanBtn = document.getElementById('btn-scan');
  const wizSelect = document.getElementById('wiz-scan-nic');
  const selectedInterface = wizSelect?.value || pendingDiscoveryNic || '';

  scanBtn.disabled = true;
  scanBtn.textContent = '🔍 Scanning…';
  el.textContent = `Scanning ${selectedInterface || 'network'} for ATEM…`;
  try {
    const results = await api.scanNetwork(selectedInterface ? { interfaceName: selectedInterface } : {});
    if (!results.atem || results.atem.length === 0) {
      el.innerHTML = 'No ATEM found on this interface.<br>Try these manual IPs: 192.168.1.10, 192.168.1.240, 10.0.0.10';
      return;
    }
    const primary = results.atem[0];
    document.getElementById('wiz-atem').value = primary.ip;
    const suffix = results.atem.length > 1 ? ` (+${results.atem.length - 1} more)` : '';
    el.innerHTML = `Found ${results.atem.length} ATEM${suffix ? 's' : ''} on this interface. Using ${primary.ip}.`;
  } catch (err) {
    el.textContent = `Scan failed: ${err.message}`;
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = '🔍 Auto-Discover on Network';
  }
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────────

function updateStatusUI(status) {
  setDot('relay', status.relay);
  setDot('atem', status.atem);
  setDot('companion', status.companion);

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
  if (atemData.programInput !== null && atemData.programInput !== undefined) {
    setStatusValue('val-program', `Input ${atemData.programInput}`, true);
  } else if (!atemConnected) {
    setStatusValue('val-program', '—', false);
  }

  if (atemData.previewInput !== null && atemData.previewInput !== undefined) {
    setStatusValue('val-preview', `Input ${atemData.previewInput}`, true);
  } else if (!atemConnected) {
    setStatusValue('val-preview', '—', false);
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
  if (audio.masterMuted || mixerData.mainMuted) {
    setStatusValue('val-audio', '🔇 MUTED', false);
  } else if (audio.silenceDetected) {
    setStatusValue('val-audio', '⚠ Silence', false);
  } else if (streaming) {
    setStatusValue('val-audio', '● OK', true);
  } else if (encoderConnected || atemConnected) {
    setStatusValue('val-audio', 'Standby', null);
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
  btn.textContent = isRunning ? 'Stop Agent' : 'Start Agent';
  btn.className = isRunning ? 'btn-primary' : 'btn-start';
}

async function toggleAgent() {
  if (isRunning) {
    await api.stopAgent();
    isRunning = false;
  } else {
    await api.startAgent();
    isRunning = true;
  }
  updateToggleBtn();
}

async function testConn() {
  const config = await api.getConfig();
  const relay = config.relay || 'wss://tally-production-cde2.up.railway.app';
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
  while (log.children.length > 20) log.removeChild(log.firstChild);
}

function addAlert(text) {
  addActivity(detectActivityType(text), text);
}

// ─── IPC listeners ─────────────────────────────────────────────────────────

api.onStatus((status) => {
  updateStatusUI(status);
});

api.onLog((text) => {
  const t = text.trim();
  if (t.includes('ALERT') || t.includes('✅') || t.includes('⚠️') || t.includes('❌') || t.includes('Stream') || t.includes('Recording')) {
    addAlert(t);
  }

  const progMatch = t.match(/Program: Input (\d+)/);
  if (progMatch) document.getElementById('val-program').textContent = `Input ${progMatch[1]}`;
  const prevMatch = t.match(/Preview: Input (\d+)/);
  if (prevMatch) document.getElementById('val-preview').textContent = `Input ${prevMatch[1]}`;
  const atemModelMatch = t.match(/ATEM model detected:\s*(.+)$/i);
  if (atemModelMatch) {
    const v = atemModelMatch[1].trim();
    const m = document.getElementById('val-atem-model');
    if (m) m.textContent = v;
  }
  const obsIdentityMatch = t.match(/OBS identity:\s*(.+)$/i);
  if (obsIdentityMatch) {
    const v = obsIdentityMatch[1].trim();
    const el = document.getElementById('val-id-encoder');
    if (el) el.textContent = v;
  }
  const encoderIdentityMatch = t.match(/Encoder identity:\s*(.+)$/i);
  if (encoderIdentityMatch) {
    const v = encoderIdentityMatch[1].trim();
    const el = document.getElementById('val-id-encoder');
    if (el) el.textContent = v;
  }
  const ppVersionMatch = t.match(/ProPresenter version detected:\s*(.+)$/i);
  if (ppVersionMatch) {
    const v = ppVersionMatch[1].trim();
    const el = document.getElementById('val-id-propresenter');
    if (el) el.textContent = `ProPresenter ${v}`;
  }
  const vmixIdentityMatch = t.match(/vMix identity:\s*(.+)$/i);
  if (vmixIdentityMatch) {
    const v = vmixIdentityMatch[1].trim();
    const el = document.getElementById('val-id-vmix');
    if (el) el.textContent = v;
  }
  const resolumeVersionMatch = t.match(/Resolume version detected:\s*(.+)$/i);
  if (resolumeVersionMatch) {
    const v = resolumeVersionMatch[1].trim();
    const el = document.getElementById('val-id-resolume');
    if (el) el.textContent = v;
  }
  const mixerIdentityMatch = t.match(/Mixer identity:\s*(.+)$/i);
  if (mixerIdentityMatch) {
    const v = mixerIdentityMatch[1].trim();
    const el = document.getElementById('val-id-mixer');
    if (el) el.textContent = v;
  }
  const companionIdentityMatch = t.match(/Companion identity:\s*(.+)$/i);
  if (companionIdentityMatch) {
    const v = companionIdentityMatch[1].trim();
    const el = document.getElementById('val-id-companion');
    if (el) el.textContent = v;
  }

  if (t.includes('recording STARTED')) document.getElementById('val-recording').textContent = '● Recording';
  if (t.includes('recording STOPPED')) document.getElementById('val-recording').textContent = 'Stopped';
  if (t.includes('Stream STARTED')) document.getElementById('val-stream').textContent = '● LIVE';
  if (t.includes('Stream STOPPED')) document.getElementById('val-stream').textContent = 'Off';
  if (t.includes('Companion connected')) document.getElementById('val-companion').textContent = 'Connected';
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

// ─── TABS ──────────────────────────────────────────────────────────────────

function switchTab(name) {
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

function startChatPolling() {
  loadChatHistory();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(pollChat, 4000);
}

function stopChatPolling() {
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function loadChatHistory() {
  // Only load today's messages (24hr window) to keep the app chat clean
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const resp = await api.getChat({ since });
  if (resp?.messages) {
    chatMessages = resp.messages;
    if (chatMessages.length > 0) chatLastTimestamp = chatMessages[chatMessages.length - 1].timestamp;
    renderChat();
  }
}

async function pollChat() {
  if (!chatLastTimestamp) return loadChatHistory();
  const resp = await api.getChat({ since: chatLastTimestamp });
  if (resp?.messages?.length > 0) {
    chatMessages.push(...resp.messages);
    chatLastTimestamp = resp.messages[resp.messages.length - 1].timestamp;
    renderChat();
  }
}

// Real-time inbound via WebSocket → stdout → IPC
api.onChatMessage((msg) => {
  // Dedup: don't add if we already have this message
  if (msg.id && chatMessages.some(m => m.id === msg.id)) return;
  chatMessages.push(msg);
  chatLastTimestamp = msg.timestamp || chatLastTimestamp;
  renderChat();
});

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function renderChat() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const sourceIcon = { telegram: '📱', app: '💻', dashboard: '🌐' };
  container.innerHTML = chatMessages.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const icon = sourceIcon[m.source] || '💬';
    const roleColor = m.sender_role === 'admin' ? 'var(--green)' : 'var(--white)';
    const name = m.sender_name || m.senderName || 'Unknown';
    return `<div style="padding:6px 12px; margin-bottom:2px;">
      <div style="font-size:10px; color:var(--dim); font-family:var(--mono);">
        ${icon} <span style="color:${roleColor}; font-weight:600;">${escapeHtml(name)}</span>
        <span style="margin-left:6px;">${time}</span>
      </div>
      <div style="font-size:13px; color:var(--white); margin-top:2px; line-height:1.4;">
        ${escapeHtml(m.message)}
      </div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
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
  const resp = await api.sendChat({ message });
  if (resp?.id) {
    chatMessages.push(resp);
    chatLastTimestamp = resp.timestamp;
    renderChat();
  }
}

// ─── EQUIPMENT ─────────────────────────────────────────────────────────────

// Equipment state is managed by deviceState in equipment-ui.js

async function loadEquipment() {
  const eq = await api.getEquipment();

  // ── Populate deviceState from API response ──
  deviceState.atem.ip = eq.atemIp || '';
  deviceState.companion.url = eq.companionUrl || '';
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

  deviceState.mixer = { type: eq.mixerType || '', host: eq.mixerHost || '', port: eq.mixerPort ? String(eq.mixerPort) : '' };
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
  if (deviceState.companion.url) expandedDevices.add('companion');
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
  if (!confirm('Disconnect YouTube? Stream keys will be removed.')) return;
  await api.oauthYouTubeDisconnect();
  updateOAuthUI();
}

async function disconnectFacebook() {
  if (!confirm('Disconnect Facebook? Stream keys will be removed.')) return;
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
  // Flush DOM inputs into deviceState
  syncDomToState();

  // Build encoders array (all configured encoders)
  const encoders = deviceState.encoder.filter(e => e.encoderType).map(e => ({
    type: e.encoderType, host: (e.host || '').trim(),
    port: parseInt(e.port) || null, password: e.password || '',
    label: (e.label || '').trim(), statusUrl: (e.statusUrl || '').trim(),
    source: (e.source || '').trim(),
  }));
  // Primary encoder (first in list) — backward compat with church-client
  const enc = deviceState.encoder[0] || {};
  const encType = enc.encoderType || '';

  const config = {
    atemIp: (deviceState.atem.ip || '').trim(),
    companionUrl: (deviceState.companion.url || '').trim(),
    // Encoders array (new format)
    encoders,
    // Primary encoder flat fields (backward compat)
    encoderType: encType,
    encoderHost: (enc.host || '').trim(),
    encoderPort: parseInt(enc.port) || 0,
    encoderPassword: enc.password || '',
    encoderLabel: (enc.label || '').trim(),
    encoderStatusUrl: (enc.statusUrl || '').trim(),
    encoderSource: (enc.source || '').trim(),
    obsUrl: encType === 'obs' ? `ws://${(enc.host || 'localhost').trim()}:${enc.port || '4455'}` : '',
    obsPassword: encType === 'obs' ? (enc.password || '') : '',
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
    mixerType: deviceState.mixer.type || '',
    mixerHost: (deviceState.mixer.host || '').trim(),
    mixerPort: parseInt(deviceState.mixer.port) || 0,
    danteNmosHost: (deviceState.dante.host || '').trim(),
    danteNmosPort: parseInt(deviceState.dante.port) || 8080,
    // NDI
    ndiSource: deviceState.ndi.configured ? (deviceState.ndi.source || '').trim() : '',
    ndiLabel: deviceState.ndi.configured ? (deviceState.ndi.label || '').trim() : '',
    // Streaming keys (read from static DOM section)
    youtubeApiKey: document.getElementById('equip-youtube-key').value.trim() || undefined,
    facebookAccessToken: document.getElementById('equip-facebook-token').value.trim() || undefined,
    rtmpUrl: document.getElementById('equip-rtmp-url').value.trim() || '',
    rtmpStreamKey: document.getElementById('equip-rtmp-key').value.trim() || undefined,
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
      addFromScan('companion', { ...d, url: `http://${d.ip}:${d.port}` });
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
