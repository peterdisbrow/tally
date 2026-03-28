'use strict';

const { normalizeDeckModel } = require('./capabilities');

function parseIntent({ prompt, deckModel }) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();

  const normalizedDeck = normalizeDeckModel(deckModel || text);

  const tags = new Set();
  if (/m\/?e\s*2|me\s*2|m\/e\s*2/.test(lower)) tags.add('atem-me2');
  if (/m\/?e\s*1|me\s*1|m\/e\s*1/.test(lower)) tags.add('atem-me1');
  if (/multiview|mv/.test(lower)) tags.add('multiview');
  if (/keyer|upstream key|usk/.test(lower)) tags.add('keyer');
  if (/ftb|fade to black/.test(lower)) tags.add('ftb');
  if (/obs/.test(lower)) tags.add('obs');
  if (/propresenter|slides/.test(lower)) tags.add('propresenter');

  const objective = inferObjective(lower, tags);

  return {
    prompt: text,
    deckModel: normalizedDeck,
    objective,
    tags: Array.from(tags)
  };
}

function inferObjective(lower, tags) {
  if (tags.has('atem-me2')) return 'atem-me2-control';
  if (tags.has('atem-me1')) return 'atem-me1-control';
  if (tags.has('obs')) return 'obs-show-control';
  if (tags.has('propresenter')) return 'presentation-control';

  if (lower.includes('control surface') || lower.includes('switcher')) return 'switcher-control';
  return 'generic-control';
}

module.exports = { parseIntent };
