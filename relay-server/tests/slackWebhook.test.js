import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isValidSlackWebhookUrl, maskSlackWebhookUrl } = require('../src/slackWebhook');

describe('isValidSlackWebhookUrl', () => {
  it('accepts official Slack incoming webhook hosts', () => {
    expect(isValidSlackWebhookUrl('https://hooks.slack.com/services/T1/B2/xxx')).toBe(true);
    expect(isValidSlackWebhookUrl('https://hooks.slack.com/services/TXXXX/BXXXX/secret')).toBe(true);
  });

  it('rejects non-https and non-Slack hosts', () => {
    expect(isValidSlackWebhookUrl('http://hooks.slack.com/services/T1/B2/xxx')).toBe(false);
    expect(isValidSlackWebhookUrl('https://evil.example/hooks.slack.com/x')).toBe(false);
    expect(isValidSlackWebhookUrl('https://hooks.slack.com.evil.example/x')).toBe(false);
    expect(isValidSlackWebhookUrl('not-a-url')).toBe(false);
  });
});

describe('maskSlackWebhookUrl', () => {
  it('hides the secret tail and never echoes the token', () => {
    const url = 'https://hooks.slack.com/services/TXXXXX/BXXXXX/supersecret';
    const masked = maskSlackWebhookUrl(url);
    expect(masked).toContain('https://hooks.slack.com/services/TXX');
    expect(masked).toMatch(/••••/);
    expect(masked).not.toContain('supersecret');
    expect(masked).not.toContain('BXXXXX');
  });

  it('returns empty string for empty input', () => {
    expect(maskSlackWebhookUrl('')).toBe('');
    expect(maskSlackWebhookUrl(null)).toBe('');
  });
});
