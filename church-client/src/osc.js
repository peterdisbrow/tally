/**
 * OSC Client — Lightweight Open Sound Control over UDP
 * Pure Node.js dgram, no external packages.
 *
 * OSC message format:
 *  1. Address string (null-terminated, padded to 4-byte boundary)
 *  2. Type tag string starting with ',' (null-terminated, padded to 4-byte boundary)
 *  3. Arguments packed per type:
 *     i = Int32 big-endian
 *     f = Float32 IEEE-754 big-endian
 *     s = null-terminated string, padded to 4-byte boundary
 *     T = no data (true)
 *     F = no data (false)
 */

const dgram = require('dgram');

// ─── ENCODE HELPERS ────────────────────────────────────────────────────────────

/** Pad a Buffer to the next 4-byte boundary with null bytes. */
function pad4(buf) {
  const rem = buf.length % 4;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rem)]);
}

/** Encode a null-terminated string padded to 4-byte boundary. */
function encodeString(str) {
  return pad4(Buffer.from(str + '\0', 'utf8'));
}

/**
 * Encode OSC message to a Buffer.
 * @param {string} address  - OSC address (e.g. '/ch/01/mix/fader')
 * @param {Array}  args     - Array of { type: 'i'|'f'|'s'|'T'|'F', value: ... }
 */
function encodeMessage(address, args = []) {
  const addrBuf = encodeString(address);

  let typeTags = ',';
  const argBufs = [];

  for (const arg of args) {
    typeTags += arg.type;
    switch (arg.type) {
      case 'i': {
        const b = Buffer.alloc(4);
        b.writeInt32BE(Math.round(arg.value), 0);
        argBufs.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(parseFloat(arg.value), 0);
        argBufs.push(b);
        break;
      }
      case 's':
        argBufs.push(encodeString(String(arg.value ?? '')));
        break;
      case 'T':
      case 'F':
        // No data bytes for booleans
        break;
      default:
        // Skip unknown types
        break;
    }
  }

  const typeTagBuf = encodeString(typeTags);
  return Buffer.concat([addrBuf, typeTagBuf, ...argBufs]);
}

// ─── DECODE HELPERS ─────────────────────────────────────────────────────────────

/** Read a null-terminated OSC string starting at offset; returns { value, nextOffset }. */
function decodeString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.slice(offset, end).toString('utf8');
  const consumed = end - offset + 1; // include the null terminator
  const nextOffset = offset + Math.ceil(consumed / 4) * 4;
  return { value, nextOffset };
}

/**
 * Decode an OSC message from a Buffer.
 * @returns {{ address: string, args: Array<{type,value}> } | null}
 */
function decodeMessage(buf) {
  try {
    let offset = 0;

    const addr = decodeString(buf, offset);
    const address = addr.value;
    offset = addr.nextOffset;

    const tags = decodeString(buf, offset);
    const typeStr = tags.value;
    offset = tags.nextOffset;

    if (!typeStr.startsWith(',')) return { address, args: [] };

    const types = typeStr.slice(1);
    const args = [];

    for (const t of types) {
      switch (t) {
        case 'i':
          args.push({ type: 'i', value: buf.readInt32BE(offset) });
          offset += 4;
          break;
        case 'f':
          args.push({ type: 'f', value: buf.readFloatBE(offset) });
          offset += 4;
          break;
        case 's': {
          const s = decodeString(buf, offset);
          args.push({ type: 's', value: s.value });
          offset = s.nextOffset;
          break;
        }
        case 'T': args.push({ type: 'T', value: true }); break;
        case 'F': args.push({ type: 'F', value: false }); break;
        case 'N': args.push({ type: 'N', value: null }); break;
        case 'I': args.push({ type: 'I', value: Infinity }); break;
        default: break; // skip unknown types
      }
    }

    return { address, args };
  } catch {
    return null;
  }
}

// ─── OSC CLIENT ─────────────────────────────────────────────────────────────────

