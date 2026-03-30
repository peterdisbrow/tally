const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, clipboard, dialog, screen } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { encryptConfig, decryptConfig } = require('./secureStorage');

// ─── CLI PROVISIONING FLAGS ────────────────────────────────────────────────────
// Supports MDM pre-seeding: --config-path, --relay-url, --church-id  (P2 item 17)
// Electron passes all argv after '--' to the app; filter out Electron-internal flags.
let _cliOpts = {};
try {
  const { Command } = require('commander');
  const program = new Command();
  program
    .name('tally')
    .description('Tally Connect — remote AV tally monitoring')
    .option('--config-path <path>', 'Override default config file path (~/.church-av/config.json)')
    .option('--relay-url <url>', 'Override relay server URL')
    .option('--church-id <id>', 'Pre-provision a church ID (written to config on first launch)')
    .option('--dev', 'Enable developer tools')
    .allowUnknownOption(true)
    .exitOverride(); // prevent process.exit() on --help in packaged builds
  program.parse(process.argv);
  _cliOpts = program.opts();
} catch { /* commander may not be available in all build configurations */ }

// Apply --config-path override before config-manager is used
if (_cliOpts.configPath) {
  process.env.TALLY_CONFIG_PATH = _cliOpts.configPath;
}
// Apply --relay-url override
if (_cliOpts.relayUrl) {
  process.env.TALLY_DEFAULT_RELAY_URL = _cliOpts.relayUrl;
}

// i18n — applied after prefs are loadable (prefs.json may have a saved locale)
const i18n = require('./i18n');
// Locale will be properly set after app.whenReady() + loadPrefs(); default to OS locale for now.
i18n.detectAndApplyLocale();

// Extracted modules (pure refactoring — see config-manager.js, relay-client.js, equipment-tester.js)
const configManager = require('./config-manager');
const relayClient = require('./relay-client');
const equipmentTester = require('./equipment-tester');
const problemFinderBridge = require('./problem-finder-bridge');

// Auto-update (gracefully optional)
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) { console.warn('electron-updater not available:', e?.message); autoUpdater = null; }

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR  = path.dirname(CONFIG_PATH);
const PREFS_PATH  = path.join(CONFIG_DIR, 'prefs.json');

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch (e) { console.warn('loadPrefs failed:', e?.message); return {}; }
}
function savePrefs(updates) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const prefs = loadPrefs();
    fs.writeFileSync(PREFS_PATH, JSON.stringify({ ...prefs, ...updates }, null, 2), 'utf8');
  } catch (e) { console.warn('savePrefs failed:', e?.message); }
}
const DEFAULT_RELAY_URL = process.env.TALLY_DEFAULT_RELAY_URL || 'wss://api.tallyconnect.app';
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const APP_LOG_PATH = path.join(LOG_DIR, 'tally-app.log');
const MAX_RECENT_LOG_LINES = 2000;
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

let tray = null;
let mainWindow = null;
let agentProcess = null;
let agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
let lastNotifiedState = {};
const recentLogLines = [];
let agentCrashCount = 0;
let _agentEscalatedAt = 0;      // timestamp of last crash-escalation notification

// ─── RELAY STATUS SSE CLIENT ─────────────────────────────────────────────────
// Pulls full device status directly from the relay server via SSE, replacing
// fragile stdout log-line parsing for rich status data.
let _sseAbort = null;
let _sseRetryTimer = null;
let _sseRetryDelay = 3000;

function startRelayStatusSSE(relayUrl, token, instanceName) {
  stopRelayStatusSSE();
  if (!relayUrl || !token) return;
  const httpUrl = relayUrl.replace(/^ws(s)?:/, 'http$1:').replace(/\/+$/, '');
  const url = `${httpUrl}/api/church/app/status/stream`;
  _sseAbort = new AbortController();
  _sseRetryDelay = 3000;

  // Instance name filters out status from other instances (different rooms).
  // The church-client builds this as `name::roomId` (see church-client/src/index.js).
  const myInstance = instanceName || '';

  (async function connect() {
    try {
      appendAppLog('SYSTEM', `SSE connecting to ${url}`);
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: _sseAbort.signal,
      });
      if (!resp.ok) {
        appendAppLog('SYSTEM', `SSE auth failed: ${resp.status}`);
        return;
      }
      appendAppLog('SYSTEM', 'SSE connected — receiving relay status');
      _sseRetryDelay = 3000; // reset on success

      // Read the SSE text stream
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Parse SSE frames: lines starting with "data: " followed by "\n\n"
        const frames = buffer.split('\n\n');
        buffer = frames.pop(); // keep incomplete frame
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const msg = JSON.parse(line.slice(6));
              // Only merge status from our own instance. Other instances
              // (different rooms) have different equipment — merging their
              // status overwrites ours and causes false disconnect flapping.
              if (msg.instance && msg.instance !== myInstance) continue;
              const status = msg.status;
              if (status && typeof status === 'object') {
                _mergeRelayStatus(status);
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // intentional close
      appendAppLog('SYSTEM', `SSE error: ${err.message}`);
    }
    // Reconnect with backoff (unless aborted)
    if (_sseAbort && !_sseAbort.signal.aborted) {
      _sseRetryTimer = setTimeout(() => connect(), _sseRetryDelay);
      _sseRetryDelay = Math.min(_sseRetryDelay * 2, 30_000);
    }
  })();
}

function _mergeRelayStatus(status) {
  // Deep merge relay status into agentStatus, preserving local-only fields.
  // IMPORTANT: preserve null for unconfigured devices — null means "hide the pill"
  for (const key of Object.keys(status)) {
    if (key.startsWith('_')) continue;
    // Don't overwrite null (unconfigured device) with relay data
    if (agentStatus[key] === null) continue;
    const val = status[key];
    // Don't let relay's default null values (from pre-connect snapshots) poison local state.
    // The Electron app controls which devices are null (unconfigured) via its own config;
    // relay nulls would permanently block future updates due to the guard above.
    if (val === null || val === undefined) continue;
    if (val && typeof val === 'object' && !Array.isArray(val) && agentStatus[key] && typeof agentStatus[key] === 'object') {
      Object.assign(agentStatus[key], val);
    } else {
      agentStatus[key] = val;
    }
  }
  checkAndNotify();
  mainWindow?.webContents.send('status', agentStatus);
  updateTray();
}

function stopRelayStatusSSE() {
  if (_sseRetryTimer) { clearTimeout(_sseRetryTimer); _sseRetryTimer = null; }
  if (_sseAbort) { _sseAbort.abort(); _sseAbort = null; }
}
const MAX_AGENT_CRASHES = 5;    // threshold for sending an escalation alert
const MAX_AGENT_BACKOFF_MS = 60_000; // cap backoff at 60s after repeated crashes

// ─── WIRE EXTRACTED MODULES ──────────────────────────────────────────────────
// Break circular dependency: relay-client needs loadConfig, config-manager needs
// enforceRelayPolicy. The init() pattern resolves this at startup.
configManager.init({ enforceRelayPolicy: relayClient.enforceRelayPolicy });
relayClient.init({
  loadConfig: () => configManager.loadConfig(),
  getMainWindow: () => mainWindow,
});
equipmentTester.init({
  tryTcpConnect: (...args) => {
    // Lazy import to avoid circular at require-time
    const { tryTcpConnect } = require('./networkScanner');
    return tryTcpConnect(...args);
  },
  tryHttpGet: (...args) => {
    const { tryHttpGet } = require('./networkScanner');
    return tryHttpGet(...args);
  },
  tryUdpProbe: (...args) => {
    const { tryUdpProbe } = require('./networkScanner');
    return tryUdpProbe(...args);
  },
  packets: (() => {
    const ns = require('./networkScanner');
    return {
      ATEM_SYN_PACKET: ns.ATEM_SYN_PACKET,
      OSC_INFO_PACKET: ns.OSC_INFO_PACKET,
      OSC_SQ_ALIVE_PACKET: ns.OSC_SQ_ALIVE_PACKET,
      OSC_YAMAHA_STATE_PACKET: ns.OSC_YAMAHA_STATE_PACKET,
    };
  })(),
});

problemFinderBridge.init({
  getAgentStatus: () => agentStatus,
  getConfig: () => configManager.loadConfig(),
  getRecentLogs: () => recentLogLines,
  getEquipmentResults: () => [],
  getMainWindow: () => mainWindow,
  appendAppLog: (src, msg) => appendAppLog(src, msg),
  getLabRootDir: () => {
    const devPath = path.resolve(__dirname, '..', '..', '..', '..', 'New project', 'problem-finder-lab');
    if (fs.existsSync(path.join(devPath, 'src', 'engine.js'))) return devPath;
    try {
      const pkgPath = path.join(process.resourcesPath || '', 'problem-finder-lab');
      if (fs.existsSync(path.join(pkgPath, 'src', 'engine.js'))) return pkgPath;
    } catch (e) { console.warn('problem-finder-lab lookup failed:', e?.message); }
    return null;
  },
});

function appendAppLog(source, message) {
  const ts = new Date().toISOString();
  const lines = String(message ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    lines.push('(empty)');
  }

  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    let batch = '';
    for (const line of lines) {
      const entry = `[${ts}] [${source}] ${line}`;
      recentLogLines.push(entry);
      batch += entry + '\n';
    }
    // Trim in-memory buffer efficiently (shift excess from front)
    if (recentLogLines.length > MAX_RECENT_LOG_LINES) {
      recentLogLines.splice(0, recentLogLines.length - MAX_RECENT_LOG_LINES);
    }
    // Log rotation: if file exceeds 10 MB, rename to .1 and start fresh (P2 item 16)
    try {
      const stat = fs.statSync(APP_LOG_PATH);
      if (stat.size > MAX_LOG_FILE_BYTES) {
        const rotatedPath = APP_LOG_PATH + '.1';
        // Overwrite any previous .1 rotation
        if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
        fs.renameSync(APP_LOG_PATH, rotatedPath);
      }
    } catch { /* file may not exist yet */ }
    // Non-blocking write — don't freeze the main process during live service
    fs.appendFile(APP_LOG_PATH, batch, 'utf8', () => {});
  } catch (e) {
    // Logging should never crash the app
    console.warn('appendAppLog failed:', e?.message);
  }
}

/**
 * Clear all logs — in-memory buffer and log files on disk.
 * Logs only persist when the user explicitly exports them.
 */
function clearAllLogs() {
  recentLogLines.length = 0;
  try {
    if (fs.existsSync(APP_LOG_PATH)) fs.unlinkSync(APP_LOG_PATH);
    const rotated = APP_LOG_PATH + '.1';
    if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
  } catch { /* best effort */ }
}

// Delegated to config-manager module
const getSanitizedConfigForExport = configManager.getSanitizedConfigForExport;

