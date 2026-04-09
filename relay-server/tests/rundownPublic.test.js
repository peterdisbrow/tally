import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildManualPlanTimerState,
  buildPublicRundownPayload,
} = require('../src/rundownPublic');

describe('rundownPublic helpers', () => {
  it('builds a timer state with the next playable cue and overtime metadata', () => {
    const now = Date.now();
    const plan = {
      id: 'plan-1',
      title: 'Sunday Service',
      items: [
        { id: 'item-1', itemType: 'section', title: 'Pre-show' },
        { id: 'item-2', itemType: 'other', title: 'Welcome', lengthSeconds: 120 },
        { id: 'item-3', itemType: 'section', title: 'Music' },
        { id: 'item-4', itemType: 'other', title: 'Song 1', lengthSeconds: 180 },
      ],
    };

    const timer = buildManualPlanTimerState(plan, {
      isLive: true,
      currentCueIndex: 1,
      startedAt: now - 180000,
      currentCueStartedAt: now - 150000,
    }, now);

    expect(timer).toMatchObject({
      is_live: true,
      cue_title: 'Welcome',
      next_cue_title: 'Song 1',
      next_cue_index: 3,
      is_overtime: true,
      overtime_seconds: 30,
    });
  });

  it('builds a public payload with flattened values, live fields, and public attachment urls', () => {
    const now = Date.now();
    const payload = buildPublicRundownPayload({
      now,
      share: { token: 'share-token', expiresAt: now + 3600000 },
      plan: {
        id: 'plan-1',
        churchId: 'church-1',
        title: 'Sunday Service',
        serviceDate: '2026-04-12',
        status: 'show_ready',
        updatedAt: now,
        items: [
          {
            id: 'item-1',
            itemType: 'other',
            title: 'Walk-in',
            notes: '<strong>Ready</strong>',
            lengthSeconds: 180,
            startType: 'hard',
            hardStartTime: '09:00',
            autoAdvance: true,
            sortOrder: 0,
          },
        ],
      },
      liveState: {
        isLive: true,
        currentCueIndex: 0,
        startedAt: now - 240000,
        currentCueStartedAt: now - 60000,
      },
      columns: [
        { id: 'col-1', name: 'Camera', type: 'dropdown', options: ['Wide'], equipmentBinding: 'atem.program_input' },
      ],
      values: [
        { id: 'val-1', itemId: 'item-1', columnId: 'col-1', value: 'Wide', updatedAt: now },
      ],
      attachments: [
        { id: 'att-1', itemId: 'item-1', filename: 'notes.pdf', mimetype: 'application/pdf', size: 1024, createdAt: now },
      ],
      attachmentUrlBuilder: (attachment) => `/api/public/rundown/share-token/attachments/${attachment.id}`,
    });

    expect(payload.columns).toHaveLength(1);
    expect(payload.values).toEqual([
      expect.objectContaining({ itemId: 'item-1', columnId: 'col-1', value: 'Wide' }),
    ]);
    expect(payload.items[0]).toMatchObject({
      notes: 'Ready',
      notesHtml: '<strong>Ready</strong>',
      cells: { 'col-1': 'Wide' },
      columns: [{ columnId: 'col-1', value: 'Wide' }],
      attachments: [
        expect.objectContaining({
          id: 'att-1',
          url: '/api/public/rundown/share-token/attachments/att-1',
        }),
      ],
    });
    expect(payload.liveState).toMatchObject({
      isLive: true,
      currentCueIndex: 0,
      elapsedSeconds: 60,
      nextCueIndex: null,
    });
    expect(payload.liveState.timer).toMatchObject({
      cue_title: 'Walk-in',
      remaining_seconds: 120,
    });
  });
});
