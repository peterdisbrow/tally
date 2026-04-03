/**
 * vMix Encoder Adapter
 *
 * Thin wrapper around the existing VMix class that returns the common
 * encoder status shape. vMix serves as both switcher and encoder.
 */

const { VMix } = require('../vmix');

class VmixEncoder {
  constructor({ host = 'localhost', port = 8088 } = {}) {
    this._vmix = new VMix({ host, port });
  }

  async connect()    { return true; }
  async disconnect() { return true; }

  async isOnline() {
    return this._vmix.isRunning();
  }

  async getStatus() {
    try {
      const s = await this._vmix.getStatus();
      return {
        type: 'vmix',
        connected: !!s.running,
        live: !!s.streaming,
        bitrateKbps: null,
        fps: null,
        cpuUsage: null,
        recording: !!s.recording,
        version: s.version || null,
        details: `${s.edition || 'vMix'} ${s.version || ''}`.trim(),
      };
    } catch {
      return {
        type: 'vmix',
        connected: false,
        live: false,
        bitrateKbps: null,
        fps: null,
        cpuUsage: null,
        recording: false,
        details: 'vMix',
      };
    }
  }

  async startStream() { return this._vmix.startStream(); }
  async stopStream()  { return this._vmix.stopStream(); }
}

module.exports = { VmixEncoder };
