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

class ViscaPtzCamera extends BasePtzCamera {
  constructor(config = {}) {
    super(config);
    this.protocol = normalizeProtocol(config.protocol || 'visca-tcp');
    this.port = Number(config.port) || defaultPortForProtocol(this.protocol);
    this._sequence = 1;
  }

  async connect() {
    if (!this.ip) throw new Error('PTZ camera IP is required');
    if (this.protocol === 'visca-tcp') {
      await this._probeTcp();
    } else {
      // UDP cameras usually do not reply to a transport probe.
      await this._probeUdp();
    }
    this.connected = true;
    this.error = null;
  }

  async isOnline() {
    try {
      if (this.protocol === 'visca-tcp') {
        await this._probeTcp(1500);
      } else {
        await this._probeUdp();
      }
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

  async setPreset(preset, opts = {}) {
    const presetVal = this._normalizePreset(preset, opts);
    await this._sendVisca([0x81, 0x01, 0x04, 0x3f, 0x01, presetVal, 0xff]);
    return String(presetVal);
  }

  async home() {
    await this._sendVisca([0x81, 0x01, 0x06, 0x04, 0xff]);
  }

  _normalizePreset(preset, opts = {}) {
    const n = Math.max(0, Number.parseInt(preset, 10) || 0);
    // Most VISCA command tables use zero-based preset in payload.
    const zeroBased = opts.zeroBasedPreset === true;
    return clamp(zeroBased ? n : Math.max(0, n - 1), 0, 0x7f);
  }

  async _probeTcp(timeoutMs = 2500) {
    await new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch { /* ignore */ }
        if (err) reject(err); else resolve();
      };
      sock.setTimeout(timeoutMs);
      sock.once('error', finish);
      sock.once('timeout', () => finish(new Error(`VISCA TCP timeout (${this.ip}:${this.port})`)));
      sock.connect(this.port, this.ip, () => finish());
    });
  }

  async _probeUdp() {
    // Best-effort UDP probe: successful local send indicates route/socket readiness.
    const inquiry = Buffer.from([0x81, 0x09, 0x04, 0x00, 0xff]); // CAM_Power Inq
    await this._sendUdp(inquiry);
  }

  async _sendVisca(bytes) {
    const payload = Buffer.from(bytes);
    if (this.protocol === 'visca-tcp') {
      await this._sendTcp(payload);
      return;
    }

    if (this.protocol === 'sony-visca-udp') {
      const wrapped = this._wrapSonyVisca(payload);
      await this._sendUdp(wrapped);
      return;
    }

    await this._sendUdp(payload);
  }

  _wrapSonyVisca(payload) {
    const header = Buffer.alloc(8);
    header[0] = 0x01;
    header[1] = 0x00;
    header.writeUInt16BE(payload.length, 2);
    header.writeUInt32BE(this._sequence >>> 0, 4);
    this._sequence = (this._sequence + 1) >>> 0;
    return Buffer.concat([header, payload]);
  }

  async _sendTcp(payload) {
    await new Promise((resolve, reject) => {
      const sock = new net.Socket();
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* ignore */ }
        if (err) reject(err); else resolve();
      };

      sock.setTimeout(2500);
      sock.once('error', finish);
      sock.once('timeout', () => finish(new Error(`VISCA TCP timeout (${this.ip}:${this.port})`)));
      sock.connect(this.port, this.ip, () => {
        sock.write(payload, (err) => {
          if (err) return finish(err);
          // Short delay for command flush/ACK window, then close.
          setTimeout(() => finish(), 70);
        });
      });
    });
  }

  async _sendUdp(payload) {
    await new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.once('error', (err) => {
        try { sock.close(); } catch { /* ignore */ }
        reject(err);
      });
      sock.send(payload, this.port, this.ip, (err) => {
        try { sock.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve();
      });
    });
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

class PTZManager {
  constructor(entries = [], logger = null) {
    this.entries = Array.isArray(entries) ? entries : [];
    this.logger = logger || (() => {});
    this.cameras = [];
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
        this.cameras.push(camera);
        this.logger(`🎥 PTZ connected: ${camera.name} (${camera.protocol} ${camera.ip}:${camera.port})`);
      } catch (err) {
        this.logger(`⚠️  PTZ failed: ${entry.name || entry.ip} (${entry.protocol || 'auto'}) — ${err.message}`);
        this.cameras.push({
          ...new BasePtzCamera(entry),
          protocol: normalizeProtocol(entry.protocol || 'auto'),
          connected: false,
          error: err.message,
          async isOnline() { return false; },
        });
      }
    }
  }

  async refreshStatus() {
    for (const cam of this.cameras) {
      if (typeof cam.isOnline === 'function') {
        try { await cam.isOnline(); } catch { /* ignore */ }
      }
    }
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
      ? ['onvif', 'visca-tcp', 'visca-udp']
      : [protocol];
    let lastErr = null;

    for (const candidate of attemptOrder) {
      try {
        const merged = { ...entry, protocol: candidate, port: entry.port || defaultPortForProtocol(candidate) };
        const cam = (candidate === 'onvif' || candidate === 'ptzoptics-onvif')
          ? new OnvifPtzCamera(merged)
          : new ViscaPtzCamera({
              ...merged,
              protocol: candidate === 'ptzoptics-visca' ? 'visca-tcp' : candidate,
            });
        await cam.connect();
        return cam;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('No supported PTZ protocol could connect');
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
  normalizeProtocol,
  defaultPortForProtocol,
};
