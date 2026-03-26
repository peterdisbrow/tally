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
const { Atem, Enums } = require('atem-connection');
const OBSWebSocket = require('obs-websocket-js').default;
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { commandHandlers } = require('./commands');
const { CompanionBridge } = require('./companion');
const { VideoHub } = require('./videohub');
const { HyperDeck } = require('./hyperdeck');
const { EncoderBridge } = require('./encoderBridge');
const { ProPresenter } = require('./propresenter');
const { Resolume } = require('./resolume');
const { VMix } = require('./vmix');
const { AudioMonitor } = require('./audioMonitor');
const { StreamHealthMonitor } = require('./streamHealthMonitor');
const { encryptConfig, decryptConfig, findUnencryptedFields } = require('./secureStorage');
const { MixerBridge } = require('./mixerBridge');
const { PTZManager, normalizeProtocol } = require('./ptz');
const { getSystemHealth } = require('./systemHealth');
const { collectDiagnosticBundle } = require('./diagnosticBundle');

// ExternalPortType enum → human-readable label (used for audio source detection)
const PORT_TYPE_NAMES = { 1: 'SDI', 2: 'HDMI', 4: 'Component', 8: 'Composite',
  16: 'S-Video', 32: 'XLR', 64: 'AES/EBU', 128: 'RCA', 256: 'Internal',
  512: 'TS Jack', 1024: 'MADI', 2048: 'TRS Jack', 4096: 'RJ45' };

// ─── CLI CONFIG ───────────────────────────────────────────────────────────────

program
  .name('tally-connect')
  .description('Connect your church AV system to ATEM School remote monitoring');

program
  .option('-t, --token <token>', 'Your church connection token (from ATEM School)')
  .option('-r, --relay <url>', 'Relay server URL', 'wss://api.tallyconnect.app')
  .option('-a, --atem <ip>', 'ATEM switcher IP address')
  .option('-o, --obs <url>', 'OBS WebSocket URL')
  .option('-p, --obs-password <password>', 'OBS WebSocket password')
  .option('-n, --name <name>', 'Label for this system (e.g., "Main Sanctuary")')
  .option('-c, --companion <url>', 'Companion HTTP API URL')
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
const LEGACY_DEFAULT_OBS_URLS = new Set(['ws://localhost:4455', 'ws://127.0.0.1:4455']);

const ATEM_MODEL_LABELS = {
  Unknown: 'ATEM',
  TVS: 'ATEM Television Studio',
  OneME: 'ATEM 1 M/E Production Studio',
  TwoME: 'ATEM 2 M/E Production Studio',
  PS4K: 'ATEM Production Studio 4K',
  OneME4K: 'ATEM 1 M/E Production Studio 4K',
  TwoME4K: 'ATEM 2 M/E Production Studio 4K',
  TwoMEBS4K: 'ATEM 2 M/E Broadcast Studio 4K',
  TVSHD: 'ATEM Television Studio HD',
  TVSProHD: 'ATEM Television Studio Pro HD',
  TVSPro4K: 'ATEM Television Studio Pro 4K',
  Constellation: 'ATEM Constellation',
  Constellation8K: 'ATEM Constellation 8K',
  Mini: 'ATEM Mini',
  MiniPro: 'ATEM Mini Pro',
  MiniProISO: 'ATEM Mini Pro ISO',
  MiniExtreme: 'ATEM Mini Extreme',
  MiniExtremeISO: 'ATEM Mini Extreme ISO',
  ConstellationHD1ME: 'ATEM 1 M/E Constellation HD',
  ConstellationHD2ME: 'ATEM 2 M/E Constellation HD',
  ConstellationHD4ME: 'ATEM 4 M/E Constellation HD',
  SDI: 'ATEM SDI',
  SDIProISO: 'ATEM SDI Pro ISO',
  SDIExtremeISO: 'ATEM SDI Extreme ISO',
  TelevisionStudioHD8: 'ATEM Television Studio HD8',
  TelevisionStudioHD8ISO: 'ATEM Television Studio HD8 ISO',
  Constellation4K1ME: 'ATEM 1 M/E Constellation 4K',
  Constellation4K2ME: 'ATEM 2 M/E Constellation 4K',
  Constellation4K4ME: 'ATEM 4 M/E Constellation 4K',
  Constellation4K4MEPlus: 'ATEM 4 M/E Constellation 4K Plus',
  TelevisionStudio4K8: 'ATEM Television Studio 4K8',
  MiniExtremeISOG2: 'ATEM Mini Extreme ISO G2',
};

const ATEM_MODEL_ENUM = (Enums && Enums.Model) || {};

function prettifyAtemModelEnumName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  if (ATEM_MODEL_LABELS[rawName]) return ATEM_MODEL_LABELS[rawName];

  return rawName
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2')
    .replace(/\bTVS\b/g, 'Television Studio')
    .replace(/\bME\b/g, 'M/E')
    .trim();
}

function extractAtemIdentity(state) {
  const info = state && typeof state.info === 'object' ? state.info : {};
  const productIdentifier = typeof info.productIdentifier === 'string' ? info.productIdentifier.trim() : '';

  const parsedModelCode = Number(info.model);
  const modelCode = Number.isFinite(parsedModelCode) ? parsedModelCode : null;

  const modelEnumName = modelCode !== null ? ATEM_MODEL_ENUM[modelCode] : null;
  const modelName = productIdentifier || prettifyAtemModelEnumName(modelEnumName);

  // Protocol version serves as a proxy for firmware revision
  const apiVer = info.apiVersion;
  const protocolVersion = apiVer && typeof apiVer === 'object'
    ? `${apiVer.major || 0}.${apiVer.minor || 0}` : null;

  return {
    modelName: modelName || null,
    modelCode,
    productIdentifier: productIdentifier || null,
    protocolVersion,
  };
}

function isMockValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate' || v.startsWith('mock://') || v.includes('mock-hyperdeck');
}

function stripMockConfig(config = {}) {
  const cleaned = { ...(config || {}) };
  if (isMockValue(cleaned.atemIp)) cleaned.atemIp = '';
  if (isMockValue(cleaned.obsUrl)) {
    cleaned.obsUrl = '';
    cleaned.obsPassword = '';
  }
  if (cleaned.proPresenter && isMockValue(cleaned.proPresenter.host)) cleaned.proPresenter = null;
  if (cleaned.mixer && isMockValue(cleaned.mixer.host)) cleaned.mixer = null;
  if (Array.isArray(cleaned.hyperdecks)) {
    cleaned.hyperdecks = cleaned.hyperdecks.filter((entry) => {
      if (typeof entry === 'string') return !isMockValue(entry);
      const host = String(entry?.host || entry?.ip || '').trim();
      return !!host && !isMockValue(host);
    });
  }
  delete cleaned.mockProduction;
  delete cleaned.fakeAtemApiPort;
  delete cleaned._preMock;
  return cleaned;
}

