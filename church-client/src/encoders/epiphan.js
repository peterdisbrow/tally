/**
 * Epiphan Pearl Encoder Adapter
 *
 * Epiphan Pearl / Pearl-2 / Pearl Mini / Pearl Nano — hardware video encoders.
 * REST API v2: /api/v2.0/channels, /api/v2.0/recorders, etc.
 * Legacy fallback: /api/channels, /admin/channel{N}/set_params.cgi
 * Auth: HTTP Basic (admin:password)
 *
 * Ref: https://www.epiphan.com/userguides/pearl-2/Content/integrate/pearlSystemAPIguide.htm
 *      https://github.com/bitfocus/companion-module-epiphan-pearl
 */

const http = require('http');

class EpiphanEncoder {
  constructor({ host, port = 80, password = '', username = 'admin' } = {}) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this._connected = false;
    this._apiBase = '/api';   // auto-upgraded to /api/v2.0 if supported
    this._channels = [];
    this._recorders = [];
    this._productName = 'Epiphan Pearl';
    this._firmware = null;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  _authHeader() {
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
  }

  _request(method, path, body = null) {
    return new Promise((resolve) => {
      const opts = {
        hostname: this.host, port: this.port, path, method,
        timeout: 5000,
        headers: { Authorization: this._authHeader() },
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

  async _api(method, path, body = null) {
    // Transparently use v2 base if detected
    const fullPath = path.startsWith('/admin/') ? path : `${this._apiBase}${path}`;
    return this._request(method, fullPath, body);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    // Detect API v2
    const vRes = await this._request('GET', '/api/v2.0/system/firmware/version');
    if (vRes.ok && vRes.data) {
      const ver = String(vRes.data).replace(/\./g, '');
      if (parseInt(ver) >= 42401) this._apiBase = '/api/v2.0';
    }

    // Fetch initial data
    const online = await this.isOnline();
    if (online) {
      // Get firmware/product info
      const fwRes = await this._api('GET', '/system/firmware');
      if (fwRes.ok && fwRes.data?.result) {
        this._productName = fwRes.data.result.product_name || 'Epiphan Pearl';
        this._firmware = fwRes.data.result.version || null;
      }
    }
    return online;
  }

  async disconnect() { this._connected = false; return true; }

  async isOnline() {
    const res = await this._api('GET', '/channels');
    this._connected = res.ok;
    if (res.ok && res.data?.result) this._channels = res.data.result;
    return res.ok;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    // Fetch channels with publisher + encoder info
    const chRes = await this._api('GET', '/channels?publishers=yes&encoders=yes');
    this._connected = chRes.ok;

    if (!chRes.ok) {
      return {
        type: 'epiphan', connected: false, live: false,
        bitrateKbps: null, fps: null, cpuUsage: null, recording: false,
        details: this._productName,
      };
    }

    const channels = chRes.data?.result || [];
    this._channels = channels;

    // Check publisher status across all channels
    let anyLive = false;
    for (const ch of channels) {
      const pubRes = await this._api('GET', `/channels/${ch.id}/publishers/status`);
      if (pubRes.ok && pubRes.data?.result) {
        for (const pub of pubRes.data.result) {
          if (pub.status?.started || pub.status?.state === 'started') anyLive = true;
        }
      }
    }

    // Check recorder status
    const recRes = await this._api('GET', '/recorders/status');
    let anyRecording = false;
    if (recRes.ok && recRes.data?.result) {
      this._recorders = recRes.data.result;
      anyRecording = recRes.data.result.some(r => r.status?.state === 'started' || r.status?.state === 'recording');
    }

    // System status (v2 only)
    let cpuLoad = null;
    let cpuTemp = null;
    if (this._apiBase === '/api/v2.0') {
      const sysRes = await this._api('GET', '/system/status');
      if (sysRes.ok && sysRes.data?.result) {
        cpuLoad = sysRes.data.result.cpuload ?? null;
        cpuTemp = sysRes.data.result.cputemp ?? null;
      }
    }

    let details = this._productName;
    if (anyLive) details += ' — Streaming';
    if (anyRecording) details += ' — Recording';
    if (cpuTemp) details += ` · ${cpuTemp}°C`;
    details += ` · ${channels.length} ch`;

    return {
      type: 'epiphan',
      connected: true,
      live: anyLive,
      bitrateKbps: null,
      fps: null,
      cpuUsage: cpuLoad,
      recording: anyRecording,
      details,
      firmwareVersion: this._firmware || null,
    };
  }

  // ── Stream control ────────────────────────────────────────────────────────

  /** Start all publishers on first channel (or specify channelId) */
  async startStream(channelId) {
    const id = channelId || this._channels[0]?.id;
    if (!id) return null;
    return this._api('POST', `/channels/${id}/publishers/control/start`);
  }

  async stopStream(channelId) {
    const id = channelId || this._channels[0]?.id;
    if (!id) return null;
    return this._api('POST', `/channels/${id}/publishers/control/stop`);
  }

  /** Start/stop specific publisher */
  async startPublisher(channelId, publisherId) {
    return this._api('POST', `/channels/${channelId}/publishers/${publisherId}/control/start`);
  }
  async stopPublisher(channelId, publisherId) {
    return this._api('POST', `/channels/${channelId}/publishers/${publisherId}/control/stop`);
  }

  // ── Recording control ─────────────────────────────────────────────────────

  async startRecord(recorderId) {
    const id = recorderId || this._recorders[0]?.id;
    if (!id) return null;
    return this._api('POST', `/recorders/${id}/control/start`);
  }

  async stopRecord(recorderId) {
    const id = recorderId || this._recorders[0]?.id;
    if (!id) return null;
    return this._api('POST', `/recorders/${id}/control/stop`);
  }

  // ── Layout control ────────────────────────────────────────────────────────

  async getLayouts(channelId) {
    const id = channelId || this._channels[0]?.id;
    if (!id) return [];
    const res = await this._api('GET', `/channels/${id}/layouts`);
    return res.ok ? (res.data?.result || []) : [];
  }

  async setActiveLayout(channelId, layoutId) {
    return this._api('PUT', `/channels/${channelId}/layouts/active`, { id: layoutId });
  }

  // ── Legacy CGI config (streaming URL, bitrate, etc.) ──────────────────────

  async setStreamingParams(channelId, params = {}) {
    // params: { rtmp_url, rtmp_stream, vbitrate, framesize, fpslimit, codec }
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const streamIdx = params._streamIndex || 0;
    return this._request('GET', `/admin/channel${channelId}/stream${streamIdx}/set_params.cgi?${qs}`);
  }

  async getStreamingParams(channelId, keys = ['publish_type', 'rtmp_url', 'rtmp_stream', 'vbitrate', 'framesize', 'fpslimit']) {
    const qs = keys.join('&');
    return this._request('GET', `/admin/channel${channelId}/get_params.cgi?${qs}`);
  }
}

module.exports = { EpiphanEncoder };
