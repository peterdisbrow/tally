/**
 * Tests for src/chat-guard.js — on-topic filtering and sensitive data detection.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isOnTopic, containsSensitiveData, OFF_TOPIC_RESPONSE, SENSITIVE_RESPONSE } = require('../src/chat-guard');

describe('isOnTopic', () => {
  it('returns false for null', () => {
    expect(isOnTopic(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isOnTopic(undefined)).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isOnTopic(123)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isOnTopic('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(isOnTopic('   ')).toBe(false);
  });

  it('allows short messages (≤5 words) through without keyword check', () => {
    expect(isOnTopic('status')).toBe(true);
    expect(isOnTopic('help')).toBe(true);
    expect(isOnTopic('go live now')).toBe(true);
    expect(isOnTopic('what is happening')).toBe(true);
  });

  it('blocks long messages with no AV keywords (gibberish)', () => {
    // These strings have >5 words and contain no matches in ON_TOPIC_KEYWORDS
    expect(isOnTopic('xyzzy plugh frobozz grue zorkmid frotz blort')).toBe(false);
    expect(isOnTopic('zzz yyy www vvv uuu ttt sss rrr qqq')).toBe(false);
  });

  it('passes long messages containing AV equipment keywords', () => {
    expect(isOnTopic('can you tell me why the atem switcher is showing a black screen right now')).toBe(true);
    expect(isOnTopic('how do I fix the obs streaming issue that keeps happening during service')).toBe(true);
  });

  it('passes messages mentioning church production terminology', () => {
    expect(isOnTopic('what happened during the worship service last sunday morning')).toBe(true);
    expect(isOnTopic('the stage monitors are too loud for the vocalist during rehearsal')).toBe(true);
  });

  it('passes messages mentioning common actions', () => {
    expect(isOnTopic('please stop the recording before the offering segment starts today')).toBe(true);
    expect(isOnTopic('go ahead and fade to black for the end of service transition please')).toBe(true);
  });

  it('exports OFF_TOPIC_RESPONSE string', () => {
    expect(typeof OFF_TOPIC_RESPONSE).toBe('string');
    expect(OFF_TOPIC_RESPONSE.length).toBeGreaterThan(0);
  });
});

describe('containsSensitiveData', () => {
  it('returns false for null', () => {
    expect(containsSensitiveData(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(containsSensitiveData(undefined)).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(containsSensitiveData(42)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(containsSensitiveData('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(containsSensitiveData('   ')).toBe(false);
  });

  it('returns false for normal production message', () => {
    expect(containsSensitiveData('switch to camera 2 please')).toBe(false);
    expect(containsSensitiveData('what is the ATEM status')).toBe(false);
  });

  it('detects YouTube-style stream key pattern with key context', () => {
    // YouTube stream key format: xxxx-xxxx-xxxx-xxxx
    expect(containsSensitiveData('my stream key is abcd-ef12-3456-7890')).toBe(true);
  });

  it('detects explicit "stream key is" phrasing', () => {
    expect(containsSensitiveData('the stream key is abc123verylongkey')).toBe(true);
  });

  it('detects password sharing', () => {
    expect(containsSensitiveData('password is MyS3cr3tP@ss')).toBe(true);
  });

  it('returns false when key-like pattern exists but no key context keyword', () => {
    // Long alphanumeric without "key", "password", etc.
    expect(containsSensitiveData('the serial number is ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(false);
  });

  it('returns false when device config intent is detected (passes through for AI)', () => {
    // This should NOT be blocked — user is trying to configure an encoder
    expect(containsSensitiveData('set the rtmp stream key to abcd-ef12-3456-7890 on the encoder')).toBe(false);
  });

  it('returns false for messages that have key context but no matching pattern', () => {
    // Has "key" keyword but no actual key pattern
    expect(containsSensitiveData('what is the stream key supposed to look like')).toBe(false);
  });

  it('exports SENSITIVE_RESPONSE string', () => {
    expect(typeof SENSITIVE_RESPONSE).toBe('string');
    expect(SENSITIVE_RESPONSE.length).toBeGreaterThan(0);
  });
});
