/**
 * Allen & Heath dLive / Avantis driver — MIDI over TCP (MixRack port 51325).
 *
 * Protocol references (tables checked line by line):
 *   dLive  MIDI Over TCP/IP Protocol, firmware V2.0
 *   Avantis TCP/IP Protocol, firmware V1.10 (identical content in the V2.0 web edition)
 *
 * Channel selection — five MIDI channels from the console's base channel N
 * (Utility / Control / MIDI, 1–12, factory default 12):
 *   N    inputs                       note = channel − 1
 *   N+1  groups     N+2 aux     N+3 matrix
 *   N+4  FX sends 00+, FX returns 20+, Mains 30+, DCAs 36+,
 *        Mute Groups 4E+ (dLive) / 46+ (Avantis)
 *
 * Honesty contract (same as the X32 and SQ drivers):
 *   • dLive has Get Mute / Get Fader / Get HPF SysEx → every SET is followed by a
 *     GET and only succeeds when the console reports the new value back.
 *   • Avantis has NO mute/level get over TCP (A&H confirmed; only name/colour
 *     can be read). Its mute/fader/DCA/mute-group commands are sent only after a
 *     name-request round-trip proves the desk is answering, and are reported as
 *     "sent, not confirmed" ({ confirmed:false }), never as done.
 *   • Names and colours are read back on both consoles.
 *   • Liveness is a round-trip (dLive: Get Mute on Main 1; Avantis: name request
 *     for input 1), never "the TCP socket is open", and never a second socket.
 *   • Unknown values are null, never "unmuted" / 0.
 *   • Functions the protocol does not have (pan, EQ, dynamics, scene save,
 *     solo clear, SoftKeys, HPF on Avantis) refuse with an error.
 */

'use strict';

const { TcpMidi } = require('../tcp-midi');
const { _internals: sqLaw } = require('./allenheath');

const DEFAULT_PORT = 51325;
const SURFACE_PORTS = new Set([51328, 51329]);   // dLive Surface: no scene recall
const DEFAULT_BASE_CHANNEL = 0x0B;                // MIDI channel 12
const GET_TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 1500;

const SYSEX_HEADER = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x10, 0x01, 0x00];
const NRPN = { FADER: 0x17, MAIN_ASSIGN: 0x18, HPF_FREQ: 0x30, HPF_ON: 0x31 };
const COLORS = { off: 0, red: 1, green: 2, yellow: 3, blue: 4, purple: 5, cyan: 6, 'lt blue': 6, 'light blue': 6, white: 7 };
const NAME_MAX = 8;

const MODELS = {
  dlive: {
    name: 'dLive', inputs: 128, mains: 6, dcas: 24, muteGroups: 8, fxReturns: 16,
    fxRetBase: 0x20, mainBase: 0x30, dcaBase: 0x36, mgBase: 0x4E, hasGet: true, hasHpf: true,
  },
  avantis: {
    name: 'Avantis', inputs: 64, mains: 3, dcas: 16, muteGroups: 8, fxReturns: 12,
    fxRetBase: 0x20, mainBase: 0x30, dcaBase: 0x36, mgBase: 0x46, hasGet: false, hasHpf: false,
  },
};

// ─── LEVEL LAW ────────────────────────────────────────────────────────────────
// Tally's fader position uses the X32 law (0.75 = 0 dB, 1.0 = +10 dB) on every console.
// A&H LV: [(dB + 54) / 64] × 127 → 0 dB = 0x6B, +10 = 0x7F, −40 = 0x1B, 00 = −inf.

function normalToLv(norm) {
  const dB = sqLaw.normalToDb(norm);
  if (!Number.isFinite(dB) || dB <= -54) return 0;
  return Math.max(0, Math.min(127, Math.round(((dB + 54) / 64) * 127)));
}
function lvToNormal(lv) {
  if (lv == null) return null;
  if (lv <= 0) return 0;
  // One LV step ≈ 0.5 dB; snap to the nearest 0.5 dB so the table points (6B = 0 dB, 57 = −10 dB) read back exactly.
  const dB = Math.round(((lv * 64) / 127 - 54) * 2) / 2;
  return Math.round(sqLaw.dbToNormal(dB) * 1000) / 1000;
}
/** dLive HPF frequency formula (protocol V2.0). */
function hzToHpf(hz) {
  return Math.max(0, Math.min(127, Math.floor((127 * ((4608 * Math.log10(hz / 4)) / Math.log10(2) - 10699)) / 41314)));
}

