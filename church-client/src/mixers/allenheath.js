/**
 * Allen & Heath SQ Hybrid Driver (OSC + TCP MIDI)
 *
 * The SQ exposes two control interfaces:
 *   • OSC on port 51326 — channel naming, HPF frequency
 *   • TCP MIDI on port 51325 — mutes, faders, sends, DCAs, mute groups,
 *     scenes, SoftKeys, pan/balance, routing assigns
 *
 * This driver uses BOTH simultaneously for maximum capability:
 *   - TCP MIDI handles the heavy lifting (14-bit faders, full routing matrix)
 *   - OSC fills gaps MIDI can't cover (channel names, HPF frequency)
 *   - Bidirectional: incoming NRPN messages from the console update live state
 *
 * NRPN parameter tables sourced from the SQ MIDI Protocol Issue 5 and
 * verified against the Bitfocus Companion module implementation.
 *
 * Key convention (same as previous OSC driver):
 *   SQ mute:  1 = muted,  0 = unmuted  (OPPOSITE of X32)
 */

'use strict';

const { OSCClient } = require('../osc');
const { TcpMidi }   = require('../tcp-midi');

// ─── SQ MODEL COUNTS ─────────────────────────────────────────────────────────

const SQ_COUNTS = {
  inputs:     48,
  mixes:      12,
  groups:     12,
  fxReturns:   8,
  fxSends:     4,
  matrices:    3,
  dcas:        8,
  muteGroups:  8,
  scenes:    300,
};

// SoftKey counts per model
const SOFTKEY_COUNTS = { SQ5: 8, SQ6: 16, SQ7: 16 };

// ─── PORTS ───────────────────────────────────────────────────────────────────

const OSC_PORT  = 51326;
const MIDI_PORT = 51325;

// ─── NRPN HELPERS ────────────────────────────────────────────────────────────

/** Combine 7-bit MSB + LSB into 14-bit value. */
function makeNrpn(msb, lsb) { return (msb << 7) + lsb; }

/** Split 14-bit NRPN back to { msb, lsb }. */
function splitNrpn(n) { return { msb: (n >> 7) & 0x7F, lsb: n & 0x7F }; }

/** Calculate NRPN for a simple 1D parameter (mute, output level). */
function nrpn1D(baseMsb, baseLsb, index) {
  return splitNrpn(makeNrpn(baseMsb, baseLsb) + index);
}

/** Calculate NRPN for a 2D source-to-sink parameter (send level, assign, pan). */
function nrpn2D(baseMsb, baseLsb, sinkCount, source, sink) {
  return splitNrpn(makeNrpn(baseMsb, baseLsb) + (sinkCount * source) + sink);
}

// ─── NRPN BASE ADDRESS TABLES ────────────────────────────────────────────────

const MUTE = {
  inputChannel: { msb: 0x00, lsb: 0x00 },
  group:        { msb: 0x00, lsb: 0x30 },
  fxReturn:     { msb: 0x00, lsb: 0x3C },
  lr:           { msb: 0x00, lsb: 0x44 },
  mix:          { msb: 0x00, lsb: 0x45 },
  fxSend:       { msb: 0x00, lsb: 0x51 },
  matrix:       { msb: 0x00, lsb: 0x55 },
  dca:          { msb: 0x02, lsb: 0x00 },
  muteGroup:    { msb: 0x04, lsb: 0x00 },
};

const OUTPUT_LEVEL = {
  lr:     { msb: 0x4F, lsb: 0x00 },
  mix:    { msb: 0x4F, lsb: 0x01 },
  fxSend: { msb: 0x4F, lsb: 0x0D },
  matrix: { msb: 0x4F, lsb: 0x11 },
  dca:    { msb: 0x4F, lsb: 0x20 },
};

const OUTPUT_PAN = {
  lr:     { msb: 0x5F, lsb: 0x00 },
  mix:    { msb: 0x5F, lsb: 0x01 },
  matrix: { msb: 0x5F, lsb: 0x11 },
};

