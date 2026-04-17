'use strict';

/**
 * MockVideoHub — TCP text-protocol server (port 9990 by default)
 *
 * Simulates a Blackmagic VideoHub so the VideoHub client can connect
 * without real hardware.  Handles the full client–server protocol:
 *
 *   1. On connect: emits PROTOCOL PREAMBLE, FRIENDLY NAME, INPUT LABELS,
 *      OUTPUT LABELS, VIDEO OUTPUT ROUTING.
 *   2. Handles label query/set requests from the client.
 *   3. Handles VIDEO OUTPUT ROUTING requests (query and set).
 *   4. Sends ACK after every successful write command.
 *
 * Test interface:
 *   getRouting()       → { output: inputIndex, … }
 *   getInputLabels()   → { index: label, … }
 *   getOutputLabels()  → { index: label, … }
 */

const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_INPUTS = {
  0: 'Camera 1',
  1: 'Camera 2',
  2: 'Camera 3',
  3: 'Camera 4',
};

const DEFAULT_OUTPUTS = {
  0: 'Monitor 1',
  1: 'Monitor 2',
  2: 'Monitor 3',
  3: 'Monitor 4',
};

const DEFAULT_ROUTES = { 0: 0, 1: 1, 2: 2, 3: 3 };

class MockVideoHub extends EventEmitter {
  constructor() {
    super();
    this._inputLabels  = new Map(Object.entries(DEFAULT_INPUTS).map(([k, v]) => [Number(k), v]));
    this._outputLabels = new Map(Object.entries(DEFAULT_OUTPUTS).map(([k, v]) => [Number(k), v]));
    this._routes       = new Map(Object.entries(DEFAULT_ROUTES).map(([k, v]) => [Number(k), v]));
    this._server  = null;
    this._clients = new Set();
  }

  /** The TCP port the server is listening on (available after start()). */
  get port() {
    return this._server?.address()?.port ?? null;
  }

  /**
   * Start listening.
   * @param {number} [port=0]  0 = pick a random available port
   * @returns {Promise<number>} The bound port number
   */
  async start(port = 0) {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => this._handleClient(socket));
      this._server.once('error', reject);
      this._server.listen(port, '127.0.0.1', () => resolve(this._server.address().port));
    });
  }

  /** Shut down the server and all connected clients. */
  async stop() {
    for (const socket of this._clients) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this._clients.clear();
    return new Promise((resolve) => this._server.close(() => resolve()));
  }

  // ─── CLIENT HANDLER ───────────────────────────────────────────────────────

  _handleClient(socket) {
    this._clients.add(socket);
    socket.once('close', () => this._clients.delete(socket));

    // Send the standard VideoHub greeting
    socket.write('PROTOCOL PREAMBLE:\nVersion: 2.4\n\n');
    socket.write('FRIENDLY NAME:\nMock VideoHub\n\n');
    socket.write(this._buildInputLabelsBlock());
    socket.write(this._buildOutputLabelsBlock());
    socket.write(this._buildRoutingBlock());

    let buf = '';
    socket.on('data', (data) => {
      buf += data.toString();

      // Parse complete double-newline-delimited blocks
      while (true) {
        const blockEnd = buf.indexOf('\n\n');
        if (blockEnd === -1) break;
        const block = buf.substring(0, blockEnd).trim();
        buf = buf.substring(blockEnd + 2);
        if (block) this._handleBlock(socket, block);
      }
    });
  }

  _handleBlock(socket, block) {
    const lines     = block.split('\n');
    const header    = lines[0].replace(/:$/, '').trim();
    const dataLines = lines.slice(1).filter(Boolean);

    switch (header) {
      case 'INPUT LABELS':
        if (dataLines.length === 0) {
          socket.write(this._buildInputLabelsBlock());
        } else {
          for (const line of dataLines) {
            const m = line.match(/^(\d+)\s+(.+)$/);
            if (m) this._inputLabels.set(Number(m[1]), m[2]);
          }
          socket.write('ACK\n\n');
        }
        break;

      case 'OUTPUT LABELS':
        if (dataLines.length === 0) {
          socket.write(this._buildOutputLabelsBlock());
        } else {
          for (const line of dataLines) {
            const m = line.match(/^(\d+)\s+(.+)$/);
            if (m) this._outputLabels.set(Number(m[1]), m[2]);
          }
          socket.write('ACK\n\n');
        }
        break;

      case 'VIDEO OUTPUT ROUTING':
        if (dataLines.length === 0) {
          socket.write(this._buildRoutingBlock());
        } else {
          for (const line of dataLines) {
            const m = line.match(/^(\d+)\s+(\d+)$/);
            if (m) this._routes.set(Number(m[1]), Number(m[2]));
          }
          socket.write('ACK\n\n');
          this.emit('routeChanged', this.getRouting());
        }
        break;

      case 'VIDEO OUTPUT LOCKS':
        if (dataLines.length === 0) {
          socket.write('VIDEO OUTPUT LOCKS:\n0 U\n1 U\n2 U\n3 U\n\n');
        } else {
          socket.write('ACK\n\n');
        }
        break;

      default:
        // Silently ignore unknown blocks (SERIAL PORT ROUTING etc.)
        break;
    }
  }

  // ─── PROTOCOL BLOCK BUILDERS ──────────────────────────────────────────────

  _buildInputLabelsBlock() {
    const lines = Array.from(this._inputLabels.entries())
      .sort(([a], [b]) => a - b)
      .map(([i, l]) => `${i} ${l}`)
      .join('\n');
    return `INPUT LABELS:\n${lines}\n\n`;
  }

  _buildOutputLabelsBlock() {
    const lines = Array.from(this._outputLabels.entries())
      .sort(([a], [b]) => a - b)
      .map(([i, l]) => `${i} ${l}`)
      .join('\n');
    return `OUTPUT LABELS:\n${lines}\n\n`;
  }

  _buildRoutingBlock() {
    const lines = Array.from(this._routes.entries())
      .sort(([a], [b]) => a - b)
      .map(([out, inp]) => `${out} ${inp}`)
      .join('\n');
    return `VIDEO OUTPUT ROUTING:\n${lines}\n\n`;
  }

  // ─── TEST INSPECTION API ──────────────────────────────────────────────────

  /** @returns {{ [output: number]: number }} output → input mapping */
  getRouting() {
    const result = {};
    for (const [out, inp] of this._routes) result[out] = inp;
    return result;
  }

  /** @returns {{ [index: number]: string }} */
  getInputLabels() {
    const result = {};
    for (const [i, l] of this._inputLabels) result[i] = l;
    return result;
  }

  /** @returns {{ [index: number]: string }} */
  getOutputLabels() {
    const result = {};
    for (const [i, l] of this._outputLabels) result[i] = l;
    return result;
  }
}

module.exports = { MockVideoHub };
