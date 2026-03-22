/**
 * ipc-contracts.test.js — IPC channel contract tests for preload.js
 *
 * Tests the IPC bridge between renderer and main process without running Electron.
 * Mocks contextBridge and ipcRenderer to capture registrations and verify:
 *
 *   - Complete electronAPI surface (all 70+ methods present)
 *   - Invoke method → channel name mapping (request/response)
 *   - Event listener → channel name mapping (subscriptions)
 *   - Payload forwarding (args passed through to ipcRenderer.invoke)
 *   - Callback wrapping (event data passed as second arg to callback)
 *   - onScanProgress returns unsubscribe function that removes the listener
 *   - No raw ipcRenderer methods exposed to renderer
 *
 * Run: node --test test/ipc-contracts.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const EventEmitter = require('events');

// ─── Mock ipcRenderer ────────────────────────────────────────────────────────

class MockIpcRenderer extends EventEmitter {
  constructor() {
    super();
    this.invoked = [];
    this.registered = [];
  }

  invoke(channel, ...args) {
    this.invoked.push({ channel, args });
    return Promise.resolve(`__result_${channel}`);
  }

  on(channel, listener) {
    this.registered.push({ channel, listener });
    return this;
  }

  removeListener(channel, listener) {
    this.registered = this.registered.filter(
      (r) => !(r.channel === channel && r.listener === listener),
    );
  }
}

// ─── Load preload.js with mocked electron module ──────────────────────────────

function loadPreload() {
  const ipcRenderer = new MockIpcRenderer();
  let exposed = null;

  const mockElectron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed = { name, api };
      },
    },
    ipcRenderer,
  };

  const originalLoad = Module._load.bind(Module);
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return mockElectron;
    return originalLoad(request, parent, isMain);
  };

  const preloadPath = require.resolve('../src/preload.js');
  delete require.cache[preloadPath];

  try {
    require('../src/preload.js');
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  return { api: exposed.api, name: exposed.name, ipcRenderer };
}

// ─── Channel name tables ──────────────────────────────────────────────────────

// [apiMethodName, ipcChannelName]
const INVOKE_CHANNELS = [
  ['getConfig',               'get-config'],
  ['saveConfig',              'save-config'],
  ['getStatus',               'get-status'],
  ['startAgent',              'start-agent'],
  ['stopAgent',               'stop-agent'],
  ['isRunning',               'is-running'],
  ['testConnection',          'test-connection'],
  ['churchAuthLogin',         'church-auth-login'],
  ['exportTestLogs',          'export-test-logs'],
  ['testEquipmentConnection', 'test-equipment-connection'],
  ['requestPreview',          'request-preview'],
  ['requestPreviewFrame',     'request-preview-frame'],
  ['scanNetwork',             'scan-network'],
  ['getNetworkInterfaces',    'get-network-interfaces'],
  ['saveEquipment',           'save-equipment'],
  ['getEquipment',            'get-equipment'],
  ['validateToken',           'validate-token'],
  ['signOut',                 'sign-out'],
  ['copyToClipboard',         'copy-to-clipboard'],
  ['openExternal',            'open-external'],
  ['probeNdi',                'probe-ndi'],
  ['captureNdiFrame',         'capture-ndi-frame'],
  ['sendChat',                'send-chat'],
  ['getChat',                 'get-chat'],
  ['pickFile',                'pick-file'],
  ['uploadChatFile',          'upload-chat-file'],
  ['saveEngineerProfile',     'save-engineer-profile'],
  ['oauthYouTubeConnect',     'oauth-youtube-connect'],
  ['oauthFacebookConnect',    'oauth-facebook-connect'],
  ['oauthFacebookSelectPage', 'oauth-facebook-select-page'],
  ['oauthYouTubeDisconnect',  'oauth-youtube-disconnect'],
  ['oauthFacebookDisconnect', 'oauth-facebook-disconnect'],
  ['oauthStatus',             'oauth-status'],
  ['oauthStreamKeys',         'oauth-stream-keys'],
  ['getPreServiceStatus',     'preservice-status'],
  ['getSessionLatest',        'get-session-latest'],
  ['getAutoStart',            'get-autostart'],
  ['setAutoStart',            'set-autostart'],
  ['getPreServiceCheck',      'get-preservice-check'],
  ['runPreServiceCheck',      'run-preservice-check'],
  ['fixAllPreService',        'fix-all-preservice'],
  ['getActiveRundown',        'get-active-rundown'],
  ['executeRundownStep',      'execute-rundown-step'],
  ['advanceRundownStep',      'advance-rundown-step'],
  ['jumpToRundownStep',       'jump-to-rundown-step'],
  ['deactivateRundown',       'deactivate-rundown'],
  ['pfAnalyze',               'pf-analyze'],
  ['pfGoNoGo',                'pf-go-no-go'],
  ['pfRunHistory',            'pf-run-history'],
  ['pfFeedback',              'pf-feedback'],
  ['pfGetConfig',             'pf-get-config'],
  ['pfSimulateFix',           'pf-simulate-fix'],
  ['pfAvailable',             'pf-available'],
  ['pfSetCamerasVerified',    'pf-set-cameras-verified'],
  ['pfGetCamerasVerified',    'pf-get-cameras-verified'],
  ['getFailoverConfig',       'get-failover-config'],
  ['saveFailoverConfig',      'save-failover-config'],
  ['getFailoverState',        'get-failover-state'],
  ['getFailoverSources',      'get-failover-sources'],
  ['onboardingChat',          'onboarding-chat'],
  ['onboardingConfirm',       'onboarding-confirm'],
  ['onboardingState',         'onboarding-state'],
  ['sendCommand',             'send-command'],
  ['sendDiagnosticBundle',    'send-diagnostic-bundle'],
];

const EVENT_CHANNELS = [
  ['onStatus',              'status'],
  ['onAuthInvalid',         'auth-invalid'],
  ['onLog',                 'log'],
  ['onPreviewFrame',        'preview-frame'],
  ['onUpdateReady',         'update-ready'],
  ['onScanProgress',        'scan-progress'],
  ['onChatMessage',         'chat-message'],
  ['onOauthUpdate',         'oauth-update'],
  ['onPfUpdate',            'pf-update'],
  ['onFailoverStateChange', 'failover-state'],
  ['onWindowVisibility',    'window-visibility'],
];

// ─── API surface completeness ─────────────────────────────────────────────────

test('contextBridge.exposeInMainWorld called with name "electronAPI"', () => {
  const { name } = loadPreload();
  assert.equal(name, 'electronAPI');
});

test('all electronAPI values are functions (no raw data exposed)', () => {
  const { api } = loadPreload();
  for (const [key, val] of Object.entries(api)) {
    assert.equal(typeof val, 'function', `electronAPI.${key} should be a function`);
  }
});

test('all invoke methods present on electronAPI', () => {
  const { api } = loadPreload();
  for (const [method] of INVOKE_CHANNELS) {
    assert.equal(typeof api[method], 'function', `${method} should be present`);
  }
});

test('all event listener methods present on electronAPI', () => {
  const { api } = loadPreload();
  for (const [method] of EVENT_CHANNELS) {
    assert.equal(typeof api[method], 'function', `${method} should be present`);
  }
});

test('electronAPI does not expose raw ipcRenderer methods', () => {
  const { api } = loadPreload();
  const forbidden = ['send', 'sendSync', 'sendToHost', 'removeAllListeners', 'invoke'];
  for (const name of forbidden) {
    assert.ok(!(name in api), `electronAPI should not expose raw ipcRenderer.${name}`);
  }
});

// ─── Invoke channel name contracts ───────────────────────────────────────────

for (const [method, channel] of INVOKE_CHANNELS) {
  test(`${method}() invokes IPC channel '${channel}'`, async () => {
    const { api, ipcRenderer } = loadPreload();
    ipcRenderer.invoked = [];
    await api[method]();
    const found = ipcRenderer.invoked.some((c) => c.channel === channel);
    assert.ok(found, `Expected ipcRenderer.invoke('${channel}') to be called`);
  });
}

// ─── Payload forwarding ───────────────────────────────────────────────────────

test('saveConfig forwards config object as first arg', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const cfg = { relay: 'wss://test.example.com', token: 'abc' };
  await api.saveConfig(cfg);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'save-config');
  assert.deepEqual(call.args[0], cfg);
});

test('testConnection forwards payload object', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const payload = { url: 'wss://relay.example.com', token: 'tok123' };
  await api.testConnection(payload);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'test-connection');
  assert.deepEqual(call.args[0], payload);
});

test('jumpToRundownStep forwards index as first arg', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.jumpToRundownStep(3);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'jump-to-rundown-step');
  assert.equal(call.args[0], 3);
});

test('setAutoStart forwards boolean true', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.setAutoStart(true);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'set-autostart');
  assert.equal(call.args[0], true);
});

test('setAutoStart forwards boolean false', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.setAutoStart(false);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'set-autostart');
  assert.equal(call.args[0], false);
});

test('pfSimulateFix forwards simId string', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.pfSimulateFix('relay_reconnect');
  const call = ipcRenderer.invoked.find((c) => c.channel === 'pf-simulate-fix');
  assert.equal(call.args[0], 'relay_reconnect');
});

test('pfGoNoGo forwards options object', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const opts = { triggerType: 'preflight' };
  await api.pfGoNoGo(opts);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'pf-go-no-go');
  assert.deepEqual(call.args[0], opts);
});

test('pfFeedback forwards feedback object', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const fb = { runId: 'run_1', rating: 5, comment: 'good' };
  await api.pfFeedback(fb);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'pf-feedback');
  assert.deepEqual(call.args[0], fb);
});

test('pfSetCamerasVerified forwards value', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.pfSetCamerasVerified(true);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'pf-set-cameras-verified');
  assert.equal(call.args[0], true);
});

test('saveFailoverConfig forwards config object', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const cfg = { primary: 'NDI1', fallback: 'NDI2', threshold: 3 };
  await api.saveFailoverConfig(cfg);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'save-failover-config');
  assert.deepEqual(call.args[0], cfg);
});

test('scanNetwork passes empty object when called with no args', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.scanNetwork();
  const call = ipcRenderer.invoked.find((c) => c.channel === 'scan-network');
  assert.deepEqual(call.args[0], {});
});

test('scanNetwork passes provided options object', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.scanNetwork({ subnet: '192.168.1.0/24' });
  const call = ipcRenderer.invoked.find((c) => c.channel === 'scan-network');
  assert.deepEqual(call.args[0], { subnet: '192.168.1.0/24' });
});

test('sendCommand forwards cmd and params as separate positional args', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.sendCommand('restart', { delay: 100 });
  const call = ipcRenderer.invoked.find((c) => c.channel === 'send-command');
  assert.equal(call.args[0], 'restart');
  assert.deepEqual(call.args[1], { delay: 100 });
});

test('oauthFacebookSelectPage forwards options', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const opts = { pageId: 'page_123' };
  await api.oauthFacebookSelectPage(opts);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'oauth-facebook-select-page');
  assert.deepEqual(call.args[0], opts);
});

test('churchAuthLogin forwards payload', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const payload = { relay: 'wss://relay.example.com', email: 'a@b.com', password: 's3cr3t' };
  await api.churchAuthLogin(payload);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'church-auth-login');
  assert.deepEqual(call.args[0], payload);
});

test('testEquipmentConnection forwards params', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const params = { type: 'atem', host: '192.168.1.100' };
  await api.testEquipmentConnection(params);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'test-equipment-connection');
  assert.deepEqual(call.args[0], params);
});

test('requestPreview forwards action string', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.requestPreview('start');
  const call = ipcRenderer.invoked.find((c) => c.channel === 'request-preview');
  assert.equal(call.args[0], 'start');
});

test('copyToClipboard forwards text string', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.copyToClipboard('hello world');
  const call = ipcRenderer.invoked.find((c) => c.channel === 'copy-to-clipboard');
  assert.equal(call.args[0], 'hello world');
});

test('openExternal forwards url string', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  await api.openExternal('https://tallyconnect.app');
  const call = ipcRenderer.invoked.find((c) => c.channel === 'open-external');
  assert.equal(call.args[0], 'https://tallyconnect.app');
});

test('onboardingChat forwards payload', async () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.invoked = [];
  const payload = { message: 'hello', sessionId: 'sess_1' };
  await api.onboardingChat(payload);
  const call = ipcRenderer.invoked.find((c) => c.channel === 'onboarding-chat');
  assert.deepEqual(call.args[0], payload);
});

// ─── Event listener channel contracts ────────────────────────────────────────

test('onStatus registers on "status" channel and wraps callback (data as second arg)', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onStatus((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'status');
  assert.ok(reg, 'listener registered on "status"');
  reg.listener(null /* event */, { relay: true, atem: false });
  assert.deepEqual(received, { relay: true, atem: false });
});

