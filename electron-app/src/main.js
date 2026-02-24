const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, clipboard, dialog } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { encryptConfig, decryptConfig } = require('./secureStorage');

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
let previewControllerSocket = null;
let lastNotifiedState = {};
const recentLogLines = [];
let agentCrashCount = 0;
const MAX_AGENT_CRASHES = 5;

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

function getSanitizedConfigForExport() {
  const config = loadConfig();
  const sanitized = { ...config };
  const redactFields = [
    'token',
    'churchToken',
    'obsPassword',
    'youtubeApiKey',
    'facebookAccessToken',
    'rtmpStreamKey',
    'twitchStreamKey',
    'adminApiKey',
  ];

  for (const field of redactFields) {
    if (sanitized[field] !== undefined && sanitized[field] !== null && sanitized[field] !== '') {
      sanitized[field] = '[redacted]';
    }
  }

  return sanitized;
}

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
    { label: 'Quit', click: () => { stopAgent(); app.exit(0); } },
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
  // ATEM disconnect
  if (lastNotifiedState.atem === true && agentStatus.atem === false) {
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

  // Common relative install locations in Electron-packaged apps
  if (process.resourcesPath) {
    addCandidate(path.join(process.resourcesPath, 'node'));                    // e.g., /resources/node
    addCandidate(path.join(process.resourcesPath, 'node', 'bin', 'node'));       // /resources/node/bin/node
    addCandidate(path.join(process.resourcesPath, 'bin', 'node'));               // /resources/bin/node
  }

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  // Fallback: check PATH with `which`/`where`
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['node'], { encoding: 'utf8' });
  if (result.status === 0) {
    const located = result.stdout.split('\n')[0]?.trim();
    if (located && fs.existsSync(located)) return located;
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

  const nodeBinary = resolveNodeBinary();
  if (!nodeBinary) {
    const msg = 'Node.js runtime not found on this Mac. Install Node.js (brew install node) or run in dev mode.';
    console.log(msg);
    appendAppLog('SYSTEM', msg);
    mainWindow?.webContents?.send('log', `[Agent] ${msg}`);
    mainWindow?.show();
    sendNotification('Tally Agent Error', msg);
    return;
  }

  // Set encoder type label from config so UI can adapt
  const encoderTypeNames = {
    obs: 'OBS', vmix: 'vMix', ecamm: 'Ecamm', blackmagic: 'Blackmagic',
    aja: 'AJA HELO', epiphan: 'Epiphan', teradek: 'Teradek',
    yolobox: 'YoloBox', 'tally-encoder': 'Tally Encoder',
    ndi: 'NDI Decoder', custom: 'Custom', 'custom-rtmp': 'Custom RTMP', 'rtmp-generic': 'RTMP',
  };
  agentStatus.encoderType = encoderTypeNames[config.encoder?.type] || '';

  appendAppLog('SYSTEM', `Starting agent (relay=${agentRelay}, name=${config.name || 'n/a'}, script=${clientPaths.script})`);

  agentProcess = spawn(nodeBinary, args, {
    cwd: clientPaths.cwd,
    env: process.env,
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
    if (text.includes('ATEM connected'))             agentStatus.atem = true;
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

function normalizeRelayUrl(url) {
  const raw = String(url || DEFAULT_RELAY_URL).trim();
  if (!raw) return DEFAULT_RELAY_URL;

  if (/^wss?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '');
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://')
      .replace(/\/+$/, '');
  }

  return `wss://${raw.replace(/\/+$/, '')}`;
}

function isLocalRelayUrl(url) {
  try {
    const normalized = normalizeRelayUrl(url);
    const httpUrl = normalized
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
    const parsed = new URL(httpUrl);
    const host = (parsed.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function enforceRelayPolicy(url) {
  const normalized = normalizeRelayUrl(url || DEFAULT_RELAY_URL);
  if (isLocalRelayUrl(normalized)) return normalized;
  return normalizeRelayUrl(DEFAULT_RELAY_URL);
}

function relayHttpUrl(url) {
  return enforceRelayPolicy(url).replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === 'wss://' ? 'https://' : 'http://'));
}

function decodeChurchIdFromToken(token) {
  try {
    const parts = token?.split('.') || [];
    if (!parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.churchId || payload.church_id || null;
  } catch {
    return null;
  }
}

function checkTokenWithRelay(token, relayUrl, ms = 5000) {
  return new Promise((resolve) => {
    const wsUrl = normalizeRelayUrl(relayUrl).replace(/\/$/, '') + '/church';
    const target = `${wsUrl}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(target);
    const AUTH_STABILITY_MS = 1200;
    let opened = false;
    let authTimer = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (authTimer) clearTimeout(authTimer);
      try { socket.removeAllListeners(); } catch {}
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch {}
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ success: false, error: 'Token validation timed out' }), ms);
    socket.once('open', () => {
      opened = true;
      authTimer = setTimeout(() => {
        clearTimeout(timer);
        finish({ success: true, message: 'Token handshake succeeded' });
      }, AUTH_STABILITY_MS);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ success: false, error: err.message || 'Token validation failed' });
    });
    socket.once('close', (code) => {
      clearTimeout(timer);
      if (code === 1008) {
        finish({ success: false, error: 'Invalid token for this relay' });
        return;
      }
      if (!opened) {
        finish({ success: false, error: `Connection closed before auth (${code})` });
        return;
      }
      finish({ success: false, error: `Relay closed connection (${code})` });
    });
  });
}

async function postJson(url, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `Request failed (${response.status})`,
        status: response.status,
        data,
      };
    }

    return { success: true, status: response.status, data };
  } catch (e) {
    return { success: false, error: e.message || 'Network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function loginChurchWithCredentials({ relay, email, password }) {
  const relayUrl = enforceRelayPolicy(relay);
  const endpoint = `${relayHttpUrl(relayUrl).replace(/\/+$/, '')}/api/church/app/login`;
  return postJson(endpoint, { email, password });
}

async function testConnection({ url, token } = {}) {
  const relayUrl = enforceRelayPolicy(url);

  if (token) {
    const tokenCheck = await checkTokenWithRelay(token, relayUrl);
    if (!tokenCheck.success) return tokenCheck;
  }

  return new Promise((resolve) => {
    const endpoint = relayHttpUrl(relayUrl);
    const lib = endpoint.startsWith('https') ? require('https') : require('http');
    const req = lib.get(endpoint, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: true, service: json.service, churches: json.churches });
        } catch {
          resolve({ success: true, message: 'Server responded' });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

function sendPreviewCommand(command, params = {}) {
  const config = loadConfig();
  if (!config.token) throw new Error('No church token configured');

  const relay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
  const churchId = decodeChurchIdFromToken(config.token);
  const adminKey = config.adminApiKey;

  if (!adminKey) {
    throw new Error('No adminApiKey stored for preview control');
  }

  if (!churchId) {
    throw new Error('Unable to parse churchId from token');
  }

  return new Promise((resolve, reject) => {
    // Keep one controller socket while preview stream is active so frames can flow.
    if (command === 'preview.start' && previewControllerSocket) {
      try { previewControllerSocket.send(JSON.stringify({ type: 'command', churchId, command: 'preview.stop', params: {} })); } catch {}
      try { previewControllerSocket.terminate(); } catch {}
      previewControllerSocket = null;
    }

    const socket = new WebSocket(`${relay.replace(/\/$/, '')}/controller?apikey=${encodeURIComponent(adminKey)}`);
    const isStart = command === 'preview.start';
    const timeout = setTimeout(() => {
      try { socket.terminate(); } catch {}
      if (isStart && previewControllerSocket === socket) previewControllerSocket = null;
      reject(new Error('Preview command timed out'));
    }, 8000);

    const done = (result) => {
      clearTimeout(timeout);
      resolve(result);
      if (!isStart) {
        try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); } catch {}
      }
      if (socket === previewControllerSocket) {
        previewControllerSocket = null;
      }
    };

    const onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'preview_frame' && msg.churchId === churchId) {
          mainWindow?.webContents.send('preview-frame', {
            timestamp: msg.timestamp,
            width: msg.width,
            height: msg.height,
            format: msg.format,
            data: msg.data,
          });
          return;
        }

        if (msg.type === 'command_result' && msg.command === command && msg.churchId === churchId) {
          if (msg.error) {
            done({ success: false, error: msg.error });
          } else {
            done({ success: true, result: msg.result });
          }
        }
      } catch (e) {
        done({ success: true });
      }
    };

    socket.once('open', () => {
      socket.send(JSON.stringify({
        type: 'command',
        churchId,
        command,
        params,
      }));

      if (command === 'preview.stop') {
        done({ success: true });
      } else if (command === 'preview.start') {
        previewControllerSocket = socket;
        socket.on('message', onMessage);
        mainWindow?.webContents.send('log', '[Preview] Started preview stream from relay controller');
      } else {
        socket.on('message', onMessage);
      }
    });

    socket.on('message', (raw) => {
      if (isStart) return; // handled above once open
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command_result' && msg.command === command && msg.churchId === churchId) {
          if (msg.error) {
            done({ success: false, error: msg.error });
          } else {
            done({ success: true, result: msg.result });
          }
        }
      } catch (e) {
        done({ success: true });
      }
    });

    socket.once('error', (err) => done({ success: false, error: err.message || 'Relay socket error' }));
    socket.once('close', () => {
      if (socket === previewControllerSocket) previewControllerSocket = null;
      done({ success: true });
    });
  });
}


// ─── CONFIG ───────────────────────────────────────────────────────────────────

function isMockValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate' || v.startsWith('mock://') || v.includes('mock-hyperdeck');
}

function stripMockConfig(config = {}) {
  const cleaned = { ...(config || {}) };

  if (isMockValue(cleaned.atemIp)) cleaned.atemIp = '';
  if (isMockValue(cleaned.obsUrl)) {
    cleaned.obsUrl = '';
    cleaned.obsPassword = '';
  }
  if (cleaned.proPresenter && isMockValue(cleaned.proPresenter.host)) cleaned.proPresenter = null;
  if (cleaned.mixer && isMockValue(cleaned.mixer.host)) cleaned.mixer = null;
  if (Array.isArray(cleaned.hyperdecks)) {
    cleaned.hyperdecks = cleaned.hyperdecks.filter((entry) => !isMockValue(entry));
  }
  delete cleaned.mockProduction;
  delete cleaned.fakeAtemApiPort;
  delete cleaned._preMock;
  return cleaned;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const config = stripMockConfig(decryptConfig(raw)); // decrypt secure fields on load
    config.relay = enforceRelayPolicy(config.relay);
    return config;
  }
  catch { return {}; }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Merge partial UI updates into existing config so token/relay are not lost.
  const merged = { ...loadConfig(), ...(config || {}) };
  // Only persist defined values; undefined means "leave existing as-is" before merge.
  const toSave = stripMockConfig(Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)));
  toSave.relay = enforceRelayPolicy(toSave.relay);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(encryptConfig(toSave), null, 2));
}

// Return config with flags instead of actual key values for the UI
// (never send streaming keys to the renderer process)
function loadConfigForUI() {
  const config = loadConfig();
  const ui = { ...config };
  const SENSITIVE = ['youtubeApiKey', 'facebookAccessToken', 'rtmpStreamKey', 'twitchStreamKey', 'obsPassword', 'churchToken'];
  for (const field of SENSITIVE) {
    ui[`${field.replace(/([A-Z])/g, m => m[0].toLowerCase())}Set`] = !!(config[field]);
    delete ui[field]; // never expose to renderer
  }
  // Convenience flags for the UI
  ui.youtubeKeySet = !!(config.youtubeApiKey);
  ui.facebookTokenSet = !!(config.facebookAccessToken);
  ui.rtmpKeySet = !!(config.rtmpStreamKey);
  return ui;
}

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

const { discoverDevices, tryTcpConnect, tryHttpGet, listAvailableInterfaces } = require('./networkScanner');

// ─── TCP CONNECT HELPER ───────────────────────────────────────────────────────

function tryTcpConnectLocal(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => { socket.destroy(); resolve({ success: true }); });
    socket.on('error', () => { socket.destroy(); resolve({ success: false }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ success: false }); });
  });
}

function tryUdpSendLocal(host, port, payloadHex = '', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const dgram = require('dgram');
    const socket = dgram.createSocket('udp4');
    const payload = payloadHex ? Buffer.from(payloadHex.replace(/\s+/g, ''), 'hex') : Buffer.from([0x81, 0x09, 0x04, 0x00, 0xff]);
    let done = false;
    const finish = (success) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch { /* ignore */ }
      resolve({ success });
    };
    const timer = setTimeout(() => finish(true), timeoutMs); // UDP is fire-and-forget; no error => likely routable
    socket.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    socket.send(payload, port, host, (err) => {
      clearTimeout(timer);
      finish(!err);
    });
  });
}

function parseProbeRate(value) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (raw.includes('/')) {
    const [numRaw, denRaw] = raw.split('/');
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
    return null;
  }
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? Number(asNum.toFixed(2)) : null;
}

function runLocalCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, timedOut, error });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, error: null });
    });
  });
}

async function probeNdiSourceLocal(source, timeoutMs = 5000) {
  const ndiSource = String(source || '').trim();
  if (!ndiSource) {
    return { success: false, details: 'Enter NDI source name' };
  }

  const args = [
    '-v', 'error',
    '-f', 'libndi_newtek',
    '-i', ndiSource,
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate',
    '-of', 'json',
    '-read_intervals', '%+1',
  ];

  const result = await runLocalCommand('ffprobe', args, timeoutMs);
  if (result.error && result.error.code === 'ENOENT') {
    return { success: false, details: 'ffprobe not installed (required for NDI monitoring)' };
  }
  if (result.timedOut) {
    return { success: false, details: `NDI probe timed out for "${ndiSource}"` };
  }
  if (!result.ok) {
    const errText = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
    const pluginMissing = errText.includes('unknown input format') || errText.includes('libndi_newtek');
    if (pluginMissing) return { success: false, details: 'ffprobe lacks libndi_newtek support' };
    return { success: false, details: `NDI source "${ndiSource}" not reachable` };
  }

  let stream = null;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  } catch {
    stream = null;
  }

  const width = stream && Number.isFinite(Number(stream.width)) ? Number(stream.width) : null;
  const height = stream && Number.isFinite(Number(stream.height)) ? Number(stream.height) : null;
  const fps = parseProbeRate(stream?.avg_frame_rate || stream?.r_frame_rate || '');
  const resolution = width && height ? `${width}x${height}` : null;
  const fpsText = Number.isFinite(fps) ? `${fps} fps` : null;

  return {
    success: true,
    details: `NDI source reachable (${ndiSource})${resolution ? ` · ${resolution}` : ''}${fpsText ? ` @ ${fpsText}` : ''}`,
  };
}

ipcMain.handle('scan-network', async (event, options = {}) => {
  const results = await discoverDevices((percent, message) => {
    mainWindow?.webContents.send('scan-progress', { percent, message });
  }, options);
  return results;
});

ipcMain.handle('test-equipment-connection', async (_, params) => {
  const { type, ip, port, password, url } = params;
  try {
    switch (type) {
      case 'atem': {
        const ok = await tryTcpConnect(ip, port || 9910, 2000);
        return { success: ok, details: ok ? 'ATEM reachable' : 'Cannot reach ATEM' };
      }
      case 'companion': {
        const target = url || `http://${ip}:${port || 8888}`;
        // Companion 4.x: probe a location slot — any HTTP response means it's running
        const resp = await tryHttpGet(`${target}/api/location/1/0/0`, 2000);
        return { success: resp.success, details: resp.success ? 'Companion connected' : 'Cannot reach Companion' };
      }
      case 'obs': {
        const ok = await tryTcpConnect(ip || '127.0.0.1', port || 4455, 2000);
        return { success: ok, details: ok ? 'OBS reachable' : 'Cannot reach OBS' };
      }
      case 'hyperdeck': {
        const ok = await tryTcpConnect(ip, port || 9993, 2000);
        return { success: ok, details: ok ? 'HyperDeck reachable' : 'Cannot reach HyperDeck' };
      }
      case 'ptz': {
        const protocol = String(params.protocol || 'auto').toLowerCase();
        const explicitPort = Number(port) || 0;
        const ptzPort = explicitPort || (
          protocol === 'onvif' ? 80
            : protocol === 'visca-udp' ? 1259
              : protocol === 'sony-visca-udp' ? 52381
                : 5678
        );
        if (protocol === 'onvif' || protocol === 'auto') {
          const onvifPort = explicitPort || 80;
          const resp = await tryHttpGet(`http://${ip}:${onvifPort}/onvif/device_service`, 3000);
          const statusCode = Number(resp.statusCode || 0);
          const looksOnvif = resp.success && statusCode > 0 && statusCode !== 404;
          if (looksOnvif) return { success: true, details: `ONVIF endpoint reachable (HTTP ${statusCode})` };
          if (protocol === 'onvif') return { success: false, details: 'Cannot reach ONVIF endpoint' };
        }
        if (protocol === 'visca-udp' || protocol === 'sony-visca-udp') {
          const probe = await tryUdpSendLocal(ip, ptzPort);
          return {
            success: probe.success,
            details: probe.success
              ? `${protocol} datagram sent`
              : `Cannot send ${protocol} datagram`,
          };
        }
        const ok = await tryTcpConnect(ip, ptzPort, 2500);
        return { success: ok, details: ok ? 'VISCA TCP reachable' : 'Cannot reach VISCA TCP camera' };
      }
      case 'propresenter': {
        const resp = await tryHttpGet(`http://${ip}:${port || 1025}/v1/version`, 3000);
        return { success: resp.success, details: resp.success ? 'ProPresenter running' : 'Cannot reach ProPresenter' };
      }
      case 'dante': {
        const resp = await tryHttpGet(`http://${ip}:${port || 8080}/x-nmos/node/v1.2/self`, 3000);
        return { success: resp.success, details: resp.success ? 'NMOS registry reachable' : 'Cannot reach NMOS registry' };
      }
      case 'vmix': {
        const resp = await tryHttpGet(`http://${ip}:${port || 8088}/api/?Function=GetShortXML`, 3000);
        if (resp.success && resp.data) {
          const editionM = resp.data.match ? resp.data.match(/<edition>([^<]+)<\/edition>/i) : null;
          const edition = editionM ? editionM[1] : 'vMix';
          return { success: true, details: `${edition} is running` };
        }
        return { success: false, details: 'Cannot reach vMix — is HTTP API enabled?' };
      }
      case 'resolume': {
        const resp = await tryHttpGet(`http://${ip}:${port || 8080}/api/v1/product`, 3000);
        const version = resp.success && resp.data ? (resp.data.name || 'Resolume Arena') : null;
        return { success: resp.success, details: resp.success ? `${version} is running` : 'Cannot reach Resolume Arena' };
      }
      case 'mixer': {
        const mixerType = params.mixerType || 'behringer';
        const defaultPort = mixerType === 'allenheath' ? 51326
          : mixerType === 'yamaha' ? 8765
          : 10023; // behringer / midas
        const targetPort = port || defaultPort;
        // Yamaha TF uses TCP on 49280 — try TCP connect; for OSC consoles, TCP probe is a good enough check
        const resp = await tryTcpConnectLocal(ip, targetPort, 3000);
        return {
          success: resp.success,
          details: resp.success
            ? `${mixerType} console reachable at ${ip}:${targetPort}`
            : `Cannot reach ${mixerType} console at ${ip}:${targetPort}`,
        };
      }
      case 'encoder': {
        const et = (params.encoderType || '').toLowerCase();
        if (et === 'obs') {
          const ok = await tryTcpConnect(ip || '127.0.0.1', port || 4455, 2000);
          return { success: ok, details: ok ? 'OBS WebSocket reachable' : 'Cannot reach OBS WebSocket' };
        }
        if (et === 'vmix') {
          const resp = await tryHttpGet(`http://${ip || 'localhost'}:${port || 8088}/api/?Function=GetShortXML`, 3000);
          return { success: resp.success, details: resp.success ? 'vMix API reachable' : 'Cannot reach vMix API' };
        }
        if (et === 'ecamm') {
          const resp = await tryHttpGet(`http://127.0.0.1:${port || 65194}/getInfo`, 3000);
          return { success: resp.success, details: resp.success ? 'Ecamm Live API connected' : 'Ecamm Live not detected (port 65194)' };
        }
        if (et === 'blackmagic') {
          const resp = await tryHttpGet(`http://${ip}:${port || 80}/control/api/v1/livestreams/0`, 3000);
          if (resp.success && resp.data) {
            const status = resp.data.status || 'Unknown';
            return { success: true, details: `Blackmagic connected — status: ${status}` };
          }
          return { success: resp.success, details: resp.success ? 'Blackmagic REST API reachable' : 'Cannot reach Blackmagic REST API (requires firmware 3.4+)' };
        }
        if (et === 'aja') {
          const resp = await tryHttpGet(`http://${ip}:${port || 80}/config?action=get&paramid=eParamID_ReplicatorStreamState`, 3000);
          if (resp.success && resp.data?.value !== undefined) {
            const states = ['Uninitialized', 'Idle', 'Streaming', 'Failing (Idle)', 'Failing (Stream)', 'Shutdown'];
            const state = states[parseInt(resp.data.value)] || 'Unknown';
            return { success: true, details: `AJA HELO connected — stream: ${state}` };
          }
          return { success: resp.success, details: resp.success ? 'AJA HELO reachable' : 'Cannot reach AJA HELO REST API' };
        }
        if (et === 'epiphan') {
          const resp = await tryHttpGet(`http://${ip}:${port || 80}/api/channels`, 3000);
          if (resp.success && resp.data?.result) {
            const count = resp.data.result.length;
            return { success: true, details: `Epiphan Pearl connected — ${count} channel${count !== 1 ? 's' : ''}` };
          }
          // Try v2 endpoint
          const resp2 = await tryHttpGet(`http://${ip}:${port || 80}/api/v2.0/channels`, 3000);
          if (resp2.success) return { success: true, details: 'Epiphan Pearl connected (API v2)' };
          return { success: false, details: 'Cannot reach Epiphan Pearl API (check IP and credentials)' };
        }
        if (et === 'teradek') {
          const resp = await tryHttpGet(`http://${ip}:${port || 80}/cgi-bin/system.cgi?command=status`, 3000);
          if (resp.success && resp.data?.status) {
            const state = resp.data.status['Broadcast-State'] || 'Unknown';
            return { success: true, details: `Teradek connected — broadcast: ${state}` };
          }
          // May need login first — just check if the web UI responds
          const resp2 = await tryHttpGet(`http://${ip}:${port || 80}/`, 3000);
          return { success: resp2.success, details: resp2.success ? 'Teradek web UI reachable (may need password)' : 'Cannot reach Teradek' };
        }
        if (et === 'tally-encoder') {
          const resp = await tryHttpGet(`http://${ip}:${port || 7070}/health`, 3000);
          return { success: resp.success, details: resp.success ? 'Tally Encoder reachable' : 'Cannot reach Tally Encoder' };
        }
        if (et === 'ndi') {
          return probeNdiSourceLocal(params.ip, 5000);
        }
        if (et === 'custom') {
          const statusUrl = params.statusUrl || '/status';
          const resp = await tryHttpGet(`http://${ip}:${port || 80}${statusUrl}`, 3000);
          return { success: resp.success, details: resp.success ? 'Custom encoder reachable' : 'Cannot reach custom encoder' };
        }
        // RTMP-push types (YoloBox, etc.) — no official control API.
        // If an IP is provided, do a basic reachability probe for closer integration.
        if (['yolobox', 'custom-rtmp', 'rtmp-generic'].includes(et)) {
          if (!ip) {
            return { success: true, details: 'Device configured — no control API (set optional IP to enable reachability checks)' };
          }
          const resp = await tryHttpGet(`http://${ip}:${port || 80}/`, 3000);
          return {
            success: resp.success,
            details: resp.success
              ? 'Device reachable (RTMP device has no public control API)'
              : 'Cannot reach device web endpoint',
          };
        }
        return { success: false, details: 'Select an encoder type' };
      }
      default:
        return { success: false, details: 'Unknown device type' };
    }
  } catch (e) {
    return { success: false, details: e.message };
  }
});

ipcMain.handle('save-equipment', (_, equipConfig) => {
  const config = loadConfig();
  if (equipConfig.atemIp !== undefined) config.atemIp = equipConfig.atemIp;
  if (equipConfig.companionUrl !== undefined) config.companionUrl = equipConfig.companionUrl;
  if (equipConfig.obsUrl !== undefined) config.obsUrl = equipConfig.obsUrl;
  if (equipConfig.obsPassword !== undefined) config.obsPassword = equipConfig.obsPassword;
  if (equipConfig.hyperdecks !== undefined) config.hyperdecks = equipConfig.hyperdecks;
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
  if (equipConfig.encoderType !== undefined) {
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
  }
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
    encoderType: config.encoder?.type || '',
    encoderHost: config.encoder?.host || '',
    encoderPort: config.encoder?.port || '',
    encoderPassword: config.encoder?.password || '',
    encoderLabel: config.encoder?.label || '',
    encoderStatusUrl: config.encoder?.statusUrl || '',
  };
});

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

app.on('before-quit', () => {
  appendAppLog('SYSTEM', 'App before-quit');
  stopAgent();
});
