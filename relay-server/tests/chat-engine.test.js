import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { ChatEngine } = require('../src/chatEngine.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  return new Database(':memory:');
}

function mockSessionRecap(activeSessionId = null) {
  return {
    getActiveSessionId: vi.fn().mockReturnValue(activeSessionId),
  };
}

function createEngine(db, opts = {}) {
  return new ChatEngine(db, opts);
}

function seedMessages(engine, churchId, messages) {
  const saved = [];
  for (const msg of messages) {
    saved.push(engine.saveMessage({
      churchId,
      senderName: msg.senderName || 'TestUser',
      senderRole: msg.senderRole || 'td',
      source: msg.source || 'app',
      message: msg.message,
    }));
  }
  return saved;
}

// ─── A. Constructor & Table Setup ───────────────────────────────────────────

describe('Constructor & Table Setup', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('creates chat_messages table on construction', () => {
    createEngine(db);
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'"
    ).get();
    expect(table).toBeTruthy();
    expect(table.name).toBe('chat_messages');
  });

  it('creates indexes on construction', () => {
    createEngine(db);
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_chat_%'"
    ).all();
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_chat_church_ts');
    expect(names).toContain('idx_chat_session');
  });

  it('does not throw if table already exists (idempotent)', () => {
    createEngine(db);
    expect(() => createEngine(db)).not.toThrow();
  });

  it('stores sessionRecap reference', () => {
    const recap = mockSessionRecap('session-1');
    const engine = createEngine(db, { sessionRecap: recap });
    expect(engine.sessionRecap).toBe(recap);
  });

  it('defaults sessionRecap to null', () => {
    const engine = createEngine(db);
    expect(engine.sessionRecap).toBeNull();
  });

  it('broadcaster functions default to null', () => {
    const engine = createEngine(db);
    expect(engine._broadcastToChurch).toBeNull();
    expect(engine._broadcastToControllers).toBeNull();
    expect(engine._notifyTelegram).toBeNull();
  });
});

// ─── B. setBroadcasters ─────────────────────────────────────────────────────

describe('setBroadcasters', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('wires all three broadcast functions', () => {
    const bc = vi.fn();
    const ctrl = vi.fn();
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl, notifyTelegram: tg });
    expect(engine._broadcastToChurch).toBe(bc);
    expect(engine._broadcastToControllers).toBe(ctrl);
    expect(engine._notifyTelegram).toBe(tg);
  });

  it('partial set only updates provided functions', () => {
    const bc = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc });
    expect(engine._broadcastToChurch).toBe(bc);
    expect(engine._broadcastToControllers).toBeNull();
    expect(engine._notifyTelegram).toBeNull();
  });

  it('does not overwrite with undefined', () => {
    const bc = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc });
    engine.setBroadcasters({ notifyTelegram: vi.fn() });
    expect(engine._broadcastToChurch).toBe(bc);
  });
});

// ─── C. saveMessage ─────────────────────────────────────────────────────────

describe('saveMessage', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('returns saved message with all fields', () => {
    const msg = engine.saveMessage({
      churchId: 'church-1',
      senderName: 'John',
      senderRole: 'td',
      source: 'app',
      message: 'Hello world',
    });
    expect(msg.id).toBeTruthy();
    expect(msg.church_id).toBe('church-1');
    expect(msg.sender_name).toBe('John');
    expect(msg.sender_role).toBe('td');
    expect(msg.source).toBe('app');
    expect(msg.message).toBe('Hello world');
    expect(msg.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('generates unique IDs for each message', () => {
    const m1 = engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'msg1' });
    const m2 = engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'msg2' });
    expect(m1.id).not.toBe(m2.id);
  });

  it('persists message to database', () => {
    engine.saveMessage({ churchId: 'church-1', senderName: 'A', senderRole: 'td', source: 'app', message: 'persisted' });
    const row = db.prepare('SELECT * FROM chat_messages WHERE church_id = ?').get('church-1');
    expect(row).toBeTruthy();
    expect(row.message).toBe('persisted');
  });

  it('links to active session when sessionRecap is available', () => {
    const recap = mockSessionRecap('session-abc');
    const eng = createEngine(db, { sessionRecap: recap });
    const msg = eng.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'test' });
    expect(msg.session_id).toBe('session-abc');
    expect(recap.getActiveSessionId).toHaveBeenCalledWith('c1');
  });

  it('session_id is null when no sessionRecap', () => {
    const msg = engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'test' });
    expect(msg.session_id).toBeNull();
  });

  it('session_id is null when sessionRecap returns null', () => {
    const recap = mockSessionRecap(null);
    const eng = createEngine(db, { sessionRecap: recap });
    const msg = eng.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'test' });
    expect(msg.session_id).toBeNull();
  });
});