test('onAuthInvalid registers on "auth-invalid" and calls callback with no data', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let called = false;
  api.onAuthInvalid(() => { called = true; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'auth-invalid');
  assert.ok(reg, 'listener registered on "auth-invalid"');
  reg.listener(null);
  assert.ok(called);
});

test('onLog wraps callback passing log data payload', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onLog((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'log');
  reg.listener(null, 'Agent started');
  assert.equal(received, 'Agent started');
});

test('onPreviewFrame wraps callback passing full frame object', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onPreviewFrame((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'preview-frame');
  const frame = { timestamp: 123, width: 1280, height: 720, format: 'jpeg', data: 'base64' };
  reg.listener(null, frame);
  assert.deepEqual(received, frame);
});

test('onUpdateReady calls callback with no arguments', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let called = false;
  api.onUpdateReady(() => { called = true; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'update-ready');
  reg.listener(null);
  assert.ok(called);
});

test('onWindowVisibility passes boolean visible to callback', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  const received = [];
  api.onWindowVisibility((v) => { received.push(v); });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'window-visibility');
  reg.listener(null, true);
  reg.listener(null, false);
  assert.deepEqual(received, [true, false]);
});

test('onChatMessage wraps callback passing message data', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onChatMessage((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'chat-message');
  reg.listener(null, { role: 'assistant', content: 'Hello!' });
  assert.deepEqual(received, { role: 'assistant', content: 'Hello!' });
});