function buildExportText() {
  const header = [
    'Tally Test Log Export',
    `Generated: ${new Date().toISOString()}`,
    `App Version: ${app.getVersion()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Node: ${process.version}`,
    '',
    '=== Runtime Status ===',
    JSON.stringify(agentStatus, null, 2),
    '',
    '=== Sanitized Config ===',
    JSON.stringify(getSanitizedConfigForExport(), null, 2),
    '',
    '=== Recent Logs ===',
  ];

  const logs = recentLogLines.slice(-1000);
  return [...header, ...(logs.length ? logs : ['(no logs captured yet)'])].join('\n');
}

async function exportTestLogs() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultPath = path.join(app.getPath('desktop'), `tally-test-logs-${stamp}.txt`);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow || undefined, {
    title: 'Export Tally Test Logs',
    defaultPath,
    filters: [{ name: 'Text Files', extensions: ['txt'] }],
  });

  if (canceled || !filePath) return { canceled: true };

  fs.writeFileSync(filePath, buildExportText(), 'utf8');
  appendAppLog('SYSTEM', `Exported test logs to ${filePath}`);
  return { canceled: false, filePath };
}

// ─── TRAY ICON STATES ─────────────────────────────────────────────────────────

// Pre-compute tray icons once (avoids recalculating on every status update)
const trayIconCache = new Map();

function getTrayIcon(state) {
  if (trayIconCache.has(state)) return trayIconCache.get(state);

  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const colors = {
    grey:   [120, 120, 120, 255],
    green:  [34, 197, 94, 255],
    yellow: [234, 179, 8, 255],
    red:    [239, 68, 68, 255],
  };
  const [r, g, b, a] = colors[state] || colors.grey;

  const cx = size / 2, cy = size / 2, radius = 6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      const idx = (y * size + x) * 4;
      if (dist <= radius) {
        canvas[idx] = r; canvas[idx + 1] = g; canvas[idx + 2] = b; canvas[idx + 3] = a;
      } else {
        canvas[idx] = 0; canvas[idx + 1] = 0; canvas[idx + 2] = 0; canvas[idx + 3] = 0;
      }
    }
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  trayIconCache.set(state, icon);
  return icon;
}

function computeTrayState() {
  if (!agentStatus.relay) return 'grey';
  if (agentStatus.relay && agentStatus.atem) return 'green';
  if (agentStatus.relay && !agentStatus.atem) return 'yellow';
  return 'red';
}

// ─── WINDOW ───────────────────────────────────────────────────────────────────

function clampBoundsToDisplay(bounds) {
  // Get the total usable area across all displays
  const displays = screen.getAllDisplays();
  if (!displays.length) return bounds;

  const { x, y, width, height } = bounds;
  const w = width || 900;
  const h = height || 820;

  // Find a display that overlaps the saved bounds
  const overlap = displays.find((d) => {
    const { x: dx, y: dy, width: dw, height: dh } = d.workArea;
    return x < dx + dw && x + w > dx && y < dy + dh && y + h > dy;
  });

  if (overlap) {
    const { x: dx, y: dy, width: dw, height: dh } = overlap.workArea;
    return {
      x: Math.max(dx, Math.min(x, dx + dw - w)),
      y: Math.max(dy, Math.min(y, dy + dh - h)),
      width: Math.min(w, dw),
      height: Math.min(h, dh),
    };
  }

  // Saved bounds are entirely off-screen — reset to primary display center
  const primary = screen.getPrimaryDisplay().workArea;
  return {
    x: primary.x + Math.round((primary.width - w) / 2),
    y: primary.y + Math.round((primary.height - h) / 2),
    width: w,
    height: h,
  };
}

function createWindow() {
  const savedBounds = loadPrefs().windowBounds || {};
  const rawWidth  = savedBounds.width  || 900;
  const rawHeight = savedBounds.height || 820;

  // Clamp saved position to visible display area (Persona 6 P2 item 9)
  let clamped = null;
  if (savedBounds.x != null && savedBounds.y != null) {
    clamped = clampBoundsToDisplay({ x: savedBounds.x, y: savedBounds.y, width: rawWidth, height: rawHeight });
  }

  const winOpts = {
    width: clamped ? clamped.width : rawWidth,
    height: clamped ? clamped.height : rawHeight,
    minWidth: 580,
    minHeight: 720,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    // Explicitly position traffic lights so Electron correctly calculates the
    // drag region boundary on all macOS versions (critical for arm64/Apple Silicon)
    trafficLightPosition: { x: 12, y: 14 },
    title: 'Tally',
    show: false,
  };
  if (clamped) { winOpts.x = clamped.x; winOpts.y = clamped.y; }
  else if (savedBounds.x != null) { winOpts.x = savedBounds.x; winOpts.y = savedBounds.y; }
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Persist window bounds across restarts (debounced)
  let _saveBoundsTimer = null;
  const _persistBounds = () => {
    clearTimeout(_saveBoundsTimer);
    _saveBoundsTimer = setTimeout(() => {
      if (mainWindow) savePrefs({ windowBounds: mainWindow.getBounds() });
    }, 400);
  };
  mainWindow.on('resize', _persistBounds);
  mainWindow.on('move', _persistBounds);

  mainWindow.on('close', (e) => {
    if (app.isQuitting) {
      mainWindow = null;
      return; // allow the window to close for real
    }
    e.preventDefault();
    mainWindow.hide();
    // On first close, let the user know the app is still running in the tray
    if (!loadPrefs().hasSeenTrayNotice) {
      savePrefs({ hasSeenTrayNotice: true });
      sendNotification('Tally Connect is still running', 'Tally Connect is still running in your system tray.');
    }
  });

  // Notify renderer when window is hidden/shown so it can pause polling
  mainWindow.on('hide', () => mainWindow?.webContents.send('window-visibility', false));
  mainWindow.on('show', () => mainWindow?.webContents.send('window-visibility', true));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Check if this is the first launch after an update
    setTimeout(() => checkWhatsNew(), 1500);
  });
}

// ─── TRAY ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayIcon('grey'));
  updateTray();
}

let _lastTrayState = '';
function updateTray() {
  if (!tray) return;
  const state = computeTrayState();
  // Build a fingerprint of all values that affect the tray menu
  const fingerprint = `${state}|${!!agentStatus.relay}|${!!agentStatus.atem}|${!!(agentStatus.encoder||agentStatus.obs)}|${!!agentStatus.companion}|${agentStatus.encoderType||''}|${agentStatus.billingTier||''}|${agentStatus.billingStatus||''}|${agentStatus.trialDaysRemaining??''}`;
  if (fingerprint === _lastTrayState) return;
  _lastTrayState = fingerprint;
  tray.setImage(getTrayIcon(state));

  const connected = agentStatus.relay;
  const atemOk = agentStatus.atem;
  const encoderOk = agentStatus.encoder || agentStatus.obs;
  const compOk = agentStatus.companion;
  const encLabel = agentStatus.encoderType || 'OBS';

  const statusLine = connected
    ? `Connected — ATEM: ${atemOk ? '✓' : '✗'} | ${encLabel}: ${encoderOk ? '✓' : '✗'} | Companion: ${compOk ? '✓' : '✗'}`
    : 'Disconnected';

  // Billing status line for tray
  const billingTier = agentStatus.billingTier || '';
  const billingStatus = agentStatus.billingStatus || '';
  const trialDays = agentStatus.trialDaysRemaining;
  let billingLine = null;
  if (billingStatus === 'trialing' && trialDays != null) {
    billingLine = `\u23F3 Trial: ${trialDays} day${trialDays !== 1 ? 's' : ''} left`;
  } else if (billingStatus === 'past_due') {
    billingLine = '\u26A0\uFE0F Payment issue \u2014 update card';
  } else if (billingStatus === 'active' && billingTier) {
    const tierNames = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
    billingLine = `\u2705 Plan: ${tierNames[billingTier] || billingTier}`;
  }

  const { t } = i18n;
  const menu = Menu.buildFromTemplate([
    { label: 'Tally', enabled: false },
    { label: statusLine, enabled: false },
    ...(billingLine ? [{ label: billingLine, enabled: false }] : []),
    { type: 'separator' },
    { label: t('tray.openDashboard'), click: () => mainWindow?.show() },
    { label: connected ? t('tray.stopMonitoring') : t('tray.startMonitoring'), click: () => connected ? stopAgent() : startAgent() },
    { type: 'separator' },
    { label: t('tray.clientPortal'), click: () => shell.openExternal('https://tallyconnect.app/portal') },
    { label: t('tray.helpSupport'), click: () => shell.openExternal('https://tallyconnect.app/help') },
    { label: 'Tally Connect', click: () => shell.openExternal('https://tallyconnect.app') },
    { type: 'separator' },
    { label: t('tray.checkForUpdates'), click: () => {
      if (autoUpdater) {
        autoUpdater.checkForUpdates().then(() => {}).catch(() => {
          mainWindow?.webContents.send('update-not-available');
        });
      } else {
        shell.openExternal('https://github.com/peterdisbrow/tally/releases/latest');
      }
    }},
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: t('tray.signOut'), click: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Sign Out', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Sign out? This will stop all monitoring.',
      });
      if (response !== 0) return;
      performSignOut();
      mainWindow?.show();
    }},
    { label: 'Reset to Factory Defaults', click: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Reset Everything', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Reset all settings to factory defaults?',
        detail: 'This will sign you out, erase all equipment configuration, and return to the initial setup screen. A backup of your current config will be saved.',
      });
      if (response !== 0) return;
      stopAgent();
      // Clear relay-side equipment before wiping local config (prevents stale IPs re-appearing on next login)
      const preResetConfig = loadConfig();
      if (preResetConfig.roomId && preResetConfig.token) {
        await syncEquipmentToRelay(preResetConfig.roomId, {}).catch(() => {});
      }
      resetConfig();
      agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} };
      mainWindow?.webContents.send('status', agentStatus);
      mainWindow?.webContents.send('signed-out');
      mainWindow?.show();
    }},
    { type: 'separator' },
    { label: t('tray.quit'), click: () => { app.isQuitting = true; stopAgent(); app.exit(0); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`Tally — ${statusLine}`);
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

function sendNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: path.join(__dirname, '../assets/icon.png') }).show();
  }
}

const _notifCooldowns = {};
function _notifyOnce(key, title, body, cooldownMs = 60000) {
  const now = Date.now();
  if (_notifCooldowns[key] && now - _notifCooldowns[key] < cooldownMs) return;
  _notifCooldowns[key] = now;
  sendNotification(title, body);
}

