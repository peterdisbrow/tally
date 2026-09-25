/**
 * Allen & Heath SQ-5 / SQ-6 / SQ-7 driver — MIDI over TCP (port 51325).
 *
 * The SQ has exactly one remote-control protocol: MIDI over TCP/IP on port
 * 51325 (SQ MIDI Protocol, Issue 5). It has NO OSC — earlier versions of this
 * driver sent channel names / HPF over "OSC 51326" into the void and reported
 * success. Those functions now refuse honestly.
 *
 * Honesty contract (same as the X32 driver):
 *   • Every SET is followed by a GET (NRPN data-increment 0x7F); the command
 *     only succeeds when the console reports the new value back. No reply →
 *     "did not confirm"; wrong value → "did not apply".
 *   • Liveness is a GET round-trip, not "the TCP socket is open": an SQ whose
 *     cable is pulled behind a switch keeps a half-open socket for minutes.
 *   • Unknown values are null, never "unmuted" / 0.
 *   • Scene recall and SoftKeys have no read-back on the SQ; they are reported
 *     as "sent, not confirmable", never as done.
 *
 * NRPN tables: SQ MIDI Protocol Issue 5 (checked against the reference tables).
 * SQ mute data: 1 = muted, 0 = unmuted.
 */

'use strict';

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

const MIDI_PORT = 51325;
const LEGACY_OSC_PORT = 51326; // old configs stored this; the SQ never listened on it
const GET_TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 1500;
const LEVEL_TOLERANCE = 128;   // ≈1 dB — the SQ quantises some values on read-back
const PAN_TOLERANCE = 256;

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

// ─── LEVEL CONVERSION ────────────────────────────────────────────────────────
//
// Tally's mixer API speaks "fader position" 0.0–1.0 with the SAME law on every
// console (X32 law: 0.75 = 0 dB, 0.5 = −10 dB, 0.25 = −30 dB, 1.0 = +10 dB), so a
// remote "fader 75%" means unity whether the booth has an X32 or an SQ.
// The SQ's NRPN Linear Taper is ~118.8 data steps per dB with 0 dB = 15196
// (SQ MIDI Protocol Issue 5; A&H forum formula). 0 = −∞.

const LEVEL_0DB_DATA = 15196;
const LEVEL_SCALE    = 118.775;
const LEVEL_MAX_DATA = 16383;
const FADER_LAW = [
  { f: 0.00, dB: -90 },
  { f: 0.25, dB: -30 },
  { f: 0.50, dB: -10 },
  { f: 0.75, dB:   0 },
  { f: 1.00, dB:  10 },
];

function normalToDb(norm) {
  const n = Math.max(0, Math.min(1, Number(norm)));
  if (n <= 0) return -Infinity;
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
    if (n <= b.f) return a.dB + ((n - a.f) / (b.f - a.f)) * (b.dB - a.dB);
  }
  return 10;
}
function dbToNormal(dB) {
  if (!Number.isFinite(dB) || dB <= -90) return 0;
  for (let i = 1; i < FADER_LAW.length; i++) {
    const a = FADER_LAW[i - 1], b = FADER_LAW[i];
    if (dB <= b.dB) return a.f + ((dB - a.dB) / (b.dB - a.dB)) * (b.f - a.f);
  }
  return 1;
}

/** Fader position 0.0–1.0 → 14-bit SQ Linear Taper data. */
function normalToData(norm) {
  const dB = normalToDb(norm);
  if (dB === -Infinity || dB <= -89.9) return 0;
  return Math.max(0, Math.min(LEVEL_MAX_DATA, Math.round(LEVEL_0DB_DATA + dB * LEVEL_SCALE)));
}

