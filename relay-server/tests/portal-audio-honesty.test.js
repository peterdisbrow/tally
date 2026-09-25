// Portal audio card honesty: an unknown master mute (console offline, or an Avantis
// that cannot report it) must never render as "✓ Unmuted"/"✓ OK", and a silence tile
// must not claim "Signal" when nothing is metering.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '../public/portal/portal.js'), 'utf8');

function extract(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  return null;
}
function load() {
  const muteSrc = extract('_muteTileState');
  const silSrc = extract('_silenceTileState');
  expect(muteSrc, '_muteTileState exists').toBeTruthy();
  expect(silSrc, '_silenceTileState exists').toBeTruthy();
  return new Function('AUDIO_CHECK_SVG', `${muteSrc}\n${silSrc}\nreturn { _muteTileState, _silenceTileState };`)('<svg/>');
}

describe('portal audio card — unknown is not OK', () => {
  it('master mute tile is tri-state', () => {
    const { _muteTileState } = load();
    expect(_muteTileState(true, 'Unmuted').html).toBe('MUTED');
    expect(_muteTileState(false, 'Unmuted').html).toContain('Unmuted');
    for (const v of [null, undefined]) {
      const t = _muteTileState(v, 'Unmuted');
      expect(t.html).toBe('Unknown');
      expect(t.html).not.toContain('<svg');
    }
  });
  it('silence tile says "Not metered" without monitoring', () => {
    const { _silenceTileState } = load();
    expect(_silenceTileState({}).html).toContain('Not metered');
    expect(_silenceTileState({ monitoring: true, silenceDetected: true }).html).toBe('Silence');
    expect(_silenceTileState({ monitoring: true }).html).toContain('Signal');
  });
  it('every audio branch uses the tri-state helpers (no raw `mainMuted ? MUTED : OK`)', () => {
    const card = extract('updateAudioHealthCard');
    expect(card).toBeTruthy();
    expect(card).not.toMatch(/mainMuted \? 'MUTED'/);
    expect((card.match(/_muteTileState\(/g) || []).length).toBe(3);
  });
  it('port tooltip no longer claims the SQ uses 51326', () => {
    const html = fs.readFileSync(path.join(here, '../public/portal/portal.html'), 'utf8');
    expect(html).not.toContain('SQ=51326');
  });
});
