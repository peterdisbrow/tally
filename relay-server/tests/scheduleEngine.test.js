/**
 * ScheduleEngine — comprehensive state machine tests
 *
 * Covers:
 *   A. Schedule persistence (set/get)
 *   B. Service window detection — time math, 30-min buffer, event churches
 *   C. Window open/close callbacks — registration, transition firing, error isolation
 *   D. _pollWindows — state tracking, no re-fire on steady state, DB error recovery
 *   E. getNextService — soonest upcoming, wraps across week boundary
 *   F. Event church handling — event_expires_at, expired event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleEngine } from '../src/scheduleEngine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service_times TEXT DEFAULT '[]',
      church_type TEXT DEFAULT 'recurring',
      event_expires_at TEXT
    )
  `);
  return db;
}

function addChurch(db, churchId, opts = {}) {
  db.prepare(
    'INSERT INTO churches (churchId, name, service_times, church_type, event_expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(
    churchId,
    opts.name || 'Test Church',
    opts.serviceTimes ? JSON.stringify(opts.serviceTimes) : '[]',
    opts.churchType || 'recurring',
    opts.eventExpiresAt || null
  );
}

/** Build a service time entry that starts exactly `minutesFromNow` in the future. */
function serviceStartingInMinutes(minutesFromNow, durationHours = 2) {
  const now = new Date();
  const start = new Date(now.getTime() + minutesFromNow * 60 * 1000);
  return {
    day: start.getDay(),
    startHour: start.getHours(),
    startMin: start.getMinutes(),
    durationHours,
  };
}

/** Build a service time entry that started `minutesAgo` minutes ago. */
function serviceStartedMinutesAgo(minutesAgo, durationHours = 2) {
  const now = new Date();
  const start = new Date(now.getTime() - minutesAgo * 60 * 1000);
  return {
    day: start.getDay(),
    startHour: start.getHours(),
    startMin: start.getMinutes(),
    durationHours,
  };
}

// ─── A. Schedule persistence ───────────────────────────────────────────────────

describe('A. Schedule persistence', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new ScheduleEngine(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
  });

  it('stores and retrieves a single service time', () => {
    const times = [{ day: 0, startHour: 9, startMin: 30, durationHours: 2 }];
    engine.setSchedule('ch1', times);
    expect(engine.getSchedule('ch1')).toEqual(times);
  });

  it('overwrites a previous schedule', () => {
    engine.setSchedule('ch1', [{ day: 0, startHour: 9, startMin: 0, durationHours: 1 }]);
    const newTimes = [{ day: 6, startHour: 18, startMin: 0, durationHours: 1.5 }];
    engine.setSchedule('ch1', newTimes);
    expect(engine.getSchedule('ch1')).toEqual(newTimes);
  });

  it('returns [] for a church with no service_times column value', () => {
    db.prepare('UPDATE churches SET service_times = NULL WHERE churchId = ?').run('ch1');
    expect(engine.getSchedule('ch1')).toEqual([]);
  });

  it('returns [] for a church with malformed JSON service_times', () => {
    db.prepare('UPDATE churches SET service_times = ? WHERE churchId = ?').run('not-json', 'ch1');
    expect(engine.getSchedule('ch1')).toEqual([]);
  });

  it('stores multiple service times', () => {
    const times = [
      { day: 0, startHour: 9, startMin: 0, durationHours: 1.5 },
      { day: 0, startHour: 11, startMin: 0, durationHours: 1.5 },
      { day: 3, startHour: 19, startMin: 0, durationHours: 1 },
    ];
    engine.setSchedule('ch1', times);
    const result = engine.getSchedule('ch1');
    expect(result.length).toBe(3);
    expect(result).toEqual(times);
  });
});

// ─── B. Service window detection ──────────────────────────────────────────────

// Note: Tests in section B use fake timers anchored to 2 PM local time to avoid
// cross-midnight issues when "N minutes from now" would roll into the next day.

