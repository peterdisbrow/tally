/**
 * Agent Manager — spawns and supervises the church-client Node.js process
 *
 * Extracted from main.js. Manages the agent lifecycle including spawn, kill,
 * crash recovery with exponential backoff, relay watchdog, and log parsing.
 *
 * Communicates back to main.js via an EventEmitter:
 *   'status-changed'  — agentStatus object updated
 *   'log'             — text for renderer log panel
 *   'chat-message'    — parsed chat JSON
 *   'auth-invalid'    — relay rejected the token
 *   'notification'    — { title, body } for OS notification
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const emitter = new EventEmitter();

// ─── MODULE STATE ─────────────────────────────────────────────────────────────

let agentProcess = null;
let agentGeneration = 0;
let agentCrashCount = 0;
let agentIntentionalStop = false;
const MAX_AGENT_CRASHES = 5;

let agentStatus = {
  relay: false, atem: false, obs: false, companion: false,
  encoder: false, encoderType: '', audio: {},
};

const recentLogLines = [];
const MAX_RECENT_LOG_LINES = 2000;

// Dependencies injected by main.js via init()
let _loadConfig = null;
let _enforceRelayPolicy = null;
let _appendAppLog = null;

// ─── INIT (called once from main.js) ─────────────────────────────────────────

function init({ loadConfig, enforceRelayPolicy, appendAppLog }) {
  _loadConfig = loadConfig;
  _enforceRelayPolicy = enforceRelayPolicy;
  _appendAppLog = appendAppLog;
}

function log(source, message) {
  if (_appendAppLog) _appendAppLog(source, message);
}

// ─── NODE BINARY RESOLUTION ───────────────────────────────────────────────────

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

function resolveAgentRuntime(clientPaths) {
  const runtimeBinary = process.execPath || resolveNodeBinary();
  if (!runtimeBinary || !fs.existsSync(runtimeBinary)) return null;

  const runtimeEnv = { ...process.env };

  // Keep child runtime architecture aligned with the app runtime.
  if (process.versions && process.versions.electron) {
    runtimeEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  const nodePathEntries = [];
  const pushNodePath = (value) => {
    if (!value) return;
    const v = String(value).trim();
    if (!v) return;
    if (!nodePathEntries.includes(v)) nodePathEntries.push(v);
  };

  // Prefer church-client-local deps first, then packaged app deps.
  pushNodePath(path.join(clientPaths.cwd, 'node_modules'));
  if (process.resourcesPath) {
    pushNodePath(path.join(process.resourcesPath, 'app.asar', 'node_modules'));
    pushNodePath(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'));
    pushNodePath(path.join(process.resourcesPath, 'node_modules'));
  }

  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) pushNodePath(p);
  }

  if (nodePathEntries.length > 0) {
    runtimeEnv.NODE_PATH = nodePathEntries.join(path.delimiter);
  }

  return { binary: runtimeBinary, env: runtimeEnv };
}

// ─── CHURCH CLIENT PATH RESOLUTION ────────────────────────────────────────────

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

// ─── START / STOP ─────────────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'wss://api.tallyconnect.app';

function startAgent() {
  if (agentProcess) return;

  const thisGeneration = ++agentGeneration;

  const config = _loadConfig();
  if (!config.token) {
    log('SYSTEM', 'Start agent requested but token is missing');
    emitter.emit('show-window');
    return;
  }

  const clientPaths = resolveChurchClientPaths();
  if (!clientPaths) {
    const msg = 'Church client agent not found. The app may need to be reinstalled.';
    console.log(msg);
    log('SYSTEM', msg);
    emitter.emit('log', `[Agent] ${msg}`);
    emitter.emit('show-window');
    emitter.emit('notification', { title: 'Tally Agent Error', body: msg });
    return;
  }

  const agentRelay = _enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
  const args = [clientPaths.script,
    '--token', config.token,
    '--relay', agentRelay,
  ];

  if (config.atemIp) args.push('--atem', config.atemIp);
  if (config.obsUrl)       args.push('--obs', config.obsUrl);
  // Passwords passed via env vars (not CLI args) so they don't appear in `ps aux`
  if (config.name)         args.push('--name', config.name);
  if (config.companionUrl) args.push('--companion', config.companionUrl);

  const runtime = resolveAgentRuntime(clientPaths);
  if (!runtime) {
    const msg = 'Runtime not found for church client agent.';
    console.log(msg);
    log('SYSTEM', msg);
    emitter.emit('log', `[Agent] ${msg}`);
    emitter.emit('show-window');
    emitter.emit('notification', { title: 'Tally Agent Error', body: msg });
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

  log('SYSTEM', `Starting agent (relay=${agentRelay}, name=${config.name || 'n/a'}, script=${clientPaths.script}, runtime=${runtime.binary})`);

  // Pass sensitive values via env vars so they don't show in `ps aux`
  const agentEnv = { ...runtime.env };
  if (config.obsPassword)  agentEnv.OBS_PASSWORD = config.obsPassword;
  if (config.token)        agentEnv.TALLY_TOKEN = config.token;

  agentProcess = spawn(runtime.binary, args, {
    cwd: clientPaths.cwd,
    env: agentEnv,
  });

  agentProcess.on('error', (err) => {
    if (thisGeneration !== agentGeneration) return; // stale event from old process
    const msg = `Failed to start agent process (${runtime.binary}): ${err.message}`;
    console.error(msg);
    log('SYSTEM', msg);
    emitter.emit('log', `[Agent] ${msg}`);
    emitter.emit('notification', { title: 'Tally Agent Error', body: msg });
    agentProcess = null;
  });

  agentProcess.stdout.on('data', (data) => {
    const text = data.toString();
    console.log('[Agent]', text.trim());
    log('AGENT', text);

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
        emitter.emit('chat-message', chatMsg);
      } catch { /* ignore parse errors */ }
    }

    emitter.emit('status-changed', agentStatus);
    emitter.emit('log', text);
  });

  agentProcess.stderr.on('data', (data) => {
    const text = data.toString();
    log('AGENT_ERR', text);
    emitter.emit('log', '[err] ' + text);

    // Detect auth rejection (WebSocket close code 1008) and notify renderer
    if (text.includes('1008') || text.includes('Invalid token') || text.includes('Authentication failed') || text.includes('auth') && text.includes('reject')) {
      agentStatus.relay = false;
      emitter.emit('status-changed', agentStatus);
      emitter.emit('auth-invalid');
    }
  });

  agentProcess.on('close', (code) => {
    if (thisGeneration !== agentGeneration) return; // stale close event from old process
    agentProcess = null;
    const savedEncoderType = agentStatus.encoderType;
    agentStatus = { relay: false, atem: false, obs: false, companion: false, encoder: false, encoderType: savedEncoderType, audio: {} };
    emitter.emit('status-changed', agentStatus);
    console.log(`Agent exited with code ${code}`);
    log('SYSTEM', `Agent exited with code ${code}`);

    // If we intentionally stopped the agent, don't count as crash
    if (agentIntentionalStop) {
      agentIntentionalStop = false;
      agentCrashCount = 0;
      return;
    }

    if (code === 0) {
      agentCrashCount = 0; // Clean exit — reset counter
    } else {
      agentCrashCount++;
      if (agentCrashCount >= MAX_AGENT_CRASHES) {
        const msg = `Agent crashed ${agentCrashCount} times. Auto-restart disabled — use the Start Agent button to retry.`;
        log('SYSTEM', msg);
        emitter.emit('log', `[Agent] ${msg}`);
        emitter.emit('notification', { title: 'Tally Agent Error', body: msg });
        agentCrashCount = 0; // Reset so manual start can try again
      } else {
        const delay = Math.min(5000 * agentCrashCount, 30000);
        log('SYSTEM', `Restarting agent in ${delay / 1000}s (crash ${agentCrashCount}/${MAX_AGENT_CRASHES})`);
        setTimeout(() => startAgent(), delay);
      }
    }
  });
}

