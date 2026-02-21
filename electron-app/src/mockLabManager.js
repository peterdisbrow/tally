const net = require('net');
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
let msgpackEncode;
let msgpackDecode;
try {
  ({ encode: msgpackEncode, decode: msgpackDecode } = require('@msgpack/msgpack'));
} catch {
  ({ encode: msgpackEncode, decode: msgpackDecode } = require('obs-websocket-js/node_modules/@msgpack/msgpack'));
}

function loadMockModule(moduleName) {
  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'church-client', 'src', `${moduleName}.js`)
    : '';
  const local = path.join(__dirname, '../../church-client/src', `${moduleName}.js`);
  const target = packaged && fs.existsSync(packaged) ? packaged : local;
  return require(target);
}

const { FakeAtem } = loadMockModule('fakeAtem');
const { FakeOBS } = loadMockModule('fakeObs');
const { FakeMixerBridge } = loadMockModule('fakeMixer');
const { FakeProPresenter } = loadMockModule('fakeProPresenter');
const { FakeAtemApiServer } = loadMockModule('fakeAtemApi');
const { encodeMessage, decodeMessage } = loadMockModule('osc');

const DEFAULT_ADDRESSES = {
  atem: { ip: '127.0.0.1', port: 9910 },
  obs: { ip: '127.0.0.1', port: 4455 },
  x32: { ip: '127.0.0.1', port: 10023 },
  encoder: { ip: '127.0.0.1', port: 1935 },
  hyperdeck: { ip: '127.0.0.1', port: 9993 },
  propresenter: { ip: '127.0.0.1', port: 1025 },
  controlApi: { ip: '127.0.0.1', port: 9911 },
};

const ENDPOINT_KEYS = ['atem', 'obs', 'x32', 'encoder', 'hyperdeck', 'propresenter', 'controlApi'];
const DEVICE_KEYS = ['atem', 'obs', 'x32', 'encoder', 'hyperdeck', 'propresenter'];
const OBS_RPC_VERSION = 1;
const OBS_SUBPROTOCOL_JSON = 'obswebsocket.json';
const OBS_SUBPROTOCOL_MSGPACK = 'obswebsocket.msgpack';
const OBS_WS_VERSION = '5.1.0';
const OBS_AVAILABLE_REQUESTS = [
  'GetVersion',
  'GetStats',
  'GetStreamStatus',
  'GetRecordStatus',
  'GetCurrentProgramScene',
  'SetCurrentProgramScene',
  'GetSceneList',
  'GetSourceScreenshot',
  'StartStream',
  'StopStream',
  'StartRecord',
  'StopRecord',
  'GetStreamServiceSettings',
  'SetStreamServiceSettings',
  'GetVideoSettings',
];

const ATEM_PACKET_FLAGS = {
  AckRequest: 1,
  NewSessionId: 2,
  AckReply: 16,
};

