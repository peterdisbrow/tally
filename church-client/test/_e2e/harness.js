/**
 * Command-dispatch E2E harness.
 *
 * Boots a self-contained relay+agent+mocks rig in the test process so the
 * accompanying command-e2e.test.js can verify that POST /api/command on the
 * relay actually reaches the church-client agent, the agent dispatches it to
 * the right device bridge, and the bridge speaks the right protocol to the
 * mock device.
 *
 * Layout
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ test process                                                    │
 *   │  • starts mocks (in-process via ./mocks/*.js)                   │
 *   │  • spawns relay-server (subprocess, ephemeral SQLite + port)    │
 *   │  • registers a test church via admin /api/churches/register     │
 *   │  • spawns church-client/src/index.js (subprocess)               │
 *   │  • POST /api/command → assert mock state via control API        │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * Why subprocesses for relay + agent? They both listen on TCP sockets and
 * have rich global state (signal handlers, fs polls, intervals). Spawning
 * them lets the harness tear them down with SIGTERM/SIGKILL and avoids the
 * "tests crash the runner" failure mode. The mocks are tiny and side-effect-
 * free, so we boot them in-process for speed.
 */

'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RELAY_DIR = path.join(REPO_ROOT, 'relay-server');
const CHURCH_CLIENT = path.join(REPO_ROOT, 'church-client');

// ─── Generic helpers ─────────────────────────────────────────────────────────

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

// ─── Mock launcher ───────────────────────────────────────────────────────────
// Boots every mock device in-process on an ephemeral port so multiple test
// runs (or two suites in one process) can't collide. Returns a map keyed by
// device name. Each entry has the URL, port, and a `control` HTTP helper.

const MOCK_REGISTRY = [
  { name: 'companion',  file: 'companionServer.js' },
  { name: 'propresenter', file: 'propresenterServer.js' },
  { name: 'videohub',   file: 'videohubServer.js' },
  { name: 'obs',        file: 'obsServer.js' },
  { name: 'tricaster',  file: 'tricasterServer.js' },
  { name: 'resolume',   file: 'resolumeServer.js' },
  { name: 'sq',         file: 'sqMixerServer.js' },
  { name: 'visca-ptz',  file: 'viscaPtzServer.js' },
];

async function startAllMocks() {
  const handles = {};
  for (const entry of MOCK_REGISTRY) {
    const mod = require(path.join(__dirname, '..', 'mocks', entry.file));
    // Bind every mock to an ephemeral port (port: 0). The agent config uses
    // the port we capture here, so default ports don't matter.
    const handle = await mod.start({ port: 0, controlPort: 0 });
    handles[entry.name] = {
      ...handle,
      // Convenience helpers wrapping the control API.
      action: (action, args = {}) => mockAction(handle.control.url, action, args),
      readState: () => mockGet(handle.control.url, '/state'),
      reset: () => mockGet(handle.control.url, '/reset', 'POST'),
    };
  }
  return handles;
}

async function stopAllMocks(handles) {
  await Promise.allSettled(Object.values(handles).map((h) => h.stop?.()));
}

