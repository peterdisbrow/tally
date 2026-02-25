/**
 * Bitfocus Companion Bridge
 * Connects to Companion 4.x HTTP API for device-agnostic control.
 * Companion 4.x runs on port 8000 and uses /api/location endpoints.
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

class CompanionBridge extends EventEmitter {
  constructor({ companionUrl = 'http://localhost:8888', buttonPollPages = [1] } = {}) {
    super();
    this.baseUrl = companionUrl.replace(/\/$/, '');
    this.connected = false;
    this.connectionCount = 0;
    this.connections = [];
    this._pollTimer = null;
    this._buttonPollTimer = null;
    this._lastButtonStates = new Map();

    // Button state mirroring
    this._buttonStates = new Map();       // key "page/row/col" → { page, row, column, text, pressed, style }
    this._recentButtonPresses = [];       // last N press events (audit trail)
    this._recentButtonPressLimit = 10;
    this._buttonPollPages = buttonPollPages;

    // Button name cache: Map<lowercaseName, { page, row, col, text }>
    this._buttonIndex = new Map();
    this._buttonIndexBuiltAt = 0;
    this._buttonIndexTTL = 60 * 1000; // rebuild after 60s
    this._buttonIndexBuilding = null;  // promise while building
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      };

      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ─── Core API ──────────────────────────────────────────────────────────────

  async isAvailable() {
    try {
      // Companion 4.x has no /api/connections endpoint.
      // Probe a known location slot; any HTTP response means Companion is up.
      const { status } = await this._request('GET', '/api/location/1/0/0');
      this.connected = status >= 200 && status < 500;
      return this.connected;
    } catch {
      this.connected = false;
      return false;
    }
  }

  async pressButton(page, row, col) {
    const { status, body } = await this._request('POST', `/api/location/${page}/${row}/${col}/press`);
    if (status >= 400) throw new Error(body?.message || `Press failed (${status})`);
    return { success: true, page, row, col };
  }

  async getConnections() {
    const reachable = await this.isAvailable();
    if (!reachable) throw new Error('Companion not reachable');

    const list = await this._fetchConnectionsList();
    if (!list.length) {
      list.push({
        id: 'companion',
        label: 'Companion',
        moduleId: 'companion',
        enabled: true,
        status: 'ok',
        hasError: false,
      });
    }

    this.connections = list;
    this.connectionCount = list.length;
    return list;
  }

  async getButtonGrid(page) {
    // Companion 4.x: get all buttons on a page via location API
    // Standard 8x4 grid
    const grid = [];
    const rows = 4;
    const cols = 8;

    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        try {
          const { body } = await this._request('GET', `/api/location/${page}/${r}/${c}`);
          row.push({
            row: r, col: c,
            text: body?.text || '',
            color: body?.bgcolor || null,
            pressed: body?.pressed || false,
          });
        } catch {
          row.push({ row: r, col: c, text: '', color: null, pressed: false });
        }
      }
      grid.push(row);
    }
    return grid;
  }

  /**
   * Build (or refresh) a cached index of all button labels → locations.
   * Scans pages 1-10 once, then reuses until TTL expires.
   */
  async _ensureButtonIndex(forceRefresh = false) {
    const age = Date.now() - this._buttonIndexBuiltAt;
    if (!forceRefresh && this._buttonIndex.size > 0 && age < this._buttonIndexTTL) {
      return; // cache is fresh
    }
    // Deduplicate concurrent builds
    if (this._buttonIndexBuilding) {
      await this._buttonIndexBuilding;
      return;
    }
    this._buttonIndexBuilding = this._buildButtonIndex();
    try {
      await this._buttonIndexBuilding;
    } finally {
      this._buttonIndexBuilding = null;
    }
  }

  async _buildButtonIndex() {
    const index = new Map();
    for (let page = 1; page <= 10; page++) {
      try {
        const grid = await this.getButtonGrid(page);
        for (const row of grid) {
          for (const btn of row) {
            if (btn.text) {
              const key = btn.text.toLowerCase().trim();
              if (key && !index.has(key)) {
                index.set(key, { page, row: btn.row, col: btn.col, text: btn.text });
              }
            }
          }
        }
      } catch {
        continue;
      }
    }
    this._buttonIndex = index;
    this._buttonIndexBuiltAt = Date.now();
    console.log(`[Companion] Button index built: ${index.size} buttons cached`);
  }

  async pressNamed(name) {
    const needle = name.toLowerCase().trim();

    // 1. Try cached index first (fast path)
    await this._ensureButtonIndex();
    // Exact match
    if (this._buttonIndex.has(needle)) {
      const { page, row, col } = this._buttonIndex.get(needle);
      return await this.pressButton(page, row, col);
    }
    // Fuzzy match (substring search within cached labels)
    for (const [key, loc] of this._buttonIndex) {
      if (key.includes(needle)) {
        return await this.pressButton(loc.page, loc.row, loc.col);
      }
    }

    // 2. Cache miss — force a fresh scan in case buttons changed
    await this._ensureButtonIndex(true);
    if (this._buttonIndex.has(needle)) {
      const { page, row, col } = this._buttonIndex.get(needle);
      return await this.pressButton(page, row, col);
    }
    for (const [key, loc] of this._buttonIndex) {
      if (key.includes(needle)) {
        return await this.pressButton(loc.page, loc.row, loc.col);
      }
    }

    throw new Error(`No button found matching "${name}"`);
  }

  // ─── Polling for state changes ─────────────────────────────────────────────

  startPolling(intervalMs = 2000) {
    this.stopPolling();
    this._pollTimer = setInterval(async () => {
      try {
        const wasConnected = this.connected;
        const available = await this.isAvailable();

        if (available && !wasConnected) {
          this.emit('stateChange', { type: 'connection', connection: { id: 'companion', status: 'ok' }, previousStatus: 'offline' });
        } else if (!available && wasConnected) {
          this.emit('stateChange', { type: 'connection', connection: { id: 'companion', status: 'offline' }, previousStatus: 'ok' });
        }

        if (available) {
          try {
            const conns = await this._fetchConnectionsList();
            this.connections = conns.length ? conns : [{ id: 'companion', label: 'Companion', moduleId: 'companion', enabled: true, status: 'ok', hasError: false }];
            this.connectionCount = this.connections.length;
          } catch {
            this.connections = [{ id: 'companion', label: 'Companion', moduleId: 'companion', enabled: true, status: 'ok', hasError: false }];
            this.connectionCount = 1;
          }

          // Poll button states alongside connection state
          try {
            await this.pollButtonStates();
          } catch { /* ignore button poll errors */ }
        } else {
          this.connections = [];
          this.connectionCount = 0;
        }
      } catch { /* ignore poll errors */ }
    }, intervalMs);
  }

  _extractConnections(body) {
    if (!body) return [];
    if (Array.isArray(body)) return body;
    if (Array.isArray(body.connections)) return body.connections;
    if (Array.isArray(body.modules)) return body.modules;
    if (Array.isArray(body.instances)) return body.instances;
    if (body && typeof body === 'object') {
      return Object.entries(body)
        .filter(([, value]) => value && typeof value === 'object')
        .map(([id, value]) => ({ id, ...value }));
    }
    return [];
  }

  _normalizeConnection(raw, index) {
    const statusValue = String(raw?.status ?? (raw?.connected === false ? 'offline' : 'ok')).trim().toLowerCase();
    const hasError = raw?.hasError === true || !!raw?.error || /error|fail/.test(statusValue);
    const id = String(raw?.id || raw?.connectionId || raw?.instanceId || raw?.moduleId || `conn-${index + 1}`);
    const label = String(raw?.label || raw?.name || raw?.friendlyName || raw?.moduleName || id);
    const moduleId = String(raw?.moduleId || raw?.type || raw?.instance_type || 'unknown');
    return {
      id,
      label,
      moduleId,
      enabled: raw?.enabled !== false && raw?.disabled !== true,
      status: statusValue || 'ok',
      hasError,
    };
  }

  async _fetchConnectionsList() {
    const endpoints = ['/api/connections', '/api/modules', '/api/instances'];
    for (const endpoint of endpoints) {
      try {
        const { status, body } = await this._request('GET', endpoint);
        if (status < 200 || status >= 300) continue;
        const rows = this._extractConnections(body);
        if (!rows.length) continue;
        return rows.map((row, index) => this._normalizeConnection(row, index));
      } catch {
        // try next endpoint
      }
    }
    return [];
  }

  // ─── Button state mirroring ─────────────────────────────────────────────

  /**
   * Poll button states for configured pages and detect changes.
   * Emits 'companion_button_pressed' and 'companion_button_released' events.
   */
  async pollButtonStates() {
    if (!this.connected) return;

    for (const page of this._buttonPollPages) {
      let grid;
      try {
        grid = await this.getButtonGrid(page);
      } catch {
        // Companion unreachable or API not available — skip silently
        continue;
      }

      for (const row of grid) {
        for (const btn of row) {
          const key = `${page}/${btn.row}/${btn.col}`;
          const prev = this._buttonStates.get(key);
          const pressed = !!btn.pressed;

          const state = {
            page,
            row: btn.row,
            column: btn.col,
            text: btn.text || '',
            pressed,
            style: btn.color || null,
          };

          this._buttonStates.set(key, state);

          // Detect transitions
          const wasPressed = prev ? prev.pressed : false;
          if (pressed && !wasPressed) {
            const event = { ...state, timestamp: Date.now() };
            this.emit('companion_button_pressed', event);
            this._recordButtonPress(event);
          } else if (!pressed && wasPressed) {
            this.emit('companion_button_released', { ...state, timestamp: Date.now() });
          }
        }
      }
    }
  }

  _recordButtonPress(event) {
    this._recentButtonPresses.push(event);
    if (this._recentButtonPresses.length > this._recentButtonPressLimit) {
      this._recentButtonPresses.shift();
    }
  }

  /**
   * Returns a map of all tracked button states keyed by "page/row/col".
   */
  getButtonStates() {
    const result = {};
    for (const [key, state] of this._buttonStates) {
      result[key] = { ...state };
    }
    return result;
  }

  /**
   * Returns recent button press events for audit trail.
   * @param {number} limit - Maximum events to return (default 10)
   */
  getRecentButtonPresses(limit = 10) {
    const count = Math.min(limit, this._recentButtonPresses.length);
    return this._recentButtonPresses.slice(-count).map(e => ({ ...e }));
  }

  /**
   * Start polling button states at the given interval.
   * Can run independently of connection polling.
   */
  startButtonPolling(intervalMs = 1000) {
    this.stopButtonPolling();
    this._buttonPollTimer = setInterval(() => {
      this.pollButtonStates().catch(() => { /* ignore poll errors */ });
    }, intervalMs);
  }

  stopButtonPolling() {
    if (this._buttonPollTimer) {
      clearInterval(this._buttonPollTimer);
      this._buttonPollTimer = null;
    }
  }


  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this.stopButtonPolling();
  }

  getStatus() {
    const pressedButtons = [];
    for (const [, state] of this._buttonStates) {
      if (state.pressed) pressedButtons.push({ ...state });
    }
    return {
      connected: this.connected,
      connectionCount: this.connectionCount,
      connections: this.connections.map(c => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status })),
      buttons: {
        tracked: this._buttonStates.size,
        pressed: pressedButtons,
        recentPresses: this.getRecentButtonPresses(),
      },
    };
  }
}

module.exports = { CompanionBridge };
