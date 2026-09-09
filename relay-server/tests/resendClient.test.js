/**
 * Tests for src/resendClient.js — tags, idempotency, retry, Svix verify.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  sanitizeTagValue,
  sanitizeTags,
  buildIdempotencyKey,
  extractTokenFromUrl,
  resolveReplyTo,
  isRetryableStatus,
  sendResendEmail,
  verifyResendWebhook,
  signResendWebhook,
  extractWebhookRecipients,
  shouldSuppressEventType,
} = require('../src/resendClient');

describe('sanitizeTagValue', () => {
  it('keeps alphanumeric, underscore, and dash', () => {
    expect(sanitizeTagValue('weekly-digest')).toBe('weekly-digest');
    expect(sanitizeTagValue('weekly_digest')).toBe('weekly_digest');
  });

  it('replaces invalid characters so weekly-digest keys cannot break sends', () => {
    expect(sanitizeTagValue('weekly-digest-email-2026-W12')).toBe('weekly-digest-email-2026-W12');
    expect(sanitizeTagValue('manual:onboarding_nudge')).toBe('manual_onboarding_nudge');
    expect(sanitizeTagValue('session-recap/abc.def')).toBe('session-recap_abc_def');
  });

  it('falls back when the value is empty after sanitize', () => {
    expect(sanitizeTagValue('!!!')).toBe('untagged');
  });
});

describe('sanitizeTags / idempotency', () => {
  it('sanitizes tag names and values', () => {
    expect(sanitizeTags([{ name: 'category', value: 'manual:foo' }])).toEqual([
      { name: 'category', value: 'manual_foo' },
    ]);
  });

  it('builds tally/churchId/emailType keys and truncates to 256', () => {
    expect(buildIdempotencyKey({ churchId: 'ch-1', emailType: 'setup-reminder' }))
      .toBe('tally/ch-1/setup-reminder');
    expect(buildIdempotencyKey({
      churchId: 'ch-1',
      emailType: 'password-reset',
      requestId: 'tok-abc',
    })).toBe('tally/ch-1/password-reset/tok-abc');
    const long = buildIdempotencyKey({ churchId: 'c'.repeat(300), emailType: 'x' });
    expect(long.length).toBe(256);
  });

  it('extracts reset/verify tokens from URLs', () => {
    expect(extractTokenFromUrl('https://tallyconnect.app/reset-password?token=abc123'))
      .toBe('abc123');
    expect(extractTokenFromUrl('/api/church/verify-email?token=xyz')).toBe('xyz');
  });
});

describe('resolveReplyTo', () => {
  it('uses explicit replyTo, then EMAIL_REPLY_TO, otherwise undefined', () => {
    expect(resolveReplyTo({ replyTo: 'support@tallyconnect.app' })).toBe('support@tallyconnect.app');
    expect(resolveReplyTo({ env: { EMAIL_REPLY_TO: 'ops@tallyconnect.app' } })).toBe('ops@tallyconnect.app');
    expect(resolveReplyTo({ env: {} })).toBeUndefined();
  });
});

describe('isRetryableStatus', () => {
  it('retries 429, 5xx, and concurrent 409 only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
    expect(isRetryableStatus(409, '{"name":"invalid_idempotent_request"}')).toBe(false);
    expect(isRetryableStatus(409, '{"name":"concurrent_idempotent_requests"}')).toBe(true);
  });
});

describe('sendResendEmail', () => {
  const base = {
    apiKey: 're_test',
    from: 'Tally <noreply@tallyconnect.app>',
    replyTo: 'support@tallyconnect.app',
    to: 'pastor@grace.church',
    subject: 'Hello',
    html: '<p>hi</p>',
    text: 'hi',
    tags: [{ name: 'category', value: 'weekly-digest-email-2026-W12' }],
    idempotencyKey: 'tally/ch-1/weekly-digest-email-2026-W12',
    sleep: async () => {},
  };

  it('sends Idempotency-Key, reply_to, and sanitized tags on success', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'msg_1' }),
    });
    const result = await sendResendEmail({ ...base, fetchFn });
    expect(result).toEqual({ sent: true, id: 'msg_1', attempts: 1 });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('tally/ch-1/weekly-digest-email-2026-W12');
    const body = JSON.parse(init.body);
    expect(body.reply_to).toBe('support@tallyconnect.app');
    expect(body.tags).toEqual([{ name: 'category', value: 'weekly-digest-email-2026-W12' }]);
  });

  it('retries 429 then succeeds with the same idempotency key', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_retry' }),
      });
    const result = await sendResendEmail({ ...base, fetchFn });
    expect(result.sent).toBe(true);
    expect(result.id).toBe('msg_retry');
    expect(result.attempts).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0][1].headers['Idempotency-Key'])
      .toBe(fetchFn.mock.calls[1][1].headers['Idempotency-Key']);
  });

  it('does not retry 4xx validation errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'bad request',
    });
    const result = await sendResendEmail({ ...base, fetchFn });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('resend-error');
    expect(result.status).toBe(400);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('retries network errors up to 3 attempts then returns network-error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await sendResendEmail({ ...base, fetchFn });
    expect(result.sent).toBe(false);
    expect(result.reason).toBe('network-error');
    expect(result.attempts).toBe(3);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('retries concurrent 409 but not invalid_idempotent_request', async () => {
    const concurrent = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ name: 'concurrent_idempotent_requests' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'msg_ok' }),
      });
    const ok = await sendResendEmail({ ...base, fetchFn: concurrent });
    expect(ok.sent).toBe(true);
    expect(concurrent).toHaveBeenCalledTimes(2);

    const invalid = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ name: 'invalid_idempotent_request' }),
    });
    const failed = await sendResendEmail({ ...base, fetchFn: invalid });
    expect(failed.sent).toBe(false);
    expect(invalid).toHaveBeenCalledOnce();
  });
});

describe('verifyResendWebhook', () => {
  const secret = `whsec_${Buffer.from('super-secret-bytes').toString('base64')}`;
  const payload = JSON.stringify({
    type: 'email.bounced',
    data: { email_id: 'ae2014de', to: ['bounced@resend.dev'], subject: 'Hi' },
  });

  it('accepts a valid Svix signature', () => {
    const headers = signResendWebhook(payload, secret);
    const result = verifyResendWebhook({ payload, headers, secret });
    expect(result.ok).toBe(true);
    expect(result.event.type).toBe('email.bounced');
  });

  it('rejects a bad signature, stale timestamp, and missing headers', () => {
    const headers = signResendWebhook(payload, secret);
    expect(verifyResendWebhook({
      payload,
      headers: { ...headers, 'svix-signature': 'v1,aaaa' },
      secret,
    }).ok).toBe(false);

    const stale = signResendWebhook(payload, secret, { timestamp: 1 });
    expect(verifyResendWebhook({ payload, headers: stale, secret }).reason).toBe('timestamp-expired');

    expect(verifyResendWebhook({ payload, headers: {}, secret }).reason).toBe('missing-headers');
    expect(verifyResendWebhook({ payload, headers, secret: '' }).reason).toBe('missing-secret');
  });
});

describe('webhook helpers', () => {
  it('extracts recipients and classifies suppressible events', () => {
    expect(extractWebhookRecipients({ data: { to: ['A@X.com', 'b@x.com'] } }))
      .toEqual(['a@x.com', 'b@x.com']);
    expect(shouldSuppressEventType('email.bounced')).toBe(true);
    expect(shouldSuppressEventType('email.complained')).toBe(true);
    expect(shouldSuppressEventType('email.failed')).toBe(false);
    expect(shouldSuppressEventType('email.delivered')).toBe(false);
  });
});
