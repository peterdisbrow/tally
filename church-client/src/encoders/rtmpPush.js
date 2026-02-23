/**
 * RTMP-Push Encoder Adapter
 *
 * For devices that push RTMP to the relay server and have no local API.
 * Covers: Blackmagic Web Presenter, YoloBox, Custom RTMP, Generic RTMP.
 *
 * Status.live is populated externally by the relay's runtime.encoderActive flag.
 */

class RtmpPushEncoder {
  constructor({ type = 'rtmp-generic', label = '' } = {}) {
    this.type = type;
    this.label = label || this._defaultLabel(type);
    this._live = false;   // set externally via setLive()
  }

  _defaultLabel(type) {
    const labels = {
      blackmagic: 'Blackmagic Web Presenter',
      yolobox: 'YoloBox',
      'custom-rtmp': 'Custom RTMP',
      'rtmp-generic': 'RTMP Device',
    };
    return labels[type] || 'RTMP Device';
  }

  async connect()    { return true; }
  async disconnect() { return true; }
  async isOnline()   { return true; } // no API to check — assumed available if configured

  /** Called by the agent when relay reports encoderActive */
  setLive(live) { this._live = !!live; }

  async getStatus() {
    return {
      type: this.type,
      connected: true,
      live: this._live,
      bitrateKbps: null,
      fps: null,
      cpuUsage: null,
      recording: false,
      details: this.label,
    };
  }
}

module.exports = { RtmpPushEncoder };