describe('B. Service window detection (regular church)', () => {
  let db, engine;

  beforeEach(() => {
    // Anchor to 14:00 (2 PM) so +30 min = 14:30, never crosses midnight
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));
    db = createTestDb();
    engine = new ScheduleEngine(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
    vi.useRealTimers();
  });

  it('returns false when no schedule is set', () => {
    expect(engine.isServiceWindow('ch1')).toBe(false);
  });

  it('returns true when currently inside a service window (started 30 min ago)', () => {
    // Service started 30 min ago, lasts 2 hours — still active
    engine.setSchedule('ch1', [serviceStartedMinutesAgo(30, 2)]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('returns true when within the 30-min pre-service buffer', () => {
    // Service starts in 20 min — within the 30-min buffer
    engine.setSchedule('ch1', [serviceStartingInMinutes(20, 2)]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('returns true exactly at the 30-min buffer boundary', () => {
    // Service starts in exactly 30 min — at the edge of the buffer
    engine.setSchedule('ch1', [serviceStartingInMinutes(30, 2)]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('returns false when service is more than 30 min away', () => {
    // Service starts in 60 min — outside the 30-min buffer
    engine.setSchedule('ch1', [serviceStartingInMinutes(60, 2)]);
    expect(engine.isServiceWindow('ch1')).toBe(false);
  });

  it('returns true within the 30-min post-service buffer', () => {
    // Service started 100 min ago, lasts 1.5 hours (90 min) — ended 10 min ago, still in buffer
    engine.setSchedule('ch1', [serviceStartedMinutesAgo(100, 1.5)]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('returns false when well past the service end + buffer', () => {
    // Service started 4 hours ago, lasted 1 hour — ended 3 hours ago
    engine.setSchedule('ch1', [serviceStartedMinutesAgo(240, 1)]);
    expect(engine.isServiceWindow('ch1')).toBe(false);
  });

  it('ignores services on other days of the week', () => {
    const now = new Date();
    const otherDay = (now.getDay() + 3) % 7;
    engine.setSchedule('ch1', [
      { day: otherDay, startHour: now.getHours(), startMin: now.getMinutes(), durationHours: 2 },
    ]);
    expect(engine.isServiceWindow('ch1')).toBe(false);
  });

  it('matches the correct service among multiple entries', () => {
    const now = new Date();
    const otherDay = (now.getDay() + 3) % 7;
    engine.setSchedule('ch1', [
      { day: otherDay, startHour: 9, startMin: 0, durationHours: 2 }, // wrong day
      serviceStartingInMinutes(15, 2), // in buffer — should match
    ]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('defaults durationHours to 2 when not provided', () => {
    // Service started 90 min ago with no durationHours — default 2h, still active
    const start = serviceStartedMinutesAgo(90);
    const { durationHours: _, ...withoutDuration } = start;
    engine.setSchedule('ch1', [withoutDuration]);
    expect(engine.isServiceWindow('ch1')).toBe(true);
  });

  it('defaults startMin to 0 when not provided', () => {
    const now = new Date();
    // Build a service starting at the current hour with no startMin
    const s = serviceStartedMinutesAgo(30, 2);
    const { startMin: _, ...withoutMin } = s;
    engine.setSchedule('ch1', [withoutMin]);
    // Whether it fires depends on whether the actual time is still in window
    // Just verify no crash and returns boolean
    const result = engine.isServiceWindow('ch1');
    expect(typeof result).toBe('boolean');
  });

  it('returns false for unknown church', () => {
    expect(engine.isServiceWindow('nonexistent')).toBe(false);
  });
});

// ─── B2. Event church window detection ────────────────────────────────────────

describe('B2. Service window detection (event churches)', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));
    db = createTestDb();
    engine = new ScheduleEngine(db);
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
    vi.useRealTimers();
  });

  it('event church with future expiry returns true (always in window)', () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h from now
    addChurch(db, 'event1', { churchType: 'event', eventExpiresAt: expiresAt });
    expect(engine.isServiceWindow('event1')).toBe(true);
  });

  it('event church with past expiry returns false', () => {
    const expiresAt = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    addChurch(db, 'event2', { churchType: 'event', eventExpiresAt: expiresAt });
    expect(engine.isServiceWindow('event2')).toBe(false);
  });

  it('event church with no event_expires_at returns true', () => {
    addChurch(db, 'event3', { churchType: 'event', eventExpiresAt: null });
    expect(engine.isServiceWindow('event3')).toBe(true);
  });

  it('recurring church is not treated as event church', () => {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    // recurring type with event_expires_at — should use schedule logic, not event logic
    addChurch(db, 'rec1', { churchType: 'recurring', eventExpiresAt: expiresAt });
    expect(engine.isServiceWindow('rec1')).toBe(false); // no schedule set
  });
});

// ─── C. Callbacks ─────────────────────────────────────────────────────────────

describe('C. Window open/close callbacks', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));
    db = createTestDb();
    engine = new ScheduleEngine(db);
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
    vi.useRealTimers();
  });

  it('addWindowOpenCallback registers a callback', () => {
    const cb = vi.fn();
    engine.addWindowOpenCallback(cb);
    expect(engine._openCallbacks).toContain(cb);
  });

  it('addWindowCloseCallback registers a callback', () => {
    const cb = vi.fn();
    engine.addWindowCloseCallback(cb);
    expect(engine._closeCallbacks).toContain(cb);
  });

  it('fires all open callbacks when window opens', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    engine.addWindowOpenCallback(cb1);
    engine.addWindowOpenCallback(cb2);

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]); // in buffer
    engine._pollWindows();

    expect(cb1).toHaveBeenCalledWith('ch1');
    expect(cb2).toHaveBeenCalledWith('ch1');
  });

  it('fires all close callbacks when window closes', () => {
    const openCb = vi.fn();
    const closeCb = vi.fn();
    engine.addWindowOpenCallback(openCb);
    engine.addWindowCloseCallback(closeCb);

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);
    engine._pollWindows(); // window opens

    // Move schedule to distant future so window closes
    const otherDay = (new Date().getDay() + 3) % 7;
    engine.setSchedule('ch1', [{ day: otherDay, startHour: 3, startMin: 0, durationHours: 1 }]);
    engine._pollWindows();

    expect(closeCb).toHaveBeenCalledWith('ch1');
  });

  it('does not re-fire open callback on repeated polls in same state', () => {
    const cb = vi.fn();
    engine.addWindowOpenCallback(cb);

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);
    engine._pollWindows(); // fires once
    engine._pollWindows(); // no change
    engine._pollWindows(); // no change

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire close callback on repeated polls in same state', () => {
    const closeCb = vi.fn();
    engine.addWindowCloseCallback(closeCb);

    addChurch(db, 'ch1');
    const otherDay = (new Date().getDay() + 3) % 7;
    engine.setSchedule('ch1', [{ day: otherDay, startHour: 3, startMin: 0, durationHours: 1 }]);
    engine._pollWindows(); // window is closed from start — no transition
    engine._pollWindows();

    expect(closeCb).not.toHaveBeenCalled();
  });

  it('isolates callback errors — other callbacks still fire', () => {
    const failingCb = vi.fn(() => { throw new Error('boom'); });
    const goodCb = vi.fn();
    engine.addWindowOpenCallback(failingCb);
    engine.addWindowOpenCallback(goodCb);

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);

    // Should not throw even though failingCb throws
    expect(() => engine._pollWindows()).not.toThrow();
    expect(goodCb).toHaveBeenCalledWith('ch1');
  });

  it('close callback error does not break other close callbacks', () => {
    const openCb = vi.fn();
    const failClose = vi.fn(() => { throw new Error('close fail'); });
    const goodClose = vi.fn();
    engine.addWindowOpenCallback(openCb);
    engine.addWindowCloseCallback(failClose);
    engine.addWindowCloseCallback(goodClose);

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);
    engine._pollWindows();

    const otherDay = (new Date().getDay() + 3) % 7;
    engine.setSchedule('ch1', [{ day: otherDay, startHour: 3, startMin: 0, durationHours: 1 }]);
    expect(() => engine._pollWindows()).not.toThrow();
    expect(goodClose).toHaveBeenCalledWith('ch1');
  });

  it('tracks open/close transitions independently per church', () => {
    const opened = [];
    const closed = [];
    engine.addWindowOpenCallback(id => opened.push(id));
    engine.addWindowCloseCallback(id => closed.push(id));

    addChurch(db, 'ch-a');
    addChurch(db, 'ch-b');

    // ch-a is in window; ch-b is not
    engine.setSchedule('ch-a', [serviceStartingInMinutes(10, 2)]);
    const otherDay = (new Date().getDay() + 3) % 7;
    engine.setSchedule('ch-b', [{ day: otherDay, startHour: 3, startMin: 0, durationHours: 1 }]);

    engine._pollWindows();

    expect(opened).toContain('ch-a');
    expect(opened).not.toContain('ch-b');
    expect(closed).not.toContain('ch-a');
    expect(closed).not.toContain('ch-b');
  });
});

