import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { computeHealthScore, getHealthTrend, getHealthRecommendations, WEIGHTS } from '../src/healthScore.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
      duration_minutes INTEGER,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      recording_confirmed INTEGER DEFAULT 0,
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

function addChurch(db, churchId = 'church-1', name = 'Test Church') {
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run(churchId, name);
}

function addSession(db, churchId, opts = {}) {
  const id = opts.id || `session-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const endedAt = opts.ended !== false ? new Date(startedAt.getTime() + (opts.durationMinutes || 90) * 60000) : null;

  db.prepare(`
    INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes,
      stream_ran, stream_runtime_minutes, alert_count, auto_recovered_count, escalated_count, grade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, churchId, startedAt.toISOString(), endedAt?.toISOString() || null,
    opts.durationMinutes || 90,
    opts.streamRan ?? 1, opts.streamRuntimeMinutes ?? 85,
    opts.alertCount ?? 0, opts.autoRecoveredCount ?? 0, opts.escalatedCount ?? 0,
    opts.grade || null
  );
  return { id, startedAt, endedAt };
}

function addAlert(db, churchId, opts = {}) {
  const id = opts.id || `alert-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, churchId, opts.alertType || 'stream_stopped', opts.severity || 'CRITICAL', createdAt.toISOString());
  return id;
}

function addServiceEvent(db, churchId, opts = {}) {
  const daysAgo = opts.daysAgo ?? 1;
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO service_events (church_id, timestamp, event_type, resolved, auto_resolved)
    VALUES (?, ?, ?, ?, ?)
  `).run(churchId, timestamp.toISOString(), opts.eventType || 'stream_stopped',
    opts.resolved ?? 0, opts.autoResolved ?? 0);
}

