// Companion: the AI engineer, Telegram replies, onboarding and the portal guide must
// describe Companion the way Tally really talks to it (HTTP API, port 8000 on 3+,
// HTTP API must be enabled, exact/unique names, press ≠ downstream confirmation).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');
const require = createRequire(import.meta.url);

describe('Companion knowledge', () => {
  const ek = read('src/engineer-knowledge.js');
  it('engineer knowledge: HTTP API switch, empty slot refused, press is not downstream confirmation', () => {
    expect(ek).toMatch(/Settings → Protocols → HTTP/);
    expect(ek).toMatch(/Pressing an empty slot is refused/);
    expect(ek).toMatch(/partial label only works when it matches exactly one button/);
    expect(ek).toMatch(/Dante scene button is "pressed, not confirmed"/);
  });
  it('command list matches the client command table', () => {
    const cmds = fs.readFileSync(path.join(here, '../../church-client/src/commands/companion.js'), 'utf8');
    const line = ek.split('\n').find((l) => l.startsWith('companion: '));
    for (const c of ['press', 'pressNamed', 'getGrid', 'connections', 'getVariable', 'getCustomVariable', 'setCustomVariable']) {
      expect(cmds).toContain(`'companion.${c}'`);
      expect(line.split(/,\s*|:\s*/)).toContain(c);
    }
  });
  it('no 8888 default anywhere Companion is explained to a church', () => {
    expect(read('src/onboardingChat.js')).not.toMatch(/companionPort \|\| 8888/);
    expect(read('src/onboardingChat.js')).not.toMatch(/Companion port 8888/);
    expect(read('public/portal/portal.html')).not.toMatch(/eq-companion-port" placeholder="8888"/);
    expect(read('public/portal/portal.html')).not.toMatch(/auto-detects Companion on port 8888/);
    expect(read('public/portal/portal.js')).not.toMatch(/same machine as Tally \(port 8888\)/);
  });
  it('portal guide names an HTTP API that is switched off and lists modules with problems', () => {
    const pj = read('public/portal/portal.js');
    expect(pj).toMatch(/comp\.apiDisabled/);
    expect(pj).toMatch(/with problems: /);
  });
});

describe('Companion Telegram replies', () => {
  const TelegramBot = require('../src/telegramBot.js');
  const Bot = TelegramBot.TallyBot || TelegramBot.TelegramBot || TelegramBot.default || TelegramBot;
  const proto = Bot.prototype || Object.getPrototypeOf(Bot);
  it('connections show each module\'s real status, not "Active" for everything', () => {
    const out = proto._formatResult.call({}, 'companion.connections', {}, [
      { label: 'atem', status: 'ok', enabled: true },
      { label: 'pp', status: 'error', detail: 'connection_failure: ECONNREFUSED', enabled: true },
      { label: 'old', status: 'disabled', enabled: false },
    ]);
    expect(out).toMatch(/atem: ✅ OK/);
    expect(out).toMatch(/pp: ❌ Error \(connection_failure: ECONNREFUSED\)/);
    expect(out).toMatch(/old: ⚫ Disabled/);
  });
  it('button grid reply lists the labelled buttons of the page (not "4 pages")', () => {
    const grid = [[{ row: 0, col: 0, text: 'Walk In' }, { row: 0, col: 1, text: '' }], [{ row: 1, col: 0, text: 'Service Start' }]];
    const out = proto._formatResult.call({}, 'companion.getGrid', { page: 1 }, grid);
    expect(out).toMatch(/Companion page 1\*: 2 labelled buttons/);
    expect(out).toMatch(/r1 c0: Service Start/);
    expect(out).not.toMatch(/pages? available/);
  });
  it('Companion refusals reach the user verbatim (they name what to fix)', () => {
    const e = '"sunday" matches 2 Companion buttons ("Dante: Sunday" p1 r0 c2, "Dante: Sunday Late" p1 r0 c3) — nothing pressed; use the exact label or page/row/column';
    expect(proto._friendlyError.call({}, e, 'companion.pressNamed')).toBe(e);
    const off = "Companion's HTTP API is switched off — press page 1 row 0 column 0 not done (enable it in Companion → Settings → Protocols → HTTP)";
    expect(proto._friendlyError.call({}, off, 'companion.press')).toBe(off);
  });
});
