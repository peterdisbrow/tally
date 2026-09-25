// The AI engineer and the portal must describe each console's real remote protocol.
// (Old text said Yamaha CL/QL use OSC on 8765 and TF uses MIDI — neither exists; both
// speak Yamaha RCP over TCP 49280. A&H desks are MIDI over TCP only. Wing has no driver.)
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8');

describe('mixer protocol knowledge', () => {
  const texts = { 'engineer-knowledge': read('src/engineer-knowledge.js'), 'tally-engineer': read('src/tally-engineer.js') };
  for (const [name, t] of Object.entries(texts)) {
    it(`${name}: Yamaha is RCP over TCP 49280, not OSC/MIDI`, () => {
      expect(t).not.toMatch(/Yamaha CL\/QL:? \(?OSC/);
      expect(t).not.toMatch(/Yamaha TF:? \(?TCP MIDI/);
      expect(t).toMatch(/Yamaha CL\/QL\/TF[^\n]*RCP[^\n]*49280/);
    });
    it(`${name}: A&H is MIDI over TCP only`, () => {
      expect(t).toMatch(/Allen & Heath SQ\/dLive\/Avantis[^\n]*MIDI over TCP only/);
    });
    it(`${name}: does not claim Behringer Wing support`, () => {
      expect(t).not.toMatch(/X32\/M32\/Wing/);
    });
  }
  it('engineer-knowledge lists the mixer.type values the client actually accepts', () => {
    const t = texts['engineer-knowledge'];
    expect(t).not.toMatch(/yamaha-cl|yamaha-tf/);
    const bridge = fs.readFileSync(path.join(here, '../../church-client/src/mixerBridge.js'), 'utf8');
    for (const type of ['allenheath', 'dlive', 'avantis', 'yamaha']) {
      expect(bridge).toContain(`case '${type}'`);
      expect(t).toContain(type);
    }
  });
  it('portal port tooltip: SQ/dLive/Avantis=51325, Yamaha CL/QL/TF=49280', () => {
    const html = read('public/portal/portal.html');
    expect(html).toContain('SQ/dLive/Avantis=51325');
    expect(html).toContain('Yamaha CL/QL/TF=49280');
    expect(html).not.toContain('CL/QL=8765');
  });
});