class OSCClient {
  /**
   * @param {{ host: string, port: number, receivePort?: number }} opts
   *   host/port     → where to SEND OSC messages
   *   receivePort   → local port to bind for incoming messages (null = OS-assigned)
   */
  constructor({ host, port, receivePort = null }) {
    this.host = host;
    this.port = port;
    this.receivePort = receivePort;

    this._socket = null;
    this._bound = false;
    this._bindReady = null;   // Promise that resolves when socket is bound
    this._subscriptions = []; // [{ prefix: string, handler: Function }]
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────────────

  _ensureSocket() {
    if (this._socket) return;

    this._socket = dgram.createSocket('udp4');

    this._socket.on('error', (err) => {
      console.error('🎛️  OSC socket error:', err.message);
    });

    this._socket.on('message', (msg) => {
      const decoded = decodeMessage(msg);
      if (!decoded) return;
      // Iterate over a snapshot so handlers may unsubscribe safely
      for (const sub of [...this._subscriptions]) {
        if (decoded.address.startsWith(sub.prefix)) {
          try { sub.handler(decoded); } catch { /* never crash */ }
        }
      }
    });

    if (this.receivePort) {
      this._bindReady = new Promise((resolve, reject) => {
        this._socket.bind(this.receivePort, () => {
          this._bound = true;
          this._bindReady = null;
          resolve();
        });
        this._socket.once('error', reject);
      });
    }
  }

  /** Ensure socket is bound (needed before we can receive replies). */
  async _waitForBind() {
    if (this._bound) return;
    if (this._bindReady) { await this._bindReady; return; }

    // No receivePort was given — bind to OS-assigned ephemeral port
    this._bindReady = new Promise((resolve, reject) => {
      this._socket.bind(0, () => {
        this._bound = true;
        this._bindReady = null;
        resolve();
      });
      this._socket.once('error', reject);
    });
    await this._bindReady;
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  /** Send an OSC message (fire-and-forget). */
  send(address, args = []) {
    this._ensureSocket();
    const buf = encodeMessage(address, args);
    this._socket.send(buf, 0, buf.length, this.port, this.host, (err) => {
      if (err) console.error('🎛️  OSC send error:', err.message);
    });
  }

  /**
   * Register a handler for incoming messages whose address starts with `prefix`.
   * @returns {Function} call to unsubscribe
   */
  subscribe(prefix, handler) {
    this._ensureSocket();
    const sub = { prefix, handler };
    this._subscriptions.push(sub);
    return () => {
      this._subscriptions = this._subscriptions.filter(s => s !== sub);
    };
  }

  /**
   * Send a message and wait for a response on the same address.
   * Rejects after timeoutMs if no response arrives.
   */
  async query(address, args = [], timeoutMs = 2000) {
    this._ensureSocket();
    await this._waitForBind();

    return new Promise((resolve, reject) => {
      let done = false;

      const timeout = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error(`OSC query timeout: ${address}`));
      }, timeoutMs);

      const handler = (decoded) => {
        if (done) return;
        if (decoded.address === address) {
          done = true;
          cleanup();
          resolve(decoded);
        }
      };

      const unsubscribe = this.subscribe(address, handler);
      const cleanup = () => { clearTimeout(timeout); unsubscribe(); };

      // Send AFTER registering handler so we don't miss a fast response
      const buf = encodeMessage(address, args);
      this._socket.send(buf, 0, buf.length, this.port, this.host, (sendErr) => {
        if (sendErr && !done) {
          done = true;
          cleanup();
          reject(sendErr);
        }
      });
    });
  }

  /** Close the UDP socket and clean up. */
  close() {
    if (this._socket) {
      try { this._socket.close(); } catch { /* ignore */ }
      this._socket = null;
      this._bound = false;
      this._bindReady = null;
    }
    this._subscriptions = [];
  }
}

module.exports = { OSCClient, encodeMessage, decodeMessage };
