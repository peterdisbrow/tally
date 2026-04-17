'use strict';

/**
 * MockVmix — HTTP server mimicking the vMix Web API
 *
 * The vMix client (src/vmix.js) uses:
 *   GET /api/?Function=GetShortXML        — health check + state
 *   GET /api/?Function=StartStreaming
 *   GET /api/?Function=StopStreaming
 *   GET /api/?Function=StartRecording
 *   GET /api/?Function=StopRecording
 *   GET /api/?Function=Cut
 *   GET /api/?Function=Fade&Duration=N
 *   GET /api/?Function=PreviewInput&Input=N
 *   GET /api/?Function=ActiveInput&Input=N
 *   GET /api/?Function=SetVolume&Input=Master&Value=N
 *   GET /api/?Function=MuteInput&Input=Master
 *   GET /api/?Function=UnmuteInput&Input=Master
 *
 * All function calls return HTTP 200 with an empty body.
 * GetShortXML returns a minimal vMix XML document reflecting current state.
 *
 * Test interface:
 *   getState()         → { streaming, recording, activeInput, previewInput, … }
 *   setStreaming(bool)
 *   setRecording(bool)
 *   getCallLog()       → string[]  list of Function= values called
 *   clearCallLog()
 */

const http = require('http');
const { EventEmitter } = require('events');

function buildXml(state) {
  // The vMix client uses _extractTag(xml, 'stream') — tag name is 'stream',
  // not 'streaming'.  Using <stream> matches what real vMix instances return.
  const stream    = state.streaming  ? 'True' : 'False';
  const recording = state.recording  ? 'True' : 'False';
  const external  = 'False';

  const inputsXml = state.inputs.map((inp) =>
    `  <input key="${inp.key}" number="${inp.number}" type="${inp.type}" ` +
    `title="${inp.title}" state="Paused" muted="False" volume="100" />`
  ).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<vmix>
  <version>${state.version}</version>
  <edition>${state.edition}</edition>
  <preset></preset>
  <inputs>
${inputsXml}
  </inputs>
  <overlays></overlays>
  <preview>${state.previewInput}</preview>
  <active>${state.activeInput}</active>
  <fadeToBlack>False</fadeToBlack>
  <transitions></transitions>
  <recording>${recording}</recording>
  <external>${external}</external>
  <stream>${stream}</stream>
  <playList>False</playList>
  <multiCorder>False</multiCorder>
  <fullscreen>False</fullscreen>
  <audio>
    <master volume="100" muted="False" meterF1="0.00" meterF2="0.00" />
  </audio>
</vmix>`;
}

class MockVmix extends EventEmitter {
  constructor() {
    super();
    this._server  = null;
    this._callLog = [];

    this._state = {
      version:      '26.0.0.58',
      edition:      'HD',
      streaming:    false,
      recording:    false,
      activeInput:  1,
      previewInput: 2,
      inputs: [
        { key: 'key-1', number: 1, type: 'Capture',  title: 'Camera 1' },
        { key: 'key-2', number: 2, type: 'Capture',  title: 'Camera 2' },
        { key: 'key-3', number: 3, type: 'Colour',   title: 'Colour 1' },
        { key: 'key-4', number: 4, type: 'GT',       title: 'Lower Third' },
      ],
    };
  }

  /** The HTTP port the server is bound to (available after start()). */
  get port() {
    return this._server?.address()?.port ?? null;
  }

  /**
   * Start the HTTP server.
   * @param {number} [port=0]  0 = random available port
   * @returns {Promise<number>} bound port
   */
  async start(port = 0) {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => this._handleRequest(req, res));
      this._server.once('error', reject);
      this._server.listen(port, '127.0.0.1', () => resolve(this._server.address().port));
    });
  }

  async stop() {
    return new Promise((resolve) => this._server.close(() => resolve()));
  }

  // ─── HTTP HANDLER ─────────────────────────────────────────────────────────

  _handleRequest(req, res) {
    const url    = new URL(req.url, 'http://localhost');
    const fn     = url.searchParams.get('Function') ?? '';
    const input  = url.searchParams.get('Input');
    const value  = url.searchParams.get('Value');
    const dur    = url.searchParams.get('Duration');

    if (url.pathname !== '/api/') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (fn) this._callLog.push(fn);

    switch (fn) {
      case 'GetShortXML': {
        const xml = buildXml(this._state);
        res.writeHead(200, {
          'Content-Type':   'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(xml),
        });
        res.end(xml);
        return;
      }

      case 'StartStreaming':
        this._state.streaming = true;
        this.emit('streamingChanged', true);
        break;

      case 'StopStreaming':
        this._state.streaming = false;
        this.emit('streamingChanged', false);
        break;

      case 'StartRecording':
        this._state.recording = true;
        this.emit('recordingChanged', true);
        break;

      case 'StopRecording':
        this._state.recording = false;
        this.emit('recordingChanged', false);
        break;

      case 'Cut':
        // Swap active ↔ preview
        [this._state.activeInput, this._state.previewInput] =
          [this._state.previewInput, this._state.activeInput];
        this.emit('cut');
        break;

      case 'ActiveInput':
        if (input != null) {
          this._state.activeInput = parseInt(input, 10) || this._state.activeInput;
          this.emit('activeInputChanged', this._state.activeInput);
        }
        break;

      case 'PreviewInput':
        if (input != null) {
          this._state.previewInput = parseInt(input, 10) || this._state.previewInput;
          this.emit('previewInputChanged', this._state.previewInput);
        }
        break;

      default:
        // Unknown function — still return 200 (vMix behaviour)
        break;
    }

    res.writeHead(200);
    res.end();
  }

  // ─── TEST INSPECTION API ──────────────────────────────────────────────────

  /** Snapshot of internal state. */
  getState() {
    return { ...this._state };
  }

  /** Force streaming state (for pre-test setup). */
  setStreaming(on) {
    this._state.streaming = Boolean(on);
  }

  /** Force recording state. */
  setRecording(on) {
    this._state.recording = Boolean(on);
  }

  /** All Function= parameter values received (in order). */
  getCallLog() {
    return [...this._callLog];
  }

  clearCallLog() {
    this._callLog = [];
  }

  /**
   * Resolves once the named function has been called at least once.
   * @param {string} fnName  e.g. 'StartStreaming'
   * @param {number} [timeoutMs=2000]
   */
  waitForCall(fnName, timeoutMs = 2000) {
    if (this._callLog.includes(fnName)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('_call', handler);
        reject(new Error(`Timeout waiting for vMix call: ${fnName}`));
      }, timeoutMs);

      // Fire a private event so we can listen for each call
      const origPush = this._callLog.push.bind(this._callLog);
      const self     = this;
      this._callLog.push = function (...args) {
        const result = origPush(...args);
        self.emit('_call', args[0]);
        return result;
      };

      const handler = (name) => {
        if (name === fnName) {
          clearTimeout(timer);
          self.removeListener('_call', handler);
          resolve();
        }
      };
      this.on('_call', handler);
    });
  }
}

module.exports = { MockVmix };