// ─── D. getMessages — Retrieval & Filtering ─────────────────────────────────

describe('getMessages', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('returns messages for a given church in chronological order', () => {
    seedMessages(engine, 'c1', [
      { message: 'first' },
      { message: 'second' },
      { message: 'third' },
    ]);
    const msgs = engine.getMessages('c1');
    expect(msgs).toHaveLength(3);
    expect(msgs[0].message).toBe('first');
    expect(msgs[2].message).toBe('third');
  });

  it('does not return messages from other churches', () => {
    seedMessages(engine, 'c1', [{ message: 'for c1' }]);
    seedMessages(engine, 'c2', [{ message: 'for c2' }]);
    const msgs = engine.getMessages('c1');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe('for c1');
  });

  it('respects limit parameter', () => {
    seedMessages(engine, 'c1', Array.from({ length: 10 }, (_, i) => ({ message: `msg-${i}` })));
    const msgs = engine.getMessages('c1', { limit: 3 });
    expect(msgs).toHaveLength(3);
  });

  it('defaults limit to 50', () => {
    seedMessages(engine, 'c1', Array.from({ length: 60 }, (_, i) => ({ message: `msg-${i}` })));
    const msgs = engine.getMessages('c1');
    expect(msgs).toHaveLength(50);
  });

  it('caps limit at 200', () => {
    seedMessages(engine, 'c1', Array.from({ length: 210 }, (_, i) => ({ message: `m${i}` })));
    const msgs = engine.getMessages('c1', { limit: 999 });
    expect(msgs).toHaveLength(200);
  });

  it('filters by since timestamp', () => {
    // Insert a message, grab its timestamp, then insert another
    const m1 = engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'old' });
    // Ensure timestamp difference
    const m2 = engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'new' });
    const msgs = engine.getMessages('c1', { since: m1.timestamp });
    // Should exclude m1 (since is exclusive) and include m2
    expect(msgs.every(m => m.message !== 'old' || m.timestamp > m1.timestamp)).toBe(true);
  });

  it('filters by sessionId', () => {
    const recap = mockSessionRecap('sess-1');
    const eng = createEngine(db, { sessionRecap: recap });
    eng.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'in session' });
    recap.getActiveSessionId.mockReturnValue(null);
    eng.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'no session' });

    const msgs = eng.getMessages('c1', { sessionId: 'sess-1' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toBe('in session');
  });

  it('latest flag returns most recent N messages in chronological order', () => {
    seedMessages(engine, 'c1', Array.from({ length: 10 }, (_, i) => ({ message: `msg-${i}` })));
    const msgs = engine.getMessages('c1', { limit: 3, latest: true });
    expect(msgs).toHaveLength(3);
    // Should be the last 3 messages in chronological order
    expect(msgs[0].message).toBe('msg-7');
    expect(msgs[1].message).toBe('msg-8');
    expect(msgs[2].message).toBe('msg-9');
  });

  it('returns empty array for unknown church', () => {
    const msgs = engine.getMessages('nonexistent');
    expect(msgs).toEqual([]);
  });

  it('handles invalid limit gracefully (defaults to 50)', () => {
    seedMessages(engine, 'c1', [{ message: 'test' }]);
    const msgs = engine.getMessages('c1', { limit: 'abc' });
    expect(msgs).toHaveLength(1); // only 1 message, but limit parsed to 50
  });
});

// ─── E. getRecentConversation — AI Context Window ───────────────────────────

