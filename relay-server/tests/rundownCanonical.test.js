import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeShareRole,
  isOperatorShare,
  manualPlanToLivePlan,
  toLegacyLiveShowState,
  publicShareUrls,
} = require('../src/rundownCanonical');

describe('rundownCanonical helpers', () => {
  it('treats missing share roles as operator for legacy Sunday links', () => {
    expect(normalizeShareRole(undefined)).toBe('operator');
    expect(isOperatorShare({ token: 'legacy' })).toBe(true);
    expect(isOperatorShare({ role: 'display' })).toBe(false);
  });

  it('preserves manual cue metadata when converting to a live plan', () => {
    const livePlan = manualPlanToLivePlan({
      id: 'plan-1',
      title: 'Sunday',
      churchId: 'church-1',
      roomId: 'sanctuary',
      items: [
        {
          id: 'cue-1',
          title: 'Welcome',
          itemType: 'other',
          sortOrder: 2,
          lengthSeconds: 90,
          notes: 'Host ready',
          startType: 'hard',
          hardStartTime: '09:00',
        },
      ],
    });

    expect(livePlan).toMatchObject({
      source: 'manual',
      roomId: 'sanctuary',
      items: [
        expect.objectContaining({
          id: 'cue-1',
          servicePosition: 2,
          notes: ['Host ready'],
          startType: 'hard',
          hardStartTime: '09:00',
        }),
      ],
    });
  });

  it('includes dedicated studio clock URLs on share payloads', () => {
    expect(publicShareUrls('abc123', 'https://api.tallyconnect.app')).toMatchObject({
      url: 'https://api.tallyconnect.app/rundown/view/abc123',
      timer_url: 'https://api.tallyconnect.app/rundown/timer/abc123',
      clock_url: 'https://api.tallyconnect.app/rundown/clock/abc123',
      show_url: 'https://api.tallyconnect.app/rundown/show/abc123',
      share_token: 'abc123',
    });
  });

  it('maps LiveRundownManager state onto the legacy live-show payload', () => {
    const mapped = toLegacyLiveShowState({
      state: 'active',
      currentIndex: 3,
      currentCueIndex: 3,
      startedAt: 1000,
      currentItemStartedAt: 1500,
      isPaused: true,
      planId: 'plan-1',
      roomId: 'sanctuary',
      currentItem: { elapsedSeconds: 12 },
    }, { id: 'plan-1', title: 'Sunday' });

    expect(mapped).toMatchObject({
      isLive: true,
      is_live: true,
      currentCueIndex: 3,
      currentCueStartedAt: 1500,
      isPaused: true,
      planId: 'plan-1',
      roomId: 'sanctuary',
    });
  });
});