function addPreServiceCheck(db, churchId, opts = {}) {
  const id = `check-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO preservice_check_results (id, church_id, pass, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, churchId, opts.pass ? 1 : 0, createdAt.toISOString());
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe('computeHealthScore', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns null score when no data exists', () => {
    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBeNull();
    expect(result.status).toBe('new');
    expect(result.message).toBe('Not enough data yet');
    expect(result.breakdown.uptime).toBeNull();
    expect(result.breakdown.alertRate).toBeNull();
    expect(result.breakdown.recoveryRate).toBeNull();
    expect(result.breakdown.preServicePassRate).toBeNull();
    expect(result.breakdown.streamStability).toBeNull();
    expect(result.trend).toBe('stable');
    expect(result.recommendations).toEqual([]);
  });

  it('returns correct structure with all required fields', () => {
    // Add a session so we get actual scores (not null for new church)
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 0 });
    const result = computeHealthScore(db, 'church-1');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('breakdown');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('recommendations');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(['improving', 'stable', 'declining']).toContain(result.trend);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });

  it('returns a perfect score for clean sessions with no alerts', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 0 });
    addSession(db, 'church-1', { daysAgo: 3, durationMinutes: 90, alertCount: 0 });

    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBe(100);
  });

  it('reduces score when there are unresolved critical events', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 3, autoRecoveredCount: 0 });
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'atem_disconnected', resolved: 0 });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'WARNING' });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });

    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBeLessThan(100);
    expect(result.breakdown.uptime).toBeLessThan(100);
  });

  it('alert rate sub-score decreases with more alerts per hour', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 5 });
    // 5 non-INFO alerts in 1 hour = 5 alerts/hr => score = 100 - 100 = 0
    for (let i = 0; i < 5; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.alertRate).toBeLessThan(50);
  });

  it('INFO alerts are excluded from alert rate', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 3 });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'INFO' });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'INFO' });
    addAlert(db, 'church-1', { daysAgo: 1, severity: 'INFO' });

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.alertRate).toBe(100);
  });

  it('recovery rate reflects auto-recovered proportion', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 4, autoRecoveredCount: 2 });

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.recoveryRate).toBe(50);
  });

  it('recovery rate is 100 when all alerts are auto-recovered', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 3, autoRecoveredCount: 3 });

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.recoveryRate).toBe(100);
  });

  it('pre-service pass rate computed correctly', () => {
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 2, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 3, pass: false });

    const result = computeHealthScore(db, 'church-1');
    // 2/3 = 66.7%
    expect(result.breakdown.preServicePassRate).toBeCloseTo(66.7, 0);
  });

  it('pre-service pass rate is null with no checks', () => {
    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.preServicePassRate).toBeNull();
  });

  it('stream stability decreases with quality events', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 120, streamRuntimeMinutes: 100 });
    // 3 bitrate_low events in ~1.67 hours of streaming
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'bitrate_low' });
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'bitrate_low' });
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'fps_low' });

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.streamStability).toBeLessThan(100);
  });

  it('stream stability is null when no streaming happened', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, streamRan: 0, streamRuntimeMinutes: 0 });

    const result = computeHealthScore(db, 'church-1');
    expect(result.breakdown.streamStability).toBeNull();
  });

  it('score is bounded between 0 and 100', () => {
    // Extreme case: lots of issues
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 30, alertCount: 20, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 20; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }
    for (let i = 0; i < 5; i++) {
      addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('respects the days parameter', () => {
    // Session 20 days ago (outside default 7-day window)
    addSession(db, 'church-1', { daysAgo: 20, durationMinutes: 60, alertCount: 10, autoRecoveredCount: 0 });
    for (let i = 0; i < 10; i++) {
      addAlert(db, 'church-1', { daysAgo: 20, severity: 'CRITICAL' });
    }

    // Default 7-day window should not see it — returns null (no data)
    const result7 = computeHealthScore(db, 'church-1', 7);
    expect(result7.score).toBeNull();

    // 30-day window should see it and produce an actual score
    const result30 = computeHealthScore(db, 'church-1', 30);
    expect(result30.score).not.toBeNull();
    expect(result30.score).toBeLessThan(100);
  });

  it('only counts data for the specified church', () => {
    addChurch(db, 'church-2', 'Other Church');
    addSession(db, 'church-2', { daysAgo: 1, durationMinutes: 60, alertCount: 10, autoRecoveredCount: 0 });
    for (let i = 0; i < 10; i++) {
      addAlert(db, 'church-2', { daysAgo: 1, severity: 'CRITICAL' });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBeNull(); // church-1 has no data
  });
});

// ─── Weights Validation ───────────────────────────────────────────────────────

describe('WEIGHTS', () => {
  it('weights sum to 1.0', () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('has all five expected categories', () => {
    expect(Object.keys(WEIGHTS)).toEqual(
      expect.arrayContaining(['uptime', 'alertRate', 'recoveryRate', 'preServicePassRate', 'streamStability'])
    );
  });
});

// ─── getHealthTrend ───────────────────────────────────────────────────────────

describe('getHealthTrend', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns weekly scores for the specified number of weeks', () => {
    const result = getHealthTrend(db, 'church-1', 4);
    expect(result.weeks).toHaveLength(4);
    expect(result).toHaveProperty('trend');
    expect(['improving', 'stable', 'declining']).toContain(result.trend);
  });

  it('each week entry has weekStart, score, and breakdown', () => {
    // Add sessions so we get actual scores
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 0 });
    addSession(db, 'church-1', { daysAgo: 8, durationMinutes: 90, alertCount: 0 });
    const result = getHealthTrend(db, 'church-1', 2);
    for (const week of result.weeks) {
      expect(week).toHaveProperty('weekStart');
      expect(week).toHaveProperty('score');
      expect(week).toHaveProperty('breakdown');
      if (week.score !== null) {
        expect(typeof week.score).toBe('number');
        expect(week.score).toBeGreaterThanOrEqual(0);
        expect(week.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('detects improving trend when recent weeks have fewer alerts', () => {
    // Older week: lots of alerts
    addSession(db, 'church-1', { daysAgo: 21, durationMinutes: 60, alertCount: 10, autoRecoveredCount: 0 });
    for (let i = 0; i < 10; i++) {
      addAlert(db, 'church-1', { daysAgo: 21, severity: 'CRITICAL' });
    }

    // Recent week: clean
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 0 });

    const result = getHealthTrend(db, 'church-1', 4);
    // Trend should be improving or stable (recent is better)
    expect(['improving', 'stable']).toContain(result.trend);
  });

  it('returns stable when no data exists', () => {
    const result = getHealthTrend(db, 'church-1', 4);
    expect(result.trend).toBe('stable');
    // All weeks should be null (no data)
    for (const week of result.weeks) {
      expect(week.score).toBeNull();
    }
  });

  it('returns correct number of weeks with custom parameter', () => {
    const result = getHealthTrend(db, 'church-1', 8);
    expect(result.weeks).toHaveLength(8);
  });
});

// ─── getHealthRecommendations ─────────────────────────────────────────────────

describe('getHealthRecommendations', () => {
  it('returns no recommendations for perfect scores', () => {
    const breakdown = {
      uptime: 100,
      alertRate: 100,
      recoveryRate: 100,
      preServicePassRate: 100,
      streamStability: 100,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs).toEqual([]);
  });

  it('returns recommendations for low uptime', () => {
    const breakdown = {
      uptime: 60,
      alertRate: 100,
      recoveryRate: 100,
      preServicePassRate: 100,
      streamStability: 100,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toContain('offline');
  });

  it('returns recommendations for low alert rate score', () => {
    const breakdown = {
      uptime: 100,
      alertRate: 40,
      recoveryRate: 100,
      preServicePassRate: 100,
      streamStability: 100,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toMatch(/alert|equipment|internet/i);
  });

  it('returns recommendations for low recovery rate', () => {
    const breakdown = {
      uptime: 100,
      alertRate: 100,
      recoveryRate: 40,
      preServicePassRate: 100,
      streamStability: 100,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toMatch(/manual|auto-recovery/i);
  });

  it('returns recommendations for low pre-service pass rate', () => {
    const breakdown = {
      uptime: 100,
      alertRate: 100,
      recoveryRate: 100,
      preServicePassRate: 40,
      streamStability: 100,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toMatch(/pre-service|checklist|equipment/i);
  });

  it('returns recommendations for low stream stability', () => {
    const breakdown = {
      uptime: 100,
      alertRate: 100,
      recoveryRate: 100,
      preServicePassRate: 100,
      streamStability: 40,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0]).toMatch(/bitrate|upload|internet/i);
  });

  it('returns at most 3 recommendations', () => {
    const breakdown = {
      uptime: 30,
      alertRate: 30,
      recoveryRate: 30,
      preServicePassRate: 30,
      streamStability: 30,
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeLessThanOrEqual(3);
  });

  it('prioritizes the lowest sub-scores first', () => {
    const breakdown = {
      uptime: 95,          // only minor issue
      alertRate: 95,
      recoveryRate: 95,
      preServicePassRate: 95,
      streamStability: 30,  // worst by far
    };
    const recs = getHealthRecommendations(breakdown);
    expect(recs.length).toBeGreaterThan(0);
    // First recommendation should be about stream stability (lowest score)
    expect(recs[0]).toMatch(/bitrate|upload|internet|stream/i);
  });
});

// ─── Integration: End-to-end scoring ──────────────────────────────────────────

describe('End-to-end scoring', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('computes a realistic mid-range score for a church with mixed results', () => {
    // 2 sessions: one clean, one problematic
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 0, streamRuntimeMinutes: 85 });
    addSession(db, 'church-1', { daysAgo: 3, durationMinutes: 90, alertCount: 4, autoRecoveredCount: 2, streamRuntimeMinutes: 80 });

    // Some alerts
    addAlert(db, 'church-1', { daysAgo: 3, severity: 'CRITICAL' });
    addAlert(db, 'church-1', { daysAgo: 3, severity: 'WARNING' });

    // Some events (1 unresolved)
    addServiceEvent(db, 'church-1', { daysAgo: 3, eventType: 'stream_stopped', resolved: 0 });
    addServiceEvent(db, 'church-1', { daysAgo: 3, eventType: 'bitrate_low', resolved: 1 });

    // Pre-service checks: 2 pass, 1 fail
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 3, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 5, pass: false });

    const result = computeHealthScore(db, 'church-1');
    expect(result.score).toBeGreaterThan(40);
    expect(result.score).toBeLessThan(100);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('handles a church with no sessions gracefully', () => {
    const result = computeHealthScore(db, 'nonexistent-church');
    expect(result.score).toBeNull();
    expect(result.status).toBe('new');
    expect(result.trend).toBe('stable');
  });

  it('trend works through getHealthTrend with real data', () => {
    // Add data across multiple weeks
    addSession(db, 'church-1', { daysAgo: 2, durationMinutes: 90, alertCount: 0 });
    addSession(db, 'church-1', { daysAgo: 9, durationMinutes: 90, alertCount: 2, autoRecoveredCount: 1 });
    addSession(db, 'church-1', { daysAgo: 16, durationMinutes: 90, alertCount: 5, autoRecoveredCount: 1 });

    const trend = getHealthTrend(db, 'church-1', 4);
    expect(trend.weeks).toHaveLength(4);
    // Filter to weeks with actual scores (non-null) for comparison
    const withScores = trend.weeks.filter(w => w.score !== null);
    if (withScores.length >= 2) {
      // most recent should be >= oldest (trend improving or stable)
      expect(withScores[withScores.length - 1].score).toBeGreaterThanOrEqual(
        withScores[0].score
      );
    }
  });
});

// ─── Realistic data volumes ────────────────────────────────────────────────────

describe('Realistic data volumes', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('handles 100+ sessions without error', () => {
    for (let i = 0; i < 120; i++) {
      addSession(db, 'church-1', {
        daysAgo: (i % 7) + 1,
        durationMinutes: 60 + (i % 60),
        alertCount: i % 5,
        autoRecoveredCount: i % 3,
        streamRuntimeMinutes: 50 + (i % 40),
      });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.breakdown).toBeDefined();
  });

  it('handles 500+ alerts without error', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 600, alertCount: 500 });

    for (let i = 0; i < 500; i++) {
      addAlert(db, 'church-1', {
        daysAgo: (i % 6) + 1,
        severity: i % 3 === 0 ? 'CRITICAL' : 'WARNING',
        alertType: i % 2 === 0 ? 'stream_stopped' : 'bitrate_low',
      });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.breakdown.alertRate).toBeLessThan(50);
  });

  it('handles many service events without error', () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 120, streamRuntimeMinutes: 100 });

    for (let i = 0; i < 200; i++) {
      addServiceEvent(db, 'church-1', {
        daysAgo: (i % 6) + 1,
        eventType: ['bitrate_low', 'fps_low', 'stream_stopped'][i % 3],
        resolved: i % 2,
      });
    }

    const result = computeHealthScore(db, 'church-1');
    expect(typeof result.score).toBe('number');
    expect(result.breakdown.streamStability).toBeLessThan(50);
  });
});

// ─── Score stability (determinism) ──────────────────────────────────────────────

describe('Score stability (determinism)', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('same data produces same score every time', () => {
    addSession(db, 'church-1', { daysAgo: 2, durationMinutes: 90, alertCount: 3, autoRecoveredCount: 1, streamRuntimeMinutes: 80 });
    addAlert(db, 'church-1', { daysAgo: 2, severity: 'CRITICAL' });
    addAlert(db, 'church-1', { daysAgo: 2, severity: 'WARNING' });
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'stream_stopped', resolved: 0 });
    addPreServiceCheck(db, 'church-1', { daysAgo: 2, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 2, pass: false });

    const result1 = computeHealthScore(db, 'church-1');
    const result2 = computeHealthScore(db, 'church-1');
    const result3 = computeHealthScore(db, 'church-1');

    expect(result1.score).toBe(result2.score);
    expect(result2.score).toBe(result3.score);
    expect(result1.breakdown).toEqual(result2.breakdown);
    expect(result2.breakdown).toEqual(result3.breakdown);
  });

  it('getHealthTrend produces same results on repeated calls', () => {
    addSession(db, 'church-1', { daysAgo: 2, durationMinutes: 90, alertCount: 0 });
    addSession(db, 'church-1', { daysAgo: 10, durationMinutes: 90, alertCount: 5, autoRecoveredCount: 2 });

    const t1 = getHealthTrend(db, 'church-1', 4);
    const t2 = getHealthTrend(db, 'church-1', 4);

    expect(t1.trend).toBe(t2.trend);
    for (let i = 0; i < t1.weeks.length; i++) {
      expect(t1.weeks[i].score).toBe(t2.weeks[i].score);
    }
  });
});

// ─── SQL injection safety ───────────────────────────────────────────────────────

describe('SQL injection safety', () => {
  let db;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('handles churchId with SQL injection characters safely', () => {
    const maliciousId = "'; DROP TABLE churches; --";
    // Should not throw, should return null (no data)
    const result = computeHealthScore(db, maliciousId);
    expect(result.score).toBeNull();
  });

  it('handles churchId with special characters', () => {
    const result = computeHealthScore(db, 'church-<script>alert(1)</script>');
    expect(result.score).toBeNull();
  });
});
