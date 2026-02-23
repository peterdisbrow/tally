/**
 * Tally Encoder Adapter
 *
 * For the dedicated Tally Encoder hardware (Raspberry Pi + Cam Link / NUC + UltraStudio).
 * Polls the encoder's Express API on port 7070.
 * Endpoints: GET /health, GET /status, GET /sync
 */

const http = require('http');

class TallyEncoderAdapter {
  constructor({ host, port = 7070 } = {}) {
    this.host = host;
    this.port = port;
    this._connected = false;
  }

  async connect()    { return this.isOnline(); }
  async disconnect() { this._connected = false; return true; }

  _httpGet(path) {
    return new Promise((resolve) => {
      const req = http.get({ hostname: this.host, port: this.port, path, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(body) }); }
          catch { resolve({ ok: res.statusCode < 400, data: null }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null }); });
    });
  }

  async isOnline() {
    const { ok } = await this._httpGet('/health');
    this._connected = ok;
    return ok;
  }

  async getStatus() {
    const { ok, data } = await this._httpGet('/status');
    this._connected = ok;

    return {
      type: 'tally-encoder',
      connected: ok,
      live: !!(data?.streaming || data?.live),
      bitrateKbps: data?.bitrateKbps || data?.bitrate ? Math.round((data.bitrate || 0) / 1000) : null,
      fps: data?.fps || null,
      cpuUsage: data?.cpuUsage || null,
      recording: false,
      details: ok ? `Tally Encoder${data?.inputType ? ` (${data.inputType})` : ''}` : 'Tally Encoder',
    };
  }
}

module.exports = { TallyEncoderAdapter };
