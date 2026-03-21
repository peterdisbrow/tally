/**
 * Billing & Stripe routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupBillingRoutes(app, ctx) {
  const { db, requireAdmin, billing, rateLimit, normalizeBillingInterval,
          safeErrorMessage, log } = ctx;

  // POST /api/billing/checkout — create Stripe Checkout session
  app.post('/api/billing/checkout', requireAdmin, rateLimit(5, 60_000), async (req, res) => {
    try {
      const { tier, churchId, email, successUrl, cancelUrl } = req.body;
      if (!tier || !['connect', 'plus', 'pro', 'managed', 'event'].includes(tier)) {
        return res.status(400).json({ error: 'Invalid tier. Must be connect, plus, pro, managed, or event.' });
      }
      const billingInterval = normalizeBillingInterval(
        req.body?.billingInterval ?? req.body?.billingCycle,
        tier,
        String(tier).toLowerCase() === 'event' ? 'one_time' : 'monthly',
      );
      if (!billingInterval) {
        return res.status(400).json({ error: 'Invalid billingInterval. Must be monthly or annual.' });
      }
      const result = await billing.createCheckout({
        tier, churchId, email, successUrl, cancelUrl, billingInterval,
        isEvent: tier === 'event',
      });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/billing/portal — Stripe Billing Portal session
  app.post('/api/billing/portal', requireAdmin, async (req, res) => {
    try {
      const { churchId, returnUrl } = req.body;
      if (!churchId) return res.status(400).json({ error: 'churchId required' });
      const result = await billing.createPortalSession({ churchId, returnUrl });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // POST /api/billing/webhook — Stripe webhook receiver
  app.post('/api/billing/webhook', async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error('[Billing] Webhook rejected — STRIPE_WEBHOOK_SECRET not configured');
      return res.status(503).json({ error: 'Webhook endpoint not configured' });
    }
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });
    try {
      const result = await billing.handleWebhook(req.rawBody || req.body, sig);
      res.json(result);
    } catch (e) {
      console.error('[Billing] Webhook error:', e.message);
      res.status(400).json({ error: e.message });
    }
  });

  // GET /api/billing/status/:churchId
  app.get('/api/billing/status/:churchId', requireAdmin, (req, res) => {
    const status = billing.getStatus(req.params.churchId);
    res.json(status);
  });

  // GET /api/billing — list all billing records
  app.get('/api/billing', requireAdmin, (req, res) => {
    res.json(billing.listAll());
  });
};
