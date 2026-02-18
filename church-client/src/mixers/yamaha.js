/**
 * Yamaha CL / QL / TF Mixer Driver
 *
 * CL/QL series: OSC on ports 8765 (console listens) / 9765 (console sends)
 * TF series:    TCP MIDI on port 49280
 *
 * ⚠️  Yamaha's OSC implementation is proprietary and less standardised than X32.
 * Methods that may not work on all models are marked with console.warn.
 * All methods fail gracefully — never crash the agent.
 */

const { OSCClient } = require('../osc');
const net = require('net');

// ─── YAMAHA CL/QL (OSC) ──────────────────────────────────────────────────────

class YamahaCLQL {
  constructor({ host, port = 8765, receivePort = 9765 }) {
    this.host = host;
    this.port = port;
    this.receivePort = receivePort;
    this._osc = null;
    this._online = false;
  }

  async connect() {
    this._osc = new OSCClient({ host: this.host, port: this.port, receivePort: this.receivePort });
    try {
      await this._osc.query('/ymhss/state', [], 3000);
      this._online = true;
    } catch {
      this._online = false;
    }
  }

  async disconnect() {
    if (this._osc) { this._osc.close(); this._osc = null; }
    this._online = false;
  }

  async isOnline() {
    if (!this._osc) return false;
    try {
      await this._osc.query('/ymhss/state', [], 2000);
      this._online = true;
      return true;
    } catch {
      this._online = false;
      return false;
    }
  }

  async getStatus() {
    if (!this._osc) return { online: false, model: 'Yamaha CL/QL', firmware: '', mainFader: 0, mainMuted: false, scene: null };
    try {
      const stateResp = await this._osc.query('/ymhss/state', [], 2000).catch(() => null);
      const online = !!stateResp;
      this._online = online;
      return { online, model: 'Yamaha CL/QL', firmware: '', mainFader: 0, mainMuted: false, scene: null };
    } catch {
      return { online: false, model: 'Yamaha CL/QL', firmware: '', mainFader: 0, mainMuted: false, scene: null };
    }
  }

  async getChannelStatus(ch) {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: getChannelStatus may not work on all CL/QL models');
    try {
      const faderResp = await this._osc.query(`/ymhss/fader/${parseInt(ch)}`, [], 2000).catch(() => null);
      const muteResp  = await this._osc.query(`/ymhss/ch/${parseInt(ch)}/to_st/on`, [], 2000).catch(() => null);
      return {
        fader: faderResp?.args?.[0]?.value ?? 0,
        muted: (muteResp?.args?.[0]?.value ?? 1) === 0,
      };
    } catch {
      return { fader: 0, muted: false };
    }
  }

  async muteChannel(ch) {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: muteChannel may not work on all CL/QL models');
    this._osc.send(`/ymhss/ch/${parseInt(ch)}/to_st/on`, [{ type: 'i', value: 0 }]);
  }

  async unmuteChannel(ch) {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: unmuteChannel may not work on all CL/QL models');
    this._osc.send(`/ymhss/ch/${parseInt(ch)}/to_st/on`, [{ type: 'i', value: 1 }]);
  }

  async setFader(ch, level) {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: setFader may not work on all CL/QL models');
    const clamped = Math.max(0, Math.min(1, parseFloat(level)));
    this._osc.send(`/ymhss/fader/${parseInt(ch)}`, [{ type: 'f', value: clamped }]);
  }

  async muteMaster() {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: muteMaster may not work on all CL/QL models');
    this._osc.send('/ymhss/fader/0', [{ type: 'f', value: 0 }]);
  }

  async unmuteMaster() {
    if (!this._osc) throw new Error('Yamaha not connected');
    console.warn('🎛️  Yamaha: unmuteMaster may not work on all CL/QL models');
    this._osc.send('/ymhss/fader/0', [{ type: 'f', value: 0.75 }]);
  }

  async recallScene(n) {
    if (!this._osc) throw new Error('Yamaha not connected');
    this._osc.send('/ymhss/scene/recall', [{ type: 'i', value: parseInt(n) }]);
  }

  async clearSolos() {
    // Yamaha CL/QL does not expose solo clear via documented OSC
  }
}

// ─── YAMAHA TF (TCP MIDI) ────────────────────────────────────────────────────

class YamahaTF {
  constructor({ host, port = 49280 }) {
    this.host = host;
    this.port = port;
    this._socket = null;
    this._online = false;
  }

