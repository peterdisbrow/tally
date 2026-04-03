/**
 * AtemSwitcher — Switcher adapter for Blackmagic ATEM switchers.
 *
 * Wraps the `atem-connection` package and exposes the common Switcher
 * interface.  Connection logic (exponential backoff, stability timer,
 * identity detection, tally, recording/streaming state) is extracted
 * from the monolithic connectATEM() in index.js so it can be reused
 * for multiple ATEM instances.
 */

const { Atem, Enums } = require('atem-connection');
const { Switcher } = require('../switcher');

// ─── ATEM model labels ──────────────────────────────────────────────────────

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

const PORT_TYPE_NAMES = {
  1: 'SDI', 2: 'HDMI', 4: 'Component', 8: 'Composite',
  16: 'S-Video', 32: 'XLR', 64: 'AES/EBU', 128: 'RCA', 256: 'Internal',
  512: 'TS Jack', 1024: 'MADI', 2048: 'TRS Jack', 4096: 'RJ45',
};

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
  const modelName = prettifyAtemModelEnumName(modelEnumName) || productIdentifier;
  const apiVer = info.apiVersion;
  let protocolVersion = null;
  if (apiVer && typeof apiVer === 'object') {
    protocolVersion = `${apiVer.major || 0}.${apiVer.minor || 0}`;
  } else if (typeof apiVer === 'string' && apiVer.trim()) {
    protocolVersion = apiVer.trim();
  } else if (typeof apiVer === 'number') {
    protocolVersion = String(apiVer);
  }
  return { modelName: modelName || null, modelCode, productIdentifier: productIdentifier || null, protocolVersion };
}

// ─── AtemSwitcher class ─────────────────────────────────────────────────────

