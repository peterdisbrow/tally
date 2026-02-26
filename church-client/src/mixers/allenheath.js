/**
 * Allen & Heath SQ / dLive Driver
 * Uses OSC on port 51326 (SQ series) or 51327 (dLive).
 *
 * Key convention difference vs Behringer X32:
 *  SQ mute:  1 = muted,  0 = unmuted  (OPPOSITE of X32)
 *  X32 on:   0 = muted,  1 = active
 * This driver normalises internally — muteChannel() always mutes regardless of console.
 */

const { OSCClient } = require('../osc');

class AllenHeathMixer {
  /**
   * @param {{ host: string, port?: number, model?: string }} opts
   */
  constructor({ host, port = 51326, model = 'SQ' }) {
    this.host = host;
    this.port = port;
    this.model = model;
    this._osc = null;
    this._online = false;
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  async connect() {
    this._osc = new OSCClient({ host: this.host, port: this.port });

    try {
      await this._osc.query('/sq/alive', [], 3000);
      this._online = true;
    } catch {
      this._online = false;
    }
  }

  async disconnect() {
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
      await this._osc.query('/sq/alive', [], 2000);
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
      const [aliveResp, faderResp, muteResp, sceneResp] = await Promise.all([
        this._osc.query('/sq/alive', [], 2000).catch(() => null),
        this._osc.query('/main/lr/fader', [], 2000).catch(() => null),
        this._osc.query('/main/lr/mute', [], 2000).catch(() => null),
        this._osc.query('/scene/current', [], 2000).catch(() => null),
      ]);

      const online = !!aliveResp;
      this._online = online;

      const mainFader = faderResp?.args?.[0]?.value ?? 0;
      // A&H SQ: mute 1 = muted, 0 = unmuted
      const muteVal  = muteResp?.args?.[0]?.value ?? 0;
      const mainMuted = muteVal === 1;
      const scene = sceneResp?.args?.[0]?.value ?? null;

      return { online, model: this.model, firmware: '', mainFader, mainMuted, scene };
    } catch {
      return { online: false, model: this.model, firmware: '', mainFader: 0, mainMuted: false, scene: null };
    }
  }

  /**
   * Returns { fader, muted } for channel n.
   */
  async getChannelStatus(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const n = parseInt(ch);

    const [faderResp, muteResp] = await Promise.all([
      this._osc.query(`/ch/${n}/fader`, [], 2000),
      this._osc.query(`/ch/${n}/mute`, [], 2000),
    ]);

    const fader   = faderResp?.args?.[0]?.value ?? 0;
    const muteVal = muteResp?.args?.[0]?.value ?? 0;
    const muted   = muteVal === 1; // A&H: 1 = muted

    return { fader, muted };
  }

  // ─── CHANNEL CONTROL ─────────────────────────────────────────────────────────

  async muteChannel(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    // A&H: 1 = muted
    this._osc.send(`/ch/${parseInt(ch)}/mute`, [{ type: 'i', value: 1 }]);
  }

  async unmuteChannel(ch) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    // A&H: 0 = unmuted
    this._osc.send(`/ch/${parseInt(ch)}/mute`, [{ type: 'i', value: 0 }]);
  }

  async setFader(ch, level) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const clamped = Math.max(0, Math.min(1, parseFloat(level)));
    this._osc.send(`/ch/${parseInt(ch)}/fader`, [{ type: 'f', value: clamped }]);
  }

  // ─── MASTER CONTROL ──────────────────────────────────────────────────────────

  async muteMaster() {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/main/lr/mute', [{ type: 'i', value: 1 }]);
  }

  async unmuteMaster() {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/main/lr/mute', [{ type: 'i', value: 0 }]);
  }

  // ─── SCENES ──────────────────────────────────────────────────────────────────

  async recallScene(n) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    this._osc.send('/scene/recall', [{ type: 'i', value: parseInt(n) }]);
  }

  /** No-op — A&H SQ does not have a clearSolos equivalent via OSC. */
  async clearSolos() {
    // No OSC command available for A&H SQ solo clear
  }

  // ─── CHANNEL PROCESSING (best-effort) ───────────────────────────────────────

  async setChannelName(ch, name) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const truncated = String(name || '').slice(0, 8); // SQ supports up to 8 chars
    this._osc.send(`/ch/${parseInt(ch)}/name`, [{ type: 's', value: truncated }]);
  }

  async setHpf(ch, { enabled = true, frequency = 80 } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const n = parseInt(ch);
    this._osc.send(`/ch/${n}/hpf/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    if (frequency != null) {
      // A&H SQ uses normalised 0–1 for HPF freq — approximate mapping
      const f = Math.max(0, Math.min(1, Math.log(frequency / 20) / Math.log(400 / 20)));
      this._osc.send(`/ch/${n}/hpf/freq`, [{ type: 'f', value: f }]);
    }
  }

  async setEq(ch, { enabled = true, bands = [] } = {}) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const n = parseInt(ch);
    // SQ EQ OSC support is limited — try known addresses, fail silently
    try {
      this._osc.send(`/ch/${n}/eq/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    } catch { /* some SQ firmware may not support this */ }
    // Individual band control is NRPN/MIDI-based on SQ — not available via OSC
    if (bands.length > 0) {
      console.warn(`🎛️  A&H ${this.model}: per-band EQ via OSC is not supported — use console directly`);
    }
  }

  async setCompressor(ch, params = {}) {
    console.warn(`🎛️  A&H ${this.model}: compressor settings not available via OSC — use console directly`);
  }

  async setGate(ch, params = {}) {
    console.warn(`🎛️  A&H ${this.model}: gate settings not available via OSC — use console directly`);
  }

  async setFullChannelStrip(ch, strip) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    const applied = [];
    const skipped = [];

    if (strip.name != null) { await this.setChannelName(ch, strip.name); applied.push('name'); }
    if (strip.hpf) { await this.setHpf(ch, strip.hpf); applied.push('hpf'); }
    if (strip.eq) {
      try { await this.setEq(ch, strip.eq); applied.push('eq-enable'); } catch { skipped.push('eq'); }
    }
    if (strip.compressor) skipped.push('compressor');
    if (strip.gate) skipped.push('gate');
    if (strip.fader != null) { await this.setFader(ch, strip.fader); applied.push('fader'); }
    if (strip.mute === true) { await this.muteChannel(ch); applied.push('mute'); }
    else if (strip.mute === false) { await this.unmuteChannel(ch); applied.push('unmute'); }

    if (skipped.length > 0) {
      console.warn(`🎛️  A&H ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available via OSC`);
    }
  }

  async saveScene(n, name) {
    if (!this._osc) throw new Error(`${this.model} not connected`);
    // Try SQ scene save — may not work on all firmware
    try {
      this._osc.send('/scene/save', [{ type: 'i', value: parseInt(n) }]);
    } catch {
      console.warn(`🎛️  A&H ${this.model}: scene save via OSC may not be supported`);
    }
  }
}

module.exports = { AllenHeathMixer };
