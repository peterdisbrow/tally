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
const {
  hpfFreqToFloat, eqFreqToFloat, eqGainToFloat, eqQToFloat,
  compThreshToFloat, compRatioToIndex, compAttackToFloat, compReleaseToFloat, compKneeToFloat,
  gateThreshToFloat, gateRangeToFloat, gateAttackToFloat, gateHoldToFloat, gateReleaseToFloat,
  clamp,
} = require('./x32-osc-map');

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

  // ─── CHANNEL NAME / SCRIBBLE STRIP ──────────────────────────────────────────

  /**
   * Set the scribble-strip label for a channel.
   * @param {number} ch  1-based channel number
   * @param {string} name  Up to 12 characters
   */
  async setChannelName(ch, name) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const truncated = String(name || '').slice(0, 12);
    this._osc.send(`/ch/${this._ch(ch)}/config/name`, [{ type: 's', value: truncated }]);
  }

  // ─── HIGH-PASS FILTER ───────────────────────────────────────────────────────

  /**
   * @param {number} ch  1-based channel number
   * @param {{ enabled?: boolean, frequency?: number }} opts
   */
  async setHpf(ch, { enabled = true, frequency = 80 } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const pad = this._ch(ch);
    this._osc.send(`/ch/${pad}/preamp/hpon`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    if (frequency != null) {
      this._osc.send(`/ch/${pad}/preamp/hpf`, [{ type: 'f', value: hpfFreqToFloat(frequency) }]);
    }
  }

  // ─── 4-BAND PARAMETRIC EQ ───────────────────────────────────────────────────

  /**
   * @param {number} ch  1-based channel number
   * @param {{ enabled?: boolean, bands?: Array<{band:number, type?:number, frequency?:number, gain?:number, q?:number}> }} opts
   *   band.type: 0=LCut, 1=LShelf, 2=PEQ, 3=VEQ, 4=HShelf, 5=HCut
   *   band.frequency: Hz (20–20000)
   *   band.gain: dB (-15 to +15)
   *   band.q: Q factor (0.3–10)
   */
  async setEq(ch, { enabled = true, bands = [] } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const pad = this._ch(ch);

    this._osc.send(`/ch/${pad}/eq/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);

    for (const b of bands) {
      const n = clamp(b.band || 1, 1, 4);
      if (b.type != null)
        this._osc.send(`/ch/${pad}/eq/${n}/type`, [{ type: 'i', value: clamp(b.type, 0, 5) }]);
      if (b.frequency != null)
        this._osc.send(`/ch/${pad}/eq/${n}/f`, [{ type: 'f', value: eqFreqToFloat(b.frequency) }]);
      if (b.gain != null)
        this._osc.send(`/ch/${pad}/eq/${n}/g`, [{ type: 'f', value: eqGainToFloat(b.gain) }]);
      if (b.q != null)
        this._osc.send(`/ch/${pad}/eq/${n}/q`, [{ type: 'f', value: eqQToFloat(b.q) }]);
    }
  }

  // ─── COMPRESSOR (Dynamics 1) ────────────────────────────────────────────────

  /**
   * @param {number} ch  1-based channel number
   * @param {{ enabled?: boolean, threshold?: number, ratio?: number, attack?: number, release?: number, knee?: number }} opts
   *   threshold: dB (-60 to 0)
   *   ratio: e.g. 4 for 4:1 — snapped to nearest X32 preset
   *   attack: ms (0–120)
   *   release: ms (5–4000)
   *   knee: 0–5
   */
  async setCompressor(ch, { enabled = true, threshold, ratio, attack, release, knee } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const pad = this._ch(ch);

    this._osc.send(`/ch/${pad}/dyn/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    // Ensure it's in compressor mode (not expander)
    this._osc.send(`/ch/${pad}/dyn/mode`, [{ type: 'i', value: 0 }]); // 0 = COMP

    if (threshold != null)
      this._osc.send(`/ch/${pad}/dyn/thr`, [{ type: 'f', value: compThreshToFloat(threshold) }]);
    if (ratio != null)
      this._osc.send(`/ch/${pad}/dyn/ratio`, [{ type: 'i', value: compRatioToIndex(ratio) }]);
    if (attack != null)
      this._osc.send(`/ch/${pad}/dyn/attack`, [{ type: 'f', value: compAttackToFloat(attack) }]);
    if (release != null)
      this._osc.send(`/ch/${pad}/dyn/release`, [{ type: 'f', value: compReleaseToFloat(release) }]);
    if (knee != null)
      this._osc.send(`/ch/${pad}/dyn/knee`, [{ type: 'f', value: compKneeToFloat(knee) }]);
  }

  // ─── GATE (Dynamics 2) ──────────────────────────────────────────────────────

  /**
   * @param {number} ch  1-based channel number
   * @param {{ enabled?: boolean, threshold?: number, range?: number, attack?: number, hold?: number, release?: number, mode?: number }} opts
   *   threshold: dB (-80 to 0)
   *   range: dB (3–80)
   *   attack: ms (0.02–300)
   *   hold: ms (0.02–2000)
   *   release: ms (5–4000)
   *   mode: 0=EXP2, 1=EXP3, 2=EXP4, 3=GATE, 4=DUCK
   */
  async setGate(ch, { enabled = false, threshold, range, attack, hold, release, mode } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const pad = this._ch(ch);

    this._osc.send(`/ch/${pad}/gate/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);

    if (mode != null)
      this._osc.send(`/ch/${pad}/gate/mode`, [{ type: 'i', value: clamp(mode, 0, 4) }]);
    if (threshold != null)
      this._osc.send(`/ch/${pad}/gate/thr`, [{ type: 'f', value: gateThreshToFloat(threshold) }]);
    if (range != null)
      this._osc.send(`/ch/${pad}/gate/range`, [{ type: 'f', value: gateRangeToFloat(range) }]);
    if (attack != null)
      this._osc.send(`/ch/${pad}/gate/attack`, [{ type: 'f', value: gateAttackToFloat(attack) }]);
    if (hold != null)
      this._osc.send(`/ch/${pad}/gate/hold`, [{ type: 'f', value: gateHoldToFloat(hold) }]);
    if (release != null)
      this._osc.send(`/ch/${pad}/gate/release`, [{ type: 'f', value: gateReleaseToFloat(release) }]);
  }

  // ─── FULL CHANNEL STRIP (batch) ─────────────────────────────────────────────

  /**
   * Apply a complete channel strip in one call.
   * @param {number} ch  1-based channel number
   * @param {object} strip  Channel strip settings
   */
  async setFullChannelStrip(ch, strip) {
    if (!this._osc) throw new Error(`${this.model} not connected`);

    if (strip.name != null)       await this.setChannelName(ch, strip.name);
    if (strip.hpf)                await this.setHpf(ch, strip.hpf);
    if (strip.eq)                 await this.setEq(ch, strip.eq);
    if (strip.compressor)         await this.setCompressor(ch, strip.compressor);
    if (strip.gate)               await this.setGate(ch, strip.gate);
    if (strip.fader != null)      await this.setFader(ch, strip.fader);
    if (strip.mute === true)      await this.muteChannel(ch);
    else if (strip.mute === false) await this.unmuteChannel(ch);
  }

  // ─── SCENE SAVE (best-effort) ───────────────────────────────────────────────

  /**
   * Attempt to save current console state as a scene.
   * X32 OSC scene save is limited / firmware-dependent.
   * @param {number} sceneNumber  0-based scene index
   * @param {string} [name]  Optional scene name
   */
  async saveScene(sceneNumber, name) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const idx = parseInt(sceneNumber) || 0;
    // Try to name the scene slot first
    if (name) {
      this._osc.send(`/-show/showfile/scene/${String(idx).padStart(3, '0')}/name`, [{ type: 's', value: String(name).slice(0, 14) }]);
    }
    // Attempt to store current state into that scene slot
    // Note: This may not work on all firmware versions
    this._osc.send(`/-show/showfile/scene/${String(idx).padStart(3, '0')}/save`, []);
  }
}

module.exports = { BehringerMixer };