function checkAndNotify() {
  // ATEM disconnect (handles both boolean and object states)
  const wasAtemConnected = lastNotifiedState.atem === true || (lastNotifiedState.atem && lastNotifiedState.atem.connected);
  const isAtemConnected = agentStatus.atem === true || (agentStatus.atem && agentStatus.atem.connected);
  if (wasAtemConnected && !isAtemConnected) {
    _notifyOnce('atem-disconnect', 'ATEM Disconnected', 'The ATEM switcher has lost connection.');
  }
  // Stream drop
  if (lastNotifiedState.streaming === true && agentStatus.streaming === false) {
    _notifyOnce('stream-drop', 'Stream Stopped', 'The live stream has stopped unexpectedly.');
  }
  // Low FPS — only notify once per minute
  if (agentStatus.fps && agentStatus.fps < 24 && agentStatus.streaming) {
    _notifyOnce('low-fps', 'Low FPS Warning', `Stream FPS dropped to ${agentStatus.fps}`, 60000);
  }
  lastNotifiedState = { ...agentStatus };
}

function resolveNodeBinary() {
  // ── 1. Try system-installed Node.js first (preferred — lighter than Electron) ──
  const candidates = new Set();

  const addCandidate = (value) => {
    if (!value) return;
    candidates.add(value);
  };

  addCandidate(process.env.NODE);
  addCandidate(process.env.NODE_PATH);

  if (process.platform === 'darwin') {
    addCandidate('/opt/homebrew/bin/node');
    addCandidate('/usr/local/bin/node');
    addCandidate('/usr/bin/node');
    addCandidate('/bin/node');
  } else if (process.platform === 'win32') {
    addCandidate('C:/Program Files/nodejs/node.exe');
    addCandidate('C:/Program Files (x86)/nodejs/node.exe');
  }

  if (process.resourcesPath) {
    addCandidate(path.join(process.resourcesPath, 'node'));
    addCandidate(path.join(process.resourcesPath, 'node', 'bin', 'node'));
    addCandidate(path.join(process.resourcesPath, 'bin', 'node'));
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return { binary: p, useElectronAsNode: false };
  }

  // Check PATH with `which`/`where`
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['node'], { encoding: 'utf8' });
  if (result.status === 0) {
    const located = result.stdout.split('\n')[0]?.trim();
    if (located && fs.existsSync(located)) return { binary: located, useElectronAsNode: false };
  }

  // ── 2. Fallback: use Electron's own Node.js via ELECTRON_RUN_AS_NODE ──
  // This always works in packaged builds — no system Node.js required.
  if (process.execPath) {
    return { binary: process.execPath, useElectronAsNode: true };
  }

  return null;
}

// ─── AGENT PROCESS ────────────────────────────────────────────────────────────

function resolveChurchClientPaths() {
  // In packaged builds, church-client lives in extraResources
  const packagedDir = path.join(process.resourcesPath || '', 'church-client');
  const packagedScript = path.join(packagedDir, 'src', 'index.js');
  if (fs.existsSync(packagedScript)) {
    return { script: packagedScript, cwd: packagedDir };
  }
  // In development, church-client is a sibling directory
  const devDir = path.join(__dirname, '..', '..', 'church-client');
  const devScript = path.join(devDir, 'src', 'index.js');
  if (fs.existsSync(devScript)) {
    return { script: devScript, cwd: devDir };
  }
  return null;
}

// ─── AUTH FAILURE DETECTOR ────────────────────────────────────────────────────
// Detect JWT expiry / rejection in agent output and fire auth-invalid immediately,
// stopping the crash-restart loop (P1 item 7 / Persona 12).
let _authInvalidFired = false;
function _detectAgentAuthFailure(text) {
  if (_authInvalidFired) return; // Already handled — don't fire multiple times
  const AUTH_PATTERNS = [
    '1008', 'Invalid token', 'Authentication failed', 'Token expired',
    'token expired', 'jwt expired', 'Unauthorized', 'auth rejected',
    'auth: reject', 'Not authorized',
  ];
  const isAuthFailure = AUTH_PATTERNS.some((p) => text.includes(p));
  if (!isAuthFailure) return;

  _authInvalidFired = true;
  appendAppLog('SYSTEM', 'Auth failure detected in agent output — stopping restart loop');
  agentStatus.relay = false;
  mainWindow?.webContents.send('status', agentStatus);
  updateTray();
  mainWindow?.webContents.send('auth-invalid');

  // Stop the agent immediately to prevent the 5-crash escalation loop
  const proc = agentProcess;
  agentProcess = null; // Prevent auto-restart in close handler
  try { proc?.kill(); } catch { /* ignore */ }
}

