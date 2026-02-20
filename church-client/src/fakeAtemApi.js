const http = require('http');
const { URL } = require('url');

function buildUiHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tally Mock Production Lab</title>
  <style>
    :root {
      --ink: #e5f0ea;
      --muted: #8aa499;
      --bg-1: #06110d;
      --bg-2: #10201a;
      --card: rgba(15, 30, 24, 0.75);
      --line: rgba(127, 187, 154, 0.25);
      --accent: #5af2a0;
      --accent-2: #7be0ff;
      --danger: #ff6a6a;
      --warn: #ffd56a;
      --ok: #66f29b;
      --font: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
      --mono: "SF Mono", "Menlo", monospace;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      font-family: var(--font);
      background:
        radial-gradient(900px 400px at 10% -10%, rgba(90,242,160,0.17), transparent 60%),
        radial-gradient(700px 300px at 90% 0%, rgba(123,224,255,0.16), transparent 58%),
        linear-gradient(160deg, var(--bg-1), var(--bg-2));
      min-height: 100vh;
    }

    .wrap {
      width: min(1220px, 94vw);
      margin: 22px auto 36px;
    }

    .hero {
      padding: 18px 20px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: linear-gradient(140deg, rgba(17,39,31,0.86), rgba(10,26,21,0.82));
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
      margin-bottom: 14px;
    }

    .title {
      margin: 0;
      font-size: 28px;
      line-height: 1.1;
      font-weight: 820;
      letter-spacing: -0.02em;
    }

    .subtitle {
      margin-top: 7px;
      color: var(--muted);
      font-size: 13px;
      letter-spacing: 0.01em;
    }

    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }

    .pill {
      border: 1px solid var(--line);
      background: rgba(7, 17, 14, 0.7);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 11px;
      font-family: var(--mono);
      color: var(--muted);
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }

    .card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--card);
      backdrop-filter: blur(4px);
      padding: 12px;
      box-shadow: 0 14px 34px rgba(0, 0, 0, 0.3);
    }

    .card h3 {
      margin: 0 0 8px;
      font-size: 14px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--accent);
    }

    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    .row:first-of-type { margin-top: 0; }

    label {
      min-width: 64px;
      color: var(--muted);
      font-size: 11px;
      font-family: var(--mono);
    }

    input, select, button {
      border-radius: 8px;
      border: 1px solid var(--line);
      background: rgba(7, 16, 13, 0.85);
      color: var(--ink);
      padding: 7px 9px;
      font-size: 12px;
      font-family: var(--font);
    }

    input, select { min-width: 64px; }

    button {
      cursor: pointer;
      font-weight: 650;
      background: linear-gradient(145deg, rgba(90,242,160,0.25), rgba(90,242,160,0.09));
    }

    button.alt {
      background: linear-gradient(145deg, rgba(123,224,255,0.21), rgba(123,224,255,0.08));
    }

    button.warn {
      background: linear-gradient(145deg, rgba(255,213,106,0.27), rgba(255,213,106,0.08));
      color: #ffe7ad;
    }

    button.danger {
      background: linear-gradient(145deg, rgba(255,106,106,0.28), rgba(255,106,106,0.1));
      color: #ffc9c9;
    }

    pre {
      margin: 0;
      max-height: 300px;
      overflow: auto;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: rgba(6, 12, 10, 0.9);
      padding: 12px;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.35;
      color: #d0e4d8;
    }

    .meta {
      margin-top: 8px;
      font-family: var(--mono);
      color: var(--muted);
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1 class="title">Tally Mock Production Lab</h1>
      <div class="subtitle">ATEM, HyperDeck, OBS + Encoder, X32, and ProPresenter in one local control room.</div>
      <div class="pill-row">
        <div class="pill">Local Only</div>
        <div class="pill">No Hardware Required</div>
        <div class="pill">Updates Every 2s</div>
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <h3>ATEM + HyperDeck</h3>
        <div class="row"><label>Program</label><input id="program" type="number" min="1" value="1"><button onclick="setProgram()">Set</button></div>
        <div class="row"><label>Preview</label><input id="preview" type="number" min="1" value="2"><button onclick="setPreview()">Set</button></div>
        <div class="row"><button onclick="post('/api/cut')">Cut</button><button class="alt" onclick="post('/api/auto')">Auto</button></div>
        <div class="row"><button onclick="setRec(true)">Start Rec</button><button class="alt" onclick="setRec(false)">Stop Rec</button></div>
        <div class="row"><button onclick="setFade(true)">Fade Black ON</button><button class="alt" onclick="setFade(false)">OFF</button></div>
        <div class="row"><label>Deck</label><input id="hd-index" type="number" min="0" value="0"><select id="hd-action"><option value="play">Play</option><option value="stop">Stop</option><option value="record">Record</option><option value="next">Next Clip</option><option value="prev">Prev Clip</option></select><button onclick="doHyperdeck()">Run</button></div>
      </article>

      <article class="card">
        <h3>OBS + Encoder</h3>
        <div class="row"><button onclick="setObsStream(true)">Start Stream</button><button class="alt" onclick="setObsStream(false)">Stop Stream</button></div>
        <div class="row"><button onclick="setObsRecord(true)">Start Record</button><button class="alt" onclick="setObsRecord(false)">Stop Record</button></div>
        <div class="row"><label>Scene</label><input id="scene" value="Program"><button onclick="setScene()">Set Scene</button></div>
        <div class="row"><label>FPS</label><input id="enc-fps" type="number" min="1" max="120" value="30"><label>CPU</label><input id="enc-cpu" type="number" min="0" max="100" value="18"><button onclick="setEncoder()">Apply</button></div>
        <div class="row"><label>Cong.</label><input id="enc-cong" type="number" min="0" max="1" step="0.01" value="0.02"><label>Kbps</label><input id="enc-kbps" type="number" min="64" value="4500"><button class="warn" onclick="setEncoder()">Set Load</button></div>
      </article>

      <article class="card">
        <h3>X32 Mixer</h3>
        <div class="row"><button onclick="setMixerOnline(true)">Online</button><button class="alt" onclick="setMixerOnline(false)">Offline</button></div>
        <div class="row"><button onclick="setMasterMute(true)">Mute Master</button><button class="alt" onclick="setMasterMute(false)">Unmute</button></div>
        <div class="row"><label>Fader</label><input id="m-fader" type="number" min="0" max="1" step="0.01" value="0.78"><button onclick="setMixerFader()">Set</button></div>
        <div class="row"><label>Scene</label><input id="m-scene" type="number" min="1" value="1"><button onclick="setMixerScene()">Recall</button></div>
      </article>

      <article class="card">
        <h3>ProPresenter</h3>
        <div class="row"><button onclick="setPPRunning(true)">Running</button><button class="alt" onclick="setPPRunning(false)">Stopped</button></div>
        <div class="row"><label>Name</label><input id="pp-name" value="Sunday Service"><label>Total</label><input id="pp-total" type="number" min="1" value="12"><button onclick="setPPPresentation()">Set</button></div>
        <div class="row"><button onclick="ppNext()">Next</button><button class="alt" onclick="ppPrev()">Prev</button></div>
        <div class="row"><label>Slide</label><input id="pp-slide" type="number" min="1" value="1"><button onclick="ppSlide()">Go</button></div>
      </article>
    </section>

    <section class="card" style="margin-top:12px;">
      <div class="row" style="justify-content:space-between;">
        <h3 style="margin:0;">Combined State</h3>
        <div>
          <button class="alt" onclick="refresh()">Refresh</button>
          <button class="danger" onclick="post('/api/reset')">Reset All</button>
        </div>
      </div>
      <pre id="state">Loading...</pre>
      <div class="meta">Tip: Leave this page open while running the Electron Mock Lab tab.</div>
    </section>
  </div>

  <script>
    async function api(path, method = 'GET', body) {
      const opts = { method, headers: { 'content-type': 'application/json' } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'request failed');
      return data;
    }

    async function post(path, body = {}) {
      await api(path, 'POST', body);
      await refresh();
    }

    async function refresh() {
      const data = await api('/api/state');
      document.getElementById('state').textContent = JSON.stringify(data.state, null, 2);
    }

    async function setProgram() { await post('/api/program', { input: Number(document.getElementById('program').value) }); }
    async function setPreview() { await post('/api/preview', { input: Number(document.getElementById('preview').value) }); }
    async function setRec(v) { await post('/api/recording', { recording: v }); }
    async function setFade(v) { await post('/api/fade-to-black', { enabled: v }); }
    async function doHyperdeck() {
      await post('/api/hyperdeck/action', {
        index: Number(document.getElementById('hd-index').value),
        action: document.getElementById('hd-action').value,
      });
    }

    async function setObsStream(v) { await post('/api/obs/stream', { active: v }); }
    async function setObsRecord(v) { await post('/api/obs/record', { active: v }); }
    async function setScene() { await post('/api/obs/scene', { scene: document.getElementById('scene').value }); }
    async function setEncoder() {
      await post('/api/obs/encoder', {
        fps: Number(document.getElementById('enc-fps').value),
        cpuUsage: Number(document.getElementById('enc-cpu').value),
        congestion: Number(document.getElementById('enc-cong').value),
        bitrateKbps: Number(document.getElementById('enc-kbps').value),
      });
    }

    async function setMixerOnline(v) { await post('/api/mixer/online', { online: v }); }
    async function setMasterMute(v) { await post('/api/mixer/master', { muted: v }); }
    async function setMixerFader() { await post('/api/mixer/fader', { level: Number(document.getElementById('m-fader').value) }); }
    async function setMixerScene() { await post('/api/mixer/scene', { scene: Number(document.getElementById('m-scene').value) }); }

    async function setPPRunning(v) { await post('/api/propresenter/running', { running: v }); }
    async function setPPPresentation() {
      await post('/api/propresenter/presentation', {
        name: document.getElementById('pp-name').value,
        slideTotal: Number(document.getElementById('pp-total').value),
      });
    }
    async function ppNext() { await post('/api/propresenter/next'); }
    async function ppPrev() { await post('/api/propresenter/prev'); }
    async function ppSlide() { await post('/api/propresenter/slide', { index: Number(document.getElementById('pp-slide').value) - 1 }); }

    refresh().catch((e) => { document.getElementById('state').textContent = e.message; });
    setInterval(() => refresh().catch(() => {}), 2000);
  </script>
</body>
</html>`;
}

const COMMAND_CATALOG = [
  { method: 'GET', path: '/api/state', description: 'Return full combined snapshot for all mock devices.' },
  { method: 'GET', path: '/api/commands', description: 'Return supported command list and payload hints.' },
  { method: 'POST', path: '/api/program', body: { me: 0, input: 1 } },
  { method: 'POST', path: '/api/preview', body: { me: 0, input: 2 } },
  { method: 'POST', path: '/api/cut', body: { me: 0 } },
  { method: 'POST', path: '/api/auto', body: { me: 0 } },
  { method: 'POST', path: '/api/atem/transition/style', body: { me: 0, style: 'mix|dip|wipe|dve|sting' } },
  { method: 'POST', path: '/api/atem/transition/rate', body: { me: 0, rate: 25 } },
  { method: 'POST', path: '/api/atem/aux', body: { aux: 1, input: 1 } },
  { method: 'POST', path: '/api/atem/usk/onair', body: { me: 0, keyer: 0, onAir: true } },
  { method: 'POST', path: '/api/atem/usk/tie', body: { me: 0, keyer: 0, tie: true } },
  { method: 'POST', path: '/api/atem/usk/type', body: { me: 0, keyer: 0, type: 'luma|chroma|pattern|dve' } },
  { method: 'POST', path: '/api/atem/usk/sources', body: { me: 0, keyer: 0, fillSource: 3, keySource: 4 } },
  { method: 'POST', path: '/api/atem/dsk/onair', body: { keyer: 0, onAir: true } },
  { method: 'POST', path: '/api/atem/dsk/tie', body: { keyer: 0, tie: true } },
  { method: 'POST', path: '/api/atem/dsk/rate', body: { keyer: 0, rate: 25 } },
  { method: 'POST', path: '/api/atem/dsk/source', body: { keyer: 0, fillSource: 3, keySource: 4 } },
  {
    method: 'POST',
    path: '/api/atem/supersource/art',
    body: { enabled: true, fillSource: 1, cutSource: 2, premultiplied: false, clip: 0, gain: 0, invert: false },
  },
  {
    method: 'POST',
    path: '/api/atem/supersource/box',
    body: { box: 0, enabled: true, input: 1, x: 0.25, y: -0.15, size: 0.5, cropped: false },
  },
  { method: 'POST', path: '/api/atem/color', body: { index: 1, hue: 120, saturation: 500, luma: 500 } },
  { method: 'POST', path: '/api/atem/macro/run', body: { index: 1 } },
  { method: 'POST', path: '/api/atem/macro/stop', body: {} },
  { method: 'POST', path: '/api/atem/media/source', body: { player: 1, sourceType: 'still|clip', sourceIndex: 1 } },
  { method: 'POST', path: '/api/atem/media/play', body: { player: 1, playing: true } },
  { method: 'POST', path: '/api/atem/label', body: { input: 1, longName: 'Center Cam', shortName: 'CTR' } },
  { method: 'POST', path: '/api/atem/ptz/preset', body: { camera: 1, preset: 2 } },
  { method: 'POST', path: '/api/atem/ptz/pantilt', body: { camera: 1, pan: 0.2, tilt: -0.1 } },
  { method: 'POST', path: '/api/atem/ptz/zoom', body: { camera: 1, zoom: 0.5 } },
  { method: 'POST', path: '/api/recording', body: { recording: true } },
  { method: 'POST', path: '/api/fade-to-black', body: { enabled: true } },
  { method: 'POST', path: '/api/audio/master', body: { left: 16000, right: 16000, holdMs: 15000 } },
  { method: 'POST', path: '/api/audio/delay', body: { input: 1, delay: 80 } },
  { method: 'POST', path: '/api/hyperdeck/action', body: { index: 0, action: 'play|stop|record|next|prev' } },
  { method: 'POST', path: '/api/obs/stream', body: { active: true } },
  { method: 'POST', path: '/api/obs/record', body: { active: true } },
  { method: 'POST', path: '/api/obs/scene', body: { scene: 'Program' } },
  { method: 'POST', path: '/api/obs/encoder', body: { fps: 30, cpuUsage: 18, congestion: 0.02, bitrateKbps: 4500 } },
  { method: 'POST', path: '/api/mixer/online', body: { online: true } },
  { method: 'POST', path: '/api/mixer/master', body: { muted: false } },
  { method: 'POST', path: '/api/mixer/fader', body: { level: 0.78 } },
  { method: 'POST', path: '/api/mixer/scene', body: { scene: 1 } },
  { method: 'POST', path: '/api/propresenter/running', body: { running: true } },
  { method: 'POST', path: '/api/propresenter/presentation', body: { name: 'Sunday Service', slideTotal: 12 } },
  { method: 'POST', path: '/api/propresenter/next', body: {} },
  { method: 'POST', path: '/api/propresenter/prev', body: {} },
  { method: 'POST', path: '/api/propresenter/slide', body: { index: 0 } },
  { method: 'POST', path: '/api/reset', body: {} },
];

class FakeAtemApiServer {
  constructor({ fakeAtem, fakeObs = null, fakeMixer = null, fakeProPresenter = null, host = '127.0.0.1', port = 9911, logger = console.log }) {
    this.fakeAtem = fakeAtem;
    this.fakeObs = fakeObs;
    this.fakeMixer = fakeMixer;
    this.fakeProPresenter = fakeProPresenter;
    this.host = host;
    this.port = Number(port) || 9911;
    this.logger = logger;
    this.server = null;
  }

  setMocks({ fakeAtem, fakeObs, fakeMixer, fakeProPresenter } = {}) {
    if (fakeAtem !== undefined) this.fakeAtem = fakeAtem;
    if (fakeObs !== undefined) this.fakeObs = fakeObs;
    if (fakeMixer !== undefined) this.fakeMixer = fakeMixer;
    if (fakeProPresenter !== undefined) this.fakeProPresenter = fakeProPresenter;
  }

  async start() {
    if (this.server) return this.address();

    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((e) => {
        this._json(res, 500, { error: e.message || 'internal error' });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });

    this.logger(`[MockLab] Control API listening on http://${this.host}:${this.port}`);
    return this.address();
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise((resolve) => srv.close(() => resolve()));
  }

  address() {
    return `http://${this.host}:${this.port}`;
  }

  async _handleRequest(req, res) {
    if (!req.url) return this._json(res, 400, { error: 'missing url' });
    const url = new URL(req.url, `http://${this.host}:${this.port}`);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return this._html(res, buildUiHtml());
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      return this._json(res, 200, { ok: true, state: await this._snapshot() });
    }

    if (req.method === 'GET' && url.pathname === '/api/commands') {
      return this._json(res, 200, { ok: true, commands: COMMAND_CATALOG });
    }

    if (req.method !== 'POST') {
      return this._json(res, 405, { error: 'method not allowed' });
    }

    const body = await this._readJsonBody(req);

    if (url.pathname === '/api/program') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.changeProgramInput(Number(body.me) || 0, Number(body.input) || 1);
      return this._state(res);
    }

    if (url.pathname === '/api/preview') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.changePreviewInput(Number(body.me) || 0, Number(body.input) || 2);
      return this._state(res);
    }

    if (url.pathname === '/api/cut') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.cut(Number(body.me) || 0);
      return this._state(res);
    }

    if (url.pathname === '/api/auto') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.autoTransition(Number(body.me) || 0);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/transition/style') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setTransitionStyle(Number(body.me) || 0, body.style);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/transition/rate') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setTransitionRate(Number(body.me) || 0, body.rate);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/aux') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setAuxSource(body.aux, body.input);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/usk/onair') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setUpstreamKeyerOnAir(Number(body.me) || 0, Number(body.keyer) || 0, !!body.onAir);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/usk/tie') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setUpstreamKeyerTie(Number(body.me) || 0, Number(body.keyer) || 0, !!body.tie);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/usk/type') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setUpstreamKeyerType(Number(body.me) || 0, Number(body.keyer) || 0, body.type);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/usk/sources') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setUpstreamKeyerSources(
        Number(body.me) || 0,
        Number(body.keyer) || 0,
        body.fillSource,
        body.keySource
      );
      return this._state(res);
    }

    if (url.pathname === '/api/atem/dsk/onair') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setDownstreamKeyerOnAir(Number(body.keyer) || 0, !!body.onAir);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/dsk/tie') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setDownstreamKeyerTie(Number(body.keyer) || 0, !!body.tie);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/dsk/rate') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setDownstreamKeyerRate(Number(body.keyer) || 0, body.rate);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/dsk/source') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setDownstreamKeyerSource(Number(body.keyer) || 0, body.fillSource, body.keySource);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/supersource/art') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setSuperSourceArt(body || {});
      return this._state(res);
    }

    if (url.pathname === '/api/atem/supersource/box') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setSuperSourceBox(body.box, body || {});
      return this._state(res);
    }

    if (url.pathname === '/api/atem/color') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setColorGenerator(body.index, body.hue, body.saturation, body.luma);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/macro/run') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.runMacro(body.index);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/macro/stop') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.stopMacro();
      return this._state(res);
    }

    if (url.pathname === '/api/atem/media/source') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setMediaPlayerSource(body.player, body.sourceType, body.sourceIndex);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/media/play') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setMediaPlayerPlaying(body.player, body.playing);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/label') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setInputSettings(body.input, { longName: body.longName, shortName: body.shortName });
      return this._state(res);
    }

    if (url.pathname === '/api/atem/ptz/preset') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setCameraControlPreset(body.camera, body.preset);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/ptz/pantilt') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setCameraControlPanTilt(body.camera, body.pan, body.tilt);
      return this._state(res);
    }

    if (url.pathname === '/api/atem/ptz/zoom') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setCameraControlZoom(body.camera, body.zoom);
      return this._state(res);
    }

    if (url.pathname === '/api/recording') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setRecordingAction({ action: body.recording ? 1 : 0 });
      return this._state(res);
    }

    if (url.pathname === '/api/fade-to-black') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setFadeToBlack(!!body.enabled);
      return this._state(res);
    }

    if (url.pathname === '/api/audio/master') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setMasterAudioLevels(body.left, body.right, body.holdMs);
      return this._state(res);
    }

    if (url.pathname === '/api/audio/delay') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      await this.fakeAtem.setAudioDelay(body.input, body.delay);
      return this._state(res);
    }

    if (url.pathname === '/api/hyperdeck/action') {
      this._need(this.fakeAtem, 'Fake ATEM unavailable');
      const idx = Number(body.index) || 0;
      const action = String(body.action || '').toLowerCase();
      if (action === 'play') await this.fakeAtem.setHyperDeckPlay(idx);
      else if (action === 'stop') await this.fakeAtem.setHyperDeckStop(idx);
      else if (action === 'record') await this.fakeAtem.setHyperDeckRecord(idx);
      else if (action === 'next') await this.fakeAtem.setHyperDeckNextClip(idx);
      else if (action === 'prev') await this.fakeAtem.setHyperDeckPrevClip(idx);
      else return this._json(res, 400, { error: 'invalid hyperdeck action' });
      return this._state(res);
    }

    if (url.pathname === '/api/obs/stream') {
      this._need(this.fakeObs, 'Fake OBS unavailable');
      this.fakeObs.setStreamActive(!!body.active);
      return this._state(res);
    }

    if (url.pathname === '/api/obs/record') {
      this._need(this.fakeObs, 'Fake OBS unavailable');
      this.fakeObs.setRecordingActive(!!body.active);
      return this._state(res);
    }

    if (url.pathname === '/api/obs/scene') {
      this._need(this.fakeObs, 'Fake OBS unavailable');
      this.fakeObs.setScene(body.scene);
      return this._state(res);
    }

    if (url.pathname === '/api/obs/encoder') {
      this._need(this.fakeObs, 'Fake OBS unavailable');
      this.fakeObs.setEncoderHealth({
        fps: body.fps,
        cpuUsage: body.cpuUsage,
        congestion: body.congestion,
        bitrateKbps: body.bitrateKbps,
      });
      return this._state(res);
    }

    if (url.pathname === '/api/mixer/online') {
      this._need(this.fakeMixer, 'Fake mixer unavailable');
      this.fakeMixer.setOnline(!!body.online);
      return this._state(res);
    }

    if (url.pathname === '/api/mixer/master') {
      this._need(this.fakeMixer, 'Fake mixer unavailable');
      this.fakeMixer.setMainMuted(!!body.muted);
      return this._state(res);
    }

    if (url.pathname === '/api/mixer/fader') {
      this._need(this.fakeMixer, 'Fake mixer unavailable');
      this.fakeMixer.setMainFader(body.level);
      return this._state(res);
    }

    if (url.pathname === '/api/mixer/scene') {
      this._need(this.fakeMixer, 'Fake mixer unavailable');
      this.fakeMixer.setScene(body.scene);
      return this._state(res);
    }

    if (url.pathname === '/api/propresenter/running') {
      this._need(this.fakeProPresenter, 'Fake ProPresenter unavailable');
      this.fakeProPresenter.setRunning(!!body.running);
      return this._state(res);
    }

    if (url.pathname === '/api/propresenter/presentation') {
      this._need(this.fakeProPresenter, 'Fake ProPresenter unavailable');
      this.fakeProPresenter.setPresentation(body.name, body.slideTotal);
      return this._state(res);
    }

    if (url.pathname === '/api/propresenter/next') {
      this._need(this.fakeProPresenter, 'Fake ProPresenter unavailable');
      await this.fakeProPresenter.nextSlide();
      return this._state(res);
    }

    if (url.pathname === '/api/propresenter/prev') {
      this._need(this.fakeProPresenter, 'Fake ProPresenter unavailable');
      await this.fakeProPresenter.previousSlide();
      return this._state(res);
    }

    if (url.pathname === '/api/propresenter/slide') {
      this._need(this.fakeProPresenter, 'Fake ProPresenter unavailable');
      await this.fakeProPresenter.goToSlide(body.index);
      return this._state(res);
    }

    if (url.pathname === '/api/reset') {
      if (this.fakeAtem && typeof this.fakeAtem.resetState === 'function') this.fakeAtem.resetState();
      if (this.fakeObs) {
        this.fakeObs.setStreamActive(false);
        this.fakeObs.setRecordingActive(false);
        this.fakeObs.setScene('Program');
        this.fakeObs.setEncoderHealth({ fps: 30, cpuUsage: 18, congestion: 0.02, bitrateKbps: 4500 });
      }
      if (this.fakeMixer) {
        this.fakeMixer.setOnline(true);
        this.fakeMixer.setMainMuted(false);
        this.fakeMixer.setMainFader(0.78);
        this.fakeMixer.setScene(1);
      }
      if (this.fakeProPresenter) {
        this.fakeProPresenter.setRunning(true);
        this.fakeProPresenter.setPresentation('Sunday Service', 12);
        this.fakeProPresenter.setSlide(0);
      }
      return this._state(res);
    }

    return this._json(res, 404, { error: 'not found' });
  }

  _need(value, message) {
    if (!value) throw new Error(message);
  }

  async _snapshot() {
    return {
      atem: this.fakeAtem?.getSnapshot?.() || null,
      obs: this.fakeObs?.getSnapshot?.() || null,
      mixer: this.fakeMixer?.getSnapshot?.() || null,
      propresenter: this.fakeProPresenter?.getSnapshot?.() || null,
    };
  }

  async _state(res) {
    return this._json(res, 200, { ok: true, state: await this._snapshot() });
  }

  async _readJsonBody(req) {
    const raw = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk.toString('utf8');
        if (data.length > 1024 * 256) reject(new Error('payload too large'));
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('invalid json');
    }
  }

  _json(res, status, data) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify(data));
  }

  _html(res, html) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  }
}

module.exports = { FakeAtemApiServer };