class AtemSwitcher extends Switcher {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} [opts.role]
   * @param {string} [opts.name]
   * @param {string} opts.ip       ATEM IP address
   */
  constructor(opts) {
    super({ ...opts, type: 'atem' });
    this.ip = opts.ip || null;
    this._atem = null;
    this._stopping = false;
    this._reconnecting = false;
    this._reconnectDelay = 2000;
    this._connectedAt = null;
    this._stabilityTimer = null;
    this._prevPgm = null;
    this._prevPvw = null;

    // Switcher-specific status fields
    this._model = null;
    this._modelCode = null;
    this._productIdentifier = null;
    this._protocolVersion = null;
    this._programInput = null;
    this._previewInput = null;
    this._inTransition = false;
    this._recording = false;
    this._streaming = false;
    this._streamingBitrate = null;
    this._streamingCacheUsed = null;
    this._streamingService = null;
    this._inputLabels = {};
    this._inputSources = {};
    this._audioDelays = {};
    this._atemAudioSources = [];
    this._cameras = {};
    this._recordingDuration = null;
    this._recordingTimeAvailable = null;
    this._recordingError = null;
  }

  /** Expose the raw Atem instance for backward compatibility (agent.atem). */
  get raw() { return this._atem; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect() {
    this._stopping = false;

    // Clean up previous instance
    if (this._atem) {
      try { this._atem.removeAllListeners(); } catch { /* ignore */ }
      try { this._atem.destroy(); } catch { /* ignore */ }
    }

    this._atem = new Atem();
    this._attachEventHandlers();

    if (this.ip) {
      console.log(`📹 [${this.id}] Connecting to ATEM at ${this.ip}...`);
      try {
        await this._atem.connect(this.ip);
      } catch (e) {
        console.warn(`⚠️  [${this.id}] ATEM connection failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }
  }

  async disconnect() {
    this._stopping = true;
    this._reconnecting = false;
    if (this._stabilityTimer) { clearTimeout(this._stabilityTimer); this._stabilityTimer = null; }
    try { if (this._atem) await this._atem.disconnect(); } catch { /* ignore */ }
    try { if (this._atem) this._atem.destroy(); } catch { /* ignore */ }
    this.connected = false;
  }

  // ─── Switching operations ───────────────────────────────────────────────

  async cut(me = 0) {
    this._ensureConnected();
    await this._timedCommand(() => this._atem.cut(me));
  }

  async setProgram(input, me = 0) {
    this._ensureConnected();
    await this._timedCommand(() => this._atem.changeProgramInput(input, me));
  }

  async setPreview(input, me = 0) {
    this._ensureConnected();
    await this._timedCommand(() => this._atem.changePreviewInput(input, me));
  }

  async autoTransition(me = 0) {
    this._ensureConnected();
    await this._timedCommand(() => this._atem.autoTransition(me));
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  getStatus() {
    return {
      ...super.getStatus(),
      connected: this.connected,
      ip: this.ip,
      model: this._model,
      modelCode: this._modelCode,
      productIdentifier: this._productIdentifier,
      protocolVersion: this._protocolVersion,
      programInput: this._programInput,
      previewInput: this._previewInput,
      inTransition: this._inTransition,
      recording: this._recording,
      streaming: this._streaming,
      streamingBitrate: this._streamingBitrate,
      streamingCacheUsed: this._streamingCacheUsed,
      streamingService: this._streamingService,
      inputLabels: this._inputLabels,
      inputSources: this._inputSources,
      audioDelays: this._audioDelays,
      atemAudioSources: this._atemAudioSources,
      cameras: this._cameras,
      recordingDuration: this._recordingDuration,
      recordingTimeAvailable: this._recordingTimeAvailable,
      recordingError: this._recordingError,
    };
  }

  // ─── Private: event handlers ────────────────────────────────────────────

  _attachEventHandlers() {
    const atem = this._atem;

    atem.on('connected', () => {
      console.log(`✅ [${this.id}] ATEM connected${this.ip ? ` (${this.ip})` : ''}`);
      this.connected = true;
      this._reconnecting = false;
      this._updateIdentity(atem.state);
      this._detectAudioSources(atem.state);

      // Stability timer — only reset backoff after 30s stable
      this._connectedAt = Date.now();
      if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        if (this.connected) this._reconnectDelay = 2000;
      }, 30_000);

      // Log initial program/preview after state populates
      setTimeout(() => {
        try {
          const me = atem.state?.video?.mixEffects?.[0];
          if (me) {
            if (this._programInput == null) {
              this._programInput = me.programInput;
              console.log(`[${this.id}] Program: Input ${me.programInput}`);
            }
            if (this._previewInput == null) {
              this._previewInput = me.previewInput;
              console.log(`[${this.id}] Preview: Input ${me.previewInput}`);
            }
          }
          this._updateInputLabels(atem.state);
        } catch { /* non-critical */ }
      }, 2000);

      this.emit('connected');
      this.emit('stateChanged');
    });

    atem.on('disconnected', () => {
      if (this._stopping) return;
      if (this._stabilityTimer) { clearTimeout(this._stabilityTimer); this._stabilityTimer = null; }
      const uptime = this._connectedAt ? Math.round((Date.now() - this._connectedAt) / 1000) : 0;
      console.warn(`⚠️  [${this.id}] ATEM disconnected${uptime ? ` (was connected ${uptime}s)` : ''}`);
      this.connected = false;
      this.emit('disconnected');
      this.emit('stateChanged');
      this._scheduleReconnect();
    });

    atem.on('stateChanged', (state, pathToChange) => {
      if (!state) return;
      this._updateIdentity(state);

      const me = state.video?.mixEffects?.[0];
      if (me) {
        const prevPgm = this._programInput;
        const prevPvw = this._previewInput;
        this._programInput = me.programInput;
        this._previewInput = me.previewInput;
        this._inTransition = me.transitionPosition?.inTransition || false;
        if (me.programInput !== prevPgm) console.log(`[${this.id}] Program: Input ${me.programInput}`);
        if (me.previewInput !== prevPvw) console.log(`[${this.id}] Preview: Input ${me.previewInput}`);
      }

      // Input label changes
      if (typeof pathToChange === 'string' && pathToChange.startsWith('inputs.')) {
        this._updateInputLabels(state);
      }

      // Recording state
      this._updateRecordingState(state);

      // Streaming state
      this._updateStreamingState(state);

      // Audio delays
      this._updateAudioDelays(state);

      // Audio source detection
      try {
        this._atemAudioSources = this._detectAudioSources(state);
      } catch { /* non-critical */ }

      // Only emit stateChanged on program/preview changes (high frequency events)
      const me2 = state.video?.mixEffects?.[0];
      if (me2) {
        const pgmChanged = me2.programInput !== this._prevPgm;
        const pvwChanged = me2.previewInput !== this._prevPvw;
        if (pgmChanged || pvwChanged) {
          this._prevPgm = me2.programInput;
          this._prevPvw = me2.previewInput;
          this.emit('stateChanged');
        }
      }
    });

    // Camera Control Protocol (CCdP) — detect Blackmagic cameras
    atem.on('receivedCommands', (commands) => {
      let cameraChanged = false;
      for (const cmd of commands) {
        if (cmd.constructor?.rawName !== 'CCdP') continue;
        const source = cmd.source;
        const { category, parameter } = cmd;
        const data = cmd.properties?.numberData || [];

        if (!this._cameras[source]) {
          this._cameras[source] = {
            detected: true,
            iris: null, gain: null, iso: null,
            whiteBalance: null, tint: null,
            shutterAngle: null, focus: null,
            lift: null, gamma: null, colorGain: null, offset: null,
            contrast: null, hueSat: null, lumMix: null,
          };
          console.log(`📷 [${this.id}] Blackmagic camera detected on input ${source}`);
        }

        const cam = this._cameras[source];
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
      if (cameraChanged) this.emit('stateChanged');
    });
  }

  // ─── Private: helpers ───────────────────────────────────────────────────

  _ensureConnected() {
    if (!this._atem || !this.connected) throw new Error(`[${this.id}] ATEM not connected`);
  }

  async _timedCommand(fn, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.id}] ATEM command timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      fn().then(result => { clearTimeout(timer); resolve(result); })
          .catch(err => { clearTimeout(timer); reject(err); });
    });
  }

  _scheduleReconnect() {
    if (this._stopping || this._reconnecting || !this.ip) return;
    this._reconnecting = true;

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60_000);

    console.log(`   [${this.id}] Reconnecting ATEM in ${delay / 1000}s...`);
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (e) {
        this._reconnecting = false;
        console.warn(`⚠️  [${this.id}] ATEM reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }

  _updateIdentity(state) {
    const source = (state && typeof state === 'object') ? state : this._atem?.state;
    if (!source || typeof source !== 'object') return;
    const detected = extractAtemIdentity(source);
    if (detected.modelName) this._model = detected.modelName;
    if (detected.modelCode !== null) this._modelCode = detected.modelCode;
    if (detected.productIdentifier) this._productIdentifier = detected.productIdentifier;
    if (detected.protocolVersion) this._protocolVersion = detected.protocolVersion;
  }

  _updateInputLabels(state) {
    if (!state || typeof state !== 'object') return;
    const inputs = state.inputs;
    if (!inputs || typeof inputs !== 'object') return;

    const labels = {};
    const inputSources = {};
    for (const [id, input] of Object.entries(inputs)) {
      if (input && input.longName) {
        labels[id] = input.longName;
        inputSources[id] = {
          longName: input.longName,
          shortName: input.shortName || '',
          portType: PORT_TYPE_NAMES[input.externalPortType] || null,
          internalPortType: input.internalPortType ?? null,
          isExternal: input.internalPortType === 0 || input.isExternal === true,
        };
      }
    }
    if (Object.keys(labels).length > 0) {
      this._inputLabels = labels;
      this._inputSources = inputSources;
      console.log(`[${this.id}] ATEM Labels: ${JSON.stringify(labels)}`);
    }
  }

  _updateRecordingState(state) {
    const recording = state.recording;
    if (recording === undefined) return;
    const wasRecording = this._recording;
    const recStatus = recording?.status;
    const isRecording = recStatus === 'Recording' || recStatus?.state === 1 || recStatus === 1;
    this._recording = isRecording;
    if (recording.duration) this._recordingDuration = recording.duration;
    if (recStatus && typeof recStatus === 'object') {
      if (recStatus.recordingTimeAvailable != null) this._recordingTimeAvailable = recStatus.recordingTimeAvailable;
      if (recStatus.error != null) this._recordingError = recStatus.error;
    }
    if (wasRecording !== isRecording) {
      this.emit('alert', `ATEM recording ${isRecording ? 'STARTED' : 'STOPPED'}`, 'info');
    }
  }

  _updateStreamingState(state) {
    const streaming = state.streaming;
    if (streaming === undefined) return;
    const wasStreaming = this._streaming;
    const streamState = streaming?.status?.state;
    const isStreaming = streamState === 4
      || streamState === 'Streaming'
      || String(streamState).toLowerCase() === 'streaming';
    this._streaming = isStreaming;

    if (streaming?.stats) {
      this._streamingBitrate = streaming.stats.encodingBitrate || null;
      this._streamingCacheUsed = streaming.stats.cacheUsed || null;
    }
    if (streaming?.service?.serviceName) {
      this._streamingService = streaming.service.serviceName;
    }

    if (wasStreaming !== isStreaming) {
      this.emit('alert',
        `ATEM streaming ${isStreaming ? 'STARTED' : 'STOPPED'}${this._streamingService ? ` (${this._streamingService})` : ''}`,
        isStreaming ? 'info' : 'warning'
      );
    }
  }

  _updateAudioDelays(state) {
    try {
      const audioDelays = {};
      const classic = state.audio?.classic?.channels || state.audio?.channels;
      if (classic && typeof classic === 'object') {
        for (const [inputId, channel] of Object.entries(classic)) {
          const delay = channel?.delay ?? channel?.sourceDelay ?? 0;
          if (delay !== 0) audioDelays[inputId] = delay;
        }
      }
      const fairlight = state.audio?.fairlight?.inputs;
      if (fairlight && typeof fairlight === 'object') {
        for (const [inputId, input] of Object.entries(fairlight)) {
          const delay = input?.delay ?? 0;
          if (delay !== 0) audioDelays[inputId] = delay;
        }
      }
      this._audioDelays = audioDelays;
    } catch { /* non-critical */ }
  }

  _detectAudioSources(state) {
    const detected = [];
    if (!state || typeof state !== 'object') return detected;

    const classicChannels = state.audio?.classic?.channels || state.audio?.channels;
    if (classicChannels && typeof classicChannels === 'object') {
      for (const [channelId, ch] of Object.entries(classicChannels)) {
        if (!ch) continue;
        if (ch.sourceType === 2 && ch.mixOption !== 0) {
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

    const fairlightInputs = state.fairlight?.inputs;
    if (fairlightInputs && typeof fairlightInputs === 'object') {
      for (const [inputId, input] of Object.entries(fairlightInputs)) {
        if (!input?.properties || input.properties.inputType !== 2) continue;
        const portName = PORT_TYPE_NAMES[input.properties.externalPortType] || 'Unknown';
        detected.push({ inputId, type: 'fairlight', sourceType: 'AudioIn', portType: portName });
      }
    }

    this._atemAudioSources = detected;
    return detected;
  }
}

module.exports = {
  AtemSwitcher,
  extractAtemIdentity,
  prettifyAtemModelEnumName,
  ATEM_MODEL_LABELS,
  ATEM_MODEL_ENUM,
  PORT_TYPE_NAMES,
};
