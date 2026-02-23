/**
 * Custom Encoder Adapter
 *
 * For any encoder with an HTTP status endpoint. The user provides host, port,
 * and an optional status URL path. The adapter polls that URL and tries to
 * extract streaming status from the JSON response.
 *
 * Expected response fields (all optional):
 *   { streaming, live, bitrate, bitrateKbps, fps, recording, status, state }
 */

const http = require('http');
const https = require('https');

class CustomEncoder {
  constructor({ host, port = 80, statusUrl = '/status', label = '' } = {}) {
    this.host = host;
    this.port = port;
    this.statusPath = statusUrl || '/status';
    this.label = label || 'Custom Encoder';
    this._connected = false;
  }

  async connect()    { return this.isOnline(); }
  async disconnect() { this._connected = false; return true; }

  _httpGet(path) {
    return new Promise((resolve) => {
      const lib = this.port === 443 ? https : http;
      const req = lib.get({ hostname: this.host, port: this.port, path, timeout: 5000 }, (res) => {
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
    const { ok } = await this._httpGet(this.statusPath);
    this._connected = ok;
    return ok;
  }

  async getStatus() {
    const { ok, data } = await this._httpGet(this.statusPath);
    this._connected = ok;

    // Best-effort field extraction from arbitrary JSON
    const live = !!(data?.streaming || data?.live || data?.state === 'streaming' || data?.status === 'streaming');
    const bitrateKbps = data?.bitrateKbps || (data?.bitrate ? Math.round(data.bitrate / 1000) : null);
    const fps = data?.fps || null;
    const recording = !!(data?.recording);

    return {
      type: 'custom',
      connected: ok,
      live,
      bitrateKbps,
      fps,
      cpuUsage: data?.cpuUsage || null,
      recording,
      details: this.label,
    };
  }
}

module.exports = { CustomEncoder };
