'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AtemSwitcher } = require('../src/switchers/atemSwitcher');
const { SwitcherManager } = require('../src/switcherManager');

function stubAgent() {
  return {
    sendAlert() {},
    sendStatus() {},
    sendToRelay() {},
    status: { atem: {}, obs: {}, vmix: {} },
  };
}

test('AtemSwitcher.reconnect is a no-op when already connected', () => {
  const sw = new AtemSwitcher({ id: 'atem-1', ip: '10.0.0.1' });
  sw.connected = true;
  const result = sw.reconnect({ immediate: true });
  assert.equal(result.kicked, false);
  assert.equal(result.reason, 'already-connected');
  assert.equal(sw._reconnectTimer, null);
});

test('AtemSwitcher.reconnect is a no-op without an IP', () => {
  const sw = new AtemSwitcher({ id: 'atem-1' });
  const result = sw.reconnect({ immediate: true });
  assert.equal(result.kicked, false);
  assert.equal(result.reason, 'unavailable');
});

test('AtemSwitcher.reconnect cancels a pending backoff and schedules immediately', async () => {
  const sw = new AtemSwitcher({ id: 'atem-1', ip: '10.0.0.1' });
  let connects = 0;
  sw.connect = async () => { connects += 1; sw.connected = true; };

  const pending = sw._scheduleReconnect({ delay: 60_000 });
  assert.equal(pending, true);
  assert.ok(sw._reconnectTimer, 'backoff timer should be pending');
  assert.equal(connects, 0);

  const result = sw.reconnect({ immediate: true });
  assert.equal(result.kicked, true);
  assert.equal(result.reason, 'scheduled');

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(connects, 1, 'force reconnect should not wait out the 60s backoff');

  await sw.disconnect();
});

test('AtemSwitcher._scheduleReconnect does not stack timers', () => {
  const sw = new AtemSwitcher({ id: 'atem-1', ip: '10.0.0.1' });
  sw.connect = async () => {};
  assert.equal(sw._scheduleReconnect({ delay: 30_000 }), true);
  const first = sw._reconnectTimer;
  assert.equal(sw._scheduleReconnect({ delay: 30_000 }), false);
  assert.equal(sw._reconnectTimer, first);
  clearTimeout(sw._reconnectTimer);
  sw._reconnectTimer = null;
});

test('SwitcherManager.reconnectByType kicks AtemSwitcher.reconnect', () => {
  const mgr = new SwitcherManager(stubAgent());
  mgr.buildFromConfig({ atemIp: '10.0.0.5' });
  const sw = mgr.get('atem-1');
  assert.ok(sw, 'legacy atemIp should migrate to atem-1');

  let called = false;
  sw.reconnect = ({ immediate } = {}) => {
    called = true;
    assert.equal(immediate, true);
    return { kicked: true, reason: 'scheduled' };
  };

  const results = mgr.reconnectByType('atem', { immediate: true });
  assert.equal(called, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'atem-1');
  assert.equal(results[0].kicked, true);
});

test('SwitcherManager.reconnectByType falls back to connect() when reconnect is missing', () => {
  const mgr = new SwitcherManager(stubAgent());
  mgr.buildFromConfig({
    switchers: [{ id: 'obs-1', type: 'obs', role: 'primary', name: 'OBS', url: 'ws://127.0.0.1:4455' }],
  });
  const sw = mgr.get('obs-1');
  let connected = false;
  sw.connect = async () => { connected = true; };
  delete sw.reconnect;

  const results = mgr.reconnectByType('obs');
  assert.equal(results[0].kicked, true);
  assert.equal(results[0].reason, 'connect');
  assert.equal(connected, true);
});

test('ChurchAVAgent.reconnectATEM delegates to SwitcherManager instead of returning early', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  const start = src.indexOf('reconnectATEM()');
  assert.ok(start > 0, 'reconnectATEM() must exist');
  const end = src.indexOf('\n  async atemCommand', start);
  const body = src.slice(start, end > start ? end : start + 1200);
  assert.match(body, /reconnectByType\(\s*['"]atem['"]/);
  assert.doesNotMatch(body, /switcherManager\.size > 0\) return;/);
});
