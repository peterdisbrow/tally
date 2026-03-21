/**
 * Regression-prevention tests: plan feature gating
 *
 * Systematically verifies that:
 *   - Each tier (connect, plus, pro, managed, event) can access exactly the
 *     features it should.
 *   - A feature available on plus is NOT available on connect.
 *   - A feature available on pro is also available on managed.
 *   - Blocked features return { allowed: false, reason: string }.
 *   - checkAccess with an unknown feature returns safe default { allowed: true }.
 *   - event tier behaves correctly (it has rooms=1 and devices='all').
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function clearBillingCache() {
  const billingPath = require.resolve('../src/billing');
  delete require.cache[billingPath];
}

function makeBilling() {
  clearBillingCache();
  process.env.STRIPE_SECRET_KEY = '';
  const { BillingSystem } = require('../src/billing');
  const mockDb = {
    exec: () => {},
    prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
  };
  return new BillingSystem(mockDb);
}

function church(tier, status = 'active') {
  return { billing_tier: tier, billing_status: status };
}

// ─── Feature matrix ──────────────────────────────────────────────────────────
//
// Feature           | connect | plus | pro | managed | event
// ──────────────────┼─────────┼──────┼─────┼─────────┼──────
// multi_church      |   ✗     |  ✓   |  ✓  |   ✓     |  ✗
// autopilot         |   ✗     |  ✓   |  ✓  |   ✓     |  ✓  (only connect blocked)
// propresenter      |   ✗     |  ✓   |  ✓  |   ✓     |  ✓
// oncall_rotation   |   ✗     |  ✓   |  ✓  |   ✓     |  ✓
// live_preview      |   ✗     |  ✓   |  ✓  |   ✓     |  ✓
// scheduler         |   ✗     |  ✓   |  ✓  |   ✓     |  ✓
// planning_center   |   ✗     |  ✗   |  ✓  |   ✓     |  ✓  (connect+plus blocked)
// monthly_report    |   ✗     |  ✗   |  ✓  |   ✓     |  ✓
// scheduler_auto    |   ✗     |  ✗   |  ✓  |   ✓     |  ✓
// reseller_api      |   ✗     |  ✗   |  ✗  |   ✓     |  ✗

const ALL_TIERS = ['connect', 'plus', 'pro', 'managed', 'event'];

// ─── multi_church ────────────────────────────────────────────────────────────

describe('feature: multi_church', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked (rooms=1, not > 1)', () => {
    const r = billing.checkAccess(church('connect'), 'multi_church');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('event: blocked (rooms=1)', () => {
    const r = billing.checkAccess(church('event'), 'multi_church');
    expect(r.allowed).toBe(false);
  });

  it('plus: allowed (rooms=3)', () => {
    expect(billing.checkAccess(church('plus'), 'multi_church').allowed).toBe(true);
  });

  it('pro: allowed (rooms=5)', () => {
    expect(billing.checkAccess(church('pro'), 'multi_church').allowed).toBe(true);
  });

  it('managed: allowed (rooms=Infinity)', () => {
    expect(billing.checkAccess(church('managed'), 'multi_church').allowed).toBe(true);
  });

  it('reason message mentions plus when connect is denied', () => {
    const r = billing.checkAccess(church('connect'), 'multi_church');
    expect(r.reason).toMatch(/Plus/i);
  });
});

// ─── autopilot ───────────────────────────────────────────────────────────────

describe('feature: autopilot', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    const r = billing.checkAccess(church('connect'), 'autopilot');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Plus/i);
  });

  const allowedTiers = ['plus', 'pro', 'managed', 'event'];
  for (const tier of allowedTiers) {
    it(`${tier}: allowed`, () => {
      expect(billing.checkAccess(church(tier), 'autopilot').allowed).toBe(true);
    });
  }
});

// ─── propresenter ────────────────────────────────────────────────────────────

describe('feature: propresenter', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'propresenter').allowed).toBe(false);
  });

  const allowedTiers = ['plus', 'pro', 'managed', 'event'];
  for (const tier of allowedTiers) {
    it(`${tier}: allowed`, () => {
      expect(billing.checkAccess(church(tier), 'propresenter').allowed).toBe(true);
    });
  }
});

// ─── oncall_rotation ─────────────────────────────────────────────────────────

describe('feature: oncall_rotation', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'oncall_rotation').allowed).toBe(false);
  });

  for (const tier of ['plus', 'pro', 'managed', 'event']) {
    it(`${tier}: allowed`, () => {
      expect(billing.checkAccess(church(tier), 'oncall_rotation').allowed).toBe(true);
    });
  }
});

// ─── live_preview ─────────────────────────────────────────────────────────────

describe('feature: live_preview', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'live_preview').allowed).toBe(false);
  });

  for (const tier of ['plus', 'pro', 'managed', 'event']) {
    it(`${tier}: allowed`, () => {
      expect(billing.checkAccess(church(tier), 'live_preview').allowed).toBe(true);
    });
  }
});

// ─── scheduler ───────────────────────────────────────────────────────────────

describe('feature: scheduler (manual rundowns)', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'scheduler').allowed).toBe(false);
  });

  for (const tier of ['plus', 'pro', 'managed', 'event']) {
    it(`${tier}: allowed`, () => {
      expect(billing.checkAccess(church(tier), 'scheduler').allowed).toBe(true);
    });
  }
});

// ─── scheduler_auto ───────────────────────────────────────────────────────────

describe('feature: scheduler_auto (auto-triggered cues)', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'scheduler_auto').allowed).toBe(false);
  });

  it('plus: blocked (plus gets manual, not auto)', () => {
    expect(billing.checkAccess(church('plus'), 'scheduler_auto').allowed).toBe(false);
  });

  it('pro: allowed', () => {
    expect(billing.checkAccess(church('pro'), 'scheduler_auto').allowed).toBe(true);
  });

  it('managed: allowed', () => {
    expect(billing.checkAccess(church('managed'), 'scheduler_auto').allowed).toBe(true);
  });

  it('event: allowed', () => {
    expect(billing.checkAccess(church('event'), 'scheduler_auto').allowed).toBe(true);
  });
});

// ─── planning_center ──────────────────────────────────────────────────────────

describe('feature: planning_center', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'planning_center').allowed).toBe(false);
  });

  it('plus: blocked (planning center is pro+ only)', () => {
    expect(billing.checkAccess(church('plus'), 'planning_center').allowed).toBe(false);
  });

  it('pro: allowed', () => {
    expect(billing.checkAccess(church('pro'), 'planning_center').allowed).toBe(true);
  });

  it('managed: allowed', () => {
    expect(billing.checkAccess(church('managed'), 'planning_center').allowed).toBe(true);
  });

  it('event: allowed (event is not connect or plus)', () => {
    expect(billing.checkAccess(church('event'), 'planning_center').allowed).toBe(true);
  });
});

// ─── monthly_report ──────────────────────────────────────────────────────────

describe('feature: monthly_report', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('connect: blocked', () => {
    expect(billing.checkAccess(church('connect'), 'monthly_report').allowed).toBe(false);
  });

  it('plus: blocked', () => {
    expect(billing.checkAccess(church('plus'), 'monthly_report').allowed).toBe(false);
  });

  it('pro: allowed', () => {
    expect(billing.checkAccess(church('pro'), 'monthly_report').allowed).toBe(true);
  });

  it('managed: allowed', () => {
    expect(billing.checkAccess(church('managed'), 'monthly_report').allowed).toBe(true);
  });

  it('event: allowed', () => {
    expect(billing.checkAccess(church('event'), 'monthly_report').allowed).toBe(true);
  });
});

// ─── reseller_api ────────────────────────────────────────────────────────────

describe('feature: reseller_api', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('managed: allowed (only tier with reseller_api)', () => {
    expect(billing.checkAccess(church('managed'), 'reseller_api').allowed).toBe(true);
  });

  for (const tier of ['connect', 'plus', 'pro', 'event']) {
    it(`${tier}: blocked`, () => {
      const r = billing.checkAccess(church(tier), 'reseller_api');
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/Enterprise/i);
    });
  }
});

// ─── Unknown feature — safe default ──────────────────────────────────────────

describe('feature: unknown feature returns safe default (allowed: true)', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  for (const tier of ALL_TIERS) {
    it(`${tier}: unknown feature 'xyz_unknown' returns allowed:true`, () => {
      expect(billing.checkAccess(church(tier), 'xyz_unknown').allowed).toBe(true);
    });
  }

  it('undefined feature returns allowed:true', () => {
    expect(billing.checkAccess(church('connect'), undefined).allowed).toBe(true);
  });

  it('empty string feature returns allowed:true', () => {
    expect(billing.checkAccess(church('connect'), '').allowed).toBe(true);
  });
});

// ─── Blocked feature reason strings ──────────────────────────────────────────

describe('blocked features always include a reason string', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  const blockedCases = [
    { tier: 'connect', feature: 'multi_church' },
    { tier: 'connect', feature: 'autopilot' },
    { tier: 'connect', feature: 'propresenter' },
    { tier: 'connect', feature: 'oncall_rotation' },
    { tier: 'connect', feature: 'live_preview' },
    { tier: 'connect', feature: 'scheduler' },
    { tier: 'connect', feature: 'scheduler_auto' },
    { tier: 'connect', feature: 'planning_center' },
    { tier: 'connect', feature: 'monthly_report' },
    { tier: 'connect', feature: 'reseller_api' },
    { tier: 'plus', feature: 'planning_center' },
    { tier: 'plus', feature: 'monthly_report' },
    { tier: 'plus', feature: 'scheduler_auto' },
    { tier: 'plus', feature: 'reseller_api' },
    { tier: 'pro', feature: 'reseller_api' },
  ];

  for (const { tier, feature } of blockedCases) {
    it(`${tier}/${feature}: reason is a non-empty string`, () => {
      const r = billing.checkAccess(church(tier), feature);
      expect(r.allowed).toBe(false);
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    });
  }
});

// ─── device_access feature ────────────────────────────────────────────────────
// The 'device_access' feature string is a passthrough; actual gating is via
// checkDeviceAccess(). Verify this documented behavior.

describe('feature: device_access is a passthrough to checkDeviceAccess()', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  it('checkAccess("device_access") always returns allowed:true for any tier', () => {
    for (const tier of ALL_TIERS) {
      expect(billing.checkAccess(church(tier), 'device_access').allowed).toBe(true);
    }
  });

  it('checkDeviceAccess gates actual devices for connect tier', () => {
    expect(billing.checkDeviceAccess(church('connect'), 'atem').allowed).toBe(true);
    expect(billing.checkDeviceAccess(church('connect'), 'obs').allowed).toBe(true);
    expect(billing.checkDeviceAccess(church('connect'), 'vmix').allowed).toBe(true);
    expect(billing.checkDeviceAccess(church('connect'), 'epiphan').allowed).toBe(false);
    expect(billing.checkDeviceAccess(church('connect'), 'blackmagic').allowed).toBe(false);
    expect(billing.checkDeviceAccess(church('connect'), 'companion').allowed).toBe(false);
  });

  it('checkDeviceAccess allows all devices for plus+ tiers', () => {
    const advancedDevices = ['propresenter', 'companion', 'epiphan', 'aja', 'teradek', 'birddog', 'blackmagic'];
    for (const tier of ['plus', 'pro', 'managed', 'event']) {
      for (const dev of advancedDevices) {
        expect(billing.checkDeviceAccess(church(tier), dev).allowed).toBe(true);
      }
    }
  });
});

// ─── Feature gating with Stripe enabled: billing status overrides tier ────────

describe('feature gating with Stripe enabled: billing status blocks all features', () => {
  let billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    const { BillingSystem } = require('../src/billing');
    const mockDb = {
      exec: () => {},
      prepare: () => ({ run: () => {}, get: () => null, all: () => [] }),
    };
    billing = new BillingSystem(mockDb);
    billing.isEnabled = () => true; // simulate Stripe configured
  });

  it('managed tier with inactive status is fully blocked', () => {
    const r = billing.checkAccess(church('managed', 'inactive'), 'reseller_api');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/inactive/);
  });

  it('pro tier with past_due status is blocked', () => {
    const r = billing.checkAccess(church('pro', 'past_due'), 'planning_center');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/past_due/);
  });

  it('managed tier with trialing status allows features', () => {
    expect(billing.checkAccess(church('managed', 'trialing'), 'reseller_api').allowed).toBe(true);
  });

  it('pro tier with active status allows planning_center', () => {
    expect(billing.checkAccess(church('pro', 'active'), 'planning_center').allowed).toBe(true);
  });

  it('connect tier with active status still blocked by tier for multi_church', () => {
    const r = billing.checkAccess(church('connect', 'active'), 'multi_church');
    expect(r.allowed).toBe(false);
  });
});

// ─── Plus tier is the boundary: features below plus vs at/above plus ──────────

describe('plus is the minimum tier boundary for most features', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  // Features that require EXACTLY plus or higher (connect is the only blocked tier)
  const plusOrHigherFeatures = ['autopilot', 'propresenter', 'oncall_rotation', 'live_preview', 'scheduler'];

  for (const feature of plusOrHigherFeatures) {
    it(`${feature}: connect blocked, plus+ allowed`, () => {
      expect(billing.checkAccess(church('connect'), feature).allowed).toBe(false);
      for (const tier of ['plus', 'pro', 'managed']) {
        expect(billing.checkAccess(church(tier), feature).allowed).toBe(true);
      }
    });
  }
});

// ─── Pro tier is the boundary for pro+ features ───────────────────────────────

describe('pro is the minimum tier boundary for advanced features', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  const proOrHigherFeatures = ['planning_center', 'monthly_report', 'scheduler_auto'];

  for (const feature of proOrHigherFeatures) {
    it(`${feature}: connect+plus blocked, pro+managed allowed`, () => {
      expect(billing.checkAccess(church('connect'), feature).allowed).toBe(false);
      expect(billing.checkAccess(church('plus'), feature).allowed).toBe(false);
      expect(billing.checkAccess(church('pro'), feature).allowed).toBe(true);
      expect(billing.checkAccess(church('managed'), feature).allowed).toBe(true);
    });
  }
});

// ─── Managed is the only tier for reseller_api ────────────────────────────────

describe('managed is the only tier for reseller_api', () => {
  let billing;
  beforeEach(() => { billing = makeBilling(); });

  for (const tier of ['connect', 'plus', 'pro', 'event']) {
    it(`${tier}: reseller_api blocked`, () => {
      expect(billing.checkAccess(church(tier), 'reseller_api').allowed).toBe(false);
    });
  }

  it('managed: reseller_api allowed', () => {
    expect(billing.checkAccess(church('managed'), 'reseller_api').allowed).toBe(true);
  });
});
