/**
 * Tally Billing — Stripe Integration
 *
 * Handles subscriptions for Connect/Plus/Pro/Enterprise (monthly or annual)
 * and one-time Event mode.
 *
 * Setup:
 *   npm install stripe  (in relay-server/)
 *   Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in .env
 *   Create products/prices in Stripe dashboard, set IDs below or via env vars.
 *
 * Flow:
 *   1. Church registers → POST /api/billing/checkout → redirect to Stripe Checkout
 *   2. Stripe webhook → POST /api/billing/webhook → activates/deactivates church
 *   3. Church portal → POST /api/billing/portal → redirect to Stripe billing portal
 */

function createStripeClientFromEnv() {
  try {
    return require('stripe')(process.env.STRIPE_SECRET_KEY);
  } catch (err) {
    if (/Neither apiKey/i.test(err.message)) {
      console.warn('⚠️  Billing disabled — set STRIPE_SECRET_KEY in .env to enable Stripe features.');
    } else {
      console.warn('⚠️  stripe package or config issue: billing disabled. Run: npm install stripe');
    }
    return null;
  }
}

let stripe = createStripeClientFromEnv();

function _setStripeClientForTests(client) {
  const isTestEnv = process.env.NODE_ENV === 'test' || !!process.env.VITEST;
  if (!isTestEnv) {
    throw new Error('_setStripeClientForTests is only allowed in test environment');
  }
  stripe = client;
}

function _resetStripeClientForTests() {
  stripe = createStripeClientFromEnv();
}

// ─── PRICE IDS ───────────────────────────────────────────────────────────────
// Set these in .env or override with Stripe dashboard IDs

const BILLING_INTERVALS = new Set(['monthly', 'annual', 'one_time']);
const PRICES = {
  connect: {
    monthly: process.env.STRIPE_PRICE_CONNECT || 'price_connect_placeholder',
    annual: process.env.STRIPE_PRICE_CONNECT_ANNUAL || process.env.STRIPE_PRICE_CONNECT_YEARLY || '',
  },
  plus: {
    monthly: process.env.STRIPE_PRICE_PLUS || 'price_plus_placeholder',
    annual: process.env.STRIPE_PRICE_PLUS_ANNUAL || process.env.STRIPE_PRICE_PLUS_YEARLY || '',
  },
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder',
    annual: process.env.STRIPE_PRICE_PRO_ANNUAL || process.env.STRIPE_PRICE_PRO_YEARLY || '',
  },
  managed: {
    monthly: process.env.STRIPE_PRICE_MANAGED || 'price_managed_placeholder',
    annual: process.env.STRIPE_PRICE_MANAGED_ANNUAL || process.env.STRIPE_PRICE_MANAGED_YEARLY || '',
  },
  event: {
    one_time: process.env.STRIPE_PRICE_EVENT || 'price_event_placeholder',
  },
};
const PRICE_ENV_KEYS = {
  connect: { monthly: 'STRIPE_PRICE_CONNECT', annual: 'STRIPE_PRICE_CONNECT_ANNUAL' },
  plus: { monthly: 'STRIPE_PRICE_PLUS', annual: 'STRIPE_PRICE_PLUS_ANNUAL' },
  pro: { monthly: 'STRIPE_PRICE_PRO', annual: 'STRIPE_PRICE_PRO_ANNUAL' },
  managed: { monthly: 'STRIPE_PRICE_MANAGED', annual: 'STRIPE_PRICE_MANAGED_ANNUAL' },
  event: { one_time: 'STRIPE_PRICE_EVENT' },
};

const TIER_NAMES = { connect: 'Connect', plus: 'Plus', pro: 'Pro', managed: 'Enterprise', event: 'Event' };
const TRIAL_PERIOD_DAYS = 30; // 30-day free trial
const GRACE_PERIOD_DAYS = 7;  // days after payment failure before deactivation
const TIER_LIMITS = {
  connect: { rooms: 1,        devices: ['atem', 'obs', 'vmix'] },
  plus:    { rooms: 3,        devices: 'all' },
  pro:     { rooms: 5,        devices: 'all' },
  managed: { rooms: Infinity, devices: 'all' },
  event:   { rooms: 1,        devices: 'all' },
};

class BillingSystem {
  constructor(db) {
    this.db = db;
    this.lifecycleEmails = null;
    this._ensureSchema();
    this._validatePriceIds();
  }

