'use strict';
/**
 * Tally Encoder — Remote Management API
 *
 * Lightweight Express server providing machine-to-machine endpoints
 * for the Tally relay to query and configure this encoder device.
 *
 * Port: TALLY_API_PORT (default 7070)
 * Auth: Authorization: Bearer <TALLY_API_TOKEN>
 *
 * Endpoints:
 *   GET  /health        — 200 OK liveness probe
 *   GET  /status        — stream + device status
 *   POST /config        — update bitrate / relay URL and restart encoder
 *   POST /restart       — restart the ffmpeg stream
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { execSync, spawn } = require('child_process');

// ── Load config from env (populated by systemd EnvironmentFile) ───────────────
const CONFIG_FILE  = process.env.CONFIG_FILE  || '/etc/tally-encoder/config.env';
const PORT         = parseInt(process.env.TALLY_API_PORT || '7070', 10);
const API_TOKEN    = process.env.TALLY_API_TOKEN || '';
const LOG_FILE     = process.env.LOG_FILE || '/var/log/tally-encoder.log';

const startTime = Date.now();

// ── Helper: read config file key=value pairs ──────────────────────────────────
function readConfig() {
  const cfg = {};
  try {
    const lines = fs.readFileSync(CONFIG_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      cfg[k] = v;
    }
  } catch {
    // Config file not yet available
  }
  return cfg;
}

// ── Helper: write updated config ──────────────────────────────────────────────
function writeConfig(updates) {
  let content = '';
  try {
    content = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch {
    content = '';
  }

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^(${key}\\s*=).*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `$1${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
  }

  fs.writeFileSync(CONFIG_FILE, content, 'utf8');
}

// ── Helper: check if ffmpeg process is running ────────────────────────────────
function isEncoderRunning() {
  try {
    const pidFile = '/tmp/tally-encoder-ffmpeg.pid';
    if (!fs.existsSync(pidFile)) return false;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid || isNaN(pid)) return false;
    // Send signal 0 to check if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Helper: restart the encoder systemd service ───────────────────────────────
function restartEncoder() {
  try {
    execSync('systemctl restart tally-encoder', { timeout: 10000 });
    return true;
  } catch {
    // Not running under systemd (dev environment) — try to signal the process
    try {
      execSync('pkill -f encoder.sh', { timeout: 5000 });
    } catch { /* process may not be running */ }
    return false;
  }
}

// ── Helper: get recent log lines ─────────────────────────────────────────────
function getRecentLogs(lines = 50) {
  try {
    const result = execSync(`tail -n ${lines} "${LOG_FILE}"`, { timeout: 3000 });
    return result.toString().trim().split('\n');
  } catch {
    return [];
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ── Bearer token auth middleware ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!API_TOKEN) {
    // No token configured — warn but allow (dev mode)
    console.warn('[API] WARNING: TALLY_API_TOKEN not set — auth disabled!');
    return next();
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' });
  }

  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}

// ── GET /health ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── GET /status ───────────────────────────────────────────────────────────────
app.get('/status', requireAuth, (req, res) => {
  const cfg = readConfig();
  const running = isEncoderRunning();
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);

  res.json({
    connected:   running,
    streamActive: running,
    uptime:       uptimeSec,
    bitrate:      cfg.BITRATE     || '3000k',
    inputDevice:  cfg.INPUT_DEVICE || 'unknown',
    inputType:    cfg.INPUT_TYPE   || 'v4l2',
    relayUrl:     cfg.RELAY_URL    || '',
    churchToken:  cfg.CHURCH_TOKEN ? '***' : '(not set)',
    apiPort:      PORT,
    logFile:      LOG_FILE,
    recentLogs:   getRecentLogs(20),
  });
});

// ── POST /config ──────────────────────────────────────────────────────────────
app.post('/config', requireAuth, (req, res) => {
  const { bitrate, relayUrl, inputDevice, inputType, audioDevice } = req.body || {};

  if (!bitrate && !relayUrl && !inputDevice && !inputType && !audioDevice) {
    return res.status(400).json({
      error: 'No config fields provided',
      supported: ['bitrate', 'relayUrl', 'inputDevice', 'inputType', 'audioDevice'],
    });
  }

  const updates = {};
  if (bitrate)      updates.BITRATE      = bitrate;
  if (relayUrl)     updates.RELAY_URL    = relayUrl;
  if (inputDevice)  updates.INPUT_DEVICE = inputDevice;
  if (inputType)    updates.INPUT_TYPE   = inputType;
  if (audioDevice)  updates.AUDIO_DEVICE = audioDevice;

  try {
    writeConfig(updates);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write config', detail: e.message });
  }

  const restarted = restartEncoder();

  res.json({
    ok:        true,
    updated:   Object.keys(updates),
    restarted,
    message:   restarted
      ? 'Config updated and encoder restarted'
      : 'Config updated — encoder restart may require manual intervention',
  });
});

// ── POST /restart ─────────────────────────────────────────────────────────────
app.post('/restart', requireAuth, (_req, res) => {
  const restarted = restartEncoder();
  res.json({
    ok:        restarted,
    restarted,
    message:   restarted ? 'Encoder restarted' : 'Restart attempted (check systemctl status tally-encoder)',
    ts:        new Date().toISOString(),
  });
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found', endpoints: ['/health', '/status', '/config', '/restart'] });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Tally API] Listening on port ${PORT}`);
  console.log(`[Tally API] Auth: ${API_TOKEN ? 'Bearer token required' : 'DISABLED (set TALLY_API_TOKEN)'}`);
});

module.exports = app; // for testing