  async connect() {
    try {
      await this._tcpConnect();
      this._online = true;
    } catch {
      this._online = false;
    }
  }

  _tcpConnect() {
    return new Promise((resolve, reject) => {
      this._socket = new net.Socket();
      this._socket.setTimeout(3000);
      this._socket.connect(this.port, this.host, () => {
        this._socket.setTimeout(0); // clear timeout after connect
        resolve();
      });
      this._socket.on('error', reject);
      this._socket.on('timeout', () => reject(new Error('TF TCP timeout')));
      this._socket.on('close', () => { this._online = false; this._socket = null; });
    });
  }

  async disconnect() {
    if (this._socket) {
      try { this._socket.destroy(); } catch { /* ignore */ }
      this._socket = null;
    }
    this._online = false;
  }

  async isOnline() {
    // Try a fresh TCP connect
    return new Promise((resolve) => {
      const testSocket = new net.Socket();
      testSocket.setTimeout(2000);
      testSocket.connect(this.port, this.host, () => {
        testSocket.destroy();
        this._online = true;
        resolve(true);
      });
      testSocket.on('error', () => { testSocket.destroy(); this._online = false; resolve(false); });
      testSocket.on('timeout', () => { testSocket.destroy(); this._online = false; resolve(false); });
    });
  }

  async getStatus() {
    const online = await this.isOnline();
    return { online, model: 'Yamaha TF', firmware: '', mainFader: 0, mainMuted: false, scene: null };
  }

  async getChannelStatus() {
    console.warn('🎛️  Yamaha TF: getChannelStatus not available via TCP MIDI');
    return { fader: 0, muted: false };
  }

  _sendMidi(bytes) {
    if (!this._socket || this._socket.destroyed) return;
    try { this._socket.write(Buffer.from(bytes)); } catch { /* ignore */ }
  }

  async muteChannel(ch) {
    console.warn('🎛️  Yamaha TF: muteChannel via TCP MIDI is model-specific');
    // MIDI Note On (ch 1) for mute toggle — channel 1-based mapped to note 0-based
    this._sendMidi([0x90, Math.max(0, parseInt(ch) - 1), 127]);
  }

  async unmuteChannel(ch) {
    console.warn('🎛️  Yamaha TF: unmuteChannel via TCP MIDI is model-specific');
    this._sendMidi([0x80, Math.max(0, parseInt(ch) - 1), 0]);
  }

  async setFader() {
    console.warn('🎛️  Yamaha TF: setFader not reliably available via TCP MIDI');
  }

  async muteMaster() {
    console.warn('🎛️  Yamaha TF: muteMaster not reliably available via TCP MIDI');
  }

  async unmuteMaster() {
    console.warn('🎛️  Yamaha TF: unmuteMaster not reliably available via TCP MIDI');
  }

  async recallScene(n) {
    // Program Change on MIDI channel 1 (0-indexed)
    this._sendMidi([0xC0, Math.max(0, parseInt(n) - 1)]);
  }

  async clearSolos() {
    // Not available via TCP MIDI
  }
}

// ─── YAMAHA MIXER FACADE ─────────────────────────────────────────────────────

class YamahaMixer {
  /**
   * @param {{ host: string, port?: number, model?: string }} opts
   *   model: 'CL' | 'QL' | 'TF' (default 'CL')
   */
  constructor({ host, port, model = 'CL' }) {
    this.model = model.toUpperCase();
    if (this.model === 'TF') {
      this._impl = new YamahaTF({ host, port: port || 49280 });
    } else {
      // CL, QL, or other — use OSC
      this._impl = new YamahaCLQL({ host, port: port || 8765 });
    }
  }

  async connect()                   { return this._impl.connect(); }
  async disconnect()                { return this._impl.disconnect(); }
  async isOnline()                  { return this._impl.isOnline(); }
  async getStatus()                 { return this._impl.getStatus(); }
  async getChannelStatus(ch)        { return this._impl.getChannelStatus(ch); }
  async muteChannel(ch)             { return this._impl.muteChannel(ch); }
  async unmuteChannel(ch)           { return this._impl.unmuteChannel(ch); }
  async setFader(ch, level)         { return this._impl.setFader(ch, level); }
  async muteMaster()                { return this._impl.muteMaster(); }
  async unmuteMaster()              { return this._impl.unmuteMaster(); }
  async recallScene(n)              { return this._impl.recallScene(n); }
  async clearSolos()                { return this._impl.clearSolos(); }
}

module.exports = { YamahaMixer };
