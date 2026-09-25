// The AI engineer must describe ProPresenter the way Tally really talks to it:
// the official /v1 REST API, polled (no WebSocket), Network enabled, no password,
// and which commands are confirmed vs only "accepted".
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');

describe('ProPresenter knowledge', () => {
  const ek = read('src/engineer-knowledge.js');
  const te = read('src/tally-engineer.js');
  it('no WebSocket / Remote-password claims', () => {
    for (const t of [ek, te]) {
      expect(t).not.toMatch(/ProPresenter[^\n]*REST API \+ WebSocket/);
      expect(t).not.toMatch(/ProPresenter Remote must be enabled \(with a password\)/);
      expect(t).not.toMatch(/Stage App must be enabled in PP Network settings for WebSocket/);
    }
    expect(ek).toMatch(/ProPresenter → Settings → Network/);
    expect(te).toMatch(/ProPresenter: official HTTP REST API \(\/v1\)/);
  });
  it('says which ProPresenter commands are only "accepted, not confirmed"', () => {
    expect(ek).toMatch(/Macros[^\n]*accepted by ProPresenter \(not confirmed\)/);
  });
  it('command list matches the client command table', () => {
    const cmds = fs.readFileSync(path.join(here, '../../church-client/src/commands/propresenter.js'), 'utf8');
    const line = ek.split('\n').find((l) => l.startsWith('propresenter: '));
    for (const c of ['lastSlide', 'triggerMacro', 'setStageLayout', 'captureStart', 'triggerGroup']) {
      expect(cmds).toContain(`'propresenter.${c}'`);
      expect(line).toContain(c);
    }
  });
});
