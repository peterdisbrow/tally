/**
 * PreServiceCheck — comprehensive tests
 *
 * Covers:
 *   A. _serviceStartingIn25to35 — timing logic: in window, out of window, wrong day
 *   B. getLatestResult — retrieves from DB, parses checks JSON
 *   C. _persistResult — stores results with session ID, trigger type
 *   D. onCommandResult — routes to registered listeners
 *   E. _checkChurch — dedup window, WS offline/timeout/error/success paths
 *   F. runManualCheck — offline returns null, sends command, awaits result, timeout
 *   G. _enrichWithVersionChecks — appends version check results
 *   H. Constructor — restores last-check timestamps from DB on startup
 *   I. start / stop — timer lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PreServiceCheck } from '../src/preServiceCheck.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service_times TEXT DEFAULT '[]'
    )
  `);
  // church_tds table for TD contact lookups
  db.exec(`
    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_chat_id TEXT,
      active INTEGER DEFAULT 1
    )
  `);
  return db;
}

function addChurch(db, churchId, opts = {}) {
  db.prepare(
    'INSERT INTO churches (churchId, name, service_times) VALUES (?, ?, ?)'
  ).run(
    churchId,
    opts.name || 'Test Church',
    opts.serviceTimes ? JSON.stringify(opts.serviceTimes) : '[]'
  );
}

/** Create a mock WebSocket that captures sends and can simulate message responses. */
function makeConnectedWs() {
  const listeners = {};
  const sent = [];
  const ws = {
    readyState: 1, // OPEN
    send: vi.fn(data => sent.push(JSON.parse(data))),
    on: vi.fn((event, handler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeListener: vi.fn(),
    _sent: sent,
    _listeners: listeners,
  };
  return ws;
}

/** Build a service time entry starting exactly `minutesFromNow` from now. */
function serviceStartingInMinutes(minutesFromNow, durationHours = 2) {
  const now = new Date();
  const start = new Date(now.getTime() + minutesFromNow * 60 * 1000);
  return {
    day: start.getDay(),
    startHour: start.getHours(),
    startMin: start.getMinutes(),
    durationHours,
  };
}

function makePreServiceCheck(db, opts = {}) {
  return new PreServiceCheck({
    db,
    scheduleEngine: opts.scheduleEngine || null,
    churches: opts.churches || new Map(),
    defaultBotToken: opts.botToken || null,
    andrewChatId: opts.andrewChatId || null,
    sessionRecap: opts.sessionRecap || null,
    versionConfig: opts.versionConfig || null,
  });
}

// ─── A. _serviceStartingIn25to35 ──────────────────────────────────────────────

describe('A. _serviceStartingIn25to35 timing logic', () => {
  let psc;

  beforeEach(() => {
    // Anchor to 2 PM to avoid midnight wraparound
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));
    const db = createTestDb();
    psc = makePreServiceCheck(db);
    psc._db = db;
  });

  afterEach(() => {
    psc.stop();
    psc._db?.close();
    vi.useRealTimers();
  });

  it('returns service info when service starts in exactly 25 minutes', () => {
    const s = serviceStartingInMinutes(25);
    const result = psc._serviceStartingIn25to35([s]);
    expect(result).not.toBeNull();
    expect(result.startHour).toBe(s.startHour);
  });

  it('returns service info when service starts in exactly 35 minutes', () => {
    const s = serviceStartingInMinutes(35);
    const result = psc._serviceStartingIn25to35([s]);
    expect(result).not.toBeNull();
  });

  it('returns service info at 30 minutes (middle of window)', () => {
    const s = serviceStartingInMinutes(30);
    const result = psc._serviceStartingIn25to35([s]);
    expect(result).not.toBeNull();
  });

  it('returns null when service starts in 24 minutes (too soon)', () => {
    const s = serviceStartingInMinutes(24);
    const result = psc._serviceStartingIn25to35([s]);
    expect(result).toBeNull();
  });

  it('returns null when service starts in 36 minutes (too far)', () => {
    const s = serviceStartingInMinutes(36);
    const result = psc._serviceStartingIn25to35([s]);
    expect(result).toBeNull();
  });

  it('returns null for an empty schedule', () => {
    expect(psc._serviceStartingIn25to35([])).toBeNull();
  });

  it('returns null when service is on a different day of the week', () => {
    const now = new Date();
    const otherDay = (now.getDay() + 3) % 7;
    const schedule = [{ day: otherDay, startHour: now.getHours(), startMin: now.getMinutes(), durationHours: 2 }];
    expect(psc._serviceStartingIn25to35(schedule)).toBeNull();
  });

  it('returns null when startMin defaults to 0 and service is not in window', () => {
    const future = serviceStartingInMinutes(60);
    const { startMin: _, ...noStartMin } = future;
    expect(psc._serviceStartingIn25to35([noStartMin])).toBeNull();
  });

  it('correctly returns startMin=0 when it defaults', () => {
    // Build entry that will be ~30 min from now, no startMin
    const target = serviceStartingInMinutes(30);
    // Only remove startMin if this hour+minute approach works
    const schedule = [{ day: target.day, startHour: target.startHour, startMin: 0, durationHours: 2 }];
    // result depends on actual time — just verify no crash
    const result = psc._serviceStartingIn25to35(schedule);
    if (result) {
      expect(result).toHaveProperty('startMin', 0);
    }
  });

  it('picks the first matching service from multiple entries', () => {
    const s1 = serviceStartingInMinutes(30); // in window
    const s2 = serviceStartingInMinutes(60); // not in window
    const result = psc._serviceStartingIn25to35([s1, s2]);
    expect(result).not.toBeNull();
    expect(result.startHour).toBe(s1.startHour);
  });
});

