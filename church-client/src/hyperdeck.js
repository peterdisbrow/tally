const net = require('net');
const { EventEmitter } = require('events');

function parseIntOrNull(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

class HyperDeck extends EventEmitter {
  constructor({ host, port = 9993, name } = {}) {
    super();
    this.host = String(host || '').trim();
    this.port = Number(port) || 9993;
    this.name = String(name || `HyperDeck ${this.host || 'device'}`);

    this.socket = null;
    this.connected = false;
    this._lineBuffer = '';
    this._blockLines = [];
    this._pending = null;
    this._commandChain = Promise.resolve();

    this._status = {
      transport: 'stop',
      recording: false,
      clipId: null,
      slotId: null,
      model: null,
      protocolVersion: null,
      lastResponseCode: null,
      lastSeen: null,
    };
  }

  async connect(timeoutMs = 5000) {
    if (this.connected && this.socket && !this.socket.destroyed) return true;
    if (!this.host) throw new Error('HyperDeck host is required');
    await this.disconnect();

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      const timer = setTimeout(() => finishReject(new Error('HyperDeck connect timeout')), timeoutMs);

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 15_000);

      socket.on('connect', () => {
        this.socket = socket;
        this.connected = true;
        this.emit('connected', this.getStatus());
        this._write('notify: transport: true');
        finishResolve();
      });

      socket.on('data', (chunk) => this._onData(chunk));

      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        this._rejectPending(new Error('HyperDeck disconnected'));
        if (wasConnected) this.emit('disconnected', this.getStatus());
      });

      socket.on('error', (err) => {
        if (!settled) finishReject(err);
      });
    });
  }

  async disconnect() {
    this._rejectPending(new Error('HyperDeck connection closed'));
    this._lineBuffer = '';
    this._blockLines = [];
    if (!this.socket) {
      this.connected = false;
      return true;
    }
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    try {
      socket.end();
      socket.destroy();
    } catch { /* ignore */ }
    return true;
  }

  _onData(chunk) {
    this._lineBuffer += chunk.toString('utf8');
    while (true) {
      const rn = this._lineBuffer.indexOf('\r\n');
      const n = this._lineBuffer.indexOf('\n');
      let idx = -1;
      let skip = 1;
      if (rn >= 0 && (n < 0 || rn <= n)) {
        idx = rn;
        skip = 2;
      } else if (n >= 0) {
        idx = n;
        skip = 1;
      }
      if (idx < 0) break;

      const line = this._lineBuffer.slice(0, idx);
      this._lineBuffer = this._lineBuffer.slice(idx + skip);
      if (line.length === 0) {
        this._flushBlock();
      } else {
        this._blockLines.push(line);
      }
    }
  }

  _flushBlock() {
    if (!this._blockLines.length) return;
    const lines = this._blockLines;
    this._blockLines = [];

    const first = String(lines[0] || '');
    const header = first.match(/^(\d{3})\s*(.*)$/);
    if (!header) return;

    const code = Number.parseInt(header[1], 10);
    const titleRaw = String(header[2] || '').trim();
    const title = titleRaw.replace(/:$/, '').toLowerCase();
    const fields = {};
    for (const line of lines.slice(1)) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) fields[String(m[1] || '').trim().toLowerCase()] = String(m[2] || '').trim();
    }

    const block = { code, title, fields, lines };
    this._status.lastResponseCode = code;
    this._status.lastSeen = new Date().toISOString();
    this._applyBlock(block);
    this._resolvePending(block);
    this.emit('response', block);
  }

  _applyBlock(block) {
    if (block.title.includes('connection info') || block.title.includes('device info')) {
      const model = String(block.fields.model || '').trim();
      if (model) this._status.model = model;
      const version = String(block.fields['protocol version'] || '').trim();
      if (version) this._status.protocolVersion = version;
    }

    if (block.title.includes('transport info')) {
      const transport = String(block.fields.status || '').trim().toLowerCase();
      if (transport) this._status.transport = transport;
      this._status.recording = transport === 'record' || transport === 'recording';
      this._status.clipId = parseIntOrNull(block.fields['clip id']);
      this._status.slotId = parseIntOrNull(block.fields['slot id']);
      this.emit('transport', this.getStatus());
    }
  }

  _resolvePending(block) {
    if (!this._pending) return;
    const pending = this._pending;

    if (pending.acceptCodes.has(block.code)) {
      this._pending = null;
      clearTimeout(pending.timer);
      pending.resolve(block);
      return;
    }

    if (block.code >= 400 && block.code < 500) {
      this._pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error(`HyperDeck command rejected (${block.code})`));
    }
  }

  _rejectPending(err) {
    if (!this._pending) return;
    const pending = this._pending;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  _write(command) {
    if (!this.socket || this.socket.destroyed || !this.connected) {
      throw new Error('HyperDeck not connected');
    }
    const payload = String(command).replace(/\r?\n$/, '') + '\r\n';
    this.socket.write(payload);
  }

  _sendAndWait(command, acceptCodes = [200], timeoutMs = 3000) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.connected || !this.socket || this.socket.destroyed) {
        reject(new Error('HyperDeck not connected'));
        return;
      }
      if (this._pending) {
        reject(new Error('HyperDeck command queue busy'));
        return;
      }

      const timer = setTimeout(() => {
        this._rejectPending(new Error(`HyperDeck command timeout (${command})`));
      }, timeoutMs);

      this._pending = {
        acceptCodes: new Set(acceptCodes),
        resolve,
        reject,
        timer,
      };

      try {
        this._write(command);
      } catch (err) {
        this._rejectPending(err);
      }
    });

    this._commandChain = this._commandChain.then(run, run);
    return this._commandChain;
  }

  async refreshStatus() {
    if (!this.connected) return this.getStatus();
    await this._sendAndWait('transport info', [208, 508]);
    return this.getStatus();
  }

  async play() {
    await this._sendAndWait('play', [200]);
    return this.refreshStatus();
  }

  async stop() {
    await this._sendAndWait('stop', [200]);
    return this.refreshStatus();
  }

  async record() {
    await this._sendAndWait('record', [200]);
    return this.refreshStatus();
  }

  async nextClip() {
    const current = Number(this._status.clipId) || 1;
    const target = Math.max(1, current + 1);
    await this._sendAndWait(`goto: clip id: ${target}`, [200]);
    return this.refreshStatus();
  }

  async prevClip() {
    const current = Number(this._status.clipId) || 1;
    const target = Math.max(1, current - 1);
    await this._sendAndWait(`goto: clip id: ${target}`, [200]);
    return this.refreshStatus();
  }

  getStatus() {
    return {
      name: this.name,
      host: this.host,
      port: this.port,
      connected: this.connected,
      model: this._status.model,
      protocolVersion: this._status.protocolVersion,
      transport: this._status.transport,
      recording: this._status.recording,
      clipId: this._status.clipId,
      slotId: this._status.slotId,
      lastSeen: this._status.lastSeen,
    };
  }
}

module.exports = { HyperDeck };
