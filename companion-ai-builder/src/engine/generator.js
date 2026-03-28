'use strict';

const { parseIntent } = require('./parser');
const { DECK_DIMENSIONS, normalizeDeckModel, normalizeGearList, getCapabilitiesForGear } = require('./capabilities');
const { validateLayout } = require('./validator');
const { buildAtemMeTemplate, buildGenericTemplate } = require('./templates');

function generateLayout(input = {}) {
  const intent = parseIntent({ prompt: input.prompt, deckModel: input.deckModel });
  const deckKey = normalizeDeckModel(intent.deckModel);
  const deck = DECK_DIMENSIONS[deckKey] || DECK_DIMENSIONS['streamdeck-xl'];
  const gear = normalizeGearList(input.gear || []);
  const capabilities = getCapabilitiesForGear(gear);

  const pages = [];

  if (intent.objective === 'atem-me2-control') {
    pages.push(buildAtemMeTemplate({ me: 2, page: 1, deck }));
  } else if (intent.objective === 'atem-me1-control') {
    pages.push(buildAtemMeTemplate({ me: 1, page: 1, deck }));
  } else {
    pages.push(buildGenericTemplate({ page: 1, deck }));
  }

  const layout = {
    version: '0.2.0',
    generatedAt: new Date().toISOString(),
    title: buildTitle(intent),
    objective: intent.objective,
    deck: {
      model: deckKey,
      ...deck
    },
    gear,
    pages,
    deployHints: {
      mode: 'bundle-dry-run',
      notes: [
        'Run /api/compatibility before deployment to verify module coverage.',
        'Run /api/deploy (dry-run) to validate target slot occupancy.',
        'This spec is generator-native and can be mapped to Companion import JSON.'
      ]
    }
  };

  const validation = validateLayout(layout, capabilities);

  const summary = summarize(layout, validation);

  return {
    layout,
    validation,
    summary,
    intent
  };
}

function buildTitle(intent) {
  if (intent.objective === 'atem-me2-control') return 'ATEM M/E 2 Stream Deck Surface';
  if (intent.objective === 'atem-me1-control') return 'ATEM M/E 1 Stream Deck Surface';
  return 'Companion Custom Control Surface';
}

function summarize(layout, validation) {
  const pageCount = layout.pages.length;
  const buttonCount = layout.pages.reduce((sum, p) => sum + p.buttons.length, 0);
  return {
    pageCount,
    buttonCount,
    warningCount: validation.warnings.length,
    errorCount: validation.errors.length
  };
}

module.exports = { generateLayout };
