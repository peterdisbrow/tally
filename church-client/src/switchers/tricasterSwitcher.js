/**
 * TriCasterSwitcher — Switcher adapter for NewTek/Vizrt TriCaster.
 *
 * Uses the TriCaster HTTP REST API (port 80) with WebSocket change
 * notifications for real-time state updates.  Commands are sent via
 * GET /v1/shortcut?name={cmd}&value={val}.
 *
 * Protocol reference:
 *   - Shortcut commands: GET /v1/shortcut?name=...&value=...
 *   - State dictionaries: GET /v1/dictionary?key=tally|shortcut_states
 *   - Product info: GET /v1/version
 *   - Change notifications: ws://{host}/v1/change_notifications
 */

const http = require('http');
const { Switcher } = require('../switcher');

// WebSocket — use the ws package if available (Electron bundles it),
// otherwise fall back to a stub that disables push notifications.
let WebSocket;
try { WebSocket = require('ws'); } catch { WebSocket = null; }

class TriCasterSwitcher extends Switcher {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} [opts.role]
   * @param {string} [opts.name]
   * @param {string} opts.host     TriCaster IP / hostname
   * @param {number} [opts.port]   HTTP API port (default 80)
   */
  constructor(opts) {
    super({ ...opts, type: 'tricaster' });
    this.host = opts.host || null;
    this.port = opts.port || 80;
    this._stopping = false;
    this._reconnecting = false;
    this._reconnectDelay = 2000;
    this._connectedAt = null;
    this._stabilityTimer = null;
    this._ws = null;
    this._pollTimer = null;

    // Status fields
    this._productName = null;
    this._productVersion = null;
    this._sessionName = null;
    this._programInput = null;
    this._previewInput = null;
    this._inTransition = false;
    this._recording = false;
    this._streaming = false;
    this._inputLabels = {};
    this._tallyMap = {};     // { inputName: { on_pgm, on_prev } }
    this._shortcutStates = {};
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async connect() {
    this._stopping = false;

    if (!this.host) {
      console.warn(`[${this.id}] TriCaster: no host configured`);
      return;
    }

    console.log(`🎬 [${this.id}] Connecting to TriCaster at ${this.host}:${this.port}...`);

    try {
      // Fetch version to verify connectivity
      const version = await this._httpGet('/v1/version');
      if (version) {
        this._productName = version.product_name || null;
        this._productVersion = version.product_version || null;
        this._sessionName = version.session_name || null;
      }

      this.connected = true;
      this._connectedAt = Date.now();
      this._reconnecting = false;

      // Reset backoff after 30s stable
      if (this._stabilityTimer) clearTimeout(this._stabilityTimer);
      this._stabilityTimer = setTimeout(() => {
        if (this.connected) this._reconnectDelay = 2000;
      }, 30_000);

      console.log(`✅ [${this.id}] TriCaster connected — ${this._productName || 'Unknown'} ${this._productVersion || ''}`);

      // Initial state fetch
      await this._refreshState();

      // Start WebSocket for change notifications (or fall back to polling)
      this._startChangeNotifications();

      this.emit('connected');
      this.emit('stateChanged');
    } catch (e) {
      console.warn(`⚠️  [${this.id}] TriCaster connection failed: ${e.message}`);
      this.connected = false;
      this._scheduleReconnect();
    }
  }

  async disconnect() {
    this._stopping = true;
    this._reconnecting = false;
    if (this._stabilityTimer) { clearTimeout(this._stabilityTimer); this._stabilityTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this.connected = false;
  }

  // ─── Switching operations ───────────────────────────────────────────────

  async cut(me = 0) {
    this._ensureConnected();
    const prefix = me === 0 ? 'main' : `v${me}`;
    await this._shortcut(`${prefix}_take`);
  }

  async setProgram(input, me = 0) {
    this._ensureConnected();
    const prefix = me === 0 ? 'main' : `v${me}`;
    // Accept numeric index or named input (e.g. 'input1', 'ddr1')
    if (typeof input === 'string' && !/^\d+$/.test(input)) {
      await this._shortcut(`${prefix}_a_row_named_input`, input);
    } else {
      await this._shortcut(`${prefix}_a_row`, String(input));
    }
    await this._refreshState();
  }

  async setPreview(input, me = 0) {
    this._ensureConnected();
    const prefix = me === 0 ? 'main' : `v${me}`;
    if (typeof input === 'string' && !/^\d+$/.test(input)) {
      await this._shortcut(`${prefix}_b_row_named_input`, input);
    } else {
      await this._shortcut(`${prefix}_b_row`, String(input));
    }
    await this._refreshState();
  }

  async autoTransition(me = 0) {
    this._ensureConnected();
    const prefix = me === 0 ? 'main' : `v${me}`;
    await this._shortcut(`${prefix}_auto`);
  }

  // ─── TriCaster-specific operations ──────────────────────────────────────

  /** Trigger a macro by name. */
  async triggerMacro(macroName) {
    this._ensureConnected();
    await this._shortcut('play_macro_byname', macroName);
  }

  /** DDR control: play, stop, back, forward. */
  async ddrControl(ddr, action) {
    this._ensureConnected();
    const validActions = ['play', 'play_toggle', 'stop', 'back', 'forward',
      'single_mode_toggle', 'playlist_mode_toggle', 'loop_mode_toggle'];
    if (!validActions.includes(action)) throw new Error(`Invalid DDR action: ${action}`);
    await this._shortcut(`${ddr}_${action}`);
  }

  /** Start/stop recording. */
  async recordToggle(forceState) {
    this._ensureConnected();
    if (forceState != null) {
      await this._shortcut('record_toggle', forceState ? '1' : '0');
    } else {
      await this._shortcut('record_toggle');
    }
    await this._refreshState();
  }

  /** Start/stop streaming. */
  async streamToggle(forceState) {
    this._ensureConnected();
    if (forceState != null) {
      await this._shortcut('streaming_toggle', forceState ? '1' : '0');
    } else {
      await this._shortcut('streaming_toggle');
    }
    await this._refreshState();
  }

  // ─── Status ─────────────────────────────────────────────────────────────

  getStatus() {
    return {
      ...super.getStatus(),
      connected: this.connected,
      host: this.host,
      port: this.port,
      productName: this._productName,
      productVersion: this._productVersion,
      sessionName: this._sessionName,
      programInput: this._programInput,
      previewInput: this._previewInput,
      inTransition: this._inTransition,
      recording: this._recording,
      streaming: this._streaming,
      inputLabels: this._inputLabels,
      tallyMap: this._tallyMap,
    };
  }

  getTally() {
    const tally = {};
    for (const [inputName, state] of Object.entries(this._tallyMap)) {
      if (state.on_pgm) tally[inputName] = 'program';
      else if (state.on_prev) tally[inputName] = 'preview';
    }
    return tally;
  }

  // ─── Private: HTTP helpers ──────────────────────────────────────────────

  /**
   * Send a shortcut command via HTTP GET.
   * @param {string} name   Shortcut name
   * @param {string} [value] Optional value
   */
  _shortcut(name, value) {
    let path = `/v1/shortcut?name=${encodeURIComponent(name)}`;
    if (value != null) path += `&value=${encodeURIComponent(value)}`;
    return this._httpGet(path);
  }

  /**
   * Fetch a dictionary key from the TriCaster.
   * @param {string} key  Dictionary key (tally, shortcut_states, etc.)
   */
  _dictionary(key) {
    return this._httpGet(`/v1/dictionary?key=${encodeURIComponent(key)}`);
  }

  /**
   * Perform an HTTP GET request and parse JSON/XML response.
   * @returns {Promise<object|null>}
   */
  _httpGet(path) {
    return new Promise((resolve, reject) => {
      const opts = {
        hostname: this.host,
        port: this.port,
        path,
        method: 'GET',
        timeout: 5000,
        headers: { Accept: 'application/json, text/xml, */*' },
      };

      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            // Try JSON first (modern TriCaster firmware)
            if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
              resolve(JSON.parse(body));
            } else if (body.trim().startsWith('<')) {
              // Simple XML attribute extraction for tally/state data
              resolve(this._parseSimpleXml(body));
            } else {
              resolve(body);
            }
          } catch {
            resolve(body);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP request timed out')); });
      req.end();
    });
  }

  /**
   * Minimal XML parser for TriCaster dictionary responses.
   * Extracts attributes from top-level elements into an object.
   * Not a full XML parser — handles the flat key/value format
   * that the TriCaster API returns.
   */
  _parseSimpleXml(xml) {
    const result = {};
    const items = [];

    // Match individual XML elements: <tag attr="val" ... />
    const elementRegex = /<(\w+)\s+([^>]*?)\/?\s*>/g;
    let match;
    while ((match = elementRegex.exec(xml)) !== null) {
      const tag = match[1];
      const attrStr = match[2];
      const attrs = {};

      // Extract attributes
      const attrRegex = /(\w+)=["']([^"']*?)["']/g;
      let am;
      while ((am = attrRegex.exec(attrStr)) !== null) {
        attrs[am[1]] = am[2];
      }

      if (tag === 'entry' || tag === 'input' || tag === 'source') {
        items.push(attrs);
      } else if (attrs.name && attrs.value !== undefined) {
        result[attrs.name] = attrs.value;
      } else {
        Object.assign(result, attrs);
      }
    }

    if (items.length > 0) result._items = items;
    return result;
  }

  // ─── Private: state refresh ─────────────────────────────────────────────

  async _refreshState() {
    try {
      await Promise.all([
        this._refreshTally(),
        this._refreshShortcutStates(),
      ]);
    } catch { /* non-critical */ }
  }

  async _refreshTally() {
    try {
      const tally = await this._dictionary('tally');
      if (!tally) return;

      const prevPgm = this._programInput;
      const prevPvw = this._previewInput;
      const tallyMap = {};
      const labels = {};

      // Parse tally items — each represents an input
      const items = tally._items || [];
      let pgmSource = null;
      let pvwSource = null;

      for (const item of items) {
        const id = item.id || item.name || item.short_name;
        if (!id) continue;

        const onPgm = item.on_pgm === 'true' || item.on_pgm === '1';
        const onPvw = item.on_prev === 'true' || item.on_prev === '1';
        tallyMap[id] = { on_pgm: onPgm, on_prev: onPvw };

        if (item.long_name || item.label) {
          labels[id] = item.long_name || item.label;
        }

        if (onPgm && !pgmSource) pgmSource = id;
        if (onPvw && !pvwSource) pvwSource = id;
      }

      // If no items, try flat key/value format
      if (items.length === 0 && typeof tally === 'object') {
        for (const [key, val] of Object.entries(tally)) {
          if (key.startsWith('_')) continue;
          if (key.endsWith('_on_pgm') || key.endsWith('_on_prev')) {
            const inputName = key.replace(/_on_p[grv][mew]$/, '');
            if (!tallyMap[inputName]) tallyMap[inputName] = { on_pgm: false, on_prev: false };
            if (key.endsWith('_on_pgm')) tallyMap[inputName].on_pgm = val === 'true' || val === '1';
            if (key.endsWith('_on_prev')) tallyMap[inputName].on_prev = val === 'true' || val === '1';
          }
        }
        for (const [id, state] of Object.entries(tallyMap)) {
          if (state.on_pgm && !pgmSource) pgmSource = id;
          if (state.on_prev && !pvwSource) pvwSource = id;
        }
      }

      this._tallyMap = tallyMap;
      this._programInput = pgmSource;
      this._previewInput = pvwSource;
      if (Object.keys(labels).length > 0) this._inputLabels = labels;

      if (prevPgm !== this._programInput) {
        console.log(`[${this.id}] TriCaster Program: ${this._programInput}`);
      }
      if (prevPvw !== this._previewInput) {
        console.log(`[${this.id}] TriCaster Preview: ${this._previewInput}`);
      }
    } catch { /* non-critical */ }
  }

  async _refreshShortcutStates() {
    try {
      const states = await this._dictionary('shortcut_states');
      if (!states || typeof states !== 'object') return;

      this._shortcutStates = states;

      // Recording state
      const wasRecording = this._recording;
      this._recording = states.record === 'true' || states.record === '1'
        || states.recording === 'true' || states.recording === '1';
      if (wasRecording !== this._recording) {
        this.emit('alert', `TriCaster recording ${this._recording ? 'STARTED' : 'STOPPED'}`, 'info');
      }

      // Streaming state
      const wasStreaming = this._streaming;
      this._streaming = states.streaming === 'true' || states.streaming === '1';
      if (wasStreaming !== this._streaming) {
        this.emit('alert',
          `TriCaster streaming ${this._streaming ? 'STARTED' : 'STOPPED'}`,
          this._streaming ? 'info' : 'warning',
        );
      }
    } catch { /* non-critical */ }
  }

  // ─── Private: WebSocket change notifications ────────────────────────────

  _startChangeNotifications() {
    if (WebSocket && this.host) {
      try {
        this._connectWebSocket();
        return;
      } catch {
        console.log(`[${this.id}] WebSocket unavailable, falling back to polling`);
      }
    }
    // Fallback: poll every 3 seconds
    this._startPoll();
  }

  _connectWebSocket() {
    if (this._stopping || !WebSocket) return;

    const url = `ws://${this.host}:${this.port}/v1/change_notifications`;
    const ws = new WebSocket(url);
    this._ws = ws;

    ws.on('open', () => {
      console.log(`[${this.id}] TriCaster WebSocket connected`);
    });

    ws.on('message', async () => {
      // Any message means state changed — refresh
      if (!this._stopping) {
        const prevPgm = this._programInput;
        const prevPvw = this._previewInput;
        await this._refreshState();
        if (prevPgm !== this._programInput || prevPvw !== this._previewInput) {
          this.emit('stateChanged');
        }
      }
    });

    ws.on('close', (code) => {
      this._ws = null;
      if (this._stopping) return;

      if (code !== 1000) {
        // Abnormal close — reconnect WebSocket after a brief delay
        setTimeout(() => this._connectWebSocket(), 500);
      }
    });

    ws.on('error', () => {
      // Error will trigger close event
    });

    // Keepalive ping every 15s
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch { /* ignore */ }
      } else {
        clearInterval(pingInterval);
      }
    }, 15_000);

    ws.on('close', () => clearInterval(pingInterval));
  }

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      if (this._stopping) return;

      const prevPgm = this._programInput;
      const prevPvw = this._previewInput;
      const wasConnected = this.connected;

      try {
        await this._refreshState();
        if (!wasConnected && this.connected) {
          this.emit('connected');
        }
        if (prevPgm !== this._programInput || prevPvw !== this._previewInput) {
          this.emit('stateChanged');
        }
      } catch {
        if (wasConnected) {
          this.connected = false;
          this.emit('disconnected');
          this.emit('stateChanged');
        }
      }
    }, 3_000);
  }

  // ─── Private: helpers ───────────────────────────────────────────────────

  _ensureConnected() {
    if (!this.connected) throw new Error(`[${this.id}] TriCaster not connected`);
  }

  _scheduleReconnect() {
    if (this._stopping || this._reconnecting || !this.host) return;
    this._reconnecting = true;

    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60_000);

    console.log(`   [${this.id}] Reconnecting TriCaster in ${delay / 1000}s...`);
    setTimeout(async () => {
      try {
        await this.connect();
      } catch (e) {
        this._reconnecting = false;
        console.warn(`⚠️  [${this.id}] TriCaster reconnect failed: ${e.message}`);
        this._scheduleReconnect();
      }
    }, delay);
  }
}

module.exports = { TriCasterSwitcher };
