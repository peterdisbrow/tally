/**
 * Tests for POST /api/resend/webhook — signature + bounce suppression.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const express = require('express');
const { signResendWebhook } = require('../src/resendClient');
const setupResendWebhook = require('../src/routes/resendWebhook');
const { createClient } = require('./helpers/expressTestClient');

const SECRET = `whsec_${Buffer.from('webhook-test-secret').toString('base64')}`;

function buildApp(lifecycleEmails, extras = {}) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  setupResendWebhook(app, { lifecycleEmails, log: () => {}, ...extras });
  return createClient(app);
}

describe('POST /api/resend/webhook', () => {
  const prevSecret = process.env.RESEND_WEBHOOK_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = prevSecret;
    setupResendWebhook.resetLastResendWebhookAt();
  });

  it('returns 503 when RESEND_WEBHOOK_SECRET is unset', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const client = buildApp({ suppressRecipient: vi.fn() });
    const { status } = await client.post('/api/resend/webhook', {
      body: { type: 'email.bounced', data: { to: ['a@b.com'] } },
    });
    expect(status).toBe(503);
  });

  it('returns 400 on an invalid signature', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const client = buildApp({ suppressRecipient: vi.fn() });
    const { status } = await client.post('/api/resend/webhook', {
      body: { type: 'email.bounced', data: { to: ['a@b.com'] } },
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,not-valid',
      },
    });
    expect(status).toBe(400);
  });

  it('suppresses recipients on hard bounce and complaint', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const suppressRecipient = vi.fn().mockResolvedValue({ suppressed: true });
    const client = buildApp({ suppressRecipient });

    const bouncePayload = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'em_bounce', to: ['bounced@resend.dev'], subject: 'Hi' },
    });
    const bounceHeaders = signResendWebhook(bouncePayload, SECRET);
    const bounce = await client.post('/api/resend/webhook', {
      body: bouncePayload,
      headers: bounceHeaders,
    });
    expect(bounce.status).toBe(200);
    expect(suppressRecipient).toHaveBeenCalledWith({
      recipient: 'bounced@resend.dev',
      reason: 'bounce',
      source: 'resend',
      emailId: 'em_bounce',
    });

    const complaintPayload = JSON.stringify({
      type: 'email.complained',
      data: { email_id: 'em_spam', to: ['complained@resend.dev'] },
    });
    const complaint = await client.post('/api/resend/webhook', {
      body: complaintPayload,
      headers: signResendWebhook(complaintPayload, SECRET),
    });
    expect(complaint.status).toBe(200);
    expect(suppressRecipient).toHaveBeenCalledWith({
      recipient: 'complained@resend.dev',
      reason: 'complaint',
      source: 'resend',
      emailId: 'em_spam',
    });
  });

  it('does not suppress delivered or failed events', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const suppressRecipient = vi.fn();
    const client = buildApp({ suppressRecipient });
    for (const type of ['email.delivered', 'email.failed']) {
      const payload = JSON.stringify({ type, data: { email_id: 'em_x', to: ['ok@x.com'] } });
      const { status } = await client.post('/api/resend/webhook', {
        body: payload,
        headers: signResendWebhook(payload, SECRET),
      });
      expect(status).toBe(200);
    }
    expect(suppressRecipient).not.toHaveBeenCalled();
  });

  it('records last received timestamp only after a valid signature', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    expect(setupResendWebhook.getLastResendWebhookAt()).toBeNull();
    const client = buildApp({ suppressRecipient: vi.fn() });

    await client.post('/api/resend/webhook', {
      body: JSON.stringify({ type: 'email.delivered', data: { to: ['ok@x.com'] } }),
      headers: {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,not-valid',
      },
    });
    expect(setupResendWebhook.getLastResendWebhookAt()).toBeNull();

    const payload = JSON.stringify({ type: 'email.delivered', data: { email_id: 'em_ok', to: ['ok@x.com'] } });
    const { status } = await client.post('/api/resend/webhook', {
      body: payload,
      headers: signResendWebhook(payload, SECRET),
    });
    expect(status).toBe(200);
    const lastAt = setupResendWebhook.getLastResendWebhookAt();
    expect(typeof lastAt).toBe('string');
    expect(Number.isNaN(Date.parse(lastAt))).toBe(false);
    expect(setupResendWebhook.getLastResendFailure()).toBeNull();
  });

  it('captures email.failed, bounce, and complaint to Sentry without recipient PII', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const captureException = vi.fn();
    const suppressRecipient = vi.fn().mockResolvedValue({ suppressed: true });
    const client = buildApp({ suppressRecipient }, { captureException });

    for (const type of ['email.failed', 'email.bounced', 'email.complained']) {
      captureException.mockClear();
      const payload = JSON.stringify({
        type,
        data: { email_id: `em_${type}`, to: ['secret.person@church.org'] },
      });
      const { status } = await client.post('/api/resend/webhook', {
        body: payload,
        headers: signResendWebhook(payload, SECRET),
      });
      expect(status).toBe(200);
      expect(captureException).toHaveBeenCalledTimes(1);
      const [err, hint] = captureException.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(`Resend ${type}`);
      expect(err.message).not.toMatch(/church\.org|secret\.person/i);
      expect(hint.tags.resend_event).toBe(type);
      expect(hint.extra.emailId).toBe(`em_${type}`);
      expect(hint.extra.recipientCount).toBe(1);
      expect(JSON.stringify(hint)).not.toMatch(/church\.org|secret\.person/i);
    }

    const lastFailure = setupResendWebhook.getLastResendFailure();
    expect(lastFailure).toEqual({
      type: 'email.complained',
      at: setupResendWebhook.getLastResendWebhookAt(),
    });
  });

  it('does not capture delivered events to Sentry', async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const captureException = vi.fn();
    const client = buildApp({ suppressRecipient: vi.fn() }, { captureException });
    const payload = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'em_ok', to: ['ok@x.com'] },
    });
    const { status } = await client.post('/api/resend/webhook', {
      body: payload,
      headers: signResendWebhook(payload, SECRET),
    });
    expect(status).toBe(200);
    expect(captureException).not.toHaveBeenCalled();
    expect(setupResendWebhook.getLastResendFailure()).toBeNull();
  });
});