describe('getRecentConversation', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('returns empty array when no messages exist', () => {
    const conv = engine.getRecentConversation('c1');
    expect(conv).toEqual([]);
  });

  it('maps td/admin roles to user role', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'from td' },
      { senderRole: 'system', message: 'AI response here' },
      { senderRole: 'admin', message: 'from admin' },
    ]);
    const conv = engine.getRecentConversation('c1');
    // First should be user (td), then assistant (system), then user (admin)
    // But the last user message gets popped
    expect(conv.length).toBeGreaterThanOrEqual(1);
    for (const turn of conv) {
      expect(['user', 'assistant']).toContain(turn.role);
    }
  });

  it('maps system role to assistant', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'question' },
      { senderRole: 'system', message: 'Here is the answer' },
      { senderRole: 'td', message: 'follow up' },
    ]);
    const conv = engine.getRecentConversation('c1');
    const assistantTurns = conv.filter(t => t.role === 'assistant');
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);
    expect(assistantTurns[0].content).toBe('Here is the answer');
  });

  it('filters out system status messages (emoji prefixed)', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'do something' },
      { senderRole: 'system', message: '\u2705 Stream started successfully' },
      { senderRole: 'system', message: 'Here is a conversational response' },
      { senderRole: 'td', message: 'thanks' },
    ]);
    const conv = engine.getRecentConversation('c1');
    const contents = conv.map(t => t.content);
    // Status message with checkmark should be filtered
    expect(contents.join(' ')).not.toContain('Stream started');
    // Conversational response should remain
    expect(contents).toContain('Here is a conversational response');
  });

  it('filters out progress messages (Uploading, Parsing, Applying)', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'do something' },
      { senderRole: 'system', message: 'Uploading file...' },
      { senderRole: 'system', message: 'Parsing configuration' },
      { senderRole: 'system', message: 'Applying settings now' },
      { senderRole: 'system', message: 'Done, everything looks good' },
      { senderRole: 'td', message: 'next question' },
    ]);
    const conv = engine.getRecentConversation('c1');
    const contents = conv.map(t => t.content);
    expect(contents.join(' ')).not.toContain('Uploading');
    expect(contents.join(' ')).not.toContain('Parsing');
    expect(contents.join(' ')).not.toContain('Applying');
  });

  it('merges consecutive same-role messages', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'first' },
      { senderRole: 'td', message: 'second' },
      { senderRole: 'system', message: 'response' },
      { senderRole: 'td', message: 'third' },
    ]);
    const conv = engine.getRecentConversation('c1');
    // Two consecutive td messages should be merged into one user turn
    const userTurns = conv.filter(t => t.role === 'user');
    if (userTurns.length > 0) {
      expect(userTurns[0].content).toContain('first');
      expect(userTurns[0].content).toContain('second');
    }
  });

  it('ensures conversation starts with user role', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'system', message: 'system message first' },
      { senderRole: 'td', message: 'user message' },
      { senderRole: 'system', message: 'response' },
      { senderRole: 'td', message: 'final' },
    ]);
    const conv = engine.getRecentConversation('c1');
    if (conv.length > 0) {
      expect(conv[0].role).toBe('user');
    }
  });

  it('removes trailing user message (current message handled by caller)', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'old question' },
      { senderRole: 'system', message: 'old answer' },
      { senderRole: 'td', message: 'current question' },
    ]);
    const conv = engine.getRecentConversation('c1');
    // The last user message should be removed
    if (conv.length > 0) {
      expect(conv[conv.length - 1].role).toBe('assistant');
    }
  });

  it('respects limit parameter', () => {
    // Seed 20 messages
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push({
        senderRole: i % 2 === 0 ? 'td' : 'system',
        message: `message-${i}`,
      });
    }
    seedMessages(engine, 'c1', msgs);
    const conv = engine.getRecentConversation('c1', { limit: 4 });
    // With limit 4, only 4 raw messages fetched from DB
    // After filtering and merging, result should be small
    expect(conv.length).toBeLessThanOrEqual(4);
  });

  it('respects maxAgeMinutes parameter — excludes old messages', () => {
    // Insert a message with a very old timestamp directly
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-id', 'c1', null, '2020-01-01T00:00:00.000Z', 'Old', 'td', 'app', 'ancient message');

    // Insert a recent message via engine
    engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'recent' });

    const conv = engine.getRecentConversation('c1', { maxAgeMinutes: 5 });
    const contents = conv.map(t => t.content);
    expect(contents.join(' ')).not.toContain('ancient');
  });

  it('returns empty array when all messages are status noise', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'system', message: '\u2705 Done' },
      { senderRole: 'system', message: '\u274C Failed' },
      { senderRole: 'system', message: 'Uploading...' },
    ]);
    const conv = engine.getRecentConversation('c1');
    expect(conv).toEqual([]);
  });

  it('strictly alternates user/assistant roles', () => {
    seedMessages(engine, 'c1', [
      { senderRole: 'td', message: 'q1' },
      { senderRole: 'admin', message: 'q2' },
      { senderRole: 'system', message: 'a1' },
      { senderRole: 'system', message: 'a2' },
      { senderRole: 'td', message: 'q3' },
    ]);
    const conv = engine.getRecentConversation('c1');
    for (let i = 1; i < conv.length; i++) {
      expect(conv[i].role).not.toBe(conv[i - 1].role);
    }
  });
});

