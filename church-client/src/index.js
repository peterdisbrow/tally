#!/usr/bin/env node
/**
 * Tally — Client Agent
 * Runs on the church's production computer.
 * Bridges local ATEM/OBS/ProPresenter → Andrew's relay server.
 *
 * Usage:
 *   npx tally-connect --token YOUR_TOKEN --relay wss://relay.atemschool.com
 */

const WebSocket = require('ws');
const { Atem } = require('atem-connection');
const OBSWebSocket = require('obs-websocket-js').default;
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { commandHandlers } = require('./commands');
const { CompanionBridge } = require('./companion');
const { VideoHub } = require('./videohub');
const { ProPresenter } = require('./propresenter');
const { Resolume } = require('./resolume');
const { VMix } = require('./vmix');
const { AudioMonitor } = require('./audioMonitor');
const { StreamHealthMonitor } = require('./streamHealthMonitor');
const { encryptConfig, decryptConfig, findUnencryptedFields } = require('./secureStorage');
const { MixerBridge } = require('./mixerBridge');
const { FakeAtem } = require('./fakeAtem');
const { FakeAtemApiServer } = require('./fakeAtemApi');
const { FakeOBS } = require('./fakeObs');
const { FakeMixerBridge } = require('./fakeMixer');
const { FakeProPresenter } = require('./fakeProPresenter');

// ─── CLI CONFIG ───────────────────────────────────────────────────────────────

program
  .name('tally-connect')
  .description('Connect your church AV system to ATEM School remote monitoring');

program
  .option('-t, --token <token>', 'Your church connection token (from ATEM School)')
  .option('-r, --relay <url>', 'Relay server URL', 'wss://tally-production-cde2.up.railway.app')
  .option('-a, --atem <ip>', 'ATEM switcher IP (use "mock" for built-in simulator)')
  .option('--mock-production', 'Run full mock production stack (ATEM + OBS + X32 + HyperDeck + ProPresenter)')
  .option('--fake-atem-api-port <port>', 'Fake ATEM control API port (default: 9911)')
  .option('-o, --obs <url>', 'OBS WebSocket URL', 'ws://localhost:4455')
  .option('-p, --obs-password <password>', 'OBS WebSocket password')
  .option('-n, --name <name>', 'Label for this system (e.g., "Main Sanctuary")')
  .option('-c, --companion <url>', 'Companion HTTP API URL', 'http://localhost:8888')
  .option('--preview-source <name>', 'OBS source name for preview screenshots', '')
  .option('--config <path>', 'Path to config file', path.join(os.homedir(), '.church-av', 'config.json'))
  .option('--watchdog', 'Enable watchdog monitoring (default: true)', true)
  .option('--no-watchdog', 'Disable watchdog monitoring')
  .parse();

// Handle 'setup' subcommand before anything else
if (process.argv[2] === 'setup') {
  const { runSetup } = require('./setup');
  runSetup();
  return; // stop processing
}

const opts = program.opts();

function isFakeAtemMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate' || v.startsWith('mock://');
}

function isFakeObsMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v.startsWith('mock://');
}

function isFakeHostMode(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim';
}

function loadConfig() {
  const configPath = opts.config;
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = decryptConfig(raw); // decrypt sensitive fields on load
    }
    catch { config = {}; }
  }

  if (opts.token) config.token = opts.token;
  if (opts.relay) config.relay = opts.relay;
  if (opts.atem) config.atemIp = opts.atem;
  if (opts.obs) config.obsUrl = opts.obs;
  if (opts.obsPassword) config.obsPassword = opts.obsPassword;
  if (opts.name) config.name = opts.name;
  if (opts.companion) config.companionUrl = opts.companion;
  if (opts.previewSource) config.previewSource = opts.previewSource;
  if (opts.watchdog !== undefined) config.watchdog = opts.watchdog;
  if (opts.fakeAtemApiPort !== undefined) config.fakeAtemApiPort = Number(opts.fakeAtemApiPort);
  if (opts.mockProduction) config.mockProduction = true;

  // Preserve array fields from config file (hyperdecks, ptz)
  // These are set via the Equipment UI, not CLI args
  if (!config.hyperdecks) config.hyperdecks = [];
  if (!config.ptz) config.ptz = [];
  if (!config.videoHubs) config.videoHubs = [];
  if (!config.proPresenter) config.proPresenter = { host: 'localhost', port: 1025 };
  if (!config.resolume) config.resolume = null; // null = not configured
  if (!config.vmix) config.vmix = null; // null = not configured (Windows only)
  if (!config.mixer) config.mixer = null; // null = not configured

  if (config.mockProduction) {
    config.atemIp = 'mock';
    config.obsUrl = 'mock://obs';
    config.proPresenter = { host: 'mock', port: 1025 };
    config.mixer = { type: 'x32', host: 'mock', port: 10023 };
    if (!Array.isArray(config.hyperdecks) || config.hyperdecks.length === 0) {
      config.hyperdecks = ['mock-hyperdeck-1'];
    }
  }

  // Stream platform API keys (optional, for Feature 9)
  // Set in ~/.church-av/config.json: youtubeApiKey, facebookAccessToken
  if (!config.youtubeApiKey) config.youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  if (!config.facebookAccessToken) config.facebookAccessToken = process.env.FACEBOOK_ACCESS_TOKEN || '';
  if (!config.youtubeApiKey) config.youtubeApiKey = '';
  if (!config.facebookAccessToken) config.facebookAccessToken = '';

  if (!config.token) {
    console.error('\n❌ No connection token provided.');
    console.error('   Get your token from ATEM School, then run:');
    console.error('   tally-connect --token YOUR_TOKEN\n');
    process.exit(1);
  }

  fs.writeFileSync(configPath, JSON.stringify(encryptConfig(config), null, 2));
  return config;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

