const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

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

const DEFAULT_ADDRESSES = {
  atem: { ip: '127.10.10.11', port: 9910 },
  obs: { ip: '127.10.10.12', port: 4455 },
  x32: { ip: '127.10.10.13', port: 10023 },
  encoder: { ip: '127.10.10.14', port: 1935 },
  hyperdeck: { ip: '127.10.10.15', port: 9993 },
  propresenter: { ip: '127.10.10.16', port: 1025 },
  controlApi: { ip: '127.0.0.1', port: 9911 },
};

const ENDPOINT_KEYS = ['atem', 'obs', 'x32', 'encoder', 'hyperdeck', 'propresenter', 'controlApi'];
const DEVICE_KEYS = ['atem', 'obs', 'x32', 'encoder', 'hyperdeck', 'propresenter'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAddresses(candidate, { requireUniqueIps = true } = {}) {
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
      this.setAddresses(opts.addresses, { requireUniqueIps: opts.requireUniqueIps !== false });
    } else {
      this.addresses = normalizeAddresses(this.addresses, { requireUniqueIps: opts.requireUniqueIps !== false });
    }

    this._allowFallback = opts.allowFallback !== undefined ? !!opts.allowFallback : true;
    this._activeAddresses = clone(this.addresses);
    this._fallbackMode = false;

    try {
      this._createMockDevices();
      await this._startMockDevices();

      await this._startTcpProbe('atem', () => 'ATEM MOCK\n');
      await this._startTcpProbe('obs', () => 'OBS MOCK\n');
      await this._startTcpProbe('x32', () => '/xremote\n');
      await this._startTcpProbe('encoder', () => 'ENCODER MOCK\n');
      await this._startTcpProbe('hyperdeck', () => '500 connection info\r\n');
      await this._startProPresenterProbeHttp();
      await this._startControlApi();

      this._running = true;
      this.logger(`[MockLab] Started. Endpoints: ${Object.entries(this._activeAddresses).map(([k, v]) => `${k}=${v.ip}:${v.port}`).join(', ')}`);
      return this.getAddresses();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    await this._stopControlApi();

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

  _startProPresenterProbeHttp() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === 'HEAD' && req.url === '/v1/version') {
          res.statusCode = 200;
          return res.end();
        }

        if (req.url === '/v1/version') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ version: '7.0-mock', mock: true }));
        }

        if (req.url === '/v1/presentation/active') {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          return res.end(JSON.stringify({ name: 'Sunday Service', slideIndex: 0, slideCount: 12 }));
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });

      this._listenWithFallback(server, 'propresenter')
        .then(() => {
          this._servers.push(server);
          resolve();
        })
        .catch(reject);
    });
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
