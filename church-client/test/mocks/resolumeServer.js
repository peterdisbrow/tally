/**
 * Mock Resolume Arena 7+ HTTP server (default port 8080).
 *
 * Implements the /api/v1/* endpoints that
 * church-client/src/resolume.js exercises:
 *   GET    /api/v1/product
 *   GET    /api/v1/composition                                → full composition tree
 *   GET    /api/v1/composition/tempo
 *   POST   /api/v1/composition/layers/:L/clips/:C/connect     → trigger clip
 *   DELETE /api/v1/composition/layers/:L/clips/:C/connect     → release clip
 *   POST   /api/v1/composition/disconnectall                  → blackout
 *   PUT    /api/v1/composition/layers/:L/video/opacity        → fade
 *   PUT    /api/v1/composition/layers/:L/bypassed             → mute layer
 *   PUT    /api/v1/composition/tempo/bpm                      → set tempo
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setLayer", args: { layer, name, clips: [...] } }
 *   POST /action { action: "setTempo", args: { bpm: 128 } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

function defaultComposition() {
  return {
    name: 'Sunday Service',
    columns: [
      { id: 1, name: 'Worship' },
      { id: 2, name: 'Announcements' },
      { id: 3, name: 'Sermon' },
    ],
    layers: [
      {
        id: 1, name: 'BG', opacity: { value: 1.0 }, bypassed: { value: false },
        clips: [
          { id: 1, name: 'Stars', selected: { value: false }, connected: { index: 0 } },
          { id: 2, name: 'Lyrics', selected: { value: false }, connected: { index: 0 } },
        ],
      },
      {
        id: 2, name: 'Lyrics', opacity: { value: 1.0 }, bypassed: { value: false },
        clips: [
          { id: 1, name: 'Verse 1', selected: { value: false }, connected: { index: 0 } },
        ],
      },
    ],
  };
}

const DEFAULTS = {
  productName: 'Resolume Arena',
  productVersion: '7.18.0',
  composition: defaultComposition(),
  tempo: { bpm: { value: 120.0 } },
  commandLog: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function start({ port = 8080, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/v1/product') {
      res.end(JSON.stringify({ name: state.productName, version: state.productVersion }));
      return;
    }
    if (req.method === 'GET' && path === '/api/v1/composition') {
      res.end(JSON.stringify(state.composition));
      return;
    }
    if (req.method === 'GET' && path === '/api/v1/composition/tempo') {
      res.end(JSON.stringify(state.tempo));
      return;
    }

    // POST /api/v1/composition/layers/:L/clips/:C/connect
    let m = path.match(/^\/api\/v1\/composition\/layers\/(\d+)\/clips\/(\d+)\/connect$/);
    if (m) {
      await readBody(req);
      const layerIdx = Number(m[1]) - 1;
      const clipIdx = Number(m[2]) - 1;
      const layer = state.composition.layers[layerIdx];
      if (req.method === 'POST') {
        // Disconnect all clips in this layer first, then connect target
        if (layer) {
          layer.clips.forEach((c, i) => { c.connected = { index: i === clipIdx ? 1 : 0 }; });
        }
        state.commandLog.push({ kind: 'connect', layer: layerIdx + 1, clip: clipIdx + 1, ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        if (layer && layer.clips[clipIdx]) layer.clips[clipIdx].connected = { index: 0 };
        state.commandLog.push({ kind: 'disconnect', layer: layerIdx + 1, clip: clipIdx + 1, ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    // POST /api/v1/composition/disconnectall
    if (req.method === 'POST' && path === '/api/v1/composition/disconnectall') {
      await readBody(req);
      for (const layer of state.composition.layers) {
        for (const clip of layer.clips) clip.connected = { index: 0 };
      }
      state.commandLog.push({ kind: 'disconnectall', ts: Date.now() });
      res.statusCode = 204;
      res.end();
      return;
    }

    // PUT /api/v1/composition/layers/:L/video/opacity
    m = path.match(/^\/api\/v1\/composition\/layers\/(\d+)\/video\/opacity$/);
    if (m && req.method === 'PUT') {
      const body = await readBody(req);
      const layer = state.composition.layers[Number(m[1]) - 1];
      try {
        const j = JSON.parse(body);
        if (layer) layer.opacity = { value: Number(j.value ?? 1.0) };
      } catch { /* tolerate malformed */ }
      res.statusCode = 204;
      res.end();
      return;
    }

    // PUT /api/v1/composition/layers/:L/bypassed
    m = path.match(/^\/api\/v1\/composition\/layers\/(\d+)\/bypassed$/);
    if (m && req.method === 'PUT') {
      const body = await readBody(req);
      const layer = state.composition.layers[Number(m[1]) - 1];
      try {
        const j = JSON.parse(body);
        if (layer) layer.bypassed = { value: !!j.value };
      } catch { /* tolerate */ }
      res.statusCode = 204;
      res.end();
      return;
    }

    // PUT /api/v1/composition/tempo/bpm
    if (req.method === 'PUT' && path === '/api/v1/composition/tempo/bpm') {
      const body = await readBody(req);
      try {
        const j = JSON.parse(body);
        state.tempo.bpm = { value: Number(j.value) };
      } catch { /* tolerate */ }
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found', path }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'resolume',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setLayer: ({ layer, name, clips }) => {
        const idx = layer - 1;
        if (state.composition.layers[idx]) {
          if (name !== undefined) state.composition.layers[idx].name = name;
          if (Array.isArray(clips)) state.composition.layers[idx].clips = clips;
        }
      },
      setTempo: ({ bpm }) => { state.tempo.bpm = { value: Number(bpm) }; },
    },
  });

  return {
    device: 'resolume',
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 8080, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-resolume] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
