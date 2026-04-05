import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  detectDrift,
  getServiceTimingStats,
  checkUpcomingConflicts,
  findMatchingWindow,
  LATE_START_THRESHOLD,
  EARLY_END_THRESHOLD,
  OVERTIME_THRESHOLD,
} from '../src/serviceWindowDrift.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service_times TEXT DEFAULT '[]'
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

  return db;
}

function addChurch(db, churchId = 'church-1', name = 'Test Church', schedule = []) {
  db.prepare('INSERT INTO churches (churchId, name, service_times) VALUES (?, ?, ?)')
    .run(churchId, name, JSON.stringify(schedule));
}

/** Build a Date for next occurrence of a given day/hour/min. */
function dateForDayTime(day, hour, min = 0, weeksAgo = 0) {
  const now = new Date();
  const currentDay = now.getDay();
  let daysUntil = (day - currentDay + 7) % 7;
  if (daysUntil === 0 && weeksAgo === 0) daysUntil = 0; // same day
  const d = new Date(now);
  d.setDate(d.getDate() + daysUntil - weeksAgo * 7);
  d.setHours(hour, min, 0, 0);
  return d;
}

function addSession(db, churchId, startedAt, endedAt, id) {
  const sid = id || `session-${Math.random().toString(36).slice(2, 8)}`;
  const duration = endedAt ? Math.round((endedAt - startedAt) / 60000) : null;
  db.prepare(`
    INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes)
    VALUES (?, ?, ?, ?, ?)
  `).run(sid, churchId, startedAt.toISOString(), endedAt ? endedAt.toISOString() : null, duration);
  return sid;
}

// ─── TESTS: detectDrift ───────────────────────────────────────────────────────

