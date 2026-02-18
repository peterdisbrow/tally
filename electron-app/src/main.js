const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, clipboard } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// Auto-update (gracefully optional)
let autoUpdater;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch { autoUpdater = null; }

const CONFIG_PATH = path.join(os.homedir(), '.church-av', 'config.json');
const CONFIG_DIR  = path.dirname(CONFIG_PATH);

let tray = null;
let mainWindow = null;
let agentProcess = null;
let agentStatus = { relay: false, atem: false, obs: false, companion: false };
let lastNotifiedState = {};

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
    width: 520,
    height: 700,
    resizable: false,
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
    const config = loadConfig();
    if (!config.token || !config.setupComplete) {
      mainWindow.show();
    }
  });
}

// ─── TRAY ─────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(getTrayIcon('grey'));
  updateTray();
}

function updateTray() {
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

// ─── AGENT PROCESS ────────────────────────────────────────────────────────────

function startAgent() {
  if (agentProcess) return;

  const config = loadConfig();
  if (!config.token) {
    mainWindow?.show();
    return;
  }

  const clientScript = path.join(__dirname, '../../church-client/src/index.js');
  const args = [clientScript,
    '--token', config.token,
    '--relay', config.relay || 'wss://tally-relay.up.railway.app',
  ];

  if (config.atemIp)       args.push('--atem', config.atemIp);
  if (config.obsUrl)       args.push('--obs', config.obsUrl);
  if (config.obsPassword)  args.push('--obs-password', config.obsPassword);
  if (config.name)         args.push('--name', config.name);
  if (config.companionUrl) args.push('--companion', config.companionUrl);

  agentProcess = spawn('node', args, {
    cwd: path.join(__dirname, '../../church-client'),
    env: process.env,
  });

  agentProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[Agent]', text.trim());

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

    checkAndNotify();
    mainWindow?.webContents.send('status', agentStatus);
    mainWindow?.webContents.send('log', text);
    updateTray();
  });

  agentProcess.stderr.on('data', (data) => {
    mainWindow?.webContents.send('log', '[err] ' + data.toString());
  });

  agentProcess.on('close', (code) => {
    agentProcess = null;
    agentStatus = { relay: false, atem: false, obs: false, companion: false };
    mainWindow?.webContents.send('status', agentStatus);
    updateTray();
    console.log(`Agent exited with code ${code}`);
    if (code !== 0) setTimeout(() => startAgent(), 5000);
  });
}

function stopAgent() {
  if (agentProcess) {
    agentProcess.kill();
    agentProcess = null;
  }
}

// ─── TEST CONNECTION ──────────────────────────────────────────────────────────

async function testConnection(relayUrl) {
  return new Promise((resolve) => {
    const url = relayUrl.replace(/^wss?:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
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
    req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
  });
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, config) => { saveConfig(config); return true; });
ipcMain.handle('get-status', () => agentStatus);
ipcMain.handle('start-agent', () => startAgent());
ipcMain.handle('stop-agent', () => stopAgent());
ipcMain.handle('is-running', () => !!agentProcess);
ipcMain.handle('test-connection', (_, url) => testConnection(url));
ipcMain.handle('copy-to-clipboard', (_, text) => { clipboard.writeText(text); return true; });

// ─── EQUIPMENT CONFIG IPC ─────────────────────────────────────────────────────

const { discoverDevices, tryTcpConnect, tryHttpGet } = require('./networkScanner');

ipcMain.handle('scan-network', async (event) => {
  const results = await discoverDevices((percent, message) => {
    mainWindow?.webContents.send('scan-progress', { percent, message });
  });
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
  if (equipConfig.proPresenterHost !== undefined) config.proPresenter = { host: equipConfig.proPresenterHost, port: equipConfig.proPresenterPort || 1025 };
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
  saveConfig(config);
  return true;
});

ipcMain.handle('get-equipment', () => {
  const config = loadConfig();
  return {
    atemIp: config.atemIp || '',
    companionUrl: config.companionUrl || 'http://localhost:8888',
    obsUrl: config.obsUrl || 'ws://localhost:4455',
    obsPassword: config.obsPassword || '',
    hyperdecks: config.hyperdecks || [],
    ptz: config.ptz || [],
    proPresenterHost: config.proPresenter?.host || 'localhost',
    proPresenterPort: config.proPresenter?.port || 1025,
    danteNmosHost: config.dante?.nmosHost || '',
    danteNmosPort: config.dante?.nmosPort || 8080,
    vmixHost: config.vmix?.host || '',
    vmixPort: config.vmix?.port || 8088,
    resolumeHost: config.resolume?.host || '',
    resolumePort: config.resolume?.port || 8080,
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

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdate();

  const config = loadConfig();
  if (config.token && config.setupComplete) {
    setTimeout(() => startAgent(), 1000);
  }
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('before-quit', () => {
  stopAgent();
});
