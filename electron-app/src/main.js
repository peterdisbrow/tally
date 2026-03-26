const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, clipboard, dialog } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { encryptConfig, decryptConfig } = require('./secureStorage');

// Extracted modules (pure refactoring — see config-manager.js, relay-client.js, equipment-tester.js)
const configManager = require('./config-manager');
const relayClient = require('./relay-client');
const equipmentTester = require('./equipment-tester');
const problemFinderBridge = require('./problem-finder-bridge');

// Auto-update (gracefully optional)
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch { autoUpdater = null; }

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR  = path.dirname(CONFIG_PATH);
const PREFS_PATH  = path.join(CONFIG_DIR, 'prefs.json');

function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; }
}
function savePrefs(updates) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const prefs = loadPrefs();
    fs.writeFileSync(PREFS_PATH, JSON.stringify({ ...prefs, ...updates }, null, 2), 'utf8');
  } catch { /* non-critical */ }
}
const DEFAULT_RELAY_URL = process.env.TALLY_DEFAULT_RELAY_URL || 'wss://api.tallyconnect.app';
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const APP_LOG_PATH = path.join(LOG_DIR, 'tally-app.log');
const MAX_RECENT_LOG_LINES = 2000;

let tray = null;
let mainWindow = null;
let agentProcess = null;
let agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {}, failover: null };
let lastNotifiedState = {};
const recentLogLines = [];
let agentCrashCount = 0;
let _agentEscalatedAt = 0;      // timestamp of last crash-escalation notification
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
    } catch { /* ignore */ }
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
    // Non-blocking write — don't freeze the main process during live service
    fs.appendFile(APP_LOG_PATH, batch, 'utf8', () => {});
  } catch {
    // Logging should never crash the app
  }
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

