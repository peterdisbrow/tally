const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { MockLabManager, DEFAULT_ADDRESSES } = require('./mockLabManager');

const DEFAULT_CONFIG = {
  addresses: JSON.parse(JSON.stringify(DEFAULT_ADDRESSES)),
  allowFallback: false,
  requireUniqueIps: false,
  nicName: '',
};
const DEFAULT_NIC_NETMASK = '255.255.255.0';

let mainWindow = null;
const logBuffer = [];
const MAX_LOG_LINES = 400;
function pushLog(message) {
  const line = `[${new Date().toISOString()}] ${String(message || '')}`;
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  }
  mainWindow?.webContents?.send('mock-lab-log', line);
}

const mockLabManager = new MockLabManager((message) => {
  pushLog(message);
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
    requireUniqueIps: input.requireUniqueIps === true,
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

function isValidIpv4(ip) {
  const value = String(ip || '').trim();
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

function subnetFromIpv4(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return '';
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function defaultUniqueIpsForNicIp(nicIp) {
  const subnet = subnetFromIpv4(nicIp);
  if (!subnet) return [];
  return [11, 12, 13, 14, 15, 16].map((host) => `${subnet}.${host}`);
}

function validateNicName(name) {
  const nicName = String(name || '').trim();
  if (!nicName) throw new Error('Missing NIC name.');
  if (!/^[a-zA-Z0-9_.:-]+$/.test(nicName)) {
    throw new Error(`Invalid NIC name: ${nicName}`);
  }
  return nicName;
}

function normalizeAliasPlan(payload = {}) {
  const nicName = validateNicName(payload.nicName);
  const nicIp = String(payload.nicIp || '').trim();
  if (!isValidIpv4(nicIp)) throw new Error('Selected NIC IPv4 is invalid.');

  const nicNetmask = String(payload.nicNetmask || DEFAULT_NIC_NETMASK).trim();
  if (!isValidIpv4(nicNetmask)) throw new Error('Selected NIC netmask is invalid.');

  const fromPayload = Array.isArray(payload.ips)
    ? payload.ips.map((ip) => String(ip || '').trim()).filter(Boolean)
    : [];
  const requestedIps = fromPayload.length ? fromPayload : defaultUniqueIpsForNicIp(nicIp);

  const uniqueIps = [];
  const seen = new Set();
  for (const ip of requestedIps) {
    if (!isValidIpv4(ip)) throw new Error(`Invalid alias IPv4: ${ip}`);
    if (seen.has(ip)) continue;
    seen.add(ip);
    uniqueIps.push(ip);
  }

  if (!uniqueIps.length) {
    throw new Error('No valid alias IP addresses were provided.');
  }

  return {
    nicName,
    nicIp,
    nicNetmask,
    ips: uniqueIps,
  };
}

function buildIfconfigCommand(action, plan, ip) {
  if (action === 'remove') {
    return `/sbin/ifconfig ${plan.nicName} -alias ${ip}`;
  }
  return `/sbin/ifconfig ${plan.nicName} alias ${ip} netmask ${plan.nicNetmask} up`;
}

function toAppleScriptString(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`;
}

function runWithMacAdminPrompt(commands) {
  return new Promise((resolve, reject) => {
    const joined = commands.join(' ; ');
    const script = `set shellCmd to ${toAppleScriptString(joined)}\ndo shell script shellCmd with administrator privileges`;
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr || stdout || error.message || '').trim() || 'Admin command failed.';
        reject(new Error(msg));
        return;
      }
      resolve(true);
    });
  });
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
    mockLabManager.setAddresses(saved.addresses, { requireUniqueIps: saved.requireUniqueIps === true });
  } catch {
    mockLabManager.setAddresses(DEFAULT_ADDRESSES, { requireUniqueIps: false });
  }
  return {
    ...saved,
    addresses: mockLabManager.getConfiguredAddresses(),
  };
});

ipcMain.handle('mock-lab-save-config', async (_, payload = {}) => {
  const merged = mergeConfig(payload);
  mockLabManager.setAddresses(merged.addresses, { requireUniqueIps: merged.requireUniqueIps === true });
  const saved = saveConfig(merged);
  return { ok: true, config: saved };
});

ipcMain.handle('mock-lab-start', async (_, opts = {}) => {
  const merged = mergeConfig(opts.addresses ? { ...loadConfig(), ...opts, addresses: opts.addresses } : { ...loadConfig(), ...opts });
  mockLabManager.setAddresses(merged.addresses, { requireUniqueIps: merged.requireUniqueIps === true });
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

ipcMain.handle('mock-lab-manage-ip-aliases', async (_, payload = {}) => {
  const action = payload?.action === 'remove' ? 'remove' : 'add';
  const plan = normalizeAliasPlan(payload);
  const commands = plan.ips.map((ip) => buildIfconfigCommand(action, plan, ip));

  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'IP alias helper currently supports macOS only.',
      action,
      commands,
      plan,
    };
  }

  try {
    await runWithMacAdminPrompt(commands);
    const summary = action === 'remove'
      ? `Removed ${commands.length} alias IP(s) from ${plan.nicName}.`
      : `Configured ${commands.length} alias IP(s) on ${plan.nicName}.`;
    pushLog(`[Alias] ${summary}`);
    return {
      ok: true,
      action,
      commands,
      plan,
      summary,
    };
  } catch (err) {
    const msg = err?.message || 'Failed to manage NIC aliases.';
    pushLog(`[Alias] Failed (${action}): ${msg}`);
    return {
      ok: false,
      error: msg,
      action,
      commands,
      plan,
    };
  }
});

app.whenReady().then(() => {
  const cfg = loadConfig();
  try {
    mockLabManager.setAddresses(cfg.addresses, { requireUniqueIps: cfg.requireUniqueIps === true });
  } catch (err) {
    logBuffer.push(`[${new Date().toISOString()}] Invalid saved config ignored: ${err.message}`);
    mockLabManager.setAddresses(DEFAULT_ADDRESSES, { requireUniqueIps: false });
  }

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try { mockLabManager.stop(); } catch {}
});
