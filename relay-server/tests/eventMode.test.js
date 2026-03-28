/**
 * Tests for src/eventMode.js — EventMode class.
 *
 * Uses an in-memory SQLite database (better-sqlite3) so no file I/O occurs.
 * start() is intentionally not tested (setInterval keeps process alive).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { EventMode } = require('../src/eventMode.js');

// ─── DB factory ───────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE churches (
    churchId TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    token TEXT,
    registeredAt TEXT
  )`);
  return db;
}

// ─── _ensureColumns() ─────────────────────────────────────────────────────────

describe('EventMode._ensureColumns()', () => {
  it('constructs without error on a fresh database', () => {
    const db = makeDb();
    expect(() => new EventMode(db)).not.toThrow();
  });

  it('adds church_type column to churches table', () => {
    const db = makeDb();
    new EventMode(db);
    // If column was added, a SELECT on it should work
    expect(() => db.prepare('SELECT church_type FROM churches LIMIT 1').get()).not.toThrow();
  });

  it('adds event_expires_at column to churches table', () => {
    const db = makeDb();
    new EventMode(db);
    expect(() => db.prepare('SELECT event_expires_at FROM churches LIMIT 1').get()).not.toThrow();
  });

  it('adds event_label column to churches table', () => {
    const db = makeDb();
    new EventMode(db);
    expect(() => db.prepare('SELECT event_label FROM churches LIMIT 1').get()).not.toThrow();
  });

  it('is idempotent — constructing twice does not throw', () => {
    const db = makeDb();
    new EventMode(db);      // adds columns
    expect(() => new EventMode(db)).not.toThrow(); // columns already exist — try/catch swallows
  });
});

// ─── createEvent() ────────────────────────────────────────────────────────────

describe('EventMode.createEvent()', () => {
  let db;
  let em;

  beforeEach(() => {
    db = makeDb();
    em = new EventMode(db);
  });

  it('returns an object with churchId, token, expiresAt, name', () => {
    const result = em.createEvent({ name: 'Test Event' });
    expect(result).toHaveProperty('churchId');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('expiresAt');
    expect(result).toHaveProperty('name');
    expect(result.name).toBe('Test Event');
  });

  it('churchId is a UUID v4 (matches UUID format)', () => {
    const { churchId } = em.createEvent({ name: 'UUID Test' });
    expect(churchId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('expiresAt is an ISO string in the future', () => {
    const { expiresAt } = em.createEvent({ name: 'Future Test' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores record in DB — can be queried by churchId', () => {
    const { churchId } = em.createEvent({ name: 'DB Store Test' });
    const row = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    expect(row).toBeDefined();
    expect(row.name).toBe('DB Store Test');
  });

  it('default durationHours=72 makes expiresAt approximately 72 hours from now', () => {
    const before = Date.now();
    const { expiresAt } = em.createEvent({ name: 'Default Duration' });
    const after = Date.now();
    const expiresMs = new Date(expiresAt).getTime();
    const expectedMin = before + 72 * 60 * 60 * 1000;
    const expectedMax = after  + 72 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
  });

  it('custom durationHours=1 makes expiresAt approximately 1 hour from now', () => {
    const before = Date.now();
    const { expiresAt } = em.createEvent({ name: '1h Event', durationHours: 1 });
    const after = Date.now();
    const expiresMs = new Date(expiresAt).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiresMs).toBeLessThanOrEqual(after  + 60 * 60 * 1000);
  });

  it('contactEmail is stored in DB when provided', () => {
    const { churchId } = em.createEvent({ name: 'Email Test', contactEmail: 'td@example.com' });
    const row = db.prepare('SELECT email FROM churches WHERE churchId = ?').get(churchId);
    expect(row.email).toBe('td@example.com');
  });

  it('email defaults to empty string when not provided', () => {
    const { churchId } = em.createEvent({ name: 'No Email' });
    const row = db.prepare('SELECT email FROM churches WHERE churchId = ?').get(churchId);
    expect(row.email).toBe('');
  });

  it('event_label is set to eventLabel when provided', () => {
    const { churchId } = em.createEvent({ name: 'Easter Sunday 2026', eventLabel: 'Easter 2026' });
    const row = db.prepare('SELECT event_label FROM churches WHERE churchId = ?').get(churchId);
    expect(row.event_label).toBe('Easter 2026');
  });

  it('event_label defaults to name when eventLabel not provided', () => {
    const { churchId } = em.createEvent({ name: 'Wedding Day' });
    const row = db.prepare('SELECT event_label FROM churches WHERE churchId = ?').get(churchId);
    expect(row.event_label).toBe('Wedding Day');
  });

  it('token is a valid JWT (three dot-separated parts)', () => {
    const { token } = em.createEvent({ name: 'JWT Test' });
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    // Each part is non-empty base64url
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('sets church_type to event in DB', () => {
    const { churchId } = em.createEvent({ name: 'Type Test' });
    const row = db.prepare('SELECT church_type FROM churches WHERE churchId = ?').get(churchId);
    expect(row.church_type).toBe('event');
  });

  it('each call generates a unique churchId', () => {
    const r1 = em.createEvent({ name: 'Event A' });
    const r2 = em.createEvent({ name: 'Event B' });
    expect(r1.churchId).not.toBe(r2.churchId);
  });
});

// ─── isEventExpired() ─────────────────────────────────────────────────────────

describe('EventMode.isEventExpired()', () => {
  let em;

  beforeEach(() => {
    em = new EventMode(makeDb());
  });

  it('returns false when event_expires_at is null', () => {
    expect(em.isEventExpired({ event_expires_at: null })).toBe(false);
  });

  it('returns false when event_expires_at is undefined', () => {
    expect(em.isEventExpired({})).toBe(false);
  });

  it('returns false when expires_at is in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(em.isEventExpired({ event_expires_at: future })).toBe(false);
  });

  it('returns true when expires_at is in the past', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(em.isEventExpired({ event_expires_at: past })).toBe(true);
  });

  it('returns true when expires_at is exactly now (boundary — past due)', () => {
    // Use a time slightly in the past to avoid flakiness
    const justPast = new Date(Date.now() - 10).toISOString();
    expect(em.isEventExpired({ event_expires_at: justPast })).toBe(true);
  });
});

// ─── getTimeRemaining() ───────────────────────────────────────────────────────

describe('EventMode.getTimeRemaining()', () => {
  let em;

  beforeEach(() => {
    em = new EventMode(makeDb());
  });

  it('returns "unknown" when event_expires_at is missing', () => {
    expect(em.getTimeRemaining({})).toBe('unknown');
  });

  it('returns "unknown" when event_expires_at is null', () => {
    expect(em.getTimeRemaining({ event_expires_at: null })).toBe('unknown');
  });

  it('returns "expired" when past expiry', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    expect(em.getTimeRemaining({ event_expires_at: past })).toBe('expired');
  });

  it('returns "Xh Ym" format for multi-hour events', () => {
    // 2 hours and 30 minutes from now
    const future = new Date(Date.now() + (2 * 60 + 30) * 60 * 1000).toISOString();
    const result = em.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^\d+h \d+m$/);
    expect(result).toBe('2h 30m');
  });

  it('returns "Ym" for sub-hour events', () => {
    // 45 minutes from now
    const future = new Date(Date.now() + 45 * 60 * 1000).toISOString();
    const result = em.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^\d+m$/);
    expect(result).toBe('45m');
  });

  it('returns "1h 0m" at exactly one hour', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000 + 500).toISOString();
    const result = em.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^1h \d+m$/);
  });
});

// ─── checkExpiry() ────────────────────────────────────────────────────────────

describe('EventMode.checkExpiry()', () => {
  let db;
  let em;

  beforeEach(() => {
    db = makeDb();
    em = new EventMode(db);
  });

  it('does not call expireEvent when no events are expired', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    em.createEvent({ name: 'Future Event' });
    // Set event_expires_at manually to the future
    db.prepare("UPDATE churches SET church_type = 'event', event_expires_at = ?").run(future);

    const expireEventSpy = vi.spyOn(em, 'expireEvent');
    await em.checkExpiry(null, new Map());
    expect(expireEventSpy).not.toHaveBeenCalled();
    expireEventSpy.mockRestore();
  });

  it('calls expireEvent for each expired event', async () => {
    const past = new Date(Date.now() - 5000).toISOString();
    // Create two events with past expiry by inserting directly
    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run('expired-1', 'Expired A', '', 'tok1', new Date().toISOString());
    db.prepare("UPDATE churches SET church_type = 'event', event_expires_at = ? WHERE churchId = ?")
      .run(past, 'expired-1');

    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run('expired-2', 'Expired B', '', 'tok2', new Date().toISOString());
    db.prepare("UPDATE churches SET church_type = 'event', event_expires_at = ? WHERE churchId = ?")
      .run(past, 'expired-2');

    const calls = [];
    vi.spyOn(em, 'expireEvent').mockImplementation(async (church) => {
      calls.push(church.churchId);
    });

    await em.checkExpiry(null, new Map());
    expect(calls).toHaveLength(2);
    expect(calls).toContain('expired-1');
    expect(calls).toContain('expired-2');
    vi.restoreAllMocks();
  });

  it('does not throw when DB query fails (logs error gracefully)', async () => {
    // Replace db.prepare to throw
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (sql.includes('SELECT')) throw new Error('DB error');
      return originalPrepare(sql);
    };
    // checkExpiry catches errors internally
    await expect(em.checkExpiry(null, new Map())).resolves.not.toThrow();
  });

  it('skips events that are not yet expired', async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run('future-event', 'Future', '', 'tok', new Date().toISOString());
    db.prepare("UPDATE churches SET church_type = 'event', event_expires_at = ? WHERE churchId = ?")
      .run(future, 'future-event');

    const expireSpy = vi.spyOn(em, 'expireEvent');
    await em.checkExpiry(null, new Map());
    expect(expireSpy).not.toHaveBeenCalled();
    expireSpy.mockRestore();
  });
});

// ─── expireEvent() ────────────────────────────────────────────────────────────

describe('EventMode.expireEvent()', () => {
  let db;
  let em;

  beforeEach(() => {
    db = makeDb();
    em = new EventMode(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TALLY_BOT_TOKEN;
    delete process.env.ALERT_BOT_TOKEN;
  });

  function insertChurch(overrides = {}) {
    const churchId = overrides.churchId || 'test-church-id';
    const name = overrides.name || 'Test Event';
    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run(churchId, name, '', 'tok', new Date().toISOString());
    db.prepare("UPDATE churches SET church_type = 'event', event_expires_at = ? WHERE churchId = ?")
      .run(new Date().toISOString(), churchId);
    return { churchId, name, ...overrides };
  }

  it('sets event_expires_at to NULL in DB after expiry', async () => {
    const church = insertChurch();
    await em.expireEvent(church, null, null);
    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get(church.churchId);
    expect(row.event_expires_at).toBeNull();
  });

  it('closes WebSocket when churchesMap has a church with readyState=1 (OPEN)', async () => {
    const church = insertChurch();
    let closed = false;
    const ws = { readyState: 1, close: (code, reason) => { closed = true; } };
    const churchesMap = new Map([[church.churchId, { ws, sockets: new Map([['_default', ws]]) }]]);
    await em.expireEvent(church, null, churchesMap);
    expect(closed).toBe(true);
  });

  it('does not close WebSocket when readyState is not 1', async () => {
    const church = insertChurch();
    let closed = false;
    const ws = { readyState: 3, close: () => { closed = true; } }; // CLOSED
    const churchesMap = new Map([[church.churchId, { ws, sockets: new Map([['_default', ws]]) }]]);
    await em.expireEvent(church, null, churchesMap);
    expect(closed).toBe(false);
  });

  it('does not throw when church is not in churchesMap', async () => {
    const church = insertChurch();
    const churchesMap = new Map(); // empty
    await expect(em.expireEvent(church, null, churchesMap)).resolves.not.toThrow();
  });

  it('does not throw when churchesMap is null', async () => {
    const church = insertChurch();
    await expect(em.expireEvent(church, null, null)).resolves.not.toThrow();
  });

  it('skips Telegram when no tdChatId set', async () => {
    process.env.TALLY_BOT_TOKEN = 'fake-token';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    const church = insertChurch({ td_telegram_chat_id: null });
    await em.expireEvent(church, null, null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips Telegram fetch when no botToken env var set', async () => {
    delete process.env.TALLY_BOT_TOKEN;
    delete process.env.ALERT_BOT_TOKEN;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
    const church = insertChurch({ td_telegram_chat_id: '123456' });
    await em.expireEvent(church, null, null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calls fetch with Telegram URL when tdChatId and TALLY_BOT_TOKEN are set', async () => {
    process.env.TALLY_BOT_TOKEN = 'test-bot-token';
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const church = insertChurch({ td_telegram_chat_id: '987654' });
    await em.expireEvent(church, null, null);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('api.telegram.org');
    expect(url).toContain('test-bot-token');
    expect(url).toContain('sendMessage');
  });

  it('uses tallyBot.sendMessage when tallyBot is provided and tdChatId is set but no botToken', async () => {
    delete process.env.TALLY_BOT_TOKEN;
    delete process.env.ALERT_BOT_TOKEN;
    const sentMessages = [];
    const tallyBot = {
      sendMessage: vi.fn(async (chatId, msg, opts) => {
        sentMessages.push({ chatId, msg });
      }),
    };
    const church = insertChurch({ td_telegram_chat_id: '555111' });
    await em.expireEvent(church, tallyBot, null);
    expect(tallyBot.sendMessage).toHaveBeenCalledOnce();
    expect(tallyBot.sendMessage.mock.calls[0][0]).toBe('555111');
  });

  it('does not call tallyBot when tdChatId is missing', async () => {
    const tallyBot = { sendMessage: vi.fn() };
    const church = insertChurch({ td_telegram_chat_id: null });
    await em.expireEvent(church, tallyBot, null);
    expect(tallyBot.sendMessage).not.toHaveBeenCalled();
  });

  it('handles fetch error gracefully without throwing', async () => {
    process.env.TALLY_BOT_TOKEN = 'error-token';
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'));
    const church = insertChurch({ td_telegram_chat_id: '123' });
    await expect(em.expireEvent(church, null, null)).resolves.not.toThrow();
    // DB should still be nulled out despite fetch failure
    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get(church.churchId);
    expect(row.event_expires_at).toBeNull();
  });
});
