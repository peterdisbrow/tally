/**
 * Mock Bitfocus Companion 4.x HTTP server.
 *
 * Implements the subset of /api/* endpoints that church-client/src/companion.js
 * exercises:
 *   - GET  /api/location/:p/:r/:c              → button state
 *   - POST /api/location/:p/:r/:c/press        → press button (logs + emits)
 *   - GET  /api/connections                    → list of configured modules
 *   - GET  /api/:conn/:var/value               → module variable value
 *   - GET  /api/custom-variable/:name/value    → custom variable
 *   - POST /api/custom-variable/:name/value    → set custom variable
 *
 * Default state: 1 page, 4×8 grid, 1 dummy connection ("atem"). Tests can
 * override via the control API (see _lib/control.js):
 *   POST /action { action: "setButton", args: { page, row, col, text, color } }
 *   POST /action { action: "setVariable", args: { connection, name, value } }
 *   POST /action { action: "setConnections", args: [ { id, label, moduleId } ] }
 *   POST /action { action: "simulatePress", args: { page, row, col } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  buttons: {}, // key "p/r/c" → { text, bgcolor, pressed }
  customVariables: {}, // name → string
  connections: [
    { id: 'atem', label: 'atem', moduleId: 'bmd-atem', enabled: true, status: 'ok' },
  ],
  variables: {}, // "connection:variable" → string
  pressLog: [], // last N { page, row, col, ts }
};

function parseLocation(url, prefix = '/api/location/') {
  const tail = url.slice(prefix.length).split('?')[0];
  const parts = tail.split('/');
  return { page: Number(parts[0]), row: Number(parts[1]), col: Number(parts[2]), action: parts[3] || null };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function start({ port = 8000, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = req.url || '/';

    // GET /api/connections
    if (req.method === 'GET' && url.startsWith('/api/connections')) {
      res.end(JSON.stringify(state.connections));
      return;
    }

    // POST /api/location/:p/:r/:c/press
    if (req.method === 'POST' && /^\/api\/location\/\d+\/\d+\/\d+\/press/.test(url)) {
      const { page, row, col } = parseLocation(url);
      const key = `${page}/${row}/${col}`;
      const btn = state.buttons[key] || (state.buttons[key] = { text: '', bgcolor: null, pressed: false });
      btn.pressed = true;
      state.pressLog.push({ page, row, col, ts: Date.now() });
      // Auto-release after 100ms so polling tests see the transition.
      setTimeout(() => { btn.pressed = false; }, 100);
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/location/:p/:r/:c
    if (req.method === 'GET' && /^\/api\/location\/\d+\/\d+\/\d+/.test(url)) {
      const { page, row, col } = parseLocation(url);
      const key = `${page}/${row}/${col}`;
      const btn = state.buttons[key] || { text: '', bgcolor: null, pressed: false };
      res.end(JSON.stringify(btn));
      return;
    }

    // POST /api/custom-variable/:name/value
    if (req.method === 'POST' && /^\/api\/custom-variable\/[^/]+\/value/.test(url)) {
      const name = decodeURIComponent(url.split('/')[3]);
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body);
        state.customVariables[name] = String(parsed.value ?? '');
      } catch {
        state.customVariables[name] = body;
      }
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/custom-variable/:name/value
    if (req.method === 'GET' && /^\/api\/custom-variable\/[^/]+\/value/.test(url)) {
      const name = decodeURIComponent(url.split('/')[3]);
      const value = state.customVariables[name];
      if (value === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify(null));
        return;
      }
      res.end(JSON.stringify(value));
      return;
    }

    // GET /api/:connection/:variable/value (must come AFTER more specific routes)
    if (req.method === 'GET' && /^\/api\/[^/]+\/[^/]+\/value/.test(url)) {
      const parts = url.split('/');
      const conn = decodeURIComponent(parts[2]);
      const varName = decodeURIComponent(parts[3]);
      const value = state.variables[`${conn}:${varName}`];
      if (value === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify(null));
        return;
      }
      res.end(JSON.stringify(value));
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
    device: 'companion',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setButton: ({ page, row, col, text = '', color = null, pressed = false }) => {
        state.buttons[`${page}/${row}/${col}`] = { text, bgcolor: color, pressed };
      },
      setVariable: ({ connection, name, value }) => {
        state.variables[`${connection}:${name}`] = String(value);
      },
      setConnections: (conns) => {
        if (Array.isArray(conns)) state.connections = conns;
      },
      simulatePress: ({ page, row, col }) => {
        const key = `${page}/${row}/${col}`;
        const btn = state.buttons[key] || (state.buttons[key] = { text: '', bgcolor: null, pressed: false });
        btn.pressed = true;
        state.pressLog.push({ page, row, col, ts: Date.now() });
        setTimeout(() => { btn.pressed = false; }, 100);
      },
    },
  });

  return {
    device: 'companion',
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
  start({ port: Number(process.env.PORT) || 8000, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-companion] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