// Source-to-sink LEVEL base addresses
const SEND_LEVEL = {
  inputToLr:      { msb: 0x40, lsb: 0x00, sinks: 1 },
  inputToMix:     { msb: 0x40, lsb: 0x44, sinks: 12 },
  inputToFxSend:  { msb: 0x4C, lsb: 0x14, sinks: 4 },
  fxRetToLr:      { msb: 0x40, lsb: 0x3C, sinks: 1 },
  fxRetToMix:     { msb: 0x46, lsb: 0x14, sinks: 12 },
  fxRetToFxSend:  { msb: 0x4E, lsb: 0x04, sinks: 4 },
  groupToLr:      { msb: 0x40, lsb: 0x30, sinks: 1 },
  groupToMix:     { msb: 0x45, lsb: 0x04, sinks: 12 },
  groupToFxSend:  { msb: 0x4D, lsb: 0x54, sinks: 4 },
  groupToMatrix:  { msb: 0x4E, lsb: 0x4B, sinks: 3 },
  lrToMatrix:     { msb: 0x4E, lsb: 0x24, sinks: 3 },
  mixToMatrix:    { msb: 0x4E, lsb: 0x27, sinks: 3 },
};

// Source-to-sink ASSIGN base addresses
const SEND_ASSIGN = {
  inputToLr:      { msb: 0x60, lsb: 0x00, sinks: 1 },
  inputToMix:     { msb: 0x60, lsb: 0x44, sinks: 12 },
  inputToGroup:   { msb: 0x66, lsb: 0x74, sinks: 12 },
  inputToFxSend:  { msb: 0x6C, lsb: 0x14, sinks: 4 },
  fxRetToLr:      { msb: 0x60, lsb: 0x3C, sinks: 1 },
  fxRetToMix:     { msb: 0x66, lsb: 0x14, sinks: 12 },
  fxRetToGroup:   { msb: 0x6B, lsb: 0x34, sinks: 12 },
  fxRetToFxSend:  { msb: 0x6E, lsb: 0x04, sinks: 4 },
  groupToLr:      { msb: 0x60, lsb: 0x30, sinks: 1 },
  groupToMix:     { msb: 0x65, lsb: 0x04, sinks: 12 },
  groupToFxSend:  { msb: 0x6D, lsb: 0x54, sinks: 4 },
  groupToMatrix:  { msb: 0x6E, lsb: 0x4B, sinks: 3 },
  lrToMatrix:     { msb: 0x6E, lsb: 0x24, sinks: 3 },
  mixToMatrix:    { msb: 0x6E, lsb: 0x27, sinks: 3 },
};

// Source-to-sink PAN/BALANCE base addresses
const SEND_PAN = {
  inputToLr:      { msb: 0x50, lsb: 0x00, sinks: 1 },
  inputToMix:     { msb: 0x50, lsb: 0x44, sinks: 12 },
  fxRetToLr:      { msb: 0x50, lsb: 0x3C, sinks: 1 },
  fxRetToMix:     { msb: 0x56, lsb: 0x14, sinks: 12 },
  groupToLr:      { msb: 0x50, lsb: 0x30, sinks: 1 },
  groupToMix:     { msb: 0x55, lsb: 0x04, sinks: 12 },
  groupToMatrix:  { msb: 0x5E, lsb: 0x4B, sinks: 3 },
  lrToMatrix:     { msb: 0x5E, lsb: 0x24, sinks: 3 },
  mixToMatrix:    { msb: 0x5E, lsb: 0x27, sinks: 3 },
};

// ─── LEVEL CONVERSION (Linear Taper) ─────────────────────────────────────────

const LEVEL_0DB_DATA = 15196;
const LEVEL_SCALE    = 118.775;
const LEVEL_MAX_DATA = 16383;

