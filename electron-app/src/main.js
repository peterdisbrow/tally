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
const STANDALONE_MOCK_LAB = process.argv.includes('--mock-lab') || process.env.TALLY_STANDALONE_MOCK_LAB === '1';
const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const APP_LOG_PATH = path.join(LOG_DIR, 'tally-app.log');
const MAX_RECENT_LOG_LINES = 2000;

let tray = null;
let mainWindow = null;
let agentProcess = null;
let mockLabManager = null;
let MockLabManagerClass = null;
let agentStatus = { relay: false, atem: false, obs: false, companion: false };
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

function ensureMockLabManager() {
  if (!MockLabManagerClass) {
    try {
      ({ MockLabManager: MockLabManagerClass } = require('./mockLabManager'));
    } catch (err) {
      throw new Error(`Mock Lab is unavailable in this build: ${err.message}`);
    }
  }

  if (!mockLabManager) {
    mockLabManager = new MockLabManagerClass((msg) => appendAppLog('MOCK', msg));
  }
  return mockLabManager;
}

function isFakeAtemMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate' || v.startsWith('mock://');
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

function getTrayIcon(state) {
  // state: 'grey' | 'green' | 'yellow' | 'red'
  // In production, these would be actual .png files in assets/
  // For now we create colored 16x16 icons programmatically
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const colors = {
    grey:   [120, 120, 120, 255],
    green:  [34, 197, 94, 255],
    yellow: [234, 179, 8, 255],
    red:    [239, 68, 68, 255],
  };
  const [r, g, b, a] = colors[state] || colors.grey;

  // Draw a filled circle
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

  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
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
    width: 560,
    height: 740,
    minWidth: 500,
    minHeight: 660,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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

function createMockLabWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 840,
    minWidth: 980,
    minHeight: 700,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    title: 'Tally Mock Lab',
    show: true,
  });

  mainWindow.loadFile(path.join(__dirname, 'mock-lab.html'));
}

// ─── TRAY ─────────────────────────────────────────────────────────────────────

function createTray() {
  if (STANDALONE_MOCK_LAB) return;
  tray = new Tray(getTrayIcon('grey'));
  updateTray();
}

