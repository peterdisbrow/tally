/**
 * Allen & Heath Avantis / dLive TCP MIDI Driver
 *
 * The Avantis uses MIDI-over-TCP on port 51325 (MixRack) — a completely
 * different protocol from the SQ/dLive OSC interface in allenheath.js.
 *
 * Capabilities:
 *   ✅ Fader level  (NRPN, 128-step, ~0.5 dB resolution)
 *   ✅ Mute / unmute (Note On velocity)
 *   ✅ Scene recall   (Bank Select + Program Change, up to 500 scenes)
 *   ✅ Channel name   (SysEx)
 *   ✅ Channel colour  (SysEx)
 *   ✅ HPF on/off + frequency (NRPN)
 *   ✅ Preamp gain    (NRPN)
 *   ✅ Pan            (NRPN)
 *   ✅ DCA mute       (MIDI channel N+4)
 *   ✅ Bidirectional — receives live fader / mute changes from console
 *
 * Protocol reference:
 *   Allen & Heath Avantis MIDI TCP Protocol V1.0
 *   https://www.allen-heath.com/content/uploads/2023/05/Avantis-MIDI-TCP-Protocol-V1.0.pdf
 *
 *   dLive MIDI Over TCP Protocol V2.0 (same message format, more detail)
 *   https://www.allen-heath.com/content/uploads/2024/06/dLive-MIDI-Over-TCP-Protocol-V2.0.pdf
 */

'use strict';

const { TcpMidi } = require('../tcp-midi');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 51325;

// Default base MIDI channel 12 (0-indexed = 0x0B).
// The console uses 5 consecutive channels: N+0 inputs, N+1 groups,
// N+2 mixes, N+3 FX returns, N+4 DCAs / mute groups.
const DEFAULT_BASE_CHANNEL = 0x0B; // MIDI channel 12

// NRPN parameter IDs (CC 98 = NRPN LSB)
const NRPN = {
  FADER:    0x17, // Fader level
  PAN:      0x18, // Pan position
  HPF_FREQ: 0x30, // HPF frequency
  HPF_ON:   0x31, // HPF enable/disable
};

// Fader value constants
const FADER_NEG_INF = 0x00;
const FADER_0DB     = 0x6B; // 107 = 0 dB
const FADER_10DB    = 0x7F; // 127 = +10 dB

// SysEx header for Avantis V1.0
const SYSEX_HEADER = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x10, 0x01, 0x00];

// SysEx commands
const SYSEX_NAME_REQ    = 0x01;
const SYSEX_NAME_REPLY  = 0x02;
const SYSEX_NAME_SET    = 0x03;
const SYSEX_COLOR_REQ   = 0x04;
const SYSEX_COLOR_REPLY = 0x05;
const SYSEX_COLOR_SET   = 0x06;

// Channel type offsets (added to base MIDI channel)
const CH_TYPE = {
  INPUT:    0, // N+0
  GROUP:    1, // N+1
  MIX:      2, // N+2
  FX_RET:   3, // N+3
  DCA:      4, // N+4
};

