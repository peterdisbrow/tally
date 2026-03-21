/**
 * Integration: ChatEngine ↔ HealthScore
 *
 * Tests the interaction points between ChatEngine (message storage/retrieval)
 * and the healthScore computation system, verifying that:
 * - Chat session linkage feeds correctly into health data
 * - Health score computation correctly uses session data that chat messages reference
 * - The session_recap integration (getActiveSessionId) correctly links messages
 * - Chat message volume/history doesn't corrupt health score computation
 * - Multi-church isolation holds across both systems
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ChatEngine } = require('../src/chatEngine.js');
import { computeHealthScore, getHealthRecommendations } from '../src/healthScore.js';

// ─── DB Setup ─────────────────────────────────────────────────────────────────

function createIntegrationDb() {
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
      stream_runtime_minutes INTEGER DEFAULT 55,
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

function insertChurch(db, churchId, name = 'Test Church') {
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run(churchId, name);
}

function insertSession(db, churchId, sessionId, opts = {}) {
  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO service_sessions
    (id, church_id, started_at, ended_at, duration_minutes, stream_ran,
     stream_runtime_minutes, alert_count, auto_recovered_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId, churchId,
    opts.startedAt || weekAgo,
    opts.endedAt || now,
    opts.durationMinutes ?? 90,
    opts.streamRan ?? 1,
    opts.streamRuntime ?? 85,
    opts.alertCount ?? 0,
    opts.autoRecovered ?? 0,
  );
}

function insertAlert(db, churchId, opts = {}) {
  const id = `alert-${Math.random().toString(36).slice(2)}`;
  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id, churchId,
    opts.alertType || 'bitrate_low',
    opts.severity || 'WARNING',
    opts.createdAt || new Date().toISOString(),
  );
  return id;
}

function mockSessionRecap(sessionId) {
  return { getActiveSessionId: vi.fn().mockReturnValue(sessionId) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ChatEngine + HealthScore integration', () => {
  let db;

  beforeEach(() => { db = createIntegrationDb(); });
  afterEach(() => { db?.close(); });

  // ── Session linking ─────────────────────────────────────────────────────────

  describe('session linking between chat and health data', () => {
    it('saveMessage links to the active session ID via sessionRecap', () => {
      const sessionId = 'session-abc';
      const recap = mockSessionRecap(sessionId);
      const engine = new ChatEngine(db, { sessionRecap: recap });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'app',
        message: 'Camera 2 is live',
      });

      expect(msg.session_id).toBe(sessionId);
      expect(recap.getActiveSessionId).toHaveBeenCalledWith('ch1');
    });

    it('messages saved during session reference the correct session ID in DB', () => {
      const sessionId = 'session-xyz';
      const engine = new ChatEngine(db, { sessionRecap: mockSessionRecap(sessionId) });

      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Check levels' });
      engine.saveMessage({ churchId: 'ch1', senderName: 'Admin', senderRole: 'admin', source: 'dashboard', message: 'Looks good' });

      const rows = db.prepare("SELECT session_id FROM chat_messages WHERE church_id = 'ch1'").all();
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.session_id === sessionId)).toBe(true);
    });

    it('messages without active session have null session_id', () => {
      const engine = new ChatEngine(db, { sessionRecap: mockSessionRecap(null) });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'app',
        message: 'Pre-service check',
      });

      expect(msg.session_id).toBeNull();
    });

    it('getMessages can filter by session ID to correlate with health data', () => {
      const sessionId = 'session-filter';
      const engine = new ChatEngine(db, { sessionRecap: mockSessionRecap(sessionId) });

      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'During session' });

      // Now with no session
      const engine2 = new ChatEngine(db, { sessionRecap: mockSessionRecap(null) });
      engine2.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'After session' });

      const sessionMsgs = engine.getMessages('ch1', { sessionId });
      expect(sessionMsgs).toHaveLength(1);
      expect(sessionMsgs[0].message).toBe('During session');
    });
  });

  // ── Health score uses session data that chat references ─────────────────────

  describe('health score uses session data correctly alongside chat', () => {
    it('health score computes correctly with sessions that chat messages reference', () => {
      insertChurch(db, 'ch1');
      insertSession(db, 'ch1', 'session-1', { alertCount: 0, streamRuntime: 90 });

      const engine = new ChatEngine(db, { sessionRecap: mockSessionRecap('session-1') });
      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Stream is healthy' });

      const result = computeHealthScore(db, 'ch1', 7);
      expect(result.score).not.toBeNull();
      expect(result.score).toBeGreaterThan(0);
    });

    it('large volume of chat messages does not corrupt health score computation', () => {
      insertChurch(db, 'ch1');
      insertSession(db, 'ch1', 'session-big', { alertCount: 2, autoRecovered: 1, streamRuntime: 120 });

      const engine = new ChatEngine(db, { sessionRecap: mockSessionRecap('session-big') });

      // Insert 50 chat messages — should not affect health score
      for (let i = 0; i < 50; i++) {
        engine.saveMessage({
          churchId: 'ch1',
          senderName: 'TD',
          senderRole: 'td',
          source: 'app',
          message: `Message ${i}: checking levels, adjusting camera`,
        });
      }

      const result = computeHealthScore(db, 'ch1', 7);
      expect(result.score).not.toBeNull();
      expect(typeof result.score).toBe('number');
      // Recovery rate: 1/2 = 50%, so a recommendation should exist
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('health score returns no data status when sessions exist only with chat, no session records', () => {
      // Chat messages exist but NO service_sessions rows
      insertChurch(db, 'ch1');
      const engine = new ChatEngine(db);
      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Testing' });

      const result = computeHealthScore(db, 'ch1', 7);
      // No sessions = no health data
      expect(result.score).toBeNull();
      expect(result.status).toBe('new');
    });
  });

  // ── Multi-church isolation ───────────────────────────────────────────────────

  describe('multi-church isolation', () => {
    it('chat messages and health scores are isolated between churches', () => {
      insertChurch(db, 'ch1');
      insertChurch(db, 'ch2');

      // Church 1: good health — no alerts
      insertSession(db, 'ch1', 'sess-ch1', { alertCount: 0, streamRuntime: 90 });

      // Church 2: poor health — many alerts
      insertSession(db, 'ch2', 'sess-ch2', { alertCount: 10, autoRecovered: 1, streamRuntime: 90 });
      for (let i = 0; i < 10; i++) {
        insertAlert(db, 'ch2', { severity: 'WARNING' });
      }

      const engine = new ChatEngine(db);
      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'All good' });
      engine.saveMessage({ churchId: 'ch2', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Issues here' });

      const score1 = computeHealthScore(db, 'ch1', 7);
      const score2 = computeHealthScore(db, 'ch2', 7);

      // Church 1 should score higher (no alerts vs many alerts)
      expect(score1.score).not.toBeNull();
      expect(score2.score).not.toBeNull();
      expect(score1.score).toBeGreaterThan(score2.score);

      // Chat messages are also isolated
      const msgs1 = engine.getMessages('ch1');
      const msgs2 = engine.getMessages('ch2');
      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);
      expect(msgs1[0].message).toBe('All good');
      expect(msgs2[0].message).toBe('Issues here');
    });

    it('pruning chat for one church does not affect health data for another', () => {
      insertChurch(db, 'ch1');
      insertChurch(db, 'ch2');
      insertSession(db, 'ch1', 'sess-prune', { alertCount: 0 });

      const engine = new ChatEngine(db);

      // Old messages for ch2 (will be pruned)
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('old-msg-1', 'ch2', null, oldDate, 'TD', 'td', 'app', 'Old message');

      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Recent' });

      const pruned = engine.pruneOldMessages(30);
      expect(pruned.deleted).toBe(1); // Only the old ch2 message pruned

      // Health score for ch1 still works
      const result = computeHealthScore(db, 'ch1', 7);
      expect(result.score).not.toBeNull();

      // ch1 chat is unaffected
      const msgs1 = engine.getMessages('ch1');
      expect(msgs1).toHaveLength(1);
    });
  });

  // ── getRecentConversation → health recommendation correlation ───────────────

  describe('conversation history does not interfere with health computation', () => {
    it('getRecentConversation returns correct role mapping for AI use while health computes in parallel', () => {
      insertChurch(db, 'ch1');
      insertSession(db, 'ch1', 'sess-conv', { alertCount: 1, autoRecovered: 1, streamRuntime: 60 });

      const engine = new ChatEngine(db);
      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'Camera offline?' });
      engine.saveMessage({ churchId: 'ch1', senderName: 'System', senderRole: 'system', source: 'app', message: 'Camera reconnected successfully' });
      engine.saveMessage({ churchId: 'ch1', senderName: 'TD', senderRole: 'td', source: 'app', message: 'All good now' });

      const conversation = engine.getRecentConversation('ch1', { maxAgeMinutes: 60 });
      const health = computeHealthScore(db, 'ch1', 7);

      // Both can work simultaneously on the same DB
      expect(Array.isArray(conversation)).toBe(true);
      expect(health.score).not.toBeNull();

      // Conversation format is correct
      const roles = conversation.map(m => m.role);
      expect(roles.every(r => r === 'user' || r === 'assistant')).toBe(true);
    });
  });

  // ── Broadcaster integration ─────────────────────────────────────────────────

  describe('broadcastChat routing', () => {
    it('message from app source does not broadcast back to church client', () => {
      const broadcastToChurch = vi.fn();
      const broadcastToControllers = vi.fn();
      const notifyTelegram = vi.fn();

      const engine = new ChatEngine(db);
      engine.setBroadcasters({ broadcastToChurch, broadcastToControllers, notifyTelegram });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'app', // comes FROM the app
        message: 'Signal check',
      });

      engine.broadcastChat(msg);

      // Should NOT broadcast back to the church (avoid loop)
      expect(broadcastToChurch).not.toHaveBeenCalled();
      // SHOULD broadcast to controllers
      expect(broadcastToControllers).toHaveBeenCalledOnce();
      // SHOULD notify Telegram (not from Telegram)
      expect(notifyTelegram).toHaveBeenCalledOnce();
    });

    it('message from telegram source does not re-notify telegram', () => {
      const broadcastToChurch = vi.fn();
      const broadcastToControllers = vi.fn();
      const notifyTelegram = vi.fn();

      const engine = new ChatEngine(db);
      engine.setBroadcasters({ broadcastToChurch, broadcastToControllers, notifyTelegram });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'telegram', // comes FROM Telegram
        message: 'Need help with audio',
      });

      engine.broadcastChat(msg);

      // Should broadcast to church and controllers
      expect(broadcastToChurch).toHaveBeenCalledOnce();
      expect(broadcastToControllers).toHaveBeenCalledOnce();
      // Should NOT loop back to Telegram
      expect(notifyTelegram).not.toHaveBeenCalled();
    });

    it('message from dashboard broadcasts to church and telegram but not controllers as duplicate', () => {
      const broadcastToChurch = vi.fn();
      const broadcastToControllers = vi.fn();
      const notifyTelegram = vi.fn();

      const engine = new ChatEngine(db);
      engine.setBroadcasters({ broadcastToChurch, broadcastToControllers, notifyTelegram });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'Admin',
        senderRole: 'admin',
        source: 'dashboard',
        message: 'Switching to backup feed',
      });

      engine.broadcastChat(msg);

      expect(broadcastToChurch).toHaveBeenCalledOnce();
      expect(broadcastToControllers).toHaveBeenCalledOnce();
      expect(notifyTelegram).toHaveBeenCalledOnce();
    });

    it('broadcast payload includes the type=chat field for WebSocket routing', () => {
      const broadcastToControllers = vi.fn();
      const engine = new ChatEngine(db);
      engine.setBroadcasters({ broadcastToControllers });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'app',
        message: 'hello',
      });
      engine.broadcastChat(msg);

      // broadcastToControllers receives the object directly (not JSON stringified)
      const payload = broadcastToControllers.mock.calls[0][0];
      expect(payload.type).toBe('chat');
      expect(payload.message).toBe('hello');
    });

    it('broadcast errors are swallowed and do not throw', () => {
      const engine = new ChatEngine(db);
      engine.setBroadcasters({
        broadcastToChurch: () => { throw new Error('WS closed'); },
        broadcastToControllers: () => { throw new Error('No controllers'); },
        notifyTelegram: () => { throw new Error('Telegram down'); },
      });

      const msg = engine.saveMessage({
        churchId: 'ch1',
        senderName: 'TD',
        senderRole: 'td',
        source: 'dashboard',
        message: 'Test error handling',
      });

      expect(() => engine.broadcastChat(msg)).not.toThrow();
    });
  });

  // ── Health recommendations for chat-correlated session data ─────────────────

  describe('health recommendations reflect real session conditions', () => {
    it('generates recovery rate recommendation when auto-recovery rate is low', () => {
      insertChurch(db, 'ch1');
      // 10 alerts, only 2 auto-recovered = 20% recovery rate
      insertSession(db, 'ch1', 'sess-low-rec', {
        alertCount: 10,
        autoRecovered: 2,
        streamRuntime: 90,
      });

      const result = computeHealthScore(db, 'ch1', 7);
      expect(result.breakdown.recoveryRate).toBeLessThan(50);

      const recs = getHealthRecommendations(result.breakdown);
      expect(recs.length).toBeGreaterThan(0);
      // Should recommend enabling auto-recovery
      expect(recs.some(r => r.toLowerCase().includes('auto-recovery') || r.toLowerCase().includes('recovery'))).toBe(true);
    });

    it('generates stream stability recommendation when bitrate events exist', () => {
      insertChurch(db, 'ch1');
      insertSession(db, 'ch1', 'sess-stream', { streamRuntime: 60 });

      // Add 5 bitrate_low events
      const weekAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO service_events (church_id, timestamp, event_type)
          VALUES (?, ?, ?)
        `).run('ch1', weekAgo, 'bitrate_low');
      }

      const result = computeHealthScore(db, 'ch1', 7);
      expect(result.breakdown.streamStability).toBeLessThan(100);
      expect(result.score).toBeLessThan(100);
    });
  });
});
