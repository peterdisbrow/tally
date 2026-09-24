'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isRelayAuthFailure } = require('../src/agent-auth-detect');

// Real agent output lines (church-client/src/index.js) for device-level failures.
const DEVICE_LINES = [
  '⚠️  OBS disconnected (code 4009: Authentication failed.). Retrying in 5s...',
  '⚠️  OBS not available: Authentication failed.',
  '[Companion] HTTP 401 Unauthorized',
  '[PlanningCenter] sync failed: 401 Unauthorized',
  '🎬 Connecting to OBS at ws://127.0.0.1:41008...',
  '[Encoder] bitrate 1008 kbps',
  'ProPresenter: Not authorized',
];
const RELAY_LINES = [
  '⚠️  Relay disconnected (1008: invalid token). Reconnecting in 3.1s... (attempt 1)',
  '⚠️  Relay disconnected (1008: token required). Reconnecting in 2.9s... (attempt 1)',
  '⚠️  Relay disconnected (1008: church not registered). Reconnecting in 3.0s... (attempt 2)',
  '⚠️  Relay disconnected (1008: billing_canceled). Reconnecting in 3.0s... (attempt 1)',
];

test('device auth failures never count as a Tally session rejection', () => {
  for (const l of DEVICE_LINES) assert.equal(isRelayAuthFailure(l), false, l);
});
test('relay 1008 session rejections do', () => {
  for (const l of RELAY_LINES) assert.equal(isRelayAuthFailure(l), true, l);
  assert.equal(isRelayAuthFailure(`noise\n${RELAY_LINES[0]}\nmore`), true);
});
test('non-auth relay closes (network drop, room limit) do not sign out', () => {
  assert.equal(isRelayAuthFailure('⚠️  Relay disconnected (1006: ). Reconnecting in 3.0s... (attempt 1)'), false);
  assert.equal(isRelayAuthFailure('🚫 Relay rejected connection: room limit reached (1 room(s) max for your plan).'), false);
});

// Run the REAL main.js _detectAgentAuthFailure against the device lines: it must
// not fire auth-invalid (old substring list fired on "Authentication failed").
test('main.js _detectAgentAuthFailure: wrong OBS password does NOT sign the operator out', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const start = src.indexOf('let _authInvalidFired = false;');
  const end = src.indexOf('\n}\n', src.indexOf('function _detectAgentAuthFailure')) + 3;
  assert.ok(start > 0 && end > start, 'found detector in main.js');
  const sent = [];
  const ctx = {
    isRelayAuthFailure, appendAppLog() {}, updateTray() {}, agentStatus: {}, agentProcess: { kill() {} },
    mainWindow: { webContents: { send: (ch) => sent.push(ch) } },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src.slice(start, end)}\nthis.detect = _detectAgentAuthFailure;`, ctx);
  for (const l of DEVICE_LINES) ctx.detect(l);
  assert.deepEqual(sent.filter((c) => c === 'auth-invalid'), [], 'auth-invalid fired for a device-level failure');
  ctx.detect(RELAY_LINES[0]);
  assert.ok(sent.includes('auth-invalid'), 'relay invalid token still signs out');
});
