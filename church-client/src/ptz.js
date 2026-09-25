/**
 * PTZ protocol bridge for common network camera control protocols.
 *
 * Supported protocols:
 * - onvif           (SOAP over HTTP, ONVIF PTZ service)
 * - ptzoptics-onvif (ONVIF profile with PTZOptics defaults)
 * - ptzoptics-visca (VISCA TCP profile with PTZOptics defaults)
 * - visca-tcp       (raw VISCA over TCP, common default port 5678)
 * - visca-udp       (raw VISCA over UDP, common default port 1259)
 * - sony-visca-udp  (Sony VISCA-over-IP UDP framing, common port 52381)
 * - auto            (tries ONVIF, then VISCA TCP, then VISCA UDP)
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const dgram = require('node:dgram');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function boolXml(value) {
  return value ? 'true' : 'false';
}

function toIsoDuration(ms) {
  const safeMs = Math.max(100, Number(ms) || 300);
  const seconds = (safeMs / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `PT${seconds}S`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProtocol(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'auto') return 'auto';
  if (raw === 'onvif') return 'onvif';
  if (raw === 'ptzoptics-onvif') return 'ptzoptics-onvif';
  if (raw === 'ptzoptics' || raw === 'ptzoptics-visca' || raw === 'ptzoptics-visca-tcp') return 'ptzoptics-visca';
  if (raw === 'visca' || raw === 'visca-tcp' || raw === 'tcp') return 'visca-tcp';
  if (raw === 'visca-udp' || raw === 'udp') return 'visca-udp';
  if (raw === 'sony-visca' || raw === 'sony-visca-udp' || raw === 'visca-sony') return 'sony-visca-udp';
  if (raw === 'atem') return 'atem';
  return raw;
}

function defaultPortForProtocol(protocol) {
  switch (normalizeProtocol(protocol)) {
    case 'onvif': return 80;
    case 'ptzoptics-onvif': return 80;
    case 'ptzoptics-visca': return 5678;
    case 'visca-udp': return 1259;
    case 'sony-visca-udp': return 52381;
    case 'visca-tcp':
    default:
      return 5678;
  }
}

class BasePtzCamera {
  constructor(config = {}) {
    this.ip = config.ip || '';
    this.name = config.name || this.ip || 'PTZ';
    this.protocol = normalizeProtocol(config.protocol);
    this.port = Number(config.port) || defaultPortForProtocol(this.protocol);
    this.username = config.username || '';
    this.password = config.password || '';
    this.connected = false;
    this.error = null;
  }

  toStatus() {
    return {
      name: this.name,
      ip: this.ip,
      protocol: this.protocol,
      port: this.port,
      connected: !!this.connected,
      error: this.error || null,
    };
  }
}

const VISCA_ERRORS = {
  0x01: 'VISCA message length error',
  0x02: 'VISCA syntax error (camera rejected the command)',
  0x03: 'VISCA command buffer full (camera busy)',
  0x04: 'VISCA command cancelled',
  0x05: 'VISCA no socket (command already finished)',
  0x41: 'VISCA command not executable (camera in standby or busy)',
};
const SONY_TYPE = { COMMAND: 0x0100, INQUIRY: 0x0110, REPLY: 0x0111, CONTROL: 0x0200, CONTROL_REPLY: 0x0201 };

class ViscaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * VISCA camera over TCP (PTZOptics 5678), raw UDP (1259) or Sony VISCA-over-IP
 * (UDP 52381). "Connected" means the camera ANSWERED a VISCA inquiry — never
 * just "the port is open" or "the datagram left this machine". Commands wait
 * for the camera's ACK + Completion and surface VISCA errors (syntax, buffer
 * full, not executable/standby). One transaction at a time per camera.
 */
class ViscaPtzCamera extends BasePtzCamera {
  constructor(config = {}) {
    super(config);
    this.protocol = normalizeProtocol(config.protocol || 'visca-tcp');
    if (this.protocol === 'ptzoptics-visca') this.protocol = 'visca-tcp';
    this.port = Number(config.port) || defaultPortForProtocol(this.protocol);
    this.power = null;             // 'on' | 'standby' | null (unknown)
    this.inquiryTimeoutMs = Number(config.inquiryTimeoutMs) || 1500;
    this.ackTimeoutMs = Number(config.ackTimeoutMs) || 1500;
    this.completionTimeoutMs = Number(config.completionTimeoutMs) || 10000;
    this.onChange = null;          // () => void — set by PTZManager
    this._sequence = 1;
    this._sock = null;             // net.Socket (tcp) | dgram.Socket (udp)
    this._sockReady = null;        // Promise while connecting
    this._rx = Buffer.alloc(0);
    this._pending = null;          // current transaction
    this._queue = Promise.resolve();
    this._sonySeqReset = false;
  }

  _setState(connected, error) {
    const changed = this.connected !== !!connected || (this.error || null) !== (error || null);
    this.connected = !!connected;
    this.error = error || null;
    if (changed && typeof this.onChange === 'function') {
      try { this.onChange(this); } catch { /* ignore */ }
    }
  }

  toStatus() {
    return { ...super.toStatus(), power: this.connected ? this.power : null };
  }

  async connect() {
    if (!this.ip) throw new Error('PTZ camera IP is required');
    try {
      await this._inquirePower();
      this._setState(true, null);
    } catch (err) {
      this._closeSocket();
      this._setState(false, err.message);
      throw err;
    }
  }

  async isOnline() {
    try {
      await this._inquirePower();
      this._setState(true, null);
      return true;
    } catch (err) {
      this._closeSocket();
      this._setState(false, err.message);
      return false;
    }
  }

