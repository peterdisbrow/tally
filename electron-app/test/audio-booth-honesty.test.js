/**
 * Booth audio honesty (sim pass — audio is core).
 * The agent sends status.mixer { connected, mainMuted, model } and
 * status.audio { silenceDetected, silenceDurationSec, lastLevelDb, source, coverage }.
 * The old hero audio card read status.audio.muted / .silence / .level — fields
 * that never exist — so it showed a green "Active" through a muted master,
 * silence, or a dead console.
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
  for (let i = src.indexOf(') {', start) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated');
}
const sum = (status) => vm.runInNewContext(`${extractFn(SRC('renderer.js'), 'getAudioSummary')}\ngetAudioSummary(s);`, { s: status });
const LIVE = { streaming: true, obs: { connected: true, streaming: true } };

test('console configured but offline → error "Console offline", counts as an issue', () => {
  const r = sum({ ...LIVE, mixer: { connected: false, type: 'x32', model: 'X32' }, audio: { coverage: 'none' } });
  assert.equal(r.state, 'error');
  assert.match(r.value, /offline/i);
  assert.equal(r.issue, true);
});

test('master muted at console → error "MUTED", counts as an issue', () => {
  const r = sum({ ...LIVE, mixer: { connected: true, mainMuted: true, model: 'X32' }, audio: { coverage: 'level', lastLevelDb: -60, source: 'atem' } });
  assert.equal(r.state, 'error');
  assert.match(r.value, /muted/i);
  assert.equal(r.issue, true);
});

test('silence detected while live → warning with duration, counts as an issue', () => {
  const r = sum({ ...LIVE, mixer: { connected: true, mainMuted: false }, audio: { coverage: 'level', silenceDetected: true, silenceDurationSec: 18, lastLevelDb: -70, source: 'atem' } });
  assert.equal(r.state, 'warning');
  assert.match(r.value, /silence/i);
  assert.match(r.detail, /18/);
  assert.equal(r.issue, true);
});

test('live with a real meter → ok, shows level and source', () => {
  const r = sum({ ...LIVE, mixer: { connected: true, mainMuted: false }, audio: { coverage: 'level', lastLevelDb: -18.4, source: 'atem' } });
  assert.equal(r.state, 'ok');
  assert.match(r.detail, /-18/);
  assert.match(r.detail, /ATEM/i);
  assert.equal(r.issue, false);
});

test('live but nothing metering audio → NOT green: calm "Not metered", no fake OK', () => {
  const r = sum({ ...LIVE, mixer: { connected: true, mainMuted: false }, audio: { coverage: 'none' } });
  assert.notEqual(r.state, 'ok');
  assert.match(r.value + r.detail, /not metered|can.t detect|no level/i);
  assert.equal(r.issue, false);
});

test('mute state unknown (null) is never shown as fine-muted or unmuted', () => {
  const r = sum({ ...LIVE, mixer: { connected: false, mainMuted: null, type: 'x32' }, audio: {} });
  assert.doesNotMatch(r.value, /muted/i);
  assert.equal(r.state, 'error');
});

test('nothing configured, not live → idle, not green', () => {
  const r = sum({ audio: { coverage: null } });
  assert.notEqual(r.state, 'ok');
});

test('hero audio card and hero issue count use getAudioSummary (not phantom audio.muted/.silence)', () => {
  const src = SRC('renderer.js');
  const fn = extractFn(src, 'updateControlRoom');
  assert.ok(!/status\.audio\.muted|status\.audio\.silence\b/.test(fn), 'reads fields the agent never sends');
  assert.match(fn, /getAudioSummary\(status\)/);
  assert.match(fn, /audioSummary\.issue/);
});

test('tray lists the audio console: online / offline / master MUTED (unknown is not "online")', () => {
  const { buildTrayDeviceSummary: b } = require('../src/tray-status');
  const buildTrayDeviceSummary = (x) => b(x).lines.join('\n');
  const on = buildTrayDeviceSummary({ mixer: { configured: true, type: 'x32', model: 'X32', connected: true, mainMuted: false } });
  assert.match(on, /Audio console.*✓/);
  const off = buildTrayDeviceSummary({ mixer: { configured: true, type: 'x32', connected: false, mainMuted: null } });
  assert.match(off, /Audio console.*✗.*offline/i);
  const muted = buildTrayDeviceSummary({ mixer: { configured: true, type: 'x32', connected: true, mainMuted: true } });
  assert.match(muted, /Audio console.*MUTED/);
  const none = buildTrayDeviceSummary({ mixer: { connected: false, type: null } });
  assert.doesNotMatch(none, /Audio console/);
});

test('Devices list dots are live, not hard-coded green: mixer offline → error, master muted → warning', () => {
  const src = SRC('renderer.js');
  const getStatusActive = (v) => !!(v && typeof v === 'object' ? v.connected : v);
  const dot = (key, st) => vm.runInNewContext(`${extractFn(src, 'deviceDotState')}\ndeviceDotState(k, s);`, { k: key, s: st, getStatusActive });
  assert.equal(dot('mixer', { mixer: { connected: false, type: 'x32' } }), 'error');
  assert.equal(dot('mixer', { mixer: { connected: true, mainMuted: true } }), 'warning');
  assert.equal(dot('mixer', { mixer: { connected: true, mainMuted: false } }), 'ok');
  assert.equal(dot('atem', { atem: { connected: false } }), 'error');
  assert.equal(dot('mixer', {}), 'unknown');
  const list = extractFn(src, 'renderSimpleDeviceList');
  assert.match(list, /key: 'mixer'/);
  assert.match(list, /device-dot unknown/);
  const css = SRC('styles.css');
  const base = css.slice(css.indexOf('.simple-device-item .device-dot {'), css.indexOf('}', css.indexOf('.simple-device-item .device-dot {')));
  assert.doesNotMatch(base, /var\(--green\)/, 'default dot must not be green');
});

test('saving equipment refreshes the Devices list (a newly added console appears with a live dot)', () => {
  const fn = extractFn(SRC('renderer.js'), '_doSaveEquipment');
  assert.match(fn, /renderSimpleDeviceList\(/);
  assert.match(fn, /updateSimpleDeviceDots\(/);
});

test('console name is not doubled ("X32 X32")', () => {
  const r = sum({ mixer: { connected: true, type: 'x32', model: 'X32', mainMuted: false } });
  assert.doesNotMatch(r.detail, /X32 X32/);
  const r2 = sum({ mixer: { connected: true, type: 'midas', model: 'M32', mainMuted: false } });
  assert.match(r2.detail, /MIDAS M32|M32/);
});

test('no UI advertises Behringer X-Air (XR12/16/18 use port 10024 and /lr/... — the X32 driver does not speak it)', () => {
  const R = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  for (const f of ['electron-app/src/device-registry.js', 'relay-server/public/portal/portal.html', 'relay-server/public/portal/portal.js', 'church-client/src/setup.js']) {
    assert.doesNotMatch(R(f), /X32 \/ X-Air/, `${f} still advertises X-Air`);
  }
});
