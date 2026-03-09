import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyIntent } = require('../src/intent-classifier.js');

// ─── Command Intent Tests ─────────────────────────────────────────────────────

describe('Command intent classification', () => {
  const commands = [
    'cut to camera 2',
    'start recording',
    'mute channel 4',
    'switch to ProPresenter',
    'start stream',
    'stop all streams',
    'cam 1',
    'take',
    'go live',
    'fade to black',
    'macro 3',
    'dsk on',
    'next slide',
    'zoom in',
    'set scene Worship',
    'unmute master',
    'recall preset 2',
    'run macro 5',
    'press companion button',
    'route input 3 to output 1',
  ];

  for (const msg of commands) {
    it(`"${msg}" → command`, () => {
      const result = classifyIntent(msg);
      expect(result.intent).toBe('command');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }

  it('short single-word commands classified as command', () => {
    expect(classifyIntent('take').intent).toBe('command');
    expect(classifyIntent('auto').intent).toBe('command');
    expect(classifyIntent('cut').intent).toBe('command');
  });

  it('camera number shortcuts classified as command', () => {
    expect(classifyIntent('cam 1').intent).toBe('command');
    expect(classifyIntent('cam 3').intent).toBe('command');
    expect(classifyIntent('camera 2').intent).toBe('command');
  });

  it('high confidence for clear command patterns', () => {
    const result = classifyIntent('cut to camera 2');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// ─── Diagnostic Intent Tests ─────────────────────────────────────────────────

describe('Diagnostic intent classification', () => {
  const diagnostics = [
    'why is my stream dropping',
    'what happened during the service',
    'is my encoder healthy',
    'why did the stream restart',
    'how do I configure OBS for streaming',
    'what is the current bitrate',
    'explain how DSK works',
    'help me troubleshoot the audio',
    'can you diagnose the encoder issue',
    'why is there no audio on the stream',
    'tell me about ATEM transitions',
    'where is the PTZ camera config',
    'is the encoder dropping frames?',
    'should I restart the encoder',
    "I'm having problems with the stream",
    "what's wrong with the audio",
  ];

  for (const msg of diagnostics) {
    it(`"${msg}" → diagnostic`, () => {
      const result = classifyIntent(msg);
      expect(result.intent).toBe('diagnostic');
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }

  it('question mark triggers diagnostic', () => {
    expect(classifyIntent('is the stream ok?').intent).toBe('diagnostic');
    expect(classifyIntent('are we live?').intent).toBe('diagnostic');
  });

  it('troubleshooting keywords trigger diagnostic', () => {
    expect(classifyIntent('the stream keeps dropping').intent).toBe('diagnostic');
    expect(classifyIntent('encoder disconnected again').intent).toBe('diagnostic');
    expect(classifyIntent('audio silence detected').intent).toBe('diagnostic');
    expect(classifyIntent('video is frozen on screen').intent).toBe('diagnostic');
  });

  it('analysis keywords trigger diagnostic', () => {
    expect(classifyIntent('what happened last week').intent).toBe('diagnostic');
    expect(classifyIntent('recurring audio issues during the service').intent).toBe('diagnostic');
    expect(classifyIntent('is the encoder health trending down').intent).toBe('diagnostic');
  });
});

// ─── Ambiguous Intent Tests ─────────────────────────────────────────────────

describe('Ambiguous intent classification', () => {
  const ambiguous = [
    'check if we are live',
    'make sure audio is working',
    'verify the stream is up',
    'look at the encoder',
    'test the audio levels',
    'start stream but check if encoder is connected first and make sure audio is routed correctly',
  ];

  for (const msg of ambiguous) {
    it(`"${msg}" → ambiguous`, () => {
      const result = classifyIntent(msg);
      expect(result.intent).toBe('ambiguous');
      expect(result.confidence).toBeLessThan(0.7);
    });
  }

  it('ambiguous patterns have low confidence', () => {
    const result = classifyIntent('check if we are live');
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('empty string defaults to command', () => {
    const result = classifyIntent('');
    expect(result.intent).toBe('command');
  });

  it('null input defaults to command', () => {
    const result = classifyIntent(null);
    expect(result.intent).toBe('command');
  });

  it('undefined input defaults to command', () => {
    const result = classifyIntent(undefined);
    expect(result.intent).toBe('command');
  });

  it('single utility words are command intent', () => {
    expect(classifyIntent('help').intent).toBe('command');
    expect(classifyIntent('status').intent).toBe('command');
  });

  it('returns confidence as a number between 0 and 1', () => {
    const tests = ['cut to camera 1', 'why is my stream dropping', 'check the audio'];
    for (const msg of tests) {
      const result = classifyIntent(msg);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('returns a reason string', () => {
    const result = classifyIntent('cut to camera 1');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('mixed command verb + troubleshoot keyword → ambiguous', () => {
    // "stop the drops" has command verb "stop" but troubleshoot keyword "drops"
    const result = classifyIntent('stop the audio drops');
    expect(result.intent).toBe('ambiguous');
  });

  it('long command-like sentences → ambiguous', () => {
    // 5+ words starting with command verb
    const result = classifyIntent('set up the entire audio routing for the worship service tomorrow morning');
    expect(result.intent).toBe('ambiguous');
  });

  it('"that is a wrap" → command', () => {
    const result = classifyIntent("that's a wrap");
    expect(result.intent).toBe('command');
  });

  it('"we are done" → command', () => {
    const result = classifyIntent("we're done");
    expect(result.intent).toBe('command');
  });
});

// ─── Result Shape Tests ──────────────────────────────────────────────────────

describe('Result shape', () => {
  it('always returns intent, confidence, and reason', () => {
    const inputs = [
      'cut to camera 1',
      'why is the stream down',
      'check if audio is working',
      '',
      null,
      'a',
    ];

    for (const input of inputs) {
      const result = classifyIntent(input);
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reason');
      expect(['command', 'diagnostic', 'ambiguous']).toContain(result.intent);
    }
  });
});
