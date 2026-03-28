'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateLayout } = require('./generator');

test('generates ATEM M/E2 layout for Stream Deck XL intent', () => {
  const out = generateLayout({
    prompt: 'I have a Stream Deck XL and want an M/E 2 control surface with status feedback',
    gear: [{ type: 'atem', connectionId: 'atem-main', name: 'ATEM 4 M/E' }]
  });

  assert.equal(out.layout.objective, 'atem-me2-control');
  assert.equal(out.layout.pages.length, 1);
  assert.equal(out.layout.pages[0].buttons.length, 32);
  const pgm1 = out.layout.pages[0].buttons.find((b) => b.label === 'PGM 1');
  const pvw1 = out.layout.pages[0].buttons.find((b) => b.label === 'PVW 1');
  assert.equal(pgm1?.row, 2);
  assert.equal(pvw1?.row, 3);
  assert.equal(out.validation.errors.length, 0);
  assert.equal(out.validation.warnings.length, 0);
});

test('warns when required action capability is missing from selected gear', () => {
  const out = generateLayout({
    prompt: 'Build me an M/E 2 panel on stream deck xl',
    gear: [{ type: 'obs', connectionId: 'obs-main', name: 'OBS' }]
  });

  assert.equal(out.layout.objective, 'atem-me2-control');
  assert.ok(out.validation.warnings.length > 0);
});

test('falls back to generic layout for unknown intent', () => {
  const out = generateLayout({
    prompt: 'build me a custom control page for random tasks',
    deckModel: 'streamdeck-mk2',
    gear: []
  });

  assert.equal(out.layout.objective, 'generic-control');
  assert.equal(out.layout.deck.model, 'streamdeck-mk2');
  assert.equal(out.layout.pages[0].buttons.length, 15);
});
