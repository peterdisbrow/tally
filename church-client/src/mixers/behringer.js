/**
 * Behringer X32 / Midas M32 Driver
 * Both consoles use identical OSC protocol on port 10023.
 *
 * Key conventions:
 *  - Channel 0=muted, 1=active  (opposite of Allen & Heath)
 *  - Fader 0.0–1.0, 0.75 ≈ 0 dB unity
 *  - /xremote must be sent every 9s to receive parameter change notifications
 */

const { OSCClient } = require('../osc');

class BehringerMixer {
  /**
   * @param {{ host: string, port?: number, model?: string }} opts
   */
  constructor({ host, port = 10023, model = 'X32' }) {
    this.host = host;
    this.port = port;
    this.model = model;
    this._osc = null;
    this._keepalive = null;
    this._online = false;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  /** Format 1-based channel number as 2-digit string: 1 → '01', 32 → '32'. */
  _ch(n) {
    return String(parseInt(n)).padStart(2, '0');
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  async connect() {
    this._osc = new OSCClient({ host: this.host, port: this.port });

    // Initial ping to see if online
    try {
      await this._osc.query('/info', [], 3000);
      this._online = true;
    } catch {
      this._online = false;
    }

    // Subscribe to parameter changes (required for real-time updates)
    this._osc.send('/xremote');

    // Keep-alive: X32 drops xremote subscriptions after 10s without a renewal
    this._keepalive = setInterval(() => {
      if (this._osc) this._osc.send('/xremote');
    }, 9000);
  }

  async disconnect() {
    if (this._keepalive) {
      clearInterval(this._keepalive);
      this._keepalive = null;
    }
    if (this._osc) {
      this._osc.close();
      this._osc = null;
    }
    this._online = false;
  }

  // ─── STATUS ───────────────────────────────────────────────────────────────────

  async isOnline() {
    if (!this._osc) return false;
    try {
      await this._osc.query('/info', [], 2000);
      this._online = true;
      return true;
    } catch {
      this._online = false;
      return false;
    }
  }

  /**
   * Returns { online, model, firmware, mainFader, mainMuted, scene }
   */
  async getStatus() {
    if (!this._osc) return { online: false, model: this.model, firmware: '', mainFader: 0, mainMuted: false, scene: null };

    try {
      const [infoResp, faderResp, muteResp, sceneResp] = await Promise.all([
        this._osc.query('/info', [], 2000).catch(() => null),
        this._osc.query('/main/st/mix/fader', [], 2000).catch(() => null),
        this._osc.query('/main/st/mix/on', [], 2000).catch(() => null),
        this._osc.query('/-show/prepos/current', [], 2000).catch(() => null),
      ]);

      const online = !!infoResp;
      this._online = online;

      // /info response: name, version, firmware, model (all strings)
      const firmware = infoResp?.args?.[1]?.value || '';
      const detectedModel = infoResp?.args?.[3]?.value || this.model;

      // X32: mainMuted when /main/st/mix/on === 0
      const mainFader = faderResp?.args?.[0]?.value ?? 0;
      const onValue   = muteResp?.args?.[0]?.value ?? 1;
      const mainMuted = onValue === 0;

      const scene = sceneResp?.args?.[0]?.value ?? null;

      return { online, model: detectedModel, firmware, mainFader, mainMuted, scene };
    } catch {
      return { online: false, model: this.model, firmware: '', mainFader: 0, mainMuted: false, scene: null };
    }
  }

  /**
   * Returns { fader, muted } for a single channel (1-32).
   */
  async getChannelStatus(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const pad = this._ch(ch);

    const [faderResp, muteResp] = await Promise.all([
      this._osc.query(`/ch/${pad}/mix/fader`, [], 2000),
      this._osc.query(`/ch/${pad}/mix/on`, [], 2000),
    ]);

    const fader = faderResp?.args?.[0]?.value ?? 0;
    const onVal = muteResp?.args?.[0]?.value ?? 1;
    const muted = onVal === 0; // X32: 0 = muted

    return { fader, muted };
  }

  // ─── CHANNEL CONTROL ─────────────────────────────────────────────────────────

  async muteChannel(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send(`/ch/${this._ch(ch)}/mix/on`, [{ type: 'i', value: 0 }]); // 0 = muted
  }

  async unmuteChannel(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send(`/ch/${this._ch(ch)}/mix/on`, [{ type: 'i', value: 1 }]); // 1 = active
  }

  async setFader(ch, level) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const clamped = Math.max(0, Math.min(1, parseFloat(level)));
    this._osc.send(`/ch/${this._ch(ch)}/mix/fader`, [{ type: 'f', value: clamped }]);
  }

  // ─── MASTER CONTROL ──────────────────────────────────────────────────────────

  async muteMaster() {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/main/st/mix/on', [{ type: 'i', value: 0 }]);
  }

  async unmuteMaster() {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/main/st/mix/on', [{ type: 'i', value: 1 }]);
  }

  // ─── SCENES & SOLOS ──────────────────────────────────────────────────────────

  async recallScene(n) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/scene/recall', [{ type: 'i', value: parseInt(n) }]);
  }

  async clearSolos() {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/-action/clearsolo');
  }
}

module.exports = { BehringerMixer };
