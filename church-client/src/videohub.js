/**
 * Blackmagic Video Hub Client
 * Connects via TCP port 9990 using the Videohub text protocol.
 */

const net = require('net');
const { EventEmitter } = require('events');

class VideoHub extends EventEmitter {
  constructor({ ip, port = 9990, name = '' }) {
    super();
    this.ip = ip;
    this.port = port;
    this.name = name || ip;
    this.socket = null;
    this.connected = false;
    this._buffer = '';
    this._inputLabels = new Map();   // index → label
    this._outputLabels = new Map();  // index → label
    this._routes = new Map();        // outputIndex → inputIndex
    this._reconnectDelay = 2000;
    this._reconnecting = false;
    this._destroyed = false;
    this._pendingCallbacks = [];     // { blockType, resolve }
  }

  async connect() {
    if (this._destroyed) return;
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      let resolved = false;

      this.socket.setTimeout(5000);

      this.socket.on('connect', () => {
        this.connected = true;
        this._reconnectDelay = 2000;
        this._reconnecting = false;
        console.log(`✅ Video Hub "${this.name}" connected (${this.ip}:${this.port})`);
        this.emit('connected');
        if (!resolved) { resolved = true; resolve(); }
      });

      this.socket.on('data', (data) => {
        this._buffer += data.toString();
        this._parseBuffer();
      });

      this.socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) {
          console.warn(`⚠️  Video Hub "${this.name}" disconnected`);
          this.emit('disconnected');
        }
        if (!resolved) { resolved = true; resolve(); }
        this._reconnect();
      });

      this.socket.on('error', (err) => {
        if (!resolved) { resolved = true; resolve(); }
        console.warn(`Video Hub "${this.name}" error: ${err.message}`);
      });

      this.socket.on('timeout', () => {
        if (!resolved) { resolved = true; resolve(); }
        this.socket.destroy();
      });

      this.socket.connect(this.port, this.ip);
    });
  }

  _reconnect() {
    if (this._destroyed || this._reconnecting) return;
    this._reconnecting = true;
    setTimeout(() => {
      this._reconnecting = false;
      if (!this._destroyed) this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60000);
  }

  async disconnect() {
    this._destroyed = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  // ─── PROTOCOL PARSER ─────────────────────────────────────────────────────

  _parseBuffer() {
    // Protocol: blocks separated by double newline. Each block has a header line followed by data lines.
    while (true) {
      const blockEnd = this._buffer.indexOf('\n\n');
      if (blockEnd === -1) break;

      const block = this._buffer.substring(0, blockEnd).trim();
      this._buffer = this._buffer.substring(blockEnd + 2);

      if (!block) continue;
      this._handleBlock(block);
    }
  }

  _handleBlock(block) {
    const lines = block.split('\n');
    const header = lines[0].replace(/:$/, '').trim();
    const dataLines = lines.slice(1);

    switch (header) {
      case 'PROTOCOL PREAMBLE':
        // Initial handshake — request full state
        this._send('INPUT LABELS:\n\n');
        this._send('OUTPUT LABELS:\n\n');
        this._send('VIDEO OUTPUT ROUTING:\n\n');
        break;

      case 'VIDEOHUB DEVICE':
        // Device info — ignore for now
        break;

      case 'INPUT LABELS':
        for (const line of dataLines) {
          const m = line.match(/^(\d+)\s+(.+)$/);
          if (m) this._inputLabels.set(parseInt(m[1]), m[2]);
        }
        this._resolvePending('INPUT LABELS');
        break;

      case 'OUTPUT LABELS':
        for (const line of dataLines) {
          const m = line.match(/^(\d+)\s+(.+)$/);
          if (m) this._outputLabels.set(parseInt(m[1]), m[2]);
        }
        this._resolvePending('OUTPUT LABELS');
        break;

      case 'VIDEO OUTPUT ROUTING':
        for (const line of dataLines) {
          const m = line.match(/^(\d+)\s+(\d+)$/);
          if (m) {
            const out = parseInt(m[1]);
            const inp = parseInt(m[2]);
            const oldInput = this._routes.get(out);
            this._routes.set(out, inp);
            if (oldInput !== undefined && oldInput !== inp) {
              this.emit('routeChanged', { output: out, input: inp, outputLabel: this._outputLabels.get(out), inputLabel: this._inputLabels.get(inp) });
            }
          }
        }
        this._resolvePending('VIDEO OUTPUT ROUTING');
        break;

      case 'VIDEO OUTPUT LOCKS':
        if (!this._outputLocks) this._outputLocks = new Map();
        for (const line of dataLines) {
          const m = line.match(/^(\d+)\s+([OLU])$/);
          if (m) this._outputLocks.set(parseInt(m[1]), m[2]);
        }
        this._resolvePending('VIDEO OUTPUT LOCKS');
        break;

      case 'SERIAL PORT ROUTING':
      case 'PROCESSING UNIT ROUTING':
      case 'VIDEO MONITORING OUTPUT ROUTING':
        this._resolvePending(header);
        break;

      case 'ACK':
        this._resolvePending('ACK');
        break;

      case 'NAK':
        console.warn(`Video Hub "${this.name}" NAK received`);
        this._resolvePending('NAK', true);
        break;

      default:
        // Unknown block — ignore
        break;
    }
  }

  _resolvePending(blockType, isError = false) {
    const idx = this._pendingCallbacks.findIndex(p => p.blockType === blockType || p.blockType === 'ACK');
    if (idx !== -1) {
      const cb = this._pendingCallbacks.splice(idx, 1)[0];
      if (isError) cb.reject?.(new Error('NAK'));
      else cb.resolve();
    }
  }

  _send(data) {
    if (this.socket && this.connected) {
      this.socket.write(data);
    }
  }

  _sendAndWait(data, expectBlock, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      let entry;
      const timer = setTimeout(() => {
        const idx = this._pendingCallbacks.findIndex(p => p === entry);
        if (idx !== -1) this._pendingCallbacks.splice(idx, 1);
        reject(new Error(`Timeout waiting for ${expectBlock}`));
      }, timeoutMs);

      entry = {
        blockType: expectBlock,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this._pendingCallbacks.push(entry);
      this._send(data);
    });
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────

  async getRoutes() {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    await this._sendAndWait('VIDEO OUTPUT ROUTING:\n\n', 'VIDEO OUTPUT ROUTING');
    const routes = [];
    for (const [output, input] of this._routes) {
      routes.push({
        output,
        input,
        outputLabel: this._outputLabels.get(output) || `Output ${output}`,
        inputLabel: this._inputLabels.get(input) || `Input ${input}`,
      });
    }
    return routes.sort((a, b) => a.output - b.output);
  }

  async getInputLabels() {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    await this._sendAndWait('INPUT LABELS:\n\n', 'INPUT LABELS');
    const labels = [];
    for (const [index, label] of this._inputLabels) {
      labels.push({ index, label });
    }
    return labels.sort((a, b) => a.index - b.index);
  }

  async getOutputLabels() {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    await this._sendAndWait('OUTPUT LABELS:\n\n', 'OUTPUT LABELS');
    const labels = [];
    for (const [index, label] of this._outputLabels) {
      labels.push({ index, label });
    }
    return labels.sort((a, b) => a.index - b.index);
  }

  async setRoute(output, input) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`VIDEO OUTPUT ROUTING:\n${output} ${input}\n\n`, 'ACK');
      this._routes.set(output, input);
      return true;
    } catch {
      return false;
    }
  }

  async setInputLabel(index, label) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`INPUT LABELS:\n${index} ${label}\n\n`, 'ACK');
      this._inputLabels.set(index, label);
      return true;
    } catch {
      return false;
    }
  }

  async setOutputLabel(index, label) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`OUTPUT LABELS:\n${index} ${label}\n\n`, 'ACK');
      this._outputLabels.set(index, label);
      return true;
    } catch {
      return false;
    }
  }

  // ─── COMPANION PARITY: Lock/Unlock Output ──────────────────────────────

  async lockOutput(output, lockState = 'O') {
    // Lock states: 'O' = owned (locked by us), 'L' = locked (by another), 'U' = unlocked
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`VIDEO OUTPUT LOCKS:\n${output} ${lockState}\n\n`, 'ACK');
      if (!this._outputLocks) this._outputLocks = new Map();
      this._outputLocks.set(output, lockState);
      return true;
    } catch {
      return false;
    }
  }

  async unlockOutput(output) {
    return this.lockOutput(output, 'U');
  }

  async getOutputLocks() {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    await this._sendAndWait('VIDEO OUTPUT LOCKS:\n\n', 'VIDEO OUTPUT LOCKS');
    const locks = [];
    if (this._outputLocks) {
      for (const [index, state] of this._outputLocks) {
        locks.push({
          output: index,
          state,
          label: this._outputLabels.get(index) || `Output ${index}`,
          locked: state !== 'U',
        });
      }
    }
    return locks.sort((a, b) => a.output - b.output);
  }

  // ─── COMPANION PARITY: Serial Port Routing ────────────────────────────

  async setSerialRoute(output, input) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`SERIAL PORT ROUTING:\n${output} ${input}\n\n`, 'ACK');
      return true;
    } catch {
      return false;
    }
  }

  // ─── COMPANION PARITY: Processing Unit Routing ────────────────────────

  async setProcessingRoute(output, input) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`PROCESSING UNIT ROUTING:\n${output} ${input}\n\n`, 'ACK');
      return true;
    } catch {
      return false;
    }
  }

  // ─── COMPANION PARITY: Monitoring Output Routing ──────────────────────

  async setMonitoringRoute(output, input) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    try {
      await this._sendAndWait(`VIDEO MONITORING OUTPUT ROUTING:\n${output} ${input}\n\n`, 'ACK');
      return true;
    } catch {
      return false;
    }
  }

  // ─── COMPANION PARITY: Bulk Route Load ────────────────────────────────

  async setBulkRoutes(routes) {
    if (!this.connected) throw new Error(`Video Hub "${this.name}" not connected`);
    const lines = routes.map(r => `${r.output} ${r.input}`).join('\n');
    try {
      await this._sendAndWait(`VIDEO OUTPUT ROUTING:\n${lines}\n\n`, 'ACK');
      for (const r of routes) {
        this._routes.set(r.output, r.input);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Summary for status reporting */
  toStatus() {
    // Serialize route map for failover source capture
    const routes = {};
    for (const [output, input] of this._routes) {
      routes[String(output)] = input;
    }
    const inputLabels = {};
    for (const [index, label] of this._inputLabels) {
      inputLabels[String(index)] = label;
    }
    const outputLabels = {};
    for (const [index, label] of this._outputLabels) {
      outputLabels[String(index)] = label;
    }

    return {
      ip: this.ip,
      name: this.name,
      connected: this.connected,
      routeCount: this._routes.size,
      inputCount: this._inputLabels.size,
      outputCount: this._outputLabels.size,
      routes,
      inputLabels,
      outputLabels,
    };
  }
}

module.exports = { VideoHub };