const ATEM_PROTOCOL_VERSION = 0x00020020; // 9.6
const ATEM_MODEL_MINI_EXTREME_ISO = 17;
const ATEM_CONNECT_HELLO = Buffer.from([
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function atemCmd(rawName, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length + 8;
  const out = Buffer.alloc(len);
  out.writeUInt16BE(len, 0);
  out.write(rawName, 4, 4, 'ascii');
  body.copy(out, 8);
  return out;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAddresses(candidate, { requireUniqueIps = false } = {}) {
  const normalized = {};

  for (const key of ENDPOINT_KEYS) {
    const fallback = DEFAULT_ADDRESSES[key];
    const next = candidate?.[key] || {};
    const ip = String(next.ip ?? fallback.ip).trim();
    const port = Number(next.port ?? fallback.port);

    if (!ip) throw new Error(`Missing IP for ${key}`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port for ${key}: ${next.port}`);
    }

    normalized[key] = { ip, port };
  }

  const endpointPairs = new Set();
  for (const key of ENDPOINT_KEYS) {
    const pair = `${normalized[key].ip.toLowerCase()}:${normalized[key].port}`;
    if (endpointPairs.has(pair)) {
      throw new Error(`Duplicate endpoint ${pair}. Each service must have a unique IP:port.`);
    }
    endpointPairs.add(pair);
  }

  if (requireUniqueIps) {
    const usedIps = new Set();
    for (const key of DEVICE_KEYS) {
      const ip = normalized[key].ip.toLowerCase();
      if (usedIps.has(ip)) {
        throw new Error(`Duplicate device IP ${normalized[key].ip}. Each mock device needs a unique IP.`);
      }
      usedIps.add(ip);
    }
  }

  return normalized;
}

class MockLabManager {
  constructor(logger = () => {}) {
    this.logger = logger;
    this.addresses = clone(DEFAULT_ADDRESSES);
    this._activeAddresses = clone(DEFAULT_ADDRESSES);
    this._allowFallback = true;

    this._servers = [];
    this._running = false;
    this._fallbackMode = false;

    this.fakeAtem = null;
    this.fakeObs = null;
    this.fakeMixer = null;
    this.fakeProPresenter = null;
    this.controlApi = null;

    this._obsClients = new Set();
    this._obsEventUnsubs = [];
    this._propresenterWsClients = new Set();
    this._proPresenterWsEndpoint = null;
    this._proPresenterEventUnsubs = [];

    this._atemUdpServer = null;
    this._atemSessions = new Map();
    this._x32Clients = new Map();
  }

  isRunning() {
    return this._running;
  }

  isFallbackMode() {
    return this._fallbackMode;
  }

  getAddresses() {
    return clone(this._running ? this._activeAddresses : this.addresses);
  }

  getConfiguredAddresses() {
    return clone(this.addresses);
  }

  setAddresses(nextAddresses = {}, opts = {}) {
    const candidate = clone(this.addresses);
    for (const key of ENDPOINT_KEYS) {
      if (nextAddresses[key] !== undefined) {
        const partial = nextAddresses[key] || {};
        candidate[key] = {
          ip: partial.ip ?? candidate[key].ip,
          port: partial.port ?? candidate[key].port,
        };
      }
    }

    const normalized = normalizeAddresses(candidate, opts);
    this.addresses = normalized;
    this._activeAddresses = clone(normalized);
    return this.getConfiguredAddresses();
  }

  _buildAttempts(endpoint) {
    const attempts = [{ ip: endpoint.ip, port: endpoint.port }];
    if (this._allowFallback) {
      attempts.push({ ip: '127.0.0.1', port: endpoint.port });
      attempts.push({ ip: '127.0.0.1', port: endpoint.port + 10000 });
    }
    return attempts;
  }

  async start(opts = {}) {
    if (this._running) return this.getAddresses();

    if (opts.addresses) {
      this.setAddresses(opts.addresses, { requireUniqueIps: opts.requireUniqueIps === true });
    } else {
      this.addresses = normalizeAddresses(this.addresses, { requireUniqueIps: opts.requireUniqueIps === true });
    }

    this._allowFallback = opts.allowFallback !== undefined ? !!opts.allowFallback : true;
    this._activeAddresses = clone(this.addresses);
    this._fallbackMode = false;

    try {
      this._createMockDevices();
      await this._startMockDevices();

      await this._startAtemProtocol();
      await this._startObsApi();
      await this._startX32Protocol();
      await this._startTcpProbe('encoder', () => 'ENCODER MOCK\n');
      await this._startHyperDeckProtocol();
      await this._startProPresenterApi();
      await this._startControlApi();

      this._running = true;
      const endpointSummary = Object.entries(this._activeAddresses).map(([k, v]) => `${k}=${v.ip}:${v.port}`).join(', ');
      const ppWs = this._proPresenterWsEndpoint
        ? `, propresenterWs=${this._proPresenterWsEndpoint.ip}:${this._proPresenterWsEndpoint.port}`
        : '';
      this.logger(`[MockLab] Started. Endpoints: ${endpointSummary}${ppWs}`);
      return this.getAddresses();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    await this._stopControlApi();
    this._detachProtocolEventBridges();

    for (const client of this._obsClients) {
      try { client.ws.close(); } catch {}
    }
    this._obsClients.clear();

    for (const ws of this._propresenterWsClients) {
      try { ws.close(); } catch {}
    }
    this._propresenterWsClients.clear();
    for (const session of this._atemSessions.values()) {
      if (session?.keepAliveTimer) clearInterval(session.keepAliveTimer);
    }
    this._atemSessions.clear();
    this._x32Clients.clear();
    this._atemUdpServer = null;

    const servers = [...this._servers];
    this._servers = [];
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    })));

    await this._stopMockDevices();

    this._running = false;
    this._fallbackMode = false;
    this._activeAddresses = clone(this.addresses);
    this._proPresenterWsEndpoint = null;
    this.logger('[MockLab] Stopped');
  }

  _createMockDevices() {
    this.fakeAtem = new FakeAtem();
    this.fakeObs = new FakeOBS();
    this.fakeMixer = new FakeMixerBridge({ type: 'x32', model: 'X32' });
    this.fakeProPresenter = new FakeProPresenter();
  }

  async _startMockDevices() {
    await this.fakeAtem.connect();
    await this.fakeObs.connect('mock://obs');
    await this.fakeMixer.connect();
    await this.fakeProPresenter.connect();
  }

  async _stopMockDevices() {
    try { await this.fakeObs?.disconnect?.(); } catch {}
    try { this.fakeProPresenter?.disconnect?.(); } catch {}
    try { await this.fakeMixer?.disconnect?.(); } catch {}
    try { await this.fakeAtem?.disconnect?.(); } catch {}
    try { this.fakeAtem?.destroy?.(); } catch {}

    this.fakeAtem = null;
    this.fakeObs = null;
    this.fakeMixer = null;
    this.fakeProPresenter = null;
  }

  _detachProtocolEventBridges() {
    for (const un of this._obsEventUnsubs) {
      try { un(); } catch {}
    }
    this._obsEventUnsubs = [];

    for (const un of this._proPresenterEventUnsubs) {
      try { un(); } catch {}
    }
    this._proPresenterEventUnsubs = [];
  }

  async _startControlApi() {
    const endpoint = this._activeAddresses.controlApi;
    const attempts = this._buildAttempts(endpoint);

    let lastError = null;
    for (const attempt of attempts) {
      const api = new FakeAtemApiServer({
        fakeAtem: this.fakeAtem,
        fakeObs: this.fakeObs,
        fakeMixer: this.fakeMixer,
        fakeProPresenter: this.fakeProPresenter,
        host: attempt.ip,
        port: attempt.port,
        logger: (msg) => this.logger(msg),
      });

      try {
        await api.start();
        if (attempt.ip !== endpoint.ip || attempt.port !== endpoint.port) {
          this._fallbackMode = true;
        }
        endpoint.ip = attempt.ip;
        endpoint.port = attempt.port;
        this.controlApi = api;
        return;
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error(`Could not bind mock control API on ${endpoint.ip}:${endpoint.port}`);
  }

  async _stopControlApi() {
    if (!this.controlApi) return;
    try { await this.controlApi.stop(); } catch {}
    this.controlApi = null;
  }

  _startTcpProbe(key, greetingFactory) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        socket.setTimeout(2500);
        socket.on('timeout', () => socket.destroy());
        socket.on('error', () => {});

        const greeting = typeof greetingFactory === 'function' ? greetingFactory() : '';
        if (greeting) {
          try { socket.write(greeting); } catch {}
        }
      });

      this._listenWithFallback(server, key)
        .then(() => {
          this._servers.push(server);
          resolve();
        })
        .catch(reject);
    });
  }

  _listenUdp(socket, ip, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        socket.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        socket.removeListener('error', onError);
        resolve();
      };

      socket.once('error', onError);
      socket.once('listening', onListening);
      socket.bind(port, ip);
    });
  }

  async _bindTcpUdpPair(key, tcpHandler, udpHandler) {
    const endpoint = this._activeAddresses[key];
    const attempts = this._buildAttempts(endpoint);
    let lastError = null;

    for (const attempt of attempts) {
      const tcpServer = net.createServer(tcpHandler);
      const udpServer = dgram.createSocket('udp4');

      try {
        udpServer.on('message', udpHandler);
        await Promise.all([
          this._listen(tcpServer, attempt.ip, attempt.port),
          this._listenUdp(udpServer, attempt.ip, attempt.port),
        ]);

        if (attempt.ip !== endpoint.ip || attempt.port !== endpoint.port) {
          this._fallbackMode = true;
        }

        endpoint.ip = attempt.ip;
        endpoint.port = attempt.port;
        this._servers.push(tcpServer);
        this._servers.push(udpServer);
        return { tcpServer, udpServer, endpoint: { ip: attempt.ip, port: attempt.port } };
      } catch (err) {
        lastError = err;
        try { tcpServer.close(); } catch {}
        try { udpServer.close(); } catch {}
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL')) continue;
        break;
      }
    }

    throw lastError || new Error(`Failed to bind ${key} on ${endpoint.ip}:${endpoint.port}`);
  }

  async _startAtemProtocol() {
    const bound = await this._bindTcpUdpPair(
      'atem',
      (socket) => {
        socket.setNoDelay(true);
        socket.setTimeout(2500);
        socket.on('timeout', () => socket.destroy());
        socket.on('error', () => {});
        try { socket.write('ATEM MOCK\n'); } catch {}
      },
      (packet, rinfo) => {
        try {
          this._onAtemUdpMessage(packet, rinfo);
        } catch (err) {
          this.logger(`[MockLab] ATEM UDP handler error: ${err?.message || err}`);
        }
      }
    );
    this._atemUdpServer = bound.udpServer;
  }

  _atemSessionKey(rinfo) {
    return `${rinfo.address}:${rinfo.port}`;
  }

  _isAtemConnectHello(packet) {
    return Buffer.isBuffer(packet) && packet.length === ATEM_CONNECT_HELLO.length && packet.equals(ATEM_CONNECT_HELLO);
  }

  _atemBuildPacket(flags, sessionId, packetId, payload = Buffer.alloc(0), ackId = 0) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
    const length = 12 + body.length;
    const out = Buffer.alloc(length, 0);
    out.writeUInt16BE(((flags & 0x1f) << 11) | length, 0);
    out.writeUInt16BE(sessionId & 0xffff, 2);
    if (flags & ATEM_PACKET_FLAGS.AckReply) out.writeUInt16BE(ackId & 0x7fff, 4);
    out.writeUInt16BE(packetId & 0x7fff, 10);
    body.copy(out, 12);
    return out;
  }

  _atemSendRaw(session, packet) {
    try {
      session.socket.send(packet, 0, packet.length, session.port, session.address);
    } catch {}
  }

  _atemSendAckReply(session, ackId) {
    const packet = this._atemBuildPacket(ATEM_PACKET_FLAGS.AckReply, session.sessionId, 0, Buffer.alloc(0), ackId);
    this._atemSendRaw(session, packet);
  }

  _atemSendAckRequest(session, payload = Buffer.alloc(0)) {
    const packetId = session.nextPacketId & 0x7fff;
    session.nextPacketId = (session.nextPacketId + 1) % 0x8000;
    const packet = this._atemBuildPacket(ATEM_PACKET_FLAGS.AckRequest, session.sessionId, packetId, payload);
    this._atemSendRaw(session, packet);
  }

  _atemMakeProgramPreviewPayload(programInput, previewInput, mixEffect = 0) {
    const pgPayload = Buffer.alloc(4);
    pgPayload.writeUInt8(mixEffect & 0xff, 0);
    pgPayload.writeUInt16BE(programInput & 0xffff, 2);
    const pvPayload = Buffer.alloc(4);
    pvPayload.writeUInt8(mixEffect & 0xff, 0);
    pvPayload.writeUInt16BE(previewInput & 0xffff, 2);
    return Buffer.concat([atemCmd('PrgI', pgPayload), atemCmd('PrvI', pvPayload)]);
  }

  _atemMakeProgramPayload(programInput, mixEffect = 0) {
    const pg = Buffer.alloc(4);
    pg.writeUInt8(mixEffect & 0xff, 0);
    pg.writeUInt16BE(programInput & 0xffff, 2);
    return pg;
  }

  _atemMakePreviewPayload(previewInput, mixEffect = 0) {
    const pv = Buffer.alloc(4);
    pv.writeUInt8(mixEffect & 0xff, 0);
    pv.writeUInt16BE(previewInput & 0xffff, 2);
    return pv;
  }

  _atemMakeInputLabelPayload(inputId, label) {
    const out = Buffer.alloc(36, 0);
    out.writeUInt16BE(inputId & 0xffff, 0);
    out.write(String(label.longName || ''), 2, 20, 'utf8');
    out.write(String(label.shortName || ''), 22, 4, 'utf8');
    out.writeUInt8(0, 26);
    out.writeUInt16BE(1, 28);
    out.writeUInt16BE(0, 30);
    out.writeUInt8(0, 32);
    out.writeUInt8(0x01, 34);
    out.writeUInt8(0x01, 35);
    return out;
  }

  _atemMakeRecordingStatusPayload(isRecording) {
    const out = Buffer.alloc(8, 0);
    // Include RecordingError.None bit (2) to avoid "NoMedia".
    out.writeUInt16BE(isRecording ? 0x0003 : 0x0002, 0);
    out.writeUInt32BE(3 * 60 * 60, 4);
    return out;
  }

  _atemBuildInitPayload() {
    const version = Buffer.alloc(4);
    version.writeUInt32BE(ATEM_PROTOCOL_VERSION, 0);

    const product = Buffer.alloc(41, 0);
    product.write('Mock ATEM Mini Extreme ISO', 0, 40, 'utf8');
    product.writeUInt8(ATEM_MODEL_MINI_EXTREME_ISO, 40);

    const topology = Buffer.alloc(24, 0);
    topology.writeUInt8(1, 0);   // mix effects
    topology.writeUInt8(20, 1);  // sources
    topology.writeUInt8(2, 2);   // downstream keyers
    topology.writeUInt8(4, 3);   // aux
    topology.writeUInt8(0, 4);   // mix minus
    topology.writeUInt8(2, 5);   // media players
    topology.writeUInt8(1, 6);   // multiviewers (v8.1+ offset layout)
    topology.writeUInt8(0, 7);   // serial ports
    topology.writeUInt8(2, 8);   // max hyperdecks
    topology.writeUInt8(1, 9);   // DVE
    topology.writeUInt8(1, 10);  // stingers
    topology.writeUInt8(1, 11);  // super sources
    topology.writeUInt8(2, 13);  // talkback channels
    topology.writeUInt8(1, 18);  // camera control
    topology.writeUInt8(1, 22);  // advanced chroma
    topology.writeUInt8(0, 23);  // only configurable outputs

    const recSettings = Buffer.alloc(137, 0);
    const initCommands = [
      atemCmd('_ver', version),
      atemCmd('_pin', product),
      atemCmd('_top', topology),
      atemCmd('RMSu', recSettings),
      atemCmd('InCm'),
    ];

    for (let i = 1; i <= 8; i += 1) {
      const entry = this.fakeAtem?._inputLabels?.get?.(i) || { longName: `Camera ${i}`, shortName: `CAM${i}` };
      initCommands.push(atemCmd('InPr', this._atemMakeInputLabelPayload(i, entry)));
    }

    const me = this.fakeAtem?.state?.video?.mixEffects?.[0] || {};
    initCommands.push(
      atemCmd('PrgI', this._atemMakeProgramPayload(me.programInput || 1, 0)),
      atemCmd('PrvI', this._atemMakePreviewPayload(me.previewInput || 2, 0)),
      atemCmd('RTMS', this._atemMakeRecordingStatusPayload(this.fakeAtem?.state?.recording?.status === 'Recording'))
    );

    return Buffer.concat(initCommands);
  }

  _atemDecodeCommands(payload) {
    const commands = [];
    let offset = 0;
    while (offset + 8 <= payload.length) {
      const len = payload.readUInt16BE(offset);
      if (len < 8 || offset + len > payload.length) break;
      const rawName = payload.toString('ascii', offset + 4, offset + 8);
      const body = payload.subarray(offset + 8, offset + len);
      commands.push({ rawName, body });
      offset += len;
    }
    return commands;
  }

  async _atemHandleIncomingCommands(session, payload) {
    const commands = this._atemDecodeCommands(payload);
    for (const cmd of commands) {
      const body = cmd.body;
      if (cmd.rawName === 'CPgI' && body.length >= 4) {
        const me = body.readUInt8(0);
        const source = body.readUInt16BE(2);
        await this.fakeAtem.changeProgramInput(me, source);
        this._atemSendAckRequest(session, this._atemMakeProgramPreviewPayload(this.fakeAtem.state.video.mixEffects[me]?.programInput || source, this.fakeAtem.state.video.mixEffects[me]?.previewInput || 2, me));
        continue;
      }

      if (cmd.rawName === 'CPvI' && body.length >= 4) {
        const me = body.readUInt8(0);
        const source = body.readUInt16BE(2);
        await this.fakeAtem.changePreviewInput(me, source);
        this._atemSendAckRequest(session, this._atemMakeProgramPreviewPayload(this.fakeAtem.state.video.mixEffects[me]?.programInput || 1, this.fakeAtem.state.video.mixEffects[me]?.previewInput || source, me));
        continue;
      }

      if (cmd.rawName === 'DCut' && body.length >= 1) {
        const me = body.readUInt8(0);
        await this.fakeAtem.cut(me);
        const stateMe = this.fakeAtem.state.video.mixEffects[me] || {};
        this._atemSendAckRequest(session, this._atemMakeProgramPreviewPayload(stateMe.programInput || 1, stateMe.previewInput || 2, me));
        continue;
      }

      if (cmd.rawName === 'DAut' && body.length >= 1) {
        const me = body.readUInt8(0);
        const rate = Number(this.fakeAtem.state.video.mixEffects[me]?.transitionProperties?.rate) || 25;
        const duration = Math.max(200, Math.min(3000, Math.round((rate / 30) * 1000)));
        await this.fakeAtem.autoTransition(me);
        setTimeout(() => {
          const stateMe = this.fakeAtem?.state?.video?.mixEffects?.[me] || {};
          this._atemSendAckRequest(session, this._atemMakeProgramPreviewPayload(stateMe.programInput || 1, stateMe.previewInput || 2, me));
        }, duration + 40);
        continue;
      }

      if (cmd.rawName === 'CInL' && body.length >= 32) {
        const flags = body.readUInt8(0);
        const input = body.readUInt16BE(2);
        const longRaw = body.subarray(4, 24).toString('utf8').replace(/\0.*$/g, '').trim();
        const shortRaw = body.subarray(24, 28).toString('utf8').replace(/\0.*$/g, '').trim();
        const current = this.fakeAtem?.state?.inputs?.[input] || {};
        const longName = (flags & 0x01) ? (longRaw || current.longName || `Input ${input}`) : (current.longName || `Input ${input}`);
        const shortName = (flags & 0x02) ? (shortRaw || longName.slice(0, 4).toUpperCase()) : (current.shortName || longName.slice(0, 4).toUpperCase());
        await this.fakeAtem.setInputSettings(input, { longName, shortName });
        this._atemSendAckRequest(session, atemCmd('InPr', this._atemMakeInputLabelPayload(input, { longName, shortName })));
        continue;
      }

      if (cmd.rawName === 'RcTM' && body.length >= 1) {
        await this.fakeAtem.setRecordingAction({ action: body.readUInt8(0) === 1 ? 1 : 0 });
        this._atemSendAckRequest(
          session,
          atemCmd('RTMS', this._atemMakeRecordingStatusPayload(this.fakeAtem?.state?.recording?.status === 'Recording'))
        );
        continue;
      }
    }
  }

  _onAtemUdpMessage(packet, rinfo) {
    if (!Buffer.isBuffer(packet) || packet.length < 12) return;

    const packetLength = packet.readUInt16BE(0) & 0x07ff;
    if (packetLength !== packet.length) return;

    const flags = packet.readUInt8(0) >> 3;
    const remotePacketId = packet.readUInt16BE(10) & 0x7fff;
    const key = this._atemSessionKey(rinfo);
    let session = this._atemSessions.get(key);

    if (this._isAtemConnectHello(packet) || (flags & ATEM_PACKET_FLAGS.NewSessionId)) {
      if (session?.keepAliveTimer) clearInterval(session.keepAliveTimer);
      session = {
        address: rinfo.address,
        port: rinfo.port,
        socket: this._atemUdpServer,
        sessionId: (Math.floor(Math.random() * 0x7fff) + 1) & 0xffff,
        nextPacketId: 1,
        keepAliveTimer: null,
      };

      if (!session.socket) return;

      this._atemSessions.set(key, session);
      const helloReply = this._atemBuildPacket(ATEM_PACKET_FLAGS.NewSessionId, session.sessionId, 0, Buffer.alloc(0));
      this._atemSendRaw(session, helloReply);

      setTimeout(() => {
        if (!this._atemSessions.has(key)) return;
        this._atemSendAckRequest(session, this._atemBuildInitPayload());
        setTimeout(() => {
          if (!this._atemSessions.has(key)) return;
          const me0 = this.fakeAtem?.state?.video?.mixEffects?.[0] || {};
          this._atemSendAckRequest(
            session,
            this._atemMakeProgramPreviewPayload(me0.programInput || 1, me0.previewInput || 2, 0)
          );
        }, 120);
      }, 30);

      session.keepAliveTimer = setInterval(() => {
        if (!this._atemSessions.has(key)) return;
        this._atemSendAckRequest(session, Buffer.alloc(0));
      }, 1000);

      return;
    }

    if (!session) return;

    if (flags & ATEM_PACKET_FLAGS.AckRequest) {
      this._atemSendAckReply(session, remotePacketId);
      if (packet.length > 12) {
        void this._atemHandleIncomingCommands(session, packet.subarray(12)).catch((err) => {
          this.logger(`[MockLab] Failed to process ATEM command payload: ${err?.message || err}`);
        });
      }
    }
  }

  async _startX32Protocol() {
    await this._bindTcpUdpPair(
      'x32',
      (socket) => {
        socket.setNoDelay(true);
        socket.setTimeout(2500);
        socket.on('timeout', () => socket.destroy());
        socket.on('error', () => {});
        try { socket.write('/xremote\n'); } catch {}
      },
      (message, rinfo) => {
        const decoded = decodeMessage(message);
        if (!decoded || !decoded.address) return;
        const args = Array.isArray(decoded.args) ? decoded.args : [];
        const address = decoded.address;
        const key = `${rinfo.address}:${rinfo.port}`;
        const state = this._x32Clients.get(key) || { xremote: false };
        this._x32Clients.set(key, state);

        const send = (oscAddress, oscArgs) => {
          try {
            const out = encodeMessage(oscAddress, oscArgs || []);
            for (const srv of this._servers) {
              if (srv && srv.type === 'udp4') {
                try {
                  const info = srv.address();
                  if (info && info.port === this._activeAddresses.x32.port) {
                    srv.send(out, 0, out.length, rinfo.port, rinfo.address);
                    return;
                  }
                } catch {}
              }
            }
          } catch {}
        };

        const snapshot = this.fakeMixer.getSnapshot();
        const parseChannel = (regex) => {
          const m = address.match(regex);
          return m ? Math.max(1, Math.min(32, Number(m[1]))) : null;
        };
        const query = args.length === 0;
        const argVal = args[0]?.value;

        if (address === '/xremote') {
          state.xremote = true;
          return;
        }

        if (address === '/info') {
          if (query) {
            send('/info', [
              { type: 's', value: snapshot.model || 'X32' },
              { type: 's', value: '4.06' },
              { type: 's', value: '4.06' },
              { type: 's', value: snapshot.model || 'X32' },
            ]);
          }
          return;
        }

        if (address === '/main/st/mix/fader') {
          if (query) send('/main/st/mix/fader', [{ type: 'f', value: Number(snapshot.mainFader ?? 0.75) }]);
          else void this.fakeMixer.setFader('master', Number(argVal));
          return;
        }

        if (address === '/main/st/mix/on') {
          if (query) send('/main/st/mix/on', [{ type: 'i', value: snapshot.mainMuted ? 0 : 1 }]);
          else {
            const isOn = Number(argVal) === 1;
            if (isOn) void this.fakeMixer.unmuteMaster();
            else void this.fakeMixer.muteMaster();
          }
          return;
        }

        if (address === '/-show/prepos/current') {
          if (query) send('/-show/prepos/current', [{ type: 'i', value: Number(snapshot.scene || 1) }]);
          return;
        }

        if (address === '/scene/recall' && !query) {
          void this.fakeMixer.recallScene(Number(argVal) || 1);
          return;
        }

        if (address === '/-action/clearsolo') {
          void this.fakeMixer.clearSolos();
          return;
        }

        const chFader = parseChannel(/^\/ch\/(\d{2})\/mix\/fader$/);
        if (chFader) {
          const ch = snapshot.channels?.[String(chFader)] || null;
          if (query) send(address, [{ type: 'f', value: Number(ch?.fader ?? 0.72) }]);
          else void this.fakeMixer.setChannelFader(chFader, Number(argVal));
          return;
        }

        const chMute = parseChannel(/^\/ch\/(\d{2})\/mix\/on$/);
        if (chMute) {
          const ch = snapshot.channels?.[String(chMute)] || null;
          if (query) send(address, [{ type: 'i', value: ch?.muted ? 0 : 1 }]);
          else {
            const isOn = Number(argVal) === 1;
            void this.fakeMixer.setChannelMute(chMute, !isOn);
          }
          return;
        }
      }
    );
  }

  _hyperdeckStatusFromFake(index = 0) {
    const hd = this.fakeAtem?.state?.hyperdecks?.[index] || { status: 'stopped', clip: 1 };
    const status = hd.status === 'playing' ? 'play' : hd.status === 'recording' ? 'record' : 'stop';
    return { status, clip: Math.max(1, Number(hd.clip) || 1) };
  }

  _hyperdeckTransportInfo(index = 0) {
    const snapshot = this._hyperdeckStatusFromFake(index);
    return [
      '208 transport info:',
      `status: ${snapshot.status}`,
      'speed: 100',
      'slot id: 1',
      `clip id: ${snapshot.clip}`,
      'single clip: false',
      'display timecode: 00:00:00:00',
      'timecode: 00:00:00:00',
      'video format: 1080p30',
      'loop: false',
      '',
    ].join('\r\n');
  }

  _hyperdeckSlotInfo() {
    return [
      '202 slot info:',
      'slot id: 1',
      'status: mounted',
      'recording time: 02:59:59:00',
      'video format: 1080p30',
      '',
    ].join('\r\n');
  }

  _hyperdeckClips(index = 0) {
    const snapshot = this._hyperdeckStatusFromFake(index);
    const first = Math.max(1, snapshot.clip - 1);
    return [
      '205 clips:',
      `${first} Mock Clip ${String(first).padStart(3, '0')} 00:00:10:00`,
      `${snapshot.clip} Mock Clip ${String(snapshot.clip).padStart(3, '0')} 00:00:10:00`,
      `${snapshot.clip + 1} Mock Clip ${String(snapshot.clip + 1).padStart(3, '0')} 00:00:10:00`,
      '',
    ].join('\r\n');
  }

  async _startHyperDeckProtocol() {
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket.setTimeout(10_000);
      socket.on('timeout', () => socket.destroy());
      socket.on('error', () => {});

      const state = {
        deck: 0,
        notifyTransport: false,
        buffer: '',
      };

      const send = (text) => {
        try { socket.write(text); } catch {}
      };

      send([
        '500 connection info:',
        'protocol version: 1.8',
        'model: HyperDeck Studio Mini',
        '',
      ].join('\r\n'));

      const sendTransportIfEnabled = () => {
        if (!state.notifyTransport) return;
        send([
          '508 transport info:',
          ...this._hyperdeckTransportInfo(state.deck).split('\r\n').slice(1),
        ].join('\r\n'));
      };

      const runHyperdeckAction = async (action) => {
        if (action === 'play') await this.fakeAtem.setHyperDeckPlay(state.deck);
        else if (action === 'stop') await this.fakeAtem.setHyperDeckStop(state.deck);
        else if (action === 'record') await this.fakeAtem.setHyperDeckRecord(state.deck);
        else if (action === 'next') await this.fakeAtem.setHyperDeckNextClip(state.deck);
        else if (action === 'prev') await this.fakeAtem.setHyperDeckPrevClip(state.deck);
      };

      const handleLine = async (line) => {
        const cmd = String(line || '').trim();
        if (!cmd) return;
        const lower = cmd.toLowerCase();

        if (lower === 'ping') return send('200 ok\r\n\r\n');
        if (lower === 'help') {
          return send([
            '201 help:',
            'commands: help, ping, transport info, slot info, clips get, play, stop, record, notify',
            '',
          ].join('\r\n'));
        }
        if (lower.startsWith('device info')) {
          return send([
            '204 device info:',
            'model: HyperDeck Studio Mini',
            'protocol version: 1.8',
            '',
          ].join('\r\n'));
        }
        if (lower.startsWith('transport info')) return send(this._hyperdeckTransportInfo(state.deck));
        if (lower.startsWith('slot info')) return send(this._hyperdeckSlotInfo());
        if (lower.startsWith('clips get')) return send(this._hyperdeckClips(state.deck));

        if (lower.startsWith('slot select')) {
          const m = lower.match(/slot id:\s*(\d+)/);
          state.deck = m ? Math.max(0, Number(m[1]) - 1) : 0;
          return send('200 ok\r\n\r\n');
        }

        if (lower.startsWith('notify')) {
          state.notifyTransport = /transport:\s*true/i.test(cmd);
          return send('200 ok\r\n\r\n');
        }

        if (lower.startsWith('goto')) {
          const m = lower.match(/clip id:\s*(\d+)/);
          if (m) {
            const target = Math.max(1, Number(m[1]) || 1);
            const now = this._hyperdeckStatusFromFake(state.deck).clip;
            if (target > now) {
              for (let i = now; i < target; i += 1) await runHyperdeckAction('next');
            } else if (target < now) {
              for (let i = now; i > target; i -= 1) await runHyperdeckAction('prev');
            }
          }
          send('200 ok\r\n\r\n');
          sendTransportIfEnabled();
          return;
        }

        if (lower.startsWith('play')) {
          await runHyperdeckAction('play');
          send('200 ok\r\n\r\n');
          sendTransportIfEnabled();
          return;
        }
        if (lower.startsWith('stop')) {
          await runHyperdeckAction('stop');
          send('200 ok\r\n\r\n');
          sendTransportIfEnabled();
          return;
        }
        if (lower.startsWith('record')) {
          await runHyperdeckAction('record');
          send('200 ok\r\n\r\n');
          sendTransportIfEnabled();
          return;
        }

        send('400 invalid command\r\n\r\n');
      };

      socket.on('data', (chunk) => {
        state.buffer += chunk.toString('utf8');
        while (true) {
          const rn = state.buffer.indexOf('\r\n');
          const n = state.buffer.indexOf('\n');
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
          const line = state.buffer.slice(0, idx);
          state.buffer = state.buffer.slice(idx + skip);
          void handleLine(line);
        }
      });
    });

    await this._listenWithFallback(server, 'hyperdeck');
    this._servers.push(server);
  }

  async _startObsApi() {
    const server = http.createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        device: 'mock-obs',
        protocols: [OBS_SUBPROTOCOL_JSON, OBS_SUBPROTOCOL_MSGPACK],
        wsPath: '/',
        wsPort: this._activeAddresses.obs.port,
        version: OBS_WS_VERSION,
      }));
    });

    const wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        if (protocols.has(OBS_SUBPROTOCOL_MSGPACK)) return OBS_SUBPROTOCOL_MSGPACK;
        if (protocols.has(OBS_SUBPROTOCOL_JSON)) return OBS_SUBPROTOCOL_JSON;
        const first = protocols.values().next();
        return first.done ? false : first.value;
      },
    });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      const client = {
        ws,
        protocol: ws.protocol || OBS_SUBPROTOCOL_JSON,
        identified: false,
        eventSubscriptions: 0,
      };
      this._obsClients.add(client);

      this._obsSend(client, {
        op: 0,
        d: {
          obsWebSocketVersion: OBS_WS_VERSION,
          rpcVersion: OBS_RPC_VERSION,
        },
      });

      ws.on('message', async (raw) => {
        const msg = this._decodeObsMessage(client, raw);
        if (!msg || typeof msg !== 'object') return;

        const op = Number(msg.op);
        const d = msg.d || {};

        if (op === 1) {
          client.identified = true;
          client.eventSubscriptions = Number(d.eventSubscriptions) || 0;
          this._obsSend(client, { op: 2, d: { negotiatedRpcVersion: OBS_RPC_VERSION } });
          return;
        }

        if (!client.identified) return;

        if (op === 3) {
          client.eventSubscriptions = Number(d.eventSubscriptions) || client.eventSubscriptions || 0;
          return;
        }

        if (op === 6) {
          const requestType = String(d.requestType || '');
          const requestId = String(d.requestId || `${Date.now()}`);
          try {
            const responseData = await this._handleObsRequest(requestType, d.requestData || {});
            this._obsSend(client, {
              op: 7,
              d: {
                requestType,
                requestId,
                requestStatus: { result: true, code: 100 },
                responseData: responseData || {},
              },
            });
          } catch (err) {
            this._obsSend(client, {
              op: 7,
              d: {
                requestType,
                requestId,
                requestStatus: {
                  result: false,
                  code: 400,
                  comment: String(err?.message || 'Request failed'),
                },
                responseData: {},
              },
            });
          }
          return;
        }

        if (op === 8) {
          const requestId = String(d.requestId || `${Date.now()}`);
          const requests = Array.isArray(d.requests) ? d.requests : [];
          const haltOnFailure = !!d.haltOnFailure;
          const results = [];
          for (const req of requests) {
            const requestType = String(req?.requestType || '');
            try {
              const responseData = await this._handleObsRequest(requestType, req?.requestData || {});
              results.push({
                requestType,
                requestStatus: { result: true, code: 100 },
                responseData: responseData || {},
              });
            } catch (err) {
              results.push({
                requestType,
                requestStatus: {
                  result: false,
                  code: 400,
                  comment: String(err?.message || 'Request failed'),
                },
                responseData: {},
              });
              if (haltOnFailure) break;
            }
          }

          this._obsSend(client, { op: 9, d: { requestId, results } });
        }
      });

      ws.on('close', () => {
        this._obsClients.delete(client);
      });

      ws.on('error', () => {});
    });

    await this._listenWithFallback(server, 'obs');
    this._servers.push(server);

    const onStream = (eventData = {}) => this._broadcastObsEvent('StreamStateChanged', eventData);
    const onRecord = (eventData = {}) => this._broadcastObsEvent('RecordStateChanged', eventData);
    const onScene = (eventData = {}) => this._broadcastObsEvent('CurrentProgramSceneChanged', eventData);
    this.fakeObs.on('StreamStateChanged', onStream);
    this.fakeObs.on('RecordStateChanged', onRecord);
    this.fakeObs.on('CurrentProgramSceneChanged', onScene);
    this._obsEventUnsubs.push(() => this.fakeObs?.off('StreamStateChanged', onStream));
    this._obsEventUnsubs.push(() => this.fakeObs?.off('RecordStateChanged', onRecord));
    this._obsEventUnsubs.push(() => this.fakeObs?.off('CurrentProgramSceneChanged', onScene));
  }

  _decodeObsMessage(client, raw) {
    try {
      if (client.protocol === OBS_SUBPROTOCOL_MSGPACK) {
        return msgpackDecode(raw);
      }
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  _obsSend(target, payload) {
    const client = target && target.ws ? target : null;
    const ws = client ? client.ws : target;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (client?.protocol === OBS_SUBPROTOCOL_MSGPACK) {
        ws.send(Buffer.from(msgpackEncode(payload)));
        return;
      }
      ws.send(JSON.stringify(payload));
    } catch {}
  }

  _obsEventIntent(eventType) {
    if (eventType === 'CurrentProgramSceneChanged') return 4; // Scenes
    if (eventType === 'StreamStateChanged' || eventType === 'RecordStateChanged') return 64; // Outputs
    return 1; // General
  }

  _broadcastObsEvent(eventType, eventData = {}) {
    const payload = {
      op: 5,
      d: {
        eventType,
        eventIntent: this._obsEventIntent(eventType),
        eventData: eventData || {},
      },
    };

    for (const client of this._obsClients) {
      if (!client.identified) continue;
      this._obsSend(client, payload);
    }
  }

  async _handleObsRequest(requestType, requestData = {}) {
    const type = String(requestType || '').trim();
    if (!type) throw new Error('requestType required');

    if (type === 'GetVersion') {
      return {
        obsVersion: '30.2.0-mock',
        obsWebSocketVersion: OBS_WS_VERSION,
        rpcVersion: OBS_RPC_VERSION,
        availableRequests: OBS_AVAILABLE_REQUESTS,
        supportedImageFormats: ['jpg', 'jpeg', 'png'],
        platform: process.platform,
        platformDescription: `MockLab (${process.platform})`,
      };
    }

    if (type === 'GetStudioModeEnabled') {
      return { studioModeEnabled: false };
    }

    if (type === 'GetCurrentPreviewScene') {
      const current = await this.fakeObs.call('GetCurrentProgramScene');
      return { currentPreviewSceneName: current.currentProgramSceneName };
    }

    if (type === 'SetCurrentPreviewScene') {
      return {};
    }

    return this.fakeObs.call(type, requestData);
  }

  async _startProPresenterApi() {
    const endpoint = this._activeAddresses.propresenter;
    const attempts = this._buildAttempts(endpoint);
    let lastError = null;

    for (const attempt of attempts) {
      const wsPort = attempt.port + 1;
      const apiServer = http.createServer((req, res) => {
        this._handleProPresenterHttp(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String(err?.message || 'internal error') }));
        });
      });

      const wsGateway = http.createServer((req, res) => {
        res.statusCode = 426;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Upgrade Required', path: '/stagedisplay' }));
      });

      const ppWss = new WebSocketServer({ noServer: true });
      wsGateway.on('upgrade', (req, socket, head) => {
        const urlPath = String(req.url || '/');
        if (!urlPath.startsWith('/stagedisplay')) {
          socket.destroy();
          return;
        }
        ppWss.handleUpgrade(req, socket, head, (ws) => ppWss.emit('connection', ws, req));
      });

      ppWss.on('connection', async (ws) => {
        this._propresenterWsClients.add(ws);
        ws.on('close', () => this._propresenterWsClients.delete(ws));
        ws.on('error', () => {});

        const slide = await this.fakeProPresenter.getCurrentSlide();
        if (slide) {
          this._propresenterWsSend(ws, {
            action: 'slideChanged',
            presentationName: slide.presentationName,
            slideIndex: slide.slideIndex,
            slideCount: slide.slideTotal,
            acn: 'fv',
            txt: `${Number(slide.slideIndex || 0) + 1}/${slide.slideTotal || 0}`,
          });
        }
      });

      try {
        await this._listen(apiServer, attempt.ip, attempt.port);
        await this._listen(wsGateway, attempt.ip, wsPort);

        if (attempt.ip !== endpoint.ip || attempt.port !== endpoint.port) {
          this._fallbackMode = true;
        }
        endpoint.ip = attempt.ip;
        endpoint.port = attempt.port;
        this._proPresenterWsEndpoint = { ip: attempt.ip, port: wsPort };

        this._servers.push(apiServer);
        this._servers.push(wsGateway);

        const onSlide = (data = {}) => {
          this._broadcastProPresenter({
            action: 'slideChanged',
            presentationName: data.presentationName || this.fakeProPresenter?._presentationName || 'Sunday Service',
            slideIndex: data.slideIndex ?? this.fakeProPresenter?._slideIndex ?? 0,
            slideCount: data.slideCount ?? this.fakeProPresenter?._slideTotal ?? 0,
            acn: data.acn || 'fv',
            txt: data.txt || '',
          });
        };
        const onPresentation = (data = {}) => {
          this._broadcastProPresenter({
            action: 'presentationChanged',
            presentationName: data.presentationName || this.fakeProPresenter?._presentationName || 'Sunday Service',
            slideCount: data.slideCount ?? this.fakeProPresenter?._slideTotal ?? 0,
          });
        };
        this.fakeProPresenter.on('slideChanged', onSlide);
        this.fakeProPresenter.on('presentationChanged', onPresentation);
        this._proPresenterEventUnsubs.push(() => this.fakeProPresenter?.off('slideChanged', onSlide));
        this._proPresenterEventUnsubs.push(() => this.fakeProPresenter?.off('presentationChanged', onPresentation));
        return;
      } catch (err) {
        lastError = err;
        try { apiServer.close(); } catch {}
        try { wsGateway.close(); } catch {}
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL')) continue;
        break;
      }
    }

    throw lastError || new Error(`Failed to bind propresenter on ${endpoint.ip}:${endpoint.port}`);
  }

  _propresenterWsSend(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  _broadcastProPresenter(payload) {
    for (const ws of this._propresenterWsClients) {
      this._propresenterWsSend(ws, payload);
    }
  }

  _sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  }

  async _handleProPresenterHttp(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '/');

    if (method === 'HEAD' && url === '/v1/version') {
      res.statusCode = 200;
      return res.end();
    }

    if (method === 'GET' && url === '/v1/version') {
      return this._sendJson(res, 200, { version: '7.13.0-mock', apiVersion: 'v1', mock: true });
    }

    if (method === 'GET' && url === '/v1/presentation/active') {
      const slide = await this.fakeProPresenter.getCurrentSlide();
      return this._sendJson(res, 200, {
        name: slide?.presentationName || 'Sunday Service',
        slideIndex: slide?.slideIndex ?? 0,
        slideCount: slide?.slideTotal ?? 0,
        notes: slide?.slideNotes || '',
        presentation: {
          name: slide?.presentationName || 'Sunday Service',
          slideIndex: slide?.slideIndex ?? 0,
          slideCount: slide?.slideTotal ?? 0,
        },
      });
    }

    if (method === 'GET' && url === '/v1/trigger/next') {
      await this.fakeProPresenter.nextSlide();
      return this._sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && url === '/v1/trigger/previous') {
      await this.fakeProPresenter.previousSlide();
      return this._sendJson(res, 200, { ok: true });
    }

    const gotoMatch = url.match(/^\/v1\/presentation\/active\/(\d+)\/trigger$/);
    if (method === 'GET' && gotoMatch) {
      await this.fakeProPresenter.goToSlide(Number(gotoMatch[1]));
      return this._sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && url === '/v1/playlists') {
      const playlists = await this.fakeProPresenter.getPlaylist();
      return this._sendJson(res, 200, { playlists });
    }

    return this._sendJson(res, 404, { error: 'not found' });
  }

  _listen(server, ip, port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, ip);
    });
  }

  async _listenWithFallback(server, key) {
    const endpoint = this._activeAddresses[key];
    const attempts = this._buildAttempts(endpoint);

    let lastError = null;
    for (const attempt of attempts) {
      try {
        await this._listen(server, attempt.ip, attempt.port);
        if (attempt.ip !== endpoint.ip || attempt.port !== endpoint.port) {
          this._fallbackMode = true;
        }
        endpoint.ip = attempt.ip;
        endpoint.port = attempt.port;
        return;
      } catch (err) {
        lastError = err;
        if (err && (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL')) continue;
        break;
      }
    }

    throw lastError || new Error(`Failed to bind ${key} on ${endpoint.ip}:${endpoint.port}`);
  }
}

module.exports = { MockLabManager, DEFAULT_ADDRESSES };