test('onOauthUpdate wraps callback passing oauth update data', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onOauthUpdate((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'oauth-update');
  reg.listener(null, { platform: 'youtube', connected: true });
  assert.deepEqual(received, { platform: 'youtube', connected: true });
});

test('onPfUpdate wraps callback passing problem finder update data', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onPfUpdate((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'pf-update');
  reg.listener(null, { status: 'GO', issues: [], coverageScore: 95 });
  assert.deepEqual(received, { status: 'GO', issues: [], coverageScore: 95 });
});

test('onFailoverStateChange wraps callback passing failover state', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onFailoverStateChange((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'failover-state');
  reg.listener(null, { active: true, source: 'fallback', primaryLost: true });
  assert.deepEqual(received, { active: true, source: 'fallback', primaryLost: true });
});

test('onScanProgress wraps callback passing scan progress data', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  let received;
  api.onScanProgress((data) => { received = data; });
  const reg = ipcRenderer.registered.find((r) => r.channel === 'scan-progress');
  reg.listener(null, { found: 3, total: 10, device: 'ATEM Mini' });
  assert.deepEqual(received, { found: 3, total: 10, device: 'ATEM Mini' });
});

// ─── onScanProgress returns unsubscribe function ─────────────────────────────

test('onScanProgress returns a function (unsubscribe)', () => {
  const { api } = loadPreload();
  const result = api.onScanProgress(() => {});
  assert.equal(typeof result, 'function');
});

test('onScanProgress unsubscribe removes the registered listener', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  const unsubscribe = api.onScanProgress(() => {});
  assert.equal(ipcRenderer.registered.filter((r) => r.channel === 'scan-progress').length, 1);
  unsubscribe();
  assert.equal(ipcRenderer.registered.filter((r) => r.channel === 'scan-progress').length, 0);
});

test('onScanProgress unsubscribe does not remove other listeners on scan-progress', () => {
  const { api, ipcRenderer } = loadPreload();
  ipcRenderer.registered = [];
  const unsub1 = api.onScanProgress(() => {});
  api.onScanProgress(() => {}); // second listener — no unsubscribe kept
  unsub1();
  assert.equal(ipcRenderer.registered.filter((r) => r.channel === 'scan-progress').length, 1);
});

test('other onX methods do NOT return a callable unsubscribe function', () => {
  const { api } = loadPreload();
  // onStatus, onLog, etc. do not return unsubscribe functions (unlike onScanProgress)
  const result = api.onStatus(() => {});
  assert.notEqual(typeof result, 'function', 'onStatus should not return a function');
});