async function mockAction(controlUrl, action, args) {
  const res = await fetch(`${controlUrl}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args }),
  });
  if (!res.ok) throw new Error(`mock control action ${action} → ${res.status}: ${await res.text()}`);
  return res.json();
}
async function mockGet(controlUrl, path = '/state', method = 'GET') {
  const res = await fetch(`${controlUrl}${path}`, { method });
  if (!res.ok) throw new Error(`mock control ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Relay subprocess ────────────────────────────────────────────────────────

async function startRelay({ port, jwtSecret, adminApiKey, dataDir }) {
  const dbPath = path.join(dataDir, 'churches.db');
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_SECRET: jwtSecret,
    ADMIN_API_KEY: adminApiKey,
    SESSION_SECRET: crypto.randomBytes(16).toString('hex'),
    DATABASE_DRIVER: 'sqlite',
    DATABASE_PATH: dbPath,
    BACKUP_DIR: path.join(dataDir, 'backups'),
    DISABLE_HTTP_LOGS: '1',
    // Suppress the noisy "telegram bot starting" warnings + Stripe/Resend
    // bootstraps that aren't relevant to dispatch tests.
    TELEGRAM_BOT_TOKEN: '',
    STRIPE_SECRET_KEY: '',
    RESEND_API_KEY: '',
    // Command rate limit defaults to 10/sec — easy to trip when 19 tests
    // dispatch back-to-back in well under a second.
    TALLY_COMMAND_RATE_LIMIT: '500',
  };

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: RELAY_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout = [];
  const stderr = [];
  proc.stdout.on('data', (d) => stdout.push(d.toString()));
  proc.stderr.on('data', (d) => stderr.push(d.toString()));

  // Wait for the listener (the log line is "Tally Relay listening on port N").
  // Falling back to polling /health/deep so we don't depend on log format.
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (!proc.pid || proc.exitCode != null) {
      throw new Error(`relay exited early: stderr=${stderr.join('').slice(-500)}`);
    }
    const res = await fetch(`${baseUrl}/health`).catch(() => null);
    return res && res.ok;
  }, { timeoutMs: 20_000, label: 'relay /health to be ready' });

  return {
    proc,
    baseUrl,
    port,
    stdout, stderr,
    captureLogs: () => ({ stdout: stdout.join(''), stderr: stderr.join('') }),
    stop: async () => {
      if (proc.exitCode != null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    },
  };
}

// ─── Admin API helpers ───────────────────────────────────────────────────────

function adminClient(baseUrl, apiKey) {
  const headers = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
  return {
    async post(path, body) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
      const text = await res.text();
      let parsed = text;
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
      return parsed;
    },
    async get(path) {
      const res = await fetch(`${baseUrl}${path}`, { headers });
      const text = await res.text();
      try { return JSON.parse(text); } catch { return text; }
    },
  };
}

async function registerTestChurch(admin, { name }) {
  // The /register endpoint accepts an optional churchId/token; we let it
  // generate both. portalEmail+password are required if either is provided —
  // skip both since the test only exercises the WS token path.
  const created = await admin.post('/api/churches/register', {
    name,
    tier: 'pro',
    billingStatus: 'active',
  });
  if (!created.churchId || !created.token) {
    throw new Error(`register returned unexpected shape: ${JSON.stringify(created)}`);
  }
  return { churchId: created.churchId, token: created.token, name };
}

// ─── Agent subprocess ────────────────────────────────────────────────────────

