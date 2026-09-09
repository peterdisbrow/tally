/**
 * Source contracts for Sunday-critical tray / offline-fallback wiring.
 * main.js is not exported — these pin the control-flow so a refactor
 * cannot silently drop the dashboard emit or re-bind Start/Stop to relay.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('pollLocalStatus emits `status` after merging local agent state', () => {
  assert.match(MAIN_JS, /_mergeLocalStatus\(body\.status\)/);
  assert.match(MAIN_JS, /webContents\?\.send\('status', agentStatus\)/);
  const mergeIdx = MAIN_JS.indexOf('_mergeLocalStatus(body.status)');
  const statusEmitIdx = MAIN_JS.indexOf("send('status', agentStatus)", mergeIdx);
  assert.ok(mergeIdx > 0, 'local-status merge must exist');
  assert.ok(statusEmitIdx > mergeIdx, 'status IPC must follow the local-status merge');
});

test('tray Start/Stop is bound to agentProcess, not relay connected', () => {
  assert.match(MAIN_JS, /const agentRunning = !!agentProcess/);
  assert.match(
    MAIN_JS,
    /label: agentRunning \? t\('tray\.stopMonitoring'\) : t\('tray\.startMonitoring'\)/,
  );
  assert.match(
    MAIN_JS,
    /click: \(\) => agentRunning \? stopAgent\(\) : startAgent\(\)/,
  );
  assert.doesNotMatch(
    MAIN_JS,
    /label: connected \? t\('tray\.stopMonitoring'\) : t\('tray\.startMonitoring'\)/,
  );
});

test('tray offline copy does not claim local monitoring when agent is stopped', () => {
  assert.match(MAIN_JS, /agentRunning \? t\('tray\.offlineLocal'\) : t\('tray\.agentStopped'\)/);
  assert.doesNotMatch(MAIN_JS, /agentRunning \? 'Offline Mode — Local monitoring active' : 'Agent stopped'/);
});

test('tray menu Open Church Portal uses i18n key tray.clientPortal', () => {
  assert.match(MAIN_JS, /t\('tray\.clientPortal'\)/);
});

test('relay health OFFLINE sends an OS notification (not only agent stdout)', () => {
  assert.match(MAIN_JS, /_notifyOnce\('relay-health-offline'/);
  assert.match(MAIN_JS, /t\('notifications\.relayOffline'\)/);
});
