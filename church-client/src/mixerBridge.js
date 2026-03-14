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
 *   'allenheath'→ Allen & Heath SQ (hybrid OSC 51326 + TCP MIDI 51325)
 *   'avantis'   → Allen & Heath Avantis (TCP MIDI port 51325)
 *   'dlive'     → Allen & Heath dLive (TCP MIDI port 51325, same as Avantis)
 *   'yamaha'    → Yamaha CL / QL / TF (port 8765 or 49280)
 */

const { EventEmitter }    = require('events');
const { BehringerMixer }  = require('./mixers/behringer');
const { AllenHeathMixer } = require('./mixers/allenheath');
const { AvantisMixer }    = require('./mixers/avantis');
const { YamahaMixer }     = require('./mixers/yamaha');

// Default tolerance for fader level comparison (float values 0.0-1.0)
const DEFAULT_FADER_TOLERANCE = 0.02;

class MixerBridge extends EventEmitter {
  /**
   * @param {{ type: string, host: string, port?: number, model?: string }} config
   */
  constructor(config) {
    super();
    this.config = config;
    this.type   = (config.type || '').toLowerCase();
    this._mixer = null;

    // Scene state storage: { sceneId → { channels: [{ channel, fader, muted }] } }
    this._expectedStates = new Map();

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
      case 'avantis':
        return new AvantisMixer({ host, port: port || 51325, model: model || 'Avantis' });
      case 'dlive':
        // dLive uses identical TCP MIDI protocol to Avantis (128 inputs vs 64)
        return new AvantisMixer({ host, port: port || 51325, model: model || 'dLive' });
      case 'yamaha':
        return new YamahaMixer({ host, port, model: model || 'CL' });
      default:
        throw new Error(`Unknown mixer type: "${type}". Use x32, behringer, midas, allenheath, avantis, dlive, or yamaha.`);
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

  // ─── CHANNEL PROCESSING ──────────────────────────────────────────────────────

  async setChannelName(ch, name)     { return this._mixer.setChannelName(ch, name); }
  async setHpf(ch, params)           { return this._mixer.setHpf(ch, params); }
  async setEq(ch, params)            { return this._mixer.setEq(ch, params); }
  async setCompressor(ch, params)    { return this._mixer.setCompressor(ch, params); }
  async setGate(ch, params)          { return this._mixer.setGate(ch, params); }
  async setFullChannelStrip(ch, strip) { return this._mixer.setFullChannelStrip(ch, strip); }

  // ─── PREAMP / PHANTOM ──────────────────────────────────────────────────────

  async setPreampGain(ch, gainDb)  { return this._mixer.setPreampGain(ch, gainDb); }
  async setHeadampGain(ch, gainDb) { return this._mixer.setHeadampGain(ch, gainDb); }
  async setPhantom(ch, enabled)    { return this._mixer.setPhantom(ch, enabled); }

  // ─── PAN / COLOR / ICON ────────────────────────────────────────────────────

  async setPan(ch, pan)            { return this._mixer.setPan(ch, pan); }
  async setChannelColor(ch, color) { return this._mixer.setChannelColor(ch, color); }
  async setChannelIcon(ch, icon)   { return this._mixer.setChannelIcon(ch, icon); }

  // ─── SEND LEVELS / BUS / DCA ───────────────────────────────────────────────

  async setSendLevel(ch, bus, level)    { return this._mixer.setSendLevel(ch, bus, level); }
  async assignToBus(ch, bus, enabled)   { return this._mixer.assignToBus(ch, bus, enabled); }
  async assignToDca(ch, dca, enabled)   { return this._mixer.assignToDca(ch, dca, enabled); }

  // ─── DCA CONTROL (SQ / Avantis / dLive) ──────────────────────────────────

  async muteDca(dca)            { return this._mixer.muteDca(dca); }
  async unmuteDca(dca)          { return this._mixer.unmuteDca(dca); }
  async setDcaFader(dca, level) { return this._mixer.setDcaFader(dca, level); }

  // ─── MUTE GROUPS (SQ only) ───────────────────────────────────────────────

  async activateMuteGroup(mg)   { return this._mixer.activateMuteGroup(mg); }
  async deactivateMuteGroup(mg) { return this._mixer.deactivateMuteGroup(mg); }

  // ─── SOFTKEYS (SQ only) ──────────────────────────────────────────────────

  async pressSoftKey(key)       { return this._mixer.pressSoftKey(key); }

  // ─── METERING ──────────────────────────────────────────────────────────────

  async getMeters(channels)             { return this._mixer.getMeters(channels); }

  // ─── SCENES & SOLOS ──────────────────────────────────────────────────────────

  async recallScene(n)   { return this._mixer.recallScene(n); }
  async saveScene(n, nm) { return this._mixer.saveScene(n, nm); }
  async verifySceneSave(n) { return this._mixer.verifySceneSave(n); }

  /**
   * Clear all solos. Only Behringer X32/M32 support this; no-op on others.
   */
  async clearSolos()   { return this._mixer.clearSolos(); }

  // ─── SCENE RECALL VERIFICATION ──────────────────────────────────────────────

  /**
   * Capture the current mixer state for specified channels.
   * Returns a snapshot of fader levels and mute states.
   *
   * @param {number[]} channels  Array of 1-based channel numbers
   * @returns {Promise<{ channels: Array<{ channel: number, fader: number, muted: boolean }> }>}
   */
  async captureCurrentState(channels) {
    if (!channels || channels.length === 0) {
      throw new Error('At least one channel must be specified');
    }

    const results = [];
    for (const ch of channels) {
      try {
        const status = await this._mixer.getChannelStatus(ch);
        results.push({
          channel: ch,
          fader: status.fader,
          muted: status.muted,
        });
      } catch {
        // If a channel can't be queried, record defaults
        results.push({ channel: ch, fader: 0, muted: false });
      }
    }
    return { channels: results };
  }

  /**
   * Save an expected state for a scene, to be used for future verification.
   *
   * @param {string|number} sceneId  Scene identifier
   * @param {{ channels: Array<{ channel: number, fader: number, muted: boolean }> }} state
   */
  saveExpectedState(sceneId, state) {
    if (sceneId == null) throw new Error('sceneId is required');
    if (!state || !Array.isArray(state.channels) || state.channels.length === 0) {
      throw new Error('state must contain a non-empty channels array');
    }
    this._expectedStates.set(String(sceneId), state);
  }

  /**
   * Retrieve a previously saved expected state for a scene.
   *
   * @param {string|number} sceneId
   * @returns {{ channels: Array<{ channel: number, fader: number, muted: boolean }> } | undefined}
   */
  getExpectedState(sceneId) {
    return this._expectedStates.get(String(sceneId));
  }

  /**
   * Verify that a recalled scene actually applied correctly by comparing
   * the current mixer state against an expected state.
   *
   * @param {string|number} sceneId  Scene identifier
   * @param {{ channels: Array<{ channel: number, fader: number, muted: boolean }> }} expectedState
   *   The expected state to verify against. If omitted, uses a previously
   *   saved state from saveExpectedState().
   * @param {{ tolerance?: number }} [options]
   *   tolerance: fader level comparison tolerance (default 0.02)
   * @returns {Promise<{ verified: boolean, mismatches: Array<{ channel: number, expected: *, actual: *, parameter: string }> }>}
   */
  async verifySceneRecall(sceneId, expectedState, options = {}) {
    const tolerance = options.tolerance != null ? options.tolerance : DEFAULT_FADER_TOLERANCE;

    // Resolve expected state: use provided or look up saved
    const expected = expectedState || this._expectedStates.get(String(sceneId));
    if (!expected || !Array.isArray(expected.channels) || expected.channels.length === 0) {
      throw new Error(`No expected state provided or saved for scene "${sceneId}"`);
    }

    const mismatches = [];

    for (const exp of expected.channels) {
      let actual;
      try {
        actual = await this._mixer.getChannelStatus(exp.channel);
      } catch {
        // Can't query this channel — treat as a mismatch
        mismatches.push({
          channel: exp.channel,
          expected: { fader: exp.fader, muted: exp.muted },
          actual: null,
          parameter: 'unreachable',
        });
        continue;
      }

      // Compare fader level (with tolerance for float imprecision)
      if (exp.fader != null && Math.abs(actual.fader - exp.fader) > tolerance) {
        mismatches.push({
          channel: exp.channel,
          expected: exp.fader,
          actual: actual.fader,
          parameter: 'fader',
        });
      }

      // Compare mute state (exact boolean match)
      if (exp.muted != null && actual.muted !== exp.muted) {
        mismatches.push({
          channel: exp.channel,
          expected: exp.muted,
          actual: actual.muted,
          parameter: 'muted',
        });
      }
    }

    const verified = mismatches.length === 0;

    // Emit event on mismatch
    if (!verified) {
      this.emit('mixer_scene_mismatch', {
        sceneId,
        mismatches,
        type: this.type,
        timestamp: Date.now(),
      });
    }

    return { verified, mismatches };
  }
}

module.exports = { MixerBridge };