describe('detectDrift', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('returns no drifts for an on-time service', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 5); // 5 min late (under threshold)
    const endedAt = new Date(startedAt.getTime() + 80 * 60000); // 80 min

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts).toEqual([]);
  });

  // ── late_start ─────────────────────────────────────────────────────────────

  it('detects late_start when service starts >10 min after scheduled', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, 25); // 25 min late
    const endedAt = new Date(startedAt.getTime() + 90 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const lateStart = drifts.find(d => d.type === 'late_start');
    expect(lateStart).toBeDefined();
    expect(lateStart.deltaMinutes).toBe(25);
    expect(lateStart.severity).toBe('warning');
  });

  it('assigns critical severity for late_start >30 min', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, 45); // 45 min late
    const endedAt = new Date(startedAt.getTime() + 60 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const lateStart = drifts.find(d => d.type === 'late_start');
    expect(lateStart).toBeDefined();
    expect(lateStart.severity).toBe('critical');
    expect(lateStart.deltaMinutes).toBe(45);
  });

  it('does not flag late_start at exactly the threshold', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, LATE_START_THRESHOLD); // exactly at threshold
    const endedAt = new Date(startedAt.getTime() + 90 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.find(d => d.type === 'late_start')).toBeUndefined();
  });

  // ── early_end ──────────────────────────────────────────────────────────────

  it('detects early_end when service ends >15 min before scheduled end', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = dateForDayTime(0, 11, 30); // ends 30 min early

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const earlyEnd = drifts.find(d => d.type === 'early_end');
    expect(earlyEnd).toBeDefined();
    expect(earlyEnd.deltaMinutes).toBe(30);
    expect(earlyEnd.severity).toBe('info');
  });

  it('does not flag early_end within threshold', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = dateForDayTime(0, 11, 50); // 10 min early — under 15 threshold

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.find(d => d.type === 'early_end')).toBeUndefined();
  });

  // ── overtime ───────────────────────────────────────────────────────────────

  it('detects overtime when service runs >20 min past scheduled end', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = dateForDayTime(0, 11, 30); // 30 min past scheduled end (11:00)

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const overtime = drifts.find(d => d.type === 'overtime');
    expect(overtime).toBeDefined();
    expect(overtime.deltaMinutes).toBe(30);
    expect(overtime.severity).toBe('warning');
  });

  it('assigns critical severity for overtime >45 min', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = dateForDayTime(0, 11, 50); // 50 min overtime

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const overtime = drifts.find(d => d.type === 'overtime');
    expect(overtime).toBeDefined();
    expect(overtime.severity).toBe('critical');
  });

  it('does not flag overtime within threshold', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = dateForDayTime(0, 11, 15); // 15 min past — under 20 threshold

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.find(d => d.type === 'overtime')).toBeUndefined();
  });

  it('fails soft when only a query-client/postgres handle is available', () => {
    expect(detectDrift({}, 'church-1', { startedAt: new Date(), sessionId: 's1' })).toEqual({ drifts: [] });
    expect(getServiceTimingStats({}, 'church-1', 4)).toEqual({
      avgStartDelay: 0,
      avgDuration: 0,
      avgEndDelay: 0,
      onTimePercent: 100,
    });
    expect(checkUpcomingConflicts({}, 'church-1')).toEqual([]);
  });

  // ── overlap ────────────────────────────────────────────────────────────────

  it('detects overlap when a service starts before the previous one ended', () => {
    const schedule = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 1.5 },
      { day: 0, startHour: 11, startMin: 0, durationHours: 1.5 },
    ];
    addChurch(db, 'church-1', 'Test', schedule);

    const prev = {
      start: dateForDayTime(0, 9, 0),
      end: dateForDayTime(0, 11, 30), // ran until 11:30
    };
    addSession(db, 'church-1', prev.start, prev.end, 'prev-session');

    const currentStart = dateForDayTime(0, 11, 0); // started at 11:00 — before prev ended
    const currentEnd = dateForDayTime(0, 12, 30);

    const { drifts } = detectDrift(db, 'church-1', {
      startedAt: currentStart,
      endedAt: currentEnd,
      sessionId: 'current-session',
    });

    const overlap = drifts.find(d => d.type === 'overlap');
    expect(overlap).toBeDefined();
    expect(overlap.severity).toBe('critical');
    expect(overlap.deltaMinutes).toBe(30);
  });

  // ── unscheduled ────────────────────────────────────────────────────────────

  it('detects unscheduled service when schedule exists but no window matches', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    // Start on a different day than scheduled
    const differentDay = (new Date().getDay() + 3) % 7; // pick a day 3 away from today
    const startedAt = dateForDayTime(differentDay, 14, 0);
    const endedAt = new Date(startedAt.getTime() + 60 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    const unscheduled = drifts.find(d => d.type === 'unscheduled');
    expect(unscheduled).toBeDefined();
    expect(unscheduled.severity).toBe('warning');
    expect(unscheduled.scheduledTime).toBeNull();
  });

  it('does not flag unscheduled when church has no schedule at all', () => {
    addChurch(db, 'church-1', 'Test', []); // empty schedule

    const startedAt = new Date();
    const endedAt = new Date(startedAt.getTime() + 60 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts).toEqual([]);
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  it('handles session with no endedAt (still running)', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, 20); // 20 min late

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt: null, sessionId: 's1' });
    const lateStart = drifts.find(d => d.type === 'late_start');
    expect(lateStart).toBeDefined();
    expect(lateStart.deltaMinutes).toBe(20);
    // No early_end or overtime since session hasn't ended
    expect(drifts.find(d => d.type === 'early_end')).toBeUndefined();
    expect(drifts.find(d => d.type === 'overtime')).toBeUndefined();
  });

  it('handles string dates in currentSession', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, 25);
    const endedAt = new Date(startedAt.getTime() + 90 * 60000);

    const { drifts } = detectDrift(db, 'church-1', {
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      sessionId: 's1',
    });
    expect(drifts.find(d => d.type === 'late_start')).toBeDefined();
  });

  it('can detect multiple drift types simultaneously', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1 }];
    addChurch(db, 'church-1', 'Test', schedule);

    // 20 min late + 25 min overtime
    const startedAt = dateForDayTime(0, 10, 20);
    const endedAt = dateForDayTime(0, 11, 25); // scheduled end is 11:00

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.find(d => d.type === 'late_start')).toBeDefined();
    expect(drifts.find(d => d.type === 'overtime')).toBeDefined();
  });

  it('handles church not found gracefully', () => {
    const startedAt = new Date();
    const { drifts } = detectDrift(db, 'nonexistent', { startedAt, sessionId: 's1' });
    expect(drifts).toEqual([]);
  });
});

// ─── TESTS: findMatchingWindow ────────────────────────────────────────────────

