import { describe, it, expect } from 'vitest';

import statusUtilsModule from '../src/status-utils.js';

const { hasStreamSignal, isStreamActive, isRecordingActive } = statusUtilsModule;

describe('status-utils', () => {
  it('treats encoder.live as an active stream signal', () => {
    const status = { encoder: { connected: true, live: true } };
    expect(hasStreamSignal(status)).toBe(true);
    expect(isStreamActive(status)).toBe(true);
  });

  it('detects HyperDeck recording from aggregated deck arrays', () => {
    const status = {
      hyperdecks: [
        { status: 'stop', recording: false },
        { status: 'record', recording: true },
      ],
    };
    expect(isRecordingActive(status)).toBe(true);
  });

  it('returns false when no stream or recording indicators are present', () => {
    const status = { atem: { connected: true }, encoder: { connected: true, live: false } };
    expect(isStreamActive(status)).toBe(false);
    expect(isRecordingActive(status)).toBe(false);
  });
});
