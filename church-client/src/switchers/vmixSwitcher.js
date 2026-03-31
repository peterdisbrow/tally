/**
 * VmixSwitcher — Switcher adapter for vMix via HTTP API.
 *
 * Wraps the existing VMix class and exposes the common Switcher
 * interface.  vMix is poll-based (no push events), so we poll
 * every 5s for state changes and emit events accordingly.
 */

const { Switcher } = require('../switcher');
const { VMix } = require('../vmix');

class VmixSwitcher extends Switcher {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} [opts.role]
   * @param {string} [opts.name]
   * @param {string} opts.host     vMix host
   * @param {number} [opts.port]   vMix port (default 8088)
   * @param {object} [opts.sharedVmix] Existing VMix instance to reuse
   */
  constructor(opts) {
    super({ ...opts, type: 'vmix' });
    this.host = opts.host || 'localhost';
    this.port = opts.port || 8088;
    this._vmix = opts.sharedVmix || null;
    this._ownsConnection = !opts.sharedVmix;
    this._pollTimer = null;
    this._stopping = false;

    // Status
    this._programInput = null;
    this._previewInput = null;
    this._inputLabels = {};
    this._streaming = false;
    this._recording = false;
    this._edition = null;
    this._version = null;
    this._inputCount = 0;
  }

  /** Expose the raw VMix instance. */
  get raw() { return this._vmix; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect() {
    this._stopping = false;

    if (!this._vmix) {
      this._vmix = new VMix({ host: this.host, port: this.port });
    }

    console.log(`🎬 [${this.id}] Connecting to vMix at ${this.host}:${this.port}...`);

    const running = await this._vmix.isRunning();
    if (running) {
      await this._refreshState();
      console.log(`✅ [${this.id}] vMix connected (${this._edition} ${this._version})`);
      this.emit('connected');
    } else {
      console.log(`⚠️  [${this.id}] vMix not reachable (will retry on poll)`);
      this.connected = false;
    }

    this._startPoll();
    this.emit('stateChanged');
  }

  async disconnect() {
    this._stopping = true;
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this.connected = false;
  }

  // ─── Switching ──────────────────────────────────────────────────────────

  async cut(me = 0) {
    this._ensureConnected();
    await this._vmix.cut();
    // Immediately refresh to get new program/preview
    await this._refreshState();
  }

  async setProgram(input, me = 0) {
    this._ensureConnected();
    await this._vmix.setProgram(input);
    await this._refreshState();
  }

  async setPreview(input, me = 0) {
    this._ensureConnected();
    await this._vmix.setPreview(input);
    await this._refreshState();
  }

  async autoTransition(me = 0) {
    this._ensureConnected();
    await this._vmix.fade();
    await this._refreshState();
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  getStatus() {
    return {
      ...super.getStatus(),
      connected: this.connected,
      programInput: this._programInput,
      previewInput: this._previewInput,
      inputLabels: this._inputLabels,
      streaming: this._streaming,
      recording: this._recording,
      edition: this._edition,
      version: this._version,
      inputCount: this._inputCount,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  _ensureConnected() {
    if (!this._vmix || !this.connected) throw new Error(`[${this.id}] vMix not connected`);
  }

  async _refreshState() {
    if (!this._vmix) return;
    try {
      const state = await this._vmix.getState(true);
      if (!state) {
        if (this.connected) {
          this.connected = false;
          this.emit('disconnected');
          this.emit('stateChanged');
        }
        return;
      }

      const wasConnected = this.connected;
      const prevPgm = this._programInput;
      const prevPvw = this._previewInput;

      this.connected = true;
      this._streaming = state.streaming || false;
      this._recording = state.recording || false;
      this._edition = state.edition || this._edition;
      this._version = state.version || this._version;
      this._programInput = state.activeInput;
      this._previewInput = state.previewInput;
      this._inputCount = (state.inputs || []).length;

      // Build input labels from vMix inputs
      const labels = {};
      for (const inp of (state.inputs || [])) {
        if (inp.number != null && inp.title) {
          labels[inp.number] = inp.title;
        }
      }
      this._inputLabels = labels;

      if (!wasConnected) this.emit('connected');
      if (prevPgm !== this._programInput || prevPvw !== this._previewInput) {
        if (this._programInput !== prevPgm) console.log(`[${this.id}] vMix Program: Input ${this._programInput}`);
        if (this._previewInput !== prevPvw) console.log(`[${this.id}] vMix Preview: Input ${this._previewInput}`);
        this.emit('stateChanged');
      }
    } catch { /* ignore poll errors */ }
  }

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      if (this._stopping) return;
      const wasConnected = this.connected;
      const wasStreaming = this._streaming;
      const wasRecording = this._recording;

      await this._refreshState();

      // Alert on state changes
      if (wasStreaming && !this._streaming) {
        this.emit('alert', 'vMix stream stopped unexpectedly', 'critical');
      }
      if (!wasStreaming && this._streaming) {
        this.emit('alert', 'vMix streaming started', 'info');
      }
      if (wasRecording && !this._recording) {
        this.emit('alert', 'vMix recording stopped', 'warning');
      }
    }, 5_000);
  }

  /**
   * Attach to an existing VMix instance (reuse the agent's this.vmix).
   */
  attachShared(vmix) {
    this._vmix = vmix;
    this._ownsConnection = false;
    this._refreshState();
    this._startPoll();
  }
}

module.exports = { VmixSwitcher };
