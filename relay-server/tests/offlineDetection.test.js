/**
 * Tests for src/crons/offlineDetection.js — offline church detection and
 * Telegram alert dispatching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const setupOfflineDetection = require('../src/crons/offlineDetection');

// WebSocket.OPEN = 1
const WS_OPEN = 1;

function makeCtx(overrides = {}) {
  const churches = new Map();

  const db = {
    prepare: vi.fn((sql) => ({
      get: vi.fn(() => null),
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  };

  const scheduleEngine = {
    isServiceWindow: vi.fn(() => false),
  };

  const alertEngine = {
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  };

  const eventMode = {
    checkExpiry: vi.fn().mockResolvedValue(undefined),
  };

  const tallyBot = {};
  const log = vi.fn();
  const _intervals = [];

  return {
    db,
    churches,
    scheduleEngine,
    alertEngine,
    eventMode,
    tallyBot,
    log,
    _intervals,
    ...overrides,
  };
}

function makeRow(churchId, name = 'Test Church') {
  return { churchId, name };
}

function churchWithHeartbeat(minutesAgo, sockets = null) {
  const lastHeartbeat = Date.now() - minutesAgo * 60 * 1000;
  return {
    lastHeartbeat,
    sockets: sockets || new Map(),
    _offlineAlertSent: false,
    _criticalOfflineAlertSent: false,
  };
}

describe('setupOfflineDetection', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.ALERT_BOT_TOKEN = 'test-token';
    process.env.ADMIN_TELEGRAM_CHAT_ID = 'test-chat-id';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns checkOfflineChurches and start functions', () => {
    const ctx = makeCtx();
    const result = setupOfflineDetection(ctx);
    expect(typeof result.checkOfflineChurches).toBe('function');
    expect(typeof result.start).toBe('function');
  });

  it('skips churches not in the runtime map', () => {
    const ctx = makeCtx();
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    // c1 not added to churches map
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    expect(() => checkOfflineChurches()).not.toThrow();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches with no heartbeat (never connected)', () => {
    const ctx = makeCtx();
    const church = { lastHeartbeat: null, sockets: new Map() };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches in a maintenance window', () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(180); // 3 hours offline
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn((sql) => ({
      get: vi.fn(() => ({ id: 'mw1' })), // maintenance window found
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches currently in a service window', () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(180);
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    ctx.scheduleEngine.isServiceWindow = vi.fn(() => true);
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('resets alert flags and skips when church has an open socket', () => {
    const ctx = makeCtx();
    const openSocket = { readyState: WS_OPEN };
    const sockets = new Map([['sock1', openSocket]]);
    const church = { ...churchWithHeartbeat(5), sockets, _offlineAlertSent: true, _criticalOfflineAlertSent: true };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    expect(church._offlineAlertSent).toBe(false);
    expect(church._criticalOfflineAlertSent).toBe(false);
  });

  it('sends critical alert when offline 24+ hours', () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(25 * 60); // 25 hours
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1', 'Grace Church')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
      'test-chat-id',
      'test-token',
      expect.stringContaining('CRITICAL'),
    );
    expect(church._criticalOfflineAlertSent).toBe(true);
  });

  it('does not send critical alert twice (deduplication)', () => {
    const ctx = makeCtx();
    const church = { ...churchWithHeartbeat(25 * 60), _criticalOfflineAlertSent: true };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('sends warning alert when offline 2+ hours during daytime', () => {
    // Use fake timers to guarantee 10 AM — deterministically within the daytime window
    vi.useFakeTimers();
    const noonToday = new Date();
    noonToday.setHours(10, 0, 0, 0);
    vi.setSystemTime(noonToday);

    const ctx = makeCtx();
    const church = churchWithHeartbeat(3 * 60); // 3 hours offline
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1', 'Hope Church')]),
    }));

    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();

    expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
      'test-chat-id',
      'test-token',
      expect.stringContaining('Hope Church'),
    );
    vi.useRealTimers();
  });

  it('does NOT send warning during nighttime (11 PM - 6 AM)', () => {
    // Use fake timers to guarantee 2 AM — nighttime, should suppress warning
    vi.useFakeTimers();
    const nightTime = new Date();
    nightTime.setHours(2, 0, 0, 0);
    vi.setSystemTime(nightTime);

    const ctx = makeCtx();
    const church = churchWithHeartbeat(3 * 60); // 3 hours offline
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1', 'Night Church')]),
    }));

    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();

    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not send warning if already sent (_offlineAlertSent=true)', () => {
    const ctx = makeCtx();
    const church = { ...churchWithHeartbeat(3 * 60), _offlineAlertSent: true };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('does not send any alert if bot token is missing', () => {
    delete process.env.ALERT_BOT_TOKEN;
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
    const ctx = makeCtx();
    const church = churchWithHeartbeat(25 * 60);
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('does not send warning for churches offline less than 2 hours', () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(90); // 90 minutes
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('start() registers an interval that calls checkOfflineChurches', () => {
    vi.useFakeTimers();
    const ctx = makeCtx();
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => []),
    }));
    const { start } = setupOfflineDetection(ctx);
    start();
    expect(ctx._intervals.length).toBe(1);

    // Advance time to trigger the interval
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(ctx.eventMode.checkExpiry).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('uses IANA timezone to compute local hour when church.timezone is set', () => {
    const ctx = makeCtx();
    // Church with a valid IANA timezone — exercises the Intl.DateTimeFormat branch in getChurchLocalHour
    const church = { ...churchWithHeartbeat(25 * 60), timezone: 'UTC' };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1', 'Timezone Church')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    // Should not throw; timezone branch is exercised
    expect(() => checkOfflineChurches()).not.toThrow();
  });

  it('uses ANDREW_TELEGRAM_CHAT_ID as fallback when ADMIN_TELEGRAM_CHAT_ID is missing', () => {
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
    process.env.ANDREW_TELEGRAM_CHAT_ID = 'andrew-chat-id';

    const ctx = makeCtx();
    const church = churchWithHeartbeat(25 * 60);
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
      'andrew-chat-id',
      'test-token',
      expect.any(String),
    );
    delete process.env.ANDREW_TELEGRAM_CHAT_ID;
  });
});