class ChurchAVAgent {
  constructor(config) {
    this.config = config;
    this.mockProduction = !!config.mockProduction;
    this.relay = null;
    this.atem = null;

    // Derive churchId and HTTP base URL from JWT token + relay URL
    try {
      const b64 = config.token.split('.')[1];
      const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
      this.churchId = payload.churchId || null;
    } catch {
      try {
        const b64 = config.token.split('.')[1];
        const payload = JSON.parse(Buffer.from(b64, 'base64').toString());
        this.churchId = payload.churchId || null;
      } catch {
        this.churchId = null;
      }
    }
    // Convert ws(s):// relay URL to http(s):// for REST calls
    this.relayHttpBase = config.relay
      ? config.relay.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://')
      : null;
    this.obs = null;
    this.companion = null;
    this.videoHubs = [];
    this.proPresenter = null;
    this.resolume = null;
    this.vmix = null;
    this.mixer = null;
    this.fakeAtemApi = null;
    this._stopping = false;
    this._fakeAtemMode = false;
    this._fakeObsMode = false;
    this._fakeMixerMode = false;
    this._fakeProPresenterMode = false;
    this.audioMonitor = new AudioMonitor();
    this.streamHealthMonitor = new StreamHealthMonitor();
    this.reconnectDelay = 3000;
    this.atemReconnectDelay = 2000;
    this.atemReconnecting = false;
    this._previewTimer = null;
    this._previewSource = config.previewSource || '';
    this.status = {
      atem: { connected: false, ip: null, programInput: null, previewInput: null, recording: false, audioDelays: {} },
      obs: { connected: false, streaming: false, recording: false, bitrate: null, fps: null },
      encoder: { connected: false, live: false, bitrateKbps: null, congestion: null, fps: null, cpuUsage: null },
      companion: { connected: false, connectionCount: 0, connections: [] },
      videoHubs: [],
      proPresenter: { connected: false, running: false, currentSlide: null, slideIndex: null, slideTotal: null },
      resolume: { connected: false, host: null, port: null },
      vmix: { connected: false, streaming: false, recording: false },
      mixer: { connected: false, type: null, mainMuted: false },
      audio: { monitoring: false, lastLevel: null, silenceDetected: false },
      system: { hostname: os.hostname(), platform: os.platform(), uptime: 0, name: config.name || null },
    };
  }

  async start() {
    console.log('\n🎥 Tally starting...');
    if (this.config.name) console.log(`   Name: ${this.config.name}`);
    console.log(`   Relay: ${this.config.relay}`);
    if (this.mockProduction) console.log('   Mode: Mock Production Lab');

    await this.connectRelay();
    await this.connectATEM();
    await this.connectOBS();
    this.audioMonitor.start(this);
    this.streamHealthMonitor.start(this);
    await this.connectCompanion();
    await this.connectVideoHubs();
    await this.connectProPresenter();
    await this.connectResolume();
    await this.connectVMix();
    await this.connectMixer();
    await this.startMockControlApi();

    setInterval(() => this.sendStatus(), 10_000);
    setInterval(() => { this.status.system.uptime = Math.floor(process.uptime()); }, 10_000);

    // Watchdog
    this.watchdogActive = this.config.watchdog !== false;
    this._lastAlerts = new Map(); // alertType → timestamp (dedup)
    if (this.watchdogActive) {
      console.log('🐕 Watchdog enabled (30s interval)');
      setInterval(() => this.watchdogTick(), 30_000);
    }

    console.log('\n✅ Tally running. Press Ctrl+C to stop.\n');
  }

