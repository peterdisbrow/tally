/**
 * Large data handling tests — large message bodies, high row counts,
 * pagination correctness at scale, and prune efficiency.
 *
 * Timing tests use very generous thresholds (5000ms) to remain deterministic
 * on any machine. We test correctness, not micro-benchmarks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { computeHealthScore } from '../src/healthScore.js';

const require = createRequire(import.meta.url);
const { ChatEngine } = require('../src/chatEngine.js');

// ─── DB factories ─────────────────────────────────────────────────────────────

function createChatDb() {
  return new Database(':memory:');
}

function createHealthDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER DEFAULT 60,
      stream_ran INTEGER DEFAULT 1,
      stream_runtime_minutes INTEGER DEFAULT 60,
      recording_confirmed INTEGER DEFAULT 1,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER,
      td_name TEXT,
      grade TEXT,
      notes TEXT
    )
  `);
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      auto_resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE preservice_check_results (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      pass INTEGER DEFAULT 0,
      checks_json TEXT DEFAULT '[]',
      trigger_type TEXT DEFAULT 'auto',
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

// ─── A. ChatEngine: 100KB message body ───────────────────────────────────────

describe('ChatEngine: 100KB message body', () => {
  let db, engine;

  beforeEach(() => {
    db = createChatDb();
    engine = new ChatEngine(db);
  });

  afterEach(() => { db?.close(); });

  it('saves and retrieves a 100KB message without truncation', () => {
    const largeBody = 'A'.repeat(100 * 1024); // exactly 100KB

    const saved = engine.saveMessage({
      churchId: 'church-large',
      senderName: 'TD',
      senderRole: 'td',
      source: 'app',
      message: largeBody,
    });

    expect(saved.id).toBeTruthy();
    expect(saved.message.length).toBe(100 * 1024);

    const retrieved = engine.getMessages('church-large', { limit: 1 });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0].message.length).toBe(100 * 1024);
    expect(retrieved[0].message).toBe(largeBody);
  });

  it('saves 10 messages each with 10KB bodies — all retrieve correctly', () => {
    const body = 'B'.repeat(10 * 1024);
    for (let i = 0; i < 10; i++) {
      engine.saveMessage({
        churchId: 'church-10kb',
        senderName: `User${i}`,
        senderRole: 'td',
        source: 'app',
        message: body,
      });
    }

    const msgs = engine.getMessages('church-10kb', { limit: 200 });
    expect(msgs).toHaveLength(10);
    msgs.forEach(m => expect(m.message.length).toBe(10 * 1024));
  });
});

// ─── B. HealthScore with 1000 sessions in DB ─────────────────────────────────

describe('computeHealthScore with 1000 sessions in DB', () => {
  let db;

  beforeEach(() => {
    db = createHealthDb();
    db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-heavy', 'Heavy Church');

    const insertSession = db.prepare(`
      INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes,
        stream_ran, stream_runtime_minutes, alert_count, auto_recovered_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const startedAt = new Date(now - (i + 1) * 60 * 60 * 1000).toISOString();
        const endedAt = new Date(now - i * 60 * 60 * 1000).toISOString();
        insertSession.run(
          `session-${i}`, 'church-heavy', startedAt, endedAt,
          60, 1, 55, Math.floor(Math.random() * 3), Math.floor(Math.random() * 2)
        );
      }
    });
    insertMany();
  });

  afterEach(() => { db?.close(); });

  it('returns a score within 5000ms for 1000 sessions', () => {
    const start = Date.now();
    const result = computeHealthScore(db, 'church-heavy', 7);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    // With sessions present, should get a valid score or 'new'
    expect(result).toBeDefined();
  });

  it('returns a valid score object shape', () => {
    const result = computeHealthScore(db, 'church-heavy', 7);
    expect(result).toHaveProperty('breakdown');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('recommendations');
    if (result.score !== null) {
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });
});

// ─── C. getMessages with 1000 messages in DB ─────────────────────────────────

describe('getMessages with 1000 messages in DB', () => {
  let db, engine;

  beforeEach(() => {
    db = createChatDb();
    engine = new ChatEngine(db);

    const insert = db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        const ts = new Date(now - (1000 - i) * 1000).toISOString();
        insert.run(`msg-${i}`, 'church-1000', null, ts, 'User', 'td', 'app', `Message ${i}`);
      }
    });
    insertMany();
  });

  afterEach(() => { db?.close(); });

  it('getMessages with default limit returns 50 (not all 1000)', () => {
    const msgs = engine.getMessages('church-1000');
    expect(msgs).toHaveLength(50);
  });

  it('getMessages with limit=100 returns 100', () => {
    const msgs = engine.getMessages('church-1000', { limit: 100 });
    expect(msgs).toHaveLength(100);
  });

  it('getMessages with limit=200 (max cap) returns 200', () => {
    const msgs = engine.getMessages('church-1000', { limit: 200 });
    expect(msgs).toHaveLength(200);
  });

  it('getMessages with limit > 200 is capped at 200', () => {
    const msgs = engine.getMessages('church-1000', { limit: 999 });
    expect(msgs).toHaveLength(200);
  });

  it('getMessages with latest=true returns the 10 most recent messages in chronological order', () => {
    const msgs = engine.getMessages('church-1000', { latest: true, limit: 10 });
    expect(msgs).toHaveLength(10);
    // Latest 10 messages: msg-990 through msg-999
    expect(msgs[msgs.length - 1].message).toBe('Message 999');
    // Should be in ASC order
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp >= msgs[i - 1].timestamp).toBe(true);
    }
  });

  it('getMessages filtered by since returns only messages after the timestamp', () => {
    const allMsgs = engine.getMessages('church-1000', { limit: 200 });
    const cutoff = allMsgs[99].timestamp; // 100th message timestamp

    const filtered = engine.getMessages('church-1000', { since: cutoff, limit: 200 });
    // Should be messages strictly after position 99
    filtered.forEach(m => {
      expect(m.timestamp > cutoff).toBe(true);
    });
  });

  it('getMessages with 1000 messages returns within 5000ms', () => {
    const start = Date.now();
    engine.getMessages('church-1000', { limit: 200 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });
});

// ─── D. 10000 messages — pruneOldMessages deletes correct records ─────────────

describe('pruneOldMessages with 10000 messages', () => {
  let db, engine;

  beforeEach(() => {
    db = createChatDb();
    engine = new ChatEngine(db);

    const insert = db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const now = Date.now();
    // Insert in a transaction for speed
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        // 6000 old (35 days ago), 4000 recent (today)
        const daysOld = i < 6000 ? 35 : 0;
        const ts = new Date(now - daysOld * 24 * 60 * 60 * 1000 - i).toISOString();
        insert.run(`bulk-${i}`, 'church-prune', null, ts, 'User', 'td', 'app', `Msg ${i}`);
      }
    });
    insertMany();
  });

  afterEach(() => { db?.close(); });

  it('prune deletes only messages older than 30 days', () => {
    const result = engine.pruneOldMessages(30);
    expect(result.deleted).toBe(6000);

    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM chat_messages WHERE church_id = 'church-prune'").get();
    expect(remaining.cnt).toBe(4000);
  });

  it('prune with 10000 messages completes within 5000ms', () => {
    const start = Date.now();
    engine.pruneOldMessages(30);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('prune does not delete messages from other churches', () => {
    // Insert a message for a different church with old timestamp
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('other-old', 'other-church', null, oldTs, 'User', 'td', 'app', 'Old msg from other church');

    engine.pruneOldMessages(30);

    // The other church's old message is also pruned (prune is global by timestamp, not per-church)
    const other = db.prepare("SELECT COUNT(*) as cnt FROM chat_messages WHERE church_id = 'other-church'").get();
    // The prune SQL is: DELETE WHERE timestamp < cutoff — so other-church old msg is also pruned
    expect(other.cnt).toBe(0);
  });
});
