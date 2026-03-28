import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { smartParse } = require('../src/smart-parser.js');

// ─── Status fixtures ─────────────────────────────────────────────────────────

const ATEM_ONLY = { atem: { connected: true } };
const ATEM_STREAMING = { atem: { connected: true, streaming: true } };
const ATEM_RECORDING = { atem: { connected: true, recording: true } };
const ATEM_LIVE_AND_REC = { atem: { connected: true, streaming: true, recording: true } };
const ENCODER_ONLY = { encoder: { connected: true } };
const ENCODER_LIVE = { encoder: { connected: true, live: true } };
const OBS_ONLY = { obs: { connected: true } };
const OBS_STREAMING = { obs: { connected: true, streaming: true } };
const OBS_RECORDING = { obs: { connected: true, recording: true } };
const MULTI_STREAM = { encoder: { connected: true }, obs: { connected: true }, atem: { connected: true } };
const MULTI_RECORD = { obs: { connected: true }, atem: { connected: true }, hyperdeck: { connected: true } };
const VMIX_ONLY = { vmix: { connected: true } };
const VMIX_STREAMING = { vmix: { connected: true, streaming: true } };
const HYPERDECK_ONLY = { hyperdeck: { connected: true } };
const NO_DEVICES = {};
const ALL_LIVE = {
  encoder: { connected: true, live: true, streaming: true, recording: true },
  obs: { connected: true, streaming: true, recording: true },
  vmix: { connected: true, streaming: true, recording: true },
  atem: { connected: true, streaming: true, recording: true },
};

// ─── A. Social phrases ───────────────────────────────────────────────────────

describe('Social phrases', () => {
  const phrases = [
    'thanks', 'thank you', 'thx', 'ty', 'awesome', 'perfect', 'great',
    'good job', 'nice', 'nice one', 'cool', 'ok', 'okay', 'got it',
    'understood', 'roger', 'copy that', '10-4', 'will do', 'sounds good',
    'bet', 'word', 'yep', 'yup', 'nope', 'no worries', 'all good', 'np',
    'Thanks!', 'THANKS', 'thanks!!', 'thanks.', 'thank you!',
  ];

  for (const phrase of phrases) {
    it(`"${phrase}" → chat reply`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('chat');
      expect(result.text).toBeTruthy();
    });
  }

  it('does not match non-social phrases', () => {
    expect(smartParse('cut to camera 1', ATEM_ONLY)).toBeNull();
    expect(smartParse('thanks for cutting', ATEM_ONLY)).toBeNull();
  });
});

// ─── B. Status questions ─────────────────────────────────────────────────────

describe('Stream status questions', () => {
  const phrases = [
    'are we live', 'are we live?', 'are we streaming?', 'are we on air',
    'is the stream up', 'is the stream on?', 'is stream running',
    'stream status', 'streaming status', 'are we on?', 'are we on air?',
  ];

  for (const phrase of phrases) {
    it(`"${phrase}" when live → positive reply`, () => {
      const result = smartParse(phrase, ATEM_STREAMING);
      expect(result).not.toBeNull();
      expect(result.type).toBe('chat');
      expect(result.text).toMatch(/yes/i);
    });

    it(`"${phrase}" when idle → negative reply`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('chat');
      expect(result.text).toMatch(/no/i);
    });
  }

  it('identifies streaming source (encoder)', () => {
    const result = smartParse('are we live?', ENCODER_LIVE);
    expect(result.text).toContain('encoder');
  });

  it('identifies streaming source (OBS)', () => {
    const result = smartParse('are we live?', OBS_STREAMING);
    expect(result.text).toContain('OBS');
  });
});

describe('Recording status questions', () => {
  const phrases = [
    'are we recording', 'are we recording?', 'is recording on',
    'recording status', 'is the recording active',
  ];

  for (const phrase of phrases) {
    it(`"${phrase}" when recording → positive`, () => {
      const result = smartParse(phrase, ATEM_RECORDING);
      expect(result).not.toBeNull();
      expect(result.type).toBe('chat');
      expect(result.text).toMatch(/yes/i);
    });

    it(`"${phrase}" when idle → negative`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('chat');
      expect(result.text).toMatch(/no/i);
    });
  }
});

