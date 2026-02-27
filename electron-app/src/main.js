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
const DEFAULT_RELAY_URL = 'wss://tally-production-cde2.up.railway.app';
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const APP_LOG_PATH = path.join(LOG_DIR, 'tally-app.log');
const MAX_RECENT_LOG_LINES = 2000;

let tray = null;
let mainWindow = null;
let agentProcess = null;
let agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} };
let lastNotifiedState = {};
const recentLogLines = [];
let agentCrashCount = 0;
const MAX_AGENT_CRASHES = 5;

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
    for (const line of lines) {
      const entry = `[${ts}] [${source}] ${line}`;
      recentLogLines.push(entry);
      if (recentLogLines.length > MAX_RECENT_LOG_LINES) {
        recentLogLines.splice(0, recentLogLines.length - MAX_RECENT_LOG_LINES);
      }
      fs.appendFileSync(APP_LOG_PATH, entry + '\n', 'utf8');
    }
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
  mainWindow = new BrowserWindow({
    width: 580,
    height: 820,
    minWidth: 520,
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
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('close', (e) => {
    if (app.isQuitting) {
      mainWindow = null;
      return; // allow the window to close for real
    }
    e.preventDefault();
    mainWindow.hide();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// ─── TRAY ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayIcon('grey'));
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const state = computeTrayState();
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
    { label: connected ? 'Stop Agent' : 'Start Agent', click: () => connected ? stopAgent() : startAgent() },
    { type: 'separator' },
    { label: 'Client Portal', click: () => shell.openExternal('https://tallyconnect.app/portal') },
    { label: 'Help & Support', click: () => shell.openExternal('https://tallyconnect.app/help') },
    { label: 'ATEM School', click: () => shell.openExternal('https://atemschool.com') },
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

function checkAndNotify() {
  // ATEM disconnect (handles both boolean and object states)
  const wasAtemConnected = lastNotifiedState.atem === true || (lastNotifiedState.atem && lastNotifiedState.atem.connected);
  const isAtemConnected = agentStatus.atem === true || (agentStatus.atem && agentStatus.atem.connected);
  if (wasAtemConnected && !isAtemConnected) {
    sendNotification('⚠️ ATEM Disconnected', 'The ATEM switcher has lost connection.');
  }
  // Stream drop
  if (lastNotifiedState.streaming === true && agentStatus.streaming === false) {
    sendNotification('🔴 Stream Stopped', 'The live stream has stopped unexpectedly.');
  }
  // Low FPS
  if (agentStatus.fps && agentStatus.fps < 24 && agentStatus.streaming) {
    sendNotification('⚠️ Low FPS Warning', `Stream FPS dropped to ${agentStatus.fps}`);
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
    '--token', config.token,
    '--relay', agentRelay,
  ];

  if (config.atemIp) args.push('--atem', config.atemIp);
  if (config.obsUrl)       args.push('--obs', config.obsUrl);
  if (config.obsPassword)  args.push('--obs-password', config.obsPassword);
  if (config.name)         args.push('--name', config.name);
  if (config.companionUrl) args.push('--companion', config.companionUrl);

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
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : process.env;

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

    if (text.includes('Connected to relay server'))  agentStatus.relay = true;
    if (text.includes('ATEM connected'))             agentStatus.atem = { connected: true, model: (agentStatus.atem && agentStatus.atem.model) || '' };
    if (text.includes('OBS connected'))              agentStatus.obs = true;
    if (text.includes('Companion connected'))        agentStatus.companion = true;
    if (text.includes('ATEM disconnected'))          agentStatus.atem = false;
    if (text.includes('OBS disconnected'))           agentStatus.obs = false;
    if (text.includes('Companion disconnected'))     agentStatus.companion = false;
    if (text.includes('Encoder connected'))          agentStatus.encoder = true;
    if (text.includes('Encoder disconnected'))       agentStatus.encoder = false;
    if (text.includes('Relay disconnected')) {
      agentStatus.relay = false;
      agentStatus._relayDisconnectedAt = Date.now();
    }
    if (text.includes('Connected to relay server')) {
      agentStatus._relayDisconnectedAt = null;
    }

    // Parse audio silence alerts
    if (text.includes('[AudioMonitor]') && text.includes('silence detected')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), silenceDetected: true };
    }
    if (text.includes('AUDIO:') && text.includes('MUTED')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), masterMuted: true };
    }
    if (text.includes('Audio master unmuted')) {
      agentStatus.audio = { ...(agentStatus.audio || {}), masterMuted: false };
    }

    // Parse ATEM model, program/preview inputs, recording from status logs
    const atemModelMatch = text.match(/ATEM model detected:\s*(.+)/i);
    if (atemModelMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.model = atemModelMatch[1].trim();
    }
    const progInputMatch = text.match(/Program: Input (\d+)/);
    if (progInputMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.programInput = parseInt(progInputMatch[1]);
    }
    const prevInputMatch = text.match(/Preview: Input (\d+)/);
    if (prevInputMatch && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.previewInput = parseInt(prevInputMatch[1]);
    }
    if (text.includes('recording STARTED') && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.recording = true;
    }
    if (text.includes('recording STOPPED') && agentStatus.atem && typeof agentStatus.atem === 'object') {
      agentStatus.atem.recording = false;
    }

    // Parse streaming/FPS from status logs
    if (text.includes('Stream STARTED'))  agentStatus.streaming = true;
    if (text.includes('Stream STOPPED'))  agentStatus.streaming = false;
    const fpsMatch = text.match(/Low stream FPS: (\d+)/);
    if (fpsMatch) agentStatus.fps = parseInt(fpsMatch[1]);

    // Detect chat messages from agent WebSocket
    const chatLineMatch = text.match(/\[CHAT\]\s*(\{.+\})/);
    if (chatLineMatch) {
      try {
        const chatMsg = JSON.parse(chatLineMatch[1]);
        mainWindow?.webContents.send('chat-message', chatMsg);
      } catch { /* ignore parse errors */ }
    }

    checkAndNotify();
    problemFinderBridge.onAgentEvent(text);
    mainWindow?.webContents.send('status', agentStatus);
    mainWindow?.webContents.send('log', text);
    updateTray();
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
    agentProcess = null;
    const savedEncoderType = agentStatus.encoderType;
    agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: savedEncoderType, audio: {} };
    mainWindow?.webContents.send('status', agentStatus);
    updateTray();
    console.log(`Agent exited with code ${code}`);
    appendAppLog('SYSTEM', `Agent exited with code ${code}`);
    if (code === 0) {
      agentCrashCount = 0; // Clean exit — reset counter
    } else {
      agentCrashCount++;
      if (agentCrashCount >= MAX_AGENT_CRASHES) {
        const msg = `Agent crashed ${agentCrashCount} times. Auto-restart disabled — use the Start Agent button to retry.`;
        appendAppLog('SYSTEM', msg);
        mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
        sendNotification('Tally Agent Error', msg);
        agentCrashCount = 0; // Reset so manual start can try again
      } else {
        const delay = Math.min(5000 * agentCrashCount, 30000);
        appendAppLog('SYSTEM', `Restarting agent in ${delay / 1000}s (crash ${agentCrashCount}/${MAX_AGENT_CRASHES})`);
        setTimeout(() => startAgent(), delay);
      }
    }
  });
}