  async _inquirePower() {
    const r = await this._transact([0x81, 0x09, 0x04, 0x00, 0xff], { inquiry: true });
    const p = r[2];
    if (p === 0x02) this.power = 'on';
    else if (p === 0x03) this.power = 'standby';
    else throw new Error(`Unexpected VISCA power reply ${Buffer.from(r).toString('hex')}`);
    return this.power;
  }

  /** Pan/tilt/zoom position from the camera (raw VISCA units). */
  async getPosition() {
    const pt = await this._transact([0x81, 0x09, 0x06, 0x12, 0xff], { inquiry: true });
    const z = await this._transact([0x81, 0x09, 0x04, 0x47, 0xff], { inquiry: true });
    const n4 = (b, i) => {
      const u = ((b[i] & 0xf) << 12) | ((b[i + 1] & 0xf) << 8) | ((b[i + 2] & 0xf) << 4) | (b[i + 3] & 0xf);
      return u >= 0x8000 ? u - 0x10000 : u;
    };
    return { pan: n4(pt, 2), tilt: n4(pt, 6), zoom: n4(z, 2) & 0xffff };
  }

  async panTilt(pan = 0, tilt = 0, opts = {}) {
    const panVal = clamp(Number(pan) || 0, -1, 1);
    const tiltVal = clamp(Number(tilt) || 0, -1, 1);
    const durationMs = Number(opts.durationMs) || 350;

    const panDir = panVal > 0 ? 0x02 : panVal < 0 ? 0x01 : 0x03;
    const tiltDir = tiltVal > 0 ? 0x01 : tiltVal < 0 ? 0x02 : 0x03;
    const panSpeed = panVal === 0 ? 0x01 : clamp(Math.round(Math.abs(panVal) * 0x18), 0x01, 0x18);
    const tiltSpeed = tiltVal === 0 ? 0x01 : clamp(Math.round(Math.abs(tiltVal) * 0x14), 0x01, 0x14);

    await this._sendVisca([0x81, 0x01, 0x06, 0x01, panSpeed, tiltSpeed, panDir, tiltDir, 0xff]);
    if (durationMs > 0 && (panVal !== 0 || tiltVal !== 0)) {
      await sleep(durationMs);
      await this.stop({ panTilt: true, zoom: false });
    }
  }

  async zoom(zoom = 0, opts = {}) {
    const zoomVal = clamp(Number(zoom) || 0, -1, 1);
    const durationMs = Number(opts.durationMs) || 250;
    let cmd = 0x00; // stop

    if (zoomVal > 0) {
      const speed = clamp(Math.round(Math.abs(zoomVal) * 0x07), 0x00, 0x07);
      cmd = 0x20 + speed; // tele
    } else if (zoomVal < 0) {
      const speed = clamp(Math.round(Math.abs(zoomVal) * 0x07), 0x00, 0x07);
      cmd = 0x30 + speed; // wide
    }

    await this._sendVisca([0x81, 0x01, 0x04, 0x07, cmd, 0xff]);
    if (durationMs > 0 && zoomVal !== 0) {
      await sleep(durationMs);
      await this.stop({ panTilt: false, zoom: true });
    }
  }

  async stop(opts = {}) {
    const stopPanTilt = opts.panTilt !== false;
    const stopZoom = opts.zoom !== false;
    if (stopPanTilt) {
      await this._sendVisca([0x81, 0x01, 0x06, 0x01, 0x01, 0x01, 0x03, 0x03, 0xff]);
    }
    if (stopZoom) {
      await this._sendVisca([0x81, 0x01, 0x04, 0x07, 0x00, 0xff]);
    }
  }

  async recallPreset(preset, opts = {}) {
    const presetVal = this._normalizePreset(preset, opts);
    await this._sendVisca([0x81, 0x01, 0x04, 0x3f, 0x02, presetVal, 0xff]);
  }

  async setPreset(preset, nameOrOpts = {}, maybeOpts = {}) {
    const opts = (nameOrOpts && typeof nameOrOpts === 'object') ? nameOrOpts : (maybeOpts || {});
    const presetVal = this._normalizePreset(preset, opts);
    await this._sendVisca([0x81, 0x01, 0x04, 0x3f, 0x01, presetVal, 0xff]);
    return String(presetVal);
  }

  async home() {
    await this._sendVisca([0x81, 0x01, 0x06, 0x04, 0xff]);
  }

  async setPower(on) {
    await this._sendVisca([0x81, 0x01, 0x04, 0x00, on ? 0x02 : 0x03, 0xff]);
    this.power = on ? 'on' : 'standby';
  }

  _normalizePreset(preset, opts = {}) {
    const n = Math.max(0, Number.parseInt(preset, 10) || 0);
    // Most VISCA command tables use zero-based preset in payload.
    const zeroBased = opts.zeroBasedPreset === true;
    return clamp(zeroBased ? n : Math.max(0, n - 1), 0, 0x7f);
  }

  /** Send a VISCA command; resolves on Completion, rejects on VISCA error/timeout. */
  async _sendVisca(bytes) {
    if (!this.connected) throw new Error(`PTZ camera ${this.name} is offline${this.error ? ` (${this.error})` : ''}`);
    try {
      await this._transact(bytes, { inquiry: false });
    } catch (err) {
      if (err instanceof ViscaError) throw err;       // camera answered "no" — still connected
      this._closeSocket();
      this._setState(false, err.message);
      throw err;
    }
  }