// ─── C. Generic streaming start/stop ─────────────────────────────────────────

describe('Generic streaming start/stop', () => {
  const startPhrases = ['start streaming', 'start stream', 'begin streaming', 'go live', 'go streaming'];
  const stopPhrases = ['stop streaming', 'stop stream', 'end streaming', 'kill streaming'];

  for (const phrase of startPhrases) {
    it(`"${phrase}" with encoder → encoder.startStream`, () => {
      const result = smartParse(phrase, ENCODER_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('command');
      expect(result.command).toBe('encoder.startStream');
    });

    it(`"${phrase}" with OBS → obs.startStream`, () => {
      const result = smartParse(phrase, OBS_ONLY);
      expect(result.command).toBe('obs.startStream');
    });

    it(`"${phrase}" with vMix → vmix.startStream`, () => {
      const result = smartParse(phrase, VMIX_ONLY);
      expect(result.command).toBe('vmix.startStream');
    });

    it(`"${phrase}" with ATEM only → atem.startStreaming`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result.command).toBe('atem.startStreaming');
    });

    it(`"${phrase}" with multi-device → encoder (highest priority)`, () => {
      const result = smartParse(phrase, MULTI_STREAM);
      expect(result.command).toBe('encoder.startStream');
    });

    it(`"${phrase}" with no devices → encoder.startStream (fallback)`, () => {
      const result = smartParse(phrase, NO_DEVICES);
      expect(result).not.toBeNull();
      expect(result.command).toBe('encoder.startStream');
    });
  }

  for (const phrase of stopPhrases) {
    it(`"${phrase}" with encoder → encoder.stopStream`, () => {
      const result = smartParse(phrase, ENCODER_ONLY);
      expect(result.command).toBe('encoder.stopStream');
    });
  }
});

// ─── D. Generic recording start/stop ─────────────────────────────────────────

describe('Generic recording start/stop', () => {
  // Priority: hyperdeck > atem > encoder > vmix > obs
  it('"start recording" with OBS → obs.startRecording', () => {
    expect(smartParse('start recording', OBS_ONLY).command).toBe('obs.startRecording');
  });

  it('"start recording" with HyperDeck → hyperdeck.record', () => {
    expect(smartParse('start recording', HYPERDECK_ONLY).command).toBe('hyperdeck.record');
  });

  it('"start recording" with ATEM → atem.startRecording', () => {
    expect(smartParse('start recording', ATEM_ONLY).command).toBe('atem.startRecording');
  });

  it('"start recording" with multi → hyperdeck (highest priority)', () => {
    expect(smartParse('start recording', MULTI_RECORD).command).toBe('hyperdeck.record');
  });

  it('"stop recording" with OBS → obs.stopRecording', () => {
    expect(smartParse('stop recording', OBS_ONLY).command).toBe('obs.stopRecording');
  });

  it('"stop recording" with HyperDeck → hyperdeck.stop', () => {
    expect(smartParse('stop recording', HYPERDECK_ONLY).command).toBe('hyperdeck.stop');
  });

  it('"begin recording" works', () => {
    const result = smartParse('begin recording', ATEM_ONLY);
    expect(result.command).toBe('atem.startRecording');
  });

  it('"end recording" works', () => {
    const result = smartParse('end recording', ATEM_ONLY);
    expect(result.command).toBe('atem.stopRecording');
  });

  it('no devices → null', () => {
    expect(smartParse('start recording', NO_DEVICES)).toBeNull();
  });
});

// ─── E. Multi-device "all" commands ──────────────────────────────────────────