describe('findMatchingWindow', () => {
  it('matches the closest window within buffer', () => {
    const schedule = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 1.5 },
      { day: 0, startHour: 11, startMin: 0, durationHours: 1.5 },
    ];
    const sessionStart = dateForDayTime(0, 9, 8); // 8 min after 9:00
    const result = findMatchingWindow(schedule, sessionStart);
    expect(result).not.toBeNull();
    expect(result.startHour).toBe(9);
  });

  it('returns null when no window matches', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 1 }];
    const sessionStart = dateForDayTime(1, 14, 0); // Monday 2pm — Sunday 9am scheduled
    const result = findMatchingWindow(schedule, sessionStart);
    expect(result).toBeNull();
  });

  it('returns null when session is more than 60 min from any window', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 1 }];
    const sessionStart = dateForDayTime(0, 11, 0); // 2 hours later
    const result = findMatchingWindow(schedule, sessionStart);
    expect(result).toBeNull();
  });
});

// ─── TESTS: getServiceTimingStats ─────────────────────────────────────────────

describe('getServiceTimingStats', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('returns defaults when no sessions exist', () => {
    addChurch(db, 'church-1', 'Test', [{ day: 0, startHour: 10, startMin: 0, durationHours: 1.5 }]);

    const stats = getServiceTimingStats(db, 'church-1', 4);
    expect(stats).toEqual({ avgStartDelay: 0, avgDuration: 0, avgEndDelay: 0, onTimePercent: 100 });
  });

  it('computes correct average start delay', () => {
    const today = new Date().getDay();
    const schedule = [{ day: today, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    // Session 1: 5 min late (on time)
    const s1Start = dateForDayTime(today, 10, 5, 1);
    const s1End = new Date(s1Start.getTime() + 85 * 60000);
    addSession(db, 'church-1', s1Start, s1End);

    // Session 2: 15 min late
    const s2Start = dateForDayTime(today, 10, 15, 2);
    const s2End = new Date(s2Start.getTime() + 75 * 60000);
    addSession(db, 'church-1', s2Start, s2End);

    const stats = getServiceTimingStats(db, 'church-1', 4);
    expect(stats.avgStartDelay).toBe(10); // (5 + 15) / 2
    expect(stats.onTimePercent).toBe(50); // 1 of 2 on time
  });

  it('computes correct average duration', () => {
    const today = new Date().getDay();
    const schedule = [{ day: today, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const s1Start = dateForDayTime(today, 10, 0, 1);
    const s1End = new Date(s1Start.getTime() + 90 * 60000); // 90 min
    addSession(db, 'church-1', s1Start, s1End);

    const s2Start = dateForDayTime(today, 10, 0, 2);
    const s2End = new Date(s2Start.getTime() + 60 * 60000); // 60 min
    addSession(db, 'church-1', s2Start, s2End);

    const stats = getServiceTimingStats(db, 'church-1', 4);
    expect(stats.avgDuration).toBe(75); // (90 + 60) / 2
  });

  it('returns 100% on-time when all sessions start within threshold', () => {
    const today = new Date().getDay();
    const schedule = [{ day: today, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    for (let w = 1; w <= 3; w++) {
      const start = dateForDayTime(today, 10, 3, w); // 3 min late each time
      const end = new Date(start.getTime() + 85 * 60000);
      addSession(db, 'church-1', start, end);
    }

    const stats = getServiceTimingStats(db, 'church-1', 4);
    expect(stats.onTimePercent).toBe(100);
  });

  it('respects weeks parameter', () => {
    const today = new Date().getDay();
    const schedule = [{ day: today, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    // Session 6 weeks ago — outside 4 week window
    const oldStart = dateForDayTime(today, 10, 30, 6);
    const oldEnd = new Date(oldStart.getTime() + 60 * 60000);
    addSession(db, 'church-1', oldStart, oldEnd);

    const stats = getServiceTimingStats(db, 'church-1', 4);
    // Should not include the old session
    expect(stats.avgStartDelay).toBe(0);
    expect(stats.avgDuration).toBe(0);
  });

  it('handles church with no schedule', () => {
    addChurch(db, 'church-1', 'Test', []);

    const start = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 90 * 60000);
    addSession(db, 'church-1', start, end);

    const stats = getServiceTimingStats(db, 'church-1', 4);
    // Still computes duration even without schedule
    expect(stats.avgDuration).toBe(90);
  });
});

// ─── TESTS: checkUpcomingConflicts ────────────────────────────────────────────

describe('checkUpcomingConflicts', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('returns empty array when no conflicts exist', () => {
    const schedule = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 1 },
      { day: 0, startHour: 11, startMin: 0, durationHours: 1 },
    ];
    addChurch(db, 'church-1', 'Test', schedule);

    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toEqual([]);
  });

  it('detects overlapping windows on the same day', () => {
    const schedule = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 2 },  // 9:00–11:00
      { day: 0, startHour: 10, startMin: 30, durationHours: 1.5 }, // 10:30–12:00
    ];
    addChurch(db, 'church-1', 'Test', schedule);

    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].overlapMinutes).toBe(30);
    expect(conflicts[0].windowA.startHour).toBe(9);
    expect(conflicts[0].windowB.startHour).toBe(10);
  });

  it('does not flag windows on different days', () => {
    const schedule = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 3 },
      { day: 3, startHour: 9, startMin: 0, durationHours: 3 },
    ];
    addChurch(db, 'church-1', 'Test', schedule);

    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toEqual([]);
  });

  it('returns empty when church has no schedule', () => {
    addChurch(db, 'church-1', 'Test', []);
    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toEqual([]);
  });

  it('returns empty for a single window per day', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toEqual([]);
  });

  it('detects multiple conflicts on the same day', () => {
    const schedule = [
      { day: 0, startHour: 8, startMin: 0, durationHours: 2 },  // 8–10
      { day: 0, startHour: 9, startMin: 30, durationHours: 2 }, // 9:30–11:30
      { day: 0, startHour: 11, startMin: 0, durationHours: 2 }, // 11–13
    ];
    addChurch(db, 'church-1', 'Test', schedule);

    const conflicts = checkUpcomingConflicts(db, 'church-1');
    expect(conflicts).toHaveLength(2);
  });

  it('handles church not found gracefully', () => {
    const conflicts = checkUpcomingConflicts(db, 'nonexistent');
    expect(conflicts).toEqual([]);
  });
});