// ─── F. pruneOldMessages — Retention / Pruning ──────────────────────────────

describe('pruneOldMessages', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('deletes messages older than retention period', () => {
    // Insert old message directly
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-1', 'c1', null, '2020-01-01T00:00:00.000Z', 'Old', 'td', 'app', 'ancient');

    // Insert recent message
    engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'recent' });

    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(1);

    const remaining = db.prepare('SELECT * FROM chat_messages WHERE church_id = ?').all('c1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe('recent');
  });

  it('returns 0 when nothing to prune', () => {
    engine.saveMessage({ churchId: 'c1', senderName: 'A', senderRole: 'td', source: 'app', message: 'recent' });
    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(0);
  });

  it('defaults to 30-day retention', () => {
    // Insert message 31 days old
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-1', 'c1', null, oldDate, 'Old', 'td', 'app', 'old enough');

    const result = engine.pruneOldMessages();
    expect(result.deleted).toBe(1);
  });

  it('respects custom retention period', () => {
    // Insert message 3 days old
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('mid-1', 'c1', null, threeDaysAgo, 'User', 'td', 'app', 'three days old');

    // With 7-day retention, should NOT delete
    expect(engine.pruneOldMessages(7).deleted).toBe(0);
    // With 1-day retention, should delete
    expect(engine.pruneOldMessages(1).deleted).toBe(1);
  });

  it('prunes across all churches', () => {
    const oldDate = '2020-01-01T00:00:00.000Z';
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-c1', 'c1', null, oldDate, 'A', 'td', 'app', 'old c1');
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('old-c2', 'c2', null, oldDate, 'B', 'td', 'app', 'old c2');

    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(2);
  });
});

// ─── G. broadcastChat — Broadcasting to Surfaces ────────────────────────────

describe('broadcastChat', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('broadcasts to all surfaces for telegram-sourced message', () => {
    const bc = vi.fn();
    const ctrl = vi.fn();
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl, notifyTelegram: tg });

    const msg = { church_id: 'c1', source: 'telegram', message: 'from tg' };
    engine.broadcastChat(msg);

    // Should send to church (since source is not app)
    expect(bc).toHaveBeenCalledWith('c1', expect.objectContaining({ type: 'chat', source: 'telegram' }));
    // Should send to controllers
    expect(ctrl).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }));
    // Should NOT notify telegram (source IS telegram)
    expect(tg).not.toHaveBeenCalled();
  });

  it('does not broadcast to church when source is app', () => {
    const bc = vi.fn();
    const ctrl = vi.fn();
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl, notifyTelegram: tg });

    const msg = { church_id: 'c1', source: 'app', message: 'from app' };
    engine.broadcastChat(msg);

    expect(bc).not.toHaveBeenCalled();
    expect(ctrl).toHaveBeenCalled();
    expect(tg).toHaveBeenCalled();
  });

  it('does not notify telegram when source is telegram', () => {
    const bc = vi.fn();
    const ctrl = vi.fn();
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl, notifyTelegram: tg });

    engine.broadcastChat({ church_id: 'c1', source: 'telegram', message: 'test' });
    expect(tg).not.toHaveBeenCalled();
  });

  it('sends to all surfaces for dashboard-sourced message', () => {
    const bc = vi.fn();
    const ctrl = vi.fn();
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl, notifyTelegram: tg });

    engine.broadcastChat({ church_id: 'c1', source: 'dashboard', message: 'from dash' });
    expect(bc).toHaveBeenCalled();
    expect(ctrl).toHaveBeenCalled();
    expect(tg).toHaveBeenCalled();
  });

  it('wraps message with type: chat', () => {
    const ctrl = vi.fn();
    engine.setBroadcasters({ broadcastToControllers: ctrl });

    const msg = { church_id: 'c1', source: 'app', message: 'hello' };
    engine.broadcastChat(msg);

    expect(ctrl).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat',
      church_id: 'c1',
      message: 'hello',
    }));
  });

  it('gracefully handles missing broadcasters (no crash)', () => {
    // No broadcasters set
    expect(() => engine.broadcastChat({ church_id: 'c1', source: 'dashboard', message: 'test' })).not.toThrow();
  });

  it('catches errors from broadcastToChurch without crashing', () => {
    const bc = vi.fn().mockImplementation(() => { throw new Error('ws error'); });
    const ctrl = vi.fn();
    engine.setBroadcasters({ broadcastToChurch: bc, broadcastToControllers: ctrl });

    expect(() => engine.broadcastChat({ church_id: 'c1', source: 'telegram', message: 'test' })).not.toThrow();
    // Should still call ctrl even though bc failed
    expect(ctrl).toHaveBeenCalled();
  });

  it('catches errors from broadcastToControllers without crashing', () => {
    const ctrl = vi.fn().mockImplementation(() => { throw new Error('ctrl error'); });
    const tg = vi.fn();
    engine.setBroadcasters({ broadcastToControllers: ctrl, notifyTelegram: tg });

    expect(() => engine.broadcastChat({ church_id: 'c1', source: 'app', message: 'test' })).not.toThrow();
    expect(tg).toHaveBeenCalled();
  });

  it('catches errors from notifyTelegram without crashing', () => {
    const tg = vi.fn().mockImplementation(() => { throw new Error('tg error'); });
    engine.setBroadcasters({ notifyTelegram: tg });

    expect(() => engine.broadcastChat({ church_id: 'c1', source: 'app', message: 'test' })).not.toThrow();
  });
});

