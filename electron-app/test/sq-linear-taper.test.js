/**
 * SQ fader law is only correct when the desk is set to Linear Taper
 * (Utility > General > MIDI). That note belongs on the device setup card,
 * and only when the selected console is an SQ — not dLive, Avantis, X32,
 * or the main booth view.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const reg = require('../src/device-registry.js');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'equipment-ui.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
const LINE = 'Set the desk to Linear Taper (Utility > General > MIDI) so fader control is correct.';

function renderMixer(type) {
  const ctx = {
    ...reg,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    setEquipDot() {},
    api: {},
    __html: '',
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${uiSrc}\ndeviceState.mixer = { type: ${JSON.stringify(type)}, host: '10.0.0.8', port: '51325', midiChannel: '1' };\n__html = renderDeviceCard('mixer');`,
    ctx,
  );
  return ctx.__html;
}

test('device setup tells the crew to use Linear Taper only when the console is an SQ', () => {
  const sq = renderMixer('allenheath');
  assert.match(sq, /Linear Taper/);
  assert.match(sq, /Utility &gt; General &gt; MIDI/);
  assert.ok(sq.includes(LINE.replace(/>/g, '&gt;')) || sq.includes(LINE), 'exact setup sentence');
  for (const type of ['dlive', 'avantis', 'x32', 'behringer', 'midas', 'yamaha', 'atem-auto', '']) {
    const html = renderMixer(type);
    assert.doesNotMatch(html, /Linear Taper/, `no taper note for ${type || 'unset'}`);
  }
  assert.doesNotMatch(renderer, /Linear Taper/, 'main booth view does not carry the setup note');
});