// ─── WIRE BUILDERS ───────────────────────────────────────────────────────────

const buildNrpn = (midiCh, note, param, value) => {
  const cc = 0xB0 | (midiCh & 0x0F);
  return [cc, 0x63, note & 0x7F, cc, 0x62, param & 0x7F, cc, 0x06, value & 0x7F];
};
/** Mute ON = vel 7F, OFF = vel 3F, each followed by a Note On vel 00 ("note off"). */
const buildMute = (midiCh, note, on) => {
  const s = 0x90 | (midiCh & 0x0F);
  return [s, note & 0x7F, on ? 0x7F : 0x3F, s, note & 0x7F, 0x00];
};
const buildSysEx = (midiCh, bytes) => [...SYSEX_HEADER, midiCh & 0x0F, ...bytes, 0xF7];
const buildSceneRecall = (baseCh, scene) => {
  const z = scene - 1;
  return [0xB0 | baseCh, 0x00, Math.floor(z / 128), 0xC0 | baseCh, z % 128];
};

class AvantisMixer {
  /**
   * @param {{ host: string, port?: number, model?: string, midiChannel?: number, baseMidiChannel?: number }} opts
   *   model:       'Avantis' | 'dLive'
   *   midiChannel: console base MIDI channel, 0-based (0–11 = MIDI ch 1–12). Default 11 (ch 12).
   *                (baseMidiChannel is the legacy name for the same thing.)
   */
  constructor({ host, port, model = 'Avantis', midiChannel, baseMidiChannel } = {}) {
    this.host = host;
    this.port = Number(port) || DEFAULT_PORT;
    this.kind = /dlive/i.test(String(model || '')) ? 'dlive' : 'avantis';
    this.M = MODELS[this.kind];
    this.model = model && String(model).trim() ? String(model).trim() : this.M.name;
    const raw = midiChannel ?? baseMidiChannel;
    const b = raw == null || raw === '' ? DEFAULT_BASE_CHANNEL : Number(raw);
    this._configError = null;
    if (!Number.isInteger(b) || b < 0 || b > 0x0B) {
      this._configError = `${this.M.name} base MIDI channel must be 1–12 (got ${Number.isInteger(b) ? b + 1 : raw}) — the console uses five channels from the base`;
      this.base = DEFAULT_BASE_CHANNEL;
    } else {
      this.base = b;
    }

    this._tcp = new TcpMidi({ host, port: this.port, autoReconnect: true });
    this._online = false;
    this._state = { mutes: {}, faders: {}, names: {}, scene: null };
    this._nrpnState = {};
    this._bank = 0;
    this._waiters = new Map();   // key → [fn(value)]

    this._tcp.on('connected', () => {
      this._online = true;
      console.log(`🎛️  ${this.model}: TCP MIDI connected to ${host}:${this.port}`);
    });
    this._tcp.on('disconnected', () => {
      this._online = false;
      console.log(`🎛️  ${this.model}: TCP MIDI disconnected`);
    });
    this._tcp.on('error', (err) => {
      console.warn(`🎛️  ${this.model}: TCP MIDI error — ${err.message}`);
    });
    this._tcp.on('midi', (msg) => this._handleIncoming(msg));
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  async connect() {
    try { await this._tcp.connect(); this._online = true; }
    catch (e) { this._online = false; console.warn(`🎛️  ${this.model}: connect failed — ${e.message}`); }
  }

  async disconnect() {
    this._tcp.disconnect();
    this._online = false;
    for (const list of this._waiters.values()) for (const w of list) w(undefined);
    this._waiters.clear();
  }

  // ─── CHANNEL HELPERS ────────────────────────────────────────────────────────

  _ch(off) { return (this.base + off) & 0x0F; }
  get _chInput() { return this._ch(0); }
  get _chN4() { return this._ch(4); }
  get _chLabel() { return `MIDI base channel ${this.base + 1}`; }

  static _idx(val, max, what = 'channel') {
    const s = String(val ?? '').trim();
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${what} "${val}" (valid: 1–${max})`);
    return n - 1;
  }

  _requireOnline() {
    if (this._configError) throw new Error(this._configError);
    if (!this._online || !this._tcp.online) throw new Error(`${this.model} not connected`);
  }
  _send(bytes) {
    if (!this._tcp.send(bytes)) throw new Error(`${this.model} not connected`);
  }

  // ─── ROUND-TRIPS ────────────────────────────────────────────────────────────

  _wait(key, sendBytes, timeoutMs = GET_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let done = false;
      const waiter = (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (v === undefined) reject(new Error('disconnected')); else resolve(v);
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const list = this._waiters.get(key);
        if (list) { const i = list.indexOf(waiter); if (i >= 0) list.splice(i, 1); if (!list.length) this._waiters.delete(key); }
        reject(new Error('timeout'));
      }, timeoutMs);
      if (!this._waiters.has(key)) this._waiters.set(key, []);
      this._waiters.get(key).push(waiter);
      if (!this._tcp.send(sendBytes)) waiter(undefined);
    });
  }
  _resolve(key, v) {
    const list = this._waiters.get(key);
    if (!list) return;
    this._waiters.delete(key);
    for (const w of list) w(v);
  }

  /** dLive: Get Mute → true/false. */
  _getMute(midiCh, note, t) { return this._wait(`mute:${midiCh}:${note}`, buildSysEx(midiCh, [0x05, 0x09, note]), t); }
  /** dLive: Get NRPN parameter (fader 17, HPF 30/31) → 0–127. */
  _getParam(midiCh, note, param, t) { return this._wait(`nrpn:${midiCh}:${note}:${param}`, buildSysEx(midiCh, [0x05, 0x0B, param, note]), t); }
  /** Both: name request → string. */
  _getName(midiCh, note, t) { return this._wait(`name:${midiCh}:${note}`, buildSysEx(midiCh, [0x01, note]), t); }
  _getColor(midiCh, note, t) { return this._wait(`color:${midiCh}:${note}`, buildSysEx(midiCh, [0x04, note]), t); }

  _noReply(label) {
    return new Error(`${this.model} did not confirm ${label} — no reply from the console (check it is powered, on the network, and set to ${this._chLabel})`);
  }

  /** Liveness round-trip. Never opens a second socket. */
  async _probe(t = PROBE_TIMEOUT_MS) {
    if (this._configError || !this._tcp.online) return false;
    try {
      if (this.M.hasGet) await this._getMute(this._chN4, this.M.mainBase, t);
      else await this._getName(this._chInput, 0, t);
      return true;
    } catch { return false; }
  }

  async isOnline() {
    this._online = await this._probe();
    return this._online;
  }

  async getStatus() {
    const online = await this.isOnline();
    if (online && this.M.hasGet) {
      await this._getParam(this._chN4, this.M.mainBase, NRPN.FADER, PROBE_TIMEOUT_MS).catch(() => undefined);
    }
    const f = this._state.faders['main:0'];
    const m = this._state.mutes['main:0'];
    return {
      online,
      model: this.model,
      firmware: '',
      mainFader: online && f != null ? lvToNormal(f) : null,
      mainMuted: online && m != null ? m : null,
      scene: this._state.scene,
      ...(this._configError ? { error: this._configError } : {}),
    };
  }

  // ─── VERIFIED / UNCONFIRMED SETS ────────────────────────────────────────────

  async _setMute(midiCh, note, on, key, label) {
    this._requireOnline();
    if (!this.M.hasGet) return this._sendUnconfirmed(buildMute(midiCh, note, on), label);
    this._send(buildMute(midiCh, note, on));
    let got;
    try { got = await this._getMute(midiCh, note); } catch { throw this._noReply(label); }
    if (got !== on) throw new Error(`${this.model} did not apply ${label} — console reports ${got ? 'muted' : 'unmuted'}`);
    this._state.mutes[key] = on;
    return { confirmed: true };
  }

  async _setLevel(midiCh, note, lv, key, label) {
    this._requireOnline();
    const bytes = buildNrpn(midiCh, note, NRPN.FADER, lv);
    if (!this.M.hasGet) return this._sendUnconfirmed(bytes, label);
    this._send(bytes);
    let got;
    try { got = await this._getParam(midiCh, note, NRPN.FADER); } catch { throw this._noReply(label); }
    if (Math.abs(got - lv) > 1) throw new Error(`${this.model} did not apply ${label} — console reports level ${got}, expected ${lv}`);
    this._state.faders[key] = got;
    return { confirmed: true };
  }

  async _sendUnconfirmed(bytes, label) {
    if (!(await this._probe())) {
      this._online = false;
      throw new Error(`${this.model} is not answering — ${label} NOT sent (check it is powered, on the network, and set to ${this._chLabel})`);
    }
    this._send(bytes);
    return { confirmed: false, reason: `the ${this.M.name} has no mute/level read-back over TCP MIDI` };
  }

  // ─── INPUTS ─────────────────────────────────────────────────────────────────

  async muteChannel(ch)   { return this._inputMute(ch, true); }
  async unmuteChannel(ch) { return this._inputMute(ch, false); }
  async _inputMute(ch, on) {
    const n = AvantisMixer._idx(ch, this.M.inputs);
    return this._setMute(this._chInput, n, on, `input:${n}`, `channel ${n + 1} ${on ? 'mute' : 'unmute'}`);
  }

  async setFader(ch, level) {
    const n = AvantisMixer._idx(ch, this.M.inputs);
    const lv = normalToLv(AvantisMixer._level(level));
    return this._setLevel(this._chInput, n, lv, `input:${n}`, `channel ${n + 1} fader`);
  }

  static _level(level) {
    const v = Number(level);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error(`Invalid level "${level}" (valid: 0.0–1.0)`);
    return v;
  }

  async getChannelStatus(ch) {
    const n = AvantisMixer._idx(ch, this.M.inputs);
    const key = `input:${n}`;
    if (this.M.hasGet && this._online && this._tcp.online) {
      await this._getMute(this._chInput, n).catch(() => undefined);
      await this._getParam(this._chInput, n, NRPN.FADER).catch(() => undefined);
    }
    const f = this._state.faders[key];
    const m = this._state.mutes[key];
    return {
      fader: f != null ? lvToNormal(f) : null,
      muted: m != null ? m : null,
      name: this._state.names[key] || undefined,
    };
  }

  // ─── MAINS ──────────────────────────────────────────────────────────────────

  async muteMaster()   { return this._setMute(this._chN4, this.M.mainBase, true, 'main:0', 'main 1 mute'); }
  async unmuteMaster() { return this._setMute(this._chN4, this.M.mainBase, false, 'main:0', 'main 1 unmute'); }

  // ─── DCA / MUTE GROUPS ──────────────────────────────────────────────────────

  async muteDca(dca)   { return this._dcaMute(dca, true); }
  async unmuteDca(dca) { return this._dcaMute(dca, false); }
  async _dcaMute(dca, on) {
    const n = AvantisMixer._idx(dca, this.M.dcas, 'DCA');
    return this._setMute(this._chN4, this.M.dcaBase + n, on, `dca:${n}`, `DCA ${n + 1} ${on ? 'mute' : 'unmute'}`);
  }
  async setDcaFader(dca, level) {
    const n = AvantisMixer._idx(dca, this.M.dcas, 'DCA');
    const lv = normalToLv(AvantisMixer._level(level));
    return this._setLevel(this._chN4, this.M.dcaBase + n, lv, `dca:${n}`, `DCA ${n + 1} fader`);
  }

  async activateMuteGroup(mg)   { return this._muteGroup(mg, true); }
  async deactivateMuteGroup(mg) { return this._muteGroup(mg, false); }
  async _muteGroup(mg, on) {
    const n = AvantisMixer._idx(mg, this.M.muteGroups, 'mute group');
    return this._setMute(this._chN4, this.M.mgBase + n, on, `muteGroup:${n}`, `mute group ${n + 1} ${on ? 'on' : 'off'}`);
  }

  // ─── SCENES ─────────────────────────────────────────────────────────────────

  /** Bank + Program Change on the base channel. No acknowledgement exists → { confirmed:false }. */
  async recallScene(n) {
    this._requireOnline();
    const scene = Number(n);
    if (!Number.isInteger(scene) || scene < 1 || scene > 500) throw new Error(`Invalid scene "${n}" (valid: 1–500)`);
    if (this.kind === 'dlive' && SURFACE_PORTS.has(this.port)) {
      throw new Error(`Scene recall only works when Tally is connected to the dLive MixRack (port 51325), not the Surface (port ${this.port})`);
    }
    this._send(buildSceneRecall(this.base, scene));
    if (!(await this._probe())) throw new Error(`${this.model} stopped responding after scene ${scene} recall`);
    return { confirmed: false, reason: `the ${this.M.name} does not acknowledge remote scene recalls, and ignores blank scenes` };
  }

  async saveScene()   { this._notAvailable('Scene save'); }
  async clearSolos()  { this._notAvailable('Solo clear'); }
  async pressSoftKey() { this._notAvailable('SoftKey control'); }

  // ─── NAME / COLOUR (read back on both consoles) ─────────────────────────────

  async setChannelName(ch, name) {
    this._requireOnline();
    const n = AvantisMixer._idx(ch, this.M.inputs);
    const s = String(name ?? '');
    if (!s.length || s.length > NAME_MAX || !/^[\x20-\x7E]+$/.test(s)) {
      throw new Error(`Invalid name "${s}" — ${this.M.name} names are 1–${NAME_MAX} plain ASCII characters`);
    }
    this._send(buildSysEx(this._chInput, [0x03, n, ...Buffer.from(s, 'ascii')]));
    let got;
    try { got = await this._getName(this._chInput, n); } catch { throw this._noReply(`channel ${n + 1} rename`); }
    if (got !== s) throw new Error(`${this.model} did not apply channel ${n + 1} rename — console reports "${got}"`);
    return { confirmed: true };
  }

  async setChannelColor(ch, color) {
    this._requireOnline();
    const n = AvantisMixer._idx(ch, this.M.inputs);
    const col = COLORS[String(color ?? '').toLowerCase()];
    if (col == null) throw new Error(`Invalid colour "${color}" (valid: off, red, green, yellow, blue, purple, cyan, white)`);
    this._send(buildSysEx(this._chInput, [0x06, n, col]));
    let got;
    try { got = await this._getColor(this._chInput, n); } catch { throw this._noReply(`channel ${n + 1} colour`); }
    if (got !== col) throw new Error(`${this.model} did not apply channel ${n + 1} colour — console reports ${got}`);
    return { confirmed: true };
  }

  // ─── HPF (dLive only) ───────────────────────────────────────────────────────

  async setHpf(ch, { enabled = true, frequency } = {}) {
    if (!this.M.hasHpf) this._notAvailable('HPF');
    this._requireOnline();
    const n = AvantisMixer._idx(ch, this.M.inputs);
    let vv = null;
    if (frequency != null && enabled !== false) {
      const hz = Number(frequency);
      if (!Number.isFinite(hz) || hz < 20 || hz > 2000) throw new Error(`Invalid HPF frequency "${frequency}" (valid: 20–2000 Hz)`);
      vv = hzToHpf(hz);
    }
    const on = enabled !== false;
    this._send(buildNrpn(this._chInput, n, NRPN.HPF_ON, on ? 0x7F : 0x00));
    let got;
    try { got = await this._getParam(this._chInput, n, NRPN.HPF_ON); } catch { throw this._noReply(`channel ${n + 1} HPF`); }
    if ((got >= 0x40) !== on) throw new Error(`${this.model} did not apply channel ${n + 1} HPF ${on ? 'on' : 'off'}`);
    if (vv != null) {
      this._send(buildNrpn(this._chInput, n, NRPN.HPF_FREQ, vv));
      try { got = await this._getParam(this._chInput, n, NRPN.HPF_FREQ); } catch { throw this._noReply(`channel ${n + 1} HPF frequency`); }
      if (Math.abs(got - vv) > 1) throw new Error(`${this.model} did not apply channel ${n + 1} HPF frequency — console reports ${got}, expected ${vv}`);
    }
    return { confirmed: true };
  }

  // ─── NOT IN THE PROTOCOL ────────────────────────────────────────────────────

  _notAvailable(what) {
    throw new Error(`${what} is not available on ${this.model} over MIDI — set it at the console`);
  }
  /** NRPN 0x18 is "Channel → Main Mix assign" on both consoles, not pan. */
  async setPan()        { this._notAvailable('Pan'); }
  async setEq()         { this._notAvailable('EQ'); }
  async setCompressor() { this._notAvailable('Compressor'); }
  async setGate()       { this._notAvailable('Gate'); }

  async setFullChannelStrip(ch, strip = {}) {
    const applied = [];
    const skipped = [];
    const unconfirmed = [];
    const note = (k, r) => { applied.push(k); if (r && r.confirmed === false) unconfirmed.push(k); };
    for (const k of ['eq', 'compressor', 'gate', 'pan']) if (strip[k] != null && strip[k] !== false) skipped.push(k);
    if (strip.hpf && !this.M.hasHpf) skipped.push('hpf');
    if (strip.name != null) note('name', await this.setChannelName(ch, strip.name));
    if (strip.color != null) note('color', await this.setChannelColor(ch, strip.color));
    if (strip.hpf && this.M.hasHpf) note('hpf', await this.setHpf(ch, strip.hpf));
    if (strip.fader != null) note('fader', await this.setFader(ch, strip.fader));
    if (strip.mute === true) note('mute', await this.muteChannel(ch));
    else if (strip.mute === false) note('unmute', await this.unmuteChannel(ch));
    if (skipped.length) console.warn(`🎛️  ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available over MIDI`);
    return { applied, skipped, unconfirmed };
  }

  // ─── INCOMING ───────────────────────────────────────────────────────────────

  _keyFor(midiCh, note) {
    const off = ((midiCh - this.base) + 16) % 16;
    const M = this.M;
    if (off === 0) return note < M.inputs ? `input:${note}` : null;
    if (off === 1) return `group:${note}`;
    if (off === 2) return `aux:${note}`;
    if (off === 3) return `matrix:${note}`;
    if (off === 4) {
      if (note >= M.mainBase && note < M.mainBase + M.mains) return `main:${note - M.mainBase}`;
      if (note >= M.dcaBase && note < M.dcaBase + M.dcas) return `dca:${note - M.dcaBase}`;
      if (note >= M.mgBase && note < M.mgBase + M.muteGroups) return `muteGroup:${note - M.mgBase}`;
      if (note >= M.fxRetBase && note < M.fxRetBase + M.fxReturns) return `fxReturn:${note - M.fxRetBase}`;
      return `fxSend:${note}`;
    }
    return null;
  }

  _handleIncoming(msg) {
    if (!msg || !msg.length) return;
    if (msg[0] === 0xF0) { this._handleSysEx(msg); return; }
    const hi = msg[0] & 0xF0;
    const ch = msg[0] & 0x0F;
    if (hi === 0x90 && msg.length >= 3) {
      const vel = msg[2];
      if (vel === 0) return;                         // "note off" — ignored, like the console does
      const on = vel >= 0x40;
      const key = this._keyFor(ch, msg[1]);
      if (key) this._state.mutes[key] = on;
      this._resolve(`mute:${ch}:${msg[1]}`, on);
      return;
    }
    if (hi === 0xB0 && msg.length >= 3) {
      const s = this._nrpnState[ch] || (this._nrpnState[ch] = {});
      const [, cc, val] = msg;
      if (cc === 0x00) { if (ch === this.base) this._bank = val; return; }
      if (cc === 0x63) { s.note = val; s.param = null; return; }
      if (cc === 0x62) { s.param = val; return; }
      if (cc === 0x06 && s.note != null && s.param != null) {
        if (s.param === NRPN.FADER) { const key = this._keyFor(ch, s.note); if (key) this._state.faders[key] = val; }
        this._resolve(`nrpn:${ch}:${s.note}:${s.param}`, val);
      }
      return;
    }
    if (hi === 0xC0 && msg.length >= 2 && ch === this.base) {
      this._state.scene = (this._bank || 0) * 128 + msg[1] + 1;
    }
  }

  _handleSysEx(msg) {
    for (let i = 0; i < SYSEX_HEADER.length; i++) if (msg[i] !== SYSEX_HEADER[i]) return;
    if (msg.length < 12) return;
    const ch = msg[8];
    const cmd = msg[9];
    const note = msg[10];
    if (cmd === 0x02) {
      const name = Buffer.from(msg.slice(11, msg.length - 1)).toString('ascii');
      const key = this._keyFor(ch, note);
      if (key) this._state.names[key] = name;
      this._resolve(`name:${ch}:${note}`, name);
    } else if (cmd === 0x05 && msg.length >= 13) {
      this._resolve(`color:${ch}:${note}`, msg[11]);
    }
  }

  static get COLORS() { return ['off', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white']; }
  static maxInputs(model) { return /dlive/i.test(String(model || '')) ? 128 : 64; }
}

module.exports = {
  AvantisMixer,
  _internals: { normalToLv, lvToNormal, hzToHpf, MODELS, DEFAULT_BASE_CHANNEL, DEFAULT_PORT },
};