function startAgent() {
  if (agentProcess) return;

  const config = loadConfig();
  if (!config.token) {
    appendAppLog('SYSTEM', 'Start agent requested but token is missing');
    mainWindow?.show();
    return;
  }

  const clientPaths = resolveChurchClientPaths();
  if (!clientPaths) {
    const msg = 'Church client agent not found. The app may need to be reinstalled.';
    console.log(msg);
    appendAppLog('SYSTEM', msg);
    mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
    mainWindow?.show();
    sendNotification('Tally Agent Error', msg);
    return;
  }

  const agentRelay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
  const args = [clientPaths.script,
    '--relay', agentRelay,
  ];

  if (config.atemIp) args.push('--atem', config.atemIp);
  if (config.atemAutoRecord) args.push('--atem-auto-record');
  if (config.obsUrl)       args.push('--obs', config.obsUrl);
  if (config.name)         args.push('--name', config.name);
  if (config.companionUrl) args.push('--companion', config.companionUrl);

  // Pass sensitive credentials via env vars instead of CLI args
  // (CLI args are visible to all OS users via `ps aux`)
  const secretEnv = {};
  if (config.token)       secretEnv.TALLY_TOKEN = config.token;
  if (config.obsPassword) secretEnv.TALLY_OBS_PASSWORD = config.obsPassword;

  const nodeResult = resolveNodeBinary();
  if (!nodeResult) {
    const msg = 'Node.js runtime not found. The app may need to be reinstalled.';
    console.log(msg);
    appendAppLog('SYSTEM', msg);
    mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
    mainWindow?.show();
    sendNotification('Tally Agent Error', msg);
    return;
  }
  const { binary: nodeBinary, useElectronAsNode } = nodeResult;

  // Set encoder type label from config so UI can adapt
  const encoderTypeNames = {
    obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Streaming Encoder',
    aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek',
    yolobox: 'YoloBox', 'tally-encoder': 'Tally Encoder',
    custom: 'Custom', 'custom-rtmp': 'Custom RTMP', 'rtmp-generic': 'RTMP',
    'atem-streaming': 'ATEM Mini',
  };
  agentStatus.encoderType = encoderTypeNames[config.encoder?.type] || '';

  // Mark unconfigured devices as null so the UI hides their status pills
  if (!config.atemIp) agentStatus.atem = null;
  if (!config.companionUrl) agentStatus.companion = null;
  if (!config.encoder?.type) agentStatus.encoder = null;
  agentStatus.resolume = config.resolume?.host
    ? { connected: false, host: config.resolume.host, port: config.resolume.port || 8080, version: null }
    : null;
  agentStatus.proPresenter = config.proPresenter?.host
    ? { connected: false, running: false, host: config.proPresenter.host, port: config.proPresenter.port || 1025 }
    : null;

  const nodeLabel = useElectronAsNode ? `${nodeBinary} (ELECTRON_RUN_AS_NODE)` : nodeBinary;
  appendAppLog('SYSTEM', `Starting agent (relay=${agentRelay}, name=${config.name || 'n/a'}, node=${nodeLabel}, script=${clientPaths.script})`);

  const spawnEnv = useElectronAsNode
    ? { ...process.env, ...secretEnv, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env, ...secretEnv };

  agentProcess = spawn(nodeBinary, args, {
    cwd: clientPaths.cwd,
    env: spawnEnv,
  });

  // Connect to relay SSE for real-time device status (replaces stdout parsing for rich data)
  // Pass our instance name so SSE can filter out status from other instances (multi-room).
  const baseName = config.name || os.hostname();
  const instanceName = config.roomId ? `${baseName}::${config.roomId}` : baseName;
  startRelayStatusSSE(agentRelay, config.token, instanceName);

  agentProcess.on('error', (err) => {
    const msg = `Failed to start agent process (${nodeBinary}): ${err.message}`;
    console.error(msg);
    appendAppLog('SYSTEM', msg);
    mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
    sendNotification('Tally Agent Error', msg);
    agentProcess = null;
  });

  _authInvalidFired = false; // Reset on each fresh agent start

  agentProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[Agent]', text.trim());
    appendAppLog('AGENT', text);
    _detectAgentAuthFailure(text); // Catch auth failures in stdout too

    let statusChanged = false;

    // Skip [STATUS_JSON] lines — status now comes via relay SSE, not stdout
    if (text.includes('[STATUS_JSON]')) { return; }

    if (text.includes('Connected to relay server'))  { agentStatus.relay = true; statusChanged = true; agentCrashCount = 0; _agentEscalatedAt = 0; }
    if (text.includes('Relay connection persistent failure')) { sendNotification('Relay Connection Issue', 'Unable to reach the relay server after 10 attempts. Will keep retrying with longer intervals.'); }
    if (text.includes('ATEM connected'))             { agentStatus.atem = { connected: true, model: (agentStatus.atem && agentStatus.atem.model) || '' }; statusChanged = true; }
    if (text.includes('OBS connected'))              { agentStatus.obs = true; statusChanged = true; }
    if (text.includes('Companion connected'))        { if (!agentStatus.companion || typeof agentStatus.companion !== 'object') agentStatus.companion = {}; agentStatus.companion.connected = true; statusChanged = true; }
    if (text.includes('ATEM disconnected'))          { agentStatus.atem = false; statusChanged = true; }
    if (text.includes('OBS disconnected'))           { agentStatus.obs = false; statusChanged = true; }
    if (text.includes('Companion disconnected'))     { if (!agentStatus.companion || typeof agentStatus.companion !== 'object') agentStatus.companion = {}; agentStatus.companion.connected = false; statusChanged = true; }
    if (text.includes('Encoder connected'))          { if (!agentStatus.encoder || typeof agentStatus.encoder !== 'object') agentStatus.encoder = {}; agentStatus.encoder.connected = true; statusChanged = true; }
    if (text.includes('Encoder disconnected'))       { if (!agentStatus.encoder || typeof agentStatus.encoder !== 'object') agentStatus.encoder = {}; agentStatus.encoder.connected = false; statusChanged = true; }
    if (text.includes('ProPresenter connected') || text.includes('ProPresenter WebSocket connected')) {
      if (!agentStatus.proPresenter || typeof agentStatus.proPresenter !== 'object') agentStatus.proPresenter = {};
      agentStatus.proPresenter.connected = true;
      agentStatus.proPresenter.running = true;
      statusChanged = true;
    }
    if (text.includes('ProPresenter disconnected') || text.includes('ProPresenter WebSocket disconnected') || text.includes('ProPresenter not reachable')) {
      if (!agentStatus.proPresenter || typeof agentStatus.proPresenter !== 'object') agentStatus.proPresenter = {};
      agentStatus.proPresenter.connected = false;
      statusChanged = true;
    }
    if (text.includes('Resolume Arena connected')) {
      if (!agentStatus.resolume || typeof agentStatus.resolume !== 'object') agentStatus.resolume = {};
      agentStatus.resolume.connected = true;
      const vm = text.match(/Resolume Arena connected \((.+?)\)/);
      if (vm) agentStatus.resolume.version = vm[1];
      statusChanged = true;
    }
    if (text.includes('Resolume Arena not reachable')) {
      if (!agentStatus.resolume || typeof agentStatus.resolume !== 'object') agentStatus.resolume = {};
      agentStatus.resolume.connected = false;
      statusChanged = true;
    }
    const resolumePollMatch = text.match(/Resolume version detected:\s*(.+)/i);
    if (resolumePollMatch) {
      if (!agentStatus.resolume || typeof agentStatus.resolume !== 'object') agentStatus.resolume = {};
      agentStatus.resolume.version = resolumePollMatch[1].trim();
      statusChanged = true;
    }
    // vMix connected: "✅ vMix connected (Edition Version) — Streaming: ..."
    const vmixConnMatch = text.match(/vMix connected\s*\(([^)]+)\)/i);
    if (vmixConnMatch) {
      if (!agentStatus.vmix || typeof agentStatus.vmix !== 'object') agentStatus.vmix = {};
      agentStatus.vmix.connected = true;
      const parts = vmixConnMatch[1].match(/^(.+?)\s+([\d.]+.*)$/);
      if (parts) { agentStatus.vmix.edition = parts[1]; agentStatus.vmix.version = parts[2]; }
      else { agentStatus.vmix.edition = vmixConnMatch[1]; }
      statusChanged = true;
    }
    if (text.includes('vMix not reachable')) {
      if (!agentStatus.vmix || typeof agentStatus.vmix !== 'object') agentStatus.vmix = {};
      agentStatus.vmix.connected = false;
      statusChanged = true;
    }
    // Mixer connected: "✅ <type> console connected"
    const mixerConnMatch = text.match(/(\w+) console connected/i);
    if (mixerConnMatch) {
      if (!agentStatus.mixer || typeof agentStatus.mixer !== 'object') agentStatus.mixer = {};
      agentStatus.mixer.connected = true;
      agentStatus.mixer.type = mixerConnMatch[1];
      statusChanged = true;
    }
    if (text.includes('console not reachable')) {
      if (!agentStatus.mixer || typeof agentStatus.mixer !== 'object') agentStatus.mixer = {};
      agentStatus.mixer.connected = false;
      statusChanged = true;
    }
    // Parse device identity log lines from church-client
    const encoderIdMatch = text.match(/Encoder identity:\s*(.+)/i);
    if (encoderIdMatch) {
      if (!agentStatus.encoder || typeof agentStatus.encoder !== 'object') agentStatus.encoder = {};
      agentStatus.encoder.details = encoderIdMatch[1].trim();
      statusChanged = true;
    }
    const ppVersionMatch = text.match(/ProPresenter version detected:\s*(.+)/i);
    if (ppVersionMatch) {
      if (!agentStatus.proPresenter || typeof agentStatus.proPresenter !== 'object') agentStatus.proPresenter = {};
      agentStatus.proPresenter.version = ppVersionMatch[1].trim();
      statusChanged = true;
    }
    const vmixIdMatch = text.match(/vMix identity:\s*(.+)/i);
    if (vmixIdMatch) {
      if (!agentStatus.vmix || typeof agentStatus.vmix !== 'object') agentStatus.vmix = {};
      const parts = vmixIdMatch[1].trim();
      // Format: "Edition Version" e.g. "vMix Pro 27.0.0.48"
      const vmixParts = parts.match(/^(\S+(?:\s+\S+)?)\s+([\d.]+.*)$/);
      if (vmixParts) { agentStatus.vmix.edition = vmixParts[1]; agentStatus.vmix.version = vmixParts[2]; }
      else { agentStatus.vmix.edition = parts; }
      statusChanged = true;
    }
    const mixerIdMatch = text.match(/Mixer identity:\s*(.+)/i);
    if (mixerIdMatch) {
      if (!agentStatus.mixer || typeof agentStatus.mixer !== 'object') agentStatus.mixer = {};
      const parts = mixerIdMatch[1].trim();
      // Format: "TYPE Model" e.g. "BEHRINGER XR18"
      const sp = parts.indexOf(' ');
      if (sp > 0) { agentStatus.mixer.type = parts.slice(0, sp); agentStatus.mixer.model = parts.slice(sp + 1); }
      else { agentStatus.mixer.type = parts; }
      statusChanged = true;
    }
    const companionIdMatch = text.match(/Companion identity:\s*(.+)/i);
    if (companionIdMatch) {
      if (!agentStatus.companion || typeof agentStatus.companion !== 'object') agentStatus.companion = {};
      agentStatus.companion.endpoint = companionIdMatch[1].trim();
      statusChanged = true;
    }
    if (text.includes('Relay disconnected')) {
      agentStatus.relay = false;
      // Don't start the watchdog timer when the relay intentionally replaced
      // this connection — the newer connection is already active.
      if (!text.includes('newer connection took over')) {
        agentStatus._relayDisconnectedAt = Date.now();
      }
      statusChanged = true;
    }
    if (text.includes('Connected to relay server')) {
      agentStatus._relayDisconnectedAt = null;
    }

    // Parse audio silence alerts
    if (text.includes('[AudioMonitor]') && text.includes('silence detected')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), silenceDetected: true }; statusChanged = true;
    }
    if (text.includes('AUDIO:') && text.includes('MUTED')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), masterMuted: true }; statusChanged = true;
    }
    if (text.includes('Audio master unmuted')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), masterMuted: false }; statusChanged = true;
    }

    // Parse SignalFailover state transitions
    const failoverMatch = text.match(/\[SignalFailover\]\s+(\S+):\s+(\w+)\s*→\s*(\w+)\s*\(([^)]+)\)(?:\s*\[([^\]]+)\])?/);
    if (failoverMatch) {
      const [, churchId, fromState, toState, trigger, diagType] = failoverMatch;
      const ts = new Date().toISOString();
      if (!agentStatus.failover) agentStatus.failover = { state: 'HEALTHY', transitions: [] };
      agentStatus.failover.state = toState;
      if (diagType) agentStatus.failover.diagnosisType = diagType;
      agentStatus.failover.transitions.unshift({ from: fromState, to: toState, trigger, ts });
      if (agentStatus.failover.transitions.length > 5) agentStatus.failover.transitions.length = 5;
      if (toState !== 'HEALTHY') agentStatus.failover.outageStartedAt = agentStatus.failover.outageStartedAt || ts;
      else agentStatus.failover.outageStartedAt = null;
      statusChanged = true;
      mainWindow?.webContents.send('failover-state', agentStatus.failover);
    }
    // Parse failover diagnosis messages
    if (text.includes('[SignalFailover]') && text.includes('Diagnosis:')) {
      const diagMatch = text.match(/Diagnosis:\s*(.+)/);
      if (diagMatch) {
        if (!agentStatus.failover) agentStatus.failover = { state: 'HEALTHY', transitions: [] };
        agentStatus.failover.diagnosisMessage = diagMatch[1].trim();
        mainWindow?.webContents.send('failover-state', agentStatus.failover);
      }
    }
    // Parse failover recovery
    if (text.includes('[SignalFailover]') && text.includes('Recovery executed')) {
      if (agentStatus.failover) {
        agentStatus.failover.state = 'HEALTHY';
        agentStatus.failover.outageStartedAt = null;
        agentStatus.failover.diagnosisMessage = null;
        agentStatus.failover.diagnosisType = null;
        statusChanged = true;
        mainWindow?.webContents.send('failover-state', agentStatus.failover);
      }
    }

    // Parse ATEM model, program/preview inputs, recording from status logs
    const atemModelMatch = text.match(/ATEM model detected:\s*(.+)/i);
    if (atemModelMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.model = atemModelMatch[1].trim(); statusChanged = true;
    }
    const progInputMatch = text.match(/Program: Input (\d+)/);
    if (progInputMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.programInput = parseInt(progInputMatch[1]); statusChanged = true;
    }
    const prevInputMatch = text.match(/Preview: Input (\d+)/);
    if (prevInputMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.previewInput = parseInt(prevInputMatch[1]); statusChanged = true;
    }
    // Parse ATEM input labels (e.g. ATEM Labels: {"1":"Camera 1","2":"Camera 2",...})
    const labelsMatch = text.match(/ATEM Labels: (\{.+\})/);
    if (labelsMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      try {
        agentStatus.atem.inputLabels = JSON.parse(labelsMatch[1]);
        statusChanged = true;
      } catch (e) { console.warn('ATEM labels parse error:', e?.message); }
    }
    if (text.includes('recording STARTED') && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.recording = true; statusChanged = true;
    }
    if (text.includes('recording STOPPED') && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.recording = false; statusChanged = true;
    }

    // Parse streaming/FPS from status logs
    if (text.includes('Stream STARTED'))  { agentStatus.streaming = true; statusChanged = true; }
    if (text.includes('Stream STOPPED'))  { agentStatus.streaming = false; statusChanged = true; }
    const fpsMatch = text.match(/Low stream FPS: (\d+)/);
    if (fpsMatch) { agentStatus.fps = parseInt(fpsMatch[1]); statusChanged = true; }

    // Detect chat messages from agent WebSocket
    const chatLineMatch = text.match(/\[CHAT\]\s*(\{.+\})/);
    if (chatLineMatch) {
      try {
        const chatMsg = JSON.parse(chatLineMatch[1]);
        mainWindow?.webContents.send('chat-message', chatMsg);
      } catch (e) { console.warn('Chat line parse error:', e?.message); }
    }

    // Detect config updates pushed from portal
    const configUpdateMatch = text.match(/\[CONFIG_UPDATE\]\s*(\{.+\})/);
    if (configUpdateMatch) {
      try {
        const update = JSON.parse(configUpdateMatch[1]);
        const config = configManager.loadConfig();
        const currentRoom = config.roomId || config.roomName || (config.churchId + '_default');
        // Equipment updates are per-room — only apply if it matches current room
        if (update.section === 'equipment' && update.roomId && update.roomId !== currentRoom) {
          console.log(`[ConfigSync] Ignoring equipment update for room ${update.roomId} (current: ${currentRoom})`);
        } else if (update.section === 'equipment' && update.data) {
          configManager.mergeEquipmentFromServer(update.data);
          console.log('[ConfigSync] Equipment config updated from portal');
          mainWindow?.webContents.send('config-updated', { section: 'equipment' });
        } else if (update.section === 'failover' || update.section === 'profile') {
          console.log(`[ConfigSync] ${update.section} config updated from portal`);
          mainWindow?.webContents.send('config-updated', { section: update.section, data: update.data });
        }
      } catch (e) { console.warn('Config update parse error:', e?.message); }
    }

    // Detect room deletion notification from relay
    const roomDeletedMatch = text.match(/\[ROOM_DELETED\]\s*(\{.+\})/);
    if (roomDeletedMatch) {
      try {
        const { roomId, roomName } = JSON.parse(roomDeletedMatch[1]);
        appendAppLog('SYSTEM', `Room "${roomName || roomId}" was deleted from portal — stopping agent and returning to room selector`);
        // Stop the agent (sets agentProcess = null to prevent auto-restart)
        stopAgent();
        // Clear room assignment from config
        const cfg = loadConfig();
        cfg.roomId = null;
        cfg.roomName = null;
        saveConfig(cfg);
        // Reset device status
        agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
        mainWindow?.webContents.send('status', agentStatus);
        // Notify renderer to show room selector
        mainWindow?.webContents.send('room-deleted', { roomId, roomName });
      } catch (e) { console.warn('Room deleted parse error:', e?.message); }
    }

    // Only run expensive notification/UI updates when status actually changed
    if (statusChanged) {
      checkAndNotify();
      mainWindow?.webContents.send('status', agentStatus);
      updateTray();
    }
    problemFinderBridge.onAgentEvent(text);
    mainWindow?.webContents.send('log', text);
  });

  agentProcess.stderr.on('data', (data) => {
    const text = data.toString();
    appendAppLog('AGENT_ERR', text);
    mainWindow?.webContents.send('log', '[err] ' + text);
    _detectAgentAuthFailure(text);
  });

  agentProcess.on('close', (code) => {
    const wasManualStop = agentProcess === null; // stopAgent() sets this to null before kill
    agentProcess = null;
    const savedEncoderType = agentStatus.encoderType;
    const closedConfig = loadConfig();
    agentStatus = {
      relay: false,
      atem: closedConfig.atemIp ? false : null,
      obs: false,
      companion: closedConfig.companionUrl ? false : null,
      encoder: closedConfig.encoder?.type ? false : null,
      encoderType: savedEncoderType,
      audio: {},
      failover: null,
      resolume: closedConfig.resolume?.host
        ? { connected: false, host: closedConfig.resolume.host, port: closedConfig.resolume.port || 8080, version: null }
        : null,
      proPresenter: closedConfig.proPresenter?.host
        ? { connected: false, running: false, host: closedConfig.proPresenter.host, port: closedConfig.proPresenter.port || 1025 }
        : null,
    };
    mainWindow?.webContents.send('status', agentStatus);
    updateTray();
    console.log(`Agent exited with code ${code}`);
    appendAppLog('SYSTEM', `Agent exited with code ${code}${wasManualStop ? ' (manual stop)' : ''}`);
    if (wasManualStop || code === 0) {
      agentCrashCount = 0; // Clean or manual stop — reset counter, no auto-restart
    } else {
      agentCrashCount++;

      // After threshold: send an escalation notification once per 10 minutes max,
      // then keep auto-restarting at capped backoff — never give up.
      if (agentCrashCount >= MAX_AGENT_CRASHES) {
        const now = Date.now();
        const escalationCooldown = 10 * 60 * 1000; // re-alert at most every 10 min
        if (now - _agentEscalatedAt > escalationCooldown) {
          _agentEscalatedAt = now;
          const msg = `Agent has crashed ${agentCrashCount} times. Still auto-restarting — check logs if this persists.`;
          appendAppLog('SYSTEM', msg);
          mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
          sendNotification('Tally Agent — Repeated Crashes', msg);
        }
      }

      // Always schedule a restart — backoff caps at MAX_AGENT_BACKOFF_MS
      const delay = Math.min(5000 * agentCrashCount, MAX_AGENT_BACKOFF_MS);
      appendAppLog('SYSTEM', `Restarting agent in ${delay / 1000}s (crash #${agentCrashCount})`);
      setTimeout(() => startAgent(), delay);
    }
  });
}