function stopAgent() {
  if (agentProcess) {
    appendAppLog('SYSTEM', 'Stopping agent');
    agentProcess.kill();
    agentProcess = null;
  } else {
    appendAppLog('SYSTEM', 'Stop agent requested but no process was running');
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
      stopAgent();
      setTimeout(() => startAgent(), 3000);
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
ipcMain.handle('save-config', (_, config) => { saveConfig(config); return true; });
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
    delete config.token;
    delete config.setupComplete;
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
  const qs = opts.since ? `?since=${encodeURIComponent(opts.since)}` : '';
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
ipcMain.handle('export-test-logs', async () => {
  try {
    return await exportTestLogs();
  } catch (e) {
    appendAppLog('SYSTEM', `Failed to export logs: ${e.message}`);
    return { canceled: false, error: e.message || 'Failed to export logs' };
  }
});

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
  const config = loadConfig();
  if (equipConfig.atemIp !== undefined) config.atemIp = equipConfig.atemIp;
  if (equipConfig.companionUrl !== undefined) config.companionUrl = equipConfig.companionUrl;
  if (equipConfig.obsUrl !== undefined) config.obsUrl = equipConfig.obsUrl;
  if (equipConfig.obsPassword !== undefined) config.obsPassword = equipConfig.obsPassword;
  if (equipConfig.hyperdecks !== undefined) config.hyperdecks = equipConfig.hyperdecks;
  if (equipConfig.videoHubs !== undefined) config.videoHubs = equipConfig.videoHubs;
  if (equipConfig.ptz !== undefined) config.ptz = equipConfig.ptz;
  if (equipConfig.proPresenterHost !== undefined) {
    config.proPresenter = equipConfig.proPresenterHost
      ? { host: equipConfig.proPresenterHost, port: equipConfig.proPresenterPort || 1025 }
      : null;
  }
  if (equipConfig.danteNmosHost !== undefined) config.dante = { nmosHost: equipConfig.danteNmosHost, nmosPort: equipConfig.danteNmosPort || 8080 };
  if (equipConfig.vmixHost !== undefined) {
    config.vmix = equipConfig.vmixHost
      ? { host: equipConfig.vmixHost, port: equipConfig.vmixPort || 8088 }
      : null;
  }
  if (equipConfig.resolumeHost !== undefined) {
    config.resolume = equipConfig.resolumeHost
      ? { host: equipConfig.resolumeHost, port: equipConfig.resolumePort || 8080 }
      : null;
  }
  if (equipConfig.mixerHost !== undefined) {
    config.mixer = equipConfig.mixerHost && equipConfig.mixerType
      ? {
          type: equipConfig.mixerType,
          host: equipConfig.mixerHost,
          port: equipConfig.mixerPort || null,
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
  saveConfig(config);
  return true;
});

ipcMain.handle('get-equipment', () => {
  const config = loadConfig();
  return {
    atemIp: config.atemIp || '',
    companionUrl: config.companionUrl || '',
    obsUrl: config.obsUrl || '',
    obsPassword: config.obsPassword || '',
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
    // Multi-encoder array (new format)
    encoders: config.encoders || (config.encoder ? [config.encoder] : []),
    // Primary encoder flat fields (backward compat)
    encoderType: config.encoder?.type || '',
    encoderHost: config.encoder?.host || '',
    encoderPort: config.encoder?.port || '',
    encoderPassword: config.encoder?.password || '',
    encoderLabel: config.encoder?.label || '',
    encoderStatusUrl: config.encoder?.statusUrl || '',
    rtmpUrl: config.rtmpUrl || '',
  };
});

// ─── PROBLEM FINDER IPC ──────────────────────────────────────────────────────

ipcMain.handle('pf-analyze', () => problemFinderBridge.runAnalysis());
ipcMain.handle('pf-go-no-go', (_, opts) => problemFinderBridge.runGoNoGo(opts));
ipcMain.handle('pf-run-history', () => problemFinderBridge.getRunHistory());
ipcMain.handle('pf-feedback', (_, fb) => problemFinderBridge.recordFeedback(fb));
ipcMain.handle('pf-get-config', () => problemFinderBridge.getFeatureFlags());
ipcMain.handle('pf-simulate-fix', (_, simId) => problemFinderBridge.simulateFix(simId));
ipcMain.handle('pf-available', () => problemFinderBridge.isAvailable());

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
