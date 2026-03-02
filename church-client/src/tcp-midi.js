/**
 * tcp-midi.js — Generic TCP MIDI Transport
 *
 * Shared low-level TCP socket that sends and receives raw MIDI bytes.
 * Used by the Avantis driver (port 51325) and Yamaha TF driver (port 49280).
 *
 * Features:
 *   • Auto-reconnect with exponential backoff
 *   • MIDI running-status parser for incoming data
 *   • Buffered message assembly (TCP can split/merge MIDI messages)
 *   • Event-based: emits parsed MIDI messages via callback
 */

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

// ─── MIDI STATUS BYTE HELPERS ────────────────────────────────────────────────

const isStatusByte   = (b) => (b & 0x80) !== 0;
const isSystemRealtime = (b) => b >= 0xF8;           // clock, start, stop, etc.
const isSysExStart   = (b) => b === 0xF0;
const isSysExEnd     = (b) => b === 0xF7;

/**
 * Expected data-byte count for a given channel-voice status byte.
 * Returns 0 for system realtime, -1 for SysEx (variable length).
 */
function dataByteCount(status) {
  if (isSystemRealtime(status)) return 0;
  if (isSysExStart(status))     return -1; // variable — terminated by 0xF7
  const hi = status & 0xF0;
  switch (hi) {
    case 0x80: return 2; // Note Off
    case 0x90: return 2; // Note On
    case 0xA0: return 2; // Poly Aftertouch
    case 0xB0: return 2; // Control Change
    case 0xC0: return 1; // Program Change
    case 0xD0: return 1; // Channel Pressure
    case 0xE0: return 2; // Pitch Bend
    default:   return 0; // unknown — skip
  }
}

// ─── MIDI PARSER ─────────────────────────────────────────────────────────────

/**
 * Stateful MIDI parser that handles running status and SysEx.
 * Emits complete messages as Uint8Arrays via the onMessage callback.
 */
class MidiParser {
  constructor(onMessage) {
    this._onMessage = onMessage;
    this._runningStatus = 0;
    this._expected = 0;
    this._buf = [];
    this._inSysEx = false;
    this._sysExBuf = [];
  }

  /**
   * Feed raw bytes from TCP.  May emit zero, one, or many messages.
   * @param {Buffer} data
   */
  feed(data) {
    for (let i = 0; i < data.length; i++) {
      const b = data[i];

      // ── System Realtime: emit immediately, don't affect running status ──
      if (isSystemRealtime(b)) {
        this._onMessage(new Uint8Array([b]));
        continue;
      }

      // ── SysEx handling ──
      if (this._inSysEx) {
        this._sysExBuf.push(b);
        if (isSysExEnd(b)) {
          this._onMessage(new Uint8Array(this._sysExBuf));
          this._sysExBuf = [];
          this._inSysEx = false;
        }
        continue;
      }

      if (isSysExStart(b)) {
        this._inSysEx = true;
        this._sysExBuf = [b];
        continue;
      }

      // ── Channel voice / mode messages ──
      if (isStatusByte(b)) {
        // New status byte — flush any partial message
        this._buf = [b];
        this._runningStatus = b;
        this._expected = dataByteCount(b);
        if (this._expected === 0) {
          this._emit();
        }
      } else {
        // Data byte — use running status if no status byte yet
        if (this._buf.length === 0 && this._runningStatus) {
          this._buf = [this._runningStatus];
          this._expected = dataByteCount(this._runningStatus);
        }
        this._buf.push(b);
        if (this._buf.length === 1 + this._expected) {
          this._emit();
        }
      }
    }
  }

  _emit() {
    if (this._buf.length > 0) {
      this._onMessage(new Uint8Array(this._buf));
      this._buf = [];
    }
  }

  reset() {
    this._runningStatus = 0;
    this._expected = 0;
    this._buf = [];
    this._inSysEx = false;
    this._sysExBuf = [];
  }
}

// ─── TCP MIDI CLIENT ─────────────────────────────────────────────────────────

const RECONNECT_BASE_MS  = 1000;
const RECONNECT_MAX_MS   = 30000;
const CONNECT_TIMEOUT_MS = 5000;
const HEALTH_CHECK_MS    = 2000;

class TcpMidi extends EventEmitter {
  /**
   * @param {{ host: string, port: number, autoReconnect?: boolean }} opts
   */
  constructor({ host, port, autoReconnect = true }) {
    super();
    this.host = host;
    this.port = port;
    this.autoReconnect = autoReconnect;

    this._socket = null;
    this._online = false;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._intentionalClose = false;

    this._parser = new MidiParser((msg) => this.emit('midi', msg));
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  /**
   * Open TCP connection.  Resolves when connected, rejects on failure.
   */
  connect() {
    return new Promise((resolve, reject) => {
      this._intentionalClose = false;
      this._clearReconnectTimer();

      this._socket = new net.Socket();
      this._socket.setTimeout(CONNECT_TIMEOUT_MS);

      this._socket.connect(this.port, this.host, () => {
        this._socket.setTimeout(0);
        this._online = true;
        this._reconnectDelay = RECONNECT_BASE_MS;
        this._parser.reset();
        this.emit('connected');
        resolve();
      });

      this._socket.on('data', (buf) => {
        this._parser.feed(buf);
      });

      this._socket.on('error', (err) => {
        if (!this._online) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });

      this._socket.on('timeout', () => {
        if (!this._online) {
          this._socket.destroy();
          reject(new Error(`TCP MIDI connect timeout ${this.host}:${this.port}`));
        }
      });

      this._socket.on('close', () => {
        const wasOnline = this._online;
        this._online = false;
        this._socket = null;

        if (wasOnline) {
          this.emit('disconnected');
        }

        if (!this._intentionalClose && this.autoReconnect) {
          this._scheduleReconnect();
        }
      });
    });
  }

  /**
   * Gracefully close.
   */
  disconnect() {
    this._intentionalClose = true;
    this._clearReconnectTimer();
    if (this._socket) {
      try { this._socket.destroy(); } catch { /* ignore */ }
      this._socket = null;
    }
    this._online = false;
    this._parser.reset();
  }

  /**
   * Non-destructive health check — opens a fresh test socket.
   */
  isOnline() {
    return new Promise((resolve) => {
      if (this._online && this._socket && !this._socket.destroyed) {
        resolve(true);
        return;
      }
      const test = new net.Socket();
      test.setTimeout(HEALTH_CHECK_MS);
      test.connect(this.port, this.host, () => {
        test.destroy();
        resolve(true);
      });
      test.on('error', () => { test.destroy(); resolve(false); });
      test.on('timeout', () => { test.destroy(); resolve(false); });
    });
  }

  get online() { return this._online; }

  // ─── SEND ───────────────────────────────────────────────────────────────────

  /**
   * Send raw MIDI bytes over the TCP socket.
   * @param {number[]|Uint8Array|Buffer} bytes
   */
  send(bytes) {
    if (!this._socket || this._socket.destroyed) return false;
    try {
      this._socket.write(Buffer.from(bytes));
      return true;
    } catch {
      return false;
    }
  }

  // ─── RECONNECT ──────────────────────────────────────────────────────────────

  _scheduleReconnect() {
    this._clearReconnectTimer();
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_MS);

    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // connect failed — close handler will schedule next attempt
      }
    }, delay);
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = { TcpMidi, MidiParser };
