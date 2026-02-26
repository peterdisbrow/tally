/**
 * OBS Encoder Adapter
 *
 * Wraps the OBS WebSocket connection for encoder status reporting.
 * Polls GetStats + GetStreamStatus to populate the common status shape.
 *
 * NOTE: The main agent still manages the OBS WebSocket connection directly
 * for switcher features (scenes, preview, etc.). This adapter piggybacks
 * on the agent's OBS instance when available, or creates its own connection.
 */

const OBSWebSocket = require('obs-websocket-js').default;

class ObsEncoder {
  constructor({ host = 'localhost', port = 4455, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this._obs = null;
    this._connected = false;
    this._streaming = false;
    this._recording = false;
    this._fps = null;
    this._cpuUsage = null;
    this._bitrateKbps = null;
    this._congestion = null;
    this._lastBytesTotal = 0;
    this._lastBytesTime = 0;
  }

  /** Accept an external OBS instance from the agent (avoids double connection) */
  setObs(obs) {
    this._obs = obs;
    // Only mark connected if the OBS instance is actually connected
    this._connected = !!(obs && obs.identified);
  }

  async connect() {
    if (this._obs) return this._connected;
    try {
      this._obs = new OBSWebSocket();
      const url = `ws://${this.host}:${this.port}`;
      await this._obs.connect(url, this.password || undefined);
      this._connected = true;

      this._obs.on('StreamStateChanged', (ev) => {
        this._streaming = ev.outputActive;
      });
      this._obs.on('RecordStateChanged', (ev) => {
        this._recording = ev.outputActive;
      });
      this._obs.on('ConnectionClosed', () => { this._connected = false; });
      return true;
    } catch {
      this._connected = false;
      return false;
    }
  }

  async disconnect() {
    if (this._obs) {
      try { this._obs.disconnect(); } catch { /* ignore */ }
      this._obs = null;
      this._connected = false;
    }
  }

  async isOnline() { return this._connected; }

  async getStatus() {
    if (!this._obs || !this._connected) {
      return { type: 'obs', connected: false, live: false, bitrateKbps: null, fps: null, cpuUsage: null, recording: false, details: 'OBS Studio' };
    }

    try {
      const stats = await this._obs.call('GetStats');
      this._fps = Math.round(stats.activeFps || 0);
      this._cpuUsage = Math.round((stats.cpuUsage || 0) * 100) / 100;
    } catch { /* ignore */ }

    try {
      const stream = await this._obs.call('GetStreamStatus');
      this._streaming = stream.outputActive;
      const now = Date.now();
      if (this._lastBytesTime && stream.outputBytes > this._lastBytesTotal) {
        const elapsed = (now - this._lastBytesTime) / 1000;
        this._bitrateKbps = Math.round(((stream.outputBytes - this._lastBytesTotal) * 8) / 1024 / elapsed);
      }
      this._lastBytesTotal = stream.outputBytes;
      this._lastBytesTime = now;
      this._congestion = stream.outputCongestion ?? null;
    } catch { /* ignore */ }

    try {
      const rec = await this._obs.call('GetRecordStatus');
      this._recording = rec.outputActive;
    } catch { /* ignore */ }

    return {
      type: 'obs',
      connected: true,
      live: this._streaming,
      bitrateKbps: this._bitrateKbps,
      fps: this._fps,
      cpuUsage: this._cpuUsage,
      recording: this._recording,
      details: 'OBS Studio',
    };
  }

  async startStream() {
    if (this._obs) await this._obs.call('StartStream');
  }
  async stopStream() {
    if (this._obs) await this._obs.call('StopStream');
  }
}

module.exports = { ObsEncoder };
