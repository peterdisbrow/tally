import { describe, it, expect } from 'vitest';

import streamGuardModule from '../src/stream-guard.js';

const {
  checkStreamSafety,
  checkWorkflowSafety,
  hasForceBypass,
  isDangerousWhileLive,
  DANGEROUS_COMMANDS,
} = streamGuardModule;

// ─── Helpers ────────────────────────────────────────────────────────────────

const LIVE_STATUS = { obs: { streaming: true } };
const RECORDING_STATUS = { obs: { recording: true } };
const IDLE_STATUS = { obs: { streaming: false, recording: false } };
const LIVE_AND_RECORDING = { obs: { streaming: true, recording: true } };

// ─── hasForceBypass ─────────────────────────────────────────────────────────

describe('hasForceBypass', () => {
  it('detects "force" keyword', () => {
    expect(hasForceBypass('force stop stream')).toBe(true);
    expect(hasForceBypass('Force fade to black')).toBe(true);
  });

  it('detects "override" keyword', () => {
    expect(hasForceBypass('override stop stream')).toBe(true);
  });

  it('detects "bypass" keyword', () => {
    expect(hasForceBypass('bypass stop recording')).toBe(true);
  });

  it('detects "now" suffix', () => {
    expect(hasForceBypass('stop stream now')).toBe(true);
    expect(hasForceBypass('stop stream now!')).toBe(true);
  });

  it('detects "do it" suffix', () => {
    expect(hasForceBypass('stop stream do it')).toBe(true);
    expect(hasForceBypass('stop stream just do it')).toBe(true);
  });

  it('returns false for normal messages', () => {
    expect(hasForceBypass('stop stream')).toBe(false);
    expect(hasForceBypass('fade to black')).toBe(false);
    expect(hasForceBypass('mute master')).toBe(false);
  });

  it('handles null/undefined/empty', () => {
    expect(hasForceBypass(null)).toBe(false);
    expect(hasForceBypass(undefined)).toBe(false);
    expect(hasForceBypass('')).toBe(false);
    expect(hasForceBypass(123)).toBe(false);
  });
});

// ─── isDangerousWhileLive ───────────────────────────────────────────────────

describe('isDangerousWhileLive', () => {
  it('classifies all critical commands', () => {
    const criticalCmds = ['obs.stopStream', 'vmix.stopStream', 'encoder.stopStream', 'atem.stopStreaming', 'atem.fadeToBlack'];
    for (const cmd of criticalCmds) {
      const result = isDangerousWhileLive(cmd);
      expect(result).toBeTruthy();
      expect(result.severity).toBe('critical');
    }
  });

  it('classifies all high-severity commands', () => {
    const highCmds = ['obs.stopRecording', 'vmix.stopRecording', 'encoder.stopRecording', 'atem.stopRecording', 'vmix.mute', 'mixer.recallScene'];
    for (const cmd of highCmds) {
      const result = isDangerousWhileLive(cmd);
      expect(result).toBeTruthy();
      expect(result.severity).toBe('high');
    }
  });

  it('mixer.mute is dangerous for master channel', () => {
    expect(isDangerousWhileLive('mixer.mute', { channel: 'master' })).toBeTruthy();
    expect(isDangerousWhileLive('mixer.mute', {})).toBeTruthy();
    expect(isDangerousWhileLive('mixer.mute')).toBeTruthy();
  });

  it('mixer.mute is safe for individual channels', () => {
    expect(isDangerousWhileLive('mixer.mute', { channel: 5 })).toBe(false);
    expect(isDangerousWhileLive('mixer.mute', { channel: 'ch1' })).toBe(false);
  });

  it('returns false for safe commands', () => {
    expect(isDangerousWhileLive('obs.switchScene')).toBe(false);
    expect(isDangerousWhileLive('atem.cut')).toBe(false);
    expect(isDangerousWhileLive('mixer.setFader')).toBe(false);
    expect(isDangerousWhileLive('obs.startStream')).toBe(false);
    expect(isDangerousWhileLive('status')).toBe(false);
  });
});

// ─── checkStreamSafety ──────────────────────────────────────────────────────

