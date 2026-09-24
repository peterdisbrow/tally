/**
 * Booth honesty contracts found in the Linux "paces" pass:
 *  1. resolveNodeBinary must never pick a directory (NODE_PATH) as the node
 *     binary — spawn() then fails with EACCES and the agent never starts.
 *  2. Relay SSE snapshots for a church with no live agent (connected:false)
 *     must not be merged — otherwise the UI shows stale ATEM/PGM/PVW while
 *     the local agent is dead.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const MAIN_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

function extractFn(name) {
  const start = MAIN_JS.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  for (let i = MAIN_JS.indexOf('{', start); i < MAIN_JS.length; i++) {
    if (MAIN_JS[i] === '{') depth++;
    else if (MAIN_JS[i] === '}') { depth--; if (depth === 0) return MAIN_JS.slice(start, i + 1); }
  }
  throw new Error(`unterminated ${name}`);
}

function loadResolver({ env, platform = 'linux', whichOut = null, execPath = '/opt/Tally/tally-connect' }) {
  const src = `${extractFn('isExecutableFile')}\n${extractFn('resolveNodeBinary')}\nresolveNodeBinary;`;
  const sandbox = {
    fs, path,
    process: { env, platform, resourcesPath: '', execPath },
    spawnSync: () => (whichOut ? { status: 0, stdout: `${whichOut}\n` } : { status: 1, stdout: '' }),
  };
  return vm.runInNewContext(src, sandbox);
}

test('NODE_PATH directory is never chosen as the node binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-nodepath-'));
  const resolve = loadResolver({ env: { NODE_PATH: dir }, whichOut: null });
  const r = resolve();
  assert.notEqual(r.binary, dir);
  assert.ok(!fs.existsSync(r.binary) || fs.statSync(r.binary).isFile());
});

test('$NODE pointing at a directory is rejected; falls back to a real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-nodedir-'));
  const resolve = loadResolver({ env: { NODE: dir }, platform: 'freebsd', whichOut: null });
  const r = resolve();
  assert.equal(r.useElectronAsNode, true, 'no valid system node → Electron-as-Node fallback');
});

test('non-executable file is rejected', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tally-noexec-')), 'node');
  fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, 0o644);
  const resolve = loadResolver({ env: { NODE: f }, platform: 'freebsd', whichOut: f });
  assert.equal(resolve().useElectronAsNode, true);
});

test('executable $NODE file is accepted', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tally-exec-')), 'node');
  fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, 0o755);
  const resolve = loadResolver({ env: { NODE: f }, platform: 'freebsd' });
  assert.deepEqual({ ...resolve() }, { binary: f, useElectronAsNode: false });
});

test('main.js no longer treats NODE_PATH as a binary candidate', () => {
  assert.doesNotMatch(MAIN_JS, /addCandidate\(process\.env\.NODE_PATH\)/);
});

test('relay SSE ignores stale snapshots and status while agent is down', () => {
  const sse = extractFn('startRelayStatusSSE');
  assert.match(sse, /if \(!agentProcess\) continue;/);
  assert.match(sse, /msg\.type === 'status_snapshot' && msg\.connected === false\) continue;/);
  const guard = sse.indexOf('if (!agentProcess) continue;');
  const merge = sse.indexOf('_mergeRelayStatus(status)');
  assert.ok(guard > 0 && merge > guard, 'guards must run before merge');
});

test('agent is spawned with the same config file the app uses (--config-path / MDM)', () => {
  const start = extractFn('startAgent');
  assert.match(start, /'--config', configManager\.CONFIG_PATH/);
});
