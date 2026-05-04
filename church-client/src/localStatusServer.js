/**
 * Local status HTTP server.
 *
 * Exposes the agent's current device state on 127.0.0.1 so the Electron
 * desktop app can read it directly when the relay is unreachable. This is
 * the data source for the local fallback dashboard.
 *
 * Security: bound to loopback only, no auth, returns whatever the agent
 * already prints to stdout via [STATUS_JSON]. No secrets — the status
 * object never contains tokens, passwords, or API keys (sendStatus()
 * builds it from device-connection state and counters).
 */

const http = require('http');

const LOOPBACK = '127.0.0.1';

/**
 * Start a localhost HTTP server that serves the agent status snapshot.
 *
 * @param {object} opts
 * @param {() => object} opts.getStatus  Callback returning the current status object.
 * @param {number} [opts.port=0]         Port to bind. 0 = OS-assigned.
 * @returns {Promise<{server: http.Server, port: number, stop: () => Promise<void>}>}
 */
function startLocalStatusServer({ getStatus, port = 0 }) {
  if (typeof getStatus !== 'function') {
    throw new TypeError('startLocalStatusServer: getStatus must be a function');
  }

  const server = http.createServer((req, res) => {
    // Reject anything but GET / and GET /local-status
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/local-status') {
      let body;
      try {
        body = JSON.stringify({
          ok: true,
          generatedAt: new Date().toISOString(),
          status: getStatus() || {},
        });
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'serialization_failed', message: err.message }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  // Reject any non-loopback connection that somehow slips past the bind.
  server.on('connection', (socket) => {
    if (socket.remoteAddress && socket.remoteAddress !== '127.0.0.1' && socket.remoteAddress !== '::1' && socket.remoteAddress !== '::ffff:127.0.0.1') {
      socket.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      const actualPort = server.address().port;
      server.removeListener('error', reject);
      const stop = () =>
        new Promise((r) => {
          server.close(() => r());
        });
      resolve({ server, port: actualPort, stop });
    });
  });
}

module.exports = { startLocalStatusServer };
