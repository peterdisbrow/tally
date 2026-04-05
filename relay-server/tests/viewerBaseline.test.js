/**
 * Tests for src/viewerBaseline.js — viewer baseline computation with real
 * in-memory SQLite DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { ViewerBaseline } = require('../src/viewerBaseline');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      peak_viewers INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS viewer_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      total_viewers INTEGER DEFAULT 0,
      yt_viewers INTEGER DEFAULT 0,
      fb_viewers INTEGER DEFAULT 0,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS churches (
      churchId TEXT PRIMARY KEY,
      service_times TEXT
    );
  `);
  return db;
}

function addSession(db, id, churchId, startedAt, peakViewers = 0) {
  db.prepare('INSERT INTO service_sessions (id, church_id, started_at, peak_viewers) VALUES (?, ?, ?, ?)')
    .run(id, churchId, startedAt, peakViewers);
}

function addSnapshot(db, id, sessionId, totalViewers, ytViewers, fbViewers, capturedAt) {
  db.prepare('INSERT INTO viewer_snapshots (id, session_id, total_viewers, yt_viewers, fb_viewers, captured_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, sessionId, totalViewers, ytViewers, fbViewers, capturedAt);
}

// Sunday 3 weeks ago
function sundayWeeksAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - (d.getDay()) - n * 7); // go to last Sunday minus n weeks
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

describe('ViewerBaseline', () => {
  let db;
  let baseline;

  beforeEach(() => {
    db = createDb();
    baseline = new ViewerBaseline(db);
  });

  describe('compute()', () => {
    it('works when constructed with a query client', async () => {
      const queryClient = createQueryClient({
        config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
        sqliteDb: db,
      });
      baseline = new ViewerBaseline(queryClient);
      await baseline.ready;

      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 120);
      const result = await baseline.compute('church_a', 0);

      expect(result.expectedPeak).toBe(120);
      expect(result.sampleCount).toBe(1);
    });

    it('returns zero baseline when no sessions exist', () => {
      const result = baseline.compute('church_a', 0);
      expect(result).toEqual({
        expectedPeak: 0,
        expectedAtMinute10: 0,
        timeToPeakMinutes: 0,
        platformSplit: {},
        trendPct: 0,
        sampleCount: 0,
      });
    });

    it('computes expectedPeak from peak_viewers across sessions', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 100);
      addSession(db, 's2', 'church_a', sundayWeeksAgo(2), 200);

      const result = baseline.compute('church_a', 0);
      expect(result.expectedPeak).toBe(150); // average of 100 and 200
      expect(result.sampleCount).toBe(2);
    });

    it('filters sessions to the matching day of week', () => {
      // Add Sunday sessions
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 100);
      // Add a Monday session (day 1)
      const monday = new Date(sundayWeeksAgo(1));
      monday.setDate(monday.getDate() + 1);
      addSession(db, 's2', 'church_a', monday.toISOString(), 999);

      const result = baseline.compute('church_a', 0); // Sunday only
      expect(result.sampleCount).toBe(1);
      expect(result.expectedPeak).toBe(100);
    });

    it('respects the weeks rolling window', () => {
      // Session within 6-week window
      addSession(db, 's1', 'church_a', sundayWeeksAgo(3), 100);
      // Session outside 6-week window (8 weeks ago)
      addSession(db, 's2', 'church_a', sundayWeeksAgo(8), 500);

      const result = baseline.compute('church_a', 0, { weeks: 6 });
      expect(result.sampleCount).toBe(1);
      expect(result.expectedPeak).toBe(100);
    });

    it('computes expectedAtMinute10 from snapshots near 10-minute mark', () => {
      const sessionStart = sundayWeeksAgo(1);
      addSession(db, 's1', 'church_a', sessionStart, 100);

      const startMs = new Date(sessionStart).getTime();
      const snap10 = new Date(startMs + 10 * 60000).toISOString(); // exactly 10 min
      const snap20 = new Date(startMs + 20 * 60000).toISOString();
      addSnapshot(db, 'sn1', 's1', 50, 30, 20, snap10);
      addSnapshot(db, 'sn2', 's1', 100, 60, 40, snap20);

      const result = baseline.compute('church_a', 0);
      expect(result.expectedAtMinute10).toBe(50);
    });

    it('computes timeToPeakMinutes from snapshots', () => {
      const sessionStart = sundayWeeksAgo(1);
      addSession(db, 's1', 'church_a', sessionStart, 100);

      const startMs = new Date(sessionStart).getTime();
      addSnapshot(db, 'sn1', 's1', 40, 20, 10, new Date(startMs + 5 * 60000).toISOString());
      addSnapshot(db, 'sn2', 's1', 100, 60, 30, new Date(startMs + 15 * 60000).toISOString());

      const result = baseline.compute('church_a', 0);
      expect(result.timeToPeakMinutes).toBe(15);
    });

    it('computes platform split percentages', () => {
      const sessionStart = sundayWeeksAgo(1);
      addSession(db, 's1', 'church_a', sessionStart, 100);

      const startMs = new Date(sessionStart).getTime();
      // Peak snapshot: 80 yt, 20 fb out of 100
      addSnapshot(db, 'sn1', 's1', 100, 80, 20, new Date(startMs + 15 * 60000).toISOString());

      const result = baseline.compute('church_a', 0);
      expect(result.platformSplit.youtube).toBe(80);
      expect(result.platformSplit.facebook).toBe(20);
      expect(result.platformSplit.other).toBeUndefined(); // 0 other
    });

    it('includes "other" in platform split when viewers are not on yt/fb', () => {
      const sessionStart = sundayWeeksAgo(1);
      addSession(db, 's1', 'church_a', sessionStart, 100);

      const startMs = new Date(sessionStart).getTime();
      addSnapshot(db, 'sn1', 's1', 100, 50, 30, new Date(startMs + 15 * 60000).toISOString()); // 20 other

      const result = baseline.compute('church_a', 0);
      expect(result.platformSplit.other).toBe(20);
    });

    it('computes trendPct when 4+ peak sessions available', () => {
      // Need 4+ sessions with positive peak_viewers
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 200); // recent
      addSession(db, 's2', 'church_a', sundayWeeksAgo(2), 200); // recent
      addSession(db, 's3', 'church_a', sundayWeeksAgo(3), 100); // older
      addSession(db, 's4', 'church_a', sundayWeeksAgo(4), 100); // older

      const result = baseline.compute('church_a', 0);
      // recentAvg=200, olderAvg=100 → trend = +100%
      expect(result.trendPct).toBe(100);
    });

    it('skips trendPct when fewer than 4 peak samples', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 200);
      addSession(db, 's2', 'church_a', sundayWeeksAgo(2), 100);

      const result = baseline.compute('church_a', 0);
      expect(result.trendPct).toBe(0);
    });

    it('handles sessions with no snapshots gracefully', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 50);
      // No snapshots added

      const result = baseline.compute('church_a', 0);
      expect(result.expectedPeak).toBe(50);
      expect(result.expectedAtMinute10).toBe(0);
    });

    it('ignores sessions with zero peak_viewers for peak calculation', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 0);  // no viewers
      addSession(db, 's2', 'church_a', sundayWeeksAgo(2), 100);

      const result = baseline.compute('church_a', 0);
      expect(result.expectedPeak).toBe(100);
    });

    it('caches result to the viewer_baselines table', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 100);
      baseline.compute('church_a', 0);

      const row = db.prepare('SELECT * FROM viewer_baselines WHERE church_id = ? AND service_day = ?').get('church_a', 0);
      expect(row).toBeDefined();
      expect(row.expected_peak).toBe(100);
    });

    it('passes instanceName and roomId to cache', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 100);
      baseline.compute('church_a', 0, { instanceName: 'room-1', roomId: 'r1' });

      const row = db.prepare('SELECT * FROM viewer_baselines WHERE church_id = ?').get('church_a');
      expect(row.instance_name).toBe('room-1');
      expect(row.room_id).toBe('r1');
    });
  });

  describe('getBaseline()', () => {
    it('returns cached baseline when less than 24 hours old', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 150);
      baseline.compute('church_a', 0); // populates cache

      const result = baseline.getBaseline('church_a', 0);
      expect(result.expectedPeak).toBe(150);
    });

    it('recomputes when no cached baseline exists', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 200);
      const result = baseline.getBaseline('church_a', 0);
      expect(result.expectedPeak).toBe(200);
    });

    it('recomputes when cached baseline is stale (older than 24h)', () => {
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 75);
      // Insert a stale cache entry
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      db.prepare(`INSERT INTO viewer_baselines
        (id, church_id, service_day, expected_peak, expected_at_minute_10,
         time_to_peak_minutes, platform_split_json, trend_pct, sample_count, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('stale-1', 'church_a', 0, 999, 0, 0, '{}', 0, 1, staleDate);

      const result = baseline.getBaseline('church_a', 0);
      // Should recompute, not use stale value
      expect(result.expectedPeak).toBe(75);
    });
  });

  describe('recomputeAll()', () => {
    it('recomputes baselines for all churches with service_times', () => {
      db.prepare('INSERT INTO churches (churchId, service_times) VALUES (?, ?)').run(
        'church_a', JSON.stringify([{ day: 0 }, { day: 3 }])
      );
      addSession(db, 's1', 'church_a', sundayWeeksAgo(1), 100);

      baseline.recomputeAll();

      const rows = db.prepare('SELECT * FROM viewer_baselines WHERE church_id = ?').all('church_a');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('handles churches with no service_times gracefully', () => {
      db.prepare('INSERT INTO churches (churchId, service_times) VALUES (?, ?)').run('church_a', null);
      expect(() => baseline.recomputeAll()).not.toThrow();
    });

    it('handles empty churches table without throwing', () => {
      expect(() => baseline.recomputeAll()).not.toThrow();
    });

    it('catches and logs DB errors in recomputeAll', () => {
      // Drop the churches table to cause the SELECT to throw
      db.exec('DROP TABLE churches');
      expect(() => baseline.recomputeAll()).not.toThrow();
    });
  });

  describe('compute() error handling', () => {
    it('catches and logs DB errors when writing the cache', () => {
      // Drop the viewer_baselines table so the INSERT inside compute() throws
      db.prepare('INSERT INTO churches (churchId, service_times) VALUES (?, ?)').run(
        'church_err', JSON.stringify([{ day: 0 }])
      );
      addSession(db, 'se1', 'church_err', sundayWeeksAgo(1), 50);
      db.exec('DROP TABLE viewer_baselines');
      // compute() should catch the INSERT error and not throw
      expect(() => baseline.compute('church_err', 0)).not.toThrow();
    });
  });
});
