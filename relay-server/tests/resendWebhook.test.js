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

function buildApp(lifecycleEmails) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
  setupResendWebhook(app, { lifecycleEmails, log: () => {} });
  return createClient(app);
}

describe('POST /api/resend/webhook', () => {
  const prevSecret = process.env.RESEND_WEBHOOK_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    else process.env.RESEND_WEBHOOK_SECRET = prevSecret;
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
});