function createWindow() {
  const savedBounds = loadPrefs().windowBounds || {};
  const winOpts = {
    width: savedBounds.width || 900,
    height: savedBounds.height || 820,
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
    title: 'Tally',
    show: false,
  };
  if (savedBounds.x != null) winOpts.x = savedBounds.x;
  if (savedBounds.y != null) winOpts.y = savedBounds.y;
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
    const tierNames = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Managed', event: 'Event' };
    billingLine = `\u2705 Plan: ${tierNames[billingTier] || billingTier}`;
  }

  const menu = Menu.buildFromTemplate([
    { label: 'Tally', enabled: false },
    { label: statusLine, enabled: false },
    ...(billingLine ? [{ label: billingLine, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => mainWindow?.show() },
    { label: connected ? 'Stop Monitoring' : 'Start Monitoring', click: () => connected ? stopAgent() : startAgent() },
    { type: 'separator' },
    { label: 'Client Portal', click: () => shell.openExternal('https://tallyconnect.app/portal') },
    { label: 'Help & Support', click: () => shell.openExternal('https://tallyconnect.app/help') },
    { label: 'Tally Connect', click: () => shell.openExternal('https://tallyconnect.app') },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => {
      if (autoUpdater) {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {
          dialog.showMessageBox({ type: 'info', title: 'Updates', message: 'You are running the latest version.' });
        });
      } else {
        shell.openExternal('https://github.com/peterdisbrow/tally/releases/latest');
      }
    }},
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; stopAgent(); app.exit(0); } },
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
    obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Blackmagic',
    aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek',
    yolobox: 'YoloBox', 'tally-encoder': 'Tally Encoder',
    ndi: 'NDI Decoder', custom: 'Custom', 'custom-rtmp': 'Custom RTMP', 'rtmp-generic': 'RTMP',
    'atem-streaming': 'ATEM Mini',
  };
  agentStatus.encoderType = encoderTypeNames[config.encoder?.type] || '';

  const nodeLabel = useElectronAsNode ? `${nodeBinary} (ELECTRON_RUN_AS_NODE)` : nodeBinary;
  appendAppLog('SYSTEM', `Starting agent (relay=${agentRelay}, name=${config.name || 'n/a'}, node=${nodeLabel}, script=${clientPaths.script})`);

  const spawnEnv = useElectronAsNode
    ? { ...process.env, ...secretEnv, ELECTRON_RUN_AS_NODE: '1' }
    : { ...process.env, ...secretEnv };

  agentProcess = spawn(nodeBinary, args, {
    cwd: clientPaths.cwd,
    env: spawnEnv,
  });

  agentProcess.on('error', (err) => {
    const msg = `Failed to start agent process (${nodeBinary}): ${err.message}`;
    console.error(msg);
    appendAppLog('SYSTEM', msg);
    mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
    sendNotification('Tally Agent Error', msg);
    agentProcess = null;
  });

  agentProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[Agent]', text.trim());
    appendAppLog('AGENT', text);

    let statusChanged = false;

    if (text.includes('Connected to relay server'))  { agentStatus.relay = true; statusChanged = true; agentCrashCount = 0; _agentEscalatedAt = 0; }
    if (text.includes('ATEM connected'))             { agentStatus.atem = { connected: true, model: (agentStatus.atem && agentStatus.atem.model) || '' }; statusChanged = true; }
    if (text.includes('OBS connected'))              { agentStatus.obs = true; statusChanged = true; }
    if (text.includes('Companion connected'))        { agentStatus.companion = true; statusChanged = true; }
    if (text.includes('ATEM disconnected'))          { agentStatus.atem = false; statusChanged = true; }
    if (text.includes('OBS disconnected'))           { agentStatus.obs = false; statusChanged = true; }
    if (text.includes('Companion disconnected'))     { agentStatus.companion = false; statusChanged = true; }
    if (text.includes('Encoder connected'))          { agentStatus.encoder = true; statusChanged = true; }
    if (text.includes('Encoder disconnected'))       { agentStatus.encoder = false; statusChanged = true; }
    if (text.includes('Relay disconnected')) {
      agentStatus.relay = false;
      agentStatus._relayDisconnectedAt = Date.now();
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
      } catch { /* ignore parse errors */ }
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
      } catch { /* ignore parse errors */ }
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

    // Detect auth rejection (WebSocket close code 1008) and notify renderer
    if (text.includes('1008') || text.includes('Invalid token') || text.includes('Authentication failed') || text.includes('auth') && text.includes('reject')) {
      agentStatus.relay = false;
      mainWindow?.webContents.send('status', agentStatus);
      updateTray();
      mainWindow?.webContents.send('auth-invalid');
    }
  });

  agentProcess.on('close', (code) => {
    const wasManualStop = agentProcess === null; // stopAgent() sets this to null before kill
    agentProcess = null;
    const savedEncoderType = agentStatus.encoderType;
    agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: savedEncoderType, audio: {}, failover: null };
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
  if (agentProcess) {
    appendAppLog('SYSTEM', 'Stopping agent');
    const proc = agentProcess;
    agentProcess = null; // Prevent auto-restart in the 'close' handler
    proc.kill();
    // Return a promise that resolves when the process actually exits
    return new Promise((resolve) => {
      const timeout = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 5000);
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

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────

// ─── RELAY HELPERS (delegated to relay-client module) ─────────────────────────
const { normalizeRelayUrl, isLocalRelayUrl, enforceRelayPolicy, relayHttpUrl,
        decodeChurchIdFromToken } = relayClient;

const { checkTokenWithRelay, postJson, loginChurchWithCredentials,
        testConnection, sendPreviewCommand } = relayClient;


// ─── CONFIG (delegated to config-manager module) ─────────────────────────────
const { loadConfig, saveConfig, loadConfigForUI, isMockValue, stripMockConfig } = configManager;

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfigForUI());
ipcMain.handle('save-config', (_, config) => {
  // Whitelist allowed config keys to prevent injection of arbitrary values
  const ALLOWED_CONFIG_KEYS = new Set([
    'token', 'relay', 'name', 'atemIp', 'companionUrl', 'obsUrl', 'obsPassword',
    'liveStreamUrl', 'setupComplete', 'encoderType', 'encoderHost', 'encoderPort',
    'encoderPassword', 'encoderLabel', 'encoderStatusUrl', 'encoderSource',
    'youtubeApiKey', 'facebookToken', 'rtmpUrl', 'rtmpKey',
    'autoStartMonitoring',
  ]);
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const sanitized = {};
  for (const [k, v] of Object.entries(config)) {
    if (ALLOWED_CONFIG_KEYS.has(k)) sanitized[k] = v;
  }
  saveConfig(sanitized);
  return true;
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

    // Decode JWT and check expiration locally first
    try {
      const parts = config.token.split('.');
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.exp && Date.now() >= payload.exp * 1000) {
          return { valid: false, reason: 'expired', churchName: payload.name || config.name || '' };
        }
      }
    } catch {
      // If we can't decode the JWT, still try server validation
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
      } catch { /* non-critical — profile sync can fail silently */ }
      return { valid: true, churchName: config.name || '' };
    }
    return { valid: false, reason: result.error || 'invalid', churchName: config.name || '' };
  } catch (e) {
    return { valid: false, reason: e.message || 'validation-error' };
  }
});

