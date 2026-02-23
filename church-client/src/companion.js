/**
 * Bitfocus Companion Bridge
 * Connects to Companion 4.x HTTP API for device-agnostic control.
 * Companion 4.x runs on port 8000 and uses /api/location endpoints.
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

class CompanionBridge extends EventEmitter {
  constructor({ companionUrl = 'http://localhost:8888' } = {}) {
    super();
    this.baseUrl = companionUrl.replace(/\/$/, '');
    this.connected = false;
    this.connectionCount = 0;
    this.connections = [];
    this._pollTimer = null;
    this._lastButtonStates = new Map();
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
    // Companion 4.x does not expose a connections list via HTTP API.
    // We just confirm it's reachable and report that.
    const reachable = await this.isAvailable();
    if (!reachable) throw new Error('Companion not reachable');

    // Return a single synthetic entry representing the Companion instance
    const list = [{
      id: 'companion',
      label: 'Companion',
      moduleId: 'companion',
      enabled: true,
      status: 'ok',
      hasError: false,
    }];

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

  async pressNamed(name) {
    // Search across pages for a button matching the name (fuzzy)
    const needle = name.toLowerCase().trim();
    // Search first 10 pages
    for (let page = 1; page <= 10; page++) {
      try {
        const grid = await this.getButtonGrid(page);
        for (const row of grid) {
          for (const btn of row) {
            if (btn.text && btn.text.toLowerCase().includes(needle)) {
              return await this.pressButton(page, btn.row, btn.col);
            }
          }
        }
      } catch {
        continue;
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
          this.connections = [{ id: 'companion', label: 'Companion', moduleId: 'companion', enabled: true, status: 'ok', hasError: false }];
          this.connectionCount = 1;
        } else {
          this.connections = [];
          this.connectionCount = 0;
        }
      } catch { /* ignore poll errors */ }
    }, intervalMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      connectionCount: this.connectionCount,
      connections: this.connections.map(c => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status })),
    };
  }
}

module.exports = { CompanionBridge };