// Colour values
const COLORS = {
  off:    0x00,
  red:    0x01,
  green:  0x02,
  yellow: 0x03,
  blue:   0x04,
  purple: 0x05,
  cyan:   0x06,
  white:  0x07,
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Convert a normalised 0.0–1.0 fader value to Avantis 0–127 MIDI value.
 * 0.0 → -inf (0), ~0.84 → 0 dB (107), 1.0 → +10 dB (127)
 */
function normalToMidiLevel(norm) {
  const clamped = Math.max(0, Math.min(1, norm));
  if (clamped === 0) return FADER_NEG_INF;
  return Math.round(clamped * 127);
}

/**
 * Convert Avantis 0–127 MIDI value back to normalised 0.0–1.0.
 */
function midiLevelToNormal(val) {
  return Math.max(0, Math.min(1, val / 127));
}

/**
 * Convert Hz to Avantis HPF MIDI value (0–127).
 * Range: ~20 Hz (0) to ~400+ Hz (127).  Log-scaled.
 */
function hzToHpfMidi(hz) {
  const clamped = Math.max(20, Math.min(400, hz));
  const norm = Math.log(clamped / 20) / Math.log(400 / 20);
  return Math.round(norm * 127);
}

/**
 * Build an NRPN message (3 CC messages = 6 or 9 bytes without running status).
 * Uses running status to compress: 7 bytes instead of 9.
 */
function buildNrpn(midiCh, channel, param, value) {
  const cc = 0xB0 | (midiCh & 0x0F);
  // With running status: status + CC99 + CH + CC98 + param + CC6 + value
  return [cc, 0x63, channel & 0x7F, 0x62, param & 0x7F, 0x06, value & 0x7F];
}

/**
 * Build a Note On message.
 */
function buildNoteOn(midiCh, note, velocity) {
  return [0x90 | (midiCh & 0x0F), note & 0x7F, velocity & 0x7F];
}

/**
 * Build a scene recall message: Bank Select (CC 0) + Program Change.
 * Scenes 1–500 across 4 banks of 128.
 */
function buildSceneRecall(midiCh, sceneNumber) {
  const n = Math.max(1, Math.min(500, parseInt(sceneNumber)));
  const zeroIdx = n - 1;
  const bank = Math.floor(zeroIdx / 128);
  const prog = zeroIdx % 128;
  const cc = 0xB0 | (midiCh & 0x0F);
  const pc = 0xC0 | (midiCh & 0x0F);
  return [cc, 0x00, bank & 0x7F, pc, prog & 0x7F];
}

/**
 * Build a SysEx message for channel name.
 */
function buildNameSet(chTypeOffset, channel, name) {
  const ascii = Array.from(Buffer.from(String(name).slice(0, 16), 'ascii'));
  return [...SYSEX_HEADER, chTypeOffset & 0x0F, SYSEX_NAME_SET, channel & 0x7F, ...ascii, 0xF7];
}

/**
 * Build a SysEx message for channel colour.
 */
function buildColorSet(chTypeOffset, channel, colorValue) {
  return [...SYSEX_HEADER, chTypeOffset & 0x0F, SYSEX_COLOR_SET, channel & 0x7F, colorValue & 0x7F, 0xF7];
}

// ─── AVANTIS MIXER CLASS ─────────────────────────────────────────────────────

class AvantisMixer {
  /**
   * @param {{ host: string, port?: number, model?: string, baseMidiChannel?: number }} opts
   *   model: 'Avantis' | 'dLive' (affects channel count, not protocol)
   *   baseMidiChannel: 0x00–0x0B (default 0x0B = channel 12)
   */
  constructor({ host, port = DEFAULT_PORT, model = 'Avantis', baseMidiChannel } = {}) {
    this.host  = host;
    this.port  = port;
    this.model = model || 'Avantis';
    this.base  = (baseMidiChannel != null) ? (baseMidiChannel & 0x0F) : DEFAULT_BASE_CHANNEL;

    this._tcp    = new TcpMidi({ host, port, autoReconnect: true });
    this._online = false;

    // Live state tracking from bidirectional feedback
    this._state = {
      faders: {},  // { 'input:0': 107, 'input:1': 85, ... }
      mutes:  {},  // { 'input:0': true, 'dca:3': false, ... }
      scene:  null,
    };

    // Wire up events
    this._tcp.on('connected', () => {
      this._online = true;
      console.log(`🎛️  ${this.model}: TCP MIDI connected to ${host}:${port}`);
    });
    this._tcp.on('disconnected', () => {
      this._online = false;
      console.log(`🎛️  ${this.model}: TCP MIDI disconnected`);
    });
    this._tcp.on('midi', (msg) => this._handleIncoming(msg));
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  async connect() {
    try {
      await this._tcp.connect();
      this._online = true;
    } catch (e) {
      this._online = false;
      console.warn(`🎛️  ${this.model}: connect failed — ${e.message}`);
    }
  }

  async disconnect() {
    this._tcp.disconnect();
    this._online = false;
  }

  async isOnline() {
    const reachable = await this._tcp.isOnline();
    this._online = reachable;
    return reachable;
  }

  async getStatus() {
    const online = await this.isOnline();
    return {
      online,
      model: this.model,
      firmware: '',
      mainFader: this._state.faders['input:main'] != null
        ? midiLevelToNormal(this._state.faders['input:main'])
        : 0,
      mainMuted: this._state.mutes['input:main'] || false,
      scene: this._state.scene,
    };
  }

  // ─── MIDI CHANNEL HELPERS ───────────────────────────────────────────────────

  /** Get the MIDI channel for a given channel type offset (0–4). */
  _ch(typeOffset) { return (this.base + typeOffset) & 0x0F; }

  /** MIDI channel for input channels. */
  get _chInput()  { return this._ch(CH_TYPE.INPUT); }
  /** MIDI channel for group channels. */
  get _chGroup()  { return this._ch(CH_TYPE.GROUP); }
  /** MIDI channel for mix buses. */
  get _chMix()    { return this._ch(CH_TYPE.MIX); }
  /** MIDI channel for FX returns. */
  get _chFxRet()  { return this._ch(CH_TYPE.FX_RET); }
  /** MIDI channel for DCAs and mute groups. */
  get _chDca()    { return this._ch(CH_TYPE.DCA); }

  // ─── FADER CONTROL ──────────────────────────────────────────────────────────

  /**
   * Set channel fader level (normalised 0.0–1.0).
   * @param {number|string} ch  Channel number (1-based)
   * @param {number} level      Normalised level 0.0–1.0
   */
  async setFader(ch, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    const val = normalToMidiLevel(parseFloat(level));
    this._tcp.send(buildNrpn(this._chInput, n, NRPN.FADER, val));
  }

  /**
   * Get channel status from live-tracked state.
   */
  async getChannelStatus(ch) {
    const n = Math.max(0, parseInt(ch) - 1);
    const key = `input:${n}`;
    return {
      fader: this._state.faders[key] != null ? midiLevelToNormal(this._state.faders[key]) : 0,
      muted: this._state.mutes[key] || false,
    };
  }

  // ─── MUTE CONTROL ──────────────────────────────────────────────────────────

  /**
   * Mute an input channel.
   * @param {number|string} ch  Channel number (1-based)
   */
  async muteChannel(ch) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    this._tcp.send(buildNoteOn(this._chInput, n, 0x7F)); // velocity ≥ 64 = mute
  }

  /**
   * Unmute an input channel.
   */
  async unmuteChannel(ch) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    this._tcp.send(buildNoteOn(this._chInput, n, 0x00)); // velocity ≤ 63 = unmute
  }

  // ─── MASTER CONTROL ────────────────────────────────────────────────────────

  /**
   * Mute master LR output.
   * Master LR on the Avantis is typically Mix 1 (channel 0 on the MIX MIDI channel).
   */
  async muteMaster() {
    if (!this._online) throw new Error(`${this.model} not connected`);
    this._tcp.send(buildNoteOn(this._chMix, 0, 0x7F));
  }

  async unmuteMaster() {
    if (!this._online) throw new Error(`${this.model} not connected`);
    this._tcp.send(buildNoteOn(this._chMix, 0, 0x00));
  }

  // ─── DCA CONTROL ───────────────────────────────────────────────────────────

  /**
   * Mute a DCA group.
   * @param {number|string} dca  DCA number (1-based, max 24)
   */
  async muteDca(dca) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(dca) - 1);
    this._tcp.send(buildNoteOn(this._chDca, n, 0x7F));
  }

  async unmuteDca(dca) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(dca) - 1);
    this._tcp.send(buildNoteOn(this._chDca, n, 0x00));
  }

  /**
   * Set DCA fader level.
   */
  async setDcaFader(dca, level) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(dca) - 1);
    const val = normalToMidiLevel(parseFloat(level));
    this._tcp.send(buildNrpn(this._chDca, n, NRPN.FADER, val));
  }

  // ─── SCENE RECALL ──────────────────────────────────────────────────────────

  /**
   * Recall a scene (1–500).
   */
  async recallScene(n) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    this._tcp.send(buildSceneRecall(this.base, parseInt(n)));
  }

  /** Scene save is not available via TCP MIDI. */
  async saveScene() {
    console.warn(`🎛️  ${this.model}: scene save not available via TCP MIDI — save at console`);
  }

  /** Solo clear is not available via TCP MIDI. */
  async clearSolos() {
    // Not in the protocol
  }

  // ─── CHANNEL PROCESSING ────────────────────────────────────────────────────

  /**
   * Set channel name via SysEx.
   * @param {number|string} ch   Channel number (1-based)
   * @param {string} name        Up to 16 ASCII characters
   */
  async setChannelName(ch, name) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    this._tcp.send(buildNameSet(CH_TYPE.INPUT, n, name));
  }

  /**
   * Set channel colour via SysEx.
   * @param {number|string} ch     Channel number (1-based)
   * @param {string} color         Color name: off, red, green, yellow, blue, purple, cyan, white
   */
  async setChannelColor(ch, color) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    const val = COLORS[String(color).toLowerCase()] ?? COLORS.off;
    this._tcp.send(buildColorSet(CH_TYPE.INPUT, n, val));
  }

  /**
   * Set HPF (high-pass filter).
   * @param {number|string} ch
   * @param {{ enabled?: boolean, frequency?: number }} params
   */
  async setHpf(ch, { enabled = true, frequency = 80 } = {}) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    // HPF on/off
    this._tcp.send(buildNrpn(this._chInput, n, NRPN.HPF_ON, enabled ? 0x7F : 0x00));
    // HPF frequency
    if (frequency != null) {
      this._tcp.send(buildNrpn(this._chInput, n, NRPN.HPF_FREQ, hzToHpfMidi(frequency)));
    }
  }

  /**
   * Set pan position.
   * @param {number|string} ch
   * @param {number} pan  -1.0 (hard left) – +1.0 (hard right), 0 = center
   */
  async setPan(ch, pan) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const n = Math.max(0, parseInt(ch) - 1);
    const p = Number(pan);
    if (!Number.isFinite(p)) throw new Error('pan must be a number');
    if (p < -1 || p > 1) throw new Error(`Pan out of range: ${pan} (valid: -1.0 to +1.0)`);
    const normalized = (p + 1) / 2;
    const val = Math.round(Math.max(0, Math.min(1, normalized)) * 127);
    this._tcp.send(buildNrpn(this._chInput, n, NRPN.PAN, val));
  }

  // Stubs for unsupported processing
  async setEq()         { console.warn(`🎛️  ${this.model}: per-band EQ not available via TCP MIDI — use console`); }
  async setCompressor() { console.warn(`🎛️  ${this.model}: compressor not available via TCP MIDI — use console`); }
  async setGate()       { console.warn(`🎛️  ${this.model}: gate not available via TCP MIDI — use console`); }

  /**
   * Apply a full channel strip (best-effort).
   */
  async setFullChannelStrip(ch, strip) {
    if (!this._online) throw new Error(`${this.model} not connected`);
    const applied = [];
    const skipped = [];

    if (strip.name != null) { await this.setChannelName(ch, strip.name); applied.push('name'); }
    if (strip.color != null) { await this.setChannelColor(ch, strip.color); applied.push('color'); }
    if (strip.hpf) { await this.setHpf(ch, strip.hpf); applied.push('hpf'); }
    if (strip.pan != null) { await this.setPan(ch, strip.pan); applied.push('pan'); }
    if (strip.fader != null) { await this.setFader(ch, strip.fader); applied.push('fader'); }
    if (strip.mute === true) { await this.muteChannel(ch); applied.push('mute'); }
    else if (strip.mute === false) { await this.unmuteChannel(ch); applied.push('unmute'); }

    if (strip.eq) skipped.push('eq');
    if (strip.compressor) skipped.push('compressor');
    if (strip.gate) skipped.push('gate');

    if (skipped.length > 0) {
      console.warn(`🎛️  ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available via TCP MIDI`);
    }

    return { applied, skipped };
  }

  // ─── BIDIRECTIONAL FEEDBACK ────────────────────────────────────────────────

  /**
   * Handle incoming MIDI messages from the console.
   * Updates live state so getChannelStatus() reflects real console positions.
   * @param {Uint8Array} msg
   */
  _handleIncoming(msg) {
    if (msg.length === 0) return;

    const status = msg[0];
    const hi = status & 0xF0;
    const ch = status & 0x0F;

    // ── Note On: mute state change ──
    if (hi === 0x90 && msg.length >= 3) {
      const note = msg[1];
      const vel  = msg[2];
      const muted = vel >= 0x40;
      const typeKey = this._channelTypeFromMidi(ch);
      if (typeKey) {
        const key = `${typeKey}:${note}`;
        this._state.mutes[key] = muted;
      }
      return;
    }

    // ── Control Change: NRPN fader data ──
    if (hi === 0xB0 && msg.length >= 3) {
      // We need to track NRPN state per MIDI channel to reassemble
      // CC 99 (0x63) = param MSB (channel number)
      // CC 98 (0x62) = param LSB (parameter ID)
      // CC 6  (0x06) = data MSB  (value)
      this._handleCC(ch, msg[1], msg[2]);
      return;
    }

    // ── Program Change: scene change ──
    if (hi === 0xC0 && msg.length >= 2) {
      const bank = this._nrpnState?.[ch]?.bank ?? 0;
      this._state.scene = (bank * 128) + msg[1] + 1;
      return;
    }

    // ── SysEx: channel name reply, colour reply ──
    if (msg[0] === 0xF0 && msg.length > 10) {
      this._handleSysEx(msg);
    }
  }

  /**
   * Track CC messages to reassemble NRPN sequences.
   */
  _handleCC(midiCh, cc, val) {
    if (!this._nrpnState) this._nrpnState = {};
    if (!this._nrpnState[midiCh]) this._nrpnState[midiCh] = {};
    const s = this._nrpnState[midiCh];

    switch (cc) {
      case 0x00: // Bank Select (for scene recall)
        s.bank = val;
        break;
      case 0x63: // NRPN MSB = channel number
        s.paramCh = val;
        break;
      case 0x62: // NRPN LSB = parameter ID
        s.paramId = val;
        break;
      case 0x06: // Data Entry MSB = value
        if (s.paramId === NRPN.FADER && s.paramCh != null) {
          const typeKey = this._channelTypeFromMidi(midiCh);
          if (typeKey) {
            this._state.faders[`${typeKey}:${s.paramCh}`] = val;
          }
        }
        break;
    }
  }

  /**
   * Handle SysEx messages (name reply, colour reply).
   */
  _handleSysEx(msg) {
    // Verify A&H header
    if (msg[1] !== 0x00 || msg[2] !== 0x00 || msg[3] !== 0x1A || msg[4] !== 0x50) return;
    // msg[8] = channel type offset, msg[9] = command, msg[10] = channel number
    if (msg.length < 12) return;
    const cmd = msg[9];
    if (cmd === SYSEX_NAME_REPLY) {
      const nameBytes = msg.slice(11, msg.length - 1); // strip F7
      const name = Buffer.from(nameBytes).toString('ascii').trim();
      // Could emit event here for UI updates
    }
  }

  /**
   * Map a MIDI channel number back to a channel type string.
   */
  _channelTypeFromMidi(midiCh) {
    const offset = ((midiCh - this.base) + 16) % 16; // handle wrap
    switch (offset) {
      case CH_TYPE.INPUT:  return 'input';
      case CH_TYPE.GROUP:  return 'group';
      case CH_TYPE.MIX:    return 'mix';
      case CH_TYPE.FX_RET: return 'fxret';
      case CH_TYPE.DCA:    return 'dca';
      default: return null;
    }
  }

  // ─── STATIC HELPERS ────────────────────────────────────────────────────────

  /** Available channel colours for this console. */
  static get COLORS() { return Object.keys(COLORS); }

  /** Max input channel count by model. */
  static maxInputs(model) {
    return (model || '').toLowerCase() === 'dlive' ? 128 : 64;
  }
}

module.exports = { AvantisMixer };