ipcMain.handle('sign-out', async () => {
  try {
    stopAgent();
    const config = loadConfig();
    // Clear all sensitive credentials — not just the session token
    const SENSITIVE_KEYS = [
      'token', 'churchToken', 'setupComplete',
      'obsPassword', 'youtubeApiKey', 'facebookAccessToken',
      'rtmpStreamKey', 'twitchStreamKey', 'adminApiKey',
      'youtubeOAuthAccessToken', 'youtubeOAuthRefreshToken',
      'facebookOAuthAccessToken', 'youtubeStreamKey', 'facebookStreamKey',
      'youtubeStreamUrl', 'facebookStreamUrl', 'facebookPageName',
    ];
    for (const key of SENSITIVE_KEYS) {
      delete config[key];
    }
    saveConfig(config);
    agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} };
    mainWindow?.webContents.send('status', agentStatus);
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
ipcMain.handle('send-chat', async (_, { message, senderName }) => {
  const config = loadConfig();
  if (!config.token) return { error: 'Not configured' };
  const relayHttp = relayHttpUrl(config.relay || DEFAULT_RELAY_URL);
  try {
    const resp = await fetch(`${relayHttp}/api/church/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
      body: JSON.stringify({ message, senderName: senderName || config.churchName || 'TD' }),
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
  const qs = params.toString() ? `?${params.toString()}` : '';
  try {
    const resp = await fetch(`${relayHttp}/api/church/chat${qs}`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
    });
    return await resp.json();
  } catch {
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
  } catch { return { active: false }; }
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
ipcMain.handle('oauth-youtube-disconnect', () => oauthFlow.disconnectPlatform('youtube'));
ipcMain.handle('oauth-facebook-disconnect', () => oauthFlow.disconnectPlatform('facebook'));
ipcMain.handle('oauth-status', () => oauthFlow.getOAuthStatus());
ipcMain.handle('oauth-stream-keys', () => oauthFlow.getStreamKeys());

// ─── EQUIPMENT CONFIG IPC ─────────────────────────────────────────────────────

ipcMain.handle('request-preview', async (_, action) => {
  const command = action === 'stop' ? 'preview.stop' : 'preview.start';
  return sendPreviewCommand(command);
});
ipcMain.handle('request-preview-frame', async () => sendPreviewCommand('preview.snap'));

const { discoverDevices, listAvailableInterfaces } = require('./networkScanner');

// ─── EQUIPMENT TESTING (delegated to equipment-tester module) ─────────────────
const { runLocalCommand, probeNdiSourceLocal } = equipmentTester;

// ─── NDI MONITORING IPC ──────────────────────────────────────────────────────

ipcMain.handle('probe-ndi', async (_, source) => {
  return probeNdiSourceLocal(source, 5000);
});

ipcMain.handle('capture-ndi-frame', async (_, source) => {
  const ndiSource = String(source || '').trim();
  if (!ndiSource) return { success: false, details: 'No NDI source configured' };

  const args = [
    '-f', 'libndi_newtek',
    '-i', ndiSource,
    '-vframes', '1',
    '-f', 'mjpeg',
    '-q:v', '5',
    'pipe:1',
  ];

  const result = await runLocalCommand('ffmpeg', args, 8000);
  if (result.error && result.error.code === 'ENOENT') {
    return { success: false, details: 'ffmpeg not installed (required for NDI snapshot)' };
  }
  if (result.timedOut) {
    return { success: false, details: `NDI frame capture timed out for "${ndiSource}"` };
  }
  if (!result.ok || !result.stdoutBuf || result.stdoutBuf.length === 0) {
    return { success: false, details: `Could not capture frame from "${ndiSource}"` };
  }
  return {
    success: true,
    frame: result.stdoutBuf.toString('base64'),
    details: 'Frame captured',
  };
});

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
  if (equipConfig.hyperdecks !== undefined) config.hyperdecks = equipConfig.hyperdecks;
  if (equipConfig.videoHubs !== undefined) config.videoHubs = equipConfig.videoHubs;
  if (equipConfig.ptz !== undefined) config.ptz = equipConfig.ptz;
  if (equipConfig.proPresenterHost !== undefined) {
    config.proPresenter = equipConfig.proPresenterHost
      ? { host: sanitizeHost(equipConfig.proPresenterHost), port: sanitizePort(equipConfig.proPresenterPort, 1025) }
      : null;
  }
  if (equipConfig.danteNmosHost !== undefined) config.dante = { nmosHost: sanitizeHost(equipConfig.danteNmosHost), nmosPort: sanitizePort(equipConfig.danteNmosPort, 8080) };
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
    hyperdecks: config.hyperdecks || [],
    videoHubs: config.videoHubs || [],
    ptz: config.ptz || [],
    proPresenterConfigured: !!config.proPresenter?.host,
    proPresenterHost: config.proPresenter?.host || '',
    proPresenterPort: config.proPresenter?.port || 1025,
    danteNmosHost: config.dante?.nmosHost || '',
    danteNmosPort: config.dante?.nmosPort || 8080,
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
  } catch {
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
  } catch {
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
  } catch {
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
  });
  autoUpdater.on('update-downloaded', () => {
    sendNotification('Update Ready', 'Restart to install the update.');
    mainWindow?.webContents.send('update-ready', true);
  });
  autoUpdater.on('error', (err) => {
    console.log('Auto-update error:', err.message);
  });
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// ─── SINGLE INSTANCE LOCK ─────────────────────────────────────────────────────

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance — focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
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
  appendAppLog('SYSTEM', 'App before-quit');
  stopAgent();
});
