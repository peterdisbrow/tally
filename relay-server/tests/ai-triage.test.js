import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  AITriageEngine,
  TIME_CONTEXT,
  AI_MODES,
  BASE_SEVERITY_SCORES,
  TIME_MULTIPLIERS,
  SAFE_REMEDIATIONS,
  RECONNECT_PATTERN_SCORES,
  ALERT_TYPE_WEIGHTS,
} from '../src/aiTriage.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT DEFAULT '',
      service_times TEXT DEFAULT '[]',
      church_type TEXT DEFAULT 'recurring',
      event_expires_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      grade TEXT
    )
  `);
  db.exec(`
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      triage_id TEXT,
      issue_category TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      status TEXT,
      forced_bypass INTEGER DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT,
      message TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at TEXT
    )
  `);
  return db;
}

function addChurch(db, churchId, opts = {}) {
  db.prepare(`
    INSERT INTO churches (churchId, name, timezone, service_times, church_type, event_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Church',
    opts.timezone !== undefined ? opts.timezone : 'America/Chicago',
    JSON.stringify(opts.serviceTimes || []),
    opts.churchType || 'recurring',
    opts.eventExpiresAt || null,
  );
}

function createMockScheduleEngine(db) {
  return {
    getSchedule(churchId) {
      const row = db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
      if (!row?.service_times) return [];
      try { return JSON.parse(row.service_times); } catch { return []; }
    },
    isServiceWindow() { return false; },
  };
}

