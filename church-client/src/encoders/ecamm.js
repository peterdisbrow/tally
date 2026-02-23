/**
 * Ecamm Live Encoder Adapter
 *
 * Mac-only streaming software with HTTP remote control API.
 * Discovery: Bonjour/mDNS service "_ecammliveremote._tcp" (port is dynamic).
 * Fallback port: 65194 if Bonjour unavailable.
 *
 * All requests: HTTP GET with required headers.
 * Responses: JSON (single values as arrays [val], lists as {items: [...]}).
 *
 * Ref: https://github.com/bitfocus/companion-module-ecamm-live
 */

const http = require('http');
const crypto = require('crypto');

// Generate a persistent client UUID
const CLIENT_UUID = 'tally-' + crypto.randomBytes(10).toString('hex');

class EcammEncoder {
  constructor({ host = 'localhost', port = 65194 } = {}) {
    this.host = host;
    this.port = port;
    this._connected = false;
    this._info = {};
    this._scenes = [];
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  _get(path) {
    return new Promise((resolve) => {
      const opts = {
        hostname: this.host, port: this.port, path,
        method: 'GET', timeout: 3000,
        headers: {
          'User-Agent': 'Tally/1.0',
          'EcammLive-UUID': CLIENT_UUID,
          'EcammLive-ClientName': 'Tally',
        },
      };

      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(body) }); }
          catch { resolve({ ok: res.statusCode < 400, data: null }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null }); });
      req.end();
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    // TODO: Could add Bonjour/mDNS discovery here for dynamic port
    return this.isOnline();
  }

  async disconnect() { this._connected = false; return true; }

  async isOnline() {
    const res = await this._get('/getInfo');
    this._connected = res.ok;
    if (res.ok && res.data) this._info = res.data;
    return res.ok;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    const res = await this._get('/getInfo');
    this._connected = res.ok;

    if (!res.ok) {
      return {
        type: 'ecamm', connected: false, live: false,
        bitrateKbps: null, fps: null, cpuUsage: null, recording: false,
        details: 'Ecamm Live',
      };
    }

    const info = res.data || {};
    this._info = info;

    // ButtonLabel tells us the state:
    // "Go Live" = not streaming, "End Broadcast" = streaming
    // "Start Recording" = not recording, "Stop Recording" = recording
    const btnLabel = info.ButtonLabel || '';
    const pauseLabel = info.PauseButtonLabel || '';

    const live = btnLabel.toLowerCase().includes('end') ||
                 btnLabel.toLowerCase().includes('stop broadcast');
    const recording = btnLabel.toLowerCase().includes('stop recording');
    const muted = !!(info.Mute);
    const viewers = parseInt(info.Viewers) || 0;
    const scene = info.CurrentScene || '';

    let details = 'Ecamm Live';
    if (live) details += ' — LIVE';
    if (recording) details += ' — Recording';
    if (viewers > 0) details += ` · ${viewers} viewers`;
    if (muted) details += ' · Muted';

    return {
      type: 'ecamm',
      connected: true,
      live,
      bitrateKbps: null,
      fps: null,
      cpuUsage: null,
      recording,
      details,
    };
  }

  // ── Stream control ────────────────────────────────────────────────────────

  /** Start stream — only clicks the button if not already live */
  async startStream() {
    const status = await this.getStatus();
    if (status.live) return { ok: true, data: 'already live' };
    return this._get('/setClickButton');
  }

  /** Stop stream — only clicks the button if currently live */
  async stopStream() {
    const status = await this.getStatus();
    if (!status.live) return { ok: true, data: 'not live' };
    return this._get('/setClickButton');
  }

  /** Toggle pause (recording) */
  async togglePause() { return this._get('/setClickPauseButton'); }

  // ── Scene control ─────────────────────────────────────────────────────────

  async getScenes() {
    const res = await this._get('/getSceneList');
    if (res.ok && res.data?.items) {
      this._scenes = res.data.items;
      return res.data.items;
    }
    return [];
  }

  async setScene(uuid) { return this._get(`/setScene?id=${encodeURIComponent(uuid)}`); }
  async nextScene()    { return this._get('/setNext'); }
  async prevScene()    { return this._get('/setPrev'); }

  // ── Audio control ─────────────────────────────────────────────────────────

  async toggleMute()   { return this._get('/setMute'); }

  // ── Input control ─────────────────────────────────────────────────────────

  async getInputs() {
    const res = await this._get('/getInputs');
    return res.ok && res.data?.items ? res.data.items : [];
  }

  async setInput(uuid) { return this._get(`/setInput?id=${encodeURIComponent(uuid)}`); }

  // ── Overlay / PiP ─────────────────────────────────────────────────────────

  async togglePIP() { return this._get('/setPIP'); }

  async getOverlays() {
    const res = await this._get('/getOverlayList');
    return res.ok && res.data?.items ? res.data.items : [];
  }
}

module.exports = { EcammEncoder };
