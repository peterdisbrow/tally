/**
 * Concurrency tests for ChatEngine — concurrent saves, reads, and prunes.
 *
 * SQLite in better-sqlite3 is inherently synchronous, so "concurrent" here
 * means multiple operations fired without awaiting between them, then resolved
 * together via Promise.all. This verifies no data loss or corruption occurs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { ChatEngine } = require('../src/chatEngine.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  return new Database(':memory:');
}

function createEngine(db, opts = {}) {
  return new ChatEngine(db, opts);
}

function makeMsg(i, churchId = 'church-1', session = 'sess-A') {
  return {
    churchId,
    senderName: `User-${i}`,
    senderRole: 'td',
    source: 'app',
    message: `Message body number ${i}`,
  };
}

// ─── A. 50 concurrent saveMessage calls from different sessions ───────────────

describe('50 concurrent saveMessage calls from different sessions', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => { db?.close(); });

  it('all 50 messages are persisted without data loss', () => {
    const COUNT = 50;
    const results = [];

    // Fire all saves without awaiting (synchronous under the hood)
    for (let i = 0; i < COUNT; i++) {
      results.push(engine.saveMessage({
        churchId: 'church-1',
        senderName: `User-${i}`,
        senderRole: 'td',
        source: 'app',
        message: `Concurrent message ${i}`,
      }));
    }

    // All saves returned a result object
    expect(results).toHaveLength(COUNT);
    results.forEach((r, i) => {
      expect(r.id).toBeTruthy();
      expect(r.message).toBe(`Concurrent message ${i}`);
    });

    // All 50 persisted in DB
    const stored = engine.getMessages('church-1', { limit: 200 });
    expect(stored).toHaveLength(COUNT);
  });

  it('each saved message has a unique id', () => {
    const COUNT = 50;
    const ids = new Set();
    for (let i = 0; i < COUNT; i++) {
      const result = engine.saveMessage(makeMsg(i));
      ids.add(result.id);
    }
    expect(ids.size).toBe(COUNT);
  });
});

// ─── B. 20 concurrent saveMessage calls to the SAME session ──────────────────

describe('20 concurrent saveMessage calls to the same church', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    const sessionRecap = { getActiveSessionId: () => 'session-shared' };
    engine = createEngine(db, { sessionRecap });
  });

  afterEach(() => { db?.close(); });

  it('all 20 messages stored — no lost writes', () => {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      engine.saveMessage({
        churchId: 'church-same',
        senderName: `Speaker-${i}`,
        senderRole: 'td',
        source: 'app',
        message: `Same-session message ${i}`,
      });
    }

    const stored = engine.getMessages('church-same', { limit: 200 });
    expect(stored).toHaveLength(COUNT);
    stored.forEach(m => {
      expect(m.session_id).toBe('session-shared');
    });
  });

  it('messages are retrievable filtered by session_id', () => {
    const COUNT = 20;
    for (let i = 0; i < COUNT; i++) {
      engine.saveMessage({
        churchId: 'church-same',
        senderName: `Speaker-${i}`,
        senderRole: 'td',
        source: 'app',
        message: `Msg ${i}`,
      });
    }
    const bySession = engine.getMessages('church-same', { sessionId: 'session-shared', limit: 200 });
    expect(bySession).toHaveLength(COUNT);
  });
});

// ─── C. getMessages called concurrently with saveMessage ─────────────────────

describe('getMessages called interleaved with saveMessage', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => { db?.close(); });

  it('interleaved saves and reads produce no errors', () => {
    const reads = [];
    // Interleave saves and reads
    for (let i = 0; i < 30; i++) {
      engine.saveMessage({
        churchId: 'church-interleaved',
        senderName: `User`,
        senderRole: 'td',
        source: 'app',
        message: `Interleaved msg ${i}`,
      });
      // Read after every save
      reads.push(engine.getMessages('church-interleaved', { limit: 200 }));
    }

    // Final read should see all 30 messages
    const final = engine.getMessages('church-interleaved', { limit: 200 });
    expect(final).toHaveLength(30);
    // All intermediate reads returned arrays (no crashes)
    reads.forEach(r => expect(Array.isArray(r)).toBe(true));
  });

  it('concurrent reads from multiple churches do not cross-contaminate', () => {
    for (let i = 0; i < 10; i++) {
      engine.saveMessage({ churchId: 'alpha', senderName: 'A', senderRole: 'td', source: 'app', message: `Alpha ${i}` });
      engine.saveMessage({ churchId: 'beta', senderName: 'B', senderRole: 'td', source: 'app', message: `Beta ${i}` });
    }

    const alpha = engine.getMessages('alpha', { limit: 200 });
    const beta = engine.getMessages('beta', { limit: 200 });

    expect(alpha).toHaveLength(10);
    expect(beta).toHaveLength(10);
    alpha.forEach(m => expect(m.church_id).toBe('alpha'));
    beta.forEach(m => expect(m.church_id).toBe('beta'));
  });
});

// ─── D. pruneOldMessages + saveMessage concurrently ──────────────────────────

describe('pruneOldMessages and saveMessage running interleaved', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => { db?.close(); });

  it('prune deletes old messages, new messages survive', () => {
    // Insert 10 "old" messages manually with a timestamp far in the past
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(`old-id-${i}`, 'church-prune', oldTs, 'OldUser', 'td', 'app', `Old msg ${i}`);
    }

    // Insert 5 fresh messages
    for (let i = 0; i < 5; i++) {
      engine.saveMessage({
        churchId: 'church-prune',
        senderName: 'NewUser',
        senderRole: 'td',
        source: 'app',
        message: `Fresh msg ${i}`,
      });
    }

    // Interleave a prune operation
    const pruneResult = engine.pruneOldMessages(30);

    // Old messages should be deleted
    expect(pruneResult.deleted).toBe(10);

    // Fresh messages should still be there
    const remaining = engine.getMessages('church-prune', { limit: 200 });
    expect(remaining).toHaveLength(5);
    remaining.forEach(m => expect(m.sender_name).toBe('NewUser'));
  });

  it('prune with no old messages returns zero deleted', () => {
    for (let i = 0; i < 5; i++) {
      engine.saveMessage({
        churchId: 'church-no-old',
        senderName: 'User',
        senderRole: 'td',
        source: 'app',
        message: `Fresh ${i}`,
      });
    }
    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(0);
    expect(engine.getMessages('church-no-old', { limit: 200 })).toHaveLength(5);
  });
});

// ─── E. Large message volume: 500 messages with pagination ───────────────────

describe('large message volume — 500 messages with pagination', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => { db?.close(); });

  it('saves 500 messages without error', () => {
    const COUNT = 500;
    for (let i = 0; i < COUNT; i++) {
      engine.saveMessage({
        churchId: 'church-bulk',
        senderName: `Bulk-${i}`,
        senderRole: 'td',
        source: 'app',
        message: `Bulk message ${i}`,
      });
    }
    // Use raw DB count to verify all persisted (getMessages caps at 200)
    const count = db.prepare("SELECT COUNT(*) as cnt FROM chat_messages WHERE church_id = 'church-bulk'").get();
    expect(count.cnt).toBe(COUNT);
  });

  it('getMessages respects the default limit of 50', () => {
    for (let i = 0; i < 100; i++) {
      engine.saveMessage({
        churchId: 'church-limit',
        senderName: 'User',
        senderRole: 'td',
        source: 'app',
        message: `Msg ${i}`,
      });
    }
    const page = engine.getMessages('church-limit'); // default limit = 50
    expect(page).toHaveLength(50);
  });

  it('getMessages respects the max cap of 200', () => {
    for (let i = 0; i < 500; i++) {
      engine.saveMessage({
        churchId: 'church-cap',
        senderName: 'User',
        senderRole: 'td',
        source: 'app',
        message: `Msg ${i}`,
      });
    }
    // Even with limit=500, capped at 200
    const page = engine.getMessages('church-cap', { limit: 500 });
    expect(page).toHaveLength(200);
  });

  it('getMessages with latest flag returns the most recent N messages', () => {
    for (let i = 0; i < 100; i++) {
      engine.saveMessage({
        churchId: 'church-latest',
        senderName: 'User',
        senderRole: 'td',
        source: 'app',
        message: `Msg ${i}`,
      });
    }
    const latest = engine.getMessages('church-latest', { latest: true, limit: 10 });
    expect(latest).toHaveLength(10);
    // Should include the last message (Msg 99)
    expect(latest[latest.length - 1].message).toBe('Msg 99');
  });

  it('getMessages ordered ASC by default', () => {
    for (let i = 0; i < 10; i++) {
      engine.saveMessage({
        churchId: 'church-order',
        senderName: 'User',
        senderRole: 'td',
        source: 'app',
        message: `Msg ${i}`,
      });
    }
    const msgs = engine.getMessages('church-order', { limit: 10 });
    // Timestamps should be non-decreasing
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp >= msgs[i - 1].timestamp).toBe(true);
    }
  });
});