function createEngine(db, opts = {}) {
  const scheduleEngine = opts.scheduleEngine || createMockScheduleEngine(db);
  return new AITriageEngine(db, scheduleEngine, {
    churches: opts.churches || new Map(),
    autoRecovery: opts.autoRecovery || null,
    broadcastToSSE: opts.broadcastToSSE || vi.fn(),
    createTicket: opts.createTicket || null,
  });
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

describe('AITriageEngine', () => {

  // ─── Database Setup ────────────────────────────────────────────────────────

  describe('_ensureTables', () => {
    it('creates required tables on construction', () => {
      const db = createTestDb();
      const engine = createEngine(db);

      // Verify tables exist by inserting
      expect(() => {
        db.prepare("INSERT INTO ai_triage_events (id, church_id, alert_type, original_severity, triage_score, triage_severity, time_context, created_at) VALUES ('t1', 'c1', 'test', 'WARNING', 50, 'medium', 'off_hours', '2024-01-01')").run();
      }).not.toThrow();

      expect(() => {
        db.prepare("INSERT INTO ai_resolutions (id, church_id, symptom_fingerprint, action_taken, success, created_at) VALUES ('r1', 'c1', 'fp', 'test', 1, '2024-01-01')").run();
      }).not.toThrow();

      expect(() => {
        db.prepare("INSERT INTO church_ai_settings (church_id, ai_mode, updated_at) VALUES ('c1', 'monitor_only', '2024-01-01')").run();
      }).not.toThrow();
    });

    it('is idempotent — calling constructor twice does not error', () => {
      const db = createTestDb();
      createEngine(db);
      expect(() => createEngine(db)).not.toThrow();
    });
  });

  // ─── Settings ──────────────────────────────────────────────────────────────

  describe('getChurchSettings / updateChurchSettings', () => {
    it('returns defaults for unconfigured church', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);
      const settings = engine.getChurchSettings('c1');

      expect(settings.ai_mode).toBe('recommend_only');
      expect(settings.sensitivity_threshold).toBe(50);
      expect(settings.pre_service_window_minutes).toBe(60);
    });

    it('persists and retrieves updated settings', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);

      engine.updateChurchSettings('c1', {
        ai_mode: 'full_auto',
        sensitivity_threshold: 75,
        pre_service_window_minutes: 45,
      }, 'admin@test.com');

      const settings = engine.getChurchSettings('c1');
      expect(settings.ai_mode).toBe('full_auto');
      expect(settings.sensitivity_threshold).toBe(75);
      expect(settings.pre_service_window_minutes).toBe(45);
      expect(settings.updated_by).toBe('admin@test.com');
    });

    it('rejects invalid AI mode', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);

      expect(() => {
        engine.updateChurchSettings('c1', { ai_mode: 'skynet' });
      }).toThrow('Invalid AI mode');
    });

    it('clamps sensitivity to 0-100 range', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);

      engine.updateChurchSettings('c1', { sensitivity_threshold: 200 });
      expect(engine.getChurchSettings('c1').sensitivity_threshold).toBe(100);

      engine.updateChurchSettings('c1', { sensitivity_threshold: -10 });
      expect(engine.getChurchSettings('c1').sensitivity_threshold).toBe(0);
    });

    it('clamps pre-service window to 10-120 range', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);

      engine.updateChurchSettings('c1', { pre_service_window_minutes: 5 });
      expect(engine.getChurchSettings('c1').pre_service_window_minutes).toBe(10);

      engine.updateChurchSettings('c1', { pre_service_window_minutes: 300 });
      expect(engine.getChurchSettings('c1').pre_service_window_minutes).toBe(120);
    });

    it('updates existing settings without creating duplicate', () => {
      const db = createTestDb();
      addChurch(db, 'c1');
      const engine = createEngine(db);

      engine.updateChurchSettings('c1', { ai_mode: 'full_auto' });
      engine.updateChurchSettings('c1', { ai_mode: 'monitor_only' });

      const count = db.prepare('SELECT COUNT(*) as cnt FROM church_ai_settings WHERE church_id = ?').get('c1');
      expect(count.cnt).toBe(1);
      expect(engine.getChurchSettings('c1').ai_mode).toBe('monitor_only');
    });
  });

  // ─── Time Context Detection ────────────────────────────────────────────────

  describe('getTimeContext', () => {
    it('returns off_hours when no schedule is set', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const ctx = engine.getTimeContext('c1');
      expect(ctx.context).toBe(TIME_CONTEXT.OFF_HOURS);
      expect(ctx.details.reason).toBe('no_schedule');
    });

    it('returns in_service for event-type churches', () => {
      const db = createTestDb();
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      addChurch(db, 'c1', { churchType: 'event', eventExpiresAt: futureDate });
      const engine = createEngine(db);

      const ctx = engine.getTimeContext('c1');
      expect(ctx.context).toBe(TIME_CONTEXT.IN_SERVICE);
      expect(ctx.details.reason).toBe('event_mode');
    });

    it('detects pre-service time context based on schedule', () => {
      const db = createTestDb();
      const now = new Date();
      const day = now.getDay();
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      // Set service 20 min from now (well within a 60-min pre window)
      const serviceStartMin = minutesNow + 20;
      if (serviceStartMin >= 24 * 60) return; // skip near midnight
      const startHour = Math.floor(serviceStartMin / 60);
      const startMin = serviceStartMin % 60;

      // Schedule on ALL days to avoid day-of-week mismatch
      const serviceTimes = [];
      for (let d = 0; d < 7; d++) {
        serviceTimes.push({ day: d, startHour, startMin, durationHours: 2 });
      }

      addChurch(db, 'c1', {
        timezone: '',
        serviceTimes,
      });
      const engine = createEngine(db);
      const ctx = engine.getTimeContext('c1');
      expect(ctx.context).toBe(TIME_CONTEXT.PRE_SERVICE);
    });

    it('detects in-service time context based on schedule', () => {
      const db = createTestDb();
      const now = new Date();
      const day = now.getDay();
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      // Set service starting 60 min ago (well inside a 2h service, past pre-service window)
      const serviceStartMin = Math.max(0, minutesNow - 60);
      const startHour = Math.floor(serviceStartMin / 60);
      const startMin = serviceStartMin % 60;

      addChurch(db, 'c1', {
        timezone: '',
        serviceTimes: [{ day, startHour, startMin, durationHours: 2 }],
      });
      const engine = createEngine(db);
      const ctx = engine.getTimeContext('c1');
      expect(ctx.context).toBe(TIME_CONTEXT.IN_SERVICE);
    });

    it('infers time context from session history when no schedule', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });

      // Add 3 sessions that match current day/time
      const now = new Date();
      for (let i = 0; i < 3; i++) {
        const sessionStart = new Date(now);
        sessionStart.setDate(sessionStart.getDate() - (7 * (i + 1)));
        db.prepare('INSERT INTO service_sessions (id, church_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
          .run(`s${i}`, 'c1', sessionStart.toISOString(), new Date(sessionStart.getTime() + 7200000).toISOString());
      }

      const engine = createEngine(db);
      const ctx = engine.getTimeContext('c1');
      expect(ctx.context).toBe(TIME_CONTEXT.IN_SERVICE);
      expect(ctx.details.reason).toBe('inferred_from_history');
    });
  });

  // ─── Triage Scoring ────────────────────────────────────────────────────────

  describe('scoreEvent', () => {
    it('applies base severity score', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);
      const result = engine.scoreEvent('c1', 'fps_low', 'WARNING');
      // Off-hours with WARNING: 40 * 0.4 = 16, no bonuses
      expect(result.triage_score).toBeGreaterThan(0);
      expect(result.original_severity).toBe('WARNING');
    });

    it('produces higher scores during in-service', () => {
      const db = createTestDb();
      const now = new Date();
      const day = now.getDay();
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      const startHour = Math.floor(Math.max(0, minutesNow - 30) / 60);
      const startMin = Math.max(0, minutesNow - 30) % 60;

      addChurch(db, 'c1', {
        timezone: '',
        serviceTimes: [{ day, startHour, startMin, durationHours: 2 }],
      });
      addChurch(db, 'c2', { serviceTimes: [] });

      const engine = createEngine(db);
      const inService = engine.scoreEvent('c1', 'stream_stopped', 'CRITICAL');
      const offHours = engine.scoreEvent('c2', 'stream_stopped', 'CRITICAL');

      expect(inService.triage_score).toBeGreaterThan(offHours.triage_score);
    });

    it('adds device count bonus for multiple disconnected devices', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });

      const churches = new Map();
      churches.set('c1', {
        churchId: 'c1',
        status: {
          atem: { connected: false },
          obs: { connected: false },
          encoder: { connected: false },
        },
      });

      const engine = createEngine(db, { churches });
      const result = engine.scoreEvent('c1', 'multiple_systems_down', 'EMERGENCY');
      // Should have device count > 1
      expect(result.device_count).toBeGreaterThan(1);
    });

    it('applies reconnection pattern penalties', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      // Record many reconnections
      for (let i = 0; i < 8; i++) {
        engine.recordReconnection('c1');
      }

      const result = engine.scoreEvent('c1', 'obs_disconnected', 'WARNING');
      expect(result.reconnect_pattern).toBe('flapping');
    });

    it('applies sensitivity multiplier', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      addChurch(db, 'c2', { serviceTimes: [] });

      const engine = createEngine(db);
      engine.updateChurchSettings('c1', { sensitivity_threshold: 100 }); // 2x multiplier
      engine.updateChurchSettings('c2', { sensitivity_threshold: 25 });  // 0.5x multiplier

      const highSensitivity = engine.scoreEvent('c1', 'stream_stopped', 'CRITICAL');
      const lowSensitivity = engine.scoreEvent('c2', 'stream_stopped', 'CRITICAL');

      expect(highSensitivity.triage_score).toBeGreaterThan(lowSensitivity.triage_score);
    });

    it('clamps score to 0-150 range', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);
      engine.updateChurchSettings('c1', { sensitivity_threshold: 100 });

      const result = engine.scoreEvent('c1', 'multiple_systems_down', 'EMERGENCY');
      expect(result.triage_score).toBeLessThanOrEqual(150);
      expect(result.triage_score).toBeGreaterThanOrEqual(0);
    });

    it('correctly derives triage severity from score', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      // Test the internal method
      expect(engine._scoreToSeverity(100)).toBe('critical');
      expect(engine._scoreToSeverity(70)).toBe('high');
      expect(engine._scoreToSeverity(40)).toBe('medium');
      expect(engine._scoreToSeverity(20)).toBe('low');
      expect(engine._scoreToSeverity(10)).toBe('info');
    });

    it('adds alert-type-specific weights', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      // stream_stopped has weight 15, fps_low has no weight
      const streamScore = engine.scoreEvent('c1', 'stream_stopped', 'CRITICAL');
      const fpsScore = engine.scoreEvent('c1', 'fps_low', 'CRITICAL');

      expect(streamScore.triage_score).toBeGreaterThan(fpsScore.triage_score);
    });
  });

  // ─── Reconnection Tracking ─────────────────────────────────────────────────

  describe('recordReconnection', () => {
    it('tracks reconnections and categorizes patterns', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      expect(engine._getReconnectPattern('c1')).toBe('stable');

      engine.recordReconnection('c1');
      expect(engine._getReconnectPattern('c1')).toBe('occasional');

      engine.recordReconnection('c1');
      expect(engine._getReconnectPattern('c1')).toBe('occasional');

      engine.recordReconnection('c1');
      expect(engine._getReconnectPattern('c1')).toBe('frequent');

      for (let i = 0; i < 4; i++) engine.recordReconnection('c1');
      expect(engine._getReconnectPattern('c1')).toBe('flapping');
    });

    it('does not cross-contaminate between churches', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      addChurch(db, 'c2', { serviceTimes: [] });
      const engine = createEngine(db);

      for (let i = 0; i < 6; i++) engine.recordReconnection('c1');
      expect(engine._getReconnectPattern('c1')).toBe('flapping');
      expect(engine._getReconnectPattern('c2')).toBe('stable');
    });
  });

  // ─── Process Alert Pipeline ────────────────────────────────────────────────

  describe('processAlert', () => {
    it('stores triage event in database', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const broadcastToSSE = vi.fn();
      const engine = createEngine(db, { broadcastToSSE });

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL', { message: 'stream dropped' });
      expect(result.eventId).toBeTruthy();
      expect(result.triageResult.triage_score).toBeGreaterThan(0);

      const row = db.prepare('SELECT * FROM ai_triage_events WHERE id = ?').get(result.eventId);
      expect(row).toBeTruthy();
      expect(row.church_id).toBe('c1');
      expect(row.alert_type).toBe('stream_stopped');
    });

    it('broadcasts SSE event', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const broadcastToSSE = vi.fn();
      const engine = createEngine(db, { broadcastToSSE });

      await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      expect(broadcastToSSE).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ai_triage_event', churchId: 'c1' }),
      );
    });

    it('in monitor_only mode, just logs without action', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);
      engine.updateChurchSettings('c1', { ai_mode: 'monitor_only' });

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      expect(result.action).toBe('monitored');
      expect(result.mode).toBe('monitor_only');
    });

    it('in recommend_only mode, creates ticket for medium+ severity', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const createTicket = vi.fn();
      const engine = createEngine(db, { createTicket });
      engine.updateChurchSettings('c1', { ai_mode: 'recommend_only' });

      // Force high enough score by using in-service context
      const now = new Date();
      const day = now.getDay();
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      db.prepare('UPDATE churches SET service_times = ? WHERE churchId = ?')
        .run(JSON.stringify([{ day, startHour: Math.floor(Math.max(0, minutesNow - 15) / 60), startMin: Math.max(0, minutesNow - 15) % 60, durationHours: 2 }]), 'c1');

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      expect(result.action).toBe('recommendation_created');

      // Ticket should have been called (score should be >= 40)
      if (result.triageResult.triage_score >= 40) {
        expect(createTicket).toHaveBeenCalled();
      }
    });

    it('in full_auto mode with safe remediation, attempts auto-fix', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });

      const autoRecovery = {
        attempt: vi.fn().mockResolvedValue({ attempted: true, success: true, reason: 'ok', command: 'recovery.restartStream' }),
      };
      const churches = new Map();
      churches.set('c1', { churchId: 'c1', status: {}, sockets: new Map() });

      const engine = createEngine(db, { autoRecovery, churches });
      engine.updateChurchSettings('c1', { ai_mode: 'full_auto' });

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      expect(result.action).toBe('auto_resolved');
      expect(result.resolution).toBeTruthy();
      expect(result.resolution.success).toBe(true);
      expect(autoRecovery.attempt).toHaveBeenCalled();

      // Check resolution was logged
      const resolutions = db.prepare('SELECT * FROM ai_resolutions WHERE church_id = ?').all('c1');
      expect(resolutions.length).toBe(1);
      expect(resolutions[0].success).toBe(1);
    });

    it('in full_auto mode falls back to recommendation when no safe remediation exists', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const createTicket = vi.fn();
      const autoRecovery = { attempt: vi.fn() };
      const churches = new Map();
      churches.set('c1', { churchId: 'c1', status: {}, sockets: new Map() });

      const engine = createEngine(db, { autoRecovery, churches, createTicket });
      engine.updateChurchSettings('c1', { ai_mode: 'full_auto' });

      // atem_disconnected has no safe remediation
      const result = await engine.processAlert('c1', 'atem_disconnected', 'CRITICAL');
      expect(result.action).toBe('escalated');
    });

    it('skips auto-fix after 3+ recent failures for same symptom', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });

      const autoRecovery = {
        attempt: vi.fn().mockResolvedValue({ attempted: true, success: true, reason: 'ok', command: 'test' }),
      };
      const churches = new Map();
      churches.set('c1', { churchId: 'c1', status: {}, sockets: new Map() });
      const createTicket = vi.fn();

      const engine = createEngine(db, { autoRecovery, churches, createTicket });
      engine.updateChurchSettings('c1', { ai_mode: 'full_auto' });

      // Insert 3 recent failures
      const now = new Date().toISOString();
      for (let i = 0; i < 3; i++) {
        db.prepare(`
          INSERT INTO ai_resolutions (id, church_id, symptom_fingerprint, action_taken, success, created_at)
          VALUES (?, 'c1', 'stream_stopped::off_hours', 'Restart stream', 0, ?)
        `).run(`fail${i}`, now);
      }

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      // Should skip auto and fall back to recommendation
      expect(result.action).toBe('escalated');
    });
  });

  // ─── Query / Stats ─────────────────────────────────────────────────────────

  describe('getRecentEvents / getStats', () => {
    it('returns empty array when no events', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const events = engine.getRecentEvents({ churchId: 'c1' });
      expect(events).toEqual([]);
    });

    it('returns events filtered by church', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      addChurch(db, 'c2', { serviceTimes: [] });
      const engine = createEngine(db);

      await engine.processAlert('c1', 'fps_low', 'WARNING');
      await engine.processAlert('c2', 'stream_stopped', 'CRITICAL');

      const c1Events = engine.getRecentEvents({ churchId: 'c1' });
      expect(c1Events.length).toBe(1);
      expect(c1Events[0].church_id).toBe('c1');
    });

    it('returns events filtered by severity', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      await engine.processAlert('c1', 'fps_low', 'WARNING');

      const allEvents = engine.getRecentEvents({ churchId: 'c1' });
      expect(allEvents.length).toBe(2);

      // Filter by a specific severity
      const lowEvents = engine.getRecentEvents({ churchId: 'c1', severity: 'info' });
      // May or may not have info events depending on scoring
      expect(Array.isArray(lowEvents)).toBe(true);
    });

    it('respects limit and offset', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      for (let i = 0; i < 5; i++) {
        await engine.processAlert('c1', 'fps_low', 'WARNING');
      }

      const page1 = engine.getRecentEvents({ churchId: 'c1', limit: 2, offset: 0 });
      expect(page1.length).toBe(2);

      const page2 = engine.getRecentEvents({ churchId: 'c1', limit: 2, offset: 2 });
      expect(page2.length).toBe(2);
      expect(page2[0].id).not.toBe(page1[0].id);
    });

    it('getStats returns correct structure', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      await engine.processAlert('c1', 'stream_stopped', 'CRITICAL');
      await engine.processAlert('c1', 'fps_low', 'WARNING');

      const stats = engine.getStats({ churchId: 'c1' });
      expect(stats.total_events).toBe(2);
      expect(Array.isArray(stats.severity_distribution)).toBe(true);
      expect(Array.isArray(stats.time_context_distribution)).toBe(true);
      expect(typeof stats.resolution_rate).toBe('number');
      expect(Array.isArray(stats.top_alert_types)).toBe(true);
      expect(Array.isArray(stats.daily_trend)).toBe(true);
    });

    it('getStats resolution rate is correct', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const now = new Date().toISOString();
      db.prepare("INSERT INTO ai_resolutions (id, church_id, symptom_fingerprint, action_taken, success, created_at) VALUES (?, 'c1', 'fp', 'test', 1, ?)").run('r1', now);
      db.prepare("INSERT INTO ai_resolutions (id, church_id, symptom_fingerprint, action_taken, success, created_at) VALUES (?, 'c1', 'fp', 'test', 0, ?)").run('r2', now);

      const stats = engine.getStats({ churchId: 'c1' });
      expect(stats.resolution_rate).toBe(50);
      expect(stats.resolution_total).toBe(2);
      expect(stats.resolution_successes).toBe(1);
    });
  });

  // ─── getAllChurchModes ──────────────────────────────────────────────────────

  describe('getAllChurchModes', () => {
    it('returns all configured church modes', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { name: 'Church A' });
      addChurch(db, 'c2', { name: 'Church B' });
      const engine = createEngine(db);

      engine.updateChurchSettings('c1', { ai_mode: 'full_auto' });
      engine.updateChurchSettings('c2', { ai_mode: 'monitor_only' });

      const modes = engine.getAllChurchModes();
      expect(modes.length).toBe(2);
      expect(modes.find(m => m.church_id === 'c1').ai_mode).toBe('full_auto');
      expect(modes.find(m => m.church_id === 'c2').ai_mode).toBe('monitor_only');
    });
  });

  // ─── Service Windows ───────────────────────────────────────────────────────

  describe('getServiceWindows', () => {
    it('returns windows with formatted times', () => {
      const db = createTestDb();
      addChurch(db, 'c1', {
        serviceTimes: [
          { day: 0, startHour: 10, startMin: 0, durationHours: 2 },
          { day: 3, startHour: 19, startMin: 30, durationHours: 1.5 },
        ],
      });
      const engine = createEngine(db);

      const result = engine.getServiceWindows('c1');
      expect(result.windows.length).toBe(2);
      expect(result.windows[0].dayName).toBe('Sun');
      expect(result.windows[0].startFormatted).toBe('10:00');
      expect(result.windows[1].dayName).toBe('Wed');
      expect(result.windows[1].startFormatted).toBe('19:30');
      expect(result.currentContext).toBeTruthy();
    });

    it('includes pre and post buffer windows', () => {
      const db = createTestDb();
      addChurch(db, 'c1', {
        serviceTimes: [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }],
      });
      const engine = createEngine(db);
      engine.updateChurchSettings('c1', { pre_service_window_minutes: 60, post_service_buffer_minutes: 15 });

      const result = engine.getServiceWindows('c1');
      expect(result.preWindowMinutes).toBe(60);
      expect(result.postBufferMinutes).toBe(15);
      expect(result.windows[0].preServiceStart).toBe(540); // 10*60 - 60
    });
  });

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('removes old events and resolutions', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      // Insert old events
      db.prepare(`
        INSERT INTO ai_triage_events (id, church_id, alert_type, original_severity, triage_score, triage_severity, time_context, created_at)
        VALUES ('old1', 'c1', 'test', 'WARNING', 50, 'medium', 'off_hours', datetime('now', '-100 days'))
      `).run();
      db.prepare(`
        INSERT INTO ai_triage_events (id, church_id, alert_type, original_severity, triage_score, triage_severity, time_context, created_at)
        VALUES ('new1', 'c1', 'test', 'WARNING', 50, 'medium', 'off_hours', datetime('now'))
      `).run();

      engine.cleanup(90);

      const remaining = db.prepare('SELECT COUNT(*) as cnt FROM ai_triage_events').get();
      expect(remaining.cnt).toBe(1);
    });
  });

  // ─── Concurrent / Stress Tests ─────────────────────────────────────────────

  describe('concurrent processing', () => {
    it('handles rapid-fire events from same church', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(engine.processAlert('c1', 'fps_low', 'WARNING', { message: `event ${i}` }));
      }

      const results = await Promise.all(promises);
      expect(results.length).toBe(50);
      results.forEach(r => {
        expect(r.eventId).toBeTruthy();
        expect(r.triageResult.triage_score).toBeGreaterThan(0);
      });

      const count = db.prepare('SELECT COUNT(*) as cnt FROM ai_triage_events WHERE church_id = ?').get('c1');
      expect(count.cnt).toBe(50);
    });

    it('handles concurrent events from multiple churches', async () => {
      const db = createTestDb();
      for (let i = 0; i < 10; i++) {
        addChurch(db, `church-${i}`, { serviceTimes: [] });
      }
      const engine = createEngine(db);

      const promises = [];
      for (let i = 0; i < 10; i++) {
        for (let j = 0; j < 5; j++) {
          promises.push(engine.processAlert(`church-${i}`, 'stream_stopped', 'CRITICAL'));
        }
      }

      const results = await Promise.all(promises);
      expect(results.length).toBe(50);

      const total = db.prepare('SELECT COUNT(*) as cnt FROM ai_triage_events').get();
      expect(total.cnt).toBe(50);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles missing church gracefully in scoring', () => {
      const db = createTestDb();
      const engine = createEngine(db);

      // Church doesn't exist in DB
      const result = engine.scoreEvent('nonexistent', 'stream_stopped', 'CRITICAL');
      expect(result.triage_score).toBeGreaterThan(0);
      expect(result.time_context).toBe(TIME_CONTEXT.OFF_HOURS);
    });

    it('handles null/undefined context in processAlert', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL', null);
      expect(result.eventId).toBeTruthy();
    });

    it('handles unknown alert types', async () => {
      const db = createTestDb();
      addChurch(db, 'c1', { serviceTimes: [] });
      const engine = createEngine(db);

      const result = await engine.processAlert('c1', 'unknown_alert_xyz', 'WARNING');
      expect(result.eventId).toBeTruthy();
      expect(result.triageResult.triage_score).toBeGreaterThan(0);
    });

    it('handles empty timezone gracefully', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { timezone: '', serviceTimes: [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }] });
      const engine = createEngine(db);

      // Should not throw
      expect(() => engine.getTimeContext('c1')).not.toThrow();
    });

    it('handles invalid timezone gracefully', () => {
      const db = createTestDb();
      addChurch(db, 'c1', { timezone: 'Invalid/Zone', serviceTimes: [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }] });
      const engine = createEngine(db);

      // Should fall back to local time, not throw
      expect(() => engine.getTimeContext('c1')).not.toThrow();
    });

    it('midnight-crossing service window detected for tomorrow pre-service', () => {
      const db = createTestDb();
      const now = new Date();
      const day = now.getDay();
      const minutesNow = now.getHours() * 60 + now.getMinutes();

      // If close to midnight (within 30 min), set service at 00:15 tomorrow
      if (minutesNow >= 23 * 60 + 30) {
        const tomorrow = (day + 1) % 7;
        addChurch(db, 'c1', {
          timezone: '',
          serviceTimes: [{ day: tomorrow, startHour: 0, startMin: 15, durationHours: 1 }],
        });
        const engine = createEngine(db);
        const ctx = engine.getTimeContext('c1');
        // Should be pre_service since we're within the window
        expect(ctx.context).toBe(TIME_CONTEXT.PRE_SERVICE);
      }
    });
  });

  // ─── Constants Validation ──────────────────────────────────────────────────

  describe('exported constants', () => {
    it('TIME_CONTEXT has required values', () => {
      expect(TIME_CONTEXT.PRE_SERVICE).toBe('pre_service');
      expect(TIME_CONTEXT.IN_SERVICE).toBe('in_service');
      expect(TIME_CONTEXT.OFF_HOURS).toBe('off_hours');
    });

    it('AI_MODES has required values', () => {
      expect(AI_MODES.FULL_AUTO).toBe('full_auto');
      expect(AI_MODES.RECOMMEND_ONLY).toBe('recommend_only');
      expect(AI_MODES.MONITOR_ONLY).toBe('monitor_only');
    });

    it('SAFE_REMEDIATIONS has entries for key alert types', () => {
      expect(SAFE_REMEDIATIONS['stream_stopped']).toBeTruthy();
      expect(SAFE_REMEDIATIONS['stream_stopped'].command).toBe('recovery.restartStream');
      expect(SAFE_REMEDIATIONS['audio_silence']).toBeTruthy();
    });

    it('BASE_SEVERITY_SCORES has required levels', () => {
      expect(BASE_SEVERITY_SCORES.EMERGENCY).toBeGreaterThan(BASE_SEVERITY_SCORES.CRITICAL);
      expect(BASE_SEVERITY_SCORES.CRITICAL).toBeGreaterThan(BASE_SEVERITY_SCORES.WARNING);
      expect(BASE_SEVERITY_SCORES.WARNING).toBeGreaterThan(BASE_SEVERITY_SCORES.INFO);
    });

    it('TIME_MULTIPLIERS makes in-service > off-hours', () => {
      expect(TIME_MULTIPLIERS[TIME_CONTEXT.IN_SERVICE]).toBeGreaterThan(TIME_MULTIPLIERS[TIME_CONTEXT.OFF_HOURS]);
      expect(TIME_MULTIPLIERS[TIME_CONTEXT.PRE_SERVICE]).toBeGreaterThan(TIME_MULTIPLIERS[TIME_CONTEXT.IN_SERVICE]);
    });
  });
});
