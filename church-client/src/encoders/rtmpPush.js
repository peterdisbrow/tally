/**
 * RTMP-Push Encoder Adapter
 *
 * For devices that push RTMP to the relay server and have no local API.
 * Covers: Blackmagic Web Presenter, YoloBox, Custom RTMP, Generic RTMP.
 *
 * Status.live is populated externally by the relay's runtime.encoderActive flag.
 */
const http = require('http');
const https = require('https');

class RtmpPushEncoder {
  constructor({ type = 'rtmp-generic', label = '', host = '', port = 80, statusPath = '/' } = {}) {
    this.type = type;
    this.label = label || this._defaultLabel(type);
    this.host = String(host || '').trim();
    this.port = Number(port) || 80;
    this.statusPath = String(statusPath || '/').startsWith('/') ? String(statusPath || '/') : `/${statusPath}`;
    this._live = false;   // set externally via setLive()
    this._bitrateKbps = null;  // set externally via setBitrate()
    this._fps = null;          // set externally via setFps()
    this._liveStartedAt = null; // track when stream went live
  }

  _defaultLabel(type) {
    const labels = {
      blackmagic: 'Blackmagic Web Presenter',
      'atem-streaming': 'ATEM Mini',
      yolobox: 'YoloBox',
      'youtube-live': 'YouTube Live',
      'facebook-live': 'Facebook Live',
      'vimeo-live': 'Vimeo Live',
      'custom-rtmp': 'Custom RTMP',
      'rtmp-generic': 'RTMP Device',
    };
    return labels[type] || 'RTMP Device';
  }

  async connect()    { return this.isOnline(); }
  async disconnect() { return true; }

  async isOnline() {
    // If no management IP is configured, this remains a configured-only integration.
    if (!this.host) return true;

    const protocol = this.port === 443 ? https : http;
    return new Promise((resolve) => {
      const req = protocol.get({
        hostname: this.host,
        port: this.port,
        path: this.statusPath || '/',
        timeout: 3000,
      }, (res) => {
        // Any HTTP response means the unit is reachable on-network.
        resolve(Number(res.statusCode) > 0);
        try { res.resume(); } catch { /* ignore */ }
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        try { req.destroy(); } catch { /* ignore */ }
        resolve(false);
      });
    });
  }

  /** Called by the agent when relay reports encoderActive */
  setLive(live) {
    const wasLive = this._live;
    this._live = !!live;
    if (live && !wasLive) this._liveStartedAt = Date.now();
    if (!live) { this._liveStartedAt = null; this._bitrateKbps = null; this._fps = null; }
  }

  /** Called by the relay when RTMP ingest metrics are available */
  setBitrate(kbps) { this._bitrateKbps = (kbps > 0) ? Math.round(kbps) : null; }
  setFps(fps) { this._fps = (fps > 0) ? Math.round(fps) : null; }

  async getStatus() {
    const reachable = await this.isOnline();

    // Build details string with live metrics when available
    let details = this.host
      ? `${this.label} (${this.host}:${this.port})${reachable ? ' · reachable' : ' · unreachable'}`
      : `${this.label} · configured`;

    if (this._live) {
      details += ' · 🔴 LIVE';
      if (this._bitrateKbps) {
        details += this._bitrateKbps >= 1000
          ? ` · ${(this._bitrateKbps / 1000).toFixed(1)} Mbps`
          : ` · ${this._bitrateKbps} kbps`;
      }
      if (this._fps) details += ` · ${this._fps}fps`;
      if (this._liveStartedAt) {
        const durSec = Math.floor((Date.now() - this._liveStartedAt) / 1000);
        const h = Math.floor(durSec / 3600);
        const m = Math.floor((durSec % 3600) / 60).toString().padStart(2, '0');
        details += ` · ${h}:${m}`;
      }
    }

    return {
      type: this.type,
      connected: this.host ? reachable : true,
      live: this._live,
      bitrateKbps: this._bitrateKbps,
      fps: this._fps,
      cpuUsage: null,
      recording: false,
      details,
    };
  }
}

module.exports = { RtmpPushEncoder };
