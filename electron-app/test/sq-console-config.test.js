/**
 * A&H SQ booth configuration honesty (sim pass — audio is core).
 * The SQ speaks only MIDI over TCP 51325 and ignores MIDI on any channel but
 * its own. The booth used to advertise port 51326 ("OSC"), probe it over UDP
 * in the network scan (never answers), had no way to set the MIDI channel, and
 * listed the console as "ALLENHEATH Console".
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

test('registry: no "SQ=51326"; A&H MIDI channel field exists and is shown only for A&H consoles', () => {
  const { DEVICE_REGISTRY } = require('../src/device-registry.js');
  const mixer = DEVICE_REGISTRY.mixer;
  assert.doesNotMatch(mixer.detailHint, /51326/);
  const f = mixer.fields.find((x) => x.key === 'midiChannel');
  assert.ok(f, 'midiChannel field');
  assert.deepEqual(f.onlyForTypes.sort(), ['allenheath', 'avantis', 'dlive']);
  assert.equal(f.options.length, 17);
  assert.match(SRC('equipment-ui.js'), /field\.onlyForTypes && !field\.onlyForTypes\.includes\(state\.type\)/);
});

test('booth save/load round-trips the MIDI channel (UI 1–16 ↔ config 0–15) for A&H only', () => {
  const r = SRC('renderer.js');
  assert.match(r, /mixerMidiChannel: \['allenheath', 'dlive', 'avantis'\]\.includes\(deviceState\.mixer\.type\)/);
  assert.match(r, /midiChannel: eq\.mixerMidiChannel \? String\(eq\.mixerMidiChannel\) : ''/);
  const m = SRC('main.js');
  assert.match(m, /midiChannel: Number\(equipConfig\.mixerMidiChannel\) - 1/);
  assert.match(m, /mixerMidiChannel: Number\.isInteger\(config\.mixer\?\.midiChannel\) \? config\.mixer\.midiChannel \+ 1 : ''/);
});

test('Devices list names the console like a human ("Allen & Heath SQ Console", not "ALLENHEATH Console")', () => {
  const fn = extractFn(SRC('renderer.js'), 'mixerDisplayName');
  const name = (t) => vm.runInNewContext(`${fn}\nmixerDisplayName(t);`, { t });
  assert.equal(name('allenheath'), 'Allen & Heath SQ');
  assert.equal(name('dlive'), 'Allen & Heath dLive');
  assert.equal(name('x32'), 'X32');
  assert.doesNotMatch(SRC('renderer.js'), /\(eq\.mixerType \|\| 'Mixer'\)\.toUpperCase\(\)/);
});

test('network scan finds an SQ where it actually listens (TCP 51325), not a UDP OSC probe on 51326', async () => {
  const s = SRC('networkScanner.js');
  assert.doesNotMatch(s, /port: 51326/);
  assert.match(s, /\{ port: 51325, type: 'mixer-allenheath' \}/);
  const fn = extractFn(s, 'probeDevice');
  const calls = [];
  const probe = vm.runInNewContext(`${fn}\nprobeDevice;`, {
    tryUdpProbe: async () => { calls.push('udp'); return false; },
    tryTcpConnect: async () => { calls.push('tcp'); return true; },
    ATEM_SYN_PACKET: 0, OSC_INFO_PACKET: 0, OSC_SQ_ALIVE_PACKET: 0, OSC_YAMAHA_STATE_PACKET: 0,
  });
  assert.equal(await probe('10.0.0.5', 51325, 'mixer-allenheath', 100), true);
  assert.deepEqual(calls, ['tcp']);
});

test('hero audio card names the console like a human ("Allen & Heath SQ", not "ALLENHEATH SQ")', () => {
  const fn = extractFn(SRC('renderer.js'), 'getAudioSummary');
  const sum = (status) => vm.runInNewContext(`${fn}\ngetAudioSummary(s);`, { s: status });
  const on = sum({ mixer: { connected: true, type: 'allenheath', model: 'SQ', mainMuted: false } });
  assert.match(on.detail, /Allen & Heath SQ/);
  assert.doesNotMatch(on.detail, /ALLENHEATH/);
  const off = sum({ mixer: { connected: false, type: 'allenheath', model: 'SQ6' } });
  assert.match(off.detail, /Allen & Heath SQ6 not responding/);
  assert.match(sum({ mixer: { connected: true, type: 'dlive', model: 'dLive', mainMuted: false } }).detail, /Allen & Heath dLive/);
  assert.match(sum({ mixer: { connected: true, type: 'x32', model: 'X32', mainMuted: false } }).detail, /^X32\b/);
});
