/**
 * Tests that autopilot access is correctly gated per billing tier.
 * Connect = blocked, Plus/Pro/Enterprise = allowed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('Billing autopilot tier access', () => {
  let BillingSystem;

  beforeEach(() => {
    const billingPath = require.resolve('../src/billing');
    delete require.cache[billingPath];
    try { delete require.cache[require.resolve('stripe')]; } catch {}
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
  });

  function createBilling() {
    const mockDb = {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    };
    return new BillingSystem(mockDb);
  }

  it('blocks autopilot for Connect tier', () => {
    const billing = createBilling();
    const result = billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'autopilot');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Plus');
  });

  it('allows autopilot for Plus tier', () => {
    const billing = createBilling();
    const result = billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'autopilot');
    expect(result.allowed).toBe(true);
  });

  it('allows autopilot for Pro tier', () => {
    const billing = createBilling();
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'autopilot');
    expect(result.allowed).toBe(true);
  });

  it('allows autopilot for Enterprise tier', () => {
    const billing = createBilling();
    const result = billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'autopilot');
    expect(result.allowed).toBe(true);
  });

  it('Connect tier limited to ATEM, OBS, vMix devices', () => {
    const billing = createBilling();

    // Allowed devices
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'atem').allowed).toBe(true);
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'obs').allowed).toBe(true);
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'vmix').allowed).toBe(true);

    // Blocked devices
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'propresenter').allowed).toBe(false);
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'companion').allowed).toBe(false);
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'epiphan').allowed).toBe(false);
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'aja').allowed).toBe(false);
  });

  it('Plus tier gets access to all devices', () => {
    const billing = createBilling();
    expect(billing.checkDeviceAccess({ billing_tier: 'plus' }, 'propresenter').allowed).toBe(true);
    expect(billing.checkDeviceAccess({ billing_tier: 'plus' }, 'companion').allowed).toBe(true);
    expect(billing.checkDeviceAccess({ billing_tier: 'plus' }, 'epiphan').allowed).toBe(true);
    expect(billing.checkDeviceAccess({ billing_tier: 'plus' }, 'aja').allowed).toBe(true);
  });
});
