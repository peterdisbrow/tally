/**
 * Paces-pass honesty fixes:
 *  - _mergeLocalStatus must keep null (unconfigured) devices null.
 *  - Renderer relay state must agree across banner/pill/hero/network card:
 *    half-open WS + failing /health = offline; agent restart with healthy
 *    relay = connecting (brief), not "Relay unreachable".
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated');
}

test('_mergeLocalStatus preserves null for unconfigured devices', () => {
  const ctx = { agentStatus: { relay: true, atem: { connected: false }, resolume: null, encoder: null, companion: null } };
  vm.runInNewContext(`${extractFn(SRC('main.js'), '_mergeLocalStatus')}\n_mergeLocalStatus(incoming);`, Object.assign(ctx, {
    incoming: { relay: false, atem: { connected: true, programInput: 5 }, resolume: { connected: false }, encoder: { connected: false }, companion: { connected: false } },
  }));
  assert.equal(ctx.agentStatus.relay, true, 'relay owned by WS/health, untouched');
  assert.equal(ctx.agentStatus.atem.connected, true);
  assert.equal(ctx.agentStatus.resolume, null);
  assert.equal(ctx.agentStatus.encoder, null);
  assert.equal(ctx.agentStatus.companion, null);
});

function relayState({ health, ws, online = true, stopped = false, downForMs = 0 }) {
  const renderer = SRC('renderer.js');
  const now = 1_000_000;
  const ctx = {
    _relayHealthOnline: health,
    _monitoringStoppedByUser: stopped,
    navigator: { onLine: online },
    Date: { now: () => now },
    getStatusActive: (v) => v === true || (v && typeof v === 'object' && v.connected === true),
  };
  const code = `const RELAY_CONNECT_GRACE_MS = 20000; let _relayWsDownSince = ${ws ? 'null' : now - downForMs};\n${extractFn(renderer, 'getRelayUiState')}\ngetRelayUiState({ relay: ${ws} });`;
  return vm.runInNewContext(code, ctx);
}

test('relay UI: WS up + health up = online', () => {
  assert.equal(relayState({ health: true, ws: true }), 'online');
});
test('relay UI: half-open WS (hung relay) + health failing = offline', () => {
  assert.equal(relayState({ health: false, ws: true }), 'offline');
});
test('relay UI: agent restarting with healthy relay = connecting (not unreachable)', () => {
  assert.equal(relayState({ health: true, ws: false, downForMs: 3000 }), 'connecting');
});
test('relay UI: WS still down after grace with healthy HTTP = offline (no endless "connecting")', () => {
  assert.equal(relayState({ health: true, ws: false, downForMs: 25000 }), 'offline');
});
test('relay UI: browser offline = no-internet', () => {
  assert.equal(relayState({ health: false, ws: false, online: false }), 'no-internet');
});

test('all relay surfaces use getRelayUiState (banner, hero, pill, network card, health handler)', () => {
  const r = SRC('renderer.js');
  const cr = extractFn(r, 'updateControlRoom');
  assert.match(cr, /const relayState = getRelayUiState\(status\);/);
  assert.match(cr, /relayState === 'connecting' \? t\('status\.relayConnecting'\)/);
  const sui = extractFn(r, 'updateStatusUI');
  assert.match(sui, /getRelayUiState\(status\)/);
  const h = extractFn(r, '_applyRelayHealth');
  assert.match(h, /getRelayUiState\(_lastStatus \|\| \{\}\)/);
  assert.doesNotMatch(h, /_cachedStatus \? getStatusActive/);
});

test('relayConnecting string exists in every locale', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'locales'))) {
    const j = JSON.parse(SRC(path.join('locales', f)));
    assert.ok(j.status.relayConnecting, `${f} status.relayConnecting`);
  }
});

test('unconfigured OBS is null (hides Encoder card) on start and after agent exit', () => {
  const m = SRC('main.js');
  const start = extractFn(m, 'startAgent');
  assert.match(start, /if \(!config\.obsUrl\) agentStatus\.obs = null;/);
  assert.match(m, /obs: closedConfig\.obsUrl \? false : null,/);
});

test('unconfigured encoder hides BOTH the Encoder card and the Streaming Encoder detail section', () => {
  const r = SRC('renderer.js');
  const fn = extractFn(r, 'isEncoderUnconfigured');
  const run = (s) => vm.runInNewContext(`${fn}\nisEncoderUnconfigured(s);`, { s });
  assert.equal(run({ encoder: null, obs: null }), true, 'ATEM-only booth');
  assert.equal(run({ encoder: null }), true, 'obs undefined');
  assert.equal(run({ encoder: null, obs: false }), false, 'OBS configured but down');
  assert.equal(run({ encoder: { connected: false }, obs: null }), false, 'encoder configured');
  assert.equal(run({ encoder: null, obs: null, encoderType: 'vMix' }), false, 'typed encoder');
  assert.match(extractFn(r, 'updateControlRoom'), /isEncoderUnconfigured\(status\)/);
  const sui = extractFn(r, 'updateStatusUI');
  assert.match(sui, /getElementById\('encoder-status-section'\)/);
  assert.match(sui, /isEncoderUnconfigured\(status\)/);
});
