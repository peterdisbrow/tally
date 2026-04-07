'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

let uuidv4;
try {
  ({ v4: uuidv4 } = require('uuid'));
} catch {
  ({ v4: uuidv4 } = require(path.join(__dirname, '../relay-server/node_modules/uuid')));
}

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require(path.join(__dirname, '../relay-server/node_modules/ws'));
}

const TEST_PORT = 34000 + Math.floor(Math.random() * 1000);
const API_KEY = `test-admin-key-${uuidv4().slice(0, 8)}`;
const JWT_SECRET = `test-jwt-secret-${uuidv4().slice(0, 8)}`;
const SESSION_SECRET = `test-session-secret-${uuidv4().slice(0, 8)}`;
const TEST_DB_PATH = path.join(__dirname, '../relay-server/data', `preview-routing-${Date.now()}.db`);

let serverProcess = null;

function apiRequest(method, requestPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: requestPath,
      method,
      headers: {
        'x-api-key': API_KEY,
        'content-type': 'application/json',
        ...extraHeaders,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function connectWS(route) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${route}`);
    const queue = { pending: [], waiters: [] };
    ws._queue = queue;
    ws.on('message', (data) => {
      if (queue.waiters.length > 0) {
        queue.waiters.shift()(data);
      } else {
        queue.pending.push(data);
      }
    });
    const timer = setTimeout(() => reject(new Error('WS connect timeout')), 5000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, timeoutMs = 5000) {
  const queue = ws._queue;
  if (queue?.pending.length > 0) {
    return Promise.resolve(JSON.parse(queue.pending.shift().toString()));
  }
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    };
    const timer = setTimeout(() => {
      if (queue) {
        const idx = queue.waiters.indexOf(onMessage);
        if (idx !== -1) queue.waiters.splice(idx, 1);
      } else {
        ws.off('message', onMessage);
      }
      reject(new Error('WS message timeout'));
    }, timeoutMs);
    if (queue) {
      queue.waiters.push(onMessage);
    } else {
      ws.once('message', onMessage);
    }
  });
}

async function startServer() {
  const serverPath = path.join(__dirname, '../relay-server/server.js');
  serverProcess = spawn('node', [serverPath], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      ADMIN_API_KEY: API_KEY,
      JWT_SECRET,
      SESSION_SECRET,
      DATABASE_PATH: TEST_DB_PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) process.stderr.write(`[preview-routing server] ${line}\n`);
    });
    serverProcess.once('error', reject);
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

async function stopServer() {
  if (!serverProcess) return;
  const child = serverProcess;
  serverProcess = null;
  await new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

test.before(async () => {
  await startServer();
});

test.after(async () => {
  await stopServer();
});

test('preview frames only go to subscribed controllers', async () => {
  const { status, body } = await apiRequest('POST', '/api/churches/register', {
    name: 'Preview Test Church',
    email: 'preview-test@example.com',
    portalEmail: 'preview-portal@example.com',
    password: 'Password123!',
  });

  assert.equal(status, 200);
  assert.ok(body.churchId);
  assert.ok(body.token);

  const churchId = body.churchId;
  const churchWS = await connectWS(`/church?token=${body.token}`);
  const subscribedControllerWS = await connectWS(`/controller?apikey=${API_KEY}`);
  const passiveControllerWS = await connectWS(`/controller?apikey=${API_KEY}`);

  await waitForMessage(churchWS);
  await waitForMessage(subscribedControllerWS);
  await waitForMessage(passiveControllerWS);

  const ackPromise = waitForMessage(subscribedControllerWS);
  subscribedControllerWS.send(JSON.stringify({ type: 'preview_subscribe', churchId }));
  const subscriptionAck = await ackPromise;
  assert.equal(subscriptionAck.type, 'preview_subscription');
  assert.equal(subscriptionAck.churchId, churchId);
  assert.equal(subscriptionAck.subscribed, true);

  const framePromise = waitForMessage(subscribedControllerWS);
  const passiveTimeout = waitForMessage(passiveControllerWS, 750);
  churchWS.send(JSON.stringify({
    type: 'preview_frame',
    timestamp: new Date().toISOString(),
    width: 720,
    height: 405,
    format: 'jpeg',
    data: 'dGVzdA==',
  }));

  const frame = await framePromise;
  assert.equal(frame.type, 'preview_available');
  assert.equal(frame.churchId, churchId);
  assert.ok(frame.frameId);

  const previewResp = await apiRequest('GET', `/api/admin/churches/${churchId}/preview/latest`);
  assert.equal(previewResp.status, 200);
  assert.equal(previewResp.body.churchId, churchId);
  assert.equal(previewResp.body.frameId, frame.frameId);
  assert.equal(previewResp.body.data, 'dGVzdA==');

  await assert.rejects(passiveTimeout, /WS message timeout/);

  churchWS.close();
  subscribedControllerWS.close();
  passiveControllerWS.close();
});
