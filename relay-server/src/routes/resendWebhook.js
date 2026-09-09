/**
 * Resend delivery webhooks (Svix-signed).
 *
 * POST /api/resend/webhook
 * Events: email.bounced, email.complained, email.delivered, email.failed
 * (opened/clicked accepted but ignored).
 *
 * Hard bounce / complaint → suppress recipient so lifecycle stops for that
 * address. Soft bounce is email.delivery_delayed — Resend retries; we do
 * not suppress those.
 */

const {
  verifyResendWebhook,
  extractWebhookRecipients,
  shouldSuppressEventType,
} = require('../resendClient');

module.exports = function setupResendWebhookRoutes(app, ctx) {
  const { lifecycleEmails, log } = ctx;
  const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

  app.post('/api/resend/webhook', asyncRoute(async (req, res) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[ResendWebhook] Rejected — RESEND_WEBHOOK_SECRET not configured');
      return res.status(503).json({ error: 'Webhook endpoint not configured' });
    }

    const payload = typeof req.rawBody === 'string'
      ? req.rawBody
      : (typeof req.body === 'string' ? req.body : '');
    const verified = verifyResendWebhook({
      payload,
      headers: req.headers,
      secret,
    });
    if (!verified.ok) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = verified.event || {};
    const type = String(event.type || '');
    const recipients = extractWebhookRecipients(event);
    const emailId = event.data?.email_id || null;

    if (shouldSuppressEventType(type)) {
      if (!lifecycleEmails) {
        console.error('[ResendWebhook] lifecycleEmails unavailable — cannot suppress');
        return res.status(500).json({ error: 'Suppression unavailable' });
      }
      const reason = type === 'email.complained' ? 'complaint' : 'bounce';
      for (const recipient of recipients) {
        await lifecycleEmails.suppressRecipient({
          recipient,
          reason,
          source: 'resend',
          emailId,
        });
        if (log) log(`[ResendWebhook] Suppressed ${recipient} (${reason})`);
      }
    } else if (type === 'email.failed') {
      console.error(`[ResendWebhook] email.failed id=${emailId} to=${recipients.join(',')}`);
    } else if (type === 'email.delivered' || type === 'email.opened' || type === 'email.clicked') {
      // Accepted for observability; no local state change.
    }

    return res.status(200).json({ received: true });
  }));
};
