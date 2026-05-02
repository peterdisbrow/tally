/**
 * Spawn the church-client agent as a subprocess pointed at the test account
 * + the mock devices.
 *
 * The agent reads its config from a JSON file (`--config <path>`). We
 * generate that file fresh on every run with:
 *   - The WS token from the test-account-create flow (long-lived 365d).
 *   - Equipment block pointing every device at 127.0.0.1:<mock-port>.
 *   - A roomId so the agent connects as `roomName::roomId` (needed for the
 *     relay's per-room status routing).
 *
 * Important: `church-client/src/index.js stripMockConfig()` deletes any host
 * containing 'mock'/'fake'/'sim' on load — so we use plain '127.0.0.1' and
 * a non-suspicious agent name.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CHURCH_CLIENT = path.join(REPO_ROOT, 'church-client');

function buildEquipmentConfig() {
  // Mirrors the keys church-client/src/index.js reads.
  //
  // Two non-obvious gotchas:
  //
  // 1) `obsUrl` MUST NOT exactly match a string in
  //    church-client/src/index.js LEGACY_DEFAULT_OBS_URLS
  //    (= ['ws://localhost:4455', 'ws://127.0.0.1:4455'] with NO trailing
  //    slash). When `encoder.type !== 'obs'` AND obsUrl matches, the agent's
  //    loadConfig() silently strips obsUrl and OBS never connects. The
  //    workaround is to use a string that points at the same socket but
  //    isn't in the set — adding a trailing slash works.
  //
  // 2) Setting `encoder.type = 'obs'` creates a SECOND OBS connection (the
  //    EncoderBridge → ObsEncoder, alongside the standalone OBS bridge from
  //    obsUrl). Both target ws://127.0.0.1:4455 and the dual connections
  //    collide on the mock — the agent goes into a flap-loop, disconnecting
  //    every other bridge along the way. Keep encoder.type as 'tricaster'
  //    (separate mock at port 5951) so OBS gets exactly one connection.
  return {
    atemIp: '127.0.0.1',
    obsUrl: 'ws://127.0.0.1:4455/', // trailing slash bypasses LEGACY_DEFAULT_OBS_URLS
    obsPassword: '',
    companionUrl: 'http://127.0.0.1:8000',
    videoHubs: [{ ip: '127.0.0.1', name: 'VH1' }],
    proPresenter: { host: '127.0.0.1', port: 1025 },
    resolume: { host: '127.0.0.1', port: 8080 },
    vmix: null,
    mixer: { type: 'allenheath', host: '127.0.0.1', port: 51326, model: 'SQ' },
    encoder: { type: 'tricaster', host: '127.0.0.1', port: 5951 },
    ptz: [],
    hyperdecks: [],
  };
}

class AgentRunner {
  constructor({ log, relayUrl, wsToken, churchName, roomId, roomName = 'E2E Studio' }) {
    this.log = log;
    this.wsRelayUrl = String(relayUrl).replace(/^http/, 'ws');
    this.wsToken = wsToken;
    this.churchName = churchName;
    this.roomId = roomId;
    this.roomName = roomName;
    this.proc = null;
    this.configPath = null;
    this.stdoutBuf = '';
    this.stderrBuf = '';
  }

  async start() {
    if (this.proc) throw new Error('[agent] already running');
    // Write a fresh config file in tmp.
    const ts = Date.now();
    this.configPath = path.join(os.tmpdir(), `e2e-harness-${ts}.json`);
    const cfg = {
      token: this.wsToken,
      relayUrl: this.wsRelayUrl,
      name: this.churchName,
      roomId: this.roomId,
      roomName: this.roomName,
      ...buildEquipmentConfig(),
    };
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));

    this.proc = spawn('node', [
      'src/index.js',
      '--config', this.configPath,
      '--token', this.wsToken,
      '--relay', this.wsRelayUrl,
      '--room-id', this.roomId,
      '--name', 'e2e-harness',
      '--no-watchdog',
    ], {
      cwd: CHURCH_CLIENT,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => { this.stdoutBuf += d.toString(); this.log?.debug('[agent-out]', d.toString().trimEnd()); });
    this.proc.stderr.on('data', (d) => { this.stderrBuf += d.toString(); this.log?.debug('[agent-err]', d.toString().trimEnd()); });
    this.proc.on('exit', (code) => { this.log?.debug(`[agent] exited code=${code}`); this.proc = null; });
  }

  /** Wait for the church-client to log a relay-connected confirmation. */
  async waitConnected({ timeoutMs = 20_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // The agent prints something like "✅ Relay connected" or
      // "Connected to relay" — accept either to stay tolerant of message
      // tweaks. Also accept "registered" as a sign the WS handshake landed.
      if (/Relay connected|Connected to relay|relay.*registered|Registered with relay/i.test(this.stdoutBuf)) return;
      if (!this.proc) {
        throw new Error(`[agent] exited before connecting:\n${this.stderrBuf || this.stdoutBuf}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`[agent] did not connect within ${timeoutMs}ms\nstdout:\n${this.stdoutBuf.slice(-2000)}\nstderr:\n${this.stderrBuf.slice(-2000)}`);
  }

  async stop() {
    if (!this.proc) return;
    const dead = new Promise((r) => this.proc.once('exit', r));
    try { this.proc.kill('SIGTERM'); } catch { /* */ }
    const force = setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch { /* */ } }, 5_000);
    await dead;
    clearTimeout(force);
    this.proc = null;
    if (this.configPath) {
      try { fs.unlinkSync(this.configPath); } catch { /* */ }
    }
  }
}

module.exports = { AgentRunner, buildEquipmentConfig };
