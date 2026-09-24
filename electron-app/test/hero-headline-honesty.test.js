/**
 * Hero headline must never say "All Systems Nominal" (green check) unless the
 * relay is actually online. Relay offline / connecting / monitoring stopped =
 * calm neutral state ("Monitoring Locally", "Connecting to Relay…",
 * "Monitoring Stopped"), not green-nominal and not an alarm.
 * Device issues always take precedence.
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
const en = JSON.parse(SRC('locales/en.json'));
function hero(args) {
  const fn = extractFn(SRC('renderer.js'), 'getHeroState');
  const t = (k) => k.split('.').reduce((o, p) => (o ? o[p] : undefined), en) || k;
  return vm.runInNewContext(`${fn}\ngetHeroState(a);`, { a: args, t });
}

test('hero: relay online, no issues = All Systems Nominal (green)', () => {
  const h = hero({ issues: 0, relayState: 'online', stoppedByUser: false });
  assert.equal(h.kind, 'nominal');
  assert.equal(h.headline, 'All Systems Nominal');
  assert.equal(h.iconClass, 'cr-hero-icon');
});
for (const rs of ['offline', 'no-internet']) {
  test(`hero: relay ${rs}, no issues = Monitoring Locally (calm, not green, not alarm)`, () => {
    const h = hero({ issues: 0, relayState: rs, stoppedByUser: false });
    assert.equal(h.kind, 'local');
    assert.notEqual(h.headline, 'All Systems Nominal');
    assert.match(h.headline, /Monitoring Locally/);
    assert.equal(h.iconClass, 'cr-hero-icon local');
  });
}
test('hero: relay connecting = Connecting to Relay… (neutral, not green)', () => {
  const h = hero({ issues: 0, relayState: 'connecting', stoppedByUser: false });
  assert.equal(h.kind, 'connecting');
  assert.notEqual(h.headline, 'All Systems Nominal');
  assert.equal(h.iconClass, 'cr-hero-icon local');
});
test('hero: monitoring stopped by user = Monitoring Stopped (not nominal)', () => {
  const h = hero({ issues: 0, relayState: 'offline', stoppedByUser: true });
  assert.equal(h.kind, 'stopped');
  assert.notEqual(h.headline, 'All Systems Nominal');
});
test('hero: device issues take precedence over relay state', () => {
  for (const rs of ['online', 'offline', 'connecting']) {
    const h = hero({ issues: 2, relayState: rs, stoppedByUser: false });
    assert.equal(h.kind, 'error');
    assert.equal(h.headline, '2 Issues Detected');
    assert.equal(h.iconClass, 'cr-hero-icon error');
  }
  assert.equal(hero({ issues: 1, relayState: 'online' }).headline, '1 Issue Detected');
});
test('updateControlRoom renders via getHeroState and never hardcodes the nominal headline', () => {
  const cr = extractFn(SRC('renderer.js'), 'updateControlRoom');
  assert.match(cr, /getHeroState\(\{/);
  assert.doesNotMatch(cr, /'All Systems Nominal'/);
});
test('hero strings exist in every locale; local icon has a calm style', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'locales'))) {
    const j = JSON.parse(SRC(path.join('locales', f)));
    for (const k of ['nominal', 'monitoringLocally', 'connectingRelay', 'monitoringStopped']) {
      assert.ok(j.hero && j.hero[k], `${f} hero.${k}`);
    }
  }
  assert.match(SRC('styles.css'), /\.cr-hero-icon\.local\s*\{/);
});

test('initial HTML hero does not claim nominal before the first status push', () => {
  const html = SRC('index.html');
  const m = html.match(/id="cr-hero-headline">([^<]*)</);
  assert.ok(m);
  assert.notEqual(m[1].trim(), 'All Systems Nominal');
  assert.match(html, /class="cr-hero-icon local" id="cr-hero-icon"/);
});
