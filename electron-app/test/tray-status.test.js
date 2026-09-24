'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildTrayDeviceSummary, isDeviceActive } = require('../src/tray-status');

test('tray: configured-but-disconnected device objects are NOT "✓ Connected"', () => {
  const s = buildTrayDeviceSummary({
    atem: { connected: false, ip: '10.0.0.5' },
    obs: { connected: false },
    encoder: null,
    companion: { connected: false },
    proPresenter: { connected: false, running: false },
    resolume: { connected: false },
    encoderType: 'OBS',
  });
  assert.equal(s.deviceCount, 0);
  assert.deepEqual(s.lines, [
    '  ATEM: ✗ Disconnected', '  OBS: ✗ Disconnected', '  Companion: ✗ Disconnected',
    '  ProPresenter: ✗ Disconnected', '  Resolume: ✗ Disconnected',
  ]);
});

test('tray: connected objects and legacy booleans count; unconfigured (null) devices are hidden', () => {
  const s = buildTrayDeviceSummary({ atem: { connected: true }, obs: true, encoder: null, companion: null, proPresenter: null, resolume: undefined, encoderType: 'OBS' });
  assert.equal(s.deviceCount, 2);
  assert.deepEqual(s.lines, ['  ATEM: ✓ Connected', '  OBS: ✓ Connected']);
});

test('tray: LIVE only when OBS is connected and streaming (no stale LIVE from a dead OBS)', () => {
  assert.equal(buildTrayDeviceSummary({ obs: { connected: true, streaming: true } }).isLive, true);
  assert.equal(buildTrayDeviceSummary({ obs: { connected: false, streaming: true } }).isLive, false);
  assert.equal(buildTrayDeviceSummary({ encoder: { connected: true, live: true } }).isLive, true);
});

test('tray: fingerprint changes when a device drops (menu must rebuild)', () => {
  const a = buildTrayDeviceSummary({ atem: { connected: true } }).fingerprint;
  const b = buildTrayDeviceSummary({ atem: { connected: false } }).fingerprint;
  assert.notEqual(a, b);
});

test('isDeviceActive', () => {
  for (const v of [null, undefined, false, {}, { connected: false }, { connected: 'yes' }, 1]) assert.equal(isDeviceActive(v), false, JSON.stringify(v));
  for (const v of [true, { connected: true }]) assert.equal(isDeviceActive(v), true);
});

test('main.js updateTray uses the honest summary (not truthiness of device objects)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function updateTray()'), src.indexOf('function updateTray()') + 4000);
  assert.match(fn, /buildTrayDeviceSummary\(agentStatus\)/);
  assert.doesNotMatch(fn, /const atemOk = agentStatus\.atem;/);
  assert.doesNotMatch(fn, /const encoderOk = agentStatus\.encoder \|\| agentStatus\.obs;/);
});
