/**
 * Bitfocus Companion Bridge
 * Connects to Companion 3.x+ HTTP API for device-agnostic control.
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
      const { status } = await this._request('GET', '/api/connections');
      this.connected = status >= 200 && status < 400;
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
    const { status, body } = await this._request('GET', '/api/connections');
    if (status >= 400) throw new Error('Failed to get connections');

    // Companion returns object keyed by connection id
    const list = [];
    if (body && typeof body === 'object') {
      for (const [id, conn] of Object.entries(body)) {
        list.push({
          id,
          label: conn.label || conn.instance_type || id,
          moduleId: conn.instance_type || conn.module || 'unknown',
          enabled: conn.enabled !== false,
          status: conn.status || 'unknown',
          hasError: conn.status === 'error' || conn.status === 'bad_config',
        });
      }
    }

    this.connections = list;
    this.connectionCount = list.length;
    return list;
  }

  async getButtonGrid(page) {
    // Companion 3.x: get all buttons on a page
    // We'll try the location API for a standard 8x4 grid
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
        const available = await this.isAvailable();
        if (!available) return;
        await this.getConnections();

        // Emit connection status changes
        for (const conn of this.connections) {
          const key = conn.id;
          const prev = this._lastButtonStates.get(key);
          if (prev && prev !== conn.status) {
            this.emit('stateChange', { type: 'connection', connection: conn, previousStatus: prev });
          }
          this._lastButtonStates.set(key, conn.status);
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
