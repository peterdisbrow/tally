/**
 * Booth PTZ honesty: per-camera live status on the dashboard, Devices list
 * dots that reflect real state (they were hard-coded green for every device),
 * offline cameras count as issues, tray shows PTZ.
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
const r = SRC('renderer.js');
const call = (fn, arg, extra = {}) => vm.runInNewContext(`${extractFn(r, fn)}\n${fn}(a);`, { a: arg, ...extra });
const cam = (o = {}) => ({ index: 1, name: 'Cam 1', ip: '10.0.0.20', protocol: 'visca-tcp', connected: true, power: 'on', error: null, ...o });

test('getPtzSummary: none configured → hidden', () => {
  assert.equal(call('getPtzSummary', []).show, false);
  assert.equal(call('getPtzSummary', null).show, false);
  assert.equal(call('getPtzSummary', undefined).show, false);
});
test('getPtzSummary: all online → ok "2/2 online"', () => {
  const s = call('getPtzSummary', [cam(), cam({ index: 2, name: 'Cam 2' })]);
  assert.equal(s.show, true); assert.equal(s.state, 'ok'); assert.equal(s.offline, 0);
  assert.match(s.value, /2\/2 online/);
});
test('getPtzSummary: one offline → error, names the camera and why', () => {
  const s = call('getPtzSummary', [cam(), cam({ index: 2, name: 'Pulpit', connected: false, power: null, error: 'No VISCA reply from 10.0.0.21:5678 within 1500ms' })]);
  assert.equal(s.state, 'error'); assert.equal(s.offline, 1);
  assert.match(s.value, /1 of 2 offline/i);
  assert.match(s.detail, /Pulpit/); assert.match(s.detail, /No VISCA reply/);
});
test('getPtzSummary: standby → warning, not ok', () => {
  const s = call('getPtzSummary', [cam({ power: 'standby' })]);
  assert.equal(s.state, 'warning'); assert.equal(s.offline, 0);
  assert.match(s.value + ' ' + s.detail, /standby/i);
});

test('deviceDotState reflects real status per device (no fake green)', () => {
  const st = { atem: { connected: false }, obs: { connected: true }, encoder: null, companion: null, ptz: [cam(), cam({ index: 2, connected: false }), cam({ index: 3, power: 'standby' })] };
  const d = (k) => vm.runInNewContext(`${extractFn(r, 'getStatusActive')}\n${extractFn(r, 'deviceDotState')}\ndeviceDotState(k, s);`, { k, s: st });
  assert.equal(d('atem'), 'error');
  assert.equal(d('encoder'), 'ok', 'OBS connected counts for the encoder row');
  assert.equal(d('companion'), 'unknown');
  assert.equal(d('ptz:0'), 'ok');
  assert.equal(d('ptz:1'), 'error');
  assert.equal(d('ptz:2'), 'warning');
  assert.equal(d('ptz:9'), 'unknown');
  assert.equal(vm.runInNewContext(`${extractFn(r, 'getStatusActive')}\n${extractFn(r, 'deviceDotState')}\ndeviceDotState('atem', null);`, {}), 'unknown');
});

test('Devices list rows carry a status key; dots are updated from live status', () => {
  const fn = extractFn(r, 'renderSimpleDeviceList');
  const el = { innerHTML: '' };
  vm.runInNewContext(`${fn}\nrenderSimpleDeviceList(eq);`, {
    eq: { atemIp: '10.0.0.9', ptz: [{ ip: '10.0.0.20', name: 'Cam 1' }, { ip: '10.0.0.21', name: 'Pulpit' }], encoderType: 'obs', encoderHost: '10.0.0.5' },
    document: { getElementById: () => el }, escapeHtml: (x) => String(x),
  });
  assert.match(el.innerHTML, /data-status-key="atem"/);
  assert.match(el.innerHTML, /data-status-key="encoder"/);
  assert.match(el.innerHTML, /data-status-key="ptz:0"/);
  assert.match(el.innerHTML, /data-status-key="ptz:1"/);
  assert.match(extractFn(r, 'updateControlRoom'), /updateSimpleDeviceDots\(status\)/);
  const css = SRC('styles.css');
  const dotRule = css.match(/\.simple-device-item \.device-dot \{[^}]*\}/)[0];
  assert.doesNotMatch(dotRule, /var\(--green\)/, 'default dot must not be green');
  for (const c of ['ok', 'error', 'warning']) assert.match(css, new RegExp(`\\.simple-device-item \\.device-dot\\.${c}\\s*\\{`));
});

test('Dashboard has a PTZ card; offline cameras count as an issue in the hero', () => {
  const html = SRC('index.html');
  assert.match(html, /id="cr-card-ptz"[^>]*style="display:none;"/);
  assert.match(html, /id="cr-ptz-status"/);
  const cr = extractFn(r, 'updateControlRoom');
  assert.match(cr, /getPtzSummary\(status\.ptz\)/);
  assert.match(cr, /setCard\('cr-card-ptz'/);
  assert.match(cr, /ptzSummary\.offline > 0\) issues\+\+/);
});

test('tray lists PTZ cameras honestly', () => {
  const { buildTrayDeviceSummary } = require('../src/tray-status');
  const a = buildTrayDeviceSummary({ ptz: [cam(), cam({ index: 2, connected: false })] });
  assert.ok(a.lines.some((l) => /PTZ: ✗ 1 of 2 offline/.test(l)), a.lines.join('|'));
  const b = buildTrayDeviceSummary({ ptz: [cam()] });
  assert.ok(b.lines.some((l) => /PTZ: ✓ 1\/1 online/.test(l)), b.lines.join('|'));
  assert.ok(!buildTrayDeviceSummary({ ptz: [] }).lines.some((l) => /PTZ/.test(l)));
});