  async watchdogTick() {
    if (!this.watchdogActive) return;
    const issues = [];

    // FPS check
    if (this.status.obs.streaming && this.status.obs.fps && this.status.obs.fps < 24) {
      issues.push('fps_low');
      this._sendWatchdogAlert('fps_low', `Low FPS: ${this.status.obs.fps}`);
    }

    // Bitrate check
    if (this.status.obs.streaming && this.status.obs.bitrate && this.status.obs.bitrate < 1000) {
      issues.push('bitrate_low');
      this._sendWatchdogAlert('bitrate_low', `Low bitrate: ${this.status.obs.bitrate}kbps`);
    }

    // ATEM disconnected
    if (this.config.atemIp && !this.status.atem.connected) {
      issues.push('atem_disconnected');
      this._sendWatchdogAlert('atem_disconnected', 'ATEM switcher disconnected');
    }

    // OBS disconnected
    if (!this.status.obs.connected) {
      issues.push('obs_disconnected');
      this._sendWatchdogAlert('obs_disconnected', 'OBS disconnected');
    }

    // Multiple systems down
    if (issues.length >= 3) {
      this._sendWatchdogAlert('multiple_systems_down', `${issues.length} issues: ${issues.join(', ')}`);
    }

    // Update audio monitor status in status object
    if (this.audioMonitor) {
      const audioStatus = this.audioMonitor.getStatus();
      this.status.audio = {
        monitoring: audioStatus.monitoring,
        silenceDetected: audioStatus.silenceDetected,
        silenceDurationSec: audioStatus.silenceDurationSec,
      };
    }

    // Update stream health monitor status
    if (this.streamHealthMonitor) {
      const shStatus = this.streamHealthMonitor.getStatus();
      this.status.streamHealth = {
        monitoring: shStatus.monitoring,
        baselineBitrate: shStatus.baselineBitrate,
        recentBitrate: shStatus.recentBitrate,
      };
    }
  }

  _sendWatchdogAlert(alertType, message) {
    const now = Date.now();
    const lastSent = this._lastAlerts.get(alertType) || 0;
    // Dedup: don't re-alert same type within 5 minutes
    if (now - lastSent < 5 * 60 * 1000) return;
    this._lastAlerts.set(alertType, now);
    console.log(`[Watchdog] ⚠️ ${message}`);
    this.sendToRelay({ type: 'alert', alertType, message, severity: 'warning' });
  }

  // ─── RELAY CONNECTION ──────────────────────────────────────────────────────