describe('Multi-device "all" commands', () => {
  it('"start all streams" → multi-step for all connected devices', () => {
    const result = smartParse('start all streams', MULTI_STREAM);
    expect(result.type).toBe('commands');
    expect(result.steps).toHaveLength(3);
    expect(result.steps.map(s => s.command)).toEqual([
      'encoder.startStream', 'obs.startStream', 'atem.startStreaming',
    ]);
  });

  it('"stop all streams" → multi-step', () => {
    const result = smartParse('stop all streams', MULTI_STREAM);
    expect(result.type).toBe('commands');
    expect(result.steps.map(s => s.command)).toEqual([
      'encoder.stopStream', 'obs.stopStream', 'atem.stopStreaming',
    ]);
  });

  it('"start all recordings" with HyperDeck uses hyperdeck.record', () => {
    const result = smartParse('start all recordings', MULTI_RECORD);
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('hyperdeck.record');
    expect(cmds).toContain('obs.startRecording');
    expect(cmds).toContain('atem.startRecording');
  });

  it('"stop all recordings" with HyperDeck uses hyperdeck.stop', () => {
    const result = smartParse('stop all recordings', MULTI_RECORD);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('hyperdeck.stop');
  });

  it('no devices → null', () => {
    expect(smartParse('start all streams', NO_DEVICES)).toBeNull();
  });

  it('"start all encoders" variant', () => {
    const result = smartParse('start all encoders', MULTI_STREAM);
    expect(result.type).toBe('commands');
  });

  it('"go all streaming" variant', () => {
    const result = smartParse('go all streaming', MULTI_STREAM);
    expect(result.type).toBe('commands');
  });
});

// ─── F. End-of-service workflow ──────────────────────────────────────────────

describe('End-of-service workflow', () => {
  const phrases = [
    "we're done", "we are done", "end service", "end the service",
    "finish the service", "wrap up", "wrap it up", "that's a wrap",
    "thats a wrap", "all done", "service over", "service ended",
    "conclude the service", "end the show", "finish the broadcast",
    "wrap up the event",
  ];

  for (const phrase of phrases) {
    it(`"${phrase}" with live ATEM → fadeToBlack + stop`, () => {
      const result = smartParse(phrase, ATEM_LIVE_AND_REC);
      expect(result).not.toBeNull();
      expect(result.type).toBe('commands');
      const cmds = result.steps.map(s => s.command);
      expect(cmds).toContain('atem.fadeToBlack');
      expect(cmds).toContain('atem.stopStreaming');
      expect(cmds).toContain('atem.stopRecording');
    });
  }

  it('stops all active devices', () => {
    const result = smartParse("we're done", ALL_LIVE);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('atem.fadeToBlack');
    expect(cmds).toContain('encoder.stopStream');
    expect(cmds).toContain('obs.stopStream');
    expect(cmds).toContain('obs.stopRecording');
    expect(cmds).toContain('vmix.stopStream');
    expect(cmds).toContain('vmix.stopRecording');
    expect(cmds).toContain('atem.stopStreaming');
    expect(cmds).toContain('atem.stopRecording');
    expect(cmds).toContain('encoder.stopRecording');
  });

  it('nothing active → chat acknowledgment', () => {
    const result = smartParse("we're done", NO_DEVICES);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/already stopped/i);
  });

  it('ATEM connected but nothing streaming → just FTB', () => {
    const result = smartParse("we're done", ATEM_ONLY);
    expect(result.type).toBe('commands');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].command).toBe('atem.fadeToBlack');
  });
});

// ─── G. Generic status / pre-service check ───────────────────────────────────

describe('Status / pre-service check', () => {
  const phrases = [
    'status', 'status?', 'check everything', 'check all',
    'check systems', 'pre-service check', 'preservice check',
    'systems check', 'system check', 'run a check', 'run check',
  ];

  for (const phrase of phrases) {
    it(`"${phrase}" → preServiceCheck`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('command');
      expect(result.command).toBe('preServiceCheck');
    });
  }
});

// ─── H. ATEM audio mute/unmute headphone/monitor ────────────────────────────