function stopAgent() {
  if (agentProcess) {
    agentIntentionalStop = true;
    ++agentGeneration; // invalidate stale close events from the old process
    log('SYSTEM', 'Stopping agent');
    const proc = agentProcess;
    agentProcess = null; // clear immediately so startAgent() can proceed
    proc.kill();
    // SIGKILL fallback if process doesn't exit within 5s
    setTimeout(() => { try { proc?.kill('SIGKILL'); } catch {} }, 5000);
  } else {
    log('SYSTEM', 'Stop agent requested but no process was running');
  }
}

// ─── RELAY RECONNECT WATCHDOG ─────────────────────────────────────────────────
// If relay stays disconnected for 2+ minutes while agent is running, restart it.
const RELAY_RECONNECT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
let _watchdogInterval = null;

function startWatchdog() {
  if (_watchdogInterval) return;
  _watchdogInterval = setInterval(() => {
    if (agentProcess && agentStatus._relayDisconnectedAt) {
      const elapsed = Date.now() - agentStatus._relayDisconnectedAt;
      if (elapsed >= RELAY_RECONNECT_TIMEOUT_MS) {
        log('SYSTEM', `Relay disconnected for ${Math.round(elapsed / 1000)}s — restarting agent`);
        emitter.emit('log', '[Watchdog] Relay disconnected too long — restarting agent');
        agentStatus._relayDisconnectedAt = null; // Reset to avoid repeated kills
        stopAgent();
        setTimeout(() => startAgent(), 3000);
      }
    }
  }, 30_000); // Check every 30 seconds
}

// Start watchdog immediately when module loads (matches original behavior)
startWatchdog();

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

function getAgentStatus() {
  return agentStatus;
}

function setAgentStatus(newStatus) {
  agentStatus = newStatus;
}

function isAgentRunning() {
  return !!agentProcess;
}

function getRecentLogLines() {
  return recentLogLines;
}

function resetCrashCount() {
  agentCrashCount = 0;
}

module.exports = {
  emitter,
  init,
  startAgent,
  stopAgent,
  getAgentStatus,
  setAgentStatus,
  isAgentRunning,
  getRecentLogLines,
  resetCrashCount,
};