function stopAgent() {
  stopRelayStatusSSE();
  if (agentProcess) {
    appendAppLog('SYSTEM', 'Stopping agent');
    const proc = agentProcess;
    agentProcess = null; // Prevent auto-restart in the 'close' handler
    proc.kill();
    // Return a promise that resolves when the process actually exits
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) { console.warn('SIGKILL failed:', e?.message); } resolve(); }, 5000);
      proc.on('close', () => { clearTimeout(timeout); resolve(); });
    });
  } else {
    appendAppLog('SYSTEM', 'Stop agent requested but no process was running');
    return Promise.resolve();
  }
}

// ─── RELAY RECONNECT WATCHDOG ────────────────────────────────────────────────
// If relay stays disconnected for 2+ minutes while agent is running, restart it.
const RELAY_RECONNECT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
setInterval(() => {
  if (agentProcess && agentStatus._relayDisconnectedAt) {
    const elapsed = Date.now() - agentStatus._relayDisconnectedAt;
    if (elapsed >= RELAY_RECONNECT_TIMEOUT_MS) {
      appendAppLog('SYSTEM', `Relay disconnected for ${Math.round(elapsed / 1000)}s — restarting agent`);
      mainWindow?.webContents?.send('log', '[Watchdog] Relay disconnected too long — restarting agent');
      agentStatus._relayDisconnectedAt = null; // Reset to avoid repeated kills
      stopAgent().then(() => setTimeout(() => startAgent(), 2000));
    }
  }
}, 30_000); // Check every 30 seconds

// ─── CONNECTION QUALITY INDICATOR ────────────────────────────────────────────
// Periodic HTTP ping to relay to measure round-trip latency (P2 item 11).
const https = require('https');
const http  = require('http');

let _lastPingMs = null;
let _lastPingTime = null;