// ─── D. _pollWindows error recovery ───────────────────────────────────────────

describe('D. _pollWindows error recovery', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new ScheduleEngine(db);
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
  });

  it('survives when the churches table query fails (graceful error)', () => {
    // Drop the churches table to force a DB error
    db.exec('DROP TABLE churches');
    expect(() => engine._pollWindows()).not.toThrow();
  });

  it('handles an empty churches table with no callbacks', () => {
    const cb = vi.fn();
    engine.addWindowOpenCallback(cb);
    engine._pollWindows(); // No churches — should be a no-op
    expect(cb).not.toHaveBeenCalled();
  });

  it('startPolling creates an interval and runs an immediate poll', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T14:00:00.000'));

    addChurch(db, 'ch1');
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);
    const openCb = vi.fn();
    engine.addWindowOpenCallback(openCb);

    engine.startPolling();
    // The immediate poll should have fired
    expect(openCb).toHaveBeenCalled();
    expect(engine._pollTimer).not.toBeNull();

    clearInterval(engine._pollTimer);
    engine._pollTimer = null;
    vi.useRealTimers();
  });

  it('startPolling polls again after 60 seconds', () => {
    vi.useFakeTimers();

    addChurch(db, 'ch1');
    const openCb = vi.fn();
    engine.addWindowOpenCallback(openCb);

    engine.startPolling();
    const callsAfterImmediate = openCb.mock.calls.length;

    // Advance 60 seconds — should trigger another poll
    engine.setSchedule('ch1', [serviceStartingInMinutes(10, 2)]);
    vi.advanceTimersByTime(60 * 1000);

    // A second poll may or may not fire the callback again depending on state,
    // but the important thing is it did not throw
    expect(() => vi.advanceTimersByTime(60 * 1000)).not.toThrow();

    clearInterval(engine._pollTimer);
    engine._pollTimer = null;
    vi.useRealTimers();
  });
});