  // ── transport ──────────────────────────────────────────────────────────────

  _transact(bytes, { inquiry }) {
    const run = () => this._transactNow(Buffer.from(bytes), inquiry);
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _transactNow(payload, inquiry, retried = false) {
    await this._ensureSocket();
    if (this.protocol === 'sony-visca-udp' && !this._sonySeqReset) await this._sonyResetSeq();
    return new Promise((resolve, reject) => {
      const tx = {
        inquiry,
        acked: false,
        seq: null,
        timer: null,
        done: (err, val) => {
          if (tx.finished) return;
          tx.finished = true;
          clearTimeout(tx.timer);
          if (this._pending === tx) this._pending = null;
          if (err) reject(err); else resolve(val);
        },
        arm: (ms, what) => {
          clearTimeout(tx.timer);
          tx.timer = setTimeout(() => tx.done(new Error(`No VISCA ${what} from ${this.ip}:${this.port} within ${ms}ms`)), ms);
        },
        onSonySeqError: null,
      };
      if (!retried && this.protocol === 'sony-visca-udp') {
        tx.onSonySeqError = () => {
          tx.finished = true; clearTimeout(tx.timer); this._pending = null;
          this._sonySeqReset = false;
          this._transactNow(payload, inquiry, true).then(resolve, reject);
        };
      }
      this._pending = tx;
      tx.arm(inquiry ? this.inquiryTimeoutMs : this.ackTimeoutMs, inquiry ? 'reply' : 'ACK');
      let wire = payload;
      if (this.protocol === 'sony-visca-udp') {
        tx.seq = this._nextSeq();
        wire = this._sonyFrame(inquiry ? SONY_TYPE.INQUIRY : SONY_TYPE.COMMAND, tx.seq, payload);
      }
      this._write(wire).catch((err) => tx.done(err));
    });
  }

  _nextSeq() {
    const s = this._sequence >>> 0;
    this._sequence = (this._sequence + 1) >>> 0;
    return s;
  }

  _sonyFrame(type, seq, payload) {
    const header = Buffer.alloc(8);
    header.writeUInt16BE(type, 0);
    header.writeUInt16BE(payload.length, 2);
    header.writeUInt32BE(seq >>> 0, 4);
    return Buffer.concat([header, payload]);
  }

  // Back-compat helper (tests/tools): Sony command framing.
  _wrapSonyVisca(payload) {
    return this._sonyFrame(SONY_TYPE.COMMAND, this._nextSeq(), Buffer.from(payload));
  }

  async _sonyResetSeq() {
    this._sequence = 1;
    await new Promise((resolve, reject) => {
      const tx = {
        control: true,
        finished: false,
        done: (err) => {
          if (tx.finished) return;
          tx.finished = true;
          clearTimeout(tx.timer);
          if (this._pending === tx) this._pending = null;
          if (err) reject(err); else resolve();
        },
      };
      tx.timer = setTimeout(() => tx.done(new Error(`No Sony VISCA control reply from ${this.ip}:${this.port} within ${this.inquiryTimeoutMs}ms`)), this.inquiryTimeoutMs);
      this._pending = tx;
      this._write(this._sonyFrame(SONY_TYPE.CONTROL, 0, Buffer.from([0x01]))).catch((e) => tx.done(e));
    });
    this._sonySeqReset = true;
  }

  async _write(buf) {
    const sock = this._sock;
    if (!sock) throw new Error(`VISCA socket to ${this.ip}:${this.port} is closed`);
    await new Promise((resolve, reject) => {
      if (this.protocol === 'visca-tcp') sock.write(buf, (err) => (err ? reject(err) : resolve()));
      else sock.send(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  async _ensureSocket() {
    if (this._sock) return;
    if (this._sockReady) return this._sockReady;
    this._sockReady = (this.protocol === 'visca-tcp' ? this._openTcp() : this._openUdp())
      .finally(() => { this._sockReady = null; });
    return this._sockReady;
  }

  _openTcp(timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        reject(err);
      };
      sock.setTimeout(timeoutMs);
      sock.once('error', fail);
      sock.once('timeout', () => fail(new Error(`VISCA TCP connect timeout (${this.ip}:${this.port})`)));
      sock.connect(this.port, this.ip, () => {
        settled = true;
        sock.setTimeout(0);
        sock.removeAllListeners('error');
        sock.removeAllListeners('timeout');
        sock.setNoDelay(true);
        this._sock = sock;
        this._rx = Buffer.alloc(0);
        sock.on('data', (chunk) => this._onStream(chunk));
        sock.on('error', () => { /* close follows */ });
        sock.on('close', () => {
          if (this._sock !== sock) return;
          this._sock = null;
          this._failPending(new Error(`VISCA TCP connection to ${this.ip}:${this.port} closed`));
          if (this.connected) this._setState(false, 'Camera closed the VISCA connection');
        });
        resolve();
      });
    });
  }

  _openUdp() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      sock.once('error', (err) => { if (!settled) { settled = true; try { sock.close(); } catch { /* */ } reject(err); } });
      sock.connect(this.port, this.ip, (err) => {
        if (err) { settled = true; try { sock.close(); } catch { /* */ } reject(err); return; }
        settled = true;
        sock.removeAllListeners('error');
        // ICMP port-unreachable surfaces as ECONNREFUSED on a connected UDP socket.
        sock.on('error', (e) => { this._failPending(new Error(`VISCA UDP ${this.ip}:${this.port}: ${e.code || e.message}`)); });
        sock.on('message', (msg) => this._onDatagram(msg));
        this._sock = sock;
        resolve();
      });
    });
  }

  _closeSocket() {
    const sock = this._sock;
    this._sock = null;
    this._sonySeqReset = false;
    if (!sock) return;
    try { if (this.protocol === 'visca-tcp') sock.destroy(); else sock.close(); } catch { /* ignore */ }
  }

  _failPending(err) {
    const tx = this._pending;
    if (tx) tx.done(err);
  }

  _onStream(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);
    let i;
    while ((i = this._rx.indexOf(0xff)) !== -1) {
      const msg = this._rx.subarray(0, i + 1);
      this._rx = Buffer.from(this._rx.subarray(i + 1));
      this._onReply(Buffer.from(msg));
    }
  }

  _onDatagram(msg) {
    if (this.protocol !== 'sony-visca-udp') {
      let start = 0;
      for (let i = 0; i < msg.length; i++) if (msg[i] === 0xff) { this._onReply(msg.subarray(start, i + 1)); start = i + 1; }
      return;
    }
    if (msg.length < 8) return;
    const type = msg.readUInt16BE(0);
    const seq = msg.readUInt32BE(4);
    const payload = msg.subarray(8);
    const tx = this._pending;
    if (!tx) return;
    if (type === SONY_TYPE.CONTROL_REPLY) {
      if (tx.control && payload[0] === 0x01) { tx.done(null); return; }
      if (payload[0] === 0x0f && payload[1] === 0x01) {
        if (tx.onSonySeqError) { tx.onSonySeqError(); return; }
        tx.done(new Error('Sony VISCA sequence number error'));
        return;
      }
      if (payload[0] === 0x0f && payload[1] === 0x02) { tx.done(new ViscaError('sony-message', 'Sony VISCA message error (camera rejected the packet)')); return; }
      return;
    }
    if (type !== SONY_TYPE.REPLY) return;
    if (tx.seq !== null && seq !== tx.seq) return;   // stale/foreign reply — ignore
    let start = 0;
    for (let i = 0; i < payload.length; i++) if (payload[i] === 0xff) { this._onReply(payload.subarray(start, i + 1)); start = i + 1; }
  }

  _onReply(msg) {
    const tx = this._pending;
    if (!tx || tx.control || msg.length < 3) return;
    const b1 = msg[1];
    if ((b1 & 0xf0) === 0x60) {
      const code = msg[2];
      tx.done(new ViscaError(code, VISCA_ERRORS[code] || `VISCA error 0x${code.toString(16)}`));
      return;
    }
    if (tx.inquiry) {
      if ((b1 & 0xf0) === 0x50) tx.done(null, [...msg]);
      return;
    }
    if ((b1 & 0xf0) === 0x40) {
      tx.acked = true;
      tx.arm(this.completionTimeoutMs, 'Completion');
      return;
    }
    if ((b1 & 0xf0) === 0x50) tx.done(null, [...msg]);
  }
}