describe('ATEM headphone/monitor mute (bug fix)', () => {
  // ── Mute phrases that should hit smart parser ──
  const mutePhrases = [
    'mute headphone mix',
    'mute headphones',
    'mute headphone',
    'mute monitor',
    'mute monitor output',
    'mute the headphone mix',
    'mute the headphones',
    'mute the monitor',
    'mute the monitor output',
    'mute headphone output',
    'Mute Headphone Mix',
    'MUTE HEADPHONES',
    'mute headphone mix!',
    'mute headphone mix.',
  ];

  for (const phrase of mutePhrases) {
    it(`"${phrase}" → setClassicAudioMonitorProps mute:true`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('command');
      expect(result.command).toBe('atem.setClassicAudioMonitorProps');
      expect(result.params).toEqual({ mute: true });
    });
  }

  // ── Unmute phrases ──
  const unmutePhrases = [
    'unmute headphone mix',
    'unmute headphones',
    'unmute headphone',
    'unmute monitor',
    'unmute monitor output',
    'unmute the headphone mix',
    'unmute the headphones',
    'unmute the monitor',
    'unmute the monitor output',
    'unmute headphone output',
    'Unmute Headphone Mix',
    'UNMUTE HEADPHONES',
    'unmute headphone mix!',
  ];

  for (const phrase of unmutePhrases) {
    it(`"${phrase}" → setClassicAudioMonitorProps mute:false`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      expect(result).not.toBeNull();
      expect(result.type).toBe('command');
      expect(result.command).toBe('atem.setClassicAudioMonitorProps');
      expect(result.params).toEqual({ mute: false });
    });
  }

  // ── Must NOT match these (should fall through to AI) ──
  const nonMatches = [
    'mute channel 1',              // mixer channel, not headphone
    'mute the master',             // master, not headphone
    'mute input 1',                // input, not headphone
    'please mute the headphones',  // "please" prefix breaks regex
    'can you mute headphones',     // conversational → AI handles it
    'turn off the headphone mix',  // different verb → AI
    'mute',                        // too generic
  ];

  for (const phrase of nonMatches) {
    it(`"${phrase}" → null (falls through to AI)`, () => {
      const result = smartParse(phrase, ATEM_ONLY);
      // Either null or a different command, but NOT setClassicAudioMonitorProps
      if (result !== null) {
        expect(result.command).not.toBe('atem.setClassicAudioMonitorProps');
      }
    });
  }

  // ── No ATEM connected → null ──
  it('mute headphone with no ATEM → null', () => {
    expect(smartParse('mute headphone mix', NO_DEVICES)).toBeNull();
  });

  it('unmute headphone with no ATEM → null', () => {
    expect(smartParse('unmute headphone mix', NO_DEVICES)).toBeNull();
  });

  // ── Must NEVER use wrong commands (the original bug) ──
  it('never routes headphone mute to setClassicAudioHeadphonesProps', () => {
    const result = smartParse('mute headphone mix', ATEM_ONLY);
    expect(result.command).not.toBe('atem.setClassicAudioHeadphonesProps');
  });

  it('never routes headphone unmute to setClassicAudioResetPeaks', () => {
    const result = smartParse('unmute headphone mix', ATEM_ONLY);
    expect(result.command).not.toBe('atem.setClassicAudioResetPeaks');
  });
});

// ─── I. Encoder-specific routing ─────────────────────────────────────────────

