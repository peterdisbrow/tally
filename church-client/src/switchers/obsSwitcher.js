/**
 * ObsSwitcher — Switcher adapter for OBS Studio via obs-websocket-js.
 *
 * Maps OBS scene switching to the common Switcher interface:
 *   - programInput = current program scene
 *   - previewInput = current preview scene (studio mode only)
 *   - inputLabels = { sceneName: sceneName }
 *   - cut() = SetCurrentProgramScene / TriggerStudioModeTransition
 *
 * When OBS is also configured as an encoder, the ObsSwitcher can share
 * the same OBSWebSocket instance to avoid duplicate connections.
 */

const { Switcher } = require('../switcher');

class ObsSwitcher extends Switcher {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} [opts.role]
   * @param {string} [opts.name]
   * @param {string} opts.url        OBS WebSocket URL (e.g. "ws://localhost:4455")
   * @param {string} [opts.password]  OBS WebSocket password
   * @param {object} [opts.sharedObs] Existing OBSWebSocket instance to reuse
   */
  constructor(opts) {
    super({ ...opts, type: 'obs' });
    this.url = opts.url || '';
    this.password = opts.password || '';
    this._obs = opts.sharedObs || null;
    this._ownsConnection = !opts.sharedObs;
    this._stopping = false;
    this._reconnectDelay = 5000;
    this._pollTimer = null;

    // Status
    this._programScene = null;
    this._previewScene = null;
    this._scenes = [];
    this._studioMode = false;
    this._streaming = false;
    this._recording = false;
    this._version = null;
    this._websocketVersion = null;
  }

  /** Expose the raw OBSWebSocket instance. */
  get raw() { return this._obs; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect() {
    this._stopping = false;

    // If sharing an existing OBS connection, just attach our poll
    if (this._obs && !this._ownsConnection) {
      // The shared instance is managed by the agent's connectOBS().
      // We just poll for scene state.
      this._startScenePoll();
      // Immediately query current state
      await this._refreshSceneState();
      return;
    }

    // Create our own OBSWebSocket instance
    if (!this._obs) {
      const OBSWebSocket = require('obs-websocket-js').default;
      this._obs = new OBSWebSocket();
    }

    this._obs.on('ConnectionOpened', () => {
      console.log(`✅ [${this.id}] OBS connected`);
      this.connected = true;
      this._reconnectDelay = 5000;
      this._queryVersion();
      this._refreshSceneState();
      this.emit('connected');
      this.emit('stateChanged');
    });

    this._obs.on('ConnectionClosed', () => {
      if (this._stopping) return;
      console.warn(`⚠️  [${this.id}] OBS disconnected. Retrying in ${this._reconnectDelay / 1000}s...`);
      this.connected = false;
      this.emit('disconnected');
      this.emit('stateChanged');
      const delay = this._reconnectDelay;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60_000);
      setTimeout(() => this.connect(), delay);
    });

    this._obs.on('CurrentProgramSceneChanged', ({ sceneName }) => {
      const prev = this._programScene;
      this._programScene = sceneName;
      if (prev !== sceneName) {
        console.log(`[${this.id}] OBS Program: ${sceneName}`);
        this.emit('stateChanged');
      }
    });

    this._obs.on('CurrentPreviewSceneChanged', ({ sceneName }) => {
      const prev = this._previewScene;
      this._previewScene = sceneName;
      if (prev !== sceneName) this.emit('stateChanged');
    });

    this._obs.on('StudioModeStateChanged', ({ studioModeEnabled }) => {
      this._studioMode = studioModeEnabled;
      if (!studioModeEnabled) this._previewScene = null;
      this.emit('stateChanged');
    });

    this._obs.on('SceneListChanged', ({ scenes }) => {
      this._scenes = (scenes || []).map(s => s.sceneName || s).filter(Boolean);
      this.emit('stateChanged');
    });

    this._obs.on('StreamStateChanged', ({ outputActive }) => {
      this._streaming = outputActive;
      this.emit('stateChanged');
    });

    this._obs.on('RecordStateChanged', ({ outputActive }) => {
      this._recording = outputActive;
      this.emit('stateChanged');
    });

    // Connect
    const connectArgs = [this.url];
    if (this.password) connectArgs.push(this.password);
    try {
      await this._obs.connect(...connectArgs);
    } catch (e) {
      console.warn(`⚠️  [${this.id}] OBS connection failed: ${e.message}`);
    }

    this._startScenePoll();
  }

  async disconnect() {
    this._stopping = true;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._ownsConnection && this._obs) {
      try { await this._obs.disconnect(); } catch { /* ignore */ }
    }
    this.connected = false;
  }

  // ─── Switching ──────────────────────────────────────────────────────────

  async cut(me = 0) {
    this._ensureConnected();
    if (this._studioMode) {
      await this._obs.call('TriggerStudioModeTransition');
    } else if (this._previewScene) {
      await this._obs.call('SetCurrentProgramScene', { sceneName: this._previewScene });
    }
  }

  async setProgram(input, me = 0) {
    this._ensureConnected();
    await this._obs.call('SetCurrentProgramScene', { sceneName: String(input) });
  }

  async setPreview(input, me = 0) {
    this._ensureConnected();
    await this._obs.call('SetCurrentPreviewScene', { sceneName: String(input) });
  }

  async autoTransition(me = 0) {
    // In OBS, auto-transition = studio mode transition
    return this.cut(me);
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  getStatus() {
    const labels = {};
    for (const scene of this._scenes) labels[scene] = scene;

    return {
      ...super.getStatus(),
      connected: this.connected,
      programInput: this._programScene,
      previewInput: this._previewScene,
      inputLabels: labels,
      streaming: this._streaming,
      recording: this._recording,
      studioMode: this._studioMode,
      version: this._version,
      websocketVersion: this._websocketVersion,
      scenes: [...this._scenes],
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  _ensureConnected() {
    if (!this._obs || !this.connected) throw new Error(`[${this.id}] OBS not connected`);
  }

  async _queryVersion() {
    try {
      const ver = await this._obs.call('GetVersion');
      this._version = ver?.obsVersion || null;
      this._websocketVersion = ver?.obsWebSocketVersion || null;
    } catch { /* optional */ }
  }

  async _refreshSceneState() {
    if (!this._obs) return;
    try {
      // Check if connected (shared connection)
      if (!this._ownsConnection) {
        this.connected = true; // trust the shared connection
      }
      if (!this.connected) return;

      const sceneList = await this._obs.call('GetSceneList');
      this._scenes = (sceneList.scenes || []).map(s => s.sceneName).reverse();
      this._programScene = sceneList.currentProgramSceneName || null;

      try {
        const studioMode = await this._obs.call('GetStudioModeEnabled');
        this._studioMode = studioMode.studioModeEnabled;
        if (this._studioMode) {
          const preview = await this._obs.call('GetCurrentPreviewScene');
          this._previewScene = preview.currentPreviewSceneName || null;
        }
      } catch {
        this._studioMode = false;
        this._previewScene = null;
      }

      const streamStatus = await this._obs.call('GetStreamStatus');
      this._streaming = streamStatus.outputActive;

      try {
        const recordStatus = await this._obs.call('GetRecordStatus');
        this._recording = recordStatus.outputActive;
      } catch { /* older OBS may not have this */ }

      this.emit('stateChanged');
    } catch { /* ignore poll errors */ }
  }

  _startScenePoll() {
    if (this._pollTimer) return;
    // Poll scene state every 10s for shared connections (events may not be wired)
    this._pollTimer = setInterval(() => this._refreshSceneState(), 10_000);
  }

  /**
   * Attach to an existing, already-connected OBSWebSocket instance.
   * Used when the agent's connectOBS() already established the connection
   * and we want to reuse it for switcher operations.
   */
  attachShared(obs) {
    this._obs = obs;
    this._ownsConnection = false;
    this.connected = true;
    this._startScenePoll();
    this._refreshSceneState();
  }
}

module.exports = { ObsSwitcher };
