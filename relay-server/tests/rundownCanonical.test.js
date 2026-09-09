import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeShareRole,
  isOperatorShare,
  manualPlanToLivePlan,
  toLegacyLiveShowState,
  publicShareUrls,
  decorateShare,
  legacyViewDisplayRedirect,
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

  it('packs every dedicated production-display URL on share payloads', () => {
    expect(publicShareUrls('abc123', 'https://api.tallyconnect.app')).toEqual({
      url: 'https://api.tallyconnect.app/rundown/view/abc123',
      timer_url: 'https://api.tallyconnect.app/rundown/timer/abc123',
      clock_url: 'https://api.tallyconnect.app/rundown/clock/abc123',
      prompter_url: 'https://api.tallyconnect.app/rundown/prompter/abc123',
      confidence_url: 'https://api.tallyconnect.app/rundown/confidence/abc123',
      show_url: 'https://api.tallyconnect.app/rundown/show/abc123',
      share_token: 'abc123',
    });
  });

  it('keeps display and operator share URLs on their own tokens', () => {
    const display = decorateShare({ token: 'disp-1', role: 'display' }, 'https://api.tallyconnect.app');
    const operator = decorateShare({ token: 'op-1', role: 'operator' }, 'https://api.tallyconnect.app');

    expect(display.role).toBe('display');
    expect(display.prompter_url).toBe('https://api.tallyconnect.app/rundown/prompter/disp-1');
    expect(display.confidence_url).toBe('https://api.tallyconnect.app/rundown/confidence/disp-1');
    expect(display.clock_url).toBe('https://api.tallyconnect.app/rundown/clock/disp-1');
    expect(display.show_url).toBe('https://api.tallyconnect.app/rundown/show/disp-1');
    expect(operator.show_url).toBe('https://api.tallyconnect.app/rundown/show/op-1');
    expect(display.prompter_url).not.toContain('op-1');
    expect(operator.prompter_url).not.toContain('disp-1');
  });

  it('redirects only legacy view query modes that lack a view-page implementation', () => {
    expect(legacyViewDisplayRedirect('abc123', { mode: 'clock', theme: 'light' }))
      .toBe('/rundown/clock/abc123?theme=light');
    expect(legacyViewDisplayRedirect('abc123', { mode: 'teleprompter' }))
      .toBe('/rundown/prompter/abc123');
    expect(legacyViewDisplayRedirect('abc123', { mode: 'confidence', theme: 'dark' }))
      .toBe('/rundown/confidence/abc123?theme=dark');
    expect(legacyViewDisplayRedirect('abc123', { mode: 'prompter' })).toBeNull();
    expect(legacyViewDisplayRedirect('abc123', { mode: 'compact' })).toBeNull();
    expect(legacyViewDisplayRedirect('abc123', {})).toBeNull();
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
