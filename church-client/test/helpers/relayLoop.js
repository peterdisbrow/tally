/**
 * relayLoop — the REMOTE-ENGINEER path, end to end, all local:
 *
 *   engineer (controller WS / admin HTTP) → REAL relay-server (temp SQLite,
 *   free port) → REAL church-client agent → stateful device mock
 *
 * Nothing here touches production: the relay is spawned from this repo with a
 * throwaway DB and random secrets, bound to 127.0.0.1 on a free port.
 *
 * Tests assert on what the engineer actually gets back (command_result with a
 * real result or a real error), and on what the relay reports as device status.
 */
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { freePort } = require('./agentHarness');

const REPO = path.join(__dirname, '..', '..', '..');
const RELAY_DIR = process.env.TALLY_RELAY_DIR || path.join(REPO, 'relay-server');
const AGENT_INDEX = process.env.TALLY_AGENT_INDEX || path.join(REPO, 'church-client', 'src', 'index.js');

function relayAvailable() {
  const ok = fs.existsSync(path.join(RELAY_DIR, 'server.js')) && fs.existsSync(path.join(RELAY_DIR, 'node_modules'));
  // CI sets TALLY_REQUIRE_RELAY_LOOP=1: a missing relay must FAIL, never silently skip
  // the remote-engineer tests.
  if (!ok && process.env.TALLY_REQUIRE_RELAY_LOOP === '1') {
    throw new Error(`relay-server not available at ${RELAY_DIR} (install its deps) — remote-engineer sims are required`);
  }
  return ok;
}

async function startRelay() {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-relayloop-'));
  const adminKey = crypto.randomBytes(24).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: 'development', PORT: String(port), DATABASE_DRIVER: 'sqlite',
    DATABASE_PATH: path.join(dir, 'relay.db'),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_API_KEY: adminKey, TALLY_REQUIRE_ACTIVE_BILLING: 'false',
    APP_URL: `http://127.0.0.1:${port}`, ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    LOG_FORMAT: 'text',
  };
  const logs = [];
  const proc = spawn(process.execPath, [path.join(RELAY_DIR, 'server.js')], { cwd: RELAY_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`relay exited ${proc.exitCode}\n${logs.join('').slice(-3000)}`);
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not up */ }
    if (Date.now() - t0 > 30000) throw new Error(`relay did not start in 30s\n${logs.join('').slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  async function api(method, p, body) {
    const r = await fetch(base + p, {
      method, headers: { 'content-type': 'application/json', 'x-api-key': adminKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json };
  }
  async function stop() {
    try { proc.kill('SIGTERM'); } catch { /* */ }
    await new Promise((r) => { const to = setTimeout(r, 4000); proc.once('exit', () => { clearTimeout(to); r(); }); });
    try { proc.kill('SIGKILL'); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  return { port, base, adminKey, api, logs, proc, stop };
}

/**
 * Start relay + register a church + start the real agent with `config`
 * + connect an engineer controller socket.
 */
async function startRelayLoop(config = {}, { env = {} } = {}) {
  const relay = await startRelay();
  const email = `sim-${Date.now()}@example.test`;
  const reg = await relay.api('POST', '/api/churches/register', {
    name: `Sim Church ${Date.now()}`, portalEmail: email, password: 'SimPass!2345', billingStatus: 'active', tier: 'pro',
  });
  if (!reg.body?.churchId || !reg.body?.token) { await relay.stop(); throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`); }
  const { churchId, token } = reg.body;

  const configFile = path.join(os.tmpdir(), `tally-relayloop-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ token, ...config }));
  const agentLogs = [];
  const agent = spawn(process.execPath, [AGENT_INDEX, '--relay', `ws://127.0.0.1:${relay.port}`, '--config', configFile, '--no-watchdog'], {
    env: { ...process.env, TALLY_SENTRY_DSN: '', ELECTRON_SENTRY_DSN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  agent.stdout.on('data', (d) => agentLogs.push(d.toString()));
  agent.stderr.on('data', (d) => agentLogs.push(d.toString()));

  // Engineer's controller socket (same one the admin dashboard / Companion module uses).
  const ctl = new WebSocket(`ws://127.0.0.1:${relay.port}/controller?apikey=${relay.adminKey}`);
  const ctlMsgs = [];
  ctl.on('message', (d) => { try { ctlMsgs.push(JSON.parse(d.toString())); } catch { /* */ } });
  await new Promise((res, rej) => { ctl.once('open', res); ctl.once('error', rej); });

  function dumpLogs(label) {
    const f = path.join(os.tmpdir(), `tally-relayloop-${label}-${Date.now()}.log`);
    try { fs.writeFileSync(f, `=== AGENT ===\n${agentLogs.join('')}\n=== RELAY ===\n${relay.logs.join('')}`); } catch { /* */ }
    return f;
  }

  async function relayStatus() {
    const r = await relay.api('GET', `/api/churches/${encodeURIComponent(churchId)}/status`);
    return r.body;
  }
  /** Poll the RELAY's view of the church until pred(status, connected) holds. */
  async function waitForRelay(pred, timeoutMs = 15000, label = 'relay condition') {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < timeoutMs) {
      last = await relayStatus().catch(() => null);
      try { if (last && pred(last.status || {}, last.connected)) return { ms: Date.now() - t0, status: last.status }; } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    const f = dumpLogs('timeout');
    throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}; relay status=${JSON.stringify(last)?.slice(0, 800)}\n[logs: ${f}]`);
  }

  /**
   * Engineer sends a command over the controller WS; resolves with what the
   * engineer receives: { result } | { error } | { relayError } (e.g. church not connected).
   */
  async function controllerCommand(command, params = {}, timeoutMs = 12000) {
    const id = crypto.randomUUID();
    const from = ctlMsgs.length;
    ctl.send(JSON.stringify({ type: 'command', churchId, command, params, id }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      for (let i = from; i < ctlMsgs.length; i++) {
        const m = ctlMsgs[i];
        if (m.type === 'command_result' && (m.messageId === id || m.id === id)) return { result: m.result, error: m.error || null, ms: Date.now() - t0 };
        if (m.type === 'error' && m.churchId === churchId) return { relayError: m.error, ms: Date.now() - t0 };
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    return { timedOut: true, ms: Date.now() - t0 };
  }

  /** Engineer sends via admin HTTP /api/command (optionally waiting for the real result). */
  async function httpCommand(command, params = {}, extra = {}) {
    return relay.api('POST', '/api/command', { churchId, command, params, ...extra });
  }

  async function stopAgent() {
    try { agent.kill('SIGTERM'); } catch { /* */ }
    await new Promise((r) => { const to = setTimeout(r, 3000); agent.once('exit', () => { clearTimeout(to); r(); }); });
    try { agent.kill('SIGKILL'); } catch { /* */ }
  }
  async function stop() {
    try { ctl.close(); } catch { /* */ }
    await stopAgent();
    await relay.stop();
    try { fs.unlinkSync(configFile); } catch { /* */ }
  }
  return { relay, churchId, token, agent, agentLogs, ctlMsgs, relayStatus, waitForRelay, controllerCommand, httpCommand, stopAgent, dumpLogs, stop };
}

module.exports = { startRelay, startRelayLoop, relayAvailable };
