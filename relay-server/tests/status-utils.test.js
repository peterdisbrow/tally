import { describe, it, expect } from 'vitest';

import statusUtilsModule from '../src/status-utils.js';

const {
  hasStreamSignal,
  isStreamActive,
  isRecordingActive,
  isHyperDeckRecording,
  getStreamBitrate,
  getStreamFps,
} = statusUtilsModule;

describe('isStreamActive', () => {
  it('detects OBS streaming', () => {
    expect(isStreamActive({ obs: { streaming: true } })).toBe(true);
  });

  it('detects vMix streaming', () => {
    expect(isStreamActive({ vmix: { streaming: true } })).toBe(true);
  });

  it('detects ATEM streaming', () => {
    expect(isStreamActive({ atem: { streaming: true } })).toBe(true);
  });

  it('detects encoder.live', () => {
    expect(isStreamActive({ encoder: { live: true } })).toBe(true);
  });

  it('detects encoder.streaming', () => {
    expect(isStreamActive({ encoder: { streaming: true } })).toBe(true);
  });

  it('returns false when all streaming flags are false', () => {
    expect(isStreamActive({ obs: { streaming: false }, vmix: { streaming: false } })).toBe(false);
  });

  it('returns false for empty status', () => {
    expect(isStreamActive({})).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isStreamActive()).toBe(false);
  });
});

describe('hasStreamSignal', () => {
  it('returns true when obs.streaming is a boolean', () => {
    expect(hasStreamSignal({ obs: { streaming: false } })).toBe(true);
  });

  it('returns true when vmix.streaming is a boolean', () => {
    expect(hasStreamSignal({ vmix: { streaming: false } })).toBe(true);
  });

  it('returns true when atem.streaming is a boolean', () => {
    expect(hasStreamSignal({ atem: { streaming: true } })).toBe(true);
  });

  it('returns true when encoder.live is a boolean', () => {
    expect(hasStreamSignal({ encoder: { live: false } })).toBe(true);
  });

  it('returns true when encoder.streaming is a boolean', () => {
    expect(hasStreamSignal({ encoder: { streaming: true } })).toBe(true);
  });

  it('returns false when no stream fields are present', () => {
    expect(hasStreamSignal({ atem: { connected: true } })).toBe(false);
  });
});

describe('isRecordingActive', () => {
  it('detects ATEM recording', () => {
    expect(isRecordingActive({ atem: { recording: true } })).toBe(true);
  });

  it('detects OBS recording', () => {
    expect(isRecordingActive({ obs: { recording: true } })).toBe(true);
  });

  it('detects vMix recording', () => {
    expect(isRecordingActive({ vmix: { recording: true } })).toBe(true);
  });

  it('detects encoder recording', () => {
    expect(isRecordingActive({ encoder: { recording: true } })).toBe(true);
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

  it('returns false when no recording indicators are present', () => {
    expect(isRecordingActive({ atem: { connected: true }, encoder: { live: false } })).toBe(false);
  });

  it('returns false for empty status', () => {
    expect(isRecordingActive({})).toBe(false);
  });
});

describe('isHyperDeckRecording', () => {
  it('detects via hyperdeck.recording boolean', () => {
    expect(isHyperDeckRecording({ hyperdeck: { recording: true } })).toBe(true);
  });

  it('detects via hyperDeck.recording boolean (capital D)', () => {
    expect(isHyperDeckRecording({ hyperDeck: { recording: true } })).toBe(true);
  });

  it('detects via hyperdecks array with recording flag', () => {
    expect(isHyperDeckRecording({ hyperdecks: [{ recording: true }] })).toBe(true);
  });

  it('detects via hyperdeck.decks array with recording flag', () => {
    expect(isHyperDeckRecording({ hyperdeck: { decks: [{ recording: true }] } })).toBe(true);
  });

  it('detects via hyperDecks array (capital D)', () => {
    expect(isHyperDeckRecording({ hyperDecks: [{ recording: true }] })).toBe(true);
  });

  it('detects via deck transport state "record"', () => {
    expect(isHyperDeckRecording({ hyperdecks: [{ transport: 'record' }] })).toBe(true);
  });

  it('detects via deck status "recording"', () => {
    expect(isHyperDeckRecording({ hyperdecks: [{ status: 'recording' }] })).toBe(true);
  });

  it('returns false when deck is stopped', () => {
    expect(isHyperDeckRecording({ hyperdecks: [{ status: 'stop', recording: false }] })).toBe(false);
  });

  it('skips null/non-object deck entries', () => {
    expect(isHyperDeckRecording({ hyperdecks: [null, { recording: true }] })).toBe(true);
  });

  it('returns false for empty status', () => {
    expect(isHyperDeckRecording({})).toBe(false);
  });

  it('returns false for empty decks array', () => {
    expect(isHyperDeckRecording({ hyperdecks: [] })).toBe(false);
  });
});

describe('getStreamBitrate', () => {
  it('returns OBS bitrate when OBS is streaming', () => {
    const result = getStreamBitrate({ obs: { streaming: true, bitrate: 5000 } });
    expect(result).toEqual({ bitrateKbps: 5000, source: 'obs' });
  });

  it('returns ATEM bitrate when ATEM is streaming', () => {
    const result = getStreamBitrate({ atem: { streaming: true, streamingBitrate: 6000000 } });
    expect(result).toEqual({ bitrateKbps: 6000, source: 'atem' });
  });

  it('returns encoder bitrate via encoder.live', () => {
    const result = getStreamBitrate({ encoder: { live: true, bitrateKbps: 4000, type: 'teradek' } });
    expect(result).toEqual({ bitrateKbps: 4000, source: 'teradek' });
  });

  it('returns encoder bitrate via encoder.streaming with default type', () => {
    const result = getStreamBitrate({ encoder: { streaming: true, bitrateKbps: 3000 } });
    expect(result).toEqual({ bitrateKbps: 3000, source: 'encoder' });
  });

  it('returns null when OBS bitrate is 0', () => {
    expect(getStreamBitrate({ obs: { streaming: true, bitrate: 0 } })).toBeNull();
  });

  it('returns null when nothing is active', () => {
    expect(getStreamBitrate({})).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(getStreamBitrate()).toBeNull();
  });
});

describe('getStreamFps', () => {
  it('returns OBS fps when streaming', () => {
    const result = getStreamFps({ obs: { streaming: true, fps: 30 } });
    expect(result).toEqual({ fps: 30, source: 'obs' });
  });

  it('returns encoder fps via encoder.live', () => {
    const result = getStreamFps({ encoder: { live: true, fps: 60, type: 'teradek' } });
    expect(result).toEqual({ fps: 60, source: 'teradek' });
  });

  it('returns encoder fps with default source when type not set', () => {
    const result = getStreamFps({ encoder: { streaming: true, fps: 29 } });
    expect(result).toEqual({ fps: 29, source: 'encoder' });
  });

  it('returns null when OBS fps is 0', () => {
    expect(getStreamFps({ obs: { streaming: true, fps: 0 } })).toBeNull();
  });

  it('returns null when nothing is streaming', () => {
    expect(getStreamFps({})).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(getStreamFps()).toBeNull();
  });
});