function measureRelayLatency() {
  const config = configManager.loadConfig();
  const relayUrl = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  const startMs = Date.now();
  const lib = relayUrl.startsWith('https') ? https : http;
  const req = lib.get(relayUrl, { timeout: 5000 }, (res) => {
    res.resume(); // drain
    const ms = Date.now() - startMs;
    _lastPingMs = ms;
    _lastPingTime = new Date().toISOString();
    mainWindow?.webContents.send('connection-quality', { latencyMs: ms, lastPingTime: _lastPingTime });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
}

// Ping every 30s while connected
setInterval(() => {
  if (agentStatus.relay) measureRelayLatency();
}, 30_000);

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────

// ─── RELAY HELPERS (delegated to relay-client module) ─────────────────────────
const { normalizeRelayUrl, isLocalRelayUrl, enforceRelayPolicy, relayHttpUrl,
        decodeChurchIdFromToken } = relayClient;

const { checkTokenWithRelay, postJson, loginChurchWithCredentials,
        testConnection, sendPreviewCommand,
        syncEquipmentToRelay, fetchEquipmentFromRelay,
        fetchRooms, createRoom, assignRoom } = relayClient;


// ─── CONFIG (delegated to config-manager module) ─────────────────────────────
const { loadConfig, saveConfig, resetConfig, loadConfigForUI, isMockValue, stripMockConfig,
        exportPortableConfig, importPortableConfig, switchRoomConfig, saveCurrentRoomEquipment } = configManager;

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfigForUI());
ipcMain.handle('save-config', (_, config) => {
  // Whitelist allowed config keys to prevent injection of arbitrary values
  const ALLOWED_CONFIG_KEYS = new Set([
    'token', 'relay', 'name', 'atemIp', 'companionUrl', 'obsUrl', 'obsPassword',
    'liveStreamUrl', 'setupComplete', 'encoderType', 'encoderHost', 'encoderPort',
    'encoderPassword', 'encoderLabel', 'encoderStatusUrl', 'encoderSource',
    'youtubeApiKey', 'facebookToken', 'rtmpUrl', 'rtmpKey',
    'autoStartMonitoring', 'roomId', 'roomName',
  ]);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const sanitized = {};
  for (const [k, v] of Object.entries(config)) {
    if (ALLOWED_CONFIG_KEYS.has(k)) sanitized[k] = v;
  }
  saveConfig(sanitized);
  return true;
});
// i18n locale data for renderer
ipcMain.handle('get-locale-data', () => ({
  locale: i18n.getLocale(),
  locales: i18n.LOCALES,
}));
ipcMain.handle('set-locale', (_, locale) => {
  i18n.setLocale(locale);
  const prefs = loadPrefs();
  savePrefs({ ...prefs, locale });
  // Rebuild tray with new locale
  updateTray();
  return i18n.getLocale();
});

ipcMain.handle('export-portable-config', async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const defaultPath = path.join(app.getPath('desktop'), `tally-config-${stamp}.json`);
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow || undefined, {
    title: 'Export Tally Config',
    defaultPath,
    filters: [{ name: 'Tally Config', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  try {
    const portable = exportPortableConfig();
    fs.writeFileSync(filePath, JSON.stringify(portable, null, 2), 'utf8');
    appendAppLog('SYSTEM', `Exported portable config to ${filePath}`);
    return { canceled: false, filePath };
  } catch (e) {
    return { canceled: false, error: e.message };
  }
});

ipcMain.handle('import-portable-config', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow || undefined, {
    title: 'Import Tally Config',
    filters: [{ name: 'Tally Config', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return { canceled: true };
  try {
    const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    const result = importPortableConfig(raw);
    if (!result.ok) return { error: result.error };
    appendAppLog('SYSTEM', `Imported portable config from ${filePaths[0]}`);
    return { ok: true };
  } catch (e) {
    return { error: `Failed to read config file: ${e.message}` };
  }
});

ipcMain.handle('get-status', () => agentStatus);
ipcMain.handle('start-agent', () => { agentCrashCount = 0; startAgent(); });
ipcMain.handle('stop-agent', () => stopAgent());
ipcMain.handle('is-running', () => !!agentProcess);
ipcMain.handle('test-connection', (_, opts) => testConnection(opts));
ipcMain.handle('church-auth-login', async (_, payload) => loginChurchWithCredentials(payload || {}));

ipcMain.handle('validate-token', async () => {
  try {
    const config = loadConfig();
    if (!config.token) return { valid: false, reason: 'no-token' };

    // Clear stale roomId on every validation (startup).
    // The user must pick a room from the selector each session.
    // This handles crash scenarios where before-quit didn't fire.
    if (config.roomId) {
      saveConfig({ roomId: undefined });
    }

    // Decode JWT and check expiration locally first
    try {
      const parts = config.token.split('.');
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          return { valid: false, reason: 'expired', churchName: payload.name || config.name || '' };
        }
      }
    } catch (e) {
      // If we can't decode the JWT, still try server validation
      console.warn('JWT decode failed:', e?.message);
    }

    // Server-side validation — always enforce relay policy so stale config URLs don't persist
    const relay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
    const result = await checkTokenWithRelay(config.token, relay, 8000);
    if (result.success) {
      // Sync church profile flags from relay (e.g. audio_via_atem)
      try {
        const profileUrl = `${relayHttpUrl(relay).replace(/\/+$/, '')}/api/church/app/me`;
        const resp = await fetch(profileUrl, {
          headers: { 'Authorization': `Bearer ${config.token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const profile = await resp.json();
          if (profile.audio_via_atem !== undefined) {
            saveConfig({ audioViaAtem: profile.audio_via_atem ? 1 : 0 });
          }
        }
      } catch (e) { console.warn('Profile sync failed:', e?.message); }

      // Equipment bootstrap is deferred until the user selects a room.
      // The room selector (shown every launch) triggers fullRoomSwitch which
      // handles fetching equipment from relay for the chosen room.
      // This prevents stale roomId from pre-loading the wrong room's equipment.

      return { valid: true, churchName: config.name || '' };
    }
    return { valid: false, reason: result.error || 'invalid', churchName: config.name || '' };
  } catch (e) {
    return { valid: false, reason: e.message || 'validation-error' };
  }
});

function performSignOut() {
  stopAgent();
  clearAllLogs();
  resetConfig(); // atomic wipe — no credential bleed via saveConfig merge
  agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} };
  mainWindow?.webContents.send('status', agentStatus);
  mainWindow?.webContents.send('signed-out');
}

// Wipe all local data when a different church/user logs in.
// Compares the churchId in the old token (if any) with the new token.
// Returns { wiped: true } if config was reset, { wiped: false } otherwise.
ipcMain.handle('prepare-for-login', async (_, { newToken }) => {
  try {
    const oldConfig = loadConfig();
    const oldChurchId = oldConfig.token ? decodeChurchIdFromToken(oldConfig.token) : null;
    const newChurchId = newToken ? decodeChurchIdFromToken(newToken) : null;

    if (oldChurchId && newChurchId && oldChurchId !== newChurchId) {
      // Different user/church — clean slate
      stopAgent();
      resetConfig();
      agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
      mainWindow?.webContents.send('status', agentStatus);
      return { wiped: true };
    }

    // Same user or no previous session — still stop agent if running
    if (agentProcess) {
      stopAgent();
      agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
      mainWindow?.webContents.send('status', agentStatus);
    }
    return { wiped: false };
  } catch (e) {
    return { wiped: false, error: e.message };
  }
});

ipcMain.handle('sign-out', async () => {
  try {
    performSignOut();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('factory-reset', async () => {
  try {
    stopAgent();
    // Clear relay-side equipment before wiping local config (prevents stale IPs re-appearing on next login)
    const preResetConfig = loadConfig();
    if (preResetConfig.roomId && preResetConfig.token) {
      await syncEquipmentToRelay(preResetConfig.roomId, {}).catch(() => {});
    }
    clearAllLogs();
    resetConfig();
    agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} };
    mainWindow?.webContents.send('status', agentStatus);
    mainWindow?.webContents.send('signed-out');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('copy-to-clipboard', (_, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('open-external', (_, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
  }
  return true;
});

// ─── DIAGNOSTIC BUNDLE IPC ────────────────────────────────────────────────────
ipcMain.handle('send-diagnostic-bundle', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  const churchId = decodeChurchIdFromToken(config.token);
  if (!churchId) return { error: 'Could not determine church ID' };
  try {
    const resp = await fetch(`${relayHttp}/api/church/${churchId}/diagnostic-bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      return { error: body.error || `Request failed (${resp.status})` };
    }
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── SEND COMMAND IPC (troubleshooter auto-actions) ────────────────────────────
ipcMain.handle('send-command', async (_, cmd, params) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/app/send-command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ command: cmd, params: params || {} }),
    });
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── CHAT IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('send-chat', async (_, { message, senderName, roomId }) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ message, senderName: senderName || config.churchName || 'TD', roomId: roomId || config.roomId || null }),
    });
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── FILE UPLOAD (for AI setup assistant) ─────────────────────────────────────

ipcMain.handle('pick-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
      { name: 'Documents', extensions: ['csv', 'txt', 'pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const fileName = require('path').basename(filePath);
  // Infer MIME type from extension
  const ext = fileName.split('.').pop().toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf',
  };
  return { filePath, fileName, mimeType: mimeMap[ext] || 'application/octet-stream' };
});

ipcMain.handle('upload-chat-file', async (_, { message, filePath, fileName, mimeType }) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);

  try {
    // Read file and base64-encode
    const fileData = require('fs').readFileSync(filePath);
    const base64Data = fileData.toString('base64');

    // Check size (max ~768KB raw = ~1MB base64, within Express 1MB limit)
    if (base64Data.length > 900000) {
      return { error: 'File too large. Maximum size is approximately 700KB.' };
    }

    const resp = await fetch(`${relayHttp}/api/church/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({
        message: message || '',
        senderName: config.churchName || 'TD',
        attachment: { data: base64Data, mimeType, fileName },
        roomId: config.roomId || null,
      }),
    });
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('get-chat', async (_, opts = {}) => {
  const config = loadConfig();
  if (!config.token) return { messages: [] };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.latest) params.set('latest', 'true');
  if (opts.limit) params.set('limit', String(opts.limit));
  // Pass roomId to scope chat history to current room
  const roomId = opts.roomId || config.roomId;
  if (roomId) params.set('roomId', roomId);
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const resp = await fetch(`${relayHttp}/api/church/chat${qs}`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    return await resp.json();
  } catch (e) {
    console.warn('Chat fetch failed:', e?.message);
    return { messages: [] };
  }
});
ipcMain.handle('get-network-interfaces', () => listAvailableInterfaces());

// ─── PRE-SERVICE STATUS IPC ───────────────────────────────────────────────────
ipcMain.handle('preservice-status', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/preservice-check`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── SESSION RECAP IPC ───────────────────────────────────────────────────────
ipcMain.handle('get-session-latest', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/session/active`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── AUTO-START CONFIG IPC ───────────────────────────────────────────────────
ipcMain.handle('get-autostart', () => {
  const config = loadConfig();
  // Default to true (enabled) if not explicitly set
  const enabled = config.autoStartMonitoring !== undefined ? !!config.autoStartMonitoring : true;
  return { enabled };
});

ipcMain.handle('set-autostart', (_, enabled) => {
  saveConfig({ autoStartMonitoring: enabled ? 1 : 0 });
  return { ok: true };
});

// ─── PRE-SERVICE CHECK IPC ────────────────────────────────────────────────────
ipcMain.handle('get-preservice-check', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/preservice-check`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('run-preservice-check', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/preservice-check/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('fix-all-preservice', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/preservice-check/fix-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── RUNDOWN IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('get-active-rundown', async () => {
  const config = loadConfig();
  if (!config.token) return { active: false };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/rundown/active`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { active: false };
    return await resp.json();
  } catch (e) { console.warn('Rundown fetch failed:', e?.message); return { active: false }; }
});

ipcMain.handle('execute-rundown-step', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/rundown/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('advance-rundown-step', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/rundown/advance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('jump-to-rundown-step', async (_, idx) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/rundown/jump`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ stepIndex: idx }),
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('deactivate-rundown', async () => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/rundown/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
    });
    if (!resp.ok) return { error: `Server returned ${resp.status}` };
    return await resp.json();
  } catch (e) { return { error: e.message }; }
});

ipcMain.handle('export-test-logs', async () => {
  try {
    return await exportTestLogs();
  } catch (e) {
    appendAppLog('SYSTEM', `Failed to export logs: ${e.message}`);
    return { canceled: false, error: e.message || 'Failed to export logs' };
  }
});

// ─── ENGINEER PROFILE IPC ─────────────────────────────────────────────────────
ipcMain.handle('save-engineer-profile', async (_, profile) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/app/me`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ engineerProfile: profile }),
    });
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
});

// ─── STREAM PLATFORM OAUTH IPC ────────────────────────────────────────────────

const oauthFlow = require('./oauthFlow');
oauthFlow.init({ loadConfig, saveConfig, relayHttpUrl, getMainWindow: () => mainWindow, defaultRelayUrl: DEFAULT_RELAY_URL });

ipcMain.handle('oauth-youtube-connect', () => oauthFlow.startYouTubeOAuth());
ipcMain.handle('oauth-facebook-connect', () => oauthFlow.startFacebookOAuth());
ipcMain.handle('oauth-facebook-select-page', (_, { pageId }) => oauthFlow.selectFacebookPage(pageId));
ipcMain.handle('oauth-facebook-list-pages', () => oauthFlow.listFacebookPages());
ipcMain.handle('oauth-youtube-disconnect', () => oauthFlow.disconnectPlatform('youtube'));
ipcMain.handle('oauth-facebook-disconnect', () => oauthFlow.disconnectPlatform('facebook'));
ipcMain.handle('oauth-status', () => oauthFlow.getOAuthStatus());
ipcMain.handle('oauth-stream-keys', () => oauthFlow.getStreamKeys());

// ─── EQUIPMENT CONFIG IPC ─────────────────────────────────────────────────────

const { discoverDevices, listAvailableInterfaces } = require('./networkScanner');

// ─── EQUIPMENT TESTING (delegated to equipment-tester module) ─────────────────
const { runLocalCommand } = equipmentTester;


ipcMain.handle('scan-network', async (event, options = {}) => {
  const results = await discoverDevices((percent, message) => {
    mainWindow?.webContents.send('scan-progress', { percent, message });
  }, options);
  return results;
});

ipcMain.handle('test-equipment-connection', async (_, params) => {
  // Delegate to equipment-tester module (uses correct UDP probes for ATEM/mixers)
  return equipmentTester.testEquipmentConnection(params);
});


// ─── Room management (list / create / assign) ──────────────────────────────

ipcMain.handle('get-rooms', async () => {
  return fetchRooms();
});

ipcMain.handle('create-room', async (_, { name, description }) => {
  return createRoom(name, description);
});

ipcMain.handle('assign-room', async (_, { roomId }) => {
  const result = await assignRoom(roomId);
  if (result.success) {
    const config = loadConfig();
    config.roomId = result.roomId;
    config.roomName = result.roomName;
    saveConfig(config);
  }
  return result;
});

// ─── Full room switch (stop agent → switch config → clear status → restart) ─
ipcMain.handle('full-room-switch', async (_, { fromRoom, toRoom, toRoomId }) => {
  // 1. Stop agent and SSE
  stopAgent();

  // 2. Push OLD room equipment to relay BEFORE switching local config
  const beforeConfig = loadConfig();
  const fromRoomId = beforeConfig.roomId;
  if (fromRoomId && beforeConfig.token) {
    const { extractEquipment } = configManager;
    syncEquipmentToRelay(fromRoomId, extractEquipment(beforeConfig)).catch(() => {});
  }

  // 3. Save old room equipment locally, clear equipment for new room
  switchRoomConfig(fromRoom || '', toRoom || '');

  // 4. Fetch new room equipment from relay (server-authoritative)
  let source = 'none';
  if (toRoomId && beforeConfig.token) {
    const remoteEquip = await fetchEquipmentFromRelay(toRoomId);
    const fresh = loadConfig();
    if (remoteEquip) {
      // Apply server equipment
      for (const key of configManager.ROOM_EQUIPMENT_KEYS) {
        fresh[key] = remoteEquip[key] !== undefined ? remoteEquip[key] : undefined;
      }
      if (!fresh.roomConfigs) fresh.roomConfigs = {};
      fresh.roomConfigs[toRoom || '_default'] = remoteEquip;
      source = 'relay';
    } else {
      // Server has no config for this room — clear equipment so we don't use stale data
      for (const key of configManager.ROOM_EQUIPMENT_KEYS) {
        fresh[key] = undefined;
      }
      source = 'none';
    }
    saveConfig(fresh);
  }

  // 5. Assign room on relay
  const assignResult = await assignRoom(toRoomId);
  if (assignResult.success) {
    const cfg = loadConfig();
    cfg.roomId = assignResult.roomId;
    cfg.roomName = assignResult.roomName;
    saveConfig(cfg);
  }

  // 6. Clear all device status
  agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
  mainWindow?.webContents.send('status', agentStatus);

  // 7. Restart agent
  agentCrashCount = 0;
  startAgent();

  return { ok: true, roomName: assignResult.roomName || toRoom, source };
});

// ─── Per-room equipment switching ────────────────────────────────────────────
// Called from renderer before saving roomId/roomName. Persists current equipment
// under the old room name, then loads saved equipment for the new room.
ipcMain.handle('switch-room', async (_, { fromRoom, toRoom, toRoomId }) => {
  // 1. Push OLD room equipment to relay BEFORE switching local config
  const beforeConfig = loadConfig();
  const fromRoomId = beforeConfig.roomId;
  if (fromRoomId && beforeConfig.token) {
    const { extractEquipment } = configManager;
    syncEquipmentToRelay(fromRoomId, extractEquipment(beforeConfig)).catch(() => {});
  }

  // 2. Save old room equipment locally, clear equipment for new room
  switchRoomConfig(fromRoom || '', toRoom || '');

  // 3. Fetch equipment from relay (server-authoritative)
  if (toRoomId && beforeConfig.token) {
    const remoteEquip = await fetchEquipmentFromRelay(toRoomId);
    const fresh = loadConfig();
    if (remoteEquip) {
      for (const key of configManager.ROOM_EQUIPMENT_KEYS) {
        fresh[key] = remoteEquip[key] !== undefined ? remoteEquip[key] : undefined;
      }
      if (!fresh.roomConfigs) fresh.roomConfigs = {};
      fresh.roomConfigs[toRoom || '_default'] = remoteEquip;
      saveConfig(fresh);
      return { loaded: true, source: 'relay' };
    } else {
      // Server has no config — clear equipment so we don't use stale data
      for (const key of configManager.ROOM_EQUIPMENT_KEYS) {
        fresh[key] = undefined;
      }
      saveConfig(fresh);
      return { loaded: false, source: 'none' };
    }
  }

  return { loaded: false, source: 'none' };
});

// ─── Fetch room equipment from relay (server-authoritative) ─────────────────
// Used on initial room selection and any time we need to pull fresh config.
ipcMain.handle('fetch-room-equipment', async (_, { roomId }) => {
  const config = loadConfig();
  if (!roomId || !config.token) return { loaded: false, source: 'none' };

  const remoteEquip = await fetchEquipmentFromRelay(roomId);
  if (remoteEquip) {
    const fresh = loadConfig();
    for (const key of configManager.ROOM_EQUIPMENT_KEYS) {
      fresh[key] = remoteEquip[key] !== undefined ? remoteEquip[key] : undefined;
    }
    const roomName = fresh.roomName || '_default';
    if (!fresh.roomConfigs) fresh.roomConfigs = {};
    fresh.roomConfigs[roomName] = remoteEquip;
    saveConfig(fresh);
    return { loaded: true, source: 'relay' };
  }
  return { loaded: false, source: 'none' };
});

ipcMain.handle('save-equipment', (_, equipConfig) => {
  if (!equipConfig || typeof equipConfig !== 'object' || Array.isArray(equipConfig)) return;

  // Sanitize IP/hostname: strip anything that isn't alphanumeric, dots, hyphens, colons
  const sanitizeHost = (v) => typeof v === 'string' ? v.replace(/[^a-zA-Z0-9.\-:]/g, '').slice(0, 255) : '';
  // Sanitize port: coerce to integer within valid range
  const sanitizePort = (v, fallback) => {
    const n = parseInt(v);
    return (Number.isFinite(n) && n >= 1 && n <= 65535) ? n : (fallback || null);
  };
  // Sanitize URL: must start with http/https/ws/wss or be empty
  const sanitizeUrl = (v) => {
    if (typeof v !== 'string') return '';
    const trimmed = v.trim();
    if (!trimmed) return '';
    if (/^(https?|wss?):\/\//i.test(trimmed)) return trimmed.slice(0, 2048);
    return '';
  };

  const config = loadConfig();
  if (equipConfig.atemIp !== undefined) config.atemIp = sanitizeHost(equipConfig.atemIp);
  if (equipConfig.companionUrl !== undefined) config.companionUrl = sanitizeUrl(equipConfig.companionUrl);
  if (equipConfig.obsUrl !== undefined) config.obsUrl = sanitizeUrl(equipConfig.obsUrl);
  if (equipConfig.obsPassword !== undefined) config.obsPassword = typeof equipConfig.obsPassword === 'string' ? equipConfig.obsPassword.slice(0, 512) : '';
  if (equipConfig.atemAutoRecord !== undefined) config.atemAutoRecord = !!equipConfig.atemAutoRecord;
  if (equipConfig.hyperdecks !== undefined) config.hyperdecks = equipConfig.hyperdecks;
  if (equipConfig.videoHubs !== undefined) config.videoHubs = equipConfig.videoHubs;
  if (equipConfig.ptz !== undefined) config.ptz = equipConfig.ptz;
  if (equipConfig.proPresenterHost !== undefined) {
    config.proPresenter = equipConfig.proPresenterHost
      ? {
          host: sanitizeHost(equipConfig.proPresenterHost),
          port: sanitizePort(equipConfig.proPresenterPort, 1025),
          triggerMode: equipConfig.proPresenterTriggerMode || 'presentation',
          backupHost: equipConfig.proPresenterBackupHost ? sanitizeHost(equipConfig.proPresenterBackupHost) : '',
          backupPort: sanitizePort(equipConfig.proPresenterBackupPort, 1025),
        }
      : null;
  }
  if (equipConfig.vmixHost !== undefined) {
    config.vmix = equipConfig.vmixHost
      ? { host: sanitizeHost(equipConfig.vmixHost), port: sanitizePort(equipConfig.vmixPort, 8088) }
      : null;
  }
  if (equipConfig.resolumeHost !== undefined) {
    config.resolume = equipConfig.resolumeHost
      ? { host: sanitizeHost(equipConfig.resolumeHost), port: sanitizePort(equipConfig.resolumePort, 8080) }
      : null;
  }
  if (equipConfig.mixerHost !== undefined) {
    config.mixer = equipConfig.mixerHost && equipConfig.mixerType
      ? {
          type: typeof equipConfig.mixerType === 'string' ? equipConfig.mixerType.slice(0, 64) : '',
          host: sanitizeHost(equipConfig.mixerHost),
          port: sanitizePort(equipConfig.mixerPort, null),
        }
      : null;
  }
  // Save encoders array (new multi-encoder format)
  if (Array.isArray(equipConfig.encoders)) {
    config.encoders = equipConfig.encoders;
    // Primary encoder for church-client backward compat
    config.encoder = equipConfig.encoders[0] || null;
  }
  // Also accept flat primary encoder fields (legacy / wizard)
  if (equipConfig.encoderType !== undefined && !Array.isArray(equipConfig.encoders)) {
    config.encoder = equipConfig.encoderType
      ? {
          type: equipConfig.encoderType,
          host: equipConfig.encoderHost || '',
          port: equipConfig.encoderPort || null,
          password: equipConfig.encoderPassword || '',
          label: equipConfig.encoderLabel || '',
          statusUrl: equipConfig.encoderStatusUrl || '',
        }
      : null;
    // Wrap single encoder into encoders array
    config.encoders = config.encoder ? [config.encoder] : [];
  }
  // Clean up legacy flat encoder keys (prevent stale values overriding nested object)
  if (equipConfig.encoderType !== undefined || Array.isArray(equipConfig.encoders)) {
    delete config.encoderType;
    delete config.encoderHost;
    delete config.encoderPort;
    delete config.encoderPassword;
    delete config.encoderLabel;
    delete config.encoderStatusUrl;
    delete config.encoderSource;
  }
  if (equipConfig.rtmpUrl !== undefined) config.rtmpUrl = equipConfig.rtmpUrl;
  if (equipConfig.rtmpStreamKey !== undefined && equipConfig.rtmpStreamKey) config.rtmpStreamKey = equipConfig.rtmpStreamKey;
  // Streaming API keys — only overwrite if user entered a new value (not empty placeholder)
  if (equipConfig.youtubeApiKey) config.youtubeApiKey = equipConfig.youtubeApiKey;
  if (equipConfig.facebookAccessToken) config.facebookAccessToken = equipConfig.facebookAccessToken;
  if (equipConfig.vimeoAccessToken) config.vimeoAccessToken = equipConfig.vimeoAccessToken;
  // Audio-via-ATEM flag + override
  if (equipConfig.audioViaAtem !== undefined) config.audioViaAtem = equipConfig.audioViaAtem ? 1 : 0;
  if (equipConfig.audioViaAtemOverride !== undefined) config.audioViaAtemOverride = equipConfig.audioViaAtemOverride || null;
  saveConfig(config);

  // Sync audioViaAtem flag to relay profile (fire and forget)
  if (equipConfig.audioViaAtem !== undefined && config.token) {
    const relay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
    fetch(`${relayHttpUrl(relay).replace(/\/+$/, '')}/api/church/app/me`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioViaAtem: equipConfig.audioViaAtem ? 1 : 0 }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {}); // non-critical
  }

  // Auto-persist equipment under the current room name
  saveCurrentRoomEquipment();

  // Push full equipment config to relay (fire-and-forget)
  const { extractEquipment, ROOM_EQUIPMENT_KEYS } = configManager;
  if (config.roomId && config.token) {
    syncEquipmentToRelay(config.roomId, extractEquipment(config)).catch(() => {});
  }

  return true;
});

ipcMain.handle('get-equipment', () => {
  const config = loadConfig();
  return {
    atemIp: config.atemIp || '',
    companionUrl: config.companionUrl || '',
    obsUrl: config.obsUrl || '',
    obsPasswordSet: !!(config.obsPassword),
    obsPassword: config.obsPassword ? '••••••••' : '',
    atemAutoRecord: !!config.atemAutoRecord,
    hyperdecks: config.hyperdecks || [],
    videoHubs: config.videoHubs || [],
    ptz: config.ptz || [],
    proPresenterConfigured: !!config.proPresenter?.host,
    proPresenterHost: config.proPresenter?.host || '',
    proPresenterPort: config.proPresenter?.port || 1025,
    proPresenterTriggerMode: config.proPresenter?.triggerMode || 'presentation',
    proPresenterBackupHost: config.proPresenter?.backupHost || '',
    proPresenterBackupPort: config.proPresenter?.backupPort || 1025,
    vmixConfigured: !!config.vmix?.host,
    vmixHost: config.vmix?.host || '',
    vmixPort: config.vmix?.port || 8088,
    resolumeConfigured: !!config.resolume?.host,
    resolumeHost: config.resolume?.host || '',
    resolumePort: config.resolume?.port || 8080,
    mixerType: config.mixer?.type || '',
    mixerHost: config.mixer?.host || '',
    mixerPort: config.mixer?.port || '',
    audioViaAtem: config.audioViaAtem || 0,
    audioViaAtemOverride: config.audioViaAtemOverride || null,
    // Multi-encoder array (new format)
    encoders: config.encoders || (config.encoder ? [config.encoder] : []),
    // Primary encoder flat fields (backward compat)
    encoderType: config.encoder?.type || '',
    encoderHost: config.encoder?.host || '',
    encoderPort: config.encoder?.port || '',
    encoderPassword: config.encoder?.password ? '••••••••' : '',
    encoderLabel: config.encoder?.label || '',
    encoderStatusUrl: config.encoder?.statusUrl || '',
    rtmpUrl: config.rtmpUrl || '',
    rtmpKeySet: !!(config.rtmpStreamKey),
    youtubeKeySet: !!(config.youtubeApiKey),
    facebookTokenSet: !!(config.facebookAccessToken),
    vimeoTokenSet: !!(config.vimeoAccessToken),
  };
});

// ─── SIGNAL FAILOVER IPC ─────────────────────────────────────────────────────

ipcMain.handle('get-failover-config', async () => {
  const config = loadConfig();
  if (!config.token) return { enabled: false };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/failover`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!res.ok) return { enabled: false };
    return await res.json();
  } catch (e) {
    console.warn('Failover config fetch failed:', e?.message);
    return { enabled: false };
  }
});

ipcMain.handle('save-failover-config', async (_, failoverConfig) => {
  const config = loadConfig();
  if (!config.token) return { ok: false, error: 'Not authenticated' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/failover`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(failoverConfig),
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-failover-state', () => {
  return agentStatus.failover || { state: 'HEALTHY', transitions: [] };
});

ipcMain.handle('get-failover-sources', async () => {
  const config = loadConfig();
  if (!config.token) return { atem: [], videohub: [], obs: [] };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/failover/sources`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!res.ok) return { atem: [], videohub: [], obs: [] };
    return await res.json();
  } catch (e) {
    console.warn('Failover sources fetch failed:', e?.message);
    return { atem: [], videohub: [], obs: [] };
  }
});

// ─── ONBOARDING CHAT IPC ─────────────────────────────────────────────────────

ipcMain.handle('onboarding-chat', async (_, payload) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not authenticated' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/onboarding/chat`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { error: `Server error ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('onboarding-confirm', async (_, payload) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not authenticated' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/onboarding/confirm`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { error: `Server error ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('onboarding-state', async () => {
  const config = loadConfig();
  if (!config.token) return { state: null };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const res = await fetch(`${relayHttp}/api/church/onboarding/state`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    if (!res.ok) return { state: null };
    return await res.json();
  } catch (e) {
    console.warn('Onboarding state fetch failed:', e?.message);
    return { state: null };
  }
});

// ─── PROBLEM FINDER IPC ──────────────────────────────────────────────────────

ipcMain.handle('pf-analyze', () => problemFinderBridge.runAnalysis());
ipcMain.handle('pf-go-no-go', (_, opts) => problemFinderBridge.runGoNoGo(opts));
ipcMain.handle('pf-run-history', () => problemFinderBridge.getRunHistory());
ipcMain.handle('pf-feedback', (_, fb) => problemFinderBridge.recordFeedback(fb));
ipcMain.handle('pf-get-config', () => problemFinderBridge.getFeatureFlags());
ipcMain.handle('pf-simulate-fix', (_, simId) => problemFinderBridge.simulateFix(simId));
ipcMain.handle('pf-available', () => problemFinderBridge.isAvailable());
ipcMain.handle('pf-set-cameras-verified', (_, verified) => problemFinderBridge.setCamerasVerified(verified));
ipcMain.handle('pf-get-cameras-verified', () => problemFinderBridge.getCamerasVerified());

// ─── AUTO-UPDATE ──────────────────────────────────────────────────────────────

function setupAutoUpdate() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    sendNotification('Update Available', `Version ${info.version} is downloading...`);
    mainWindow?.webContents.send('log', `Update available: v${info.version}`);
    mainWindow?.webContents.send('update-available-info', { version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    appendAppLog('SYSTEM', `Auto-update: already on latest version (${info?.version || app.getVersion()})`);
    mainWindow?.webContents.send('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-progress', {
      percent: Math.round(progress.percent || 0),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendNotification('Update Ready', `v${info.version} is ready — restart to install.`);
    mainWindow?.webContents.send('update-ready', true);
    mainWindow?.webContents.send('update-downloaded-info', { version: info.version, releaseNotes: info.releaseNotes || '' });
  });

  autoUpdater.on('error', (err) => {
    const msg = err?.message || 'Unknown update error';
    appendAppLog('SYSTEM', `Auto-update error: ${msg}`);
    mainWindow?.webContents.send('update-error', msg);
  });

  // Check for updates; the interval setting is read from prefs
  const prefs = loadPrefs();
  const intervalHours = Math.max(1, Math.min(168, Number(prefs.updateCheckIntervalHours) || 24));
  autoUpdater.checkForUpdatesAndNotify().catch((e) => {
    appendAppLog('SYSTEM', `Update check failed: ${e?.message}`);
    mainWindow?.webContents.send('update-error', e?.message || 'Update check failed');
  });

  // Periodic re-check based on interval setting
  if (intervalHours < 168) {
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, intervalHours * 60 * 60 * 1000);
  }
}

// ─── WHAT'S NEW SPLASH ────────────────────────────────────────────────────────
// After an update, show a "What's New" notification on first launch of the new version.
function checkWhatsNew() {
  const currentVersion = app.getVersion();
  const prefs = loadPrefs();
  if (prefs.lastSeenVersion !== currentVersion) {
    savePrefs({ lastSeenVersion: currentVersion });
    // Defer until window is ready
    if (mainWindow?.webContents) {
      mainWindow.webContents.send('whats-new', { version: currentVersion });
    }
  }
}

// ─── SINGLE INSTANCE LOCK ─────────────────────────────────────────────────────

// ─── DEEP LINK (tally:// URL scheme) ─────────────────────────────────────────

/**
 * Handle a tally:// deep link URL.
 * Supported schemes:
 *   tally://open              — focus the main window
 *   tally://config?key=value  — pre-fill config fields (non-sensitive only)
 */
function handleDeepLink(url) {
  if (!url || !url.startsWith('tally://')) return;
  appendAppLog('SYSTEM', `Deep link: ${url}`);

  try {
    const parsed = new URL(url);
    const action = parsed.hostname || parsed.pathname.replace(/^\/+/, '');

    if (action === 'open') {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    } else if (action === 'config') {
      // Only allow whitelisted, non-sensitive keys
      const ALLOWED_KEYS = ['relayUrl', 'churchId', 'atemHost', 'companionHost', 'obsHost'];
      const patch = {};
      for (const [k, v] of parsed.searchParams) {
        if (ALLOWED_KEYS.includes(k)) patch[k] = v;
      }
      if (Object.keys(patch).length > 0) {
        const existing = configManager.loadConfig();
        configManager.saveConfig(Object.assign({}, existing, patch));
        appendAppLog('SYSTEM', `Deep link patched config: ${JSON.stringify(patch)}`);
        if (mainWindow) mainWindow.webContents.send('config-updated');
      }
    }
  } catch (err) {
    appendAppLog('WARN', `Deep link parse error: ${err.message}`);
  }
}

// Register tally:// as the app's URL protocol handler
if (process.platform !== 'linux') {
  app.setAsDefaultProtocolClient('tally');
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Someone tried to launch a second instance — focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    // Windows/Linux deep link arrives as a CLI arg in the second instance
    const deepLinkUrl = argv.find((a) => a.startsWith('tally://'));
    if (deepLinkUrl) handleDeepLink(deepLinkUrl);
  });

  // macOS: deep link via open-url event (arrives before or after ready)
  app.on('open-url', (_event, url) => {
    handleDeepLink(url);
  });
}

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  appendAppLog('FATAL', `uncaughtException: ${err?.stack || err?.message || String(err)}`);
});

