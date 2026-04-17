'use strict';

/**
 * MockAllenHeath — TCP MIDI server (port 51325 by default)
 *
 * Simulates an Allen & Heath SQ console's TCP MIDI interface so the
 * AllenHeathMixer driver can connect without real hardware.
 *
 * Accepts raw MIDI bytes, parses NRPN (Non-Registered Parameter Number)
 * four-message sequences, and maintains internal mute/fader state.
 *
 * NRPN wire format (12 bytes per parameter set):
 *   [0xB0|ch] 0x63 paramMSB   ← NRPN MSB
 *   [0xB0|ch] 0x62 paramLSB   ← NRPN LSB
 *   [0xB0|ch] 0x06 valueMSB   ← Data Entry Coarse
 *   [0xB0|ch] 0x26 valueLSB   ← Data Entry Fine
 *
 * Test interface:
 *   getMuteState(paramMsb, paramLsb) → boolean
 *   getFaderLevel(paramMsb, paramLsb) → 14-bit number (0–16383)
 *   getReceivedBytes()  → number[]  all raw bytes ever received
 *   clearReceivedBytes()
 *   waitForBytes(count, timeoutMs) → Promise<void>  resolves when ≥ count bytes received
 */

const net = require('net');
const { EventEmitter } = require('events');

// ─── NRPN STATE PARSER ────────────────────────────────────────────────────────

/**
 * Stateful NRPN message assembler.  Handles running-status and fragmented TCP
 * delivery.  Emits a complete { ch, paramMsb, paramLsb, vc, vf } object once
 * the four-CC sequence is fully received.
 */
class NrpnTracker {
  constructor(onComplete) {
    this._onComplete = onComplete;
    this._state = {};
  }

  /**
   * Feed raw bytes.  May call onComplete zero or more times.
   * @param {number[]} bytes
   */
  feed(bytes) {
    // Bytes arrive as groups of 3: [status, cc, value]
    // Running-status means status may be omitted when the same status repeats.
    let i = 0;
    let runningStatus = null;

    while (i < bytes.length) {
      const b = bytes[i];
      if (b & 0x80) {
        // New status byte
        runningStatus = b;
        i++;
      }

      if (runningStatus == null) { i++; continue; }

      const hi = runningStatus & 0xF0;
      if (hi !== 0xB0) {
        // Not a CC — skip this data byte pair
        i += 2;
        continue;
      }

      // Need 2 data bytes
      if (i + 1 >= bytes.length) break;

      const cc  = bytes[i];
      const val = bytes[i + 1];
      i += 2;

      const ch = runningStatus & 0x0F;
      if (!this._state[ch]) this._state[ch] = {};
      const s = this._state[ch];

      switch (cc) {
        case 0x63: s.paramMsb = val; break;
        case 0x62: s.paramLsb = val; break;
        case 0x06: s.vc       = val; break;
        case 0x26:
          if (s.paramMsb != null && s.paramLsb != null) {
            this._onComplete({
              ch,
              paramMsb: s.paramMsb,
              paramLsb: s.paramLsb,
              vc: s.vc ?? 0,
              vf: val,
            });
          }
          break;
        default:
          break;
      }
    }
  }

  reset() {
    this._state = {};
  }
}

// ─── MOCK SERVER ──────────────────────────────────────────────────────────────

class MockAllenHeath extends EventEmitter {
  constructor() {
    super();
    this._server        = null;
    this._clients       = new Set();
    this._receivedBytes = [];   // all raw bytes (for assertion)
    this._muteState     = {};   // `${msb}:${lsb}` → boolean
    this._faderState    = {};   // `${msb}:${lsb}` → 14-bit value

    this._tracker = new NrpnTracker((nrpn) => {
      const key  = `${nrpn.paramMsb}:${nrpn.paramLsb}`;
      const data = (nrpn.vc << 7) | nrpn.vf;

      // Mute parameters have paramMsb <= 0x04 (SQ mute address space)
      if (nrpn.paramMsb <= 0x04) {
        this._muteState[key] = nrpn.vf === 0x01;
      } else {
        this._faderState[key] = data;
      }

      this.emit('nrpn', nrpn);
    });
  }

  /** The port the server is bound to (available after start()). */
  get port() {
    return this._server?.address()?.port ?? null;
  }

  /**
   * Start listening.
   * @param {number} [port=0]  0 = random available port
   * @returns {Promise<number>} bound port
   */
  async start(port = 0) {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => this._handleClient(socket));
      this._server.once('error', reject);
      this._server.listen(port, '127.0.0.1', () => resolve(this._server.address().port));
    });
  }

  async stop() {
    for (const socket of this._clients) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this._clients.clear();
    return new Promise((resolve) => this._server.close(() => resolve()));
  }

  _handleClient(socket) {
    this._clients.add(socket);
    socket.once('close', () => this._clients.delete(socket));
    this.emit('clientConnected', socket);

    socket.on('data', (data) => {
      const bytes = Array.from(data);
      this._receivedBytes.push(...bytes);
      this._tracker.feed(bytes);
      this.emit('data', data);
    });
  }

  // ─── TEST INSPECTION API ──────────────────────────────────────────────────

  /** Raw bytes received from all connected clients. */
  getReceivedBytes() {
    return [...this._receivedBytes];
  }

  clearReceivedBytes() {
    this._receivedBytes = [];
    this._tracker.reset();
    this._muteState  = {};
    this._faderState = {};
  }

  /**
   * Query decoded mute state for an NRPN parameter address.
   * @param {number} paramMsb
   * @param {number} paramLsb
   * @returns {boolean} true = muted
   */
  getMuteState(paramMsb, paramLsb) {
    return this._muteState[`${paramMsb}:${paramLsb}`] ?? false;
  }

  /**
   * Query decoded fader/level value for an NRPN parameter address.
   * @param {number} paramMsb
   * @param {number} paramLsb
   * @returns {number} 14-bit value (0–16383)
   */
  getFaderLevel(paramMsb, paramLsb) {
    return this._faderState[`${paramMsb}:${paramLsb}`] ?? 0;
  }

  /**
   * Resolves once at least `count` bytes have been received, or rejects on timeout.
   * @param {number} count
   * @param {number} [timeoutMs=2000]
   */
  waitForBytes(count, timeoutMs = 2000) {
    if (this._receivedBytes.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('data', check);
        reject(new Error(`Timeout: expected ${count} bytes, got ${this._receivedBytes.length}`));
      }, timeoutMs);

      const check = () => {
        if (this._receivedBytes.length >= count) {
          clearTimeout(timer);
          this.removeListener('data', check);
          resolve();
        }
      };
      this.on('data', check);
    });
  }

  /**
   * Resolves once an NRPN event matching the given address is received.
   * @param {number} paramMsb
   * @param {number} paramLsb
   * @param {number} [timeoutMs=2000]
   */
  waitForNrpn(paramMsb, paramLsb, timeoutMs = 2000) {
    const key = `${paramMsb}:${paramLsb}`;
    // Already received?
    if (key in this._muteState || key in this._faderState) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('nrpn', handler);
        reject(new Error(`Timeout waiting for NRPN ${paramMsb}:${paramLsb}`));
      }, timeoutMs);

      const handler = (nrpn) => {
        if (nrpn.paramMsb === paramMsb && nrpn.paramLsb === paramLsb) {
          clearTimeout(timer);
          this.removeListener('nrpn', handler);
          resolve(nrpn);
        }
      };
      this.on('nrpn', handler);
    });
  }
}

module.exports = { MockAllenHeath };