/** 14-bit SQ Linear Taper data → fader position 0.0–1.0. */
function dataToNormal(data) {
  if (data == null) return null;
  if (data <= 0) return 0;
  return Math.round(dbToNormal((data - LEVEL_0DB_DATA) / LEVEL_SCALE) * 1000) / 1000;
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
   * Validate a 1-based number from user input and return the 0-based index.
   * Throws instead of silently mapping garbage to channel 1.
   */
  static _idx(val, max, what = 'channel') {
    const n = Number(val);
    if (!Number.isInteger(n) || n < 1 || (max && n > max)) {
      throw new Error(`Invalid ${what} "${val}"${max ? ` (valid: 1–${max})` : ''}`);
    }
    return n - 1;
  }

  static _level(level) {
    const l = Number(level);
    if (!Number.isFinite(l) || l < 0 || l > 1) throw new Error(`level must be 0.0–1.0 (got ${level})`);
    return l;
  }

  /** Send MIDI bytes and throw if the write fails (dead/stale socket). */
  _send(bytes) {
    if (!this._tcp.send(bytes)) {
      this._online = false;
      throw new Error(`${this.model} send failed — connection lost`);
    }
  }

  /**
   * @param {{ host: string, port?: number, midiPort?: number, model?: string, midiChannel?: number }} opts
   *   port / midiPort: TCP MIDI port (default 51325). A stored legacy 51326 is treated as 51325.
   *   model:       'SQ' | 'SQ5' | 'SQ6' | 'SQ7' (default 'SQ')
   *   midiChannel: 0–15 (default 0 = MIDI channel 1) — must match the console's MIDI setting
   */
  constructor({ host, port, midiPort, model = 'SQ', midiChannel = 0 }) {
    this.host  = host;
    this.model = String(model || 'SQ').toUpperCase().replace(/[\s-]/g, '');
    this.midiCh = (Number(midiChannel) || 0) & 0x0F;

    const p = Number(midiPort) || Number(port);
    this.port = p && p !== LEGACY_OSC_PORT ? p : MIDI_PORT;
    this._tcp = new TcpMidi({ host, port: this.port, autoReconnect: true });
    this._online = false;

    this._state = {
      mutes:  {},   // { 'input:0': true, 'lr:0': false, 'dca:3': false, 'muteGroup:0': true }
      faders: {},   // { 'input:0': 15196, 'lr:0': 15196, 'dca:2': 8000, 'mix:1': ... }
      scene:  null,
    };
    this._nrpnState = { paramMsb: null, paramLsb: null, vc: null, sceneBank: 0 };
    this._waiters = new Map(); // nrpn14 → [resolve]

    this._tcp.on('connected', () => {
      this._online = true;
      console.log(`🎛️  ${this.model}: TCP MIDI connected to ${host}:${this.port}`);
      this._queryInitialState().catch(() => {});
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
    try {
      await this._tcp.connect();
      this._online = true;
    } catch {
      this._online = false;
    }
  }

  async disconnect() {
    this._tcp.disconnect();
    this._online = false;
    for (const list of this._waiters.values()) for (const w of list) w(undefined);
    this._waiters.clear();
  }

  /**
   * Online = the console answers a GET (LR mute) — not merely "socket open".
   * Never opens a second TCP connection to the desk.
   */
  async isOnline() {
    if (!this._tcp.online) { this._online = false; return false; }
    const v = await this._get(MUTE.lr.msb, MUTE.lr.lsb, PROBE_TIMEOUT_MS).catch(() => undefined);
    this._online = v !== undefined;
    return this._online;
  }

  async getStatus() {
    const online = await this.isOnline();
    if (online) {
      await this._get(OUTPUT_LEVEL.lr.msb, OUTPUT_LEVEL.lr.lsb, PROBE_TIMEOUT_MS).catch(() => undefined);
    }
    const lrData = this._state.faders['lr:0'];
    const lrMute = this._state.mutes['lr:0'];
    return {
      online,
      model: this.model,
      firmware: '',
      mainFader: online && lrData != null ? dataToNormal(lrData) : null,
      mainMuted: online && lrMute != null ? lrMute : null,
      scene: this._state.scene,
    };
  }

  // ─── GET / VERIFIED SET ─────────────────────────────────────────────────────

  _requireOnline() {
    if (!this._online || !this._tcp.online) throw new Error(`${this.model} not connected`);
  }

  /** Ask the console for a parameter; resolves with its 14-bit value. */
  _get(msb, lsb, timeoutMs = GET_TIMEOUT_MS) {
    const nrpn = makeNrpn(msb, lsb);
    return new Promise((resolve, reject) => {
      let done = false;
      const waiter = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (v === undefined) reject(new Error('disconnected'));
        else resolve(v);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = this._waiters.get(nrpn);
        if (list) {
          const i = list.indexOf(waiter);
          if (i >= 0) list.splice(i, 1);
          if (!list.length) this._waiters.delete(nrpn);
        }
        reject(new Error('timeout'));
      }, timeoutMs);
      if (!this._waiters.has(nrpn)) this._waiters.set(nrpn, []);
      this._waiters.get(nrpn).push(waiter);
      if (!this._tcp.send(buildNrpnIncrement(this.midiCh, msb, lsb, 0x7F))) {
        waiter(undefined);
      }
    });
  }

  /**
   * SET then GET. Resolves only when the console reports the value back.
   * @param {{msb:number,lsb:number}} addr
   * @param {number} data 14-bit value
   * @param {string} label human description for errors
   * @param {number} [tol=0] allowed read-back difference
   */
  async _setVerified(addr, data, label, tol = 0) {
    this._requireOnline();
    const { vc, vf } = dataToVcVf(data);
    this._send(buildNrpnSet(this.midiCh, addr.msb, addr.lsb, vc, vf));
    let got;
    try {
      got = await this._get(addr.msb, addr.lsb);
    } catch {
      throw new Error(`${this.model} did not confirm ${label} — no reply from the console (check it is powered, on the network, and set to MIDI channel ${this.midiCh + 1})`);
    }
    if (Math.abs(got - data) > tol) {
      throw new Error(`${this.model} did not apply ${label} — console reports ${got}, expected ${data}`);
    }
    return got;
  }

  async _setMute(addr, muted, key, label) {
    await this._setVerified(addr, muted ? 1 : 0, label);
    this._state.mutes[key] = !!muted;
  }

  // ─── MUTE CONTROL ──────────────────────────────────────────────────────────

  async muteChannel(ch)   { return this._inputMute(ch, true); }
  async unmuteChannel(ch) { return this._inputMute(ch, false); }

  async _inputMute(ch, muted) {
    const n = AllenHeathMixer._idx(ch, SQ_COUNTS.inputs);
    const addr = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, n);
    await this._setMute(addr, muted, `input:${n}`, `channel ${n + 1} ${muted ? 'mute' : 'unmute'}`);
  }

  async muteMaster()   { await this._setMute(MUTE.lr, true, 'lr:0', 'main LR mute'); }
  async unmuteMaster() { await this._setMute(MUTE.lr, false, 'lr:0', 'main LR unmute'); }

  // ─── DCA / MUTE GROUP CONTROL ──────────────────────────────────────────────

  async muteDca(dca)   { return this._dcaMute(dca, true); }
  async unmuteDca(dca) { return this._dcaMute(dca, false); }

  async _dcaMute(dca, muted) {
    const n = AllenHeathMixer._idx(dca, SQ_COUNTS.dcas, 'DCA');
    await this._setMute(nrpn1D(MUTE.dca.msb, MUTE.dca.lsb, n), muted, `dca:${n}`, `DCA ${n + 1} ${muted ? 'mute' : 'unmute'}`);
  }

  async setDcaFader(dca, level) {
    const n = AllenHeathMixer._idx(dca, SQ_COUNTS.dcas, 'DCA');
    const data = normalToData(AllenHeathMixer._level(level));
    const got = await this._setVerified(nrpn1D(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb, n), data, `DCA ${n + 1} level`, LEVEL_TOLERANCE);
    this._state.faders[`dca:${n}`] = got;
  }

  async activateMuteGroup(mg)   { return this._muteGroup(mg, true); }
  async deactivateMuteGroup(mg) { return this._muteGroup(mg, false); }

  async _muteGroup(mg, on) {
    const n = AllenHeathMixer._idx(mg, SQ_COUNTS.muteGroups, 'mute group');
    await this._setMute(nrpn1D(MUTE.muteGroup.msb, MUTE.muteGroup.lsb, n), on, `muteGroup:${n}`, `mute group ${n + 1} ${on ? 'on' : 'off'}`);
  }

  // ─── FADER CONTROL ─────────────────────────────────────────────────────────

  /** Input channel fader = the input→LR send level on the SQ. */
  async setFader(ch, level) {
    const n = AllenHeathMixer._idx(ch, SQ_COUNTS.inputs);
    const data = normalToData(AllenHeathMixer._level(level));
    const addr = nrpn2D(SEND_LEVEL.inputToLr.msb, SEND_LEVEL.inputToLr.lsb, 1, n, 0);
    const got = await this._setVerified(addr, data, `channel ${n + 1} fader`, LEVEL_TOLERANCE);
    this._state.faders[`input:${n}`] = got;
  }

  /** Live read from the console; null for anything it didn't report. */
  async getChannelStatus(ch) {
    const n = AllenHeathMixer._idx(ch, SQ_COUNTS.inputs);
    if (this._online) {
      const m = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, n);
      const f = nrpn2D(SEND_LEVEL.inputToLr.msb, SEND_LEVEL.inputToLr.lsb, 1, n, 0);
      await Promise.all([
        this._get(m.msb, m.lsb).catch(() => undefined),
        this._get(f.msb, f.lsb).catch(() => undefined),
      ]);
    }
    const fd = this._state.faders[`input:${n}`];
    const mu = this._state.mutes[`input:${n}`];
    return { fader: fd != null ? dataToNormal(fd) : null, muted: mu != null ? mu : null };
  }

  // ─── SEND LEVELS ───────────────────────────────────────────────────────────

  async setSendLevel(inputCh, mixBus, level) {
    const src = AllenHeathMixer._idx(inputCh, SQ_COUNTS.inputs);
    const snk = AllenHeathMixer._idx(mixBus, SQ_COUNTS.mixes, 'mix bus');
    const addr = nrpn2D(SEND_LEVEL.inputToMix.msb, SEND_LEVEL.inputToMix.lsb, SQ_COUNTS.mixes, src, snk);
    await this._setVerified(addr, normalToData(AllenHeathMixer._level(level)), `channel ${src + 1} → mix ${snk + 1} send`, LEVEL_TOLERANCE);
  }

  async setFxSendLevel(inputCh, fxSend, level) {
    const src = AllenHeathMixer._idx(inputCh, SQ_COUNTS.inputs);
    const snk = AllenHeathMixer._idx(fxSend, SQ_COUNTS.fxSends, 'FX send');
    const addr = nrpn2D(SEND_LEVEL.inputToFxSend.msb, SEND_LEVEL.inputToFxSend.lsb, SQ_COUNTS.fxSends, src, snk);
    await this._setVerified(addr, normalToData(AllenHeathMixer._level(level)), `channel ${src + 1} → FX ${snk + 1} send`, LEVEL_TOLERANCE);
  }

  async setMixLevel(mixBus, level) {
    const n = AllenHeathMixer._idx(mixBus, SQ_COUNTS.mixes, 'mix bus');
    const got = await this._setVerified(nrpn1D(OUTPUT_LEVEL.mix.msb, OUTPUT_LEVEL.mix.lsb, n), normalToData(AllenHeathMixer._level(level)), `mix ${n + 1} level`, LEVEL_TOLERANCE);
    this._state.faders[`mix:${n}`] = got;
  }

  // ─── ROUTING ASSIGNS ───────────────────────────────────────────────────────

  async setInputToMixAssign(inputCh, mixBus, assigned) {
    const src = AllenHeathMixer._idx(inputCh, SQ_COUNTS.inputs);
    const snk = AllenHeathMixer._idx(mixBus, SQ_COUNTS.mixes, 'mix bus');
    const addr = nrpn2D(SEND_ASSIGN.inputToMix.msb, SEND_ASSIGN.inputToMix.lsb, SQ_COUNTS.mixes, src, snk);
    await this._setVerified(addr, assigned ? 1 : 0, `channel ${src + 1} → mix ${snk + 1} assign`);
  }

  async setInputToGroupAssign(inputCh, group, assigned) {
    const src = AllenHeathMixer._idx(inputCh, SQ_COUNTS.inputs);
    const snk = AllenHeathMixer._idx(group, SQ_COUNTS.groups, 'group');
    const addr = nrpn2D(SEND_ASSIGN.inputToGroup.msb, SEND_ASSIGN.inputToGroup.lsb, SQ_COUNTS.groups, src, snk);
    await this._setVerified(addr, assigned ? 1 : 0, `channel ${src + 1} → group ${snk + 1} assign`);
  }

  // ─── PAN ───────────────────────────────────────────────────────────────────

  /** @param {number} pan -1.0 (left) to +1.0 (right), 0 = center */
  async setPan(ch, pan) {
    const n = AllenHeathMixer._idx(ch, SQ_COUNTS.inputs);
    const p = Number(pan);
    if (!Number.isFinite(p)) throw new Error('pan must be a number');
    if (p < -1 || p > 1) throw new Error(`Pan out of range: ${pan} (valid: -1.0 to +1.0)`);
    const addr = nrpn2D(SEND_PAN.inputToLr.msb, SEND_PAN.inputToLr.lsb, 1, n, 0);
    await this._setVerified(addr, normalToPanData((p + 1) / 2), `channel ${n + 1} pan`, PAN_TOLERANCE);
  }

  // ─── SCENE RECALL ──────────────────────────────────────────────────────────

  /**
   * The SQ has no scene read-back over MIDI and silently ignores a recall of a
   * blank scene, so this can only report "sent". Returns { confirmed: false }.
   */
  async recallScene(n) {
    this._requireOnline();
    const sceneNum = Number(n);
    if (!Number.isInteger(sceneNum) || sceneNum < 1 || sceneNum > SQ_COUNTS.scenes) {
      throw new Error(`Invalid scene "${n}" (valid: 1–${SQ_COUNTS.scenes})`);
    }
    const { bankMsg, pgmMsg } = buildSceneRecall(this.midiCh, sceneNum);
    this._send(bankMsg);
    await new Promise(r => setTimeout(r, 200));
    this._send(pgmMsg);
    // Prove the desk is still there after the recall (not proof the scene loaded).
    if (!(await this.isOnline())) {
      throw new Error(`${this.model} stopped responding after scene ${sceneNum} recall`);
    }
    return { confirmed: false, reason: 'The SQ does not report scene recalls over MIDI, and ignores recalls of blank scenes' };
  }

  async saveScene() {
    throw new Error(`Scene save is not available on ${this.model} over MIDI — save at the console`);
  }

  async clearSolos() {
    throw new Error(`Solo clear is not available on ${this.model} over MIDI — clear at the console`);
  }

  // ─── SOFTKEYS ──────────────────────────────────────────────────────────────

  /** Press + release a SoftKey (1-based). No read-back exists → { confirmed: false }. */
  async pressSoftKey(key) {
    this._requireOnline();
    const max = SOFTKEY_COUNTS[this.model] || 16;
    const idx = AllenHeathMixer._idx(key, max, 'SoftKey');
    this._send(buildSoftKey(this.midiCh, idx, true));
    await new Promise(r => setTimeout(r, 100));
    this._send(buildSoftKey(this.midiCh, idx, false));
    return { confirmed: false, reason: 'The SQ does not report SoftKey presses back over MIDI' };
  }

  // ─── NOT AVAILABLE OVER SQ MIDI ────────────────────────────────────────────

  _notAvailable(what) {
    throw new Error(`${what} is not available on ${this.model} over MIDI — set it at the console`);
  }
  async setChannelName() { this._notAvailable('Channel naming'); }
  async setHpf()         { this._notAvailable('HPF'); }
  async setEq()          { this._notAvailable('EQ'); }
  async setCompressor()  { this._notAvailable('Compressor'); }
  async setGate()        { this._notAvailable('Gate'); }

  async setFullChannelStrip(ch, strip) {
    const applied = [];
    const skipped = [];
    for (const k of ['name', 'hpf', 'eq', 'compressor', 'gate']) {
      if (strip[k] != null && strip[k] !== false) skipped.push(k);
    }
    if (strip.pan != null) { await this.setPan(ch, strip.pan); applied.push('pan'); }
    if (strip.fader != null) { await this.setFader(ch, strip.fader); applied.push('fader'); }
    if (strip.mute === true) { await this.muteChannel(ch); applied.push('mute'); }
    else if (strip.mute === false) { await this.unmuteChannel(ch); applied.push('unmute'); }
    if (skipped.length > 0) {
      console.warn(`🎛️  ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available over SQ MIDI`);
    }
    return { applied, skipped };
  }

  // ─── INCOMING MIDI (GET replies + console surface changes) ─────────────────

  _handleIncoming(msg) {
    if (!msg || msg.length === 0) return;
    const status = msg[0];
    if ((status & 0x0F) !== this.midiCh) return;
    const hi = status & 0xF0;
    if (hi === 0xB0) { this._handleCC(msg); return; }
    if (hi === 0xC0 && msg.length >= 2) {
      const upper = this._nrpnState.sceneBank ?? 0;
      this._state.scene = ((upper & 0x7F) << 7) + msg[1] + 1;
    }
  }

  _handleCC(msg) {
    if (msg.length < 3) return;
    const cc = msg[1];
    const val = msg[2];
    switch (cc) {
      case 0x00: this._nrpnState.sceneBank = val; break;
      case 0x63: this._nrpnState.paramMsb = val; this._nrpnState.vc = null; break;
      case 0x62: this._nrpnState.paramLsb = val; break;
      case 0x06: this._nrpnState.vc = val; break;
      case 0x26:
        if (this._nrpnState.vc == null) return;
        this._processNrpnValue(this._nrpnState.paramMsb, this._nrpnState.paramLsb, this._nrpnState.vc, val);
        break;
    }
  }

  _processNrpnValue(msb, lsb, vc, vf) {
    if (msb == null || lsb == null) return;
    const nrpn = makeNrpn(msb, lsb);
    const data = vcVfToData(vc, vf);

    if (msb <= 0x04) {
      const key = this._muteNrpnToKey(nrpn);
      if (key) this._state.mutes[key] = data === 1;
    } else if (msb >= 0x40 && msb <= 0x4F) {
      const key = this._levelNrpnToKey(nrpn);
      if (key) this._state.faders[key] = data;
    }

    const list = this._waiters.get(nrpn);
    if (list) {
      this._waiters.delete(nrpn);
      for (const w of list) w(data);
    }
  }

  /** Map a mute NRPN back to a state key ('input:5', 'lr:0', 'dca:2', 'muteGroup:0'). */
  _muteNrpnToKey(nrpn) {
    for (const [type, base] of Object.entries(MUTE)) {
      const baseN = makeNrpn(base.msb, base.lsb);
      const count = this._countForMuteType(type);
      if (nrpn >= baseN && nrpn < baseN + count) {
        const name = type === 'inputChannel' ? 'input' : type;
        return `${name}:${nrpn - baseN}`;
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

  _levelNrpnToKey(nrpn) {
    const inLrBase = makeNrpn(SEND_LEVEL.inputToLr.msb, SEND_LEVEL.inputToLr.lsb);
    if (nrpn >= inLrBase && nrpn < inLrBase + SQ_COUNTS.inputs) return `input:${nrpn - inLrBase}`;
    const lrBase = makeNrpn(OUTPUT_LEVEL.lr.msb, OUTPUT_LEVEL.lr.lsb);
    if (nrpn === lrBase) return 'lr:0';
    const mixBase = makeNrpn(OUTPUT_LEVEL.mix.msb, OUTPUT_LEVEL.mix.lsb);
    if (nrpn >= mixBase && nrpn < mixBase + SQ_COUNTS.mixes) return `mix:${nrpn - mixBase}`;
    const dcaBase = makeNrpn(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb);
    if (nrpn >= dcaBase && nrpn < dcaBase + SQ_COUNTS.dcas) return `dca:${nrpn - dcaBase}`;
    return null;
  }

  // ─── INITIAL STATE QUERY ───────────────────────────────────────────────────

  /**
   * Query mute and key level states on connect (throttled — some SQ firmware
   * resets the connection if NRPN traffic floods in right after connect).
   */
  async _queryInitialState() {
    const settleMs = Number(process.env.TALLY_SQ_SETTLE_MS) || 1000;
    await new Promise(r => setTimeout(r, settleMs));
    const BATCH_SIZE = 8;
    const BATCH_DELAY = Number(process.env.TALLY_SQ_BATCH_DELAY_MS) || 500;
    const queries = [];
    queries.push(buildNrpnIncrement(this.midiCh, MUTE.lr.msb, MUTE.lr.lsb, 0x7F));
    queries.push(buildNrpnIncrement(this.midiCh, OUTPUT_LEVEL.lr.msb, OUTPUT_LEVEL.lr.lsb, 0x7F));
    for (let i = 0; i < SQ_COUNTS.inputs; i++) {
      const addr = nrpn1D(MUTE.inputChannel.msb, MUTE.inputChannel.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }
    for (let i = 0; i < SQ_COUNTS.dcas; i++) {
      const m = nrpn1D(MUTE.dca.msb, MUTE.dca.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, m.msb, m.lsb, 0x7F));
      const l = nrpn1D(OUTPUT_LEVEL.dca.msb, OUTPUT_LEVEL.dca.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, l.msb, l.lsb, 0x7F));
    }
    for (let i = 0; i < SQ_COUNTS.mixes; i++) {
      const addr = nrpn1D(MUTE.mix.msb, MUTE.mix.lsb, i);
      queries.push(buildNrpnIncrement(this.midiCh, addr.msb, addr.lsb, 0x7F));
    }
    for (let i = 0; i < queries.length; i++) {
      if (!this._tcp.online) return;
      this._tcp.send(queries[i]);
      if ((i + 1) % BATCH_SIZE === 0) await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }
}

module.exports = {
  AllenHeathMixer,
  _internals: { normalToData, dataToNormal, normalToDb, dbToNormal, LEVEL_0DB_DATA, MIDI_PORT },
};