// ─── TESTS: Drift object structure ────────────────────────────────────────────

describe('Drift object structure', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('each drift has type, severity, message, scheduledTime, actualTime, deltaMinutes', () => {
    const schedule = [{ day: 0, startHour: 9, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 9, 25);
    const endedAt = new Date(startedAt.getTime() + 90 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.length).toBeGreaterThan(0);

    for (const drift of drifts) {
      expect(drift).toHaveProperty('type');
      expect(drift).toHaveProperty('severity');
      expect(drift).toHaveProperty('message');
      expect(drift).toHaveProperty('scheduledTime');
      expect(drift).toHaveProperty('actualTime');
      expect(drift).toHaveProperty('deltaMinutes');
      expect(['info', 'warning', 'critical']).toContain(drift.severity);
      expect(typeof drift.deltaMinutes).toBe('number');
    }
  });
});

// ─── TESTS: Midnight crossing edge case ───────────────────────────────────────

describe('Midnight crossing', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('handles a service scheduled to run past midnight', () => {
    // Service starts at 23:00, duration 2 hours (ends 01:00 next day)
    const schedule = [{ day: 6, startHour: 23, startMin: 0, durationHours: 2 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(6, 23, 5); // 5 min late — under threshold
    const endedAt = new Date(startedAt.getTime() + 115 * 60000); // ~1:55 next day

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    // Should not flag late_start (5 min) or overtime (close to scheduled end)
    expect(drifts.find(d => d.type === 'late_start')).toBeUndefined();
  });
});

// ─── TESTS: First service edge case ──────────────────────────────────────────

describe('First service (no previous sessions)', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db?.close(); });

  it('does not flag overlap when there are no previous sessions', () => {
    const schedule = [{ day: 0, startHour: 10, startMin: 0, durationHours: 1.5 }];
    addChurch(db, 'church-1', 'Test', schedule);

    const startedAt = dateForDayTime(0, 10, 0);
    const endedAt = new Date(startedAt.getTime() + 90 * 60000);

    const { drifts } = detectDrift(db, 'church-1', { startedAt, endedAt, sessionId: 's1' });
    expect(drifts.find(d => d.type === 'overlap')).toBeUndefined();
  });
});

// ─── TESTS: Thresholds exported correctly ─────────────────────────────────────

describe('Exported thresholds', () => {
  it('LATE_START_THRESHOLD is 10', () => {
    expect(LATE_START_THRESHOLD).toBe(10);
  });

  it('EARLY_END_THRESHOLD is 15', () => {
    expect(EARLY_END_THRESHOLD).toBe(15);
  });

  it('OVERTIME_THRESHOLD is 20', () => {
    expect(OVERTIME_THRESHOLD).toBe(20);
  });
});
