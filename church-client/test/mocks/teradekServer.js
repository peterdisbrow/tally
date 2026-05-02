/**
 * Mock Teradek VidiU HTTP server (default port 8082 in mocks — real Teradek
 * VidiUs ship on port 80 which requires root; tests can override via
 * `port: 0` for an ephemeral port).
 *
 * Implements the cgi-bin surface that
 * church-client/src/encoders/teradek.js exercises:
 *   POST /cgi-bin/api.cgi    body=command=login&user=admin&passwd=... → set session cookie
 *   GET  /cgi-bin/json.cgi?command=geti&q=System.Info.Product → identity
 *   GET  /cgi-bin/json.cgi?command=geti&q=Codec.Status        → bitrate
 *   GET  /cgi-bin/system.cgi?command=status                   → broadcast/record state
 *   GET  /cgi-bin/system.cgi?command=broadcast&action=start|stop
 *   GET  /cgi-bin/system.cgi?command=recording&action=start|stop
 *
 * Auth: any password is accepted (default real password is 'admin'). Without
 * a session cookie the protected endpoints return "##Access denied#" plain
 * text, matching real-firmware behavior, so the church-client's
 * retry-after-login flow exercises the right code path.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setBroadcastState", args: { state: "Live" | "Ready" } }
 *   POST /action { action: "setRecording", args: { recording: true } }
 *   POST /action { action: "setBitrate", args: { kbps: 4500 } }
 *   POST /action { action: "setBattery", args: { percent: 75 } }
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  productName: 'VidiU Pro',
  serial: 'MOCK-T-0001',
  firmware: '6.7.0',
  broadcastState: 'Ready',
  broadcastError: 'none',
  recording: false,
  bitrateBps: 0,
  videoInput: 'HDMI:Connected',
  batteryPercent: 100,
  charging: '1',
  loginLog: [],
  commandLog: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function start({ port = 8082, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));
  const sessions = new Set();

  function isAuthed(req) {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/serenity-session=([^;]+)/);
    return m && sessions.has(m[1]);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;

    // Login
    if (req.method === 'POST' && path === '/cgi-bin/api.cgi') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      if (params.get('command') === 'login') {
        const sessionId = crypto.randomBytes(16).toString('hex');
        sessions.add(sessionId);
        state.loginLog.push({ user: params.get('user'), ts: Date.now() });
        res.setHeader('Set-Cookie', `serenity-session=${sessionId}; Path=/`);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'unknown command' }));
      return;
    }

    // All cgi-bin GET endpoints require auth — return ##Access denied# plain text otherwise
    if (req.method === 'GET' && path.startsWith('/cgi-bin/')) {
      if (!isAuthed(req)) {
        res.setHeader('Content-Type', 'text/plain');
        res.end('##Access denied#');
        return;
      }

      // /cgi-bin/system.cgi?command=...
      if (path === '/cgi-bin/system.cgi') {
        const command = url.searchParams.get('command');
        const action = url.searchParams.get('action');

        if (command === 'status') {
          res.end(JSON.stringify({
            status: {
              'Broadcast-State': state.broadcastState,
              'Broadcast-Error': state.broadcastError,
              'Record-Status': state.recording ? '1:00:00:00' : '0:00:00:00',
              'System-Power': `mains:${state.batteryPercent}:unknown:${state.charging}`,
              'Video-Input': state.videoInput,
            },
          }));
          return;
        }
        if (command === 'broadcast') {
          if (action === 'start') state.broadcastState = 'Live';
          if (action === 'stop') state.broadcastState = 'Ready';
          state.commandLog.push({ command, action, ts: Date.now() });
          res.end(JSON.stringify({ ok: true, state: state.broadcastState }));
          return;
        }
        if (command === 'recording') {
          if (action === 'start') state.recording = true;
          if (action === 'stop') state.recording = false;
          state.commandLog.push({ command, action, ts: Date.now() });
          res.end(JSON.stringify({ ok: true, recording: state.recording }));
          return;
        }
      }

      // /cgi-bin/json.cgi?command=geti&q=...
      if (path === '/cgi-bin/json.cgi') {
        const q = url.searchParams.get('q');
        if (q === 'System.Info.Product') {
          res.end(JSON.stringify({
            'System.Info.Product.productname': state.productName,
            'System.Info.Product.serialnumber': state.serial,
            'System.Info.Product.productversion': state.firmware,
          }));
          return;
        }
        if (q === 'Codec.Status') {
          res.end(JSON.stringify({
            'Codec.Status.stream1': JSON.stringify({
              encoder: { current_bitrate: state.bitrateBps },
            }),
          }));
          return;
        }
        res.end(JSON.stringify({}));
        return;
      }
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
    device: 'teradek',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setBroadcastState: ({ state: s }) => { state.broadcastState = s; },
      setBroadcastError: ({ error }) => { state.broadcastError = error || 'none'; },
      setRecording: ({ recording }) => { state.recording = !!recording; },
      setBitrate: ({ kbps }) => { state.bitrateBps = Number(kbps) * 1000; },
      setBattery: ({ percent, charging }) => {
        if (percent !== undefined) state.batteryPercent = Number(percent);
        if (charging !== undefined) state.charging = charging ? '1' : '0';
      },
    },
  });

  return {
    device: 'teradek',
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
  start({ port: Number(process.env.PORT) || 8082, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-teradek] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
