const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MockLabManager, DEFAULT_ADDRESSES } = require('./mockLabManager');

const DEFAULT_CONFIG = {
  addresses: JSON.parse(JSON.stringify(DEFAULT_ADDRESSES)),
  allowFallback: false,
  requireUniqueIps: true,
  nicName: '',
};

let mainWindow = null;
const logBuffer = [];
const MAX_LOG_LINES = 400;
const mockLabManager = new MockLabManager((message) => {
  const line = `[${new Date().toISOString()}] ${String(message || '')}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  }
  mainWindow?.webContents?.send('mock-lab-log', line);
});

function configPath() {
  return path.join(app.getPath('userData'), 'mock-lab-config.json');
}

function mergeConfig(input = {}) {
  return {
    addresses: {
      ...JSON.parse(JSON.stringify(DEFAULT_ADDRESSES)),
      ...(input.addresses || {}),
    },
    allowFallback: input.allowFallback === true,
    requireUniqueIps: input.requireUniqueIps !== false,
    nicName: String(input.nicName || '').trim(),
  };
}

function loadConfig() {
  const file = configPath();
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return mergeConfig(parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(nextConfig) {
  const normalized = mergeConfig(nextConfig || {});
  const file = configPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

function listAvailableInterfaces() {
  const ifaces = os.networkInterfaces();
  const out = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push({
          name,
          ip: iface.address,
          netmask: iface.netmask,
        });
      }
    }
  }

  out.sort((a, b) => (a.name.localeCompare(b.name) || a.ip.localeCompare(b.ip)));
  return out;
}

async function getMockLabStatus() {
  const configured = mockLabManager.getConfiguredAddresses();
  const active = mockLabManager.getAddresses();
  const controlUrl = `http://${active.controlApi.ip}:${active.controlApi.port}`;

  let mockState = null;
  try {
    if (mockLabManager.isRunning()) {
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
    running: mockLabManager.isRunning(),
    fallbackMode: mockLabManager.isFallbackMode(),
    addresses: active,
    configuredAddresses: configured,
    controlUrl,
    state: mockState,
    logs: logBuffer.slice(-120),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 980,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    title: 'Tally Mock Lab',
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-mock-lab.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'mock-lab.html'));
}

ipcMain.handle('mock-lab-status', async () => getMockLabStatus());
ipcMain.handle('mock-lab-get-network-interfaces', async () => listAvailableInterfaces());

ipcMain.handle('mock-lab-get-config', async () => {
  const saved = loadConfig();
  try {
    mockLabManager.setAddresses(saved.addresses, { requireUniqueIps: saved.requireUniqueIps !== false });
  } catch {
    mockLabManager.setAddresses(DEFAULT_ADDRESSES, { requireUniqueIps: true });
  }
  return {
    ...saved,
    addresses: mockLabManager.getConfiguredAddresses(),
  };
});

ipcMain.handle('mock-lab-save-config', async (_, payload = {}) => {
  const merged = mergeConfig(payload);
  mockLabManager.setAddresses(merged.addresses, { requireUniqueIps: merged.requireUniqueIps !== false });
  const saved = saveConfig(merged);
  return { ok: true, config: saved };
});

ipcMain.handle('mock-lab-start', async (_, opts = {}) => {
  const merged = mergeConfig(opts.addresses ? { ...loadConfig(), ...opts, addresses: opts.addresses } : { ...loadConfig(), ...opts });
  mockLabManager.setAddresses(merged.addresses, { requireUniqueIps: merged.requireUniqueIps !== false });
  saveConfig(merged);
  await mockLabManager.start({
    addresses: merged.addresses,
    allowFallback: merged.allowFallback,
    requireUniqueIps: merged.requireUniqueIps,
  });
  return getMockLabStatus();
});

ipcMain.handle('mock-lab-stop', async () => {
  await mockLabManager.stop();
  return getMockLabStatus();
});

ipcMain.handle('mock-lab-open-external', async (_, url) => {
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(() => {
  const cfg = loadConfig();
  try {
    mockLabManager.setAddresses(cfg.addresses, { requireUniqueIps: cfg.requireUniqueIps !== false });
  } catch (err) {
    logBuffer.push(`[${new Date().toISOString()}] Invalid saved config ignored: ${err.message}`);
    mockLabManager.setAddresses(DEFAULT_ADDRESSES, { requireUniqueIps: true });
  }

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try { mockLabManager.stop(); } catch {}
});
