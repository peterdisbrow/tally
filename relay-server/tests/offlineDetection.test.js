/**
 * Tests for src/crons/offlineDetection.js — offline church detection and
 * Telegram alert dispatching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

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

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

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

  it('skips churches not in the runtime map', async () => {
    const ctx = makeCtx();
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    // c1 not added to churches map
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await expect(checkOfflineChurches()).resolves.toBeUndefined();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches with no heartbeat (never connected)', async () => {
    const ctx = makeCtx();
    const church = { lastHeartbeat: null, sockets: new Map() };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches in a maintenance window', async () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(180); // 3 hours offline
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn((sql) => ({
      get: vi.fn(() => ({ id: 'mw1' })), // maintenance window found
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('skips churches currently in a service window', async () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(180);
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    ctx.scheduleEngine.isServiceWindow = vi.fn(() => true);
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('resets alert flags and skips when church has an open socket', async () => {
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
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    expect(church._offlineAlertSent).toBe(false);
    expect(church._criticalOfflineAlertSent).toBe(false);
  });

  it('sends critical alert when offline 24+ hours', async () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(25 * 60); // 25 hours
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1', 'Grace Church')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
      'test-chat-id',
      'test-token',
      expect.stringContaining('CRITICAL'),
    );
    expect(church._criticalOfflineAlertSent).toBe(true);
  });

  it('does not send critical alert twice (deduplication)', async () => {
    const ctx = makeCtx();
    const church = { ...churchWithHeartbeat(25 * 60), _criticalOfflineAlertSent: true };
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('sends warning alert when offline 2+ hours during daytime', async () => {
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
    await checkOfflineChurches();

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

  it('does not send any alert if bot token is missing', async () => {
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
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('does not send warning for churches offline less than 2 hours', async () => {
    const ctx = makeCtx();
    const church = churchWithHeartbeat(90); // 90 minutes
    ctx.churches.set('c1', church);
    ctx.db.prepare = vi.fn(() => ({
      get: vi.fn(() => null),
      all: vi.fn(() => [makeRow('c1')]),
    }));
    const { checkOfflineChurches } = setupOfflineDetection(ctx);
    await checkOfflineChurches();
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

  it('uses IANA timezone to compute local hour when church.timezone is set', async () => {
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
    await expect(checkOfflineChurches()).resolves.toBeUndefined();
  });

  it('uses ANDREW_TELEGRAM_CHAT_ID as fallback when ADMIN_TELEGRAM_CHAT_ID is missing', async () => {
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
    await checkOfflineChurches();
    expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
      'andrew-chat-id',
      'test-token',
      expect.any(String),
    );
    delete process.env.ANDREW_TELEGRAM_CHAT_ID;
  });

  it('reads timezone from the SQL row when the runtime church has none', async () => {
    // Regression: in production, churches loaded into the runtime map at
    // startup don't carry `timezone` until the agent connects and sends a
    // status update (server.js:910-928 vs :4751). If we only consulted the
    // runtime map for timezone, getChurchLocalHour would silently fall back
    // to server local time — producing a time-of-day-dependent suppression
    // of the night-time alert window for any church not in the relay's local
    // tz. Pin it to UTC + a 03:00 UTC frozen clock so the local-server hour
    // can never accidentally match.
    const fixedNow = Date.UTC(2026, 0, 15, 3, 0, 0); // 2026-01-15T03:00:00Z — UTC night
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const ctx = makeCtx();
      // SQL-row timezone is 'America/Anchorage' (UTC-9 in winter → 18:00 local
      // when UTC is 03:00 → NOT night). If the impl only looked at the runtime
      // church (which lacks timezone), it would compute server-local hour and
      // potentially classify as night.
      const church = churchWithHeartbeat(180); // 3h offline, no timezone field
      ctx.churches.set('c1', church);
      ctx.db.prepare = vi.fn(() => ({
        get: vi.fn(() => null),
        all: vi.fn(() => [{ churchId: 'c1', name: 'Anchorage Church', timezone: 'America/Anchorage' }]),
      }));
      const { checkOfflineChurches } = setupOfflineDetection(ctx);
      await checkOfflineChurches();
      expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
        'test-chat-id',
        'test-token',
        expect.stringContaining('Anchorage Church'),
      );
    } finally {
      Date.now = realDateNow;
    }
  });

  it('uses the query-client path when only a query client is available', async () => {
    // Pin the clock to a UTC daytime hour so the night-suppression check
    // (localHour < 6 || >= 23) never accidentally swallows the alert. Without
    // this, the test was time-of-day dependent — passing during UTC daylight
    // and failing between 23:00–05:59 UTC (any TZ at "night" would suppress).
    const fixedNow = Date.UTC(2026, 5, 15, 14, 0, 0); // 2026-06-15T14:00:00Z = 14:00 UTC = clearly daytime
    const realDateNow = Date.now;
    Date.now = () => fixedNow;
    let sqlite, queryClient;
    try {
      sqlite = new Database(':memory:');
      sqlite.exec(`
        CREATE TABLE churches (
          churchId TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          timezone TEXT DEFAULT '',
          lastHeartbeat INTEGER
        );
        CREATE TABLE maintenance_windows (
          id TEXT PRIMARY KEY,
          churchId TEXT NOT NULL,
          startTime TEXT NOT NULL,
          endTime TEXT NOT NULL
        );
      `);
      sqlite.prepare(
        'INSERT INTO churches (churchId, name, timezone, lastHeartbeat) VALUES (?, ?, ?, ?)'
      ).run('c1', 'Query Church', 'UTC', fixedNow - 3 * 60 * 60 * 1000);

      queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: sqlite });
      const ctx = makeCtx({ db: { queryClient }, churches: new Map([['c1', churchWithHeartbeat(180)]]) });
      // Runtime church.lastHeartbeat is set off the (now-fixed) Date.now —
      // re-pin it explicitly to fixedNow - 3h so it lines up regardless of
      // when churchWithHeartbeat() ran relative to the Date.now mutation.
      ctx.churches.get('c1').lastHeartbeat = fixedNow - 3 * 60 * 60 * 1000;
      const { checkOfflineChurches } = setupOfflineDetection(ctx);
      await checkOfflineChurches();

      expect(ctx.alertEngine.sendTelegramMessage).toHaveBeenCalledWith(
        'test-chat-id',
        'test-token',
        expect.stringContaining('Query Church'),
      );
    } finally {
      Date.now = realDateNow;
      if (queryClient) await queryClient.close();
      if (sqlite) sqlite.close();
    }
  });
});