describe('checkStreamSafety', () => {
  it('returns null when not streaming or recording', () => {
    expect(checkStreamSafety('obs.stopStream', {}, IDLE_STATUS)).toBeNull();
    expect(checkStreamSafety('atem.fadeToBlack', {}, IDLE_STATUS)).toBeNull();
    expect(checkStreamSafety('mixer.mute', { channel: 'master' }, IDLE_STATUS)).toBeNull();
  });

  it('returns warning for critical command while streaming', () => {
    const result = checkStreamSafety('obs.stopStream', {}, LIVE_STATUS);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('critical');
    expect(result.warning).toContain('stream is live');
    expect(result.warning).toContain('🔴');
  });

  it('returns warning for high-severity command while recording', () => {
    const result = checkStreamSafety('obs.stopRecording', {}, RECORDING_STATUS);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('high');
    expect(result.warning).toContain('recording is in progress');
  });

  it('returns null for safe commands while live', () => {
    expect(checkStreamSafety('obs.switchScene', {}, LIVE_STATUS)).toBeNull();
    expect(checkStreamSafety('atem.cut', {}, LIVE_STATUS)).toBeNull();
  });

  it('returns null for individual channel mute while live', () => {
    expect(checkStreamSafety('mixer.mute', { channel: 5 }, LIVE_STATUS)).toBeNull();
  });

  it('returns warning for master mute while live', () => {
    const result = checkStreamSafety('mixer.mute', { channel: 'master' }, LIVE_STATUS);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('high');
  });

  it('detects streaming from various sources', () => {
    expect(checkStreamSafety('obs.stopStream', {}, { vmix: { streaming: true } })).toBeTruthy();
    expect(checkStreamSafety('obs.stopStream', {}, { atem: { streaming: true } })).toBeTruthy();
    expect(checkStreamSafety('obs.stopStream', {}, { encoder: { live: true } })).toBeTruthy();
    expect(checkStreamSafety('obs.stopStream', {}, { encoder: { streaming: true } })).toBeTruthy();
  });
});

// ─── checkWorkflowSafety ────────────────────────────────────────────────────

describe('checkWorkflowSafety', () => {
  it('returns null when not streaming or recording', () => {
    const steps = [
      { command: 'obs.stopStream', params: {} },
      { command: 'obs.stopRecording', params: {} },
    ];
    expect(checkWorkflowSafety(steps, IDLE_STATUS)).toBeNull();
  });

  it('returns null when workflow has no dangerous steps', () => {
    const steps = [
      { command: 'atem.cut', params: {} },
      { command: 'obs.switchScene', params: { scene: 'End' } },
    ];
    expect(checkWorkflowSafety(steps, LIVE_STATUS)).toBeNull();
  });

  it('returns single warning listing all dangerous steps while live', () => {
    const steps = [
      { command: 'atem.fadeToBlack', params: {} },
      { command: 'obs.stopStream', params: {} },
      { command: 'obs.stopRecording', params: {} },
    ];
    const result = checkWorkflowSafety(steps, LIVE_STATUS);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('critical');
    expect(result.warning).toContain('stream is live');
    expect(result.warning).toContain('fade to black');
    expect(result.warning).toContain('stop the OBS stream');
    expect(result.warning).toContain('stop the OBS recording');
  });

  it('returns high severity when only recording steps are dangerous', () => {
    const steps = [
      { command: 'atem.cut', params: {} },
      { command: 'obs.stopRecording', params: {} },
    ];
    const result = checkWorkflowSafety(steps, RECORDING_STATUS);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('high');
  });

  it('elevates to critical if any step is critical', () => {
    const steps = [
      { command: 'obs.stopRecording', params: {} },
      { command: 'obs.stopStream', params: {} },
    ];
    const result = checkWorkflowSafety(steps, LIVE_AND_RECORDING);
    expect(result).toBeTruthy();
    expect(result.severity).toBe('critical');
  });
});

// ─── DANGEROUS_COMMANDS registry ────────────────────────────────────────────

describe('DANGEROUS_COMMANDS registry', () => {
  it('has exactly 11 entries', () => {
    expect(Object.keys(DANGEROUS_COMMANDS).length).toBe(11);
  });

  it('every entry has severity and desc', () => {
    for (const [cmd, entry] of Object.entries(DANGEROUS_COMMANDS)) {
      expect(entry.severity).toMatch(/^(critical|high)$/);
      expect(typeof entry.desc).toBe('string');
      expect(entry.desc.length).toBeGreaterThan(0);
    }
  });
});
