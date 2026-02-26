/**
 * EncoderBridge — Unified Streaming Encoder API
 *
 * Wraps all supported encoder types behind a single consistent interface.
 * Follows the same pattern as MixerBridge (mixerBridge.js + mixers/).
 *
 * Supported types:
 *   Software:  'obs', 'vmix', 'ecamm', 'tricaster'
 *   Monitoring: 'ndi' (receive-only monitoring via ffprobe/libndi_newtek)
 *   Hardware:  'blackmagic', 'aja', 'epiphan', 'teradek', 'birddog', 'tally-encoder'
 *   ATEM:     'atem-streaming' (ATEM Mini built-in encoder, monitored via ATEM SDK)
 *   RTMP-push: 'yolobox', 'custom-rtmp', 'rtmp-generic' (no API, CDN-only)
 *   Custom:    'custom' (user-provided HTTP status endpoint)
 *
 * All encoders stream to their CDN directly (YouTube, Facebook, etc.).
 * Only the Tally Encoder streams to the relay server.
 * Software encoders can optionally push a second RTMP to the relay.
 */

const { ObsEncoder }           = require('./encoders/obs');
const { VmixEncoder }          = require('./encoders/vmix');
const { EcammEncoder }         = require('./encoders/ecamm');
const { BlackmagicEncoder }    = require('./encoders/blackmagic');
const { AjaEncoder }           = require('./encoders/aja');
const { EpiphanEncoder }       = require('./encoders/epiphan');
const { TeradekEncoder }       = require('./encoders/teradek');
const { TallyEncoderAdapter }  = require('./encoders/tallyEncoder');
const { RtmpPushEncoder }      = require('./encoders/rtmpPush');
const { CustomEncoder }        = require('./encoders/custom');
const { NdiEncoder }           = require('./encoders/ndi');
const { TriCasterEncoder }     = require('./encoders/tricaster');
const { BirdDogEncoder }       = require('./encoders/birddog');

const DEFAULT_STATUS = {
  type: 'unknown', connected: false, live: false,
  bitrateKbps: null, fps: null, cpuUsage: null,
  recording: false, details: null,
};

class EncoderBridge {
  /**
   * @param {{ type: string, host?: string, port?: number, password?: string, label?: string, statusUrl?: string, source?: string }} config
   */
  constructor(config) {
    this.config = config;
    this.type = (config.type || '').toLowerCase();
    this._encoder = this._create(config);
  }

  _create({ type, host, port, password, label, statusUrl, source }) {
    const t = (type || '').toLowerCase();
    switch (t) {
      case 'obs':
        return new ObsEncoder({ host: host || 'localhost', port: port || 4455, password });
      case 'vmix':
        return new VmixEncoder({ host: host || 'localhost', port: port || 8088 });
      case 'ecamm':
        return new EcammEncoder({ host: host || 'localhost', port: port || 65194 });
      case 'blackmagic':
        return new BlackmagicEncoder({ host, port: port || 80 });
      case 'aja':
        return new AjaEncoder({ host, port: port || 80, password });
      case 'epiphan':
        return new EpiphanEncoder({ host, port: port || 80, password });
      case 'teradek':
        return new TeradekEncoder({ host, port: port || 80, password });
      case 'tricaster':
        return new TriCasterEncoder({ host, port: port || 5951, password, label });
      case 'birddog':
        return new BirdDogEncoder({ host, port: port || 8080, password, label, source: source || statusUrl || '' });
      case 'tally-encoder':
        return new TallyEncoderAdapter({ host, port: port || 7070 });
      case 'ndi':
        return new NdiEncoder({ host: source || host, label });
      case 'custom':
        return new CustomEncoder({ host, port: port || 80, statusUrl, label });
      case 'atem-streaming':
        // ATEM Mini built-in streaming — no separate encoder to connect to.
        // Streaming status is monitored through the ATEM SDK connection.
        return new RtmpPushEncoder({ type: 'atem-streaming', label: 'ATEM Mini', host, port: port || 80 });
      case 'yolobox':
      case 'custom-rtmp':
      case 'rtmp-generic':
        return new RtmpPushEncoder({ type: t, label, host, port: port || 80 });
      default:
        return new RtmpPushEncoder({ type: 'rtmp-generic', label: label || type, host, port: port || 80 });
    }
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  async connect() {
    try { return await this._encoder.connect(); }
    catch { return false; }
  }

  async disconnect() {
    try { return await this._encoder.disconnect(); }
    catch { return true; }
  }

  // ─── STATUS ───────────────────────────────────────────────────────────────────

  async isOnline() {
    try { return await this._encoder.isOnline(); }
    catch { return false; }
  }

  async getStatus() {
    try {
      const s = await this._encoder.getStatus();
      return { ...DEFAULT_STATUS, ...s, type: s.type || this.type };
    } catch {
      return { ...DEFAULT_STATUS, type: this.type };
    }
  }

  // ─── STREAM CONTROL ──────────────────────────────────────────────────────────

  async startStream() {
    if (this._encoder.startStream) return this._encoder.startStream();
    return null;
  }

  async stopStream() {
    if (this._encoder.stopStream) return this._encoder.stopStream();
    return null;
  }

  // ─── RECORD CONTROL (hardware encoders) ───────────────────────────────────────

  async startRecord() {
    if (this._encoder.startRecord) return this._encoder.startRecord();
    return null;
  }

  async stopRecord() {
    if (this._encoder.stopRecord) return this._encoder.stopRecord();
    return null;
  }

  // ─── PASSTHROUGH ──────────────────────────────────────────────────────────────

  /** For RTMP-push encoders (YoloBox, etc.), relay sets live status externally */
  setLive(live) {
    if (this._encoder.setLive) this._encoder.setLive(live);
  }

  /** Provide external OBS instance for OBS encoder (avoids double-connect) */
  setObs(obs) {
    if (this._encoder.setObs) this._encoder.setObs(obs);
  }

  /** Access underlying adapter for device-specific methods */
  get adapter() { return this._encoder; }
}

module.exports = { EncoderBridge };
