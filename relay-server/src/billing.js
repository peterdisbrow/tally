/**
 * Tally Billing — Stripe Integration
 *
 * Handles subscriptions for Connect ($49/mo), Pro ($149/mo), Managed ($299/mo)
 * and one-time Event mode ($99/event).
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

let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch {
  console.warn('⚠️  stripe package not installed — billing disabled. Run: npm install stripe');
}

// ─── PRICE IDS ───────────────────────────────────────────────────────────────
// Set these in .env or override with Stripe dashboard IDs

const PRICES = {
  connect:  process.env.STRIPE_PRICE_CONNECT  || 'price_connect_placeholder',
  pro:      process.env.STRIPE_PRICE_PRO       || 'price_pro_placeholder',
  managed:  process.env.STRIPE_PRICE_MANAGED   || 'price_managed_placeholder',
  event:    process.env.STRIPE_PRICE_EVENT     || 'price_event_placeholder', // one-time
};

const TIER_NAMES = { connect: 'Connect', pro: 'Pro', managed: 'Managed', event: 'Event' };
const TIER_LIMITS = {
  connect: { churches: 1, devices: ['atem', 'obs', 'vmix'] },
  pro:     { churches: 999, devices: 'all' },
  managed: { churches: 999, devices: 'all' },
  event:   { churches: 1, devices: 'all' },
};

class BillingSystem {
  constructor(db) {
    this.db = db;
    this._ensureSchema();
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
        status TEXT NOT NULL DEFAULT 'trialing',
        trial_ends_at TEXT,
        current_period_end TEXT,
        cancel_at_period_end INTEGER DEFAULT 0,
        email TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Add billing columns to churches table
    const cols = {
      billing_tier: 'TEXT DEFAULT NULL',
      billing_status: "TEXT DEFAULT 'inactive'",
      billing_trial_ends: 'TEXT DEFAULT NULL',
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

  // ─── CHECKOUT ─────────────────────────────────────────────────────────────

  /**
   * Create a Stripe Checkout session.
   * Returns { url } to redirect the customer to.
   */
  async createCheckout({ tier, churchId, email, successUrl, cancelUrl, isEvent = false }) {
    if (!this.isEnabled()) throw new Error('Stripe not configured');

    const priceId = PRICES[tier];
    if (!priceId || priceId.includes('placeholder')) {
      throw new Error(`Stripe price ID for "${tier}" not configured. Set STRIPE_PRICE_${tier.toUpperCase()} in .env`);
    }

    const sessionParams = {
      mode: isEvent ? 'payment' : 'subscription',
      customer_email: email || undefined,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  cancelUrl  || `${process.env.APP_URL}/billing/cancel`,
      metadata: { churchId: churchId || '', tier },
      allow_promotion_codes: true,
    };

    if (!isEvent) {
      // 14-day free trial for subscriptions
      sessionParams.subscription_data = {
        trial_period_days: 14,
        metadata: { churchId: churchId || '', tier },
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    // Store pending session
    if (churchId) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT OR REPLACE INTO billing_customers
          (id, church_id, stripe_session_id, tier, status, email, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(`billing_${churchId}`, churchId, session.id, tier, email || '', now, now);
    }

    return { url: session.url, sessionId: session.id };
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
    }

    return { received: true };
  }

  async _onCheckoutCompleted(session) {
    const { churchId, tier } = session.metadata || {};
    const now = new Date().toISOString();

    // Update billing record with customer ID
    if (session.customer) {
      this.db.prepare(`
        UPDATE billing_customers
        SET stripe_customer_id = ?, stripe_subscription_id = ?, status = 'active', updated_at = ?
        WHERE stripe_session_id = ? OR church_id = ?
      `).run(session.customer, session.subscription || null, now, session.id, churchId || '');
    }

    // Activate the church
    if (churchId) {
      this._activateChurch(churchId, tier, 'active');
    }

    console.log(`[Billing] ✅ Checkout complete for church ${churchId} (${tier})`);
  }

  async _onSubscriptionUpdated(sub) {
    const { churchId, tier } = sub.metadata || {};
    const status = sub.status; // active, trialing, past_due, canceled, etc.
    const periodEnd = new Date(sub.current_period_end * 1000).toISOString();
    const now = new Date().toISOString();

    this.db.prepare(`
      UPDATE billing_customers
      SET status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ?
      WHERE stripe_subscription_id = ? OR church_id = ?
    `).run(status, periodEnd, sub.cancel_at_period_end ? 1 : 0, now, sub.id, churchId || '');

    if (churchId) {
      const isActive = ['active', 'trialing'].includes(status);
      this._activateChurch(churchId, tier || this._getChurchTier(churchId), isActive ? status : 'inactive');
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
    }
  }

  async _onPaymentFailed(invoice) {
    const subId = invoice.subscription;
    const billing = this.db.prepare('SELECT * FROM billing_customers WHERE stripe_subscription_id = ?').get(subId);
    if (billing) {
      this.db.prepare(`UPDATE billing_customers SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`)
        .run(new Date().toISOString(), subId);
      console.log(`[Billing] ⚠️ Payment failed for church ${billing.church_id}`);
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

  // ─── CHURCH ACTIVATION ────────────────────────────────────────────────────

  _activateChurch(churchId, tier, status) {
    this.db.prepare(`
      UPDATE churches SET billing_tier = ?, billing_status = ? WHERE churchId = ?
    `).run(tier || 'connect', status, churchId);
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

  // ─── TIER CHECKING ────────────────────────────────────────────────────────

  /**
   * Check if a church's billing allows a feature.
   * Returns { allowed: bool, reason?: string }
   */
  checkAccess(church, feature) {
    if (!this.isEnabled()) return { allowed: true }; // billing disabled = all access

    const tier = church.billing_tier || 'connect';
    const status = church.billing_status || 'inactive';

    // Allow during grace period (active or trialing)
    if (!['active', 'trialing'].includes(status)) {
      return { allowed: false, reason: `Subscription ${status}. Visit tally.atemschool.com to manage billing.` };
    }

    const limits = TIER_LIMITS[tier] || TIER_LIMITS.connect;

    // Device access
    if (feature === 'multi_church' && limits.churches === 1) {
      return { allowed: false, reason: 'Multi-church support requires Pro or Managed plan.' };
    }

    if (feature === 'planning_center' && tier === 'connect') {
      return { allowed: false, reason: 'Planning Center sync requires Pro or Managed plan.' };
    }

    if (feature === 'monthly_report' && tier === 'connect') {
      return { allowed: false, reason: 'Monthly reports require Pro or Managed plan.' };
    }

    if (feature === 'reseller_api' && tier !== 'managed') {
      return { allowed: false, reason: 'Reseller API requires Managed plan.' };
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
}

module.exports = { BillingSystem, PRICES, TIER_NAMES, TIER_LIMITS };