function updateTray() {
  if (STANDALONE_MOCK_LAB || !tray) return;
  const state = computeTrayState();
  tray.setImage(getTrayIcon(state));

  const connected = agentStatus.relay;
  const atemOk = agentStatus.atem;
  const obsOk  = agentStatus.obs;
  const compOk = agentStatus.companion;

  const statusLine = connected
    ? `Connected — ATEM: ${atemOk ? '✓' : '✗'} | OBS: ${obsOk ? '✓' : '✗'} | Companion: ${compOk ? '✓' : '✗'}`
    : 'Disconnected';

  const menu = Menu.buildFromTemplate([
    { label: 'Tally', enabled: false },
    { label: statusLine, enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => mainWindow?.show() },
    { label: connected ? 'Stop Agent' : 'Start Agent', click: () => connected ? stopAgent() : startAgent() },
    { type: 'separator' },
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

  // Detect if mock lab is running — if so, force mock production mode
  const mockLabRunning = mockLabManager?.isRunning?.() || false;
  const useMockProduction = config.mockProduction || mockLabRunning || isFakeAtemMode(config.atemIp);

  const agentRelay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
  const args = [clientPaths.script,
    '--token', config.token,
    '--relay', agentRelay,
  ];

  if (useMockProduction) {
    args.push('--mock-production');
    if (config.fakeAtemApiPort) args.push('--fake-atem-api-port', String(config.fakeAtemApiPort));
  } else {
    if (config.atemIp) args.push('--atem', config.atemIp);
    if (config.fakeAtemApiPort) args.push('--fake-atem-api-port', String(config.fakeAtemApiPort));
  }
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
    if (text.includes('Relay disconnected'))         agentStatus.relay = false;

    // Forward preview frames if embedded in agent stdout (they're sent via relay WS, not stdout, 
    // but if future versions embed them, this catches it)

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
    agentStatus = { relay: false, atem: false, obs: false, companion: false };
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

    const finish = (result) => {
      try { socket.removeAllListeners(); } catch {}
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try { socket.close(); } catch {}
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ success: false, error: 'Token validation timed out' }), ms);
    socket.once('open', () => {
      clearTimeout(timer);
      finish({ success: true, message: 'Token handshake succeeded' });
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      finish({ success: false, error: err.message || 'Token validation failed' });
    });
    socket.once('close', (code) => {
      clearTimeout(timer);
      if (code === 1008) {
        finish({ success: false, error: 'Invalid token for this relay' });
      }
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

async function getMockLabStatus() {
  const config = loadConfig();
  const manager = ensureMockLabManager();
  const addresses = manager.getAddresses();
  const configuredAddresses = manager.getConfiguredAddresses();
  const controlUrl = `http://${addresses.controlApi.ip}:${addresses.controlApi.port}`;

  let mockState = null;
  try {
    if (manager.isRunning()) {
      const resp = await fetch(`${controlUrl}/api/state`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) {
        const data = await resp.json();
        mockState = data?.state || null;
      }
    }
  } catch {
    mockState = null;
  }

  return {
    running: manager.isRunning(),
    fallbackMode: manager.isFallbackMode(),
    mockProduction: !!config.mockProduction,
    addresses,
    configuredAddresses,
    controlUrl,
    state: mockState,
  };
}

async function startMockLab(opts = {}) {
  const withAgent = opts.withAgent !== undefined ? opts.withAgent === true : !STANDALONE_MOCK_LAB;
  const manager = ensureMockLabManager();
  const addresses = await manager.start({
    addresses: opts.addresses,
    allowFallback: opts.allowFallback,
    requireUniqueIps: opts.requireUniqueIps,
  });
  const controlUrl = `http://${addresses.controlApi.ip}:${addresses.controlApi.port}`;

  if (withAgent) {
    const config = loadConfig();
    // Save pre-mock values so stopMockLab can restore them
    config._preMock = {
      atemIp: config.atemIp || '',
      obsUrl: config.obsUrl || '',
      obsPassword: config.obsPassword || '',
      hyperdecks: config.hyperdecks || [],
      proPresenter: config.proPresenter || null,
      mixer: config.mixer || null,
      fakeAtemApiPort: config.fakeAtemApiPort || null,
    };
    config.mockProduction = true;
    config.fakeAtemApiPort = addresses.controlApi.port;
    config.atemIp = addresses.atem.ip;
    config.obsUrl = `ws://${addresses.obs.ip}:${addresses.obs.port}`;
    config.obsPassword = '';
    config.hyperdecks = [addresses.hyperdeck.ip];
    config.proPresenter = { host: addresses.propresenter.ip, port: addresses.propresenter.port };
    config.mixer = { type: 'x32', host: addresses.x32.ip, port: addresses.x32.port };
    if (!config.companionUrl) config.companionUrl = 'http://localhost:8888';
    saveConfig(config);

    if (agentProcess) stopAgent();
    startAgent();
  }

  appendAppLog('MOCK', `Mock lab started. Control API: ${controlUrl}${withAgent ? ' (agent mode)' : ' (standalone mode)'}`);
  return { success: true, addresses, controlUrl };
}

async function stopMockLab(opts = {}) {
  const withAgent = opts.withAgent !== undefined ? opts.withAgent === true : !STANDALONE_MOCK_LAB;
  if (withAgent && agentProcess) stopAgent();
  const manager = ensureMockLabManager();
  await manager.stop();

  if (withAgent) {
    const config = loadConfig();
    config.mockProduction = false;
    // Restore pre-mock values so the agent doesn't try to connect to mock IPs
    if (config._preMock) {
      config.atemIp = config._preMock.atemIp;
      config.obsUrl = config._preMock.obsUrl;
      config.obsPassword = config._preMock.obsPassword;
      config.hyperdecks = config._preMock.hyperdecks;
      config.proPresenter = config._preMock.proPresenter;
      config.mixer = config._preMock.mixer;
      config.fakeAtemApiPort = config._preMock.fakeAtemApiPort;
      delete config._preMock;
    }
    saveConfig(config);
  }

  appendAppLog('MOCK', `Mock lab stopped${withAgent ? ' (agent mode)' : ''}`);
  return { success: true };
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

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const config = decryptConfig(raw); // decrypt secure fields on load
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
  const toSave = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
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
    agentStatus = { relay: false, atem: false, obs: false, companion: false };
    mainWindow?.webContents.send('status', agentStatus);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
ipcMain.handle('copy-to-clipboard', (_, text) => { clipboard.writeText(text); return true; });

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
ipcMain.handle('mock-lab-status', async () => getMockLabStatus());
ipcMain.handle('mock-lab-start', async (_, opts = {}) => startMockLab(opts));
ipcMain.handle('mock-lab-stop', async (_, opts = {}) => stopMockLab(opts));
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
        if (isFakeAtemMode(ip)) {
          return { success: true, details: 'Fake ATEM simulator mode is enabled (use IP "mock")' };
        }
        const ok = await tryTcpConnect(ip, port || 9910, 2000);
        return { success: ok, details: ok ? 'ATEM reachable' : 'Cannot reach ATEM' };
      }
      case 'companion': {
        const target = url || `http://${ip}:${port || 8888}`;
        const resp = await tryHttpGet(`${target}/api/connections`, 2000);
        const connCount = resp.success && Array.isArray(resp.data) ? resp.data.length : 0;
        return { success: resp.success, details: resp.success ? `${connCount} connections active` : 'Cannot reach Companion' };
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
        const ok = await tryTcpConnect(ip, port || 80, 2000);
        return { success: ok, details: ok ? 'Camera reachable' : 'Cannot reach camera' };
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
  saveConfig(config);
  return true;
});

ipcMain.handle('get-equipment', () => {
  const config = loadConfig();
  return {
    mockProduction: !!config.mockProduction,
    atemIp: config.atemIp || '',
    companionUrl: config.companionUrl || 'http://localhost:8888',
    obsUrl: config.obsUrl || 'ws://localhost:4455',
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

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  appendAppLog('FATAL', `uncaughtException: ${err?.stack || err?.message || String(err)}`);
});

process.on('unhandledRejection', (reason) => {
  appendAppLog('FATAL', `unhandledRejection: ${reason?.stack || reason?.message || String(reason)}`);
});

app.whenReady().then(() => {
  appendAppLog('SYSTEM', `App ready (version=${app.getVersion()}, platform=${process.platform}/${process.arch})`);
  if (STANDALONE_MOCK_LAB) {
    createMockLabWindow();
  } else {
    createWindow();
  }
  createTray();
  setupAutoUpdate();

  if (STANDALONE_MOCK_LAB) {
    setTimeout(() => startMockLab({ withAgent: false }).catch((e) => appendAppLog('MOCK', `Autostart failed: ${e.message}`)), 250);
  } else {
    // Agent start is now controlled by the renderer after auth validation
  }
});

app.on('window-all-closed', (e) => {
  if (STANDALONE_MOCK_LAB) {
    app.quit();
    return;
  }
  e.preventDefault();
});

app.on('before-quit', () => {
  appendAppLog('SYSTEM', 'App before-quit');
  stopAgent();
  try { mockLabManager?.stop?.(); } catch {}
});
