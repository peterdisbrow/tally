// Portal Planning Center card: a connection whose last sync failed (token revoked, PCO down,
// no permission) must not show a green "Connected" — it says "Sync failing" and why.
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
function render(status) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: '', className: '', style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const document = { getElementById: el };
  const f = extract('updatePcoUI');
  expect(f, 'updatePcoUI exists').toBeTruthy();
  new Function('document', 'lockChurchAdminControl', `${f}\nupdatePcoUI(arguments[2]);`)(document, () => {}, status);
  return { badge: el('conn-pco-badge'), msg: el('conn-pco-status-msg') };
}

describe('portal Planning Center card', () => {
  it('healthy connection → green Connected', () => {
    const r = render({ connected: true, orgName: 'Lab Church', lastSynced: '2026-09-25T08:00:00Z', lastSyncError: null });
    expect(r.badge.textContent).toBe('Connected');
    expect(r.badge.className).toContain('conn-badge-on');
  });
  it('last sync failed → amber "Sync failing" with the reason', () => {
    const r = render({ connected: true, orgName: 'Lab Church', lastSynced: null, lastSyncError: 'Planning Center rejected the credentials (401) — reconnect Planning Center' });
    expect(r.badge.textContent).toBe('Sync failing');
    expect(r.badge.className).toContain('conn-badge-warn');
    expect(r.msg.textContent).toMatch(/401.*reconnect/);
  });
  it('not connected → Disconnected', () => {
    expect(render({ connected: false }).badge.textContent).toBe('Disconnected');
  });
});