describe('Encoder-specific routing', () => {
  const ENCODER_ONLY = { encoder: { connected: true } };
  const ENCODER_LIVE = { encoder: { connected: true, live: true } };
  const ENCODER_STREAMING = { encoder: { connected: true, streaming: true } };
  const ENCODER_RECORDING = { encoder: { connected: true, recording: true } };
  const ENCODER_FULL = { encoder: { connected: true, live: true, streaming: true, recording: true } };

  // ── Streaming ──
  const streamStartPhrases = ['start streaming', 'start stream', 'begin streaming', 'go live'];
  for (const phrase of streamStartPhrases) {
    it(`"${phrase}" with encoder → encoder.startStream`, () => {
      expect(smartParse(phrase, ENCODER_ONLY).command).toBe('encoder.startStream');
    });
  }

  const streamStopPhrases = ['stop streaming', 'stop stream', 'end streaming', 'kill streaming'];
  for (const phrase of streamStopPhrases) {
    it(`"${phrase}" with encoder → encoder.stopStream`, () => {
      expect(smartParse(phrase, ENCODER_ONLY).command).toBe('encoder.stopStream');
    });
  }

  // ── Recording ──
  it('"start recording" with encoder → encoder.startRecording', () => {
    expect(smartParse('start recording', ENCODER_ONLY).command).toBe('encoder.startRecording');
  });

  it('"stop recording" with encoder → encoder.stopRecording', () => {
    expect(smartParse('stop recording', ENCODER_ONLY).command).toBe('encoder.stopRecording');
  });

  it('"begin recording" with encoder → encoder.startRecording', () => {
    expect(smartParse('begin recording', ENCODER_ONLY).command).toBe('encoder.startRecording');
  });

  it('"end recording" with encoder → encoder.stopRecording', () => {
    expect(smartParse('end recording', ENCODER_ONLY).command).toBe('encoder.stopRecording');
  });

  // ── Status questions ──
  it('"are we live?" with encoder live → yes, mentions encoder', () => {
    const result = smartParse('are we live?', ENCODER_LIVE);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/yes/i);
    expect(result.text).toContain('encoder');
  });

  it('"are we live?" with encoder streaming → yes', () => {
    const result = smartParse('are we live?', ENCODER_STREAMING);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/yes/i);
  });

  it('"are we live?" with encoder idle → no', () => {
    const result = smartParse('are we live?', ENCODER_ONLY);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/no/i);
  });

  // ── End-of-service ──
  it('"we\'re done" stops encoder stream + recording when both active', () => {
    const result = smartParse("we're done", ENCODER_FULL);
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopStream');
    expect(cmds).toContain('encoder.stopRecording');
  });

  it('"we\'re done" stops only stream when encoder is live but not recording', () => {
    const result = smartParse("we're done", { encoder: { connected: true, live: true, streaming: true } });
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopStream');
    expect(cmds).not.toContain('encoder.stopRecording');
  });

  it('"we\'re done" stops only recording when encoder is recording but not streaming', () => {
    const result = smartParse("we're done", ENCODER_RECORDING);
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).not.toContain('encoder.stopStream');
    expect(cmds).toContain('encoder.stopRecording');
  });

  // ── Priority: encoder is #1 for streaming ──
  it('encoder beats obs for streaming', () => {
    const r = smartParse('go live', { encoder: { connected: true }, obs: { connected: true } });
    expect(r.command).toBe('encoder.startStream');
  });

  it('encoder beats vmix for streaming', () => {
    const r = smartParse('go live', { encoder: { connected: true }, vmix: { connected: true } });
    expect(r.command).toBe('encoder.startStream');
  });

  it('encoder beats atem for streaming', () => {
    const r = smartParse('go live', { encoder: { connected: true }, atem: { connected: true } });
    expect(r.command).toBe('encoder.startStream');
  });

  // ── Priority: encoder is #3 for recording (after hyperdeck, atem) ──
  it('hyperdeck beats encoder for recording', () => {
    const r = smartParse('start recording', { hyperdeck: { connected: true }, encoder: { connected: true } });
    expect(r.command).toBe('hyperdeck.record');
  });

  it('atem beats encoder for recording', () => {
    const r = smartParse('start recording', { atem: { connected: true }, encoder: { connected: true } });
    expect(r.command).toBe('atem.startRecording');
  });

  it('encoder beats vmix for recording', () => {
    const r = smartParse('start recording', { encoder: { connected: true }, vmix: { connected: true } });
    expect(r.command).toBe('encoder.startRecording');
  });

  it('encoder beats obs for recording', () => {
    const r = smartParse('start recording', { encoder: { connected: true }, obs: { connected: true } });
    expect(r.command).toBe('encoder.startRecording');
  });

  // ── Multi-device "all" includes encoder ──
  it('"start all streams" includes encoder', () => {
    const result = smartParse('start all streams', { encoder: { connected: true }, obs: { connected: true } });
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.startStream');
    expect(cmds).toContain('obs.startStream');
  });

  it('"stop all streams" includes encoder', () => {
    const result = smartParse('stop all streams', { encoder: { connected: true }, vmix: { connected: true } });
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopStream');
    expect(cmds).toContain('vmix.stopStream');
  });

  it('"start all recordings" includes encoder', () => {
    const result = smartParse('start all recordings', { encoder: { connected: true }, obs: { connected: true } });
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.startRecording');
    expect(cmds).toContain('obs.startRecording');
  });

  it('"stop all recordings" includes encoder', () => {
    const result = smartParse('stop all recordings', { encoder: { connected: true }, atem: { connected: true } });
    expect(result.type).toBe('commands');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('encoder.stopRecording');
    expect(cmds).toContain('atem.stopRecording');
  });
});

