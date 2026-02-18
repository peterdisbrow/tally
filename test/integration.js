#!/usr/bin/env node
/**
 * Integration Tests for Church AV Connect
 * Starts relay server, connects mock clients, tests full flow.
 * No external test framework — just Node.js assert.
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const TEST_PORT = 30000 + Math.floor(Math.random() * 10000);
const API_KEY = 'test-admin-key-' + uuidv4().substring(0, 8);
const JWT_SECRET = 'test-jwt-secret-' + uuidv4().substring(0, 8);

let serverProcess;
let results = [];
let totalTests = 0;
let passed = 0;

function test(name, fn) {
  totalTests++;
  return fn()
    .then(() => { passed++; results.push({ name, pass: true }); console.log(`  ✅ ${name}`); })
    .catch(err => { results.push({ name, pass: false, error: err.message }); console.log(`  ❌ ${name}: ${err.message}`); });
}

function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_PORT,
      path,
      method,
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
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

function connectWS(path) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function waitForMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
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

  serverProcess = spawn('node', [serverPath], {
    env: { ...process.env, PORT: TEST_PORT, ADMIN_API_KEY: API_KEY, JWT_SECRET: JWT_SECRET, DATABASE_PATH: './data/test-' + Date.now() + '.db' },
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
  console.log(`\n🧪 Church AV Connect Integration Tests (port ${TEST_PORT})\n`);

  let churchId, churchToken;

  // 1. Health check
  await test('GET / returns service info', async () => {
    const { status, body } = await apiRequest('GET', '/');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.service, 'church-av-relay');
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
    const { status, body } = await apiRequest('POST', '/api/churches/register', { name: 'Test Church', email: 'test@example.com' });
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

  // 7. Connect church via WebSocket
  let churchWS;
  await test('Church connects via WebSocket', async () => {
    churchWS = await connectWS(`/church?token=${churchToken}`);
    const msg = await waitForMessage(churchWS);
    assert.strictEqual(msg.type, 'connected');
    assert.strictEqual(msg.churchId, churchId);
  });

  // 8. Connect controller
  let controllerWS;
  await test('Controller connects via WebSocket', async () => {
    controllerWS = await connectWS(`/controller?apikey=${API_KEY}`);
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'church_list');
    assert.ok(Array.isArray(msg.churches));
  });

  // 9. Church sends status update
  await test('Church status update reaches controller', async () => {
    const statusMsg = { type: 'status_update', status: { atem: { connected: true }, obs: { connected: false } } };
    churchWS.send(JSON.stringify(statusMsg));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'status_update');
    assert.strictEqual(msg.churchId, churchId);
    assert.strictEqual(msg.status.atem.connected, true);
  });

  // 10. Send command via API
  await test('Send command to church via API', async () => {
    const { body } = await apiRequest('POST', '/api/command', { churchId, command: 'atem.cut', params: { input: 2 } });
    assert.ok(body.sent);
    const msg = await waitForMessage(churchWS);
    assert.strictEqual(msg.type, 'command');
    assert.strictEqual(msg.command, 'atem.cut');
    assert.strictEqual(msg.params.input, 2);
  });

  // 11. Command result flows back
  await test('Command result reaches controller', async () => {
    churchWS.send(JSON.stringify({ type: 'command_result', id: 'test-123', result: 'Cut executed' }));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'command_result');
    assert.strictEqual(msg.result, 'Cut executed');
  });

  // 12. Church status via API
  await test('GET church status returns last known state', async () => {
    const { body } = await apiRequest('GET', `/api/churches/${churchId}/status`);
    assert.strictEqual(body.name, 'Test Church');
    assert.strictEqual(body.connected, true);
  });

  // 13. Preview frame forwarded
  await test('Preview frame forwarded to controller', async () => {
    const frame = { type: 'preview_frame', timestamp: new Date().toISOString(), width: 720, height: 405, format: 'jpeg', data: 'dGVzdA==' };
    churchWS.send(JSON.stringify(frame));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'preview_frame');
    assert.strictEqual(msg.churchId, churchId);
    assert.strictEqual(msg.data, 'dGVzdA==');
  });

  // 14. Oversized preview frame rejected
  await test('Oversized preview frame rejected', async () => {
    const bigData = 'x'.repeat(200_000);
    churchWS.send(JSON.stringify({ type: 'preview_frame', data: bigData }));
    // Controller should NOT receive this
    const received = await Promise.race([
      waitForMessage(controllerWS, 1000).then(() => true),
      sleep(1200).then(() => false),
    ]);
    assert.strictEqual(received, false);
  });

  // 15. Alert forwarded
  await test('Alert from church reaches controller', async () => {
    churchWS.send(JSON.stringify({ type: 'alert', message: 'ATEM disconnected', severity: 'warning' }));
    const msg = await waitForMessage(controllerWS);
    assert.strictEqual(msg.type, 'alert');
    assert.strictEqual(msg.severity, 'warning');
  });

  // 16. Broadcast
  await test('Broadcast command reaches connected church', async () => {
    const { body } = await apiRequest('POST', '/api/broadcast', { command: 'atem.fadeToBlack' });
    assert.strictEqual(body.sent, 1);
    const msg = await waitForMessage(churchWS);
    assert.strictEqual(msg.command, 'atem.fadeToBlack');
  });

  // 17. Delete church
  await test('Delete church', async () => {
    // Close websockets first
    churchWS.close();
    controllerWS.close();
    await sleep(200);

    const { status, body } = await apiRequest('DELETE', `/api/churches/${churchId}`);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.deleted, true);
  });

  // 18. Deleted church gone
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
