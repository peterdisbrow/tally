/**
 * A&H dLive/Avantis booth honesty. The Avantis cannot report master mute over
 * MIDI, so "Console online" must say the mute state is not reported instead of
 * implying "unmuted"; the MIDI selector must say 13–16 are SQ-only (dLive/Avantis
 * base channel is 1–12).
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

test('booth audio card: unknown master mute is stated, known unmute is not flagged', () => {
  const fn = extractFn(SRC('renderer.js'), 'getAudioSummary');
  const sum = (status) => vm.runInNewContext(`${fn}\ngetAudioSummary(s);`, { s: status });
  const unk = sum({ mixer: { connected: true, type: 'avantis', model: 'Avantis', mainMuted: null } });
  assert.equal(unk.value, 'Console online');
  assert.match(unk.detail, /master mute not reported/);
  const known = sum({ mixer: { connected: true, type: 'dlive', model: 'dLive', mainMuted: false } });
  assert.doesNotMatch(known.detail, /not reported/);
  assert.equal(sum({ mixer: { connected: true, type: 'dlive', mainMuted: true } }).value, 'MUTED');
});

test('MIDI selector: default names both defaults; 13–16 marked SQ-only', () => {
  const { DEVICE_REGISTRY } = require('../src/device-registry.js');
  const f = DEVICE_REGISTRY.mixer.fields.find((x) => x.key === 'midiChannel');
  assert.match(f.options[0].label, /dLive\/Avantis 12/);
  assert.match(f.options[13].label, /MIDI ch 13 \(SQ only\)/);
  assert.doesNotMatch(f.options[12].label, /SQ only/);
});
