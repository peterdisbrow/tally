import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { LiveRundownManager } = require('../src/liveRundown');

function createManager() {
  return new LiveRundownManager({
    broadcastToMobile: () => {},
    broadcastToPortal: () => {},
    broadcastToControllers: () => {},
    broadcastToChurch: () => {},
  });
}

describe('LiveRundownManager manual-plan compatibility', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-08T12:00:00.000Z'));
    manager = createManager();
  });

  afterEach(() => {
    manager?.shutdown();
    vi.useRealTimers();
  });

  it('starts on the first playable cue and preserves richer cue metadata', () => {
    const state = manager.startSession('church-1', {
      id: 'plan-1',
      title: 'Sunday Service',
      source: 'manual',
      items: [
        { id: 'section-1', itemType: 'section', title: 'Pre-show' },
        {
          id: 'cue-1',
          itemType: 'other',
          title: 'Welcome',
          lengthSeconds: 90,
          startType: 'hard',
          hardStartTime: '09:00',
          autoAdvance: true,
          notesHtml: '<strong>Host ready</strong>',
          customCells: [{ columnId: 'camera', value: 'Wide' }],
          attachments: [{ id: 'att-1', filename: 'notes.pdf' }],
        },
      ],
    });

    expect(state).toMatchObject({
      currentIndex: 1,
      currentCueIndex: 1,
      source: 'manual',
      effectiveAutoAdvance: true,
      currentItem: {
        id: 'cue-1',
        startType: 'hard',
        hardStartTime: '09:00',
        autoAdvance: true,
        notesHtml: '<strong>Host ready</strong>',
      },
    });
    expect(state.currentItem.customCells).toEqual([{ columnId: 'camera', value: 'Wide' }]);
    expect(state.currentItem.attachments).toEqual([{ id: 'att-1', filename: 'notes.pdf' }]);
  });

  it('skips section rows for next cue timing and manual navigation', () => {
    manager.startSession('church-1', {
      id: 'plan-2',
      title: 'Service Flow',
      items: [
        { id: 'cue-1', itemType: 'other', title: 'Walk-in', lengthSeconds: 120 },
        { id: 'section-1', itemType: 'section', title: 'Worship' },
        { id: 'cue-2', itemType: 'song', title: 'Song 1', lengthSeconds: 180 },
      ],
    });

    expect(manager.getTimerState('church-1')).toMatchObject({
      cue_title: 'Walk-in',
      next_cue_title: 'Song 1',
      next_cue_index: 2,
    });

    const advanced = manager.advance('church-1');
    expect(advanced).toMatchObject({
      currentIndex: 2,
      currentCueIndex: 2,
      currentItem: { id: 'cue-2', title: 'Song 1' },
    });

    const rewound = manager.back('church-1');
    expect(rewound).toMatchObject({
      currentIndex: 0,
      currentItem: { id: 'cue-1', title: 'Walk-in' },
    });
  });

  it('honors per-cue auto-advance even when session-wide auto-advance is off', async () => {
    manager.startSession('church-1', {
      id: 'plan-3',
      title: 'Countdown',
      items: [
        { id: 'cue-1', itemType: 'other', title: 'Countdown', lengthSeconds: 1, autoAdvance: true },
        { id: 'section-1', itemType: 'section', title: 'Spacer' },
        { id: 'cue-2', itemType: 'other', title: 'Go Live', lengthSeconds: 30 },
      ],
    });

    await vi.advanceTimersByTimeAsync(1200);

    const state = manager.getState('church-1');
    expect(state).toMatchObject({
      currentIndex: 2,
      currentCueIndex: 2,
      currentItem: { id: 'cue-2', title: 'Go Live' },
    });
  });
});
