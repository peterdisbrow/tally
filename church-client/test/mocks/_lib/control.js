/**
 * Control-API helper for mock device servers.
 *
 * Each mock device exposes a small HTTP control endpoint on a separate port
 * so tests (or operators using `npm run mocks` in a dev session) can poke its
 * state without speaking the device's native protocol. Standard endpoints:
 *
 *   GET  /              → { device, port, state, actions }
 *   GET  /state         → state snapshot only
 *   POST /action        → { action: "<name>", args: { ... } } → handler return value
 *   POST /reset         → reset to initial state
 *
 * Mocks register actions like { goToProgram: ({ input }) => state.programInput = input }.
 * Handler functions receive args and a mutable `state` reference; their return
 * value (if any) is sent back as JSON.
 */

'use strict';

const http = require('node:http');

function createControlServer({ device, port = 0, state, actions = {}, initialState }) {
  const initSnapshot = JSON.parse(JSON.stringify(initialState ?? state));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const path = (req.url || '/').split('?')[0];
        if (req.method === 'GET' && path === '/') {
          res.end(JSON.stringify({
            device,
            port: server.address()?.port,
            state,
            actions: Object.keys(actions),
          }));
          return;
        }
        if (req.method === 'GET' && path === '/state') {
          res.end(JSON.stringify(state));
          return;
        }
        if (req.method === 'POST' && path === '/action') {
          const { action, args } = body ? JSON.parse(body) : {};
          const handler = actions[action];
          if (!handler) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `unknown action: ${action}` }));
            return;
          }
          const result = await handler(args || {}, state);
          res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result, state }));
          return;
        }
        if (req.method === 'POST' && path === '/reset') {
          // Replace each key in `state` with the snapshot value to keep callers'
          // references intact.
          for (const key of Object.keys(state)) delete state[key];
          for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(initSnapshot)))) {
            state[key] = value;
          }
          res.end(JSON.stringify({ reset: true, state }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { createControlServer };
