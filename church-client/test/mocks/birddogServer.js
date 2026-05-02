/**
 * Mock BirdDog HTTP server (default port 8081 in mocks — real BirdDogs ship
 * on port 8080, but Resolume's mock takes that port in the launcher to avoid
 * collisions; tests can override with `port: 0` to bind a random port).
 *
 * Implements the identity probe surface that
 * church-client/src/encoders/birddog.js exercises:
 *   GET /about           → JSON or KV with model + firmware
 *   GET /version         → fallback identity endpoint
 *   GET /List            → fallback identity endpoint
 *   GET /decodestatus?ChNum=N → live decode status for the configured channel
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setIdentity", args: { model, firmware } }
 *   POST /action { action: "setDecodeStatus", args: { chNum, status } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  model: 'BirdDog Studio',
  firmware: '4.2.7',
  decodeChannels: {
    1: { source: 'OBS-PC (Tally)', signal: 'OK', resolution: '1920x1080', fps: 30 },
  },
};

async function start({ port = 8081, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/about' || path === '/version')) {
      res.end(JSON.stringify({
        Manufacturer: 'BirdDog',
        ModelName: state.model,
        FirmwareVersion: state.firmware,
        FW: state.firmware,
        SerialNumber: 'MOCK-0001',
      }));
      return;
    }

    if (req.method === 'GET' && path === '/List') {
      // Some firmwares return a plain-text or KV format
      res.setHeader('Content-Type', 'text/plain');
      res.end(`birddog_model=${state.model}\nfw=${state.firmware}\nsn=MOCK-0001`);
      return;
    }

    if (req.method === 'GET' && path === '/decodestatus') {
      const ch = url.searchParams.get('ChNum') || '1';
      const status = state.decodeChannels[ch] || { source: '', signal: 'No Signal' };
      res.end(JSON.stringify(status));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'birddog',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setIdentity: ({ model, firmware }) => {
        if (model !== undefined) state.model = model;
        if (firmware !== undefined) state.firmware = firmware;
      },
      setDecodeStatus: ({ chNum = 1, status }) => {
        state.decodeChannels[chNum] = { ...(state.decodeChannels[chNum] || {}), ...(status || {}) };
      },
    },
  });

  return {
    device: 'birddog',
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
  start({ port: Number(process.env.PORT) || 8081, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-birddog] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