  connectRelay() {
    return new Promise((resolve) => {
      const url = `${this.config.relay}/church?token=${this.config.token}`;
      console.log(`\n📡 Connecting to relay...`);

      // Terminate any stale socket (CONNECTING=0 or OPEN=1) before creating a new one
      if (this.relay && (this.relay.readyState === 0 || this.relay.readyState === 1)) {
        try { this.relay.terminate(); } catch { /* ignore */ }
      }

      this.relay = new WebSocket(url);
      let resolved = false;
      const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };

      this.relay.on('open', () => {
        console.log('✅ Connected to relay server');
        this.reconnectDelay = 3000;
        this.sendStatus();
        doResolve();
      });

      this.relay.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleRelayMessage(msg);
        } catch (e) {
          console.error('Relay message parse error:', e.message);
        }
      });

      this.relay.on('close', (code, reason) => {
        console.warn(`⚠️  Relay disconnected (${code}: ${reason}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
        doResolve(); // Don't block startup if relay is down
        setTimeout(() => this.connectRelay(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
      });

      this.relay.on('error', (err) => {
        console.error('Relay error:', err.message);
        doResolve(); // Don't block startup on error
      });

      setTimeout(doResolve, 5000);
    });
  }

  handleRelayMessage(msg) {
    switch (msg.type) {
      case 'connected':
        console.log(`🟢 Relay confirmed: ${msg.name}`);
        break;
      case 'command':
        console.log(`📨 Command received: ${msg.command}`, msg.params || '');
        this.executeCommand(msg);
        break;
      case 'pong':
        break;
      default:
        console.log('Relay msg:', msg.type);
    }
  }

  async executeCommand(msg) {
    const { command, params = {}, id } = msg;
    let result = null;
    let error = null;

    try {
      const handler = commandHandlers[command];
      if (handler) {
        result = await handler(this, params);
      } else {
        error = `Unknown command: ${command}`;
      }
    } catch (e) {
      error = e.message;
      console.error(`Command error (${command}):`, e.message);
    }

    this.sendToRelay({ type: 'command_result', id, command, result, error });
    if (result && !error) console.log(`✅ ${typeof result === 'string' ? result : JSON.stringify(result)}`);
    if (error) console.error(`❌ ${error}`);
  }

  // ─── ATEM CONNECTION (with exponential backoff reconnect) ─────────────────

  async connectATEM() {
    const atemIp = this.config.atemIp;
    const fakeMode = this.mockProduction || isFakeAtemMode(atemIp);
    this._fakeAtemMode = fakeMode;
    this.atem = fakeMode ? new FakeAtem() : new Atem();

    this.atem.on('connected', () => {
      const label = fakeMode ? 'ATEM simulator' : 'ATEM';
      console.log(`✅ ${label} connected${atemIp ? ` (${atemIp})` : ''}`);
      this.status.atem.connected = true;
      this.status.atem.ip = fakeMode ? (atemIp || 'mock') : atemIp;
      this.atemReconnectDelay = 2000;
      this.atemReconnecting = false;
      this.sendStatus();
      this.sendAlert(fakeMode ? 'ATEM simulator connected' : 'ATEM connected', 'info');
    });

    this.atem.on('disconnected', () => {
      if (this._stopping) return;
      console.warn(`⚠️  ${fakeMode ? 'ATEM simulator' : 'ATEM'} disconnected`);
      this.status.atem.connected = false;
      this.sendStatus();
      this.sendAlert(fakeMode ? 'ATEM simulator disconnected' : 'ATEM disconnected', 'warning');
      this.reconnectATEM();
    });

    this.atem.on('stateChanged', (state, pathToChange) => {
      if (!state) return;

      const me = state.video?.mixEffects?.[0];
      if (me) {
        this.status.atem.programInput = me.programInput;
        this.status.atem.previewInput = me.previewInput;
        this.status.atem.inTransition = me.transitionPosition?.inTransition || false;
      }

      const recording = state.recording;
      if (recording !== undefined) {
        const wasRecording = this.status.atem.recording;
        this.status.atem.recording = recording?.status === 'Recording';
        if (wasRecording !== this.status.atem.recording) {
          this.sendAlert(`ATEM recording ${this.status.atem.recording ? 'STARTED' : 'STOPPED'}`, 'info');
        }
      }

      // ── Audio delay readout ──────────────────────────────────────────────
      // Read per-input audio delays (Classic audio model: state.audio.classic.channels,
      // Fairlight model: state.audio.fairlight.inputs — both use optional chaining).
      // Delay values are in frames on Classic, microseconds on Fairlight; we expose
      // the raw value and label the source so the UI can display it appropriately.
      try {
        const audioDelays = {};
        // Classic audio (ATEM Mini/Pro/2 M/E etc.)
        const classic = state.audio?.classic?.channels || state.audio?.channels;
        if (classic && typeof classic === 'object') {
          for (const [inputId, channel] of Object.entries(classic)) {
            const delay = channel?.delay ?? channel?.sourceDelay ?? 0;
            if (delay !== 0) audioDelays[inputId] = delay;
          }
        }
        // Fairlight audio (ATEM Constellation etc.)
        const fairlight = state.audio?.fairlight?.inputs;
        if (fairlight && typeof fairlight === 'object') {
          for (const [inputId, input] of Object.entries(fairlight)) {
            const delay = input?.delay ?? 0;
            if (delay !== 0) audioDelays[inputId] = delay;
          }
        }
        this.status.atem.audioDelays = audioDelays;
      } catch { /* ignore — audio delay is non-critical */ }

      this.sendStatus();
    });

    if (atemIp || fakeMode) {
      if (fakeMode) {
        console.log('📹 Starting fake ATEM simulator...');
      } else {
        console.log(`📹 Connecting to ATEM at ${atemIp}...`);
      }
      try {
        if (fakeMode) await this.atem.connect();
        else await this.atem.connect(atemIp);
      } catch (e) {
        console.warn(`⚠️  ${fakeMode ? 'ATEM simulator' : 'ATEM'} connection failed: ${e.message}`);
        this.reconnectATEM();
      }
    } else {
      console.log('📹 ATEM IP not configured — skipping (set with --atem <ip>)');
    }
  }

  reconnectATEM() {
    if (this._stopping || this.atemReconnecting || (!this.config.atemIp && !this.mockProduction)) return;
    this.atemReconnecting = true;
    console.log(`   Reconnecting ATEM in ${this.atemReconnectDelay / 1000}s...`);
    setTimeout(async () => {
      this.atemReconnecting = false;
      try {
        if (this.mockProduction || isFakeAtemMode(this.config.atemIp)) await this.atem.connect();
        else await this.atem.connect(this.config.atemIp);
      } catch (e) {
        console.warn(`⚠️  ATEM reconnect failed: ${e.message}`);
        this.atemReconnectDelay = Math.min(this.atemReconnectDelay * 2, 60_000);
        this.reconnectATEM();
      }
    }, this.atemReconnectDelay);
  }

  async atemCommand(fn) {
    if (!this.atem || !this.status.atem.connected) throw new Error('ATEM not connected');
    return fn();
  }

  async stop() {
    this._stopping = true;
    try {
      if (this.fakeAtemApi) {
        await this.fakeAtemApi.stop();
        this.fakeAtemApi = null;
      }
    } catch {}

    try {
      if (this.obs && typeof this.obs.disconnect === 'function') {
        await this.obs.disconnect();
      }
      if (this.proPresenter && typeof this.proPresenter.disconnect === 'function') {
        this.proPresenter.disconnect();
      }
      if (this.mixer && typeof this.mixer.disconnect === 'function') {
        await this.mixer.disconnect();
      }
      if (this.atem && typeof this.atem.disconnect === 'function') {
        await this.atem.disconnect();
      }
      if (this.atem && typeof this.atem.destroy === 'function') {
        this.atem.destroy();
      }
    } catch {}
  }

  // ─── OBS CONNECTION ───────────────────────────────────────────────────────

  async connectOBS() {
    if (!this._obsReconnectDelay) this._obsReconnectDelay = 5000;
    const obsUrl = this.config.obsUrl || 'ws://localhost:4455';
    const fakeMode = this.mockProduction || isFakeObsMode(obsUrl);
    this._fakeObsMode = fakeMode;

    // Create OBS instance and attach event listeners ONCE.
    // On reconnect we reuse the same instance — just call connect() again.
    if (!this.obs) {
      this.obs = fakeMode ? new FakeOBS() : new OBSWebSocket();

      this.obs.on('ConnectionOpened', () => {
        console.log('✅ OBS connected');
        this.status.obs.connected = true;
        this.status.encoder.connected = true;
        this._obsReconnectDelay = 5000; // reset backoff on success
        this.sendStatus();
      });

      this.obs.on('ConnectionClosed', () => {
        if (this._stopping) return;
        console.warn(`⚠️  OBS disconnected. Retrying in ${this._obsReconnectDelay / 1000}s...`);
        this.status.obs.connected = false;
        this.status.encoder.connected = false;
        this.sendStatus();
        const delay = this._obsReconnectDelay;
        this._obsReconnectDelay = Math.min(this._obsReconnectDelay * 2, 60_000);
        setTimeout(() => this.connectOBS(), delay);
      });

      this.obs.on('StreamStateChanged', ({ outputActive }) => {
        const wasStreaming = this.status.obs.streaming;
        this.status.obs.streaming = outputActive;
        this.status.encoder.live = !!outputActive;
        if (wasStreaming !== outputActive) {
          this.sendAlert(`Stream ${outputActive ? 'STARTED' : 'STOPPED'}`, 'info');
          this.sendStatus();
        }
      });

      this.obs.on('RecordStateChanged', ({ outputActive }) => {
        this.status.obs.recording = outputActive;
        this.sendStatus();
      });

      // Stats poll — registered ONCE, checks connected flag before each call
      if (!this._obsStatsPollStarted) {
        this._obsStatsPollStarted = true;
        setInterval(async () => {
          if (!this.status.obs.connected) return;
          try {
            const stats = await this.obs.call('GetStats');
            this.status.obs.fps = Math.round(stats.activeFps || 0);
            this.status.obs.cpuUsage = Math.round(stats.cpuUsage || 0);
            this.status.encoder.fps = this.status.obs.fps;
            this.status.encoder.cpuUsage = this.status.obs.cpuUsage;
            this.status.encoder.congestion = typeof stats.outputCongestion === 'number'
              ? Number(stats.outputCongestion.toFixed(2))
              : null;

            const streamStatus = await this.obs.call('GetStreamStatus');
            this.status.obs.streaming = streamStatus.outputActive;
            this.status.obs.bitrate = streamStatus.outputBytes
              ? Math.round((streamStatus.outputBytes / 1024 / 15))
              : null;
            this.status.encoder.bitrateKbps = this.status.obs.bitrate;
            this.status.encoder.live = !!streamStatus.outputActive;

            if (this.status.obs.fps < 24 && this.status.obs.streaming) {
              this.sendAlert(`⚠️ Low stream FPS: ${this.status.obs.fps}fps`, 'warning');
            }
          } catch { /* ignore poll errors */ }
        }, 15_000);
      }
    }

    try {
      console.log(`🎬 Connecting to ${fakeMode ? 'mock OBS' : 'OBS'} at ${obsUrl}...`);
      await this.obs.connect(obsUrl, this.config.obsPassword);
    } catch (e) {
      console.warn('⚠️  OBS not available:', e.message);
      console.log('   (OBS optional — ATEM monitoring still works)');
    }
  }

  // ─── COMPANION CONNECTION ────────────────────────────────────────────────

  async connectCompanion() {
    const url = this.config.companionUrl || 'http://localhost:8888';
    console.log(`🎛️  Checking Companion at ${url}...`);
    this.companion = new CompanionBridge({ companionUrl: url });

    const available = await this.companion.isAvailable();
    if (available) {
      console.log('✅ Companion connected');
      this.status.companion.connected = true;
      try {
        const conns = await this.companion.getConnections();
        this.status.companion.connectionCount = conns.length;
        this.status.companion.connections = conns.map(c => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status }));
        console.log(`   ${conns.length} Companion connections found`);
      } catch { /* ignore */ }
      this.companion.startPolling();
    } else {
      console.log('⚠️  Companion not available (optional)');
    }

    // Periodically refresh companion status
    setInterval(async () => {
      try {
        const avail = await this.companion.isAvailable();
        this.status.companion.connected = avail;
        if (avail) {
          const conns = await this.companion.getConnections();
          this.status.companion.connectionCount = conns.length;
          this.status.companion.connections = conns.map(c => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status }));
        }
      } catch { /* ignore */ }
    }, 30_000);
  }

  // ─── PREVIEW SCREENSHOTS ────────────────────────────────────────────────

  async capturePreviewFrame() {
    if (!this.obs || !this.status.obs.connected) return null;
    try {
      const params = {
        imageFormat: 'jpg',
        imageWidth: 720,
        imageHeight: 405,
        imageCompressionQuality: 55,
      };
      // Use specific source or default to current program scene
      if (this._previewSource) {
        params.sourceName = this._previewSource;
        const resp = await this.obs.call('GetSourceScreenshot', params);
        return { data: resp.imageData.replace(/^data:image\/jpeg;base64,/, ''), width: 720, height: 405 };
      } else {
        // Get current program scene name
        const scene = await this.obs.call('GetCurrentProgramScene');
        params.sourceName = scene.currentProgramSceneName;
        const resp = await this.obs.call('GetSourceScreenshot', params);
        return { data: resp.imageData.replace(/^data:image\/jpeg;base64,/, ''), width: 720, height: 405 };
      }
    } catch (e) {
      console.error('Preview capture error:', e.message);
      return null;
    }
  }

  startPreview(intervalMs = 5000) {
    this.stopPreview();
    console.log(`📸 Preview started (every ${intervalMs}ms)`);
    this.status.previewActive = true;
    this._previewTimer = setInterval(async () => {
      const frame = await this.capturePreviewFrame();
      if (frame) {
        // Safety: skip if frame > 150KB base64
        if (frame.data.length > 150_000) {
          console.warn('Preview frame too large, skipping');
          return;
        }
        this.sendToRelay({
          type: 'preview_frame',
          timestamp: new Date().toISOString(),
          width: frame.width,
          height: frame.height,
          format: 'jpeg',
          data: frame.data,
        });
      }
    }, intervalMs);
  }

  stopPreview() {
    if (this._previewTimer) {
      clearInterval(this._previewTimer);
      this._previewTimer = null;
      this.status.previewActive = false;
      console.log('📸 Preview stopped');
    }
  }

  // ─── VIDEO HUB CONNECTION ─────────────────────────────────────────────────

  async connectVideoHubs() {
    const hubs = this.config.videoHubs || [];
    if (hubs.length === 0) {
      console.log('📺 No Video Hubs configured (set via config)');
      return;
    }

    for (const hubConfig of hubs) {
      const hub = new VideoHub({ ip: hubConfig.ip, name: hubConfig.name });
      hub.on('connected', () => {
        this._updateVideoHubStatus();
        this.sendStatus();
      });
      hub.on('disconnected', () => {
        this._updateVideoHubStatus();
        this.sendStatus();
      });
      hub.on('routeChanged', (info) => {
        console.log(`📺 Route changed: ${info.inputLabel} → ${info.outputLabel}`);
        this.sendStatus();
      });
      this.videoHubs.push(hub);
      console.log(`📺 Connecting to Video Hub "${hubConfig.name}" at ${hubConfig.ip}...`);
      await hub.connect();
    }
    this._updateVideoHubStatus();
  }

  _updateVideoHubStatus() {
    this.status.videoHubs = this.videoHubs.map(h => h.toStatus());
  }

  // ─── PROPRESENTER CONNECTION ────────────────────────────────────────────

  async connectProPresenter() {
    const ppConfig = this.config.proPresenter || {};
    const fakeMode = this.mockProduction || isFakeHostMode(ppConfig.host);
    this._fakeProPresenterMode = fakeMode;
    if (!fakeMode && !ppConfig.host && ppConfig.host !== 'localhost') {
      console.log('⛪ ProPresenter not configured (set via Equipment tab)');
      return;
    }

    console.log(`⛪ Connecting to ${fakeMode ? 'mock ProPresenter' : 'ProPresenter'} at ${ppConfig.host || 'mock'}:${ppConfig.port || 1025}...`);
    this.proPresenter = fakeMode
      ? new FakeProPresenter()
      : new ProPresenter({ host: ppConfig.host, port: ppConfig.port || 1025 });

    this.proPresenter.on('connected', () => {
      this.status.proPresenter.connected = true;
      this.sendStatus();
    });

    this.proPresenter.on('disconnected', () => {
      this.status.proPresenter.connected = false;
      this.sendStatus();
    });

    this.proPresenter.on('slideChanged', () => {
      this._updateProPresenterStatus();
    });

    await this.proPresenter.connect();
    await this._updateProPresenterStatus();

    // Periodically refresh ProPresenter status
    setInterval(() => this._updateProPresenterStatus(), 30_000);
  }

  async _updateProPresenterStatus() {
    if (!this.proPresenter) return;
    try {
      const running = await this.proPresenter.isRunning();
      this.status.proPresenter.running = running;
      if (running) {
        const slide = await this.proPresenter.getCurrentSlide();
        if (slide) {
          this.status.proPresenter.currentSlide = slide.presentationName;
          this.status.proPresenter.slideIndex = slide.slideIndex;
          this.status.proPresenter.slideTotal = slide.slideTotal;
        }
      }
      this.status.proPresenter.connected = this.proPresenter.connected;
    } catch { /* ignore */ }
  }

  // ─── RESOLUME CONNECTION ──────────────────────────────────────────────────

  async connectResolume() {
    const cfg = this.config.resolume;
    if (!cfg || !cfg.host) {
      console.log('🎞️  Resolume not configured (set via Equipment tab)');
      return;
    }

    console.log(`🎞️  Connecting to Resolume Arena at ${cfg.host}:${cfg.port || 8080}...`);
    this.resolume = new Resolume({ host: cfg.host, port: cfg.port || 8080 });

    const running = await this.resolume.isRunning();
    if (running) {
      const version = await this.resolume.getVersion();
      console.log(`✅ Resolume Arena connected (${version})`);
      this.status.resolume = { connected: true, host: cfg.host, port: cfg.port || 8080 };
    } else {
      console.log('⚠️  Resolume Arena not reachable (will skip — optional device)');
      this.status.resolume = { connected: false, host: cfg.host, port: cfg.port || 8080 };
    }

    // Periodically refresh Resolume status
    setInterval(async () => {
      if (!this.resolume) return;
      try {
        const running = await this.resolume.isRunning();
        const wasConnected = this.status.resolume.connected;
        this.status.resolume.connected = running;
        if (wasConnected !== running) {
          this.sendAlert(running ? 'Resolume Arena reconnected' : 'Resolume Arena disconnected', running ? 'info' : 'warning');
          this.sendStatus();
        }
      } catch { /* ignore */ }
    }, 30_000);
  }

  // ─── VMIX CONNECTION ──────────────────────────────────────────────────────

  async connectVMix() {
    const cfg = this.config.vmix;
    if (!cfg || !cfg.host) {
      console.log('🎬 vMix not configured (set via Equipment tab — Windows only)');
      return;
    }

    console.log(`🎬 Connecting to vMix at ${cfg.host}:${cfg.port || 8088}...`);
    this.vmix = new VMix({ host: cfg.host, port: cfg.port || 8088 });

    const running = await this.vmix.isRunning();
    if (running) {
      const status = await this.vmix.getStatus();
      console.log(`✅ vMix connected (${status.edition} ${status.version}) — Streaming: ${status.streaming}, Recording: ${status.recording}`);
      this.status.vmix = { connected: true, streaming: status.streaming, recording: status.recording };
    } else {
      console.log('⚠️  vMix not reachable (will retry on watchdog tick — optional device)');
      this.status.vmix = { connected: false, streaming: false, recording: false };
    }

    // Poll vMix status every 30s
    setInterval(async () => {
      if (!this.vmix) return;
      try {
        const status = await this.vmix.getStatus();
        const wasStreaming = this.status.vmix.streaming;
        const wasRecording = this.status.vmix.recording;
        this.status.vmix = { connected: status.running, streaming: status.streaming || false, recording: status.recording || false };

        if (wasStreaming && !status.streaming) {
          this.sendAlert('🔴 vMix stream stopped unexpectedly', 'critical');
        }
        if (wasRecording && !status.recording) {
          this.sendAlert('⚠️ vMix recording stopped', 'warning');
        }
        if (!wasStreaming && status.streaming) {
          this.sendAlert('✅ vMix streaming started', 'info');
        }
        this.sendStatus();
      } catch { /* ignore */ }
    }, 30_000);
  }

  // ─── MIXER CONNECTION ─────────────────────────────────────────────────────

  async connectMixer() {
    const cfg = this.config.mixer;
    const fakeMode = this.mockProduction || isFakeHostMode(cfg?.host);
    this._fakeMixerMode = fakeMode;
    if (!fakeMode && (!cfg || !cfg.host)) {
      console.log('🎛️  Audio console not configured (set via Equipment tab)');
      return;
    }

    const mixerConfig = cfg || { type: 'x32', host: 'mock', port: 10023 };
    console.log(`🎛️  Connecting to ${fakeMode ? 'mock' : mixerConfig.type} console at ${mixerConfig.host}:${mixerConfig.port || 'default'}...`);
    this.mixer = fakeMode ? new FakeMixerBridge(mixerConfig) : new MixerBridge(mixerConfig);
    await this.mixer.connect();

    const online = await this.mixer.isOnline();
    if (online) {
      const status = await this.mixer.getStatus();
      this.status.mixer = { connected: true, type: mixerConfig.type, mainMuted: status.mainMuted };
      console.log(`✅ ${fakeMode ? 'mock' : mixerConfig.type} console connected`);
      if (status.mainMuted) this.sendAlert('⚠️ WARNING: Audio console master is MUTED', 'warning');
    } else {
      console.log(`⚠️  ${mixerConfig.type} console not reachable (will retry on poll)`);
      this.status.mixer = { connected: false, type: mixerConfig.type, mainMuted: false };
    }

    // Poll every 30s — alert if master gets muted during service
    setInterval(async () => {
      if (!this.mixer) return;
      try {
        const status = await this.mixer.getStatus();
        const wasMuted = this.status.mixer.mainMuted;
        this.status.mixer = { connected: status.online, type: mixerConfig.type, mainMuted: status.mainMuted };
        if (!wasMuted && status.mainMuted) this.sendAlert('🔇 AUDIO: Master output was MUTED on console', 'critical');
        if (wasMuted && !status.mainMuted) this.sendAlert('✅ Audio master unmuted', 'info');
        this.sendStatus();
      } catch { /* ignore poll errors */ }
    }, 30_000);
  }

  async startMockControlApi() {
    const anyMock = this._fakeAtemMode || this._fakeObsMode || this._fakeMixerMode || this._fakeProPresenterMode || this.mockProduction;
    if (!anyMock) return;

    const apiPort = Number(this.config.fakeAtemApiPort || process.env.TALLY_FAKE_ATEM_API_PORT || 9911);
    if (!this.fakeAtemApi) {
      this.fakeAtemApi = new FakeAtemApiServer({
        fakeAtem: this._fakeAtemMode ? this.atem : null,
        fakeObs: this._fakeObsMode ? this.obs : null,
        fakeMixer: this._fakeMixerMode ? this.mixer : null,
        fakeProPresenter: this._fakeProPresenterMode ? this.proPresenter : null,
        port: apiPort,
      });
      try {
        const baseUrl = await this.fakeAtemApi.start();
        console.log(`🧪 Mock Production Lab: ${baseUrl}`);
      } catch (e) {
        console.warn(`⚠️  Mock control API failed to start: ${e.message}`);
      }
      return;
    }

    this.fakeAtemApi.setMocks({
      fakeAtem: this._fakeAtemMode ? this.atem : null,
      fakeObs: this._fakeObsMode ? this.obs : null,
      fakeMixer: this._fakeMixerMode ? this.mixer : null,
      fakeProPresenter: this._fakeProPresenterMode ? this.proPresenter : null,
    });
  }

  // ─── HELPERS ──────────────────────────────────────────────────────────────

  sendToRelay(msg) {
    if (this.relay?.readyState === WebSocket.OPEN) {
      this.relay.send(JSON.stringify(msg));
    }
  }

  sendStatus() {
    // Debounce rapid status sends (e.g. multiple device events within 100ms)
    if (this._statusDebounce) return;
    this._statusDebounce = true;
    // Send immediately on first call, then coalesce subsequent calls within 100ms
    this.sendToRelay({ type: 'status_update', status: this.status });
    setTimeout(() => {
      this._statusDebounce = false;
    }, 100);
  }

  sendAlert(message, severity = 'warning') {
    console.log(`[ALERT] ${message}`);
    this.sendToRelay({ type: 'alert', message, severity });
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const agent = new ChurchAVAgent(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    await agent.stop().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await agent.start();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
