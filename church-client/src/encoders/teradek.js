/**
 * Teradek Encoder Adapter
 *
 * Teradek VidiU / VidiU Go / VidiU Pro / Cube — hardware streaming encoders.
 * CGI API: /cgi-bin/api.cgi (auth), /cgi-bin/system.cgi (status & control),
 *          /cgi-bin/json.cgi (device info & codec stats)
 * Auth: POST login returns session cookie.
 *
 * Ref: https://github.com/bitfocus/companion-module-teradek-vidiu
 */

const http = require('http');

class TeradekEncoder {
  constructor({ host, port = 80, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password || 'admin';  // VidiU defaults to 'admin'
    this._connected = false;
    this._cookie = '';
    this._productName = 'Teradek';
    this._serial = '';
    this._firmware = '';
    this._isVidiuGo = false;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  _request(method, path, postBody = null) {
    return new Promise((resolve) => {
      const opts = {
        hostname: this.host, port: this.port, path, method,
        timeout: 5000,
        headers: {},
      };
      if (this._cookie) {
        opts.headers.Cookie = `fw_ver=3.0.8; passwordChanged=true; serenity-session=${this._cookie}`;
      }
      if (postBody) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(postBody);
      }

      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          // Capture session cookie
          const sc = res.headers['set-cookie'];
          if (sc) {
            const str = Array.isArray(sc) ? sc.join('; ') : sc;
            const m = str.match(/serenity-session=([^;]+)/);
            if (m) this._cookie = m[1];
          }

          // Check for access denied
          if (body.includes('##Access denied#')) {
            return resolve({ ok: false, data: null, raw: body, denied: true });
          }

          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(body), raw: body }); }
          catch { resolve({ ok: res.statusCode < 400, data: null, raw: body }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null, raw: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, raw: '' }); });
      if (postBody) req.write(postBody);
      req.end();
    });
  }

  async _login() {
    const body = `command=login&user=admin&passwd=${encodeURIComponent(this.password)}`;
    const res = await this._request('POST', '/cgi-bin/api.cgi', body);
    if (res.raw && res.raw.includes('##Invalid password#')) return false;
    return !!this._cookie;
  }

  async _authedGet(path) {
    let res = await this._request('GET', path);
    if (res.denied) {
      await this._login();
      res = await this._request('GET', path);
    }
    return res;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    await this._login();
    const online = await this.isOnline();
    if (online) {
      // Get product info
      const info = await this._authedGet('/cgi-bin/json.cgi?command=geti&q=System.Info.Product');
      if (info.ok && info.data) {
        const d = info.data;
        this._productName = d['System.Info.Product.productname'] || 'Teradek';
        this._serial = d['System.Info.Product.serialnumber'] || '';
        this._firmware = d['System.Info.Product.productversion'] || '';
        this._isVidiuGo = this._productName.toLowerCase().includes('go');
      }
    }
    return online;
  }

  async disconnect() { this._connected = false; this._cookie = ''; return true; }

  async isOnline() {
    const res = await this._authedGet('/cgi-bin/system.cgi?command=status');
    this._connected = res.ok && !!res.data?.status;
    return this._connected;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    const sysRes = await this._authedGet('/cgi-bin/system.cgi?command=status');
    this._connected = sysRes.ok;

    if (!sysRes.ok || !sysRes.data?.status) {
      return {
        type: 'teradek', connected: false, live: false,
        bitrateKbps: null, fps: null, cpuUsage: null, recording: false,
        details: this._productName,
      };
    }

    const s = sysRes.data.status;
    const broadcastState = s['Broadcast-State'] || 'Ready';
    const live = broadcastState === 'Live' || broadcastState === 'Starting';
    const broadcastError = s['Broadcast-Error'] || 'none';

    // Recording: "1:..." means recording
    const recParts = (s['Record-Status'] || '').split(':');
    const recording = recParts[0] === '1';

    // Power: "source:percentage:unknown:charging"
    const powerParts = (s['System-Power'] || '').split(':');
    const batteryPct = powerParts[1] || null;

    // Video input: "type:state"
    const videoInput = (s['Video-Input'] || '').split(':')[0] || '';

    // Bitrate: from codec status (not available on VidiU Go)
    let bitrateKbps = null;
    if (!this._isVidiuGo) {
      const codecRes = await this._authedGet('/cgi-bin/json.cgi?command=geti&q=Codec.Status');
      if (codecRes.ok && codecRes.data) {
        try {
          const stream1 = JSON.parse(codecRes.data['Codec.Status.stream1'] || '{}');
          if (stream1.encoder?.current_bitrate) {
            bitrateKbps = Math.round(stream1.encoder.current_bitrate / 1000);
          }
        } catch { /* ignore */ }
      }
    }

    let details = this._productName;
    if (this._firmware) details += ` v${this._firmware}`;
    if (live) details += ` — ${broadcastState}`;
    if (recording) details += ' — Recording';
    if (broadcastError !== 'none') details += ` (⚠ ${broadcastError})`;
    if (batteryPct) details += ` · 🔋${batteryPct}%`;
    if (videoInput) details += ` · ${videoInput}`;

    return {
      type: 'teradek',
      connected: true,
      live,
      bitrateKbps,
      fps: null,
      cpuUsage: null,
      recording,
      details,
    };
  }

  // ── Stream / Record control ───────────────────────────────────────────────

  async startStream() { return this._authedGet('/cgi-bin/system.cgi?command=broadcast&action=start'); }
  async stopStream()  { return this._authedGet('/cgi-bin/system.cgi?command=broadcast&action=stop'); }
  async startRecord() { return this._authedGet('/cgi-bin/system.cgi?command=recording&action=start'); }
  async stopRecord()  { return this._authedGet('/cgi-bin/system.cgi?command=recording&action=stop'); }
}

module.exports = { TeradekEncoder };