process.on('unhandledRejection', (reason) => {
  appendAppLog('FATAL', `unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`);
});

app.whenReady().then(() => {
  appendAppLog('SYSTEM', `App ready (version=${app.getVersion()}, platform=${process.platform}/${process.arch})`);
  // Apply saved locale preference
  const prefs = loadPrefs();
  if (prefs.locale) i18n.setLocale(prefs.locale);
  // Apply --church-id provisioning flag (P2 item 17)
  if (_cliOpts.churchId) {
    const existing = configManager.loadConfig();
    if (!existing.churchId) {
      configManager.saveConfig({ churchId: _cliOpts.churchId });
      appendAppLog('SYSTEM', `CLI: provisioned churchId=${_cliOpts.churchId}`);
    }
  }
  createWindow();
  createTray();
  setupAutoUpdate();
  // Agent start is controlled by the renderer after auth validation.
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  stopAgent();
  // Clear roomId so next launch always shows the room selector.
  // Keep roomName + roomConfigs so equipment is preserved per-room.
  // Setting to undefined causes saveConfig's filter to strip the key from disk.
  try {
    if (loadConfig().roomId) {
      saveConfig({ roomId: undefined });
    }
  } catch { /* best effort */ }
  // Clear all logs — next session starts fresh
  clearAllLogs();
});