/** Normalised 0.0–1.0 → 14-bit data value (Linear Taper). */
function normalToData(norm) {
  if (norm <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, norm)) * LEVEL_MAX_DATA);
}

/** 14-bit data value → normalised 0.0–1.0. */
function dataToNormal(data) {
  if (data <= 0) return 0;
  return Math.min(1, data / LEVEL_MAX_DATA);
}

/** Split 14-bit data value to { vc, vf }. */
function dataToVcVf(data) {
  return { vc: (data >> 7) & 0x7F, vf: data & 0x7F };
}

/** Combine vc + vf back to 14-bit data. */
function vcVfToData(vc, vf) { return (vc << 7) | vf; }

// ─── PAN CONVERSION ──────────────────────────────────────────────────────────

const PAN_CENTER_DATA = 8191;

/** Normalised 0.0 (left) – 1.0 (right), 0.5 = center → 14-bit pan data. */
function normalToPanData(norm) {
  return Math.round(Math.max(0, Math.min(1, norm)) * LEVEL_MAX_DATA);
}

// ─── NRPN MESSAGE BUILDERS ───────────────────────────────────────────────────

/**
 * Build a 12-byte NRPN Data Entry message (set a value).
 * SQ uses full 14-bit values (coarse + fine).
 */
function buildNrpnSet(midiCh, paramMsb, paramLsb, vc, vf) {
  const cc = 0xB0 | (midiCh & 0x0F);
  return [
    cc, 0x63, paramMsb & 0x7F,  // NRPN MSB
    cc, 0x62, paramLsb & 0x7F,  // NRPN LSB
    cc, 0x06, vc & 0x7F,        // Data Entry MSB (coarse)
    cc, 0x26, vf & 0x7F,        // Data Entry LSB (fine)
  ];
}

/**
 * Build a 9-byte NRPN Increment message (toggle or query).
 * val = 0x00 → toggle,  val = 0x7F → query
 */
function buildNrpnIncrement(midiCh, paramMsb, paramLsb, val) {
  const cc = 0xB0 | (midiCh & 0x0F);
  return [
    cc, 0x63, paramMsb & 0x7F,
    cc, 0x62, paramLsb & 0x7F,
    cc, 0x60, val & 0x7F,
  ];
}

/**
 * Build scene recall: CC 0 (Bank Select) + Program Change.
 */
function buildSceneRecall(midiCh, sceneNumber) {
  const n = Math.max(1, Math.min(SQ_COUNTS.scenes, parseInt(sceneNumber)));
  const zeroIdx = n - 1;
  const upper = (zeroIdx >> 7) & 0x0F;
  const lower = zeroIdx & 0x7F;
  const cc = 0xB0 | (midiCh & 0x0F);
  const pc = 0xC0 | (midiCh & 0x0F);
  return { bankMsg: [cc, 0x00, upper], pgmMsg: [pc, lower] };
}

/**
 * Build SoftKey press (Note On) or release (Note Off).
 */
function buildSoftKey(midiCh, keyIndex, press) {
  const note = 0x30 + (keyIndex & 0x0F);
  if (press) {
    return [0x90 | (midiCh & 0x0F), note, 0x7F];
  }
  return [0x80 | (midiCh & 0x0F), note, 0x00];
}

// ─── ALLEN & HEATH SQ MIXER ──────────────────────────────────────────────────

class AllenHeathMixer {
  /**
   * Convert a 1-based channel/DCA/group number to a safe 0-based index.
   * Returns 0 for any non-numeric or missing input so callers never receive NaN.
   * @param {*} val  1-based number from user input
   * @returns {number} 0-based index ≥ 0
   */
  static _idx(val) {
    return Math.max(0, (parseInt(val, 10) || 1) - 1);
  }

