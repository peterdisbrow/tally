/**
 * EventMode — comprehensive tests
 *
 * Covers:
 *   A. createEvent — record creation, JWT token, registration code, field defaults
 *   B. isEventExpired — timestamp comparison, edge cases
 *   C. getTimeRemaining — hours+minutes, minutes-only, expired, no timestamp
 *   D. expireEvent — WS close, Telegram via fetch, via tallyBot, DB nulling, error isolation
 *   E. checkExpiry — finds expired events, skips unexpired, handles empty results
 *   F. _ensureColumns — idempotent on repeated calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { EventMode } from '../src/eventMode.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL,
      church_type TEXT DEFAULT 'recurring',
      event_expires_at TEXT,
      event_label TEXT,
      td_name TEXT,
      td_telegram_chat_id TEXT,
      registration_code TEXT
    )
  `);
  return db;
}

function addExpiredEvent(db, churchId, opts = {}) {
  const expiresAt = opts.expiresAt || new Date(Date.now() - 60 * 1000).toISOString();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt, church_type, event_expires_at, event_label, td_telegram_chat_id)
    VALUES (?, ?, '', '', ?, 'event', ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Event',
    now,
    expiresAt,
    opts.eventLabel || null,
    opts.tdTelegramChatId || null
  );
}

// ─── A. createEvent ───────────────────────────────────────────────────────────

describe('A. createEvent', () => {
  let db, eventMode;

  beforeEach(() => {
    db = createTestDb();
    eventMode = new EventMode(db);
  });

  afterEach(() => db?.close());

  it('returns churchId, token, expiresAt, and name', () => {
    const result = eventMode.createEvent({ name: 'Easter Sunday 2026' });
    expect(result).toHaveProperty('churchId');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('expiresAt');
    expect(result.name).toBe('Easter Sunday 2026');
  });

  it('persists the church record to the DB', () => {
    const { churchId } = eventMode.createEvent({ name: 'Wedding Ceremony' });
    const row = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    expect(row).toBeTruthy();
    expect(row.name).toBe('Wedding Ceremony');
    expect(row.church_type).toBe('event');
  });

  it('sets event_expires_at based on durationHours (default 72h)', () => {
    const before = Date.now();
    const { expiresAt, churchId } = eventMode.createEvent({ name: 'Conference' });
    const after = Date.now();

    const expiresMs = new Date(expiresAt).getTime();
    // Should be roughly 72 hours from now
    expect(expiresMs).toBeGreaterThanOrEqual(before + 72 * 60 * 60 * 1000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 72 * 60 * 60 * 1000 + 1000);
  });

  it('respects custom durationHours', () => {
    const before = Date.now();
    const { expiresAt } = eventMode.createEvent({ name: 'Short Event', durationHours: 4 });
    const after = Date.now();

    const expiresMs = new Date(expiresAt).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 4 * 60 * 60 * 1000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 4 * 60 * 60 * 1000 + 1000);
  });

  it('stores eventLabel in DB (defaults to name if not provided)', () => {
    const { churchId } = eventMode.createEvent({ name: 'Easter', eventLabel: 'Easter 2026' });
    const row = db.prepare('SELECT event_label FROM churches WHERE churchId = ?').get(churchId);
    expect(row.event_label).toBe('Easter 2026');
  });

  it('defaults event_label to name when not provided', () => {
    const { churchId } = eventMode.createEvent({ name: 'Wedding' });
    const row = db.prepare('SELECT event_label FROM churches WHERE churchId = ?').get(churchId);
    expect(row.event_label).toBe('Wedding');
  });

  it('stores contactEmail', () => {
    const { churchId } = eventMode.createEvent({ name: 'Conf', contactEmail: 'av@example.com' });
    const row = db.prepare('SELECT email FROM churches WHERE churchId = ?').get(churchId);
    expect(row.email).toBe('av@example.com');
  });

  it('stores tdName when provided', () => {
    const { churchId } = eventMode.createEvent({ name: 'Conf', tdName: 'John Smith' });
    const row = db.prepare('SELECT td_name FROM churches WHERE churchId = ?').get(churchId);
    expect(row.td_name).toBe('John Smith');
  });

  it('stores tdTelegramChatId as string', () => {
    const { churchId } = eventMode.createEvent({ name: 'Conf', tdTelegramChatId: 12345678 });
    const row = db.prepare('SELECT td_telegram_chat_id FROM churches WHERE churchId = ?').get(churchId);
    expect(row.td_telegram_chat_id).toBe('12345678');
  });

  it('stores a registration code', () => {
    const { churchId } = eventMode.createEvent({ name: 'Conf' });
    const row = db.prepare('SELECT registration_code FROM churches WHERE churchId = ?').get(churchId);
    expect(row.registration_code).toBeTruthy();
    expect(row.registration_code.length).toBe(6); // 3 bytes hex = 6 chars
  });

  it('generates unique churchId UUIDs for each call', () => {
    const r1 = eventMode.createEvent({ name: 'Event A' });
    const r2 = eventMode.createEvent({ name: 'Event B' });
    expect(r1.churchId).not.toBe(r2.churchId);
  });

  it('returns a valid JWT token', () => {
    const { token } = eventMode.createEvent({ name: 'JWT Test' });
    // JWT has 3 dot-separated base64 parts
    const parts = token.split('.');
    expect(parts.length).toBe(3);
  });
});

// ─── B. isEventExpired ────────────────────────────────────────────────────────

describe('B. isEventExpired', () => {
  let db, eventMode;

  beforeEach(() => {
    db = createTestDb();
    eventMode = new EventMode(db);
  });

  afterEach(() => db?.close());

  it('returns false when event_expires_at is null', () => {
    expect(eventMode.isEventExpired({ event_expires_at: null })).toBe(false);
  });

  it('returns false when event_expires_at is undefined', () => {
    expect(eventMode.isEventExpired({})).toBe(false);
  });

  it('returns true when event_expires_at is in the past', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(eventMode.isEventExpired({ event_expires_at: past })).toBe(true);
  });

  it('returns false when event_expires_at is in the future', () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(eventMode.isEventExpired({ event_expires_at: future })).toBe(false);
  });

  it('returns true when event_expires_at is exactly now (boundary)', () => {
    // Slightly in the past to account for execution time
    const justNow = new Date(Date.now() - 1).toISOString();
    expect(eventMode.isEventExpired({ event_expires_at: justNow })).toBe(true);
  });
});

// ─── C. getTimeRemaining ──────────────────────────────────────────────────────

describe('C. getTimeRemaining', () => {
  let db, eventMode;

  beforeEach(() => {
    db = createTestDb();
    eventMode = new EventMode(db);
  });

  afterEach(() => db?.close());

  it('returns "unknown" when no event_expires_at', () => {
    expect(eventMode.getTimeRemaining({})).toBe('unknown');
    expect(eventMode.getTimeRemaining({ event_expires_at: null })).toBe('unknown');
  });

  it('returns "expired" when past expiry', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(eventMode.getTimeRemaining({ event_expires_at: past })).toBe('expired');
  });

  it('formats hours and minutes correctly', () => {
    const future = new Date(Date.now() + (2 * 60 + 30) * 60 * 1000).toISOString(); // 2h 30m
    const result = eventMode.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^2h \d+m$/);
    // Math.floor on ~150 minutes = 2h 30m
    expect(result).toBe('2h 30m');
  });

  it('returns minutes-only format when less than 1 hour remains', () => {
    const future = new Date(Date.now() + 45 * 60 * 1000).toISOString(); // 45 min
    const result = eventMode.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^\d+m$/);
    expect(result).not.toContain('h');
  });

  it('returns "0m" when just seconds remain', () => {
    const future = new Date(Date.now() + 30 * 1000).toISOString(); // 30 seconds
    const result = eventMode.getTimeRemaining({ event_expires_at: future });
    expect(result).toBe('0m');
  });

  it('handles exactly 1 hour', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = eventMode.getTimeRemaining({ event_expires_at: future });
    expect(result).toMatch(/^0?59m$|^1h 0?0?m$/); // ~1h depending on execution time
  });
});

// ─── D. expireEvent ───────────────────────────────────────────────────────────

describe('D. expireEvent', () => {
  let db, eventMode;

  beforeEach(() => {
    db = createTestDb();
    eventMode = new EventMode(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db?.close();
  });

  it('nulls out event_expires_at in the DB', async () => {
    addExpiredEvent(db, 'ev1');
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');
    await eventMode.expireEvent(church);

    const updated = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('ev1');
    expect(updated.event_expires_at).toBeNull();
  });

  it('closes an open WebSocket connection', async () => {
    addExpiredEvent(db, 'ev1');
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    const mockWs = { readyState: 1, close: vi.fn() };
    const churchesMap = new Map([['ev1', { ws: mockWs }]]);

    await eventMode.expireEvent(church, null, churchesMap);
    expect(mockWs.close).toHaveBeenCalledWith(1000, expect.stringContaining('ended'));
  });

  it('does not close a disconnected WebSocket', async () => {
    addExpiredEvent(db, 'ev1');
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    const mockWs = { readyState: 3, close: vi.fn() }; // CLOSED
    const churchesMap = new Map([['ev1', { ws: mockWs }]]);

    await eventMode.expireEvent(church, null, churchesMap);
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it('sends Telegram notification via fetch when botToken is set', async () => {
    process.env.TALLY_BOT_TOKEN = 'test-token-123';
    addExpiredEvent(db, 'ev1', { tdTelegramChatId: '999888' });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    await eventMode.expireEvent(church);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('test-token-123'),
      expect.objectContaining({ method: 'POST' })
    );

    delete process.env.TALLY_BOT_TOKEN;
  });

  it('uses tallyBot.sendMessage when no bot token but tallyBot provided', async () => {
    delete process.env.TALLY_BOT_TOKEN;
    delete process.env.ALERT_BOT_TOKEN;

    addExpiredEvent(db, 'ev1', { tdTelegramChatId: '999888' });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    const tallyBot = { sendMessage: vi.fn().mockResolvedValue(true) };
    await eventMode.expireEvent(church, tallyBot);

    expect(tallyBot.sendMessage).toHaveBeenCalledWith('999888', expect.any(String), expect.any(Object));
  });

  it('skips Telegram notification when no chatId', async () => {
    process.env.TALLY_BOT_TOKEN = 'test-token';
    addExpiredEvent(db, 'ev1', { tdTelegramChatId: null });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    await eventMode.expireEvent(church);
    expect(fetch).not.toHaveBeenCalled();

    delete process.env.TALLY_BOT_TOKEN;
  });

  it('skips Telegram when no chatId and no tallyBot', async () => {
    delete process.env.TALLY_BOT_TOKEN;
    delete process.env.ALERT_BOT_TOKEN;
    addExpiredEvent(db, 'ev1', { tdTelegramChatId: null });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    await expect(eventMode.expireEvent(church)).resolves.not.toThrow();
    // DB should still be updated
    const updated = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('ev1');
    expect(updated.event_expires_at).toBeNull();
  });

  it('does not throw when Telegram fetch fails', async () => {
    process.env.TALLY_BOT_TOKEN = 'test-token';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    addExpiredEvent(db, 'ev1', { tdTelegramChatId: '999888' });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    await expect(eventMode.expireEvent(church)).resolves.not.toThrow();

    delete process.env.TALLY_BOT_TOKEN;
  });

  it('includes event_label in Telegram message when different from name', async () => {
    process.env.TALLY_BOT_TOKEN = 'test-token';
    addExpiredEvent(db, 'ev1', {
      name: 'First Baptist',
      eventLabel: 'Easter 2026',
      tdTelegramChatId: '999888',
    });
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ev1');

    await eventMode.expireEvent(church);

    const callBody = JSON.parse(fetch.mock.calls[0][1].body);
    expect(callBody.text).toContain('Easter 2026');

    delete process.env.TALLY_BOT_TOKEN;
  });
});

// ─── E. checkExpiry ───────────────────────────────────────────────────────────

describe('E. checkExpiry', () => {
  let db, eventMode;

  beforeEach(() => {
    db = createTestDb();
    eventMode = new EventMode(db);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db?.close();
  });

  it('expires events that are past their deadline', async () => {
    addExpiredEvent(db, 'ev-past');
    await eventMode.checkExpiry();

    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('ev-past');
    expect(row.event_expires_at).toBeNull();
  });

  it('does not expire events that have not yet expired', async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    addExpiredEvent(db, 'ev-future', { expiresAt: future });

    await eventMode.checkExpiry();

    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('ev-future');
    expect(row.event_expires_at).toBe(future);
  });

  it('does not touch recurring churches', async () => {
    // A recurring church should never appear in the expired query
    db.prepare(
      'INSERT INTO churches (churchId, name, email, token, registeredAt, church_type, event_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('rec1', 'Recurring', '', '', new Date().toISOString(), 'recurring', new Date(Date.now() - 60000).toISOString());

    await eventMode.checkExpiry();

    // Recurring church should be untouched (query filters by church_type = 'event')
    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('rec1');
    expect(row.event_expires_at).not.toBeNull();
  });

  it('does not touch events with NULL event_expires_at', async () => {
    // Event church with null expiry — should not appear in query
    db.prepare(
      'INSERT INTO churches (churchId, name, email, token, registeredAt, church_type, event_expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'
    ).run('ev-null', 'Null Expiry Event', '', '', new Date().toISOString(), 'event');

    await eventMode.checkExpiry();
    // Should remain untouched
    const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get('ev-null');
    expect(row.event_expires_at).toBeNull(); // already null, no change
  });

  it('handles multiple expired events in one pass', async () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    addExpiredEvent(db, 'ev-a', { expiresAt: past });
    addExpiredEvent(db, 'ev-b', { expiresAt: past });
    addExpiredEvent(db, 'ev-c', { expiresAt: past });

    await eventMode.checkExpiry();

    for (const id of ['ev-a', 'ev-b', 'ev-c']) {
      const row = db.prepare('SELECT event_expires_at FROM churches WHERE churchId = ?').get(id);
      expect(row.event_expires_at).toBeNull();
    }
  });

  it('does not throw when churches table query fails', async () => {
    db.exec('DROP TABLE churches');
    await expect(eventMode.checkExpiry()).resolves.not.toThrow();
  });

  it('passes tallyBot and churchesMap through to expireEvent', async () => {
    addExpiredEvent(db, 'ev-map');
    const mockWs = { readyState: 1, close: vi.fn() };
    const churchesMap = new Map([['ev-map', { ws: mockWs }]]);

    await eventMode.checkExpiry(null, churchesMap);
    expect(mockWs.close).toHaveBeenCalled();
  });
});

// ─── F. _ensureColumns idempotency ────────────────────────────────────────────

describe('F. _ensureColumns idempotency', () => {
  it('can be instantiated twice without error (columns already exist)', () => {
    const db = createTestDb();
    // First instance adds the columns
    const em1 = new EventMode(db);
    // Second instance should handle already-existing columns gracefully
    expect(() => new EventMode(db)).not.toThrow();
    db.close();
  });

  it('adds missing columns to a bare churches table', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT NOT NULL)');

    // EventMode should add church_type, event_expires_at, event_label columns
    expect(() => new EventMode(db)).not.toThrow();

    // Should be able to query the new columns
    const row = db.prepare('SELECT church_type FROM churches LIMIT 1').get();
    // No rows, but no error means column was added
    expect(row).toBeUndefined();
    db.close();
  });
});
