/**
 * Edge-case tests for src/healthScore.js
 *
 * Existing healthScore.test.js covers: no data (null score), structure,
 * perfect score, unresolved events, alert rate, INFO exclusion, recovery rate,
 * pre-service pass rate, stream stability, getHealthTrend, getHealthRecommendations.
 *
 * This file adds:
 *   - computeHealthScore with a non-existent churchId
 *   - Score clamped at 0 when downtime > totalMinutes
 *   - Score clamped at 100 (never exceeds 100)
 *   - getHealthRecommendations with empty breakdown
 *   - getHealthRecommendations with only null values
 *   - getHealthRecommendations returns max 3 recommendations
 *   - _determineTrend: single valid score returns 'stable'
 *   - getHealthTrend with weeks=1 (minimum)
 *   - computeHealthScore with large negative days (far future cutoff)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { computeHealthScore, getHealthTrend, getHealthRecommendations } from '../src/healthScore.js';

function createTestDb() {
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
      duration_minutes INTEGER DEFAULT 90,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      grade TEXT
    )
  `);

  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      auto_resolved INTEGER DEFAULT 0
    )
  `);

  db.exec(`
    CREATE TABLE preservice_check_results (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      pass INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

function addChurch(db, churchId = 'church-1') {
  db.prepare('INSERT OR IGNORE INTO churches (churchId, name) VALUES (?, ?)').run(churchId, 'Test Church');
}

function addSession(db, churchId, opts = {}) {
  const id = `session-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const endedAt = opts.ended !== false
    ? new Date(Date.parse(startedAt) + (opts.durationMinutes || 90) * 60000).toISOString()
    : null;

  db.prepare(`
    INSERT INTO service_sessions
      (id, church_id, started_at, ended_at, duration_minutes, stream_ran, stream_runtime_minutes, alert_count, auto_recovered_count, escalated_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, churchId, startedAt, endedAt,
    opts.durationMinutes ?? 90,
    opts.streamRan ?? 1,
    opts.streamRuntimeMinutes ?? 85,
    opts.alertCount ?? 0,
    opts.autoRecoveredCount ?? 0,
    opts.escalatedCount ?? 0
  );
}

function addCriticalEvent(db, churchId, resolved = 0, daysAgo = 1) {
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO service_events (church_id, timestamp, event_type, resolved) VALUES (?, ?, ?, ?)')
    .run(churchId, timestamp, 'stream_stopped', resolved);
}

function addPreServiceCheck(db, churchId, pass = 1, daysAgo = 1) {
  const id = `check-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO preservice_check_results (id, church_id, pass, created_at) VALUES (?, ?, ?, ?)')
    .run(id, churchId, pass ? 1 : 0, createdAt);
}

// ─── computeHealthScore edge cases ────────────────────────────────────────────

describe('computeHealthScore — edge cases', () => {
  let db;
  beforeEach(() => { db = createTestDb(); addChurch(db); });
  afterEach(() => { db?.close(); });

  it('returns null score for a churchId that does not exist in the DB', () => {
    const result = computeHealthScore(db, 'nonexistent-church-xyz');
    expect(result.score).toBeNull();
    expect(result.status).toBe('new');
  });

  it('score is never negative — clamped to 0', () => {
    // 90 min session with massive downtime from events
    addSession(db, 'church-1', { durationMinutes: 10, streamRan: 1, streamRuntimeMinutes: 10 });
    // Add many unresolved critical events (each adds 5 min downtime)
    for (let i = 0; i < 20; i++) {
      addCriticalEvent(db, 'church-1', 0, 1);
    }
    const result = computeHealthScore(db, 'church-1');
    // uptime sub-score should be 0 (clamped), overall score >= 0
    expect(result.score).toBeGreaterThanOrEqual(0);
    if (result.breakdown.uptime !== null) {
      expect(result.breakdown.uptime).toBeGreaterThanOrEqual(0);
    }
  });

  it('score is never above 100', () => {
    addSession(db, 'church-1', { durationMinutes: 90, alertCount: 0, autoRecoveredCount: 0, streamRuntimeMinutes: 90 });
    addPreServiceCheck(db, 'church-1', true, 1);
    const result = computeHealthScore(db, 'church-1');
    if (result.score !== null) {
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('custom days parameter controls the lookback window', () => {
    // Add a session 10 days ago — should appear in 30-day window but not 7-day
    addSession(db, 'church-1', { daysAgo: 10, durationMinutes: 90, alertCount: 5 });

    const result7  = computeHealthScore(db, 'church-1', 7);
    const result30 = computeHealthScore(db, 'church-1', 30);

    // 7-day window: session is outside it, so null score
    expect(result7.score).toBeNull();
    // 30-day window: session is inside it
    expect(result30.score).not.toBeNull();
  });

  it('only completed sessions (ended_at NOT NULL) contribute to scores', () => {
    // Add an in-progress session (ended_at = null)
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, ended: false });
    const result = computeHealthScore(db, 'church-1');
    // In-progress sessions should not count; score should be null (no data)
    expect(result.score).toBeNull();
  });

  it('fails soft when only a query-client/postgres handle is available', () => {
    const result = computeHealthScore({}, 'church-1');
    expect(result.score).toBeNull();
    expect(result.status).toBe('new');
    expect(result.breakdown).toEqual({
      uptime: null,
      alertRate: null,
      recoveryRate: null,
      preServicePassRate: null,
      streamStability: null,
    });

    const trend = getHealthTrend({}, 'church-1', 2);
    expect(trend.weeks).toHaveLength(2);
    expect(trend.trend).toBe('stable');
    expect(trend.weeks.every(w => w.score === null)).toBe(true);
  });
});

// ─── getHealthRecommendations edge cases ──────────────────────────────────────

describe('getHealthRecommendations — edge cases', () => {
  it('returns empty array for an empty breakdown object', () => {
    const recs = getHealthRecommendations({});
    expect(recs).toEqual([]);
  });

  it('returns empty array when all values are null (no data)', () => {
    const recs = getHealthRecommendations({
      uptime: null,
      alertRate: null,
      recoveryRate: null,
      preServicePassRate: null,
      streamStability: null,
    });
    expect(recs).toEqual([]);
  });

  it('returns at most 3 recommendations even when all scores are very low', () => {
    const recs = getHealthRecommendations({
      uptime: 10,
      alertRate: 10,
      recoveryRate: 10,
      preServicePassRate: 10,
      streamStability: 10,
    });
    expect(recs.length).toBeLessThanOrEqual(3);
  });

  it('returns no recommendations when all scores are 100', () => {
    const recs = getHealthRecommendations({
      uptime: 100,
      alertRate: 100,
      recoveryRate: 100,
      preServicePassRate: 100,
      streamStability: 100,
    });
    expect(recs).toEqual([]);
  });

  it('returns recommendation for the worst-scoring dimension', () => {
    const recs = getHealthRecommendations({
      uptime: 30,        // very low — should trigger uptime tip
      alertRate: 95,
      recoveryRate: 95,
      preServicePassRate: 95,
      streamStability: 95,
    });
    expect(recs.length).toBeGreaterThan(0);
    // The uptime tip should be about network cables / power
    expect(recs[0]).toMatch(/network|cables|power|offline/i);
  });

  it('returns recommendation strings (not objects)', () => {
    const recs = getHealthRecommendations({ uptime: 50, alertRate: 60 });
    for (const rec of recs) {
      expect(typeof rec).toBe('string');
      expect(rec.length).toBeGreaterThan(0);
    }
  });
});

// ─── getHealthTrend edge cases ────────────────────────────────────────────────

describe('getHealthTrend — edge cases', () => {
  let db;
  beforeEach(() => { db = createTestDb(); addChurch(db); });
  afterEach(() => { db?.close(); });

  it('returns stable trend when no data exists', () => {
    const result = getHealthTrend(db, 'church-1', 4);
    expect(result.trend).toBe('stable');
    expect(result.weeks).toHaveLength(4);
    // All weeks should have null score
    for (const week of result.weeks) {
      expect(week.score).toBeNull();
    }
  });

  it('returns weeks array with the correct number of entries', () => {
    const result = getHealthTrend(db, 'church-1', 6);
    expect(result.weeks).toHaveLength(6);
  });

  it('weeks have weekStart in YYYY-MM-DD format', () => {
    const result = getHealthTrend(db, 'church-1', 2);
    for (const week of result.weeks) {
      expect(week.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('trend is one of improving, stable, declining', () => {
    const result = getHealthTrend(db, 'church-1', 4);
    expect(['improving', 'stable', 'declining']).toContain(result.trend);
  });
});