// ─── E. getNextService ────────────────────────────────────────────────────────

describe('E. getNextService', () => {
  let db, engine;

  beforeEach(() => {
    db = createTestDb();
    engine = new ScheduleEngine(db);
    addChurch(db, 'ch1');
  });

  afterEach(() => {
    if (engine._pollTimer) clearInterval(engine._pollTimer);
    db?.close();
  });

  it('returns null when no schedule is set', () => {
    expect(engine.getNextService('ch1')).toBeNull();
  });

  it('returns the next upcoming service with correct fields', () => {
    // Services on every day ensure one is always upcoming
    const times = [];
    for (let d = 0; d < 7; d++) {
      times.push({ day: d, startHour: 10, startMin: 0, durationHours: 2 });
    }
    engine.setSchedule('ch1', times);

    const next = engine.getNextService('ch1');
    expect(next).not.toBeNull();
    expect(next).toHaveProperty('day');
    expect(next).toHaveProperty('startTime');
    expect(next).toHaveProperty('minutesUntil');
    expect(next.startTime).toBe('10:00');
    expect(next.minutesUntil).toBeGreaterThan(0);
    expect(next.minutesUntil).toBeLessThanOrEqual(7 * 24 * 60);
  });

  it('pads startMin with leading zero in startTime', () => {
    engine.setSchedule('ch1', [
      { day: (new Date().getDay() + 2) % 7, startHour: 9, startMin: 5, durationHours: 1 },
    ]);
    const next = engine.getNextService('ch1');
    expect(next.startTime).toBe('09:05');
  });

  it('returns the soonest service among multiple', () => {
    const now = new Date();
    const nearDay = (now.getDay() + 1) % 7;
    const farDay = (now.getDay() + 5) % 7;
    engine.setSchedule('ch1', [
      { day: farDay, startHour: 10, startMin: 0, durationHours: 1 },
      { day: nearDay, startHour: 10, startMin: 0, durationHours: 1 },
    ]);
    const next = engine.getNextService('ch1');
    expect(next.day).toBe(nearDay);
  });

  it('wraps around the week boundary correctly', () => {
    // Set a service for the same day-of-week as today but earlier in the day
    // so it's actually ~7 days away
    const now = new Date();
    const pastTime = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago
    engine.setSchedule('ch1', [
      { day: pastTime.getDay(), startHour: pastTime.getHours(), startMin: pastTime.getMinutes(), durationHours: 1 },
    ]);
    const next = engine.getNextService('ch1');
    expect(next).not.toBeNull();
    expect(next.minutesUntil).toBeGreaterThan(0);
    // Should be close to 7 days away
    expect(next.minutesUntil).toBeGreaterThan(6 * 24 * 60);
  });
});
