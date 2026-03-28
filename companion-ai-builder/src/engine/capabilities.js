'use strict';

const DECK_DIMENSIONS = {
  'streamdeck-mini': { cols: 3, rows: 2, buttons: 6, label: 'Stream Deck Mini' },
  'streamdeck-mk2': { cols: 5, rows: 3, buttons: 15, label: 'Stream Deck MK.2' },
  'streamdeck-plus': { cols: 4, rows: 2, buttons: 8, knobs: 4, label: 'Stream Deck Plus' },
  'streamdeck-xl': { cols: 8, rows: 4, buttons: 32, label: 'Stream Deck XL' },
  mobile: { cols: 5, rows: 3, buttons: 15, label: 'Companion Mobile' }
};

const GEAR_ACTIONS = {
  atem: {
    actions: new Set([
      'atem.me.setPreview',
      'atem.me.setProgram',
      'atem.me.cut',
      'atem.me.auto',
      'atem.me.setTransitionStyle',
      'atem.me.setTransitionRate',
      'atem.me.toggleKeyOnAir',
      'atem.me.ftb'
    ]),
    feedback: new Set([
      'atem.me.previewSource',
      'atem.me.programSource',
      'atem.me.keyOnAir',
      'atem.me.transitionStyle',
      'atem.me.ftb'
    ])
  },
  obs: {
    actions: new Set(['obs.setScene', 'obs.toggleMute', 'obs.toggleStream']),
    feedback: new Set(['obs.currentScene', 'obs.sourceMute', 'obs.streaming'])
  },
  vmix: {
    actions: new Set(['vmix.setProgram', 'vmix.setPreview', 'vmix.transition']),
    feedback: new Set(['vmix.program', 'vmix.preview'])
  },
  propresenter: {
    actions: new Set(['pp.nextSlide', 'pp.prevSlide', 'pp.triggerMacro', 'pp.clearAll']),
    feedback: new Set(['pp.currentSlide', 'pp.stageMessage'])
  },
  x32: {
    actions: new Set(['x32.muteChannel', 'x32.unmuteChannel', 'x32.recallScene']),
    feedback: new Set(['x32.channelMute', 'x32.currentScene'])
  },
  wing: {
    actions: new Set(['wing.muteChannel', 'wing.recallScene']),
    feedback: new Set(['wing.channelMute', 'wing.currentScene'])
  }
};

const GEAR_MODULE_HINTS = {
  atem: ['bmd-atem', 'atem', 'blackmagicdesign-atem'],
  obs: ['obs-studio', 'obs'],
  vmix: ['vmix'],
  propresenter: ['renewedvision-propresenter', 'propresenter'],
  x32: ['behringer-x32', 'x32'],
  wing: ['behringer-wing', 'wing']
};

const ACTION_PREFIX_TO_GEAR = {
  atem: 'atem',
  obs: 'obs',
  vmix: 'vmix',
  pp: 'propresenter',
  x32: 'x32',
  wing: 'wing'
};

function normalizeDeckModel(input) {
  const v = String(input || '').toLowerCase().trim();
  if (!v) return 'streamdeck-xl';
  if (v.includes('xl')) return 'streamdeck-xl';
  if (v.includes('mini')) return 'streamdeck-mini';
  if (v.includes('plus')) return 'streamdeck-plus';
  if (v.includes('mk2') || v.includes('mk.2')) return 'streamdeck-mk2';
  if (v.includes('mobile') || v.includes('tablet') || v.includes('phone')) return 'mobile';
  return DECK_DIMENSIONS[v] ? v : 'streamdeck-xl';
}

function normalizeGearList(gear) {
  if (!Array.isArray(gear)) return [];
  return gear
    .map((item) => {
      const type = String(item?.type || '').toLowerCase().trim();
      const connectionId = String(item?.connectionId || type || '').trim();
      const name = String(item?.name || type || '').trim();
      if (!type) return null;
      return { type, connectionId, name };
    })
    .filter(Boolean);
}

function getCapabilitiesForGear(gearList) {
  const actions = new Set();
  const feedback = new Set();

  for (const gear of gearList) {
    const cap = GEAR_ACTIONS[gear.type];
    if (!cap) continue;
    for (const action of cap.actions) actions.add(action);
    for (const fb of cap.feedback) feedback.add(fb);
  }

  return { actions, feedback };
}

function inferGearFromId(id) {
  const token = String(id || '').trim().split('.')[0].toLowerCase();
  return ACTION_PREFIX_TO_GEAR[token] || null;
}

function getModuleHintsForGear(type) {
  return GEAR_MODULE_HINTS[String(type || '').toLowerCase()] || [];
}

module.exports = {
  DECK_DIMENSIONS,
  GEAR_ACTIONS,
  GEAR_MODULE_HINTS,
  normalizeDeckModel,
  normalizeGearList,
  getCapabilitiesForGear,
  inferGearFromId,
  getModuleHintsForGear
};
