#!/usr/bin/env node
/**
 * Stripe Product & Price Setup Script
 *
 * Creates all Tally products and prices in your Stripe account and outputs
 * the env vars you need for Railway / .env.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js
 *
 * This script is idempotent — if products already exist (matched by metadata.tally_tier),
 * it skips them and only creates what's missing.
 */

const TIERS = [
  {
    tier: 'connect',
    name: 'Tally Connect',
    description: 'Single-room church production monitoring with basic alerts and remote control.',
    monthly: 4900,   // $49/mo
    annual: 49000,   // $490/yr (2 months free)
  },
  {
    tier: 'plus',
    name: 'Tally Plus',
    description: 'Multi-room monitoring with signal failover, AI diagnostics, and pre-service checks.',
    monthly: 9900,   // $99/mo
    annual: 99000,   // $990/yr
  },
  {
    tier: 'pro',
    name: 'Tally Pro',
    description: 'Full-featured monitoring for large churches with unlimited rooms and priority support.',
    monthly: 14900,  // $149/mo
    annual: 149000,  // $1490/yr
  },
  {
    tier: 'managed',
    name: 'Tally Enterprise',
    description: 'Fully managed church production monitoring with dedicated support and SLA.',
    monthly: 49900,  // $499/mo
    annual: 499000,  // $4990/yr
  },
];

const EVENT_TIERS = [
  {
    tier: 'event',
    name: 'Tally Event — Single',
    description: 'One-time event monitoring for a single production.',
    amount: 29900,   // $299
    envKey: 'STRIPE_PRICE_EVENT',
  },
];

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('Error: STRIPE_SECRET_KEY environment variable is required.');
    console.error('Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.js');
    process.exit(1);
  }

  const isLive = key.startsWith('sk_live_');
  console.log(`\n  Stripe mode: ${isLive ? '🔴 LIVE' : '🟡 TEST'}\n`);

  if (isLive) {
    console.log('  ⚠️  You are using a LIVE Stripe key. Products and prices will be created in your live account.');
    console.log('  Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise(r => setTimeout(r, 5000));
  }

  let stripe;
  try {
    stripe = require('stripe')(key);
  } catch {
    console.error('Error: stripe package not installed. Run: npm install stripe');
    process.exit(1);
  }

  // Check for existing products
  const existing = await stripe.products.list({ limit: 100, active: true });
  const existingByTier = {};
  for (const p of existing.data) {
    if (p.metadata?.tally_tier) existingByTier[p.metadata.tally_tier] = p;
  }

  const envVars = {};

  // Create subscription products + prices
  for (const t of TIERS) {
    let product = existingByTier[t.tier];
    if (product) {
      console.log(`  ✓ ${t.name} — product already exists (${product.id})`);
    } else {
      product = await stripe.products.create({
        name: t.name,
        description: t.description,
        metadata: { tally_tier: t.tier },
      });
      console.log(`  + ${t.name} — created product ${product.id}`);
    }

    // Monthly price
    const monthlyEnv = `STRIPE_PRICE_${t.tier.toUpperCase()}`;
    const existingMonthly = await findPrice(stripe, product.id, 'month');
    if (existingMonthly) {
      envVars[monthlyEnv] = existingMonthly.id;
      console.log(`    ✓ Monthly ($${t.monthly / 100}/mo) — ${existingMonthly.id}`);
    } else {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: t.monthly,
        currency: 'usd',
        recurring: { interval: 'month' },
        metadata: { tally_tier: t.tier, interval: 'monthly' },
      });
      envVars[monthlyEnv] = price.id;
      console.log(`    + Monthly ($${t.monthly / 100}/mo) — ${price.id}`);
    }

    // Annual price
    const annualEnv = `STRIPE_PRICE_${t.tier.toUpperCase()}_ANNUAL`;
    const existingAnnual = await findPrice(stripe, product.id, 'year');
    if (existingAnnual) {
      envVars[annualEnv] = existingAnnual.id;
      console.log(`    ✓ Annual ($${t.annual / 100}/yr) — ${existingAnnual.id}`);
    } else {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: t.annual,
        currency: 'usd',
        recurring: { interval: 'year' },
        metadata: { tally_tier: t.tier, interval: 'annual' },
      });
      envVars[annualEnv] = price.id;
      console.log(`    + Annual ($${t.annual / 100}/yr) — ${price.id}`);
    }
  }

  // Create event (one-time) products + prices
  for (const t of EVENT_TIERS) {
    let product = existingByTier[t.tier];
    if (product) {
      console.log(`  ✓ ${t.name} — product already exists (${product.id})`);
    } else {
      product = await stripe.products.create({
        name: t.name,
        description: t.description,
        metadata: { tally_tier: t.tier },
      });
      console.log(`  + ${t.name} — created product ${product.id}`);
    }

    const existingPrice = await findOneTimePrice(stripe, product.id);
    if (existingPrice) {
      envVars[t.envKey] = existingPrice.id;
      console.log(`    ✓ One-time ($${t.amount / 100}) — ${existingPrice.id}`);
    } else {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: t.amount,
        currency: 'usd',
        metadata: { tally_tier: t.tier, interval: 'one_time' },
      });
      envVars[t.envKey] = price.id;
      console.log(`    + One-time ($${t.amount / 100}) — ${price.id}`);
    }
  }

  // Output env vars
  console.log('\n━━━ Copy these to Railway / .env ━━━\n');
  for (const [k, v] of Object.entries(envVars)) {
    console.log(`${k}=${v}`);
  }
  console.log('');
}

async function findPrice(stripe, productId, interval) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 10 });
  return prices.data.find(p => p.recurring?.interval === interval);
}

async function findOneTimePrice(stripe, productId) {
  const prices = await stripe.prices.list({ product: productId, active: true, limit: 10 });
  return prices.data.find(p => !p.recurring);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
