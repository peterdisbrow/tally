/**
 * MixerBridge — Unified Audio Console API
 *
 * Wraps Behringer/Midas, Allen & Heath, and Yamaha drivers behind a
 * single consistent interface. All callers use MixerBridge; the driver
 * choice is made from config.type.
 *
 * Supported types:
 *   'behringer' → Behringer X32 / X-Air (port 10023)
 *   'midas'     → Midas M32 / M32R (same protocol as Behringer, port 10023)
 *   'allenheath'→ Allen & Heath SQ / dLive (port 51326)
 *   'yamaha'    → Yamaha CL / QL / TF (port 8765 or 49280)
 */

const { BehringerMixer } = require('./mixers/behringer');
const { AllenHeathMixer } = require('./mixers/allenheath');
const { YamahaMixer }     = require('./mixers/yamaha');

class MixerBridge {
  /**
   * @param {{ type: string, host: string, port?: number, model?: string }} config
   */
  constructor(config) {
    this.config = config;
    this.type   = (config.type || '').toLowerCase();
    this._mixer = null;

    this._mixer = this._create(config);
  }

  _create({ type, host, port, model }) {
    const t = (type || '').toLowerCase();
    switch (t) {
      case 'behringer':
      case 'x32':
        return new BehringerMixer({ host, port: port || 10023, model: model || 'X32' });
      case 'midas':
        // Midas M32 uses identical OSC protocol to Behringer X32
        return new BehringerMixer({ host, port: port || 10023, model: model || 'M32' });
      case 'allenheath':
        return new AllenHeathMixer({ host, port: port || 51326, model: model || 'SQ' });
      case 'yamaha':
        return new YamahaMixer({ host, port, model: model || 'CL' });
      default:
        throw new Error(`Unknown mixer type: "${type}". Use x32, behringer, midas, allenheath, or yamaha.`);
    }
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  async connect()     { return this._mixer.connect(); }
  async disconnect()  { return this._mixer.disconnect(); }

  // ─── STATUS ───────────────────────────────────────────────────────────────────

  async isOnline() {
    try { return await this._mixer.isOnline(); }
    catch { return false; }
  }

  /**
   * Returns { online, type, model, mainFader, mainMuted, scene }
   */
  async getStatus() {
    try {
      const s = await this._mixer.getStatus();
      return { ...s, type: this.type };
    } catch {
      return { online: false, type: this.type, model: this.config.model || '', mainFader: 0, mainMuted: false, scene: null };
    }
  }

  // ─── CHANNEL CONTROL ─────────────────────────────────────────────────────────

  async muteChannel(ch)      { return this._mixer.muteChannel(ch); }
  async unmuteChannel(ch)    { return this._mixer.unmuteChannel(ch); }
  async getChannelStatus(ch) { return this._mixer.getChannelStatus(ch); }
  async setFader(ch, level)  { return this._mixer.setFader(ch, level); }

  // ─── MASTER CONTROL ──────────────────────────────────────────────────────────

  async muteMaster()   { return this._mixer.muteMaster(); }
  async unmuteMaster() { return this._mixer.unmuteMaster(); }

  // ─── SCENES & SOLOS ──────────────────────────────────────────────────────────

  async recallScene(n) { return this._mixer.recallScene(n); }

  /**
   * Clear all solos. Only Behringer X32/M32 support this; no-op on others.
   */
  async clearSolos()   { return this._mixer.clearSolos(); }
}

module.exports = { MixerBridge };