  /**
   * @param {{ host: string, port?: number, model?: string, midiChannel?: number }} opts
   *   model: 'SQ' | 'SQ5' | 'SQ6' | 'SQ7' (default 'SQ')
   *   midiChannel: 0–15 (default 0 = MIDI channel 1)
   */
  constructor({ host, port, model = 'SQ', midiChannel = 0 }) {
    this.host  = host;
    this.model = model.toUpperCase();
    this.midiCh = midiChannel & 0x0F;

    // OSC for channel naming + HPF (port 51326)
    this._osc = null;
    this._oscPort = port || OSC_PORT;

    // TCP MIDI for everything else (port 51325)
    this._tcp = new TcpMidi({ host, port: MIDI_PORT, autoReconnect: true });
    this._online = false;

    // Live state from bidirectional feedback
    this._state = {
      mutes:  {},   // { 'input:0': true, 'dca:3': false, ... }
      faders: {},   // { 'input:0': 15196, 'mix:2': 8000, ... }
      scene:  null,
    };

    // NRPN parsing state for incoming messages
    this._nrpnState = { paramMsb: null, paramLsb: null };

    // Wire TCP MIDI events
    this._tcp.on('connected', () => {
      this._online = true;
      console.log(`🎛️  ${this.model}: TCP MIDI connected to ${host}:${MIDI_PORT}`);
      this._queryInitialState();
    });
    this._tcp.on('disconnected', () => {
      this._online = false;
      console.log(`🎛️  ${this.model}: TCP MIDI disconnected`);
    });
    this._tcp.on('error', (err) => {
      console.warn(`🎛️  ${this.model}: TCP MIDI error — ${err.message}`);
      this._online = false;
    });
    this._tcp.on('midi', (msg) => this._handleIncoming(msg));
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  async connect() {
    // Connect both TCP MIDI and OSC
    try {
      await this._tcp.connect();
      this._online = true;
    } catch {
      this._online = false;
    }

    // OSC — best effort (used only for naming + HPF)
    try {
      this._osc = new OSCClient({ host: this.host, port: this._oscPort });
      await this._osc.query('/sq/alive', [], 3000).catch(() => null);
    } catch {
      this._osc = null;
    }
  }

  async disconnect() {
    this._tcp.disconnect();
    if (this._osc) { this._osc.close(); this._osc = null; }
    this._online = false;
  }

  async isOnline() {
    const reachable = await this._tcp.isOnline();
    this._online = reachable;
    return reachable;
  }

  async getStatus() {
    const online = await this.isOnline();
    // Query main LR level if connected
    const lrData = this._state.faders['lr:0'];
    const mainFader = lrData != null ? dataToNormal(lrData) : 0;
    const mainMuted = this._state.mutes['lr:0'] || false;
    return {
      online,
      model: this.model,
      firmware: '',
      mainFader,
      mainMuted,
      scene: this._state.scene,
    };
  }

  // ─── MUTE CONTROL ──────────────────────────────────────────────────────────

  async muteChannel(ch) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(ch);
    const addr = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x01));
  }

  async unmuteChannel(ch) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(ch);
    const addr = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x00));
  }

  async muteMaster() {
    if (!this._online) throw new Error(`${this.model} not connected`);
    this._tcp.send(buildNrpnSet(this.midiCh, MUTE.lr.msb, MUTE.lr.lsb, 0x00, 0x01));
  }

  async unmuteMaster() {
    if (!this._online) throw new Error(`${this.model} not connected`);
    this._tcp.send(buildNrpnSet(this.midiCh, MUTE.lr.msb, MUTE.lr.lsb, 0x00, 0x00));
  }

  // ─── DCA / MUTE GROUP CONTROL ──────────────────────────────────────────────

  /**
   * Mute a DCA (1-based).
   */
  async muteDca(dca) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(dca);
    const addr = nrpn1D(MUTE.dca.msb, MUTE.dca.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x01));
  }

  async unmuteDca(dca) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(dca);
    const addr = nrpn1D(MUTE.dca.msb, MUTE.dca.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x00));
  }

  /**
   * Set DCA fader level (normalised 0.0–1.0).
   */
  async setDcaFader(dca, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(dca);
    const addr = nrpn1D(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb, n);
    const data = normalToData(parseFloat(level));
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  /**
   * Activate a mute group (1-based).
   */
  async activateMuteGroup(mg) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(mg);
    const addr = nrpn1D(MUTE.muteGroup.msb, MUTE.muteGroup.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x01));
  }

  async deactivateMuteGroup(mg) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(mg);
    const addr = nrpn1D(MUTE.muteGroup.msb, MUTE.muteGroup.lsb, n);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, 0x00));
  }

  // ─── FADER CONTROL ─────────────────────────────────────────────────────────

  /**
   * Set input channel fader (normalised 0.0–1.0, 14-bit resolution).
   */
  async setFader(ch, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(ch);
    const addr = nrpn2D(SEND_LEVEL.inputToLr.msb, SEND_LEVEL.inputToLr.lsb, 1, n, 0);
    const data = normalToData(parseFloat(level));
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  /**
   * Get channel status from live-tracked state.
   */
  async getChannelStatus(ch) {
    const n = AllenHeathMixer._idx(ch);
    return {
      fader: this._state.faders[`input:${n}`] != null
        ? dataToNormal(this._state.faders[`input:${n}`])
        : 0,
      muted: this._state.mutes[`input:${n}`] || false,
    };
  }

  // ─── SEND LEVELS (the big upgrade) ─────────────────────────────────────────

  /**
   * Set send level from an input channel to a mix bus.
   * @param {number} inputCh  Input channel (1-based)
   * @param {number} mixBus   Mix bus (1-based, 1–12)
   * @param {number} level    Normalised 0.0–1.0
   */
  async setSendLevel(inputCh, mixBus, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const src = AllenHeathMixer._idx(inputCh);
    const snk = AllenHeathMixer._idx(mixBus);
    const addr = nrpn2D(SEND_LEVEL.inputToMix.msb, SEND_LEVEL.inputToMix.lsb, SQ_COUNTS.mixes, src, snk);
    const data = normalToData(parseFloat(level));
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  /**
   * Set send level from an input channel to an FX send.
   * @param {number} inputCh  Input channel (1-based)
   * @param {number} fxSend   FX send (1-based, 1–4)
   * @param {number} level    Normalised 0.0–1.0
   */
  async setFxSendLevel(inputCh, fxSend, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const src = AllenHeathMixer._idx(inputCh);
    const snk = AllenHeathMixer._idx(fxSend);
    const addr = nrpn2D(SEND_LEVEL.inputToFxSend.msb, SEND_LEVEL.inputToFxSend.lsb, SQ_COUNTS.fxSends, src, snk);
    const data = normalToData(parseFloat(level));
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  /**
   * Set output level for a mix bus (1-based).
   */
  async setMixLevel(mixBus, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(mixBus);
    const addr = nrpn1D(OUTPUT_LEVEL.mix.msb, OUTPUT_LEVEL.mix.lsb, n);
    const data = normalToData(parseFloat(level));
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  // ─── ROUTING ASSIGNS ───────────────────────────────────────────────────────

  /**
   * Assign/unassign an input channel to a mix bus.
   */
  async setInputToMixAssign(inputCh, mixBus, assigned) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const src = AllenHeathMixer._idx(inputCh);
    const snk = AllenHeathMixer._idx(mixBus);
    const addr = nrpn2D(SEND_ASSIGN.inputToMix.msb, SEND_ASSIGN.inputToMix.lsb, SQ_COUNTS.mixes, src, snk);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, assigned ? 0x01 : 0x00));
  }

  /**
   * Assign/unassign an input channel to a group.
   */
  async setInputToGroupAssign(inputCh, group, assigned) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const src = AllenHeathMixer._idx(inputCh);
    const snk = AllenHeathMixer._idx(group);
    const addr = nrpn2D(SEND_ASSIGN.inputToGroup.msb, SEND_ASSIGN.inputToGroup.lsb, SQ_COUNTS.groups, src, snk);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, 0x00, assigned ? 0x01 : 0x00));
  }

  // ─── PAN ───────────────────────────────────────────────────────────────────

  /**
   * Set input channel pan in LR.
   * @param {number} pan -1.0 (left) to +1.0 (right), 0 = center
   */
  async setPan(ch, pan) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = AllenHeathMixer._idx(ch);
    const p = Number(pan);
    if (!Number.isFinite(p)) throw new Error('pan must be a number');
    if (p < -1 || p > 1) throw new Error(`Pan out of range: ${pan} (valid: -1.0 to +1.0)`);

    // SQ NRPN pan is 0.0–1.0 with center at 0.5.
    const normalized = (p + 1) / 2;
    const addr = nrpn2D(SEND_PAN.inputToLr.msb, SEND_PAN.inputToLr.lsb, 1, n, 0);
    const data = normalToPanData(normalized);
    const { vc, vf } = dataToVcVf(data);
    this._tcp.send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
  }

  // ─── SCENE RECALL ──────────────────────────────────────────────────────────

  async recallScene(n) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const { bankMsg, pgmMsg } = buildSceneRecall(this.midiCh, parseInt(n));
    this._tcp.send(bankMsg);
    // 200ms delay between bank select and program change (SQ requirement)
    await new Promise(r => setTimeout(r, 200));
    this._tcp.send(pgmMsg);
  }

  async saveScene(n, name) {
    console.warn(`🎛️  ${this.model}: scene save not available via MIDI — save at console`);
  }

  async clearSolos() {
    // Not available via MIDI or OSC on SQ
  }

  // ─── SOFTKEYS ──────────────────────────────────────────────────────────────

  /**
   * Press and release a SoftKey (1-based).
   * SoftKeys can be mapped to any console function on the SQ surface.
   */
  async pressSoftKey(key) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const idx = AllenHeathMixer._idx(key);
    this._tcp.send(buildSoftKey(this.midiCh, idx, true));
    await new Promise(r => setTimeout(r, 100));
    this._tcp.send(buildSoftKey(this.midiCh, idx, false));
  }

  // ─── CHANNEL PROCESSING (OSC — MIDI can't do these) ────────────────────────

  async setChannelName(ch, name) {
    if (!this._osc) {
      console.warn(`🎛️  ${this.model}: OSC not connected — channel name requires OSC`);
      return;
    }
    const truncated = String(name || '').slice(0, 8);
    this._osc.send(`/ch/${parseInt(ch)}/name`, [{ type: 's', value: truncated }]);
  }

  async setHpf(ch, { enabled = true, frequency = 80 } = {}) {
    if (!this._osc) {
      console.warn(`🎛️  ${this.model}: OSC not connected — HPF requires OSC`);
      return;
    }
    const n = parseInt(ch);
    this._osc.send(`/ch/${n}/hpf/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    if (frequency != null) {
      const f = Math.max(0, Math.min(1, Math.log(frequency / 20) / Math.log(400 / 20)));
      this._osc.send(`/ch/${n}/hpf/freq`, [{ type: 'f', value: f }]);
    }
  }

  async setEq(ch, { enabled = true } = {}) {
    if (!this._osc) return;
    try {
      this._osc.send(`/ch/${parseInt(ch)}/eq/on`, [{ type: 'i', value: enabled ? 1 : 0 }]);
    } catch { /* some firmware may not support this */ }
    console.warn(`🎛️  ${this.model}: per-band EQ not available via MIDI or OSC — use console`);
  }

  async setCompressor() {
    console.warn(`🎛️  ${this.model}: compressor not available via MIDI or OSC — use console`);
  }

  async setGate() {
    console.warn(`🎛️  ${this.model}: gate not available via MIDI or OSC — use console`);
  }

  async setFullChannelStrip(ch, strip) {
    const applied = [];
    const skipped = [];

    if (strip.name != null) { await this.setChannelName(ch, strip.name); applied.push('name'); }
    if (strip.hpf) { await this.setHpf(ch, strip.hpf); applied.push('hpf'); }
    if (strip.eq) {
      try { await this.setEq(ch, strip.eq); applied.push('eq-enable'); } catch { skipped.push('eq'); }
    }
    if (strip.pan != null) { await this.setPan(ch, strip.pan); applied.push('pan'); }
    if (strip.fader != null) { await this.setFader(ch, strip.fader); applied.push('fader'); }
    if (strip.mute === true) { await this.muteChannel(ch); applied.push('mute'); }
    else if (strip.mute === false) { await this.unmuteChannel(ch); applied.push('unmute'); }
    if (strip.compressor) skipped.push('compressor');
    if (strip.gate) skipped.push('gate');

    if (skipped.length > 0) {
      console.warn(`🎛️  ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available via MIDI/OSC`);
    }

    return { applied, skipped };
  }

  // ─── BIDIRECTIONAL FEEDBACK (incoming MIDI from console) ────────────────────

  _handleIncoming(msg) {
    if (msg.length === 0) return;
    const status = msg[0];
    const hi = status & 0xF0;

    // ── Control Change: NRPN messages ──
    if (hi === 0xB0) {
      this._handleCC(msg);
      return;
    }

    // ── Program Change: scene feedback ──
    if (hi === 0xC0 && msg.length >= 2) {
      const upper = this._nrpnState.sceneBank ?? 0;
      this._state.scene = ((upper & 0x7F) << 7) + msg[1] + 1;
      return;
    }
  }

  _handleCC(msg) {
    if (msg.length < 3) return;
    const cc = msg[1];
    const val = msg[2];

    switch (cc) {
      case 0x00: // Bank Select (for scene recall)
        this._nrpnState.sceneBank = val;
        break;
      case 0x63: // NRPN MSB
        this._nrpnState.paramMsb = val;
        break;
      case 0x62: // NRPN LSB
        this._nrpnState.paramLsb = val;
        break;
      case 0x06: // Data Entry MSB (coarse value)
        this._nrpnState.vc = val;
        break;
      case 0x26: // Data Entry LSB (fine value) → NRPN message complete
        this._processNrpnValue(
          this._nrpnState.paramMsb,
          this._nrpnState.paramLsb,
          this._nrpnState.vc,
          val
        );
        break;
    }
  }

  /**
   * Process a complete incoming NRPN value.
   */
  _processNrpnValue(msb, lsb, vc, vf) {
    if (msb == null || lsb == null) return;
    const nrpn = makeNrpn(msb, lsb);
    const data = vcVfToData(vc, vf);

    // Classify by MSB range
    if (msb <= 0x04) {
      // Mute event
      const key = this._muteNrpnToKey(nrpn);
      if (key) this._state.mutes[key] = vf === 0x01;
    } else if (msb >= 0x40 && msb <= 0x4F) {
      // Fader / level event
      const key = this._levelNrpnToKey(nrpn);
      if (key) this._state.faders[key] = data;
    }
    // Pan (0x50–0x5F) could be tracked here if needed
  }

  /**
   * Map a mute NRPN address back to a state key like 'input:5'.
   */
  _muteNrpnToKey(nrpn) {
    for (const [type, base] of Object.entries(MUTE)) {
      const baseN = makeNrpn(base.msb, base.lsb);
      const count = this._countForMuteType(type);
      if (nrpn >= baseN && nrpn < baseN + count) {
        return `${type}:${nrpn - baseN}`;
      }
    }
    return null;
  }

  _countForMuteType(type) {
    const map = {
      inputChannel: SQ_COUNTS.inputs,
      group: SQ_COUNTS.groups,
      fxReturn: SQ_COUNTS.fxReturns,
      lr: 1,
      mix: SQ_COUNTS.mixes,
      fxSend: SQ_COUNTS.fxSends,
      matrix: SQ_COUNTS.matrices,
      dca: SQ_COUNTS.dcas,
      muteGroup: SQ_COUNTS.muteGroups,
    };
    return map[type] || 0;
  }

  /**
   * Map a level NRPN address back to a state key.
   * Covers input→LR sends and output levels.
   */
  _levelNrpnToKey(nrpn) {
    // Input→LR levels (input faders as perceived by the TD)
    const inLrBase = makeNrpn(SEND_LEVEL.inputToLr.msb, SEND_LEVEL.inputToLr.lsb);
    if (nrpn >= inLrBase && nrpn < inLrBase + SQ_COUNTS.inputs) {
      return `input:${nrpn - inLrBase}`;
    }
    // LR output level
    const lrBase = makeNrpn(OUTPUT_LEVEL.lr.msb, OUTPUT_LEVEL.lr.lsb);
    if (nrpn === lrBase) return 'lr:0';
    // Mix output levels
    const mixBase = makeNrpn(OUTPUT_LEVEL.mix.msb, OUTPUT_LEVEL.mix.lsb);
    if (nrpn >= mixBase && nrpn < mixBase + SQ_COUNTS.mixes) {
      return `mix:${nrpn - mixBase}`;
    }
    // DCA levels
    const dcaBase = makeNrpn(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb);
    if (nrpn >= dcaBase && nrpn < dcaBase + SQ_COUNTS.dcas) {
      return `dca:${nrpn - dcaBase}`;
    }
    return null;
  }

  // ─── INITIAL STATE QUERY ───────────────────────────────────────────────────

  /**
   * Query all mute and fader states from the console on connect.
   * Uses NRPN Increment with val=0x7F (query) and throttles to avoid
   * overwhelming the console.
   */
  async _queryInitialState() {
    // Brief pause after TCP handshake before querying — some SQ firmware
    // resets the connection if NRPN traffic arrives too quickly after connect
    await new Promise(r => setTimeout(r, 1000));

    const BATCH_SIZE = 8;
    const BATCH_DELAY = 500; // ms — conservative to avoid SQ connection reset

    const queries = [];

    // Query all input mutes
    for (let i = 0; i < SQ_COUNTS.inputs; i++) {
      const addr = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }
    // Query LR mute
    queries.push(buildNrpnIncrement(this.midiCh, MUTE.lr.msb, MUTE.lr.lsb, 0x7F));
    // Query DCA mutes
    for (let i = 0; i < SQ_COUNTS.dcas; i++) {
      const addr = nrpn1D(MUTE.dca.msb, MUTE.dca.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }
    // Query mix mutes
    for (let i = 0; i < SQ_COUNTS.mixes; i++) {
      const addr = nrpn1D(MUTE.mix.msb, MUTE.mix.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }

    // Send in batches
    for (let i = 0; i < queries.length; i++) {
      this._tcp.send(queries[i]);
      if ((i + 1) % BATCH_SIZE === 0) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    // Brief pause, then query key levels
    await new Promise(r => setTimeout(r, BATCH_DELAY));

    // Query LR output level
    const lrAddr = nrpn1D(OUTPUT_LEVEL.lr.msb, OUTPUT_LEVEL.lr.lsb, 0);
    this._tcp.send(buildNrpnIncrement(this.midiCh, lrAddr.msb, lrAddr.lsb, 0x7F));

    // Query DCA levels
    for (let i = 0; i < SQ_COUNTS.dcas; i++) {
      const addr = nrpn1D(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb, i);
      this._tcp.send(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }
  }
}

module.exports = { AllenHeathMixer };
