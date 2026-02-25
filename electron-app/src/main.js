const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── EXTRACTED MODULES ───────────────────────────────────────────────────────
const { loadConfig, saveConfig, loadConfigForUI, getSanitizedConfigForExport, CONFIG_DIR } = require('./config-manager');
const { enforceRelayPolicy, checkTokenWithRelay, testConnection, loginChurchWithCredentials, sendPreviewCommand, relayHttpUrl, DEFAULT_RELAY_URL } = require('./relay-client');
const { testEquipmentConnection } = require('./equipment-tester');
const agentManager = require('./agent-manager');

// Auto-update (gracefully optional)
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch { autoUpdater = null; }

const LOG_DIR = path.join(CONFIG_DIR, 'logs');
const APP_LOG_PATH = path.join(LOG_DIR, 'tally-app.log');
const MAX_RECENT_LOG_LINES = 2000;

let tray = null;
let mainWindow = null;
let lastNotifiedState = {};
const recentLogLines = [];

let logWriteCount = 0;

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

    // Log rotation: rotate at 5 MB, keep one backup (check every 100 writes to avoid fs.statSync on every call)
    if (++logWriteCount % 100 === 0) {
      const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB
      try {
        const stat = fs.statSync(APP_LOG_PATH);
        if (stat.size > MAX_LOG_SIZE) {
          const rotated = APP_LOG_PATH + '.1';
          try { fs.unlinkSync(rotated); } catch {}
          fs.renameSync(APP_LOG_PATH, rotated);
        }
      } catch { /* file doesn't exist yet */ }
    }

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

function buildExportText() {
  const agentStatus = agentManager.getAgentStatus();
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
  const agentStatus = agentManager.getAgentStatus();
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

  // Prevent navigation away from local files (security hardening)
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
  const agentStatus = agentManager.getAgentStatus();
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
    { label: connected ? 'Stop Agent' : 'Start Agent', click: () => connected ? agentManager.stopAgent() : agentManager.startAgent() },
    { type: 'separator' },
    { label: 'Client Portal', click: () => shell.openExternal('https://tallyconnect.app/portal') },
    { label: 'Help & Support', click: () => shell.openExternal('https://tallyconnect.app/help') },
    { label: 'ATEM School', click: () => shell.openExternal('https://atemschool.com') },
    { type: 'separator' },
    { label: 'Quit', click: () => { agentManager.stopAgent(); app.exit(0); } },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`Tally — ${statusLine}`);
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

let lastLowFpsNotification = 0;

function sendNotification(title, body) {
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body, icon: path.join(__dirname, '../assets/icon.png') });
    notification.show();
    return notification;
  }
  return null;
}

function checkAndNotify() {
  const agentStatus = agentManager.getAgentStatus();
  // ATEM disconnect
  if (lastNotifiedState.atem === true && agentStatus.atem === false) {
    sendNotification('⚠️ ATEM Disconnected', 'The ATEM switcher has lost connection.');
  }
  // Stream drop
  if (lastNotifiedState.streaming === true && agentStatus.streaming === false) {
    sendNotification('🔴 Stream Stopped', 'The live stream has stopped unexpectedly.');
  }
  // Low FPS — debounce to max once per minute
  if (agentStatus.fps && agentStatus.fps < 24 && agentStatus.streaming && Date.now() - lastLowFpsNotification > 60000) {
    lastLowFpsNotification = Date.now();
    sendNotification('⚠️ Low FPS Warning', `Stream FPS dropped to ${agentStatus.fps}`);
  }
  lastNotifiedState = { ...agentStatus };
}

// ─── AGENT MANAGER INIT & EVENTS ─────────────────────────────────────────────

agentManager.init({
  loadConfig,
  enforceRelayPolicy,
  appendAppLog,
});

// Wire agent events back to main.js responsibilities (tray, IPC, notifications)
agentManager.emitter.on('status-changed', (status) => {
  checkAndNotify();
  mainWindow?.webContents.send('status', status);
  updateTray();
});

agentManager.emitter.on('log', (text) => {
  mainWindow?.webContents.send('log', text);
});

agentManager.emitter.on('chat-message', (chatMsg) => {
  mainWindow?.webContents.send('chat-message', chatMsg);
});

agentManager.emitter.on('auth-invalid', () => {
  // Stop reconnect thrash on invalid token and force explicit re-auth.
  agentManager.stopAgent();
  mainWindow?.webContents.send('auth-invalid');
  updateTray();
});

agentManager.emitter.on('notification', ({ title, body }) => {
  sendNotification(title, body);
});

agentManager.emitter.on('show-window', () => {
  mainWindow?.show();
});

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfigForUI());
ipcMain.handle('save-config', (_, config) => {
  // Allowlist config fields to prevent arbitrary data injection
  const ALLOWED_KEYS = ['token', 'relay', 'name', 'atemIp', 'obsUrl', 'obsPassword', 'companionUrl',
    'hyperdecks', 'ptz', 'proPresenter', 'dante', 'vmix', 'resolume', 'mixer', 'encoder',
    'notifications', 'autoStart', 'theme'];
  const sanitized = {};
  for (const key of ALLOWED_KEYS) {
    if (key in config) sanitized[key] = config[key];
  }
  saveConfig(sanitized);
  return true;
});
ipcMain.handle('get-status', () => agentManager.getAgentStatus());
ipcMain.handle('start-agent', () => { agentManager.resetCrashCount(); agentManager.startAgent(); });
ipcMain.handle('stop-agent', () => agentManager.stopAgent());
ipcMain.handle('is-running', () => agentManager.isAgentRunning());
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
    agentManager.stopAgent();
    const config = loadConfig();
    delete config.token;
    delete config.setupComplete;
    saveConfig(config);
    agentManager.setAgentStatus({ relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: '', audio: {} });
    mainWindow?.webContents.send('status', agentManager.getAgentStatus());
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
  return sendPreviewCommand(command, {}, { loadConfig, getMainWindow: () => mainWindow });
});
ipcMain.handle('request-preview-frame', async () => sendPreviewCommand('preview.snap', {}, { loadConfig, getMainWindow: () => mainWindow }));

const { discoverDevices, tryTcpConnect, tryHttpGet, listAvailableInterfaces } = require('./networkScanner');

ipcMain.handle('scan-network', async (event, options = {}) => {
  const results = await discoverDevices((percent, message) => {
    mainWindow?.webContents.send('scan-progress', { percent, message });
  }, options);
  return results;
});

ipcMain.handle('test-equipment-connection', async (_, params) => {
  return testEquipmentConnection(params, { tryTcpConnect, tryHttpGet });
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
    obsPassword: config.obsPassword ? '••••••••' : '',
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
    encoderPassword: config.encoder?.password ? '••••••••' : '',
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
    const notification = sendNotification('Update Ready', 'Click to restart and install the update.');
    if (notification) {
      notification.on('click', () => {
        autoUpdater.quitAndInstall();
      });
    }
    mainWindow?.webContents.send('update-ready', true);
  });
  autoUpdater.on('error', (err) => {
    console.log('Auto-update error:', err.message);
    appendAppLog('SYSTEM', `Auto-update error: ${err.message}`);
    mainWindow?.webContents?.send('log', `[Update] Error checking for updates: ${err.message}`);
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
  agentManager.stopAgent();
});
