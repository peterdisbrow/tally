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
  setLive(live) { this._live = !!live; }

  async getStatus() {
    const reachable = await this.isOnline();
    const details = this.host
      ? `${this.label} (${this.host}:${this.port})${reachable ? ' · reachable' : ' · unreachable'}`
      : `${this.label} · configured`;

    return {
      type: this.type,
      connected: this.host ? reachable : true,
      live: this._live,
      bitrateKbps: null,
      fps: null,
      cpuUsage: null,
      recording: false,
      details,
    };
  }
}

module.exports = { RtmpPushEncoder };