// ─── J. vMix-specific routing ────────────────────────────────────────────────

describe('vMix-specific routing', () => {
  const VMIX_ONLY = { vmix: { connected: true } };
  const VMIX_LIVE = { vmix: { connected: true, streaming: true, recording: true } };

  it('"go live" with vMix → vmix.startStream', () => {
    expect(smartParse('go live', VMIX_ONLY).command).toBe('vmix.startStream');
  });

  it('"stop streaming" with vMix → vmix.stopStream', () => {
    expect(smartParse('stop streaming', VMIX_ONLY).command).toBe('vmix.stopStream');
  });

  it('"start recording" with vMix → vmix.startRecording', () => {
    expect(smartParse('start recording', VMIX_ONLY).command).toBe('vmix.startRecording');
  });

  it('"stop recording" with vMix → vmix.stopRecording', () => {
    expect(smartParse('stop recording', VMIX_ONLY).command).toBe('vmix.stopRecording');
  });

  it('"are we live?" with vMix streaming → yes, mentions vMix', () => {
    const result = smartParse('are we live?', { vmix: { connected: true, streaming: true } });
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/yes/i);
    expect(result.text).toContain('vMix');
  });

  it('"we\'re done" stops vMix stream + recording', () => {
    const result = smartParse("we're done", VMIX_LIVE);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('vmix.stopStream');
    expect(cmds).toContain('vmix.stopRecording');
  });

  // Priority tests
  it('obs beats vmix for streaming', () => {
    const r = smartParse('go live', { obs: { connected: true }, vmix: { connected: true } });
    expect(r.command).toBe('obs.startStream');
  });

  it('vmix beats obs for recording', () => {
    const r = smartParse('start recording', { vmix: { connected: true }, obs: { connected: true } });
    expect(r.command).toBe('vmix.startRecording');
  });
});

// ─── K. OBS-specific routing ─────────────────────────────────────────────────

describe('OBS-specific routing', () => {
  const OBS_LIVE = { obs: { connected: true, streaming: true, recording: true } };

  it('"go live" with OBS → obs.startStream', () => {
    expect(smartParse('go live', OBS_ONLY).command).toBe('obs.startStream');
  });

  it('"stop streaming" with OBS → obs.stopStream', () => {
    expect(smartParse('stop streaming', OBS_ONLY).command).toBe('obs.stopStream');
  });

  it('"start recording" with OBS → obs.startRecording', () => {
    expect(smartParse('start recording', OBS_ONLY).command).toBe('obs.startRecording');
  });

  it('"stop recording" with OBS → obs.stopRecording', () => {
    expect(smartParse('stop recording', OBS_ONLY).command).toBe('obs.stopRecording');
  });

  it('"are we live?" with OBS streaming → yes, mentions OBS', () => {
    const result = smartParse('are we live?', OBS_STREAMING);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/yes/i);
    expect(result.text).toContain('OBS');
  });

  it('"we\'re done" stops OBS stream + recording', () => {
    const result = smartParse("we're done", OBS_LIVE);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('obs.stopStream');
    expect(cmds).toContain('obs.stopRecording');
  });
});

// ─── L. HyperDeck-specific routing ──────────────────────────────────────────

