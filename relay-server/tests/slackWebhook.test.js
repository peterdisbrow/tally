import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { encryptSecret, decryptSecret, isEncrypted } = require('../src/secretCrypto');
const {
  isValidSlackWebhookUrl,
  isMaskedSlackWebhookPlaceholder,
  maskSlackWebhookUrl,
  resolveSlackWebhookUrl,
  slackStatusPayload,
} = require('../src/slackWebhook');

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

describe('resolveSlackWebhookUrl / slackStatusPayload', () => {
  const plaintext = 'https://hooks.slack.com/services/TXXXXX/BXXXXX/supersecret';

  it('returns legacy plaintext unchanged', () => {
    expect(resolveSlackWebhookUrl(plaintext)).toBe(plaintext);
  });

  it('decrypts enc:v1 ciphertext', () => {
    const stored = encryptSecret(plaintext);
    expect(isEncrypted(stored)).toBe(true);
    expect(resolveSlackWebhookUrl(stored)).toBe(plaintext);
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it('masks ciphertext without leaking the secret or the ciphertext', () => {
    const stored = encryptSecret(plaintext);
    const status = slackStatusPayload({ slack_webhook_url: stored, slack_channel: '#alerts' });
    expect(status.configured).toBe(true);
    expect(status.channel).toBe('#alerts');
    expect(status.webhookUrl).toMatch(/••••/);
    expect(status.webhookUrl).toContain('TXX');
    expect(status.webhookUrl).not.toContain('supersecret');
    expect(status.webhookUrlFull).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('supersecret');
    expect(JSON.stringify(status)).not.toContain('enc:v1:');
  });

  it('masks leftover plaintext the same way', () => {
    const status = slackStatusPayload({ slack_webhook_url: plaintext });
    expect(status.configured).toBe(true);
    expect(status.webhookUrl).not.toContain('supersecret');
  });

  it('detects masked placeholders', () => {
    expect(isMaskedSlackWebhookPlaceholder('https://hooks.slack.com/services/TXX••••/••••••••')).toBe(true);
    expect(isMaskedSlackWebhookPlaceholder(plaintext)).toBe(false);
  });
});