class OnvifPtzCamera extends BasePtzCamera {
  constructor(config = {}) {
    super(config);
    this.protocol = 'onvif';
    this.port = Number(config.port) || 80;
    this.deviceServiceUrl = config.deviceServiceUrl || `http://${this.ip}:${this.port}/onvif/device_service`;
    this.mediaServiceUrl = null;
    this.ptzServiceUrl = null;
    this.profileToken = config.profileToken || '';
  }

  async connect() {
    if (!this.ip) throw new Error('PTZ camera IP is required');
    await this._initServices();
    this.connected = true;
    this.error = null;
  }

  async isOnline() {
    try {
      if (!this.profileToken || !this.ptzServiceUrl) await this._initServices();
      await this.getStatus();
      this.connected = true;
      this.error = null;
      return true;
    } catch (err) {
      this.connected = false;
      this.error = err.message;
      return false;
    }
  }

  async panTilt(pan = 0, tilt = 0, opts = {}) {
    const panVal = clamp(Number(pan) || 0, -1, 1);
    const tiltVal = clamp(Number(tilt) || 0, -1, 1);
    const timeoutMs = Number(opts.durationMs) || 350;
    await this._ensureReady();
    await this._continuousMove({ pan: panVal, tilt: tiltVal, zoom: null, timeoutMs });
  }

  async zoom(zoom = 0, opts = {}) {
    const zoomVal = clamp(Number(zoom) || 0, -1, 1);
    const timeoutMs = Number(opts.durationMs) || 250;
    await this._ensureReady();
    await this._continuousMove({ pan: null, tilt: null, zoom: zoomVal, timeoutMs });
  }

