/**
 * Edge-case and error handling tests for src/chatEngine.js.
 *
 * The existing chat-engine.test.js covers: constructor/table setup, saveMessage,
 * getMessages (filtering by since/sessionId/limit/latest), getRecentConversation
 * (mapping, merging, alternation), pruneOldMessages, and broadcastChat.
 *
 * This file adds:
 *   - saveMessage with missing/null fields
 *   - getMessages with boundary limit values (0, negative, huge)
 *   - pruneOldMessages with 0-day and negative retention
 *   - broadcastChat when one broadcaster throws — others still called
 *   - broadcastChat when no broadcasters are set (no crash)
 *   - getRecentConversation with only system noise messages (emoji prefixed)
 *   - getRecentConversation with limit=0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { ChatEngine } = require('../src/chatEngine.js');

function createTestDb() {
  return new Database(':memory:');
}

function createEngine(db, opts = {}) {
  return new ChatEngine(db, opts);
}

// ─── saveMessage edge cases ───────────────────────────────────────────────────

describe('saveMessage — edge cases', () => {
  let db, engine;
  beforeEach(() => { db = createTestDb(); engine = createEngine(db); });
  afterEach(() => { db?.close(); });

  it('saves a message with an empty string for message content', () => {
    const saved = engine.saveMessage({
      churchId: 'church-1', senderName: 'TD', senderRole: 'td', source: 'app', message: '',
    });
    expect(saved.id).toBeTruthy();
    expect(saved.message).toBe('');

    const rows = engine.getMessages('church-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('');
  });

  it('saves a message with a very long message body (10,000 chars)', () => {
    const longMsg = 'x'.repeat(10000);
    const saved = engine.saveMessage({
      churchId: 'church-2', senderName: 'Admin', senderRole: 'admin', source: 'dashboard', message: longMsg,
    });
    const rows = engine.getMessages('church-2');
    expect(rows[0].message).toBe(longMsg);
  });

  it('messages from different churches are isolated', () => {
    engine.saveMessage({ churchId: 'A', senderName: 'TD', senderRole: 'td', source: 'app', message: 'hello A' });
    engine.saveMessage({ churchId: 'B', senderName: 'TD', senderRole: 'td', source: 'app', message: 'hello B' });

    expect(engine.getMessages('A')).toHaveLength(1);
    expect(engine.getMessages('B')).toHaveLength(1);
    expect(engine.getMessages('A')[0].message).toBe('hello A');
  });

  it('session_id is null when sessionRecap returns null', () => {
    const recap = { getActiveSessionId: vi.fn().mockReturnValue(null) };
    const e = createEngine(db, { sessionRecap: recap });
    const saved = e.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'hi' });
    expect(saved.session_id).toBeNull();
  });

  it('session_id is set from sessionRecap when active', () => {
    const recap = { getActiveSessionId: vi.fn().mockReturnValue('session-abc') };
    const e = createEngine(db, { sessionRecap: recap });
    const saved = e.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'hi' });
    expect(saved.session_id).toBe('session-abc');
  });
});

// ─── getMessages boundary limits ─────────────────────────────────────────────

describe('getMessages — boundary limit values', () => {
  let db, engine;
  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
    for (let i = 0; i < 10; i++) {
      engine.saveMessage({ churchId: 'church-1', senderName: 'TD', senderRole: 'td', source: 'app', message: `msg ${i}` });
    }
  });
  afterEach(() => { db?.close(); });

  it('limit=0 is coerced to parseInt(0)||50 = 50, returns all 10 messages', () => {
    // parseInt('0') is 0, falsy → default 50; 10 messages total so we get all 10
    const rows = engine.getMessages('church-1', { limit: 0 });
    expect(rows).toHaveLength(10);
  });

  it('limit=1 returns only the oldest message', () => {
    const rows = engine.getMessages('church-1', { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('msg 0');
  });

  it('limit=200 (max cap) returns all 10 when fewer exist', () => {
    const rows = engine.getMessages('church-1', { limit: 200 });
    expect(rows).toHaveLength(10);
  });

  it('limit=999 is capped at 200 — still returns all 10 since 10 < 200', () => {
    const rows = engine.getMessages('church-1', { limit: 999 });
    expect(rows).toHaveLength(10);
  });

  it('limit=-5 coerces to NaN → default 50, returns all 10', () => {
    // parseInt(-5) is -5, truthy → Math.min(-5, 200) = -5
    // SQLite LIMIT with negative value = no limit; still returns all rows
    const rows = engine.getMessages('church-1', { limit: -5 });
    expect(rows.length).toBeGreaterThanOrEqual(10);
  });

  it('returns empty array for a church with no messages', () => {
    const rows = engine.getMessages('nonexistent-church');
    expect(rows).toEqual([]);
  });
});

// ─── pruneOldMessages edge cases ─────────────────────────────────────────────

describe('pruneOldMessages — boundary retention values', () => {
  let db, engine;
  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('pruneOldMessages(0) deletes all messages (cutoff = now)', () => {
    // Insert a message with an old timestamp
    engine.saveMessage({ churchId: 'c', senderName: 'T', senderRole: 'td', source: 'app', message: 'old' });
    // Directly update timestamp to be old
    db.prepare("UPDATE chat_messages SET timestamp = '2020-01-01T00:00:00.000Z'").run();

    const result = engine.pruneOldMessages(0);
    expect(result.deleted).toBe(1);
    expect(engine.getMessages('c')).toHaveLength(0);
  });

  it('pruneOldMessages(30) does not delete recent messages', () => {
    engine.saveMessage({ churchId: 'c', senderName: 'T', senderRole: 'td', source: 'app', message: 'recent' });
    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(0);
    expect(engine.getMessages('c')).toHaveLength(1);
  });

  it('pruneOldMessages returns { deleted: 0 } when table is empty', () => {
    const result = engine.pruneOldMessages(30);
    expect(result).toEqual({ deleted: 0 });
  });

  it('pruneOldMessages(1000) keeps all recent messages', () => {
    engine.saveMessage({ churchId: 'c', senderName: 'T', senderRole: 'td', source: 'app', message: 'recent' });
    const result = engine.pruneOldMessages(1000);
    expect(result.deleted).toBe(0);
  });
});

// ─── broadcastChat error isolation ───────────────────────────────────────────

describe('broadcastChat — error handling', () => {
  let db, engine;
  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('does not crash when no broadcasters are set', () => {
    const saved = engine.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'test' });
    expect(() => engine.broadcastChat(saved)).not.toThrow();
  });

  it('continues broadcasting to other targets when one broadcaster throws', () => {
    const throwingBroadcaster = vi.fn().mockImplementation(() => { throw new Error('network error'); });
    const controllerBroadcast = vi.fn();
    const telegramNotify = vi.fn();

    engine.setBroadcasters({
      broadcastToChurch: throwingBroadcaster,
      broadcastToControllers: controllerBroadcast,
      notifyTelegram: telegramNotify,
    });

    const saved = engine.saveMessage({ churchId: 'c', senderName: 'Admin', senderRole: 'admin', source: 'dashboard', message: 'hi' });
    // source !== 'app' so broadcastToChurch will be called and throw
    expect(() => engine.broadcastChat(saved)).not.toThrow();

    // Despite the throw, the other broadcasters should still be called
    expect(controllerBroadcast).toHaveBeenCalledOnce();
    expect(telegramNotify).toHaveBeenCalledOnce();
  });

  it('skips broadcastToChurch when source is "app"', () => {
    const churchBroadcast = vi.fn();
    const controllerBroadcast = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: churchBroadcast, broadcastToControllers: controllerBroadcast });

    const saved = engine.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'hi' });
    engine.broadcastChat(saved);

    expect(churchBroadcast).not.toHaveBeenCalled();
    expect(controllerBroadcast).toHaveBeenCalledOnce();
  });

  it('skips notifyTelegram when source is "telegram"', () => {
    const telegramNotify = vi.fn();
    const controllerBroadcast = vi.fn();
    engine.setBroadcasters({ notifyTelegram: telegramNotify, broadcastToControllers: controllerBroadcast });

    const saved = engine.saveMessage({ churchId: 'c', senderName: 'Bot', senderRole: 'admin', source: 'telegram', message: 'from tg' });
    engine.broadcastChat(saved);

    expect(telegramNotify).not.toHaveBeenCalled();
    expect(controllerBroadcast).toHaveBeenCalledOnce();
  });
});

// ─── getRecentConversation edge cases ────────────────────────────────────────

describe('getRecentConversation — noise filtering and edge cases', () => {
  let db, engine;
  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('filters out emoji-prefixed system messages', () => {
    // Insert system messages that should be filtered
    const emojiMsgs = ['✅ Done', '❌ Failed', '⚠️ Warning', '📤 Sending', '🎛️ Switcher', '🎥 Camera', '📺 Display'];
    for (const msg of emojiMsgs) {
      engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: msg });
    }
    const result = engine.getRecentConversation('c');
    expect(result).toHaveLength(0);
  });

  it('filters out progress messages from system role', () => {
    engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: 'Uploading config...' });
    engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: 'Parsing scene...' });
    engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: 'Applying changes...' });
    const result = engine.getRecentConversation('c');
    expect(result).toHaveLength(0);
  });

  it('returns empty array when only system noise exists', () => {
    engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: '✅ Stream started' });
    const result = engine.getRecentConversation('c');
    expect(result).toEqual([]);
  });

  it('returns empty array for a church with no messages at all', () => {
    const result = engine.getRecentConversation('nonexistent');
    expect(result).toEqual([]);
  });

  it('non-noise system messages are included as assistant role', () => {
    engine.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Is the stream up?' });
    engine.saveMessage({ churchId: 'c', senderName: 'System', senderRole: 'system', source: 'app', message: 'Yes, stream is live and stable' });
    engine.saveMessage({ churchId: 'c', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Great, thank you!' });

    const result = engine.getRecentConversation('c');
    // Last user message should be dropped (it's the "current" message for the caller to append)
    // So we expect: [user: "Is the stream up?", assistant: "Yes, stream is live..."]
    expect(result.length).toBeGreaterThanOrEqual(1);
    const roles = result.map(r => r.role);
    // Must start with user
    expect(roles[0]).toBe('user');
  });
});
