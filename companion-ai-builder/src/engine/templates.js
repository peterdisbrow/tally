'use strict';

const ATEM_SOURCES_DEFAULT = [1, 2, 3, 4, 5, 6, 7, 8];

function buildAtemMeTemplate({ me = 2, sources = ATEM_SOURCES_DEFAULT, page = 1, deck = { cols: 8, rows: 4 } }) {
  const buttons = [];
  const cols = Math.max(1, Number(deck?.cols) || 8);
  const rows = Math.max(1, Number(deck?.rows) || 4);
  const sourceRow = sources.slice(0, cols);

  // Traditional switcher placement: buses live on the lower rows.
  const programRow = rows >= 2 ? rows - 2 : 0;
  const previewRow = rows - 1;
  const transitionRow = rows >= 3 ? 0 : null;
  const utilityRow = rows >= 4 ? 1 : null;

  // Program bus quick sources.
  sourceRow.forEach((source, index) => {
    buttons.push({
      page,
      row: programRow,
      col: index,
      label: `PGM ${source}`,
      action: {
        id: 'atem.me.setProgram',
        params: { me, source }
      },
      feedback: [{ id: 'atem.me.programSource', eq: { me, source }, style: 'red-active' }],
      category: 'program'
    });
  });

  // Preview bus quick sources.
  sourceRow.forEach((source, index) => {
    buttons.push({
      page,
      row: previewRow,
      col: index,
      label: `PVW ${source}`,
      action: {
        id: 'atem.me.setPreview',
        params: { me, source }
      },
      feedback: [{ id: 'atem.me.previewSource', eq: { me, source }, style: 'green-active' }],
      category: 'preview'
    });
  });

  // Transition controls and keyers.
  const row0 = [
    {
      label: 'CUT',
      action: { id: 'atem.me.cut', params: { me } },
      feedback: [],
      category: 'transition'
    },
    {
      label: 'AUTO',
      action: { id: 'atem.me.auto', params: { me } },
      feedback: [],
      category: 'transition'
    },
    {
      label: 'MIX',
      action: { id: 'atem.me.setTransitionStyle', params: { me, style: 'mix' } },
      feedback: [{ id: 'atem.me.transitionStyle', eq: { me, style: 'mix' }, style: 'amber-active' }],
      category: 'transition'
    },
    {
      label: 'DIP',
      action: { id: 'atem.me.setTransitionStyle', params: { me, style: 'dip' } },
      feedback: [{ id: 'atem.me.transitionStyle', eq: { me, style: 'dip' }, style: 'amber-active' }],
      category: 'transition'
    },
    {
      label: 'RATE -',
      action: { id: 'atem.me.setTransitionRate', params: { me, delta: -5 } },
      feedback: [],
      category: 'transition'
    },
    {
      label: 'RATE +',
      action: { id: 'atem.me.setTransitionRate', params: { me, delta: 5 } },
      feedback: [],
      category: 'transition'
    },
    {
      label: 'KEY 1',
      action: { id: 'atem.me.toggleKeyOnAir', params: { me, keyer: 1 } },
      feedback: [{ id: 'atem.me.keyOnAir', eq: { me, keyer: 1, onAir: true }, style: 'red-active' }],
      category: 'keyer'
    },
    {
      label: 'FTB',
      action: { id: 'atem.me.ftb', params: { me, enabled: 'toggle' } },
      feedback: [{ id: 'atem.me.ftb', eq: { me, enabled: true }, style: 'red-active' }],
      category: 'safety'
    }
  ];

  if (transitionRow !== null && transitionRow !== programRow && transitionRow !== previewRow) {
    row0.slice(0, cols).forEach((item, col) => {
      buttons.push({ page, row: transitionRow, col, ...item });
    });
  }

  // Utility row for source banking and safety macros.
  const row1 = [
    { label: 'SRC 1-8', action: { id: 'builder.page.bank', params: { me, bank: 1 } }, feedback: [], category: 'bank' },
    { label: 'SRC 9-16', action: { id: 'builder.page.bank', params: { me, bank: 2 } }, feedback: [], category: 'bank' },
    { label: 'PVW BLK', action: { id: 'atem.me.setPreview', params: { me, source: 0 } }, feedback: [], category: 'safety' },
    { label: 'PGM BLK', action: { id: 'atem.me.setProgram', params: { me, source: 0 } }, feedback: [], category: 'safety' },
    { label: 'KEY OFF', action: { id: 'atem.me.toggleKeyOnAir', params: { me, keyer: 1, force: false } }, feedback: [], category: 'keyer' },
    { label: 'AUTO 25F', action: { id: 'atem.me.setTransitionRate', params: { me, absolute: 25 } }, feedback: [], category: 'transition' },
    { label: 'SAFE CUT', action: { id: 'atem.me.cut', params: { me, safe: true } }, feedback: [], category: 'safety' },
    { label: 'STATUS', action: { id: 'builder.status', params: { me } }, feedback: [], category: 'system' }
  ];

  if (utilityRow !== null && utilityRow !== programRow && utilityRow !== previewRow) {
    row1.slice(0, cols).forEach((item, col) => {
      buttons.push({ page, row: utilityRow, col, ...item });
    });
  }

  return {
    id: `atem-me${me}-xl-page-${page}`,
    name: `ATEM M/E ${me} Control`,
    page,
    buttons,
    metadata: {
      type: 'atem-me-control',
      me,
      sourceCount: sourceRow.length,
      profile: cols === 8 && rows === 4 ? 'streamdeck-xl' : 'dynamic'
    }
  };
}

function buildGenericTemplate({ page = 1, deck }) {
  const buttons = [];
  let n = 1;
  for (let row = 0; row < deck.rows; row += 1) {
    for (let col = 0; col < deck.cols; col += 1) {
      buttons.push({
        page,
        row,
        col,
        label: `Action ${n}`,
        action: { id: 'custom.action', params: { index: n } },
        feedback: [],
        category: 'custom'
      });
      n += 1;
    }
  }

  return {
    id: `generic-page-${page}`,
    name: 'Custom Control Page',
    page,
    buttons,
    metadata: {
      type: 'generic-control',
      sourceCount: 0,
      profile: 'generic'
    }
  };
}

module.exports = {
  buildAtemMeTemplate,
  buildGenericTemplate,
  ATEM_SOURCES_DEFAULT
};