describe('HyperDeck-specific routing', () => {
  it('"start recording" → hyperdeck.record', () => {
    expect(smartParse('start recording', HYPERDECK_ONLY).command).toBe('hyperdeck.record');
  });

  it('"stop recording" → hyperdeck.stop', () => {
    expect(smartParse('stop recording', HYPERDECK_ONLY).command).toBe('hyperdeck.stop');
  });

  it('hyperdeck beats everything for recording', () => {
    const all = { hyperdeck: { connected: true }, atem: { connected: true }, encoder: { connected: true }, vmix: { connected: true }, obs: { connected: true } };
    expect(smartParse('start recording', all).command).toBe('hyperdeck.record');
  });

  it('"start all recordings" includes hyperdeck.record', () => {
    const result = smartParse('start all recordings', MULTI_RECORD);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('hyperdeck.record');
  });

  it('"stop all recordings" includes hyperdeck.stop', () => {
    const result = smartParse('stop all recordings', MULTI_RECORD);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('hyperdeck.stop');
  });
});

// ─── M. ATEM-specific routing ───────────────────────────────────────────────

describe('ATEM-specific routing', () => {
  it('"go live" with ATEM only → atem.startStreaming (not startStream)', () => {
    expect(smartParse('go live', ATEM_ONLY).command).toBe('atem.startStreaming');
  });

  it('"stop streaming" with ATEM → atem.stopStreaming', () => {
    expect(smartParse('stop streaming', ATEM_ONLY).command).toBe('atem.stopStreaming');
  });

  it('"start recording" with ATEM → atem.startRecording', () => {
    expect(smartParse('start recording', ATEM_ONLY).command).toBe('atem.startRecording');
  });

  it('"stop recording" with ATEM → atem.stopRecording', () => {
    expect(smartParse('stop recording', ATEM_ONLY).command).toBe('atem.stopRecording');
  });

  it('"are we live?" with ATEM streaming → yes, mentions ATEM', () => {
    const result = smartParse('are we live?', ATEM_STREAMING);
    expect(result.type).toBe('chat');
    expect(result.text).toMatch(/yes/i);
    expect(result.text).toContain('ATEM');
  });

  it('"we\'re done" with ATEM: fadeToBlack first, then stop stream/recording', () => {
    const result = smartParse("we're done", ATEM_LIVE_AND_REC);
    expect(result.steps[0].command).toBe('atem.fadeToBlack');
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('atem.stopStreaming');
    expect(cmds).toContain('atem.stopRecording');
  });

  it('ATEM is last priority for streaming', () => {
    const all = { encoder: { connected: true }, obs: { connected: true }, vmix: { connected: true }, atem: { connected: true } };
    expect(smartParse('go live', all).command).toBe('encoder.startStream');
  });

  it('"start all streams" uses atem.startStreaming (not startStream)', () => {
    const result = smartParse('start all streams', MULTI_STREAM);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('atem.startStreaming');
    expect(cmds).not.toContain('atem.startStream');
  });

  it('"stop all streams" uses atem.stopStreaming', () => {
    const result = smartParse('stop all streams', MULTI_STREAM);
    const cmds = result.steps.map(s => s.command);
    expect(cmds).toContain('atem.stopStreaming');
    expect(cmds).not.toContain('atem.stopStream');
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('null input → null', () => {
    expect(smartParse(null, ATEM_ONLY)).toBeNull();
  });

  it('empty string → null', () => {
    expect(smartParse('', ATEM_ONLY)).toBeNull();
  });

  it('whitespace only → null', () => {
    expect(smartParse('   ', ATEM_ONLY)).toBeNull();
  });

  it('undefined input → null', () => {
    expect(smartParse(undefined, ATEM_ONLY)).toBeNull();
  });

  it('number input → null', () => {
    expect(smartParse(123, ATEM_ONLY)).toBeNull();
  });

  it('unrecognized command → null (falls through to AI)', () => {
    expect(smartParse('cut to camera 3', ATEM_ONLY)).toBeNull();
  });

  it('works with no status argument', () => {
    const result = smartParse('thanks');
    expect(result).not.toBeNull();
    expect(result.type).toBe('chat');
  });
});