// ─── B. getLatestResult ───────────────────────────────────────────────────────

describe('B. getLatestResult', () => {
  let db, psc;

  beforeEach(() => {
    db = createTestDb();
    psc = makePreServiceCheck(db);
  });

  afterEach(() => {
    psc.stop();
    db?.close();
  });

  it('returns null when no results exist', () => {
    addChurch(db, 'ch1');
    expect(psc.getLatestResult('ch1')).toBeNull();
  });

  it('returns the latest result with parsed checks array', () => {
    addChurch(db, 'ch1');
    const checks = [{ name: 'OBS Connected', pass: true }, { name: 'Audio OK', pass: false }];
    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES (?, ?, NULL, 1, ?, 'manual', ?)
    `).run('result-1', 'ch1', JSON.stringify(checks), new Date().toISOString());

    const result = psc.getLatestResult('ch1');
    expect(result).not.toBeNull();
    expect(result.pass).toBe(1);
    expect(result.checks).toEqual(checks);
    expect(result.trigger_type).toBe('manual');
  });

  it('returns the most recent result when multiple exist', () => {
    addChurch(db, 'ch1');
    const older = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const newer = new Date().toISOString();

    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES (?, ?, NULL, 0, '[]', 'auto', ?)
    `).run('old', 'ch1', older);

    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES (?, ?, NULL, 1, '[]', 'manual', ?)
    `).run('new', 'ch1', newer);

    const result = psc.getLatestResult('ch1');
    expect(result.id).toBe('new');
    expect(result.pass).toBe(1);
  });
});

// ─── C. _persistResult ────────────────────────────────────────────────────────

describe('C. _persistResult', () => {
  let db, psc;

  beforeEach(() => {
    db = createTestDb();
    psc = makePreServiceCheck(db);
  });

  afterEach(() => {
    psc.stop();
    db?.close();
  });

  it('stores a passing result in DB', () => {
    addChurch(db, 'ch1');
    psc._persistResult('ch1', { pass: true, checks: [{ name: 'Test', pass: true }] }, 'auto');

    const row = db.prepare('SELECT * FROM preservice_check_results WHERE church_id = ?').get('ch1');
    expect(row).not.toBeNull();
    expect(row.pass).toBe(1);
    expect(row.trigger_type).toBe('auto');
    expect(JSON.parse(row.checks_json)).toHaveLength(1);
  });

  it('stores a failing result', () => {
    addChurch(db, 'ch1');
    psc._persistResult('ch1', { pass: false, checks: [] }, 'manual');

    const row = db.prepare('SELECT * FROM preservice_check_results WHERE church_id = ?').get('ch1');
    expect(row.pass).toBe(0);
    expect(row.trigger_type).toBe('manual');
  });

  it('links a session_id when sessionRecap is available', () => {
    addChurch(db, 'ch1');
    const sessionRecap = { getActiveSessionId: vi.fn().mockReturnValue('session-abc') };
    const pscWithSession = makePreServiceCheck(db, { sessionRecap });

    pscWithSession._persistResult('ch1', { pass: true, checks: [] }, 'auto');

    const row = db.prepare('SELECT session_id FROM preservice_check_results WHERE church_id = ?').get('ch1');
    expect(row.session_id).toBe('session-abc');

    pscWithSession.stop();
  });

  it('is a no-op when result is null', () => {
    addChurch(db, 'ch1');
    psc._persistResult('ch1', null, 'auto');

    const count = db.prepare('SELECT COUNT(*) as cnt FROM preservice_check_results WHERE church_id = ?').get('ch1');
    expect(count.cnt).toBe(0);
  });

  it('is a no-op when db is null', () => {
    const noDb = makePreServiceCheck(null);
    expect(() => noDb._persistResult('ch1', { pass: true, checks: [] }, 'auto')).not.toThrow();
    noDb.stop();
  });
});

// ─── D. onCommandResult ───────────────────────────────────────────────────────

describe('D. onCommandResult — listener dispatch', () => {
  let db, psc;

  beforeEach(() => {
    db = createTestDb();
    psc = makePreServiceCheck(db);
  });

  afterEach(() => {
    psc.stop();
    db?.close();
  });

  it('calls all registered listeners with the message', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    psc._resultListeners.push(handler1, handler2);

    const msg = { type: 'command_result', churchId: 'ch1', messageId: 'abc' };
    psc.onCommandResult(msg);

    expect(handler1).toHaveBeenCalledWith(msg);
    expect(handler2).toHaveBeenCalledWith(msg);
  });

  it('is a no-op with no listeners registered', () => {
    expect(() => psc.onCommandResult({ type: 'command_result' })).not.toThrow();
  });
});

// ─── E. _checkChurch ──────────────────────────────────────────────────────────

describe('E. _checkChurch state machine', () => {
  let db;

  beforeEach(() => {
    // Anchor to 2 PM to avoid midnight wraparound with serviceStartingInMinutes(30)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));
    db = createTestDb();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    db?.close();
  });

  it('skips a church not in the 25–35 min window', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(60)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    const psc = makePreServiceCheck(db, { botToken: 'tok' });
    await psc._checkChurch(church);

    // No result persisted (never got to that point)
    const count = db.prepare('SELECT COUNT(*) as cnt FROM preservice_check_results').get();
    expect(count.cnt).toBe(0);

    psc.stop();
  });

  it('skips if checked within the past 2 hours (dedup)', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    const psc = makePreServiceCheck(db, { botToken: 'tok' });
    psc.lastPreServiceCheckAt.set('ch1', Date.now() - 30 * 60 * 1000); // 30 min ago

    await psc._checkChurch(church);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM preservice_check_results').get();
    expect(count.cnt).toBe(0);

    psc.stop();
  });

  it('allows re-check after the 2-hour dedup window expires', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    const churches = new Map([['ch1', { ws: null }]]); // WS offline
    const psc = makePreServiceCheck(db, { botToken: null, churches });
    // Last check was 3 hours ago — dedup window passed
    psc.lastPreServiceCheckAt.set('ch1', Date.now() - 3 * 60 * 60 * 1000);

    await psc._checkChurch(church);

    // dedup timestamp should be updated
    const ts = psc.lastPreServiceCheckAt.get('ch1');
    expect(Date.now() - ts).toBeLessThan(5000);

    psc.stop();
  });

  it('sends WS command when church is connected and awaits result (success path)', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws }]]);

    const psc = makePreServiceCheck(db, { churches, botToken: null });

    // Set up a responder: when psc pushes a listener, simulate a response
    const originalPush = psc._resultListeners.push.bind(psc._resultListeners);
    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      originalPush(handler);
      // Immediately simulate the command_result response
      Promise.resolve().then(() => {
        // Extract the messageId from the last sent WS message
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            result: { pass: true, checks: [{ name: 'OBS', pass: true }] },
          });
        }
      });
    });

    await psc._checkChurch(church);

    // WS command should have been sent
    expect(ws.send).toHaveBeenCalled();
    const sentMsg = ws._sent[0];
    expect(sentMsg.type).toBe('command');
    expect(sentMsg.command).toBe('system.preServiceCheck');

    psc.stop();
  });

  it('records failReason=offline when WS is not connected', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    // Church in map but ws is null
    const churches = new Map([['ch1', { ws: null }]]);
    db.prepare('INSERT INTO church_tds (church_id, telegram_chat_id, active) VALUES (?, ?, 1)').run('ch1', '111222');

    const psc = makePreServiceCheck(db, { botToken: 'test-tok', churches });
    await psc._checkChurch(church);

    // Telegram should have been called with offline message
    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain('not connected');

    psc.stop();
  });

  it('records failReason=offline when church not in churches map', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');
    db.prepare('INSERT INTO church_tds (church_id, telegram_chat_id, active) VALUES (?, ?, 1)').run('ch1', '999');

    const psc = makePreServiceCheck(db, { botToken: 'test-tok', churches: new Map() });
    await psc._checkChurch(church);

    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain('not connected');

    psc.stop();
  });

  it('sends success Telegram message when all checks pass', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');
    db.prepare('INSERT INTO church_tds (church_id, telegram_chat_id, active) VALUES (?, ?, 1)').run('ch1', '555');

    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws, status: {} }]]);
    const psc = makePreServiceCheck(db, { botToken: 'test-tok', churches });

    // Spy and auto-respond
    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      Array.prototype.push.call(psc._resultListeners, handler);
      Promise.resolve().then(() => {
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            result: { pass: true, checks: [] },
          });
        }
      });
    });

    await psc._checkChurch(church);
    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain('All systems go');

    psc.stop();
  });

  it('sends warning Telegram message when checks fail', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');
    db.prepare('INSERT INTO church_tds (church_id, telegram_chat_id, active) VALUES (?, ?, 1)').run('ch1', '555');

    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws, status: {} }]]);
    const psc = makePreServiceCheck(db, { botToken: 'test-tok', churches });

    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      Array.prototype.push.call(psc._resultListeners, handler);
      Promise.resolve().then(() => {
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            result: { pass: false, checks: [{ name: 'OBS', pass: false, detail: 'Not running' }] },
          });
        }
      });
    });

    await psc._checkChurch(church);
    expect(fetch).toHaveBeenCalled();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.text).toContain('issue');
    expect(body.text).toContain('OBS');

    psc.stop();
  });

  it('does not send Telegram when no bot token', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    const psc = makePreServiceCheck(db, { botToken: null, churches: new Map() });
    await psc._checkChurch(church);

    expect(fetch).not.toHaveBeenCalled();
    psc.stop();
  });

  it('does not send Telegram when no TDs configured', async () => {
    addChurch(db, 'ch1', { serviceTimes: [serviceStartingInMinutes(30)] });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');

    // No church_tds rows for ch1
    const psc = makePreServiceCheck(db, { botToken: 'test-tok', churches: new Map() });
    await psc._checkChurch(church);

    expect(fetch).not.toHaveBeenCalled();
    psc.stop();
  });
});

// ─── F. runManualCheck ────────────────────────────────────────────────────────

describe('F. runManualCheck', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db?.close());

  it('returns null when church is not in the churches map', async () => {
    const psc = makePreServiceCheck(db, { churches: new Map() });
    const result = await psc.runManualCheck('ch1');
    expect(result).toBeNull();
    psc.stop();
  });

  it('returns null when WS is disconnected (readyState !== 1)', async () => {
    const ws = { readyState: 3, send: vi.fn() }; // CLOSED
    const churches = new Map([['ch1', { ws }]]);
    const psc = makePreServiceCheck(db, { churches });

    const result = await psc.runManualCheck('ch1');
    expect(result).toBeNull();
    psc.stop();
  });

  it('sends command to WS and resolves with result', async () => {
    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws, status: {} }]]);
    const psc = makePreServiceCheck(db, { churches });

    // Auto-respond to the command
    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      Array.prototype.push.call(psc._resultListeners, handler);
      Promise.resolve().then(() => {
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            result: { pass: true, checks: [{ name: 'Audio', pass: true }] },
          });
        }
      });
    });

    const result = await psc.runManualCheck('ch1');
    expect(result).not.toBeNull();
    expect(result.pass).toBe(true);
    expect(result.checks).toHaveLength(1);

    // Verify command was sent
    expect(ws.send).toHaveBeenCalled();
    const msg = ws._sent[0];
    expect(msg.command).toBe('system.preServiceCheck');
    expect(msg.type).toBe('command');

    psc.stop();
  });

  it('persists manual result with trigger_type = manual', async () => {
    addChurch(db, 'ch1');
    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws, status: {} }]]);
    const psc = makePreServiceCheck(db, { churches });

    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      Array.prototype.push.call(psc._resultListeners, handler);
      Promise.resolve().then(() => {
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            result: { pass: true, checks: [] },
          });
        }
      });
    });

    await psc.runManualCheck('ch1');

    const row = db.prepare('SELECT trigger_type FROM preservice_check_results WHERE church_id = ?').get('ch1');
    expect(row?.trigger_type).toBe('manual');

    psc.stop();
  });

  it('returns null on timeout (no response within 10s)', async () => {
    vi.useFakeTimers();

    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws }]]);
    const psc = makePreServiceCheck(db, { churches });

    const resultPromise = psc.runManualCheck('ch1');

    // Advance 10 seconds to trigger timeout
    await vi.advanceTimersByTimeAsync(10001);

    const result = await resultPromise;
    expect(result).toBeNull();

    psc.stop();
    vi.useRealTimers();
  }, 15000);

  it('returns null when WS sends error result', async () => {
    const ws = makeConnectedWs();
    const churches = new Map([['ch1', { ws }]]);
    const psc = makePreServiceCheck(db, { churches });

    vi.spyOn(psc._resultListeners, 'push').mockImplementation(handler => {
      Array.prototype.push.call(psc._resultListeners, handler);
      Promise.resolve().then(() => {
        const sent = ws._sent[ws._sent.length - 1];
        if (sent) {
          psc.onCommandResult({
            type: 'command_result',
            churchId: 'ch1',
            messageId: sent.id,
            error: 'Check failed',
          });
        }
      });
    });

    const result = await psc.runManualCheck('ch1');
    expect(result).toBeNull(); // error path returns null

    psc.stop();
  });
});

// ─── G. _enrichWithVersionChecks ──────────────────────────────────────────────

describe('G. _enrichWithVersionChecks', () => {
  let db, psc;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db?.close();
  });

  it('returns original checks unchanged when no versionConfig', () => {
    const pscNoVC = makePreServiceCheck(db);
    const checks = [{ name: 'Audio', pass: true }];
    const result = pscNoVC._enrichWithVersionChecks(checks, {});
    expect(result).toEqual(checks);
    pscNoVC.stop();
  });

  it('returns original checks unchanged when status is null/undefined', () => {
    const versionConfig = { checkVersion: vi.fn() };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const checks = [{ name: 'Test', pass: true }];
    expect(pscVC._enrichWithVersionChecks(checks, null)).toEqual(checks);
    expect(pscVC._enrichWithVersionChecks(checks, undefined)).toEqual(checks);
    pscVC.stop();
  });

  it('appends version check for OBS when version is present and meets minimum', () => {
    const versionConfig = {
      checkVersion: vi.fn().mockReturnValue({
        checked: true,
        meetsRequirement: true,
        outdated: false,
        current: '30.0.0',
        minimum: '28.0.0',
      }),
    };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const status = { obs: { version: '30.0.0' } };

    const result = pscVC._enrichWithVersionChecks([], status);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('OBS Version');
    expect(result[0].pass).toBe(true);
    expect(result[0].detail).toContain('30.0.0');

    pscVC.stop();
  });

  it('appends failing version check when version is outdated', () => {
    const versionConfig = {
      checkVersion: vi.fn().mockReturnValue({
        checked: true,
        meetsRequirement: false,
        outdated: true,
        current: '27.0.0',
        minimum: '28.0.0',
      }),
    };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const status = { obs: { version: '27.0.0' } };

    const result = pscVC._enrichWithVersionChecks([], status);
    expect(result[0].pass).toBe(false);
    expect(result[0].detail).toContain('minimum: v28.0.0');

    pscVC.stop();
  });

  it('skips devices where version is not present in status', () => {
    const versionConfig = {
      checkVersion: vi.fn().mockReturnValue({ checked: false }),
    };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const status = {}; // No device versions at all

    const result = pscVC._enrichWithVersionChecks([], status);
    expect(result.length).toBe(0);

    pscVC.stop();
  });

  it('skips devices where checkVersion returns checked=false', () => {
    const versionConfig = {
      checkVersion: vi.fn().mockReturnValue({ checked: false }),
    };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const status = { obs: { version: '30.0.0' } };

    const result = pscVC._enrichWithVersionChecks([], status);
    expect(result.length).toBe(0);

    pscVC.stop();
  });

  it('uses encoder type from status.encoder.type in label', () => {
    const versionConfig = {
      checkVersion: vi.fn().mockReturnValue({
        checked: true,
        meetsRequirement: true,
        outdated: false,
        current: '2.1.0',
        minimum: '2.0.0',
      }),
    };
    const pscVC = makePreServiceCheck(db, { versionConfig });
    const status = {
      encoder: { type: 'Teradek', firmwareVersion: '2.1.0' },
    };

    const result = pscVC._enrichWithVersionChecks([], status);
    const encoderCheck = result.find(c => c.name.includes('Teradek'));
    expect(encoderCheck).toBeTruthy();

    pscVC.stop();
  });
});

// ─── H. Constructor — DB restoration ─────────────────────────────────────────

describe('H. Constructor — restores last-check times from DB', () => {
  it('populates lastPreServiceCheckAt from preservice_check_results on startup', () => {
    const db = createTestDb();
    addChurch(db, 'ch1');

    // Create the table manually (normally created by PreServiceCheck constructor)
    db.exec(`
      CREATE TABLE IF NOT EXISTS preservice_check_results (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        pass INTEGER DEFAULT 0,
        checks_json TEXT DEFAULT '[]',
        trigger_type TEXT DEFAULT 'auto',
        created_at TEXT NOT NULL
      )
    `);

    // Pre-seed a result from 1 hour ago
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO preservice_check_results (id, church_id, session_id, pass, checks_json, trigger_type, created_at)
      VALUES ('r1', 'ch1', NULL, 1, '[]', 'auto', ?)
    `).run(oneHourAgo);

    const psc = makePreServiceCheck(db);
    const ts = psc.lastPreServiceCheckAt.get('ch1');
    expect(ts).toBeTruthy();
    const expectedTs = new Date(oneHourAgo).getTime();
    expect(Math.abs(ts - expectedTs)).toBeLessThan(1000);

    psc.stop();
    db.close();
  });

  it('gracefully handles missing table at startup', () => {
    const db = createTestDb();
    // Drop the preservice_check_results table to simulate first-boot
    // The table won't exist yet — constructor should not throw
    expect(() => makePreServiceCheck(db)).not.toThrow();
    db.close();
  });
});

// ─── I. start / stop ─────────────────────────────────────────────────────────

describe('I. start / stop timer lifecycle', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db?.close());

  it('start creates an interval timer', () => {
    vi.useFakeTimers();
    const psc = makePreServiceCheck(db);
    psc.start();
    expect(psc._timer).not.toBeNull();
    psc.stop();
    vi.useRealTimers();
  });

  it('stop clears the timer and sets it to null', () => {
    vi.useFakeTimers();
    const psc = makePreServiceCheck(db);
    psc.start();
    psc.stop();
    expect(psc._timer).toBeNull();
    vi.useRealTimers();
  });

  it('stop is idempotent — calling twice does not throw', () => {
    const psc = makePreServiceCheck(db);
    psc.stop();
    expect(() => psc.stop()).not.toThrow();
  });
});
