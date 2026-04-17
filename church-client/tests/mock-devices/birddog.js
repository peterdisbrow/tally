'use strict';

/**
 * MockBirdDog — HTTP + UDP server mimicking a BirdDog PTZ encoder/decoder
 *
 * The BirdDog encoder (src/encoders/birddog.js) probes these endpoints:
 *   GET /about       → JSON { DeviceName, FWVersion, ... }
 *   GET /version     → fallback identity probe
 *   GET /decodestatus?ChNum=1  → JSON decode status
 *
 * VISCA-over-UDP PTZ preset recall (port 52381 by default on real hardware).
 * The mock UDP server accepts VISCA command bytes and tracks the last command.
 *
 * Test interface:
 *   getAbout()            → { DeviceName, FWVersion }
 *   getDecodeStatus()     → { source, status }
 *   setDecodeSource(src)  — simulate an NDI source appearing
 *   getLastViscaCommand() → Buffer | null
 *   getCallLog()          → string[]
 */

const http  = require('http');
const dgram = require('dgram');
const { EventEmitter } = require('events');

class MockBirdDog extends EventEmitter {
  constructor() {
    super();
    this._httpServer  = null;
    this._viscaSocket = null;
    this._callLog     = [];
    this._lastVisca   = null;

    this._about = {
      DeviceName:  'BirdDog P200',
      FWVersion:   '3.0',
      BuildDate:   '2024-01-01',
      model:       'P200',
    };

    this._decodeStatus = {
      source:     'BirdDog_Camera1 (Stream)',
      status:     'connected',
      resolution: '1920x1080',
      frameRate:  '59.94',
    };
  }

  /** The HTTP port the server is bound to (available after start()). */
  get port() {
    return this._httpServer?.address()?.port ?? null;
  }

  /** The UDP VISCA port (available after start()). */
  get viscaPort() {
    return this._viscaSocket?.address()?.port ?? null;
  }

  /**
   * Start both the HTTP and VISCA UDP servers.
   * @param {number} [httpPort=0]   0 = random available port
   * @param {number} [viscaPort=0]  0 = random available port
   */
  async start(httpPort = 0, viscaPort = 0) {
    const [hp, vp] = await Promise.all([
      this._startHttp(httpPort),
      this._startVisca(viscaPort),
    ]);
    return { httpPort: hp, viscaPort: vp };
  }

  async stop() {
    await Promise.all([
      new Promise((resolve) => this._httpServer ? this._httpServer.close(() => resolve()) : resolve()),
      new Promise((resolve) => {
        if (!this._viscaSocket) return resolve();
        this._viscaSocket.close(() => resolve());
        this._viscaSocket = null;
      }),
    ]);
  }

  // ─── HTTP SERVER ──────────────────────────────────────────────────────────

  _startHttp(port) {
    return new Promise((resolve, reject) => {
      this._httpServer = http.createServer((req, res) => this._handleHttp(req, res));
      this._httpServer.once('error', reject);
      this._httpServer.listen(port, '127.0.0.1', () => resolve(this._httpServer.address().port));
    });
  }

  _handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost');
    this._callLog.push(url.pathname);

    switch (url.pathname) {
      case '/about':
      case '/version': {
        const body = JSON.stringify(this._about);
        res.writeHead(200, {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        break;
      }

      case '/decodestatus': {
        const body = JSON.stringify(this._decodeStatus);
        res.writeHead(200, {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        break;
      }

      case '/List': {
        // Some BirdDog firmware exposes /List for device enumeration
        const body = JSON.stringify([this._about]);
        res.writeHead(200, {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        res.end(body);
        break;
      }

      default:
        res.writeHead(404);
        res.end();
        break;
    }
  }

  // ─── VISCA UDP SERVER ─────────────────────────────────────────────────────

  _startVisca(port) {
    return new Promise((resolve, reject) => {
      this._viscaSocket = dgram.createSocket('udp4');
      this._viscaSocket.once('error', reject);
      this._viscaSocket.on('message', (msg, rinfo) => {
        this._lastVisca = msg;
        this.emit('visca', { command: msg, rinfo });

        // VISCA ACK + Completion response
        const ack  = Buffer.from([0x90, 0x41, 0xFF]);
        const comp = Buffer.from([0x90, 0x51, 0xFF]);
        this._viscaSocket.send(ack,  0, ack.length,  rinfo.port, rinfo.address);
        this._viscaSocket.send(comp, 0, comp.length, rinfo.port, rinfo.address);
      });
      this._viscaSocket.bind(port, '127.0.0.1', () => {
        this._viscaSocket.removeListener('error', reject);
        resolve(this._viscaSocket.address().port);
      });
    });
  }

  // ─── TEST INSPECTION API ──────────────────────────────────────────────────

  getAbout()  { return { ...this._about }; }

  getDecodeStatus() { return { ...this._decodeStatus }; }

  /** Simulate an NDI source appearing on the decoder. */
  setDecodeSource(source) {
    this._decodeStatus.source = source;
    this._decodeStatus.status = source ? 'connected' : 'disconnected';
  }

  getLastViscaCommand() { return this._lastVisca; }

  getCallLog()  { return [...this._callLog]; }
  clearCallLog() { this._callLog = []; }

  /** Override the device identity the /about endpoint returns. */
  setAbout(fields) {
    Object.assign(this._about, fields);
  }
}

module.exports = { MockBirdDog };
