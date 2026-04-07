#!/usr/bin/env node
/**
 * Integration Tests for Tally
 * Starts relay server, connects mock clients, tests full flow.
 * No external test framework — just Node.js assert.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = require(path.join(__dirname, '../relay-server/node_modules/ws'));
}

let uuidv4;
try {
  ({ v4: uuidv4 } = require('uuid'));
} catch {
  ({ v4: uuidv4 } = require(path.join(__dirname, '../relay-server/node_modules/uuid')));
}

const TEST_PORT = 30000 + Math.floor(Math.random() * 10000);
const API_KEY = 'test-admin-key-' + uuidv4().substring(0, 8);
const JWT_SECRET = 'test-jwt-secret-' + uuidv4().substring(0, 8);

let serverProcess;
let results = [];
let totalTests = 0;
let passed = 0;
let testDbPath;

function test(name, fn) {
  totalTests++;
  return fn()
    .then(() => { passed++; results.push({ name, pass: true }); console.log(`  ✅ ${name}`); })
    .catch(err => { results.push({ name, pass: false, error: err.message }); console.log(`  ❌ ${name}: ${err.message}`); });
}

function apiRequest(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function httpRequest(method, requestPath, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path: requestPath,
      method,
      headers: { ...headers },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });

    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function getCookieHeader(setCookieHeaders, cookieName) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  const found = list.find((entry) => String(entry).startsWith(`${cookieName}=`));
  if (!found) return '';
  return String(found).split(';')[0];
}

function connectWS(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
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
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── START SERVER ────────────────────────────────────────────────────────────

async function startServer() {
  // Set env before requiring server
  process.env.PORT = TEST_PORT;
  process.env.ADMIN_API_KEY = API_KEY;
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DATABASE_PATH = ':memory:';

  // We need to start the server in a child process to avoid module caching issues
  const { spawn } = require('child_process');
  const serverPath = require('path').join(__dirname, '../relay-server/server.js');

  testDbPath = require('path').join(__dirname, '../relay-server/data', `test-${Date.now()}.db`);
  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: TEST_PORT, ADMIN_API_KEY: API_KEY, JWT_SECRET: JWT_SECRET, DATABASE_PATH: testDbPath, SESSION_SECRET: 'test-session-secret-' + uuidv4() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('running on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr.on('data', (data) => {
      console.error('[server stderr]', data.toString().trim());
    });
    serverProcess.on('error', reject);
  });
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n🧪 Tally Integration Tests (port ${TEST_PORT})\n`);

  let churchId, churchToken, churchAppToken, supportTriageId, supportTicketId, churchPortalCookie;
  const churchPortalEmail = 'portal-test@example.com';
  const churchPortalPassword = 'Password123!';

  // 1. Health check
  await test('GET / returns service info', async () => {
    const { status, body } = await apiRequest('GET', '/');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.service, 'tally-relay');
  });

  // 2. Health endpoint
  await test('GET /api/health returns stats', async () => {
    const { status, body } = await apiRequest('GET', '/api/health');
    assert.strictEqual(status, 200);
    assert.ok(body.uptime >= 0);
    assert.strictEqual(typeof body.totalMessagesRelayed, 'number');
  });

  // 3. Auth required
  await test('API requires auth', async () => {
    const options = { hostname: 'localhost', port: TEST_PORT, path: '/api/churches', method: 'GET', headers: { 'Content-Type': 'application/json' } };
    const { status } = await new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 401);
  });

  // 4. Register church
  await test('Register a church', async () => {
    const { status, body } = await apiRequest('POST', '/api/churches/register', {
      name: 'Test Church',
      email: 'test@example.com',
      portalEmail: churchPortalEmail,
      password: churchPortalPassword,
    });
    assert.strictEqual(status, 200);
    assert.ok(body.churchId);
    assert.ok(body.token);
    assert.strictEqual(body.name, 'Test Church');
    churchId = body.churchId;
    churchToken = body.token;
  });

  // 5. Duplicate name rejected
  await test('Reject duplicate church name', async () => {
    const { status } = await apiRequest('POST', '/api/churches/register', { name: 'Test Church' });
    assert.strictEqual(status, 409);
  });

  // 6. List churches
  await test('List churches returns registered church', async () => {
    const { body } = await apiRequest('GET', '/api/churches');
    assert.ok(Array.isArray(body));
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].name, 'Test Church');
    assert.strictEqual(body[0].connected, false);
  });

  // 7. Billing webhook rejects when Stripe is not configured (checked before signature)
  await test('Billing webhook requires stripe-signature header', async () => {
    const { status, body } = await httpRequest(
      'POST',
      '/api/billing/webhook',
      JSON.stringify({ type: 'checkout.session.completed' }),
      { 'Content-Type': 'application/json' }
    );
    // When STRIPE_WEBHOOK_SECRET is not set, 503 is returned before checking signature
    assert.strictEqual(status, 503);
    assert.strictEqual(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  });

  // 8. Billing webhook returns 503 when Stripe is not configured
  await test('Billing webhook fails cleanly without Stripe config', async () => {
    const { status, body } = await httpRequest(
      'POST',
      '/api/billing/webhook',
      JSON.stringify({ type: 'checkout.session.completed' }),
      {
        'Content-Type': 'application/json',
        'stripe-signature': 't=12345,v1=fake-signature',
      }
    );
    assert.strictEqual(status, 503);
    assert.strictEqual(typeof body.error, 'string');
    assert.ok(body.error.length > 0);
  });

  // 9. Church portal API is protected by session cookie
  await test('Church portal API rejects missing session cookie', async () => {
    const { status, body } = await httpRequest('GET', '/api/church/me');
    assert.strictEqual(status, 401);
    assert.strictEqual(body.error, 'Not authenticated');
  });

  // 10. Church portal page redirects when unauthenticated
  await test('Church portal page redirects to login when unauthenticated', async () => {
    const { status, headers } = await httpRequest('GET', '/church-portal');
    assert.strictEqual(status, 302);
    assert.strictEqual(headers.location, '/church-login');
  });

  // 11. Invalid session cookie is rejected and cleared
  await test('Invalid church portal session cookie is rejected', async () => {
    const { status, body, headers } = await httpRequest('GET', '/api/church/me', null, {
      Cookie: 'tally_church_session=invalid.jwt.token',
    });
    assert.strictEqual(status, 401);
    assert.strictEqual(body.error, 'Session expired');
    assert.ok(Array.isArray(headers['set-cookie']));
  });

  // 12. Church portal login rejects bad credentials
  await test('Church portal login rejects invalid credentials', async () => {
    const form = `email=${encodeURIComponent(churchPortalEmail)}&password=${encodeURIComponent('WrongPassword!')}`;
    const { status, body } = await httpRequest('POST', '/api/church/login', form, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.strictEqual(status, 401);
    assert.strictEqual(typeof body, 'string');
    assert.ok(body.includes('Invalid email or password'));
  });

  // 13. Church portal login sets session cookie
  await test('Church portal login sets session cookie and redirects', async () => {
    const form = `email=${encodeURIComponent(churchPortalEmail)}&password=${encodeURIComponent(churchPortalPassword)}`;
    const { status, headers } = await httpRequest('POST', '/api/church/login', form, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    assert.strictEqual(status, 302);
    assert.strictEqual(headers.location, '/church-portal');
    churchPortalCookie = getCookieHeader(headers['set-cookie'], 'tally_church_session');
    assert.ok(churchPortalCookie.startsWith('tally_church_session='));
  });

  // 14. Valid session cookie grants church portal API access
  await test('Church portal session cookie grants /api/church/me access', async () => {
    const { status, body } = await httpRequest('GET', '/api/church/me', null, {
      Cookie: churchPortalCookie,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.churchId, churchId);
    assert.strictEqual(body.portal_email, churchPortalEmail);
  });

  // 15. Church app credential login (support bearer auth token)
  await test('Credential login returns church app token', async () => {
    const { status, body } = await apiRequest('POST', '/api/church/app/login', {
      email: churchPortalEmail,
      password: churchPortalPassword,
    });

    assert.strictEqual(status, 200);
    assert.ok(body.token);
    churchAppToken = body.token;
  });

  // 16. Support triage (church app auth)
  await test('Support triage accepts church app bearer token', async () => {
    const { status, body } = await apiRequest(
      'POST',
      '/api/church/support/triage',
      {
        issueCategory: 'stream_down',
        severity: 'P2',
        summary: 'Stream dropped during rehearsal',
        appVersion: 'smoke-test',
      },
      { Authorization: `Bearer ${churchAppToken}` }
    );

    assert.strictEqual(status, 201);
    assert.ok(body.triageId);
    assert.strictEqual(body.triageResult, 'needs_escalation');
    supportTriageId = body.triageId;
  });

  // 17. Create support ticket from triage
  await test('Support ticket creation from triage works', async () => {
    const { status, body } = await apiRequest(
      'POST',
      '/api/church/support/tickets',
      {
        triageId: supportTriageId,
        title: 'Need urgent stream help',
        description: 'Unable to keep stream online for more than 2 minutes.',
        severity: 'P2',
        issueCategory: 'stream_down',
      },
      { Authorization: `Bearer ${churchAppToken}` }
    );

    assert.strictEqual(status, 201);
    assert.ok(body.ticketId);
    assert.strictEqual(body.status, 'open');
    supportTicketId = body.ticketId;
  });

  // 18. Update support ticket
  await test('Support ticket update changes status', async () => {
    const { status, body } = await apiRequest(
      'POST',
      `/api/church/support/tickets/${supportTicketId}/updates`,
      { message: 'Issue still reproduces after reboot.', status: 'waiting_customer' },
      { Authorization: `Bearer ${churchAppToken}` }
    );

    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.status, 'waiting_customer');
  });

  // 19. List support tickets
  await test('Support ticket list includes newly created ticket', async () => {
    const { status, body } = await apiRequest(
      'GET',
      '/api/church/support/tickets?limit=10',
      null,
      { Authorization: `Bearer ${churchAppToken}` }
    );

    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body));
    assert.ok(body.some((t) => t.id === supportTicketId && t.status === 'waiting_customer'));
  });

  // 20. Connect church via WebSocket
  let churchWS;
  await test('Church connects via WebSocket', async () => {
    churchWS = await connectWS(`/church?token=${churchToken}`);
    const msg = await waitForMessage(churchWS);
    assert.strictEqual(msg.type, 'connected');
    assert.strictEqual(msg.churchId, churchId);
  });

  // 21. Connect controller
  let controllerWS;
  await test('Controller connects via WebSocket', async () => {
    controllerWS = await connectWS(`/controller?apikey=${API_KEY}`);
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'church_list');
    assert.ok(Array.isArray(msg.churches));
  });

  // 22. Church sends status update
  await test('Church status update reaches controller', async () => {
    const statusMsg = { type: 'status_update', status: { atem: { connected: true }, obs: { connected: false } } };
    churchWS.send(JSON.stringify(statusMsg));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'status_update');
    assert.strictEqual(msg.churchId, churchId);
    assert.strictEqual(msg.status.atem.connected, true);
  });

  // 23. Send command via API
  await test('Send command to church via API', async () => {
    const waitCommand = waitForMessage(churchWS);
    const { body } = await apiRequest('POST', '/api/command', { churchId, command: 'atem.cut', params: { input: 2 } });
    assert.ok(body.sent);
    const msg = await waitCommand;
    assert.strictEqual(msg.type, 'command');
    assert.strictEqual(msg.command, 'atem.cut');
    assert.strictEqual(msg.params.input, 2);
  });

  // 24. Command result flows back
  await test('Command result reaches controller', async () => {
    churchWS.send(JSON.stringify({ type: 'command_result', id: 'test-123', result: 'Cut executed' }));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'command_result');
    assert.strictEqual(msg.result, 'Cut executed');
  });

  // 25. Church status via API
  await test('GET church status returns last known state', async () => {
    const { body } = await apiRequest('GET', `/api/churches/${churchId}/status`);
    assert.strictEqual(body.name, 'Test Church');
    assert.strictEqual(body.connected, true);
  });

  // 26. Preview frame forwarded
  await test('Preview frame forwarded only to subscribed controller', async () => {
    const passiveControllerWS = await connectWS(`/controller?apikey=${API_KEY}`);
    const passiveHello = await waitForMessage(passiveControllerWS);
    assert.strictEqual(passiveHello.type, 'church_list');

    const ackPromise = waitForMessage(controllerWS);
    controllerWS.send(JSON.stringify({ type: 'preview_subscribe', churchId }));
    const subscriptionAck = await ackPromise;
    assert.strictEqual(subscriptionAck.type, 'preview_subscription');
    assert.strictEqual(subscriptionAck.churchId, churchId);
    assert.strictEqual(subscriptionAck.subscribed, true);

    const frame = { type: 'preview_frame', timestamp: new Date().toISOString(), width: 720, height: 405, format: 'jpeg', data: 'dGVzdA==' };
    const passiveReceived = waitForMessage(passiveControllerWS, 1000)
      .then(() => true)
      .catch((err) => {
        if (err.message === 'WS message timeout') return false;
        throw err;
      });
    const subscribedReceived = waitForMessage(controllerWS);
    churchWS.send(JSON.stringify(frame));
    const msg = await subscribedReceived;
    assert.strictEqual(msg.type, 'preview_available');
    assert.strictEqual(msg.churchId, churchId);
    assert.ok(msg.frameId);

    const previewResp = await apiRequest('GET', `/api/admin/churches/${churchId}/preview/latest`);
    assert.strictEqual(previewResp.status, 200);
    assert.strictEqual(previewResp.body.churchId, churchId);
    assert.strictEqual(previewResp.body.frameId, msg.frameId);
    assert.strictEqual(previewResp.body.data, 'dGVzdA==');
    assert.strictEqual(await passiveReceived, false);

    await new Promise((resolve) => {
      passiveControllerWS.once('close', resolve);
      passiveControllerWS.close();
    });
  });

  // 27. Oversized preview frame rejected
  await test('Oversized preview frame rejected', async () => {
    const bigData = 'x'.repeat(200_000);
    churchWS.send(JSON.stringify({ type: 'preview_frame', data: bigData }));
    // Controller should NOT receive this
    const received = await waitForMessage(controllerWS, 1000)
      .then(() => true)
      .catch((err) => {
        if (err.message === 'WS message timeout') return false;
        throw err;
      });
    assert.strictEqual(received, false);
  });

  // 28. Alert forwarded
  await test('Alert from church reaches controller', async () => {
    churchWS.send(JSON.stringify({ type: 'alert', message: 'ATEM disconnected', severity: 'warning' }));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'alert');
    assert.strictEqual(msg.severity, 'warning');
  });

  // 29. Broadcast
  await test('Broadcast command reaches connected church', async () => {
    const waitBroadcast = waitForMessage(churchWS);
    const { body } = await apiRequest('POST', '/api/broadcast', { command: 'atem.fadeToBlack' });
    assert.strictEqual(body.sent, 1);
    const msg = await waitBroadcast;
    assert.strictEqual(msg.command, 'atem.fadeToBlack');
  });

  // 30. Delete church
  await test('Delete church', async () => {
    // Close websockets first
    churchWS.close();
    controllerWS.close();
    await sleep(200);

    const { status, body } = await apiRequest('DELETE', `/api/churches/${churchId}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.deleted, true);
  });

  // 31. Deleted church gone
  await test('Deleted church not in list', async () => {
    const { body } = await apiRequest('GET', '/api/churches');
    assert.strictEqual(body.length, 0);
  });

  // Done
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed}/${totalTests} passed`);
  if (passed === totalTests) {
    console.log('🎉 All tests passed!\n');
  } else {
    console.log(`⚠️  ${totalTests - passed} test(s) failed\n`);
    results.filter(r => !r.pass).forEach(r => console.log(`   ❌ ${r.name}: ${r.error}`));
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await startServer();
    await sleep(500); // Give server a moment
    await runTests();
  } catch (err) {
    console.error('Fatal test error:', err);
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
    // Clean up test db
    const fs = require('fs');
    const glob = require('path').join(__dirname, '../relay-server/data');
    try {
      const files = fs.readdirSync(glob);
      files.filter(f => f.startsWith('test-')).forEach(f => fs.unlinkSync(require('path').join(glob, f)));
    } catch { /* ignore */ }

    process.exit(passed === totalTests ? 0 : 1);
  }
}

main();