  /** Warn at startup if Stripe is enabled but price IDs are still placeholders */
  _validatePriceIds() {
    if (!stripe) return; // Stripe not configured, skip

    // Check for webhook secret
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.warn('\n⚠️  Stripe is enabled but STRIPE_WEBHOOK_SECRET is not set.');
      console.warn('   Webhook signature verification will fail without it.\n');
    }

    const missing = [];
    for (const [tier, intervals] of Object.entries(PRICES)) {
      for (const [interval, priceId] of Object.entries(intervals)) {
        if (!priceId || priceId.includes('placeholder') || !priceId.startsWith('price_')) {
          const envKey = PRICE_ENV_KEYS[tier]?.[interval] || `STRIPE_PRICE_${tier.toUpperCase()}`;
          missing.push(envKey);
        }
      }
    }
    if (missing.length > 0) {
      console.warn(`\n⚠️  Stripe is enabled but ${missing.length} price ID(s) are missing or still placeholders:`);
      console.warn(`   ${missing.join(', ')}`);
      console.warn('   Set these in .env with real Stripe price IDs before accepting payments.\n');
    }
  }

  /** Attach lifecycle emails engine (called from server.js after both are initialized) */
  setLifecycleEmails(engine) {
    this.lifecycleEmails = engine;
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_customers (
        id TEXT PRIMARY KEY,
        church_id TEXT REFERENCES churches(churchId),
        reseller_id TEXT,
        stripe_customer_id TEXT UNIQUE,
        stripe_subscription_id TEXT,
        stripe_session_id TEXT,
        tier TEXT NOT NULL DEFAULT 'connect',
        billing_interval TEXT,
        status TEXT NOT NULL DEFAULT 'trialing',
        trial_ends_at TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        grace_ends_at TEXT,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Add billing columns to billing_customers (safe migration for existing DBs)
    const billingCustomerCols = {
      grace_ends_at: 'TEXT',
      billing_interval: 'TEXT',
    };
    for (const [col, def] of Object.entries(billingCustomerCols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM billing_customers LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE billing_customers ADD COLUMN ${col} ${def}`);
      }
    }

    // Add billing columns to churches table
    const cols = {
      billing_tier: 'TEXT DEFAULT NULL',
      billing_status: "TEXT DEFAULT 'inactive'",
      billing_trial_ends: 'TEXT DEFAULT NULL',
      billing_interval: 'TEXT DEFAULT NULL',
    };
    for (const [col, def] of Object.entries(cols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${def}`);
      }
    }
  }

  isEnabled() {
    return !!stripe && !!process.env.STRIPE_SECRET_KEY;
  }

  _normaliseTier(tier) {
    const normalized = String(tier || '').trim().toLowerCase();
    return TIER_NAMES[normalized] ? normalized : null;
  }

  _normaliseBillingInterval(interval, tier) {
    const normalizedTier = this._normaliseTier(tier);
    if (normalizedTier === 'event') return 'one_time';

    if (interval === undefined || interval === null || String(interval).trim() === '') {
      return 'monthly';
    }

    const value = String(interval).trim().toLowerCase().replace(/[\s-]/g, '_');
    if (value === 'monthly' || value === 'month') return 'monthly';
    if (value === 'annual' || value === 'yearly' || value === 'year' || value === 'annually') return 'annual';
    if (value === 'one_time' || value === 'once' || value === 'event') return null;
    return null;
  }

  _priceEnvVar(tier, billingInterval) {
    return PRICE_ENV_KEYS[tier]?.[billingInterval] || `STRIPE_PRICE_${String(tier || '').toUpperCase()}`;
  }

  _resolvePriceId(tier, billingInterval) {
    return PRICES[tier]?.[billingInterval] || null;
  }

  // ─── CHECKOUT ─────────────────────────────────────────────────────────────

  /**
   * Create a Stripe Checkout session.
   * Returns { url } to redirect the customer to.
   */
  async createCheckout({ tier, churchId, email, successUrl, cancelUrl, isEvent = false, billingInterval }) {
    if (!this.isEnabled()) throw new Error('Stripe not configured');

    const normalizedTier = this._normaliseTier(tier);
    if (!normalizedTier) throw new Error(`Invalid billing tier "${tier}"`);

    const effectiveInterval = this._normaliseBillingInterval(billingInterval, normalizedTier);
    if (!effectiveInterval || !BILLING_INTERVALS.has(effectiveInterval)) {
      throw new Error(`Invalid billing interval "${billingInterval}". Use "monthly" or "annual".`);
    }

    const eventCheckout = isEvent || normalizedTier === 'event';
    const priceId = this._resolvePriceId(normalizedTier, effectiveInterval);
    if (!priceId || priceId.includes('placeholder')) {
      const envKey = this._priceEnvVar(normalizedTier, effectiveInterval);
      throw new Error(`Stripe price ID for "${normalizedTier}" (${effectiveInterval}) not configured. Set ${envKey} in .env`);
    }

    const sessionParams = {
      mode: eventCheckout ? 'payment' : 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${process.env.APP_URL}/billing/cancel`,
      metadata: { churchId: churchId || '', tier: normalizedTier, billingInterval: effectiveInterval },
      allow_promotion_codes: true,
    };

    if (!eventCheckout) {
      // 60-day free trial for subscriptions (matches landing page promise)
      sessionParams.subscription_data = {
        trial_period_days: TRIAL_PERIOD_DAYS,
        metadata: { churchId: churchId || '', tier: normalizedTier, billingInterval: effectiveInterval },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Store pending session
    if (churchId) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT OR REPLACE INTO billing_customers
          (id, church_id, stripe_session_id, tier, billing_interval, status, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(`billing_${churchId}`, churchId, session.id, normalizedTier, effectiveInterval, email || '', now, now);
      this.db.prepare(`
        UPDATE churches
        SET billing_tier = ?, billing_interval = ?
        WHERE churchId = ?
      `).run(normalizedTier, effectiveInterval, churchId);
    }

    return { url: session.url, sessionId: session.id, tier: normalizedTier, billingInterval: effectiveInterval };
  }

  // ─── BILLING PORTAL ───────────────────────────────────────────────────────

  /**
   * Create a Stripe Billing Portal session so customers can manage their sub.
   */
  async createPortalSession({ churchId, returnUrl }) {
    if (!this.isEnabled()) throw new Error('Stripe not configured');

    const billing = this.db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get(churchId);
    if (!billing?.stripe_customer_id) throw new Error('No billing record found for this church');

    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripe_customer_id,
      return_url: returnUrl || process.env.APP_URL,
    });

    return { url: session.url };
  }

  // ─── WEBHOOK HANDLER ──────────────────────────────────────────────────────

  /**
   * Process incoming Stripe webhook events.
   * Call from POST /api/billing/webhook with raw body.
   */
  async handleWebhook(rawBody, signature) {
    if (!this.isEnabled()) throw new Error('Stripe not configured');

    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw new Error(`Webhook signature verification failed: ${err.message}`);
    }

    console.log(`[Billing] Webhook: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this._onCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await this._onSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await this._onSubscriptionCancelled(event.data.object);
        break;
      case 'invoice.payment_failed':
        await this._onPaymentFailed(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await this._onPaymentSucceeded(event.data.object);
        break;
      case 'charge.dispute.created':
        await this._onDisputeCreated(event.data.object);
        break;
      case 'charge.dispute.closed':
        await this._onDisputeClosed(event.data.object);
        break;
      case 'customer.subscription.trial_will_end':
        // Stripe fires this 3 days before trial ends — our lifecycle emails already handle this
        console.log(`[Billing] Trial ending soon for subscription ${event.data.object.id}`);
        break;
      case 'invoice.upcoming':
        await this._onInvoiceUpcoming(event.data.object);
        break;
    }

    return { received: true };
  }

  async _onCheckoutCompleted(session) {
    const { churchId, tier, billingInterval } = session.metadata || {};
    const now = new Date().toISOString();

    // Update billing record with customer ID
    if (session.customer) {
      this.db.prepare(`
        UPDATE billing_customers
        SET stripe_customer_id = ?, stripe_subscription_id = ?, billing_interval = COALESCE(?, billing_interval), status = 'active', updated_at = ?
        WHERE stripe_session_id = ? OR church_id = ?
      `).run(session.customer, session.subscription || null, billingInterval || null, now, session.id, churchId || '');
    }

    // Activate the church
    if (churchId) {
      this._activateChurch(churchId, tier, 'active', billingInterval);
    }

    // Process referral credit — give the referrer a free month
    if (churchId) {
      try {
        await this._processReferralCredit(churchId, tier, session.customer);
      } catch (e) {
        console.error(`[Referral] Credit failed for ${churchId}: ${e.message}`);
      }
    }

    console.log(`[Billing] ✅ Checkout complete for church ${churchId} (${tier}, ${billingInterval || 'monthly'})`);

    // Send appropriate email based on checkout type
    if (this.lifecycleEmails && churchId) {
      const church = this.db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(churchId);
      if (church) {
        if (session.metadata?.reactivation === 'true') {
          this.lifecycleEmails.sendReactivationConfirmation(church).catch(() => {});
        } else {
          this.lifecycleEmails.sendPaymentConfirmed(church, { tier, interval: billingInterval }).catch(() => {});
        }
      }
    }
  }

  async _onSubscriptionUpdated(sub) {
    const { churchId, tier, billingInterval } = sub.metadata || {};
    const status = sub.status; // active, trialing, past_due, canceled, etc.
    const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE billing_customers
      SET status = ?, current_period_end = ?, cancel_at_period_end = ?, billing_interval = COALESCE(?, billing_interval), updated_at = ?
      WHERE stripe_subscription_id = ? OR church_id = ?
    `).run(status, periodEnd, sub.cancel_at_period_end ? 1 : 0, billingInterval || null, now, sub.id, churchId || '');

    if (churchId) {
      const isActive = ['active', 'trialing'].includes(status);
      this._activateChurch(
        churchId,
        tier || this._getChurchTier(churchId),
        isActive ? status : 'inactive',
        billingInterval || this._getChurchBillingInterval(churchId),
      );
    }
  }

  async _onSubscriptionCancelled(sub) {
    const { churchId } = sub.metadata || {};
    const now = new Date().toISOString();

    this.db.prepare(`UPDATE billing_customers SET status = 'canceled', updated_at = ? WHERE stripe_subscription_id = ?`)
      .run(now, sub.id);

    if (churchId) {
      this._deactivateChurch(churchId, 'subscription_cancelled');
      console.log(`[Billing] ❌ Subscription cancelled for church ${churchId}`);

      // Send cancellation confirmation email
      if (this.lifecycleEmails) {
        const church = this.db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(churchId);
        const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
        if (church) this.lifecycleEmails.sendCancellationConfirmation(church, { periodEnd }).catch(() => {});
      }
    }
  }

  async _onPaymentFailed(invoice) {
    const subId = invoice.subscription;
    const billingRecord = this.db.prepare('SELECT * FROM billing_customers WHERE stripe_subscription_id = ?').get(subId);
    if (billingRecord) {
      const now = new Date();
      const graceEndsAt = new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        UPDATE billing_customers
        SET status = 'past_due', grace_ends_at = ?, updated_at = ?
        WHERE stripe_subscription_id = ?
      `).run(graceEndsAt, now.toISOString(), subId);

      // Update churches table status
      if (billingRecord.church_id) {
        this.db.prepare('UPDATE churches SET billing_status = ? WHERE churchId = ?')
          .run('past_due', billingRecord.church_id);
      }

      console.log(`[Billing] ⚠️ Payment failed for church ${billingRecord.church_id} — grace period until ${graceEndsAt}`);

      // Send payment-failed dunning email
      if (this.lifecycleEmails && billingRecord.church_id) {
        const church = this.db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(billingRecord.church_id);
        if (church) this.lifecycleEmails.sendPaymentFailed(church).catch(e => console.error(`[Billing] Payment-failed email error for ${church.name}: ${e.message}`));
      }
    }
  }

  async _onPaymentSucceeded(invoice) {
    const subId = invoice.subscription;
    const billing = this.db.prepare('SELECT * FROM billing_customers WHERE stripe_subscription_id = ?').get(subId);
    if (billing && billing.status === 'past_due') {
      this.db.prepare(`UPDATE billing_customers SET status = 'active', updated_at = ? WHERE stripe_subscription_id = ?`)
        .run(new Date().toISOString(), subId);
      console.log(`[Billing] ✅ Payment recovered for church ${billing.church_id}`);
    }
  }

  // ─── CHARGE DISPUTES ─────────────────────────────────────────────────────

  async _onDisputeCreated(dispute) {
    const customerId = dispute.customer;
    if (!customerId) return;

    const billingRecord = this.db.prepare(
      'SELECT * FROM billing_customers WHERE stripe_customer_id = ?'
    ).get(customerId);

    if (!billingRecord) {
      console.log(`[Billing] Dispute created for unknown customer ${customerId}`);
      return;
    }

    const now = new Date().toISOString();

    // Log the dispute
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_disputes (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        stripe_dispute_id TEXT UNIQUE NOT NULL,
        stripe_charge_id TEXT,
        amount INTEGER,
        currency TEXT DEFAULT 'usd',
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);

    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO billing_disputes (id, church_id, stripe_dispute_id, stripe_charge_id, amount, currency, reason, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        `dispute_${billingRecord.church_id}_${Date.now()}`,
        billingRecord.church_id,
        dispute.id,
        dispute.charge || null,
        dispute.amount || 0,
        dispute.currency || 'usd',
        dispute.reason || 'unknown',
        now
      );
    } catch (e) {
      console.error(`[Billing] Failed to record dispute: ${e.message}`);
    }

    // Immediately flag the church — disputes are serious
    this.db.prepare('UPDATE billing_customers SET status = ?, updated_at = ? WHERE stripe_customer_id = ?')
      .run('disputed', now, customerId);
    this.db.prepare('UPDATE churches SET billing_status = ? WHERE churchId = ?')
      .run('disputed', billingRecord.church_id);

    console.log(`[Billing] ⚠️ Dispute opened for church ${billingRecord.church_id} — reason: ${dispute.reason}, amount: $${(dispute.amount / 100).toFixed(2)}`);

    // Send dispute alert email
    if (this.lifecycleEmails && billingRecord.church_id) {
      const church = this.db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(billingRecord.church_id);
      if (church) this.lifecycleEmails.sendDisputeAlert(church, { amount: dispute.amount, reason: dispute.reason, disputeId: dispute.id }).catch(e => console.error(`[Billing] Dispute alert email error for ${church.name}: ${e.message}`));
    }
  }

  async _onDisputeClosed(dispute) {
    const customerId = dispute.customer;
    if (!customerId) return;

    const billingRecord = this.db.prepare(
      'SELECT * FROM billing_customers WHERE stripe_customer_id = ?'
    ).get(customerId);

    if (!billingRecord) return;

    const now = new Date().toISOString();

    // Update dispute record
    try {
      this.db.prepare(
        "UPDATE billing_disputes SET status = ?, resolved_at = ? WHERE stripe_dispute_id = ?"
      ).run(dispute.status || 'closed', now, dispute.id);
    } catch { /* table might not exist */ }

    // If won, restore to active. If lost, keep as inactive.
    if (dispute.status === 'won') {
      this.db.prepare('UPDATE billing_customers SET status = ?, updated_at = ? WHERE stripe_customer_id = ?')
        .run('active', now, customerId);
      if (billingRecord.church_id) {
        this._activateChurch(billingRecord.church_id, billingRecord.tier, 'active', billingRecord.billing_interval);
      }
      console.log(`[Billing] ✅ Dispute WON for church ${billingRecord.church_id} — restored to active`);
    } else {
      // Lost or other outcome — deactivate
      if (billingRecord.church_id) {
        this._deactivateChurch(billingRecord.church_id, `dispute_${dispute.status}`);
      }
      console.log(`[Billing] ❌ Dispute ${dispute.status} for church ${billingRecord.church_id} — deactivated`);
    }
  }

  // ─── INVOICE UPCOMING ────────────────────────────────────────────────────

  async _onInvoiceUpcoming(invoice) {
    const customerId = invoice.customer;
    if (!customerId) return;

    const billingRecord = this.db.prepare(
      'SELECT * FROM billing_customers WHERE stripe_customer_id = ?'
    ).get(customerId);
    if (!billingRecord) return;

    const amount = invoice.amount_due || invoice.total || 0;
    const dueDate = invoice.due_date || invoice.next_payment_attempt;

    if (this.lifecycleEmails && billingRecord.church_id) {
      const church = this.db.prepare('SELECT churchId, name, portal_email FROM churches WHERE churchId = ?').get(billingRecord.church_id);
      if (church) {
        this.lifecycleEmails.sendInvoiceUpcoming(church, { amount, dueDate }).catch(() => {});
        console.log(`[Billing] Invoice upcoming email queued for ${billingRecord.church_id} — $${(amount / 100).toFixed(2)}`);
      }
    }
  }

  // ─── REACTIVATION ───────────────────────────────────────────────────────

  /**
   * Create a new checkout session for a cancelled/expired church to resubscribe.
   * Returns { url } to redirect the customer to Stripe checkout.
   */
  async reactivate({ churchId, tier, billingInterval, successUrl, cancelUrl }) {
    if (!this.isEnabled()) throw new Error('Stripe not configured');

    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) throw new Error('Church not found');

    const allowedStatuses = ['canceled', 'inactive', 'trial_expired', 'disputed'];
    if (!allowedStatuses.includes(church.billing_status)) {
      throw new Error(`Church is "${church.billing_status}" — reactivation only available for cancelled, expired, or inactive accounts.`);
    }

    const effectiveTier = this._normaliseTier(tier || church.billing_tier) || 'connect';
    const effectiveInterval = this._normaliseBillingInterval(billingInterval || church.billing_interval, effectiveTier) || 'monthly';

    // Create a fresh checkout (no trial for reactivation)
    const priceId = this._resolvePriceId(effectiveTier, effectiveInterval);
    if (!priceId || priceId.includes('placeholder')) {
      throw new Error(`Price not configured for ${effectiveTier} (${effectiveInterval})`);
    }

    // Check if we have an existing Stripe customer to reuse
    const existingBilling = this.db.prepare(
      'SELECT stripe_customer_id FROM billing_customers WHERE church_id = ? AND stripe_customer_id IS NOT NULL ORDER BY datetime(updated_at) DESC LIMIT 1'
    ).get(churchId);

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.APP_URL || 'https://tallyconnect.app'}/portal?reactivated=true`,
      cancel_url: cancelUrl || `${process.env.APP_URL || 'https://tallyconnect.app'}/portal`,
      metadata: { churchId, tier: effectiveTier, billingInterval: effectiveInterval, reactivation: 'true' },
      allow_promotion_codes: true,
    };

    // Reuse existing Stripe customer if available
    if (existingBilling?.stripe_customer_id) {
      sessionParams.customer = existingBilling.stripe_customer_id;
    } else {
      sessionParams.customer_email = church.portal_email || church.email;
    }

    // No trial period for reactivation
    const session = await stripe.checkout.sessions.create(sessionParams);

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR REPLACE INTO billing_customers
        (id, church_id, stripe_session_id, stripe_customer_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      `billing_${churchId}`,
      churchId,
      session.id,
      existingBilling?.stripe_customer_id || null,
      effectiveTier,
      effectiveInterval,
      church.portal_email || church.email || '',
      now, now
    );

    this.db.prepare('UPDATE churches SET billing_tier = ?, billing_status = ? WHERE churchId = ?')
      .run(effectiveTier, 'pending', churchId);

    console.log(`[Billing] Reactivation checkout created for church ${churchId} (${effectiveTier}, ${effectiveInterval})`);
    return { url: session.url, sessionId: session.id };
  }

  // ─── CHURCH ACTIVATION ────────────────────────────────────────────────────

  _activateChurch(churchId, tier, status, billingInterval) {
    this.db.prepare(`
      UPDATE churches
      SET billing_tier = ?, billing_status = ?, billing_interval = COALESCE(?, billing_interval)
      WHERE churchId = ?
    `).run(tier || 'connect', status, billingInterval || null, churchId);
  }

  _deactivateChurch(churchId, reason) {
    this.db.prepare(`
      UPDATE churches SET billing_status = 'inactive' WHERE churchId = ?
    `).run(churchId);
    console.log(`[Billing] Church ${churchId} deactivated: ${reason}`);
  }

  _getChurchTier(churchId) {
    const billing = this.db.prepare('SELECT tier FROM billing_customers WHERE church_id = ?').get(churchId);
    return billing?.tier || 'connect';
  }

  _getChurchBillingInterval(churchId) {
    const billing = this.db.prepare('SELECT billing_interval, tier FROM billing_customers WHERE church_id = ?').get(churchId);
    const church = this.db.prepare('SELECT billing_interval, billing_tier FROM churches WHERE churchId = ?').get(churchId);
    const tier = billing?.tier || church?.billing_tier || 'connect';
    return this._normaliseBillingInterval(billing?.billing_interval || church?.billing_interval || null, tier);
  }

  // ─── TIER CHECKING ────────────────────────────────────────────────────────

  /**
   * Check if a church's billing allows a feature.
   * Returns { allowed: bool, reason?: string }
   */
  checkAccess(church, feature) {
    const tier = church.billing_tier || 'connect';
    const status = church.billing_status || 'inactive';

    // When Stripe is configured, enforce billing status (payment checks)
    if (this.isEnabled()) {
      if (!['active', 'trialing'].includes(status)) {
        return { allowed: false, reason: `Subscription ${status}. Visit tallyconnect.app to manage billing.` };
      }
    }

    // Tier-based feature gating is always enforced (even without Stripe)
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.connect;

    // Room/campus limits
    if (feature === 'multi_church' && limits.rooms <= 1) {
      return { allowed: false, reason: 'Multi-room support requires Plus or higher plan.' };
    }

    if (feature === 'planning_center' && (tier === 'connect' || tier === 'plus')) {
      return { allowed: false, reason: 'Planning Center sync requires Pro or Enterprise plan.' };
    }

    if (feature === 'monthly_report' && (tier === 'connect' || tier === 'plus')) {
      return { allowed: false, reason: 'Monthly reports require Pro or Enterprise plan.' };
    }

    if (feature === 'autopilot' && (tier === 'connect' || tier === 'plus')) {
      return { allowed: false, reason: 'AI Autopilot requires Pro or Enterprise plan.' };
    }

    // Rundown scheduler: manual rundowns for Plus+, auto-triggers for Pro+
    if (feature === 'scheduler' && tier === 'connect') {
      return { allowed: false, reason: 'Service rundowns require Plus or higher plan.' };
    }

    if (feature === 'scheduler_auto' && (tier === 'connect' || tier === 'plus')) {
      return { allowed: false, reason: 'Auto-triggered rundown cues require Pro or Enterprise plan.' };
    }

    if (feature === 'reseller_api' && tier !== 'managed') {
      return { allowed: false, reason: 'Reseller API requires Enterprise plan.' };
    }

    // Plus+ features
    if (feature === 'propresenter' && tier === 'connect') {
      return { allowed: false, reason: 'ProPresenter control requires Plus or higher plan.' };
    }

    if (feature === 'oncall_rotation' && tier === 'connect') {
      return { allowed: false, reason: 'On-call TD rotation requires Plus or higher plan.' };
    }

    if (feature === 'live_preview' && tier === 'connect') {
      return { allowed: false, reason: 'Live video preview requires Plus or higher plan.' };
    }

    // Device-level access (Connect tier limited to ATEM, OBS, vMix)
    if (feature === 'device_access') {
      // device_access expects the device type passed as a second argument via checkDeviceAccess()
      return { allowed: true }; // handled by checkDeviceAccess() below
    }

    return { allowed: true };
  }

  /**
   * Check if a church's tier allows access to a specific device type.
   * Connect tier is limited to ATEM, OBS, vMix. All other tiers get full access.
   * @param {object} church - Church row from DB
   * @param {string} deviceType - e.g. 'atem', 'obs', 'vmix', 'propresenter', 'companion', etc.
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkDeviceAccess(church, deviceType) {
    const tier = church.billing_tier || 'connect';
    const limits = TIER_LIMITS[tier] || TIER_LIMITS.connect;

    if (limits.devices === 'all') return { allowed: true };

    const normalised = String(deviceType).toLowerCase().replace(/[\s_-]/g, '');
    const allowed = limits.devices.some(d => normalised.includes(d));
    if (!allowed) {
      return { allowed: false, reason: `${deviceType} is not available on the ${TIER_NAMES[tier] || tier} plan. Upgrade to Plus or higher.` };
    }
    return { allowed: true };
  }

  // ─── STATUS ───────────────────────────────────────────────────────────────

  getStatus(churchId) {
    const billing = this.db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get(churchId);
    if (!billing) return { tier: null, status: 'no_billing', configured: this.isEnabled() };
    return {
      tier: billing.tier,
      tierName: TIER_NAMES[billing.tier] || billing.tier,
      billingInterval: this._normaliseBillingInterval(billing.billing_interval, billing.tier),
      status: billing.status,
      currentPeriodEnd: billing.current_period_end,
      cancelAtPeriodEnd: !!billing.cancel_at_period_end,
      configured: this.isEnabled(),
    };
  }

  listAll() {
    return this.db.prepare(`
      SELECT bc.*, c.name as church_name
      FROM billing_customers bc
      LEFT JOIN churches c ON c.churchId = bc.church_id
      ORDER BY bc.created_at DESC
    `).all();
  }

  // ─── REFERRAL CREDITS ──────────────────────────────────────────────────────

  /**
   * When a referred church completes checkout, credit the referrer with a free month.
   * Uses Stripe customer balance (negative = credit on next invoice).
   */
  async _processReferralCredit(referredChurchId, tier, stripeCustomerId) {
    // Look up the referral
    let referral;
    try {
      referral = this.db.prepare(
        "SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending' LIMIT 1"
      ).get(referredChurchId);
    } catch { return; } // table may not exist yet

    if (!referral) return;

    // Only valid for new accounts — referred church must have been created within the last 60 days
    try {
      const referred = this.db.prepare(
        'SELECT registeredAt FROM churches WHERE churchId = ?'
      ).get(referredChurchId);
      if (referred) {
        const daysSinceCreated = (Date.now() - new Date(referred.registeredAt).getTime()) / 86400000;
        if (daysSinceCreated > 60) {
          const now = new Date().toISOString();
          this.db.prepare("UPDATE referrals SET status = 'expired', converted_at = ? WHERE id = ?").run(now, referral.id);
          console.log(`[Referral] Referred church ${referredChurchId} is ${Math.round(daysSinceCreated)} days old — not a new account. Skipping credit.`);
          return;
        }
      }
    } catch { /* not critical */ }

    // Cap at 5 free months per referrer
    const MAX_REFERRAL_CREDITS = 5;
    let creditedCount = 0;
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM referrals WHERE referrer_id = ? AND status = 'credited'"
      ).get(referral.referrer_id);
      creditedCount = row?.cnt || 0;
    } catch { /* table may not exist */ }

    if (creditedCount >= MAX_REFERRAL_CREDITS) {
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE referrals SET status = 'converted', converted_at = ? WHERE id = ?
      `).run(now, referral.id);
      console.log(`[Referral] Referrer ${referral.referrer_id} has reached the ${MAX_REFERRAL_CREDITS}-credit cap. Marked as converted (no credit).`);
      return;
    }

    // Fixed referral credit amount — same for all tiers to prevent abuse
    const REFERRAL_CREDIT_CENTS = 4900; // $49 credit regardless of tier

    // Get referrer's billing info
    const referrerBilling = this.db.prepare(
      'SELECT stripe_customer_id, tier FROM billing_customers WHERE church_id = ? LIMIT 1'
    ).get(referral.referrer_id);

    if (!referrerBilling?.stripe_customer_id) {
      console.log(`[Referral] Referrer ${referral.referrer_id} has no Stripe customer — skipping credit`);
      return;
    }

    const creditAmountCents = REFERRAL_CREDIT_CENTS;
    const now = new Date().toISOString();

    try {
      // Add credit to referrer's Stripe customer balance (negative = credit)
      await stripe.customers.createBalanceTransaction(referrerBilling.stripe_customer_id, {
        amount: -creditAmountCents, // negative = credit
        currency: 'usd',
        description: `Referral credit: ${referral.referred_name || 'a friend'} signed up`,
      });

      // Update referral record
      this.db.prepare(`
        UPDATE referrals SET status = 'credited', credit_amount = ?, converted_at = ?, credited_at = ? WHERE id = ?
      `).run(creditAmountCents, now, now, referral.id);

      console.log(`[Referral] ✅ Credited ${creditAmountCents / 100} to referrer ${referral.referrer_id} for ${referral.referred_name}`);
    } catch (e) {
      // Mark as converted but not credited (manual follow-up needed)
      this.db.prepare(`
        UPDATE referrals SET status = 'converted', credit_amount = ?, converted_at = ? WHERE id = ?
      `).run(creditAmountCents, now, referral.id);
      console.error(`[Referral] Stripe credit failed: ${e.message}. Marked as converted for manual review.`);
    }
  }
}

module.exports = {
  BillingSystem,
  PRICES,
  TIER_NAMES,
  TIER_LIMITS,
  BILLING_INTERVALS,
  TRIAL_PERIOD_DAYS,
  GRACE_PERIOD_DAYS,
  _setStripeClientForTests,
  _resetStripeClientForTests,
};