  async stop(opts = {}) {
    await this._ensureReady();
    const body = `
      <tptz:Stop xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
        <tptz:PanTilt>${boolXml(opts.panTilt !== false)}</tptz:PanTilt>
        <tptz:Zoom>${boolXml(opts.zoom !== false)}</tptz:Zoom>
      </tptz:Stop>`;
    await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/Stop',
      body,
    });
  }

  async recallPreset(preset) {
    await this._ensureReady();
    const presetToken = await this._resolvePresetToken(preset);
    const body = `
      <tptz:GotoPreset xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
        <tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>
      </tptz:GotoPreset>`;
    await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/GotoPreset',
      body,
    });
    return presetToken;
  }

  async setPreset(preset, name = '') {
    await this._ensureReady();
    const presetToken = String(Number.parseInt(preset, 10) || preset);
    const body = `
      <tptz:SetPreset xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
        <tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>
        <tptz:PresetName>${escapeXml(name || `Preset ${presetToken}`)}</tptz:PresetName>
      </tptz:SetPreset>`;
    const xml = await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/SetPreset',
      body,
    });
    const returned = this._firstMatch(xml, /<(?:\w+:)?PresetToken>\s*([^<]+)\s*<\/(?:\w+:)?PresetToken>/i);
    return returned || presetToken;
  }

  async home() {
    await this._ensureReady();
    const body = `
      <tptz:GotoHomePosition xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
      </tptz:GotoHomePosition>`;
    await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/GotoHomePosition',
      body,
    });
  }

  async getStatus() {
    await this._ensureReady();
    const body = `
      <tptz:GetStatus xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
      </tptz:GetStatus>`;
    const xml = await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/GetStatus',
      body,
    });

    const pan = this._firstMatch(xml, /<tt:PanTilt[^>]*\bx="([^"]+)"/i);
    const tilt = this._firstMatch(xml, /<tt:PanTilt[^>]*\by="([^"]+)"/i);
    const zoom = this._firstMatch(xml, /<tt:Zoom[^>]*\bx="([^"]+)"/i);
    return {
      pan: pan != null ? Number(pan) : null,
      tilt: tilt != null ? Number(tilt) : null,
      zoom: zoom != null ? Number(zoom) : null,
    };
  }

  async _continuousMove({ pan, tilt, zoom, timeoutMs }) {
    const panTiltXml = (pan == null && tilt == null)
      ? ''
      : `<tt:PanTilt x="${Number(pan || 0).toFixed(3)}" y="${Number(tilt || 0).toFixed(3)}"/>`;
    const zoomXml = zoom == null
      ? ''
      : `<tt:Zoom x="${Number(zoom || 0).toFixed(3)}"/>`;
    const timeout = toIsoDuration(timeoutMs || 300);

    const body = `
      <tptz:ContinuousMove xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
        <tptz:Velocity>
          ${panTiltXml}
          ${zoomXml}
        </tptz:Velocity>
        <tptz:Timeout>${timeout}</tptz:Timeout>
      </tptz:ContinuousMove>`;
    await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove',
      body,
    });
  }

  async _ensureReady() {
    if (!this.profileToken || !this.ptzServiceUrl) {
      await this._initServices();
    }
  }

  async _initServices() {
    // 1) Device capabilities
    const capabilitiesBody = `
      <tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
        <tds:Category>All</tds:Category>
      </tds:GetCapabilities>`;
    const capsXml = await this._soap({
      xaddr: this.deviceServiceUrl,
      action: 'http://www.onvif.org/ver10/device/wsdl/GetCapabilities',
      body: capabilitiesBody,
    });

    const mediaXAddr = this._extractServiceXAddr(capsXml, 'Media')
      || this._extractServiceXAddr(capsXml, 'Media2');
    const ptzXAddr = this._extractServiceXAddr(capsXml, 'PTZ');

    this.mediaServiceUrl = mediaXAddr || this.deviceServiceUrl;
    this.ptzServiceUrl = ptzXAddr || this.deviceServiceUrl;

    // 2) Profile token (media)
    if (!this.profileToken) {
      const profilesBody = `<trt:GetProfiles xmlns:trt="http://www.onvif.org/ver10/media/wsdl"/>`;
      const profilesXml = await this._soap({
        xaddr: this.mediaServiceUrl,
        action: 'http://www.onvif.org/ver10/media/wsdl/GetProfiles',
        body: profilesBody,
      });
      const token = this._firstMatch(profilesXml, /<(?:\w+:)?Profiles[^>]*\btoken="([^"]+)"/i);
      if (!token) throw new Error(`ONVIF: no profile token returned by ${this.name}`);
      this.profileToken = token;
    }
  }

  _extractServiceXAddr(xml, serviceName) {
    const re = new RegExp(
      `<(?:\\w+:)?${serviceName}\\b[^>]*>[\\s\\S]*?<\\w*:XAddr>([^<]+)<\\/\\w*:XAddr>|<(?:\\w+:)?${serviceName}\\b[^>]*>[\\s\\S]*?<(?:\\w+:)?XAddr>([^<]+)<\\/(?:\\w+:)?XAddr>`,
      'i'
    );
    const m = xml.match(re);
    return m ? (m[1] || m[2] || '').trim() : null;
  }

  _firstMatch(xml, regex) {
    const m = xml.match(regex);
    return m ? m[1] : null;
  }

  async _resolvePresetToken(preset) {
    const wanted = String(Number.parseInt(preset, 10) || preset).trim();
    const body = `
      <tptz:GetPresets xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
        <tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>
      </tptz:GetPresets>`;
    const xml = await this._soap({
      xaddr: this.ptzServiceUrl,
      action: 'http://www.onvif.org/ver20/ptz/wsdl/GetPresets',
      body,
    });

    // Prefer exact token match.
    const tokenRegex = /<(?:\w+:)?Preset\b[^>]*\btoken="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Preset>/gi;
    let m;
    while ((m = tokenRegex.exec(xml)) !== null) {
      const token = m[1];
      const name = (m[2].match(/<(?:\w+:)?Name>\s*([^<]+)\s*<\/(?:\w+:)?Name>/i) || [])[1] || '';
      if (token === wanted || name === wanted) return token;
    }
    return wanted;
  }

  async _soap({ xaddr, action, body, timeoutMs = 4500 }) {
    const envelope = this._buildEnvelope(body);
    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: `"${action}"`,
    };
    if (this.username || this.password) {
      const basic = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }

    const resp = await fetch(xaddr, {
      method: 'POST',
      headers,
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const xml = await resp.text();
    if (!resp.ok) {
      const reason = this._firstMatch(xml, /<(?:\w+:)?Text[^>]*>\s*([^<]+)\s*<\/(?:\w+:)?Text>/i);
      throw new Error(`ONVIF ${resp.status}${reason ? `: ${reason}` : ''}`);
    }
    if (/<(?:\w+:)?Fault\b/i.test(xml)) {
      const reason = this._firstMatch(xml, /<(?:\w+:)?Text[^>]*>\s*([^<]+)\s*<\/(?:\w+:)?Text>/i) || 'Unknown SOAP fault';
      throw new Error(`ONVIF fault: ${reason}`);
    }
    return xml;
  }

  _buildEnvelope(body) {
    const security = this.username
      ? this._buildWsseSecurity(this.username, this.password)
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
      <s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
        <s:Header>
          ${security}
        </s:Header>
        <s:Body>
          ${body}
        </s:Body>
      </s:Envelope>`;
  }

  _buildWsseSecurity(username, password) {
    const nonceBytes = crypto.randomBytes(16);
    const created = new Date().toISOString();
    const digest = crypto
      .createHash('sha1')
      .update(Buffer.concat([nonceBytes, Buffer.from(created), Buffer.from(password || '')]))
      .digest('base64');
    const nonce = nonceBytes.toString('base64');

    return `
      <wsse:Security s:mustUnderstand="1">
        <wsse:UsernameToken>
          <wsse:Username>${escapeXml(username)}</wsse:Username>
          <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
          <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce}</wsse:Nonce>
          <wsu:Created>${created}</wsu:Created>
        </wsse:UsernameToken>
      </wsse:Security>`;
  }
}

// ─── Preset Management & Position Tracking ──────────────────────────────────

class PresetManager extends EventEmitter {
  constructor() {
    super();
    // presets: Map<cameraId, Map<presetId, { name, position: {pan, tilt, zoom}, savedAt }>>
    this._presets = new Map();
    // recallHistory: Map<cameraId, Array<{ presetId, name, position, recalledAt, verified?, drift? }>>
    this._recallHistory = new Map();
    // lastKnownPosition: Map<cameraId, { pan, tilt, zoom, timestamp, source }>
    this._lastKnownPosition = new Map();
    // positionHistory: Map<cameraId, Array<{ pan, tilt, zoom, timestamp, source }>>
    this._positionHistory = new Map();
  }

  savePreset(cameraId, presetId, name, position) {
    const cid = String(cameraId);
    const pid = String(presetId);
    if (!position || typeof position.pan !== 'number' || typeof position.tilt !== 'number' || typeof position.zoom !== 'number') {
      throw new Error('Position must include numeric pan, tilt, and zoom values');
    }
    if (!this._presets.has(cid)) {
      this._presets.set(cid, new Map());
    }
    const preset = {
      name: name || `Preset ${pid}`,
      position: { pan: position.pan, tilt: position.tilt, zoom: position.zoom },
      savedAt: new Date().toISOString(),
    };
    this._presets.get(cid).set(pid, preset);
    return preset;
  }

  recallPreset(cameraId, presetId) {
    const cid = String(cameraId);
    const pid = String(presetId);
    const cameraPresets = this._presets.get(cid);
    if (!cameraPresets || !cameraPresets.has(pid)) {
      throw new Error(`Preset ${pid} not found for camera ${cid}`);
    }
    const preset = cameraPresets.get(pid);
    const entry = {
      presetId: pid,
      name: preset.name,
      position: { ...preset.position },
      recalledAt: new Date().toISOString(),
    };
    if (!this._recallHistory.has(cid)) {
      this._recallHistory.set(cid, []);
    }
    this._recallHistory.get(cid).push(entry);
    return preset;
  }

  verifyPresetPosition(cameraId, presetId, actualPosition, tolerance = 0.05) {
    const cid = String(cameraId);
    const pid = String(presetId);
    const cameraPresets = this._presets.get(cid);
    if (!cameraPresets || !cameraPresets.has(pid)) {
      throw new Error(`Preset ${pid} not found for camera ${cid}`);
    }
    const expected = cameraPresets.get(pid).position;
    const drift = {
      pan: Math.abs(actualPosition.pan - expected.pan),
      tilt: Math.abs(actualPosition.tilt - expected.tilt),
      zoom: Math.abs(actualPosition.zoom - expected.zoom),
    };
    const verified = drift.pan <= tolerance && drift.tilt <= tolerance && drift.zoom <= tolerance;

    // Update the most recent recall history entry with verification data
    const history = this._recallHistory.get(cid);
    if (history) {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].presetId === pid) {
          history[i].verified = verified;
          history[i].drift = { ...drift };
          history[i].actual = { ...actualPosition };
          break;
        }
      }
    }

    return {
      verified,
      expected: { ...expected },
      actual: { pan: actualPosition.pan, tilt: actualPosition.tilt, zoom: actualPosition.zoom },
      drift,
    };
  }

  listPresets(cameraId) {
    const cid = String(cameraId);
    const cameraPresets = this._presets.get(cid);
    if (!cameraPresets) return [];
    const result = [];
    for (const [pid, preset] of cameraPresets) {
      result.push({
        presetId: pid,
        name: preset.name,
        position: { ...preset.position },
        savedAt: preset.savedAt,
      });
    }
    return result;
  }

  getPresetRecallHistory(cameraId, limit = 20) {
    const cid = String(cameraId);
    const history = this._recallHistory.get(cid);
    if (!history || history.length === 0) return [];
    // Return most recent first, limited
    return history.slice(-limit).reverse().map((e) => ({ ...e }));
  }

  // ─── Position Tracking ──────────────────────────────────────────────────────

  updatePosition(cameraId, position, source = 'command') {
    const cid = String(cameraId);
    const entry = {
      pan: position.pan,
      tilt: position.tilt,
      zoom: position.zoom,
      timestamp: Date.now(),
      source,
    };

    const previous = this._lastKnownPosition.get(cid);
    this._lastKnownPosition.set(cid, entry);

    if (!this._positionHistory.has(cid)) {
      this._positionHistory.set(cid, []);
    }
    const hist = this._positionHistory.get(cid);
    hist.push(entry);
    // Keep history bounded
    if (hist.length > 500) hist.splice(0, hist.length - 500);

    // Detect manual move: if source is 'poll' and previous source was 'command',
    // and position changed significantly, emit event.
    if (source === 'poll' && previous && previous.source !== 'poll') {
      const movedPan = Math.abs(position.pan - previous.pan);
      const movedTilt = Math.abs(position.tilt - previous.tilt);
      const movedZoom = Math.abs(position.zoom - previous.zoom);
      const manualThreshold = 0.01;
      if (movedPan > manualThreshold || movedTilt > manualThreshold || movedZoom > manualThreshold) {
        this.emit('ptz_manual_move_detected', {
          cameraId: cid,
          previous: { pan: previous.pan, tilt: previous.tilt, zoom: previous.zoom },
          current: { pan: position.pan, tilt: position.tilt, zoom: position.zoom },
          delta: { pan: movedPan, tilt: movedTilt, zoom: movedZoom },
          timestamp: entry.timestamp,
        });
      }
    }

    return entry;
  }

  getLastKnownPosition(cameraId) {
    return this._lastKnownPosition.get(String(cameraId)) || null;
  }

  getPositionHistory(cameraId, limit = 50) {
    const cid = String(cameraId);
    const hist = this._positionHistory.get(cid);
    if (!hist || hist.length === 0) return [];
    return hist.slice(-limit).map((e) => ({ ...e }));
  }
}

class PTZManager {
  constructor(entries = [], logger = null) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.logger = logger || (() => {});
    this.cameras = [];
    this.presetManager = new PresetManager();
    this.onChange = null;
  }

  /** Close persistent camera sockets (agent stop / PTZ reconfigure). */
  close() {
    for (const cam of this.cameras) {
      cam.onChange = null;
      try { if (typeof cam._closeSocket === 'function') cam._closeSocket(); } catch { /* ignore */ }
    }
  }

  hasCameras() {
    return this.cameras.length > 0;
  }

  async connectAll() {
    this.cameras = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this._normalizeEntry(this.entries[i], i);
      if (!entry.ip || normalizeProtocol(entry.protocol) === 'atem') continue;
      try {
        const camera = await this._buildConnectedCamera(entry);
        this._adopt(camera);
        this.cameras.push(camera);
        this.logger(`🎥 PTZ connected: ${camera.name} (${camera.protocol} ${camera.ip}:${camera.port})`);
      } catch (err) {
        this.logger(`⚠️  PTZ failed: ${entry.name || entry.ip} (${entry.protocol || 'auto'}) — ${err.message}`);
        // Keep a camera that keeps TRYING: an explicit-protocol camera object
        // (its inquiry poll reconnects), or an auto-detect placeholder that
        // re-runs detection on every refresh. Never a dead stub.
        const protocol = normalizeProtocol(entry.protocol || 'auto');
        let cam;
        if (protocol !== 'auto') {
          cam = this._makeCamera(entry, protocol);
        } else {
          cam = new BasePtzCamera(entry);
          cam.protocol = 'auto';
          cam._retryEntry = entry;
        }
        cam.connected = false;
        cam.error = err.message;
        this._adopt(cam);
        this.cameras.push(cam);
      }
    }
  }

  _adopt(cam) {
    cam.onChange = () => { if (typeof this.onChange === 'function') this.onChange(); };
  }

  async refreshStatus() {
    await Promise.all(this.cameras.map(async (cam, i) => {
      if (cam._retryEntry) {
        try {
          const built = await this._buildConnectedCamera(cam._retryEntry);
          this._adopt(built);
          this.cameras[i] = built;
          this.logger(`🎥 PTZ connected: ${built.name} (${built.protocol} ${built.ip}:${built.port})`);
        } catch (err) { cam.error = err.message; }
        return;
      }
      if (typeof cam.isOnline === 'function') {
        const was = !!cam.connected;
        try { await cam.isOnline(); } catch { /* ignore */ }
        if (was !== !!cam.connected) {
          this.logger(cam.connected ? `🎥 PTZ reconnected: ${cam.name}` : `⚠️  PTZ offline: ${cam.name} — ${cam.error}`);
        }
      }
    }));
  }

  getStatus() {
    return this.cameras.map((cam, i) => ({
      index: i + 1,
      ...(typeof cam.toStatus === 'function' ? cam.toStatus() : {
        name: cam.name || `PTZ ${i + 1}`,
        ip: cam.ip || '',
        protocol: cam.protocol || 'unknown',
        port: cam.port || null,
        connected: !!cam.connected,
        error: cam.error || null,
      }),
    }));
  }

  async panTilt(cameraRef, pan, tilt, opts = {}) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.panTilt) throw new Error('Selected PTZ camera does not support pan/tilt');
    return cam.panTilt(pan, tilt, opts);
  }

  async zoom(cameraRef, zoom, opts = {}) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.zoom) throw new Error('Selected PTZ camera does not support zoom');
    return cam.zoom(zoom, opts);
  }

  async stop(cameraRef, opts = {}) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.stop) throw new Error('Selected PTZ camera does not support stop');
    return cam.stop(opts);
  }

  async recallPreset(cameraRef, preset, opts = {}) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.recallPreset) throw new Error('Selected PTZ camera does not support preset recall');
    return cam.recallPreset(preset, opts);
  }

  async setPreset(cameraRef, preset, name = '', opts = {}) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.setPreset) throw new Error('Selected PTZ camera does not support preset save');
    return cam.setPreset(preset, name, opts);
  }

  async home(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (!cam?.home) throw new Error('Selected PTZ camera does not support home');
    return cam.home();
  }

  // ─── Extended VISCA camera controls ────────────────────────────────────────

  async autoFocus(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x38, 0x02, 0xff]);
      return 'auto';
    }
    throw new Error('Auto focus not supported on this camera type');
  }

  async manualFocus(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x38, 0x03, 0xff]);
      return 'manual';
    }
    throw new Error('Manual focus not supported on this camera type');
  }

  async focusNear(cameraRef, speed = 3) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      const sp = clamp(speed, 0, 7);
      await cam._sendVisca([0x81, 0x01, 0x04, 0x08, 0x30 + sp, 0xff]);
      return 'focusing near';
    }
    throw new Error('Focus control not supported on this camera type');
  }

  async focusFar(cameraRef, speed = 3) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      const sp = clamp(speed, 0, 7);
      await cam._sendVisca([0x81, 0x01, 0x04, 0x08, 0x20 + sp, 0xff]);
      return 'focusing far';
    }
    throw new Error('Focus control not supported on this camera type');
  }

  async focusStop(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x08, 0x00, 0xff]);
      return 'focus stopped';
    }
    throw new Error('Focus control not supported on this camera type');
  }

  async setAutoWhiteBalance(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x35, 0x00, 0xff]);
      return 'auto';
    }
    throw new Error('White balance not supported on this camera type');
  }

  async setIndoorWhiteBalance(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x35, 0x01, 0xff]);
      return 'indoor';
    }
    throw new Error('White balance not supported on this camera type');
  }

  async setOutdoorWhiteBalance(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x35, 0x02, 0xff]);
      return 'outdoor';
    }
    throw new Error('White balance not supported on this camera type');
  }

  async setOnePushWhiteBalance(cameraRef) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x35, 0x03, 0xff]);
      await cam._sendVisca([0x81, 0x01, 0x04, 0x10, 0x05, 0xff]);
      return 'one-push triggered';
    }
    throw new Error('White balance not supported on this camera type');
  }

  async setBacklightComp(cameraRef, enabled) {
    const cam = this._resolveCamera(cameraRef);
    if (cam._sendVisca) {
      await cam._sendVisca([0x81, 0x01, 0x04, 0x33, enabled ? 0x02 : 0x03, 0xff]);
      return enabled ? 'on' : 'off';
    }
    throw new Error('Backlight compensation not supported on this camera type');
  }

  _normalizeEntry(entry, index) {
    if (typeof entry === 'string') {
      return { ip: entry, name: `PTZ ${index + 1}`, protocol: 'auto' };
    }
    const protocol = normalizeProtocol(entry?.protocol || 'auto');
    return {
      ip: String(entry?.ip || '').trim(),
      name: String(entry?.name || `PTZ ${index + 1}`),
      protocol,
      port: entry?.port ? Number(entry.port) : '',
      username: String(entry?.username || ''),
      password: String(entry?.password || ''),
      profileToken: String(entry?.profileToken || ''),
    };
  }

  async _buildConnectedCamera(entry) {
    const protocol = normalizeProtocol(entry.protocol);
    const attemptOrder = protocol === 'auto'
      ? ['onvif', 'ptzoptics-onvif', 'visca-tcp', 'ptzoptics-visca', 'visca-udp', 'sony-visca-udp']
      : [protocol];
    let lastErr = null;

    for (const candidate of attemptOrder) {
      try {
        const cam = this._makeCamera(entry, candidate);
        await cam.connect();
        return cam;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('No supported PTZ protocol could connect');
  }

  _makeCamera(entry, candidate) {
    const merged = { ...entry, protocol: candidate, port: entry.port || defaultPortForProtocol(candidate) };
    return (candidate === 'onvif' || candidate === 'ptzoptics-onvif')
      ? new OnvifPtzCamera(merged)
      : new ViscaPtzCamera({ ...merged, protocol: candidate === 'ptzoptics-visca' ? 'visca-tcp' : candidate });
  }

  _resolveCamera(ref) {
    if (!this.cameras.length) throw new Error('No PTZ cameras configured');
    if (typeof ref === 'string' && Number.isNaN(Number(ref))) {
      const byName = this.cameras.find((cam) => String(cam.name || '').toLowerCase() === ref.toLowerCase());
      if (byName) return byName;
      throw new Error(`PTZ camera "${ref}" not found`);
    }

    const idx = Math.max(1, Number.parseInt(ref || 1, 10));
    const cam = this.cameras[idx - 1];
    if (!cam) throw new Error(`PTZ camera ${idx} not found`);
    if (!cam.connected) throw new Error(`PTZ camera ${idx} is offline`);
    return cam;
  }
}

module.exports = {
  PTZManager,
  ViscaPtzCamera,
  PresetManager,
  normalizeProtocol,
  defaultPortForProtocol,
};