// ─── H. Message Sanitization / Edge Cases ───────────────────────────────────

describe('Message sanitization & edge cases', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('stores messages with special characters', () => {
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: "O'Brien", senderRole: 'td', source: 'app',
      message: "It's a test with 'quotes' and \"double quotes\"",
    });
    expect(msg.message).toContain("'quotes'");
    const row = db.prepare('SELECT message FROM chat_messages WHERE id = ?').get(msg.id);
    expect(row.message).toContain("'quotes'");
  });

  it('stores messages with unicode/emoji content', () => {
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'User', senderRole: 'td', source: 'app',
      message: 'Great service today! \uD83D\uDE4F\uD83C\uDFB5',
    });
    expect(msg.message).toContain('\uD83D\uDE4F');
  });

  it('stores empty message string', () => {
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'User', senderRole: 'td', source: 'app',
      message: '',
    });
    expect(msg.message).toBe('');
  });

  it('stores very long messages', () => {
    const longMsg = 'x'.repeat(10000);
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'User', senderRole: 'td', source: 'app',
      message: longMsg,
    });
    expect(msg.message.length).toBe(10000);
    const row = db.prepare('SELECT message FROM chat_messages WHERE id = ?').get(msg.id);
    expect(row.message.length).toBe(10000);
  });

  it('handles SQL injection attempts safely via parameterized queries', () => {
    const malicious = "'; DROP TABLE chat_messages; --";
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'Hacker', senderRole: 'td', source: 'app',
      message: malicious,
    });
    expect(msg.message).toBe(malicious);
    // Table should still exist
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_messages'").get();
    expect(table).toBeTruthy();
  });

  it('handles newlines in messages', () => {
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'User', senderRole: 'td', source: 'app',
      message: 'line1\nline2\nline3',
    });
    expect(msg.message).toBe('line1\nline2\nline3');
  });
});

// ─── I. Message Processing Pipeline (save → retrieve → conversation) ────────

describe('Message processing pipeline', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('full pipeline: save → getMessages → getRecentConversation', () => {
    // Simulate a conversation
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'How do I switch cameras?' });
    engine.saveMessage({ churchId: 'c1', senderName: 'System', senderRole: 'system', source: 'app', message: 'You can use "cut to camera N" to switch.' });
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Thanks!' });

    // getMessages returns all raw messages
    const raw = engine.getMessages('c1');
    expect(raw).toHaveLength(3);

    // getRecentConversation formats for AI
    const conv = engine.getRecentConversation('c1');
    // Should have user + assistant (trailing user "Thanks!" is removed)
    expect(conv.length).toBeGreaterThanOrEqual(1);
    expect(conv[0].role).toBe('user');
    if (conv.length > 1) {
      expect(conv[1].role).toBe('assistant');
    }
  });

  it('save + broadcast works end-to-end', () => {
    const ctrl = vi.fn();
    engine.setBroadcasters({ broadcastToControllers: ctrl });

    const saved = engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'test' });
    engine.broadcastChat(saved);

    expect(ctrl).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat',
      church_id: 'c1',
      sender_name: 'TD',
      message: 'test',
    }));
  });

  it('messages from multiple sources interleave correctly', () => {
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'from app' });
    engine.saveMessage({ churchId: 'c1', senderName: 'Admin', senderRole: 'admin', source: 'dashboard', message: 'from dashboard' });
    engine.saveMessage({ churchId: 'c1', senderName: 'TG User', senderRole: 'td', source: 'telegram', message: 'from telegram' });

    const msgs = engine.getMessages('c1');
    expect(msgs).toHaveLength(3);
    expect(msgs.map(m => m.source)).toEqual(['app', 'dashboard', 'telegram']);
  });
});