async function startAgent({ relayHttpUrl, wsToken, churchName, roomId, equipment, logBuf }) {
  const wsRelayUrl = relayHttpUrl.replace(/^http/, 'ws');
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tally-cmd-e2e-'));
  const configPath = path.join(tmpDir, 'config.json');
  const cfg = {
    token: wsToken,
    relay: wsRelayUrl,
    name: churchName,
    roomId,
    roomName: 'E2E Studio',
    ...equipment,
  };
  await fsp.writeFile(configPath, JSON.stringify(cfg, null, 2));

  const proc = spawn(process.execPath, [
    'src/index.js',
    '--config', configPath,
    '--token', wsToken,
    '--relay', wsRelayUrl,
    '--room-id', roomId,
    '--name', churchName,
    '--no-watchdog',
  ], {
    cwd: CHURCH_CLIENT,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => logBuf.stdout.push(d.toString()));
  proc.stderr.on('data', (d) => logBuf.stderr.push(d.toString()));

  return {
    proc,
    configPath,
    tmpDir,
    stop: async () => {
      if (proc.exitCode != null) return;
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } resolve(); }, 3000);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ─── Top-level lifecycle ─────────────────────────────────────────────────────

async function bootHarness({ churchName = `E2E-${Date.now()}` } = {}) {
  // Find a free port and mint admin credentials.
  const relayPort = await findFreePort();
  const adminApiKey = `e2e-admin-${crypto.randomBytes(8).toString('hex')}`;
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  // Ephemeral data dir for SQLite + backups.
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tally-relay-e2e-'));

  // Boot all mocks.
  const mocks = await startAllMocks();

  // Boot the relay subprocess.
  const relay = await startRelay({ port: relayPort, jwtSecret, adminApiKey, dataDir });
  const admin = adminClient(relay.baseUrl, adminApiKey);

  // Register the test church.
  const church = await registerTestChurch(admin, { name: churchName });

  // Build the agent config from the live mock ports.
  const equipment = {
    // Encoder / TriCaster — wired via switchers list (TriCaster has its own
    // bridge on top of the Switcher abstraction).
    switchers: [
      {
        id: 'tc-1',
        type: 'tricaster',
        role: 'primary',
        name: 'TriCaster Mini',
        host: '127.0.0.1',
        port: mocks.tricaster.port,
      },
    ],
    obsUrl: mocks.obs.url, // ws://127.0.0.1:<port>
    obsPassword: '',
    obsMonitoring: true,
    companionUrl: mocks.companion.url,
    companionMonitoring: true,
    videoHubs: [{ ip: '127.0.0.1', name: 'VH-Main', port: mocks.videohub.port }],
    proPresenter: { host: '127.0.0.1', port: mocks.propresenter.port },
    resolume: { host: '127.0.0.1', port: mocks.resolume.port },
    // SQ uses two ports — OSC for naming/HPF, TCP MIDI for everything else.
    // Both must be threaded through to the bridge or the agent silently
    // falls back to the hardcoded production defaults (51326/51325) and
    // never reaches our ephemeral mock.
    mixer: {
      type: 'allenheath',
      host: '127.0.0.1',
      port: mocks.sq.oscPort,
      midiPort: mocks.sq.midiPort,
      model: 'SQ',
    },
    ptz: [{
      ip: '127.0.0.1',
      name: 'BirdDog PTZ Camera',
      protocol: 'visca-tcp',
      port: mocks['visca-ptz'].port,
    }],
  };

  // Spawn the agent.
  const logBuf = { stdout: [], stderr: [] };
  const agent = await startAgent({
    relayHttpUrl: relay.baseUrl,
    wsToken: church.token,
    churchName: church.name,
    roomId: 'room_e2e_main',
    equipment,
    logBuf,
  });

  // Wait for the agent to register on the relay's churches map (i.e., the
  // WebSocket landed and is OPEN). Poll the admin /api/churches/:id/status
  // endpoint — `connected: true` means at least one socket is OPEN.
  await waitFor(async () => {
    const status = await admin.get(`/api/churches/${church.churchId}/status`);
    return status.connected === true;
  }, { timeoutMs: 25_000, label: 'agent WebSocket connection' });

  return {
    church,
    relay,
    admin,
    agent,
    mocks,
    logBuf,
    /** Reset all mock state to initial defaults between tests. */
    resetMocks: async () => {
      await Promise.all(Object.values(mocks).map(async (m) => {
        try { await m.reset(); } catch { /* mock may not be running */ }
      }));
    },
    /** Helper: dispatch a command via /api/command. */
    dispatch: (command, params = {}) =>
      admin.post('/api/command', { churchId: church.churchId, command, params }),
    /** Tear everything down. Safe to call multiple times. */
    stop: async () => {
      try { await agent.stop(); } catch { /* */ }
      try { await relay.stop(); } catch { /* */ }
      try { await stopAllMocks(mocks); } catch { /* */ }
      await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
    /** Snapshot the captured agent + relay logs for failure diagnostics. */
    snapshotLogs: () => ({
      agentStdout: logBuf.stdout.join(''),
      agentStderr: logBuf.stderr.join(''),
      ...relay.captureLogs(),
    }),
  };
}

module.exports = { bootHarness, waitFor, sleep, findFreePort };