function loadConfig() {
  const configPath = opts.config;
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = stripMockConfig(decryptConfig(raw)); // decrypt sensitive fields on load
    }
    catch { config = {}; }
  }

  if (opts.token || process.env.TALLY_TOKEN) config.token = opts.token || process.env.TALLY_TOKEN;
  if (opts.relay) config.relay = opts.relay;
  if (opts.atem) config.atemIp = opts.atem;
  if (opts.obs !== undefined) config.obsUrl = opts.obs;
  if (opts.obsPassword || process.env.TALLY_OBS_PASSWORD) config.obsPassword = opts.obsPassword || process.env.TALLY_OBS_PASSWORD;
  if (opts.name) config.name = opts.name;
  if (opts.companion !== undefined) config.companionUrl = opts.companion;
  if (opts.previewSource) config.previewSource = opts.previewSource;
  if (opts.watchdog !== undefined) config.watchdog = opts.watchdog;

  // Preserve array fields from config file (hyperdecks, ptz)
  // These are set via the Equipment UI, not CLI args
  if (!config.hyperdecks) config.hyperdecks = [];
  if (!config.ptz) config.ptz = [];
  if (!config.videoHubs) config.videoHubs = [];
  if (!config.proPresenter) config.proPresenter = null;
  if (!config.resolume) config.resolume = null; // null = not configured
  if (!config.vmix) config.vmix = null; // null = not configured (Windows only)
  if (!config.mixer) config.mixer = null; // null = not configured

  // Backward compatibility: older Electron setup flows may persist flat
  // encoder fields instead of config.encoder object.
  if (!config.encoder && config.encoderType) {
    config.encoder = {
      type: String(config.encoderType || '').trim(),
      host: String(config.encoderHost || '').trim(),
      port: Number(config.encoderPort) || null,
      password: String(config.encoderPassword || ''),
      label: String(config.encoderLabel || ''),
      statusUrl: String(config.encoderStatusUrl || ''),
      source: String(config.encoderSource || ''),
    };
  } else if (config.encoder && !config.encoder.source && config.encoderSource) {
    config.encoder.source = String(config.encoderSource || '').trim();
  }

  // Legacy cleanup: older builds defaulted OBS to localhost even when not configured.
  // If encoder is not OBS, treat those legacy defaults as "not configured".
  const encoderType = String(config.encoder?.type || '').toLowerCase();
  const normalizedObs = String(config.obsUrl || '').trim().toLowerCase();
  if (encoderType !== 'obs' && LEGACY_DEFAULT_OBS_URLS.has(normalizedObs)) {
    config.obsUrl = '';
    config.obsPassword = '';
  }

  config = stripMockConfig(config);

  // Normalize PTZ entries to object form.
  if (Array.isArray(config.ptz)) {
    config.ptz = config.ptz.map((entry, i) => {
      if (typeof entry === 'string') {
        return { ip: entry, name: `PTZ ${i + 1}`, protocol: 'auto' };
      }
      const protocol = normalizeProtocol(entry?.protocol || 'auto');
      return {
        ip: String(entry?.ip || '').trim(),
        name: String(entry?.name || `PTZ ${i + 1}`),
        protocol,
        port: entry?.port ? Number(entry.port) : '',
        username: String(entry?.username || ''),
        password: String(entry?.password || ''),
        profileToken: String(entry?.profileToken || ''),
      };
    }).filter((cam) => cam.ip);
  }

  // Stream platform API keys (optional, for Feature 9)
  // Set in ~/.church-av/config.json: youtubeApiKey, facebookAccessToken, vimeoAccessToken
  if (!config.youtubeApiKey) config.youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  if (!config.facebookAccessToken) config.facebookAccessToken = process.env.FACEBOOK_ACCESS_TOKEN || '';
  if (!config.vimeoAccessToken) config.vimeoAccessToken = process.env.VIMEO_ACCESS_TOKEN || '';
  if (!config.youtubeApiKey) config.youtubeApiKey = '';
  if (!config.facebookAccessToken) config.facebookAccessToken = '';
  if (!config.vimeoAccessToken) config.vimeoAccessToken = '';

  if (!config.token) {
    console.error('\n❌ No connection token provided.');
    console.error('   Get your token from ATEM School, then run:');
    console.error('   tally-connect --token YOUR_TOKEN\n');
    process.exit(1);
  }

  fs.writeFileSync(configPath, JSON.stringify(encryptConfig(stripMockConfig(config)), null, 2));
  return config;
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

