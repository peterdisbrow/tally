// Portal ProPresenter card: slide numbers are 1-based for people (agent sends 0-based),
// offline shows "not reachable" instead of hiding or showing the last slide, nothing on
// screen is said plainly, and running timers ('Running'/'Overrun' from the agent) are shown as running.
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
const load = () => {
  const f = extract('_ppDetailView');
  expect(f, '_ppDetailView exists').toBeTruthy();
  return new Function(`${f}\nreturn _ppDetailView;`)();
};

describe('portal ProPresenter card', () => {
  it('slide is 1-based: agent slideIndex 0 of 12 → "Slide 1 of 12"', () => {
    const v = load()({ connected: true, currentSlide: 'Worship Set', slideIndex: 0, slideTotal: 12, timers: [] });
    expect(v.name).toBe('Worship Set');
    expect(v.slideLine).toBe('Slide 1 of 12');
  });
  it('offline → shown as not reachable, no slide', () => {
    const v = load()({ connected: false, currentSlide: null, slideIndex: null });
    expect(v.show).toBe(true);
    expect(v.name).toMatch(/not reachable/i);
    expect(v.slideLine).toBe('');
  });
  it('connected with nothing on screen → "Nothing on screen"', () => {
    expect(load()({ connected: true, currentSlide: null, slideIndex: null, timers: [] }).name).toBe('Nothing on screen');
  });
  it('agent timer states Running / Overrun count as running', () => {
    const v = load()({ connected: true, timers: [{ name: 'Sermon', time: '00:10:00', state: 'Running' }, { name: 'Count', time: '00:00:05', state: 'Overrun' }, { name: 'X', time: '00:05:00', state: 'Stopped' }] });
    expect(v.timers.map((t) => t.running)).toEqual([true, true, false]);
    expect(v.timers[1].overrun).toBe(true);
  });
  it('the card uses the view helper (no 0-based "Slide " + sIdx)', () => {
    const card = extract('updateProPresenterDetailCard');
    expect(card).toContain('_ppDetailView(');
    expect(card).not.toMatch(/'Slide ' \+ sIdx \+/);
  });
});
