/**
 * Blackmagic Web Presenter / Streaming Encoder Adapter
 *
 * Blackmagic Web Presenter HD/4K, Streaming Encoder HD/4K.
 * REST API v1: http://IP/control/api/v1/
 * No auth required. Firmware 3.4+.
 *
 * Ref: https://documents.blackmagicdesign.com/DeveloperManuals/RESTAPIBlackmagicWebPresenter.pdf
 */

const http = require('http');

class BlackmagicEncoder {
  constructor({ host, port = 80 } = {}) {
    this.host = host;
    this.port = port;
    this._connected = false;
    this._productName = 'Blackmagic Web Presenter';
    this._softwareVersion = '';
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  _request(method, path, body = null) {
    return new Promise((resolve) => {
      const fullPath = `/control/api/v1${path}`;
      const opts = {
        hostname: this.host, port: this.port, path: fullPath, method,
        timeout: 5000,
        headers: {},
      };
      if (body) {
        const payload = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }

      const req = http.request(opts, (res) => {
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => {
          if (res.statusCode === 204) return resolve({ ok: true, data: null, status: 204 });
          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(raw), status: res.statusCode }); }
          catch { resolve({ ok: res.statusCode < 400, data: null, status: res.statusCode }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null, status: 0 }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, status: 0 }); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    const online = await this.isOnline();
    if (online) {
      const prodRes = await this._request('GET', '/system/product');
      if (prodRes.ok && prodRes.data) {
        this._productName = prodRes.data.productName || 'Blackmagic Web Presenter';
        this._softwareVersion = prodRes.data.softwareVersion || '';
      }
    }
    return online;
  }

  async disconnect() { this._connected = false; return true; }

  async isOnline() {
    const res = await this._request('GET', '/livestreams/0');
    this._connected = res.ok;
    return res.ok;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    const [streamRes, sysRes] = await Promise.all([
      this._request('GET', '/livestreams/0'),
      this._request('GET', '/system'),
    ]);

    this._connected = streamRes.ok;

    if (!streamRes.ok) {
      return {
        type: 'blackmagic', connected: false, live: false,
        bitrateKbps: null, fps: null, cpuUsage: null, recording: false,
        details: this._productName,
      };
    }

    const s = streamRes.data || {};
    const status = s.status || 'Idle';  // Idle, Connecting, Streaming, Flushing, Interrupted
    const live = status === 'Streaming' || status === 'Connecting';
    const bitrateKbps = s.bitrate ? Math.round(s.bitrate / 1000) : null;
    const duration = s.duration || null;
    const cache = s.cache || null;
    const videoFormat = s.effectiveVideoFormat || '';

    // Extract FPS from video format string like "1920x1080p30"
    let fps = null;
    const fpsMatch = videoFormat.match(/[pi](\d+(?:\.\d+)?)/);
    if (fpsMatch) fps = parseFloat(fpsMatch[1]);

    let details = this._productName;
    if (this._softwareVersion) details += ` v${this._softwareVersion}`;
    if (live && duration) {
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      details += ` — Streaming ${mins}m${secs}s`;
    } else if (status !== 'Idle') {
      details += ` — ${status}`;
    }
    if (videoFormat) details += ` · ${videoFormat}`;
    if (cache != null && cache > 50) details += ` · Cache ${cache}%`;

    return {
      type: 'blackmagic',
      connected: true,
      live,
      bitrateKbps,
      fps,
      cpuUsage: null,
      recording: false,  // Web Presenter doesn't record
      details,
    };
  }

  // ── Stream control ────────────────────────────────────────────────────────

  async startStream() { return this._request('PUT', '/livestreams/0/start'); }
  async stopStream()  { return this._request('PUT', '/livestreams/0/stop'); }

  // ── Platform / CDN configuration ──────────────────────────────────────────

  /** Get current streaming platform config */
  async getActivePlatform() {
    const res = await this._request('GET', '/livestreams/0/activePlatform');
    return res.ok ? res.data : null;
  }

  /** Set streaming platform config: { platform, server, key, quality, url } */
  async setActivePlatform(config) {
    return this._request('PUT', '/livestreams/0/activePlatform', config);
  }

  /** List available platform names */
  async getPlatforms() {
    const res = await this._request('GET', '/livestreams/platforms');
    return res.ok ? res.data : [];
  }

  /** Get platform service config (servers, quality profiles) */
  async getPlatformConfig(platformName) {
    const res = await this._request('GET', `/livestreams/platforms/${encodeURIComponent(platformName)}`);
    return res.ok ? res.data : null;
  }

  // ── System ────────────────────────────────────────────────────────────────

  async getVideoFormat() {
    const res = await this._request('GET', '/system/videoFormat');
    return res.ok ? res.data : null;
  }

  async setVideoFormat(format) {
    return this._request('PUT', '/system/videoFormat', format);
  }

  async getSupportedVideoFormats() {
    const res = await this._request('GET', '/system/supportedVideoFormats');
    return res.ok ? (res.data?.formats || []) : [];
  }

  async getAudioSources() {
    const res = await this._request('GET', '/monitorOutput/audioSources');
    return res.ok ? res.data : [];
  }

  async setAudioSource(source) {
    return this._request('PUT', '/monitorOutput/audioSources/active', { audioSource: source });
  }
}

module.exports = { BlackmagicEncoder };