class ChurchAVAgent {
  constructor(config) {
    this.config = config;
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
    this.hyperdecks = [];
    this.proPresenter = null;
    this.resolume = null;
    this.vmix = null;
    this.mixer = null;
    this.ptzManager = null;
    this.encoderBridge = null;
    this._encoderManaged = false;  // true when EncoderBridge owns status.encoder
    this._stopping = false;
    this._fakeAtemMode = false;
    this.audioMonitor = new AudioMonitor();
    this.streamHealthMonitor = new StreamHealthMonitor();
    this._identityCache = new Map();
    this.reconnectDelay = 3000;
    this.atemReconnectDelay = 2000;
    this.atemReconnecting = false;
    this._previewTimer = null;
    this._previewSource = config.previewSource || '';
    this.status = {
      atem: {
        connected: false,
        ip: null,
        model: null,
        modelCode: null,
        productIdentifier: null,
        protocolVersion: null,
        programInput: null,
        previewInput: null,
        recording: false,
        streaming: false,
        streamingBitrate: null,
        streamingCacheUsed: null,
        streamingService: null,
        audioDelays: {},
        atemAudioSources: [],
        cameras: {}, // Blackmagic cameras detected via CCdP packets
      },
      audioViaAtem: false,
      audioViaAtemSource: 'none', // 'none' | 'auto' | 'manual'
      obs: {
        connected: false,
        app: null,
        version: null,
        websocketVersion: null,
        streaming: false,
        recording: false,
        bitrate: null,
        fps: null,
      },
      encoder: {
        connected: false,
        live: false,
        bitrateKbps: null,
        congestion: null,
        fps: null,
        cpuUsage: null,
        details: null,
      },
      companion: { connected: false, endpoint: null, connectionCount: 0, connections: [] },
      videoHubs: [],
      hyperdeck: { connected: false, recording: false, decks: [] },
      hyperdecks: [],
      proPresenter: {
        connected: false, running: false, version: null,
        currentSlide: null, presentationUUID: null, slideIndex: null, slideTotal: null, slideNotes: null,
        activeLook: null, timers: [], screens: null, playlistFocused: null,
        triggerMode: 'presentation', backup: null,
      },
      resolume: { connected: false, host: null, port: null, version: null },
      vmix: { connected: false, streaming: false, recording: false, edition: null, version: null },
      mixer: { connected: false, type: null, model: null, firmware: null, mainMuted: false },
      ptz: [],
      audio: { monitoring: false, lastLevel: null, silenceDetected: false },
      system: { hostname: os.hostname(), platform: os.platform(), uptime: 0, name: config.name || null, roomId: config.roomId || null, roomName: config.roomName || null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '' },
    };

    // Per-device health telemetry (latency, command success rate, reconnect count)
    this.health = {
      relay:        { latencyMs: null, reconnects: 0 },
      atem:         { latencyMs: null, commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      obs:          { latencyMs: null, commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      ptz:          { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      companion:    { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      proPresenter: { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      resolume:     { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      vmix:         { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      mixer:        { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      hyperdeck:    { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      encoder:      { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      camera:       { commandsTotal: 0, commandsOk: 0, commandsFailed: 0, reconnects: 0 },
      _startedAt: Date.now(),
    };

    // ── Signal failover bitrate tracking ──────────────────────────────────────
    this._bitrateBaseline = null;      // established kbps baseline for current stream
    this._bitrateSamples = [];         // rolling samples for baseline calculation
    this._bitrateInLoss = false;       // true = loss signal sent, waiting for recovery
    this._fastEncoderPoll = false;     // true = 3s poll instead of 15s

    // ── Recent alerts / commands for diagnostic bundles ─────────────────────────
    this._recentAlerts = [];           // last 50 alerts (for diagnostic bundle)
    this._recentCommands = [];         // last 20 commands sent/received
    this._lastAlerts = new Map();      // alertType → timestamp (dedup for watchdog)

    // ── Interval tracking for clean shutdown ───────────────────────────────────
    this._intervals = [];              // all setInterval IDs for unified cleanup
    this._relayConnecting = false;     // guard against overlapping connectRelay() calls
  }

  /** Track a setInterval ID for cleanup on stop(). Returns the ID. */
  _track(intervalId) {
    this._intervals.push(intervalId);
    return intervalId;
  }

  updateAtemIdentity(state) {
    const source = (state && typeof state === 'object') ? state : this.atem?.state;
    if (!source || typeof source !== 'object') return;

    const detected = extractAtemIdentity(source);
    const previousModel = this.status.atem.model;
    if (detected.modelName) this.status.atem.model = detected.modelName;
    if (detected.modelCode !== null) this.status.atem.modelCode = detected.modelCode;
    if (detected.productIdentifier) this.status.atem.productIdentifier = detected.productIdentifier;
    if (detected.protocolVersion) this.status.atem.protocolVersion = detected.protocolVersion;

    if (this.status.atem.model && this.status.atem.model !== previousModel) {
      console.log(`ATEM model detected: ${this.status.atem.model}`);
    }
  }

  /**
   * Extract and log ATEM input labels so Electron main.js can parse them.
   * Stores labels in status.atem.inputLabels as { inputId: "label", ... }
   */
  _logInputLabels(state) {
    if (!state || typeof state !== 'object') return;
    const inputs = state.inputs;
    if (!inputs || typeof inputs !== 'object') return;

    const labels = {};
    for (const [id, input] of Object.entries(inputs)) {
      if (input && input.longName) {
        labels[id] = input.longName;
      }
    }
    if (Object.keys(labels).length > 0) {
      this.status.atem.inputLabels = labels;
      console.log(`ATEM Labels: ${JSON.stringify(labels)}`);
    }
  }

  /**
   * Scan ATEM audio state for direct audio inputs (XLR, RCA, etc.) that are
   * actively mixed in.  Returns an array of detected sources; empty = none found.
   */
  detectAtemAudioSources(state) {
    const detected = [];
    if (!state || typeof state !== 'object') return detected;

    // ── Classic Audio (ATEM Mini / Pro / 2 M/E etc.) ──────────────────────
    // AudioSourceType.ExternalAudio = 2, AudioMixOption.Off = 0
    const classicChannels = state.audio?.classic?.channels || state.audio?.channels;
    if (classicChannels && typeof classicChannels === 'object') {
      for (const [channelId, ch] of Object.entries(classicChannels)) {
        if (!ch) continue;
        if (ch.sourceType === 2 && ch.mixOption !== 0) { // ExternalAudio & not Off
          detected.push({
            inputId: channelId,
            type: 'classic',
            sourceType: 'ExternalAudio',
            portType: PORT_TYPE_NAMES[ch.portType] || 'Unknown',
            mixOption: ch.mixOption === 1 ? 'On' : 'AFV',
          });
        }
      }
    }

    // ── Fairlight Audio (ATEM Constellation / newer 4K) ────────────────────
    // FairlightInputType.AudioIn = 2, FairlightAudioMixOption.Off = 1
    const fairlightInputs = state.fairlight?.inputs;
    if (fairlightInputs && typeof fairlightInputs === 'object') {
      for (const [inputId, input] of Object.entries(fairlightInputs)) {
        if (!input?.properties || input.properties.inputType !== 2) continue; // AudioIn
        const portName = PORT_TYPE_NAMES[input.properties.externalPortType] || 'Unknown';
        for (const [sourceId, src] of Object.entries(input.sources || {})) {
          if (!src?.properties || src.properties.mixOption === 1) continue; // skip Off
          detected.push({
            inputId,
            sourceId,
            type: 'fairlight',
            sourceType: 'AudioIn',
            portType: portName,
            mixOption: src.properties.mixOption === 2 ? 'On' : 'AFV',
          });
        }
      }
    }

    return detected;
  }

  /** Update status.audioViaAtem based on auto-detection + manual override. */
  _resolveAudioViaAtem() {
    const override = this.config.audioViaAtemOverride; // 'on' | 'off' | undefined
    if (override === 'on') {
      this.status.audioViaAtem = true;
      this.status.audioViaAtemSource = 'manual';
    } else if (override === 'off') {
      this.status.audioViaAtem = false;
      this.status.audioViaAtemSource = 'manual';
    } else {
      const autoDetected = (this.status.atem.atemAudioSources || []).length > 0;
      this.status.audioViaAtem = autoDetected;
      this.status.audioViaAtemSource = autoDetected ? 'auto' : 'none';
    }
  }

  logIdentity(key, prefix, value) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    const cacheKey = String(key || '').trim() || prefix;
    const previous = this._identityCache.get(cacheKey);
    if (previous === normalized) return;
    this._identityCache.set(cacheKey, normalized);
    console.log(`${prefix} ${normalized}`);
  }

  isObsMonitoringEnabled() {
    const encoderType = String(this.config.encoder?.type || '').trim().toLowerCase();
    if (encoderType === 'obs') return true;
    const obsUrl = String(this.config.obsUrl || '').trim();
    if (!obsUrl) return false;
    return !LEGACY_DEFAULT_OBS_URLS.has(obsUrl.toLowerCase());
  }

  getObsUrlForConnection() {
    const configuredUrl = String(this.config.obsUrl || '').trim();
    if (configuredUrl) return configuredUrl;

    // If OBS is selected as the encoder, derive the URL from encoder host/port.
    const encoderType = String(this.config.encoder?.type || '').trim().toLowerCase();
    if (encoderType === 'obs') {
      const host = String(this.config.encoder?.host || '').trim() || 'localhost';
      const port = Number(this.config.encoder?.port) || 4455;
      return `ws://${host}:${port}`;
    }

    return '';
  }

  isCompanionMonitoringEnabled() {
    return !!String(this.config.companionUrl || '').trim();
  }

  async start() {
    console.log('\n🎥 Tally starting...');
    if (this.config.name) console.log(`   Name: ${this.config.name}`);
    console.log(`   Relay: ${this.config.relay}`);

    await this.connectRelay();
    await this.connectATEM();
    if (this.isObsMonitoringEnabled()) {
      await this.connectOBS();
    } else {
      console.log('🎬 OBS not configured (set via Equipment tab)');
    }
    this.audioMonitor.start(this);
    this.streamHealthMonitor.start(this);
    if (this.isCompanionMonitoringEnabled()) {
      await this.connectCompanion();
    } else {
      console.log('🎛️  Companion not configured (set via Equipment tab)');
    }
    await this.connectVideoHubs();
    await this.connectHyperDecks();
    await this.connectProPresenter();
    await this.connectResolume();
    await this.connectVMix();
    await this.connectMixer();
    await this.connectPTZ();
    await this.connectEncoder();

    this._track(setInterval(() => this.sendStatus(), 10_000));
    this._track(setInterval(() => { this.status.system.uptime = Math.floor(process.uptime()); }, 10_000));

    // System health monitoring (CPU, RAM, disk) — poll every 30s
    this._track(setInterval(async () => {
      try {
        const health = await getSystemHealth();
        Object.assign(this.status.system, health);
      } catch { /* ignore */ }
    }, 30_000));
    // Initial system health snapshot
    getSystemHealth().then(health => Object.assign(this.status.system, health)).catch(() => {});

    // Watchdog
    this.watchdogActive = this.config.watchdog !== false;
    if (this.watchdogActive) {
      console.log('🐕 Watchdog enabled (30s interval)');
      this._track(setInterval(() => this.watchdogTick(), 30_000));
    }

    console.log('\n✅ Tally running. Press Ctrl+C to stop.\n');
  }

  async watchdogTick() {
    if (!this.watchdogActive) return;
    const issues = [];

    // ── Source-agnostic stream quality checks ───────────────────────────────
    // Check FPS from whatever source is streaming
    const fps = this._getStreamFps();
    if (fps && fps.value < 24) {
      issues.push('fps_low');
      this._sendWatchdogAlert('fps_low', `Low FPS on ${fps.source}: ${fps.value}`);
    }

    // Check bitrate from whatever source is streaming
    const bitrate = this._getStreamBitrate();
    if (bitrate && bitrate.value < 1000) {
      issues.push('bitrate_low');
      this._sendWatchdogAlert('bitrate_low', `Low bitrate on ${bitrate.source}: ${bitrate.value}kbps`);
    }

    // ATEM disconnected
    const churchName = this.config.name || 'Church';
    if (this.config.atemIp && !this.status.atem.connected) {
      issues.push('atem_disconnected');
      this._sendWatchdogAlert('atem_disconnected', `${churchName}: ATEM disconnected (${this.config.atemIp || 'unknown IP'}) — will auto-reconnect`);
    }

    // OBS disconnected
    if (this.isObsMonitoringEnabled() && !this.status.obs.connected) {
      issues.push('obs_disconnected');
      const obsHost = this.config.obsUrl || 'unknown host';
      this._sendWatchdogAlert('obs_disconnected', `${churchName}: OBS disconnected (${obsHost}) — will auto-reconnect`);
    }

    // vMix disconnected
    if (this.vmix && !this.status.vmix?.connected) {
      issues.push('vmix_disconnected');
      this._sendWatchdogAlert('vmix_disconnected', `${churchName}: vMix disconnected`);
    }

    // Companion disconnected
    if (this.companion && !this.status.companion?.connected) {
      issues.push('companion_disconnected');
      const companionHost = this.config.companionUrl || 'unknown host';
      this._sendWatchdogAlert('companion_disconnected', `${churchName}: Companion disconnected (${companionHost})`);
    }

    // Encoder disconnected (hardware encoder managed by EncoderBridge)
    if (this._encoderManaged && this.encoderBridge && !this.status.encoder?.connected) {
      issues.push('encoder_disconnected');
      const encoderType = this.status.encoder?.type || this.config.encoder?.type || 'encoder';
      this._sendWatchdogAlert('encoder_disconnected', `${encoderType} encoder disconnected`);
    }

    // HyperDeck disconnected
    if (this.hyperdecks && this.hyperdecks.length > 0 && this.status.hyperdeck && !this.status.hyperdeck.connected) {
      issues.push('hyperdeck_disconnected');
      this._sendWatchdogAlert('hyperdeck_disconnected', 'HyperDeck disconnected');
    }

    // Mixer disconnected
    if (this.mixer && !this.status.mixer?.connected) {
      issues.push('mixer_disconnected');
      const mixerType = this.status.mixer?.type || this.config.mixer?.type || 'mixer';
      this._sendWatchdogAlert('mixer_disconnected', `${mixerType} audio console disconnected`);
    }

    // PTZ camera disconnected
    if (this.ptzManager && this.ptzManager.hasCameras()) {
      const allDown = this.status.ptz?.length > 0 && this.status.ptz.every(c => !c.connected);
      if (allDown) {
        issues.push('ptz_disconnected');
        this._sendWatchdogAlert('ptz_disconnected', 'All PTZ cameras disconnected');
      }
    }

    // ProPresenter disconnected
    if (this.proPresenter && !this.status.proPresenter?.connected && !this.status.proPresenter?.running) {
      issues.push('propresenter_disconnected');
      this._sendWatchdogAlert('propresenter_disconnected', 'ProPresenter disconnected');
    }

    // Multiple systems down — human-readable device names
    if (issues.length >= 3) {
      const issueLabels = {
        atem_disconnected: 'ATEM Switcher',
        obs_disconnected: 'OBS Studio',
        companion_disconnected: 'Companion',
        vmix_disconnected: 'vMix',
        encoder_disconnected: 'Encoder',
        hyperdeck_disconnected: 'HyperDeck',
        mixer_disconnected: 'Audio Console',
        ptz_disconnected: 'PTZ Cameras',
        propresenter_disconnected: 'ProPresenter',
        fps_low: 'Low FPS',
        bitrate_low: 'Low Bitrate',
      };
      const names = issues.map(k => issueLabels[k] || k);
      this._sendWatchdogAlert('multiple_systems_down', `Multiple devices offline at ${churchName} — ${names.join(', ')}. Check network switch and power.`);
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

  /**
   * Get current stream bitrate from whatever source is actively streaming.
   * Returns { value, source } or null.
   */
  _getStreamBitrate() {
    if (this.status.obs?.streaming && this.status.obs.bitrate > 0)
      return { value: this.status.obs.bitrate, source: 'OBS' };
    if (this.status.atem?.streaming && this.status.atem.streamingBitrate > 0)
      return { value: Math.round(this.status.atem.streamingBitrate / 1000), source: 'ATEM' };
    if ((this.status.encoder?.live || this.status.encoder?.streaming) && this.status.encoder.bitrateKbps > 0)
      return { value: this.status.encoder.bitrateKbps, source: this.status.encoder.type || 'Encoder' };
    return null;
  }

  /**
   * Get current stream FPS from whatever source is actively streaming.
   * Returns { value, source } or null.
   */
  _getStreamFps() {
    if (this.status.obs?.streaming && this.status.obs.fps > 0)
      return { value: this.status.obs.fps, source: 'OBS' };
    if ((this.status.encoder?.live || this.status.encoder?.streaming) && this.status.encoder.fps > 0)
      return { value: this.status.encoder.fps, source: this.status.encoder.type || 'Encoder' };
    return null;
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
    // Guard against overlapping connection attempts (e.g. rapid close events)
    if (this._relayConnecting) return Promise.resolve();
    this._relayConnecting = true;

    return new Promise((resolve) => {
      const url = `${this.config.relay}/church?token=${this.config.token}`;
      console.log(`\n📡 Connecting to relay...`);

      // Terminate any stale socket (CONNECTING=0 or OPEN=1) before creating a new one
      if (this.relay && (this.relay.readyState === 0 || this.relay.readyState === 1)) {
        try { this.relay.terminate(); } catch { /* ignore */ }
      }

      this.relay = new WebSocket(url);
      let resolved = false;
      const doResolve = () => {
        this._relayConnecting = false;
        if (!resolved) { resolved = true; resolve(); }
      };

      this.relay.on('open', () => {
        console.log('✅ Connected to relay server');
        this._relayConnecting = false;
        this.reconnectDelay = 3000;
        this.sendStatus();
        doResolve();

        // Ping relay every 30s to measure latency
        if (this._relayPingTimer) {
          clearInterval(this._relayPingTimer);
          const oldIdx = this._intervals.indexOf(this._relayPingTimer);
          if (oldIdx !== -1) this._intervals.splice(oldIdx, 1);
        }
        this._relayPingTimer = this._track(setInterval(() => {
          if (this.relay?.readyState === WebSocket.OPEN) {
            this._relayPingSent = Date.now();
            this.sendToRelay({ type: 'ping', ts: this._relayPingSent });
          }
        }, 30_000));
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
        this._relayConnecting = false;
        console.warn(`⚠️  Relay disconnected (${code}: ${reason}). Reconnecting in ${this.reconnectDelay / 1000}s...`);
        if (this._relayPingTimer) clearInterval(this._relayPingTimer);
        this.health.relay.reconnects++;
        doResolve(); // Don't block startup if relay is down
        if (!this._stopping && !this._reconnectScheduled) {
          this._reconnectScheduled = true;
          setTimeout(() => { this._reconnectScheduled = false; this.connectRelay(); }, this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000);
        }
      });

      this.relay.on('error', (err) => {
        // Don't clear _relayConnecting here — the 'close' event always follows
        // and handles reconnection scheduling.
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
      case 'chat':
        // Forward to Electron app via stdout structured line
        console.log(`[CHAT] ${JSON.stringify({
          id: msg.id,
          sender_name: msg.sender_name || msg.senderName,
          sender_role: msg.sender_role || msg.senderRole,
          source: msg.source,
          message: msg.message,
          timestamp: msg.timestamp,
        })}`);
        break;
      case 'pong':
        if (msg.ts) this.health.relay.latencyMs = Date.now() - msg.ts;
        this._lastPongTime = Date.now();
        break;
      case 'failover_state':
        this.log('Received failover state update from relay');
        // Forward to any listeners (the electron app parses stdout)
        this.log(`[SignalFailover] STATE_UPDATE: ${JSON.stringify(msg)}`);
        break;
      case 'encoder_metrics':
        // Relay pushes RTMP ingest metrics (e.g., from nginx-rtmp stats or Tally Encoder)
        if (this.encoderBridge?.adapter) {
          const a = this.encoderBridge.adapter;
          if (msg.live !== undefined && a.setLive) a.setLive(msg.live);
          if (msg.bitrateKbps > 0 && a.setBitrate) a.setBitrate(msg.bitrateKbps);
          if (msg.fps > 0 && a.setFps) a.setFps(msg.fps);
        }
        break;
      default:
        console.log('Relay msg:', msg.type);
    }
  }

  async executeCommand(msg) {
    const { command, params = {}, id } = msg;
    const deviceKey = command.split('.')[0];
    const hDev = this.health[deviceKey];
    if (hDev) hDev.commandsTotal++;

    let result = null;
    let error = null;
    const t0 = Date.now();

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

    if (hDev) {
      if (error) hDev.commandsFailed++;
      else hDev.commandsOk++;
      hDev.latencyMs = Date.now() - t0;
    }

    this.sendToRelay({ type: 'command_result', id, command, result, error });

    // Track recent commands for diagnostic bundles
    this._recentCommands.push({ command, params, error: error || null, timestamp: Date.now() });
    while (this._recentCommands.length > 20) this._recentCommands.shift();

    if (result && !error) console.log(`✅ ${typeof result === 'string' ? result : JSON.stringify(result)}`);
    if (error) console.error(`❌ ${error}`);
  }

  // ─── ATEM CONNECTION (with exponential backoff reconnect) ─────────────────

  async connectATEM() {
    const atemIp = this.config.atemIp;
    this.status.atem.ip = atemIp || null;
    this._fakeAtemMode = false;

    // Clean up previous ATEM instance to prevent orphaned event handlers
    if (this.atem) {
      try { this.atem.removeAllListeners(); } catch { /* ignore */ }
      try { this.atem.destroy(); } catch { /* ignore */ }
    }

    this.atem = new Atem();

    this.atem.on('connected', () => {
      console.log(`✅ ATEM connected${atemIp ? ` (${atemIp})` : ''}`);
      this.status.atem.connected = true;
      this.status.atem.ip = atemIp;
      this.updateAtemIdentity(this.atem?.state);
      try { this.status.atem.atemAudioSources = this.detectAtemAudioSources(this.atem?.state); } catch { /* non-critical */ }
      this._resolveAudioViaAtem();
      this.atemReconnectDelay = 2000;
      this.atemReconnecting = false;
      this.sendStatus();
      this.sendAlert('ATEM connected', 'info');
      this.sendToRelay({ type: 'signal_event', signal: 'atem_restored' });

      // Log initial program/preview + input labels after state has populated
      setTimeout(() => {
        try {
          const me = this.atem?.state?.video?.mixEffects?.[0];
          if (me) {
            if (this.status.atem.programInput === undefined || this.status.atem.programInput === null) {
              this.status.atem.programInput = me.programInput;
              console.log(`Program: Input ${me.programInput}`);
            }
            if (this.status.atem.previewInput === undefined || this.status.atem.previewInput === null) {
              this.status.atem.previewInput = me.previewInput;
              console.log(`Preview: Input ${me.previewInput}`);
            }
          }
          this._logInputLabels(this.atem?.state);
        } catch { /* non-critical */ }
      }, 2000);
    });

    this.atem.on('disconnected', () => {
      if (this._stopping) return;
      console.warn('⚠️  ATEM disconnected');
      this.status.atem.connected = false;
      this.sendStatus();
      this.sendAlert('ATEM disconnected', 'warning');
      this.sendToRelay({ type: 'signal_event', signal: 'atem_lost' });
      this.reconnectATEM();
    });

    this.atem.on('stateChanged', (state, pathToChange) => {
      if (!state) return;
      this.updateAtemIdentity(state);

      const me = state.video?.mixEffects?.[0];
      if (me) {
        const prevPgm = this.status.atem.programInput;
        const prevPvw = this.status.atem.previewInput;
        this.status.atem.programInput = me.programInput;
        this.status.atem.previewInput = me.previewInput;
        this.status.atem.inTransition = me.transitionPosition?.inTransition || false;
        // Log changes so Electron main.js can parse them from stdout
        if (me.programInput !== prevPgm) console.log(`Program: Input ${me.programInput}`);
        if (me.previewInput !== prevPvw) console.log(`Preview: Input ${me.previewInput}`);
      }

      // Detect input label changes
      if (typeof pathToChange === 'string' && pathToChange.startsWith('inputs.')) {
        this._logInputLabels(state);
      }

      const recording = state.recording;
      if (recording !== undefined) {
        const wasRecording = this.status.atem.recording;
        this.status.atem.recording = recording?.status === 'Recording';
        if (wasRecording !== this.status.atem.recording) {
          this.sendAlert(`ATEM recording ${this.status.atem.recording ? 'STARTED' : 'STOPPED'}`, 'info');
        }
      }

      // ── Streaming encoder readout ─────────────────────────────────────────
      const streaming = state.streaming;
      if (streaming !== undefined) {
        const wasStreaming = this.status.atem.streaming;
        const isStreaming = streaming?.status?.state?.toString() === 'Streaming'
          || streaming?.status?.state === 2; // StreamingStatus.Streaming enum value
        this.status.atem.streaming = isStreaming;

        if (streaming?.stats) {
          this.status.atem.streamingBitrate = streaming.stats.encodingBitrate || null;
          this.status.atem.streamingCacheUsed = streaming.stats.cacheUsed || null;
        }
        if (streaming?.service?.serviceName) {
          this.status.atem.streamingService = streaming.service.serviceName;
        }

        if (wasStreaming !== isStreaming) {
          this.sendAlert(
            `ATEM streaming ${isStreaming ? 'STARTED' : 'STOPPED'}${this.status.atem.streamingService ? ` (${this.status.atem.streamingService})` : ''}`,
            isStreaming ? 'info' : 'warning'
          );
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

      // ── Direct audio input detection ──────────────────────────────────
      try {
        this.status.atem.atemAudioSources = this.detectAtemAudioSources(state);
        this._resolveAudioViaAtem();
      } catch { /* non-critical */ }

      // Only send status when program/preview input actually changed
      // (stateChanged fires at very high frequency; periodic 10s interval covers the rest)
      const me2 = state.video?.mixEffects?.[0];
      if (me2) {
        const pgmChanged = me2.programInput !== this._prevAtemPgm;
        const pvwChanged = me2.previewInput !== this._prevAtemPvw;
        if (pgmChanged || pvwChanged) {
          this._prevAtemPgm = me2.programInput;
          this._prevAtemPvw = me2.previewInput;
          this.sendStatus();
        }
      }
    });

    // ── Camera Control Protocol (CCdP) — detect Blackmagic cameras ──────
    this.atem.on('receivedCommands', (commands) => {
      let cameraChanged = false;
      for (const cmd of commands) {
        if (cmd.constructor?.rawName !== 'CCdP') continue;
        const source = cmd.source;
        const { category, parameter } = cmd;
        const data = cmd.properties?.numberData || [];

        // Initialize camera entry on first CCdP from this source
        if (!this.status.atem.cameras[source]) {
          this.status.atem.cameras[source] = {
            detected: true,
            iris: null, gain: null, iso: null,
            whiteBalance: null, tint: null,
            shutterAngle: null, focus: null,
            lift: null, gamma: null, colorGain: null, offset: null,
            contrast: null, hueSat: null, lumMix: null,
          };
          console.log(`📷 Blackmagic camera detected on input ${source}`);
        }

        const cam = this.status.atem.cameras[source];
        cam.lastSeen = Date.now();

        // Lens (category 0)
        if (category === 0) {
          if (parameter === 0) cam.focus = data[0] ?? cam.focus;
          if (parameter === 2) cam.iris = data[0] ?? cam.iris;
        }
        // Video (category 1)
        if (category === 1) {
          if (parameter === 1) cam.gain = data[0] ?? cam.gain;
          if (parameter === 2) { cam.whiteBalance = data[0] ?? cam.whiteBalance; cam.tint = data[1] ?? cam.tint; }
          if (parameter === 5 || parameter === 8) cam.shutterAngle = data[0] ?? cam.shutterAngle;
          if (parameter === 13) cam.iso = data[0] ?? cam.iso;
        }
        // Color correction (category 8)
        if (category === 8) {
          if (parameter === 0 && data.length >= 4) cam.lift = data.slice(0, 4);
          if (parameter === 1 && data.length >= 4) cam.gamma = data.slice(0, 4);
          if (parameter === 2 && data.length >= 4) cam.colorGain = data.slice(0, 4);
          if (parameter === 3 && data.length >= 4) cam.offset = data.slice(0, 4);
          if (parameter === 4 && data.length >= 2) cam.contrast = data.slice(0, 2);
          if (parameter === 5) cam.lumMix = data[0] ?? cam.lumMix;
          if (parameter === 6 && data.length >= 2) cam.hueSat = data.slice(0, 2);
        }
        cameraChanged = true;
      }
      if (cameraChanged) this.sendStatus();
    });

    if (atemIp) {
      console.log(`📹 Connecting to ATEM at ${atemIp}...`);
      try {
        await this.atem.connect(atemIp);
      } catch (e) {
        console.warn(`⚠️  ATEM connection failed: ${e.message}`);
        this.reconnectATEM();
      }
    } else {
      console.log('📹 ATEM IP not configured — skipping (set with --atem <ip>)');
    }
  }

  reconnectATEM() {
    if (this._stopping || this.atemReconnecting || !this.config.atemIp) return;
    this.health.atem.reconnects++;
    this.atemReconnecting = true;
    console.log(`   Reconnecting ATEM in ${this.atemReconnectDelay / 1000}s...`);
    setTimeout(async () => {
      try {
        await this.atem.connect(this.config.atemIp);
        this.atemReconnecting = false;
      } catch (e) {
        this.atemReconnecting = false;
        console.warn(`⚠️  ATEM reconnect failed: ${e.message}`);
        this.atemReconnectDelay = Math.min(this.atemReconnectDelay * 2, 60_000);
        this.reconnectATEM();
      }
    }, this.atemReconnectDelay);
  }

  async atemCommand(fn, timeoutMs = 10000) {
    if (!this.atem || !this.status.atem.connected) throw new Error('ATEM not connected');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ATEM command timed out after ' + (timeoutMs / 1000) + 's')), timeoutMs);
      fn().then(result => { clearTimeout(timer); resolve(result); })
          .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  async stop() {
    this._stopping = true;

    // 1. Clear ALL tracked intervals (prevents timer fires after connections close)
    for (const id of this._intervals) clearInterval(id);
    this._intervals.length = 0;

    // 2. Clear named timers (belt + suspenders for any created before _track)
    if (this._relayPingTimer) { clearInterval(this._relayPingTimer); this._relayPingTimer = null; }
    if (this._encoderPollTimer) { clearInterval(this._encoderPollTimer); this._encoderPollTimer = null; }
    if (this._previewTimer) { clearInterval(this._previewTimer); this._previewTimer = null; }

    // 3. Close relay WebSocket
    if (this.relay) {
      try { this.relay.removeAllListeners(); this.relay.terminate(); } catch { /* ignore */ }
    }

    // 4. Prevent pending ATEM reconnect from firing
    this.atemReconnecting = true;

    // 5. Disconnect all devices (each in its own try/catch so one failure doesn't skip the rest)
    try {
      if (this.obs && typeof this.obs.disconnect === 'function') {
        await this.obs.disconnect();
      }
    } catch { /* ignore */ }

    try {
      if (this.proPresenter && typeof this.proPresenter.disconnect === 'function') {
        this.proPresenter.disconnect();
      }
    } catch { /* ignore */ }

    try {
      if (this.mixer && typeof this.mixer.disconnect === 'function') {
        await this.mixer.disconnect();
      }
    } catch { /* ignore */ }

    try {
      if (Array.isArray(this.hyperdecks)) {
        await Promise.allSettled(this.hyperdecks.map((deck) => deck?.disconnect?.()));
      }
    } catch { /* ignore */ }

    try {
      if (this.atem && typeof this.atem.disconnect === 'function') {
        await this.atem.disconnect();
      }
    } catch { /* ignore */ }

    try {
      if (this.atem && typeof this.atem.destroy === 'function') {
        this.atem.destroy();
      }
    } catch { /* ignore */ }

    // 6. Clean up Companion, StreamHealthMonitor, AudioMonitor
    if (this.companion?.stopPolling) this.companion.stopPolling();
    if (this.streamHealthMonitor?.stop) this.streamHealthMonitor.stop();
    if (this.audioMonitor?.stop) this.audioMonitor.stop();

    console.log('🛑 All timers cleared, connections closed.');
  }

  // ─── OBS CONNECTION ───────────────────────────────────────────────────────

  async connectOBS() {
    if (!this._obsReconnectDelay) this._obsReconnectDelay = 5000;
    const obsUrl = this.getObsUrlForConnection();
    if (!obsUrl) {
      console.log('🎬 OBS not configured (set via Equipment tab)');
      return;
    }
    // Create OBS instance and attach event listeners ONCE.
    // On reconnect we reuse the same instance — just call connect() again.
    if (!this.obs) {
      this.obs = new OBSWebSocket();

      this.obs.on('ConnectionOpened', () => {
        console.log('✅ OBS connected');
        this.status.obs.connected = true;
        this.status.obs.app = 'OBS Studio';
        if (!this._encoderManaged) this.status.encoder.connected = true;
        this._obsReconnectDelay = 5000; // reset backoff on success
        void (async () => {
          try {
            const ver = await this.obs.call('GetVersion');
            this.status.obs.version = ver?.obsVersion || null;
            this.status.obs.websocketVersion = ver?.obsWebSocketVersion || null;
            const identity = `OBS Studio${this.status.obs.version ? ` v${this.status.obs.version}` : ''}${this.status.obs.websocketVersion ? ` (WS ${this.status.obs.websocketVersion})` : ''}`;
            this.logIdentity('obs', 'OBS identity:', identity);
            this.sendStatus();
          } catch { /* optional */ }
        })();
        this.sendStatus();
      });

      this.obs.on('ConnectionClosed', () => {
        if (this._stopping) return;
        if (!this.isObsMonitoringEnabled()) return;
        this.health.obs.reconnects++;
        console.warn(`⚠️  OBS disconnected. Retrying in ${this._obsReconnectDelay / 1000}s...`);
        this.status.obs.connected = false;
        if (!this._encoderManaged) this.status.encoder.connected = false;
        this.sendStatus();
        const delay = this._obsReconnectDelay;
        this._obsReconnectDelay = Math.min(this._obsReconnectDelay * 2, 60_000);
        setTimeout(() => this.connectOBS(), delay);
      });

      this.obs.on('StreamStateChanged', ({ outputActive }) => {
        const wasStreaming = this.status.obs.streaming;
        this.status.obs.streaming = outputActive;
        if (!this._encoderManaged) this.status.encoder.live = !!outputActive;
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
        this._track(setInterval(async () => {
          if (!this.status.obs.connected) return;
          try {
            const stats = await this.obs.call('GetStats');
            this.status.obs.fps = Math.round(stats.activeFps || 0);
            this.status.obs.cpuUsage = Math.round(stats.cpuUsage || 0);
            if (!this._encoderManaged) {
              this.status.encoder.fps = this.status.obs.fps;
              this.status.encoder.cpuUsage = this.status.obs.cpuUsage;
              this.status.encoder.congestion = typeof stats.outputCongestion === 'number'
                ? Number(stats.outputCongestion.toFixed(2))
                : null;
            }

            const streamStatus = await this.obs.call('GetStreamStatus');
            this.status.obs.streaming = streamStatus.outputActive;
            // Compute bitrate from byte deltas (not cumulative)
            if (streamStatus.outputBytes != null) {
              const now = Date.now();
              if (this._prevObsBytes == null) {
                this._prevObsBytes = streamStatus.outputBytes;
                this._prevObsTime = now;
                this.status.obs.bitrate = null;
              } else {
                const deltaBits = (streamStatus.outputBytes - this._prevObsBytes) * 8;
                const deltaSec = (now - this._prevObsTime) / 1000;
                this.status.obs.bitrate = deltaSec > 0 ? Math.round(deltaBits / deltaSec / 1000) : 0;
                this._prevObsBytes = streamStatus.outputBytes;
                this._prevObsTime = now;
              }
            } else {
              this.status.obs.bitrate = null;
            }
            if (!this._encoderManaged) {
              this.status.encoder.bitrateKbps = this.status.obs.bitrate;
              this.status.encoder.live = !!streamStatus.outputActive;
            }

            // Low FPS alert handled by watchdog with dedup — no direct alert here
          } catch { /* ignore poll errors */ }
        }, 15_000));
      }
    }

    try {
      console.log(`🎬 Connecting to OBS at ${obsUrl}...`);
      await this.obs.connect(obsUrl, this.config.obsPassword);
    } catch (e) {
      console.warn('⚠️  OBS not available:', e.message);
      console.log('   (OBS optional — ATEM monitoring still works)');
    }
  }

  // ─── ENCODER BRIDGE ──────────────────────────────────────────────────────

  async connectEncoder() {
    const cfg = this.config.encoder;
    if (!cfg || !cfg.type) {
      // No explicit encoder configured — OBS fallback (existing behavior)
      console.log('📡 Encoder: using OBS default (no encoder configured)');
      return;
    }

    console.log(`📡 Connecting to encoder: ${cfg.type}${cfg.host ? ` at ${cfg.host}:${cfg.port || ''}` : ''}...`);
    this._encoderManaged = true;
    this.encoderBridge = new EncoderBridge(cfg);

    // If encoder type is OBS, share the existing OBS WebSocket instance
    if (cfg.type === 'obs' && this.obs) {
      this.encoderBridge.setObs(this.obs);
    }

    const online = await this.encoderBridge.connect();
    if (online) {
      console.log('✅ Encoder connected');
      const s = await this.encoderBridge.getStatus();
      Object.assign(this.status.encoder, s);
      if (s?.details) this.logIdentity('encoder', 'Encoder identity:', s.details);
    } else {
      console.log('⚠️  Encoder not available (will retry)');
    }

    // Adaptive encoder polling: 3s during active streams (for failover detection), 15s otherwise
    this._encoderPollTimer = null;
    this._startEncoderPoll(15_000);
  }

  _startEncoderPoll(intervalMs) {
    if (this._encoderPollTimer) clearInterval(this._encoderPollTimer);
    this._encoderPollTimer = this._track(setInterval(() => this._pollEncoder(), intervalMs));
  }

  async _pollEncoder() {
    if (!this.encoderBridge) return;
    try {
      const wasConnected = this.status.encoder.connected;
      const wasLive = this.status.encoder.live || this.status.encoder.streaming;
      const s = await this.encoderBridge.getStatus();
      Object.assign(this.status.encoder, s);
      if (s?.details) this.logIdentity('encoder', 'Encoder identity:', s.details);

      if (s.connected && !wasConnected) { this.health.encoder.reconnects++; console.log('✅ Encoder connected'); }
      if (!s.connected && wasConnected) console.log('⚠️  Encoder disconnected');

      // Detect encoder stream started/stopped
      const isLive = s.live || s.streaming;
      if (wasLive && !isLive && s.connected) {
        const encoderType = s.type || this.config.encoder?.type || 'Encoder';
        this.sendAlert(`🔴 ${encoderType} stream stopped`, 'critical');
        // Reset bitrate tracking + switch back to slow poll
        this._bitrateBaseline = null;
        this._bitrateSamples = [];
        this._bitrateInLoss = false;
        if (this._fastEncoderPoll) {
          this._fastEncoderPoll = false;
          this._startEncoderPoll(15_000);
        }
      }
      if (!wasLive && isLive) {
        const encoderType = s.type || this.config.encoder?.type || 'Encoder';
        this.sendAlert(`✅ ${encoderType} streaming started`, 'info');
        // Switch to fast poll for failover detection
        if (!this._fastEncoderPoll) {
          this._fastEncoderPoll = true;
          this._startEncoderPoll(3_000);
          console.log('[SignalFailover] Fast encoder poll enabled (3s)');
        }
      }

      // ── Bitrate signal tracking (for failover state machine) ──────────────
      if (isLive && s.bitrateKbps > 0) {
        this._updateBitrateSignal(s.bitrateKbps);
      }
    } catch { /* ignore */ }
  }

  _updateBitrateSignal(bitrateKbps) {
    const BASELINE_SAMPLES = 3;
    const DROP_RATIO = 0.2;     // below 20% of baseline = loss
    const RECOVER_RATIO = 0.5;  // above 50% of baseline = recovered

    // Build baseline from first healthy samples
    if (bitrateKbps > 500) {
      this._bitrateSamples.push(bitrateKbps);
      if (this._bitrateSamples.length > 10) this._bitrateSamples.shift();
      if (!this._bitrateBaseline && this._bitrateSamples.length >= BASELINE_SAMPLES) {
        this._bitrateBaseline = this._bitrateSamples.reduce((a, b) => a + b, 0) / this._bitrateSamples.length;
        console.log(`[SignalFailover] Bitrate baseline: ${Math.round(this._bitrateBaseline)} kbps`);
      }
    }

    if (!this._bitrateBaseline) return;

    const ratio = bitrateKbps / this._bitrateBaseline;

    if (!this._bitrateInLoss && ratio < DROP_RATIO) {
      // Bitrate dropped below threshold — signal loss
      this._bitrateInLoss = true;
      console.log(`[SignalFailover] Bitrate loss: ${Math.round(bitrateKbps)} kbps (${Math.round(ratio * 100)}% of baseline ${Math.round(this._bitrateBaseline)} kbps)`);
      this.sendToRelay({
        type: 'signal_event',
        signal: 'encoder_bitrate_loss',
        bitrateKbps: Math.round(bitrateKbps),
        baselineKbps: Math.round(this._bitrateBaseline),
      });
    } else if (this._bitrateInLoss && ratio > RECOVER_RATIO) {
      // Bitrate recovered above threshold — signal recovery
      this._bitrateInLoss = false;
      console.log(`[SignalFailover] Bitrate recovered: ${Math.round(bitrateKbps)} kbps (${Math.round(ratio * 100)}% of baseline)`);
      this.sendToRelay({
        type: 'signal_event',
        signal: 'encoder_bitrate_recovered',
        bitrateKbps: Math.round(bitrateKbps),
      });
    }
  }

  // ─── COMPANION CONNECTION ────────────────────────────────────────────────

  async connectCompanion() {
    const configuredUrl = String(this.config.companionUrl || '').trim();
    if (!configuredUrl) {
      console.log('🎛️  Companion not configured (set via Equipment tab)');
      return;
    }
    const url = configuredUrl;
    console.log(`🎛️  Checking Companion at ${url}...`);
    this.companion = new CompanionBridge({ companionUrl: url });
    this.status.companion.endpoint = url;

    const available = await this.companion.isAvailable();
    if (available) {
      console.log('✅ Companion connected');
      this.status.companion.connected = true;
      this.logIdentity('companion', 'Companion identity:', url);
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

    // Periodically refresh companion status (guard against duplicate intervals on re-entry)
    if (this._companionPollTimer) clearInterval(this._companionPollTimer);
    this._companionPollTimer = this._track(setInterval(async () => {
      try {
        const wasConnected = this.status.companion.connected;
        const avail = await this.companion.isAvailable();
        this.status.companion.connected = avail;
        if (avail) {
          const conns = await this.companion.getConnections();
          this.status.companion.connectionCount = conns.length;
          this.status.companion.connections = conns.map(c => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status }));
        }
        // Log state changes so the Electron host picks them up
        if (avail && !wasConnected) { this.health.companion.reconnects++; console.log('✅ Companion connected'); }
        if (!avail && wasConnected) console.log('⚠️  Companion disconnected');
      } catch { /* ignore */ }
    }, 30_000));
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
    this._previewTimer = this._track(setInterval(async () => {
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
    }, intervalMs));
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

  // ─── HYPERDECK CONNECTION ────────────────────────────────────────────────

  async connectHyperDecks() {
    const rawEntries = Array.isArray(this.config.hyperdecks) ? this.config.hyperdecks : [];
    const entries = rawEntries.map((entry, index) => {
      if (typeof entry === 'string') {
        return { host: entry.trim(), port: 9993, name: `HyperDeck ${index + 1}` };
      }
      return {
        host: String(entry?.host || entry?.ip || '').trim(),
        port: Number(entry?.port) || 9993,
        name: String(entry?.name || `HyperDeck ${index + 1}`),
      };
    }).filter((deck) => deck.host);
    if (entries.length === 0) {
      console.log('🎞️  HyperDeck not configured (set via Equipment tab)');
      this.status.hyperdeck = { connected: false, recording: false, decks: [] };
      this.status.hyperdecks = [];
      return;
    }

    this.hyperdecks = [];
    for (const entry of entries) {
      const deck = new HyperDeck({
        host: entry.host,
        port: entry.port || 9993,
        name: entry.name || `HyperDeck ${this.hyperdecks.length + 1}`,
      });
      deck.on('connected', () => {
        const identity = `${deck.host}:${deck.port}${deck.getStatus().model ? ` (${deck.getStatus().model})` : ''}`;
        this.logIdentity(`hyperdeck:${deck.host}:${deck.port}`, 'HyperDeck identity:', identity);
        this._updateHyperDeckStatus();
        this.sendStatus();
      });
      deck.on('disconnected', () => {
        this._updateHyperDeckStatus();
        this.sendStatus();
      });
      deck.on('transport', () => {
        this._updateHyperDeckStatus();
        this.sendStatus();
      });
      this.hyperdecks.push(deck);
    }

    for (const deck of this.hyperdecks) {
      try {
        console.log(`🎞️  Connecting to HyperDeck "${deck.name}" at ${deck.host}:${deck.port}...`);
        await deck.connect();
        await deck.refreshStatus();
        const st = deck.getStatus();
        console.log(`✅ HyperDeck connected (${st.model || 'model unknown'})`);
      } catch (e) {
        console.warn(`⚠️  HyperDeck connection failed (${deck.host}:${deck.port}): ${e.message}`);
      }
    }

    this._updateHyperDeckStatus();
    this.sendStatus();

    if (this._hyperdeckPollTimer) clearInterval(this._hyperdeckPollTimer);
    this._hyperdeckPollTimer = this._track(setInterval(async () => {
      if (!Array.isArray(this.hyperdecks) || this.hyperdecks.length === 0) return;
      await Promise.all(this.hyperdecks.map(async (deck) => {
        try {
          const wasDeckConnected = deck.connected;
          if (!deck.connected) {
            await deck.connect();
          }
          if (deck.connected) {
            if (!wasDeckConnected) this.health.hyperdeck.reconnects++;
            await deck.refreshStatus();
          }
        } catch {
          // best-effort reconnect/poll
        }
      }));
      this._updateHyperDeckStatus();
      this.sendStatus();
    }, 15_000));
  }

  _updateHyperDeckStatus() {
    const decks = Array.isArray(this.hyperdecks)
      ? this.hyperdecks.map((deck, index) => ({ index, ...deck.getStatus() }))
      : [];
    const connected = decks.some((deck) => deck.connected);
    const recording = decks.some((deck) => deck.recording);
    this.status.hyperdecks = decks;
    this.status.hyperdeck = { connected, recording, decks };
  }

  // ─── PROPRESENTER CONNECTION ────────────────────────────────────────────

  async connectProPresenter() {
    const ppConfig = this.config.proPresenter || {};
    if (!ppConfig.host) {
      console.log('⛪ ProPresenter not configured (set via Equipment tab)');
      return;
    }

    const ppOpts = {
      host: ppConfig.host,
      port: ppConfig.port || 1025,
      triggerMode: ppConfig.triggerMode || 'presentation',
    };
    if (ppConfig.backupHost) {
      ppOpts.backupHost = ppConfig.backupHost;
      ppOpts.backupPort = ppConfig.backupPort || 1025;
    }
    console.log(`⛪ Connecting to ProPresenter at ${ppOpts.host}:${ppOpts.port} (${ppOpts.triggerMode} mode)...`);
    this.proPresenter = new ProPresenter(ppOpts);

    this.proPresenter.on('connected', () => {
      this.status.proPresenter.connected = true;
      this.sendStatus();
    });

    this.proPresenter.on('disconnected', () => {
      this.health.proPresenter.reconnects++;
      this.status.proPresenter.connected = false;
      this.sendStatus();
    });

    this.proPresenter.on('slideChanged', (data) => {
      this._updateProPresenterStatus();
      // Forward to relay for AutoPilot trigger evaluation
      this._sendSlideChangeEvent(data);
    });

    this.proPresenter.on('lookChanged', () => this.sendStatus());
    this.proPresenter.on('timerUpdate', () => this.sendStatus());
    this.proPresenter.on('screenStateChanged', () => this.sendStatus());

    await this.proPresenter.connect();
    try {
      const version = await this.proPresenter.getVersion?.();
      if (version) {
        this.status.proPresenter.version = version;
        this.logIdentity('propresenter', 'ProPresenter version detected:', version);
      }
    } catch { /* optional */ }
    await this._updateProPresenterStatus();

    // Poll every 3s for rich status (timers, looks, screens, slide)
    if (this._proPollTimer) clearInterval(this._proPollTimer);
    this._proPollTimer = this._track(setInterval(() => this._updateProPresenterStatus(), 3_000));
  }

  async _updateProPresenterStatus() {
    if (!this.proPresenter) return;
    try {
      const running = await this.proPresenter.isRunning();
      this.status.proPresenter.running = running;
      if (running) {
        // Fetch all status in parallel — one failure doesn't block others
        const [slideRes, lookRes, timerRes, screenRes, playlistRes] = await Promise.allSettled([
          this.proPresenter.getCurrentSlide(),
          this.proPresenter.getActiveLook(),
          this.proPresenter.getTimerStatus(),
          this.proPresenter.getAudienceScreenStatus(),
          this.proPresenter.getPlaylistFocused(),
        ]);
        // Spread the full toStatus() so all fields flow through automatically
        Object.assign(this.status.proPresenter, this.proPresenter.toStatus());
      } else {
        this.status.proPresenter.connected = this.proPresenter.connected;
      }
    } catch { /* ignore */ }
  }

  _sendSlideChangeEvent(data) {
    if (!this.relay || this.relay.readyState !== 1) return;
    try {
      this.relay.send(JSON.stringify({
        type: 'propresenter_slide_change',
        presentationName: data?.presentationName || this.status.proPresenter?.currentSlide || '',
        slideIndex: data?.slideIndex ?? this.status.proPresenter?.slideIndex ?? 0,
        slideCount: data?.slideCount ?? this.status.proPresenter?.slideTotal ?? 0,
      }));
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
      this.status.resolume = { connected: true, host: cfg.host, port: cfg.port || 8080, version: version || null };
      if (version) this.logIdentity('resolume', 'Resolume version detected:', version);
    } else {
      console.log('⚠️  Resolume Arena not reachable (will skip — optional device)');
      this.status.resolume = { connected: false, host: cfg.host, port: cfg.port || 8080, version: null };
    }

    // Periodically refresh Resolume status (guard against duplicate intervals on re-entry)
    if (this._resolumePollTimer) clearInterval(this._resolumePollTimer);
    this._resolumePollTimer = this._track(setInterval(async () => {
      if (!this.resolume) return;
      try {
        const running = await this.resolume.isRunning();
        const wasConnected = this.status.resolume.connected;
        this.status.resolume.connected = running;
        if (wasConnected !== running) {
          if (running && !wasConnected) this.health.resolume.reconnects++;
          this.sendAlert(running ? 'Resolume Arena reconnected' : 'Resolume Arena disconnected', running ? 'info' : 'warning');
          this.sendStatus();
        }
      } catch { /* ignore */ }
    }, 30_000));
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
      this.status.vmix = {
        connected: true,
        streaming: status.streaming,
        recording: status.recording,
        edition: status.edition || null,
        version: status.version || null,
      };
      const vmixIdentity = `${status.edition || 'vMix'}${status.version ? ` ${status.version}` : ''}`;
      this.logIdentity('vmix', 'vMix identity:', vmixIdentity);
    } else {
      console.log('⚠️  vMix not reachable (will retry on watchdog tick — optional device)');
      this.status.vmix = { connected: false, streaming: false, recording: false, edition: null, version: null };
    }

    // Poll vMix status every 30s (guard against duplicate intervals on re-entry)
    if (this._vmixPollTimer) clearInterval(this._vmixPollTimer);
    this._vmixPollTimer = this._track(setInterval(async () => {
      if (!this.vmix) return;
      try {
        const status = await this.vmix.getStatus();
        const wasConnected = this.status.vmix.connected;
        const wasStreaming = this.status.vmix.streaming;
        const wasRecording = this.status.vmix.recording;
        if (status.running && !wasConnected) this.health.vmix.reconnects++;
        this.status.vmix = {
          connected: status.running,
          streaming: status.streaming || false,
          recording: status.recording || false,
          edition: status.edition || this.status.vmix.edition || null,
          version: status.version || this.status.vmix.version || null,
        };
        const vmixIdentity = `${this.status.vmix.edition || 'vMix'}${this.status.vmix.version ? ` ${this.status.vmix.version}` : ''}`;
        this.logIdentity('vmix', 'vMix identity:', vmixIdentity);

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
    }, 30_000));
  }

  // ─── MIXER CONNECTION ─────────────────────────────────────────────────────

  async connectMixer() {
    const cfg = this.config.mixer;
    if (!cfg || !cfg.host) {
      console.log('🎛️  Audio console not configured (set via Equipment tab)');
      return;
    }

    const mixerConfig = cfg;
    console.log(`🎛️  Connecting to ${mixerConfig.type} console at ${mixerConfig.host}:${mixerConfig.port || 'default'}...`);
    this.mixer = new MixerBridge(mixerConfig);
    await this.mixer.connect();

    const online = await this.mixer.isOnline();
    if (online) {
      const status = await this.mixer.getStatus();
      this.status.mixer = { connected: true, type: mixerConfig.type, model: status.model || null, firmware: status.firmware || null, mainMuted: status.mainMuted };
      const mixerIdentity = `${String(mixerConfig.type || 'mixer').toUpperCase()}${status.model ? ` ${status.model}` : ''}`;
      this.logIdentity('mixer', 'Mixer identity:', mixerIdentity);
      console.log(`✅ ${mixerConfig.type} console connected`);
      if (status.mainMuted) this.sendAlert('⚠️ WARNING: Audio console master is MUTED', 'warning');
    } else {
      console.log(`⚠️  ${mixerConfig.type} console not reachable (will retry on poll)`);
      this.status.mixer = { connected: false, type: mixerConfig.type, model: null, mainMuted: false };
    }

    // Poll every 30s — alert if master gets muted during service (guard against duplicate intervals)
    if (this._mixerPollTimer) clearInterval(this._mixerPollTimer);
    this._mixerPollTimer = this._track(setInterval(async () => {
      if (!this.mixer) return;
      try {
        const status = await this.mixer.getStatus();
        const wasConnected = this.status.mixer.connected;
        const wasMuted = this.status.mixer.mainMuted;
        if (status.online && !wasConnected) this.health.mixer.reconnects++;
        this.status.mixer = {
          connected: status.online,
          type: mixerConfig.type,
          model: status.model || this.status.mixer.model || null,
          firmware: status.firmware || this.status.mixer.firmware || null,
          mainMuted: status.mainMuted,
        };
        const mixerIdentity = `${String(mixerConfig.type || 'mixer').toUpperCase()}${this.status.mixer.model ? ` ${this.status.mixer.model}` : ''}`;
        this.logIdentity('mixer', 'Mixer identity:', mixerIdentity);
        if (!wasMuted && status.mainMuted) this.sendAlert('🔇 AUDIO: Master output was MUTED on console', 'critical');
        if (wasMuted && !status.mainMuted) this.sendAlert('✅ Audio master unmuted', 'info');
        this.sendStatus();
      } catch { /* ignore poll errors */ }
    }, 30_000));
  }

  // ─── PTZ CONNECTION ───────────────────────────────────────────────────────

  async connectPTZ() {
    const entries = Array.isArray(this.config.ptz) ? this.config.ptz.filter((c) => c?.ip) : [];
    if (entries.length === 0) {
      console.log('🎥 PTZ cameras not configured (set via Equipment tab)');
      this.status.ptz = [];
      return;
    }

    this.ptzManager = new PTZManager(entries, (msg) => console.log(msg));
    await this.ptzManager.connectAll();
    this.status.ptz = this.ptzManager.getStatus();
    this.sendStatus();

    if (this._ptzPollTimer) clearInterval(this._ptzPollTimer);
    this._ptzPollTimer = this._track(setInterval(async () => {
      if (!this.ptzManager) return;
      try {
        const prevPtz = this.status.ptz || [];
        await this.ptzManager.refreshStatus();
        this.status.ptz = this.ptzManager.getStatus();
        // Count cameras that transitioned from disconnected to connected
        for (let i = 0; i < this.status.ptz.length; i++) {
          if (this.status.ptz[i]?.connected && !(prevPtz[i]?.connected)) this.health.ptz.reconnects++;
        }
        this.sendStatus();
      } catch { /* ignore */ }
    }, 30_000));
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
    this.sendToRelay({ type: 'status_update', status: { ...this.status, health: this.health } });
    setTimeout(() => {
      this._statusDebounce = false;
    }, 100);
  }

  sendAlert(message, severity = 'warning') {
    console.log(`[ALERT] ${message}`);
    this.sendToRelay({ type: 'alert', message, severity });

    // Track recent alerts for diagnostic bundles
    this._recentAlerts.push({ message, severity, timestamp: Date.now() });
    while (this._recentAlerts.length > 50) this._recentAlerts.shift();
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