// ─── J. Context Window Limits / History Truncation ──────────────────────────

describe('Context window limits', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('getRecentConversation limits to 10 messages by default', () => {
    // Seed 30 alternating messages
    for (let i = 0; i < 30; i++) {
      engine.saveMessage({
        churchId: 'c1',
        senderName: 'User',
        senderRole: i % 2 === 0 ? 'td' : 'system',
        source: 'app',
        message: `msg-${i}`,
      });
    }
    const conv = engine.getRecentConversation('c1');
    // Only 10 raw messages fetched, so conversation turns will be <= 10
    expect(conv.length).toBeLessThanOrEqual(10);
  });

  it('custom limit constrains conversation window', () => {
    for (let i = 0; i < 20; i++) {
      engine.saveMessage({
        churchId: 'c1',
        senderName: 'User',
        senderRole: i % 2 === 0 ? 'td' : 'system',
        source: 'app',
        message: `msg-${i}`,
      });
    }
    const conv = engine.getRecentConversation('c1', { limit: 4 });
    expect(conv.length).toBeLessThanOrEqual(4);
  });

  it('age-based truncation excludes stale messages from context', () => {
    // Insert old messages directly
    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`old-${i}`, 'c1', null, '2020-01-01T00:00:00.000Z', 'Old', i % 2 === 0 ? 'td' : 'system', 'app', `old-${i}`);
    }
    // Insert recent message
    engine.saveMessage({ churchId: 'c1', senderName: 'New', senderRole: 'td', source: 'app', message: 'recent' });

    const conv = engine.getRecentConversation('c1', { maxAgeMinutes: 1 });
    // Old messages should be excluded; only the recent one (which gets popped as trailing user)
    for (const turn of conv) {
      expect(turn.content).not.toContain('old-');
    }
  });
});

// ─── K. Response Formatting ─────────────────────────────────────────────────

describe('Response formatting', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });
  afterEach(() => { db?.close(); });

  it('saveMessage returns consistent shape', () => {
    const msg = engine.saveMessage({
      churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'test',
    });
    expect(msg).toHaveProperty('id');
    expect(msg).toHaveProperty('church_id');
    expect(msg).toHaveProperty('session_id');
    expect(msg).toHaveProperty('timestamp');
    expect(msg).toHaveProperty('sender_name');
    expect(msg).toHaveProperty('sender_role');
    expect(msg).toHaveProperty('source');
    expect(msg).toHaveProperty('message');
  });

  it('getMessages returns rows with all DB columns', () => {
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'test' });
    const msgs = engine.getMessages('c1');
    const msg = msgs[0];
    expect(msg).toHaveProperty('id');
    expect(msg).toHaveProperty('church_id');
    expect(msg).toHaveProperty('session_id');
    expect(msg).toHaveProperty('timestamp');
    expect(msg).toHaveProperty('sender_name');
    expect(msg).toHaveProperty('sender_role');
    expect(msg).toHaveProperty('source');
    expect(msg).toHaveProperty('message');
  });

  it('getRecentConversation returns {role, content} objects only', () => {
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'question' });
    engine.saveMessage({ churchId: 'c1', senderName: 'System', senderRole: 'system', source: 'app', message: 'answer' });
    engine.saveMessage({ churchId: 'c1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'follow up' });

    const conv = engine.getRecentConversation('c1');
    for (const turn of conv) {
      expect(Object.keys(turn).sort()).toEqual(['content', 'role']);
    }
  });

  it('broadcastChat adds type field to message', () => {
    const ctrl = vi.fn();
    engine.setBroadcasters({ broadcastToControllers: ctrl });
    engine.broadcastChat({ church_id: 'c1', source: 'app', message: 'test' });
    expect(ctrl.mock.calls[0][0].type).toBe('chat');
  });

  it('pruneOldMessages returns { deleted: number }', () => {
    const result = engine.pruneOldMessages();
    expect(typeof result.deleted).toBe('number');
  });
});
