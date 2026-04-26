'use strict';

/**
 * viewerBaseline.js
 * Aggregates viewer_snapshots over a rolling 4-8 week window to calculate
 * expected peak viewers, time-to-peak, platform split, and trends.
 *
 * Exports a baseline object for pre-service rundown consumption.
 * Recomputes weekly and caches in the viewer_baselines table.
 */

const crypto = require('crypto');
const { createQueryClient } = require('./db');
const { buildNonTestSessionClauseSync, buildNonTestSessionClause } = require('./schemaCompat');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const CREATE_VIEWER_BASELINES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS viewer_baselines (
    id TEXT PRIMARY KEY,
    church_id TEXT NOT NULL,
    instance_name TEXT,
    room_id TEXT,
    service_day INTEGER NOT NULL,
    expected_peak INTEGER,
    expected_at_minute_10 INTEGER,
    time_to_peak_minutes INTEGER,
    platform_split_json TEXT,
    trend_pct REAL,
    sample_count INTEGER,
    computed_at TEXT
  )
`;

class ViewerBaseline {
  constructor(dbOrClient, options = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, options);

    if (this.db) {
      this._ensureTableSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  _resolveClient(dbOrClient, options = {}) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: options.config || SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[ViewerBaseline] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
  }

  _ensureTableSync() {
    this.db.exec(CREATE_VIEWER_BASELINES_TABLE_SQL);
    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_viewer_baselines_church ON viewer_baselines(church_id, service_day)');
    } catch (err) { /* already exists */ console.debug("[viewerBaseline] intentional swallow:", err); }
  }

  async _ensureTable() {
    const client = this._requireClient();
    await client.exec(CREATE_VIEWER_BASELINES_TABLE_SQL);
    try {
      await client.exec('CREATE INDEX IF NOT EXISTS idx_viewer_baselines_church ON viewer_baselines(church_id, service_day)');
    } catch (err) { /* already exists */ console.debug("[viewerBaseline] intentional swallow:", err); }
  }

  /**
   * Compute baseline for a church on a specific day of the week.
   * Aggregates viewer_snapshots from the last `weeks` weeks of sessions
   * that match the given day.
   *
   * @param {string} churchId
   * @param {number} serviceDay 0=Sunday, 6=Saturday
   * @param {object} [opts]
   * @param {number} [opts.weeks=6] Rolling window in weeks
   * @param {string} [opts.instanceName]
   * @param {string} [opts.roomId]
   * @returns {{ expectedPeak: number, expectedAtMinute10: number, timeToPeakMinutes: number, platformSplit: object, trendPct: number, sampleCount: number }}
   */
  compute(churchId, serviceDay, opts = {}) {
    if (this.db) return this._computeSync(churchId, serviceDay, opts);
    return this._computeAsync(churchId, serviceDay, opts);
  }

  _computeSync(churchId, serviceDay, opts = {}) {
    const weeks = opts.weeks || 6;
    const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
    const nonTestSessionClause = buildNonTestSessionClauseSync(this.db);

    // Get sessions matching this day within the window
    const sessions = this.db.prepare(`
      SELECT id, started_at, peak_viewers
      FROM service_sessions
      WHERE church_id = ? AND started_at > ?${nonTestSessionClause}
      ORDER BY started_at DESC
    `).all(churchId, cutoff);

    // Filter to sessions that started on the matching day of week
    const daySessions = sessions.filter(s => {
      const d = new Date(s.started_at);
      return d.getDay() === serviceDay;
    });

    if (daySessions.length === 0) {
      return { expectedPeak: 0, expectedAtMinute10: 0, timeToPeakMinutes: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 };
    }

    // Aggregate peak viewers
    const peaks = daySessions.map(s => s.peak_viewers || 0).filter(p => p > 0);
    const expectedPeak = peaks.length > 0
      ? Math.round(peaks.reduce((a, b) => a + b, 0) / peaks.length)
      : 0;

    // Get viewer snapshots for these sessions to compute minute-10 and time-to-peak
    let expectedAtMinute10 = 0;
    let timeToPeakMinutes = 0;
    const platformTotals = { youtube: 0, facebook: 0, other: 0 };
    let platformSamples = 0;

    for (const session of daySessions) {
      if (!session.id) continue;
      const snapshots = this.db.prepare(`
        SELECT total_viewers, yt_viewers, fb_viewers, captured_at
        FROM viewer_snapshots
        WHERE session_id = ?
        ORDER BY captured_at ASC
      `).all(session.id);

      if (snapshots.length === 0) continue;

      const sessionStart = new Date(session.started_at).getTime();

      // Find snapshot closest to minute 10
      let closest10 = null;
      let closestDiff = Infinity;
      let peakSnapshot = { total_viewers: 0, captured_at: session.started_at };

      for (const snap of snapshots) {
        const minutesIn = (new Date(snap.captured_at).getTime() - sessionStart) / 60000;
        const diff = Math.abs(minutesIn - 10);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest10 = snap;
        }
        if ((snap.total_viewers || 0) > (peakSnapshot.total_viewers || 0)) {
          peakSnapshot = snap;
        }
      }

      if (closest10 && closestDiff < 5) {
        expectedAtMinute10 += closest10.total_viewers || 0;
      }

      // Time to peak
      if (peakSnapshot.total_viewers > 0) {
        const peakMinutes = (new Date(peakSnapshot.captured_at).getTime() - sessionStart) / 60000;
        timeToPeakMinutes += Math.max(0, peakMinutes);
      }

      // Platform split from the peak snapshot
      const yt = peakSnapshot.yt_viewers || 0;
      const fb = peakSnapshot.fb_viewers || 0;
      const total = peakSnapshot.total_viewers || 0;
      if (total > 0) {
        platformTotals.youtube += yt;
        platformTotals.facebook += fb;
        platformTotals.other += Math.max(0, total - yt - fb);
        platformSamples++;
      }
    }

    const sessionCount = daySessions.length;
    expectedAtMinute10 = sessionCount > 0 ? Math.round(expectedAtMinute10 / sessionCount) : 0;
    timeToPeakMinutes = sessionCount > 0 ? Math.round(timeToPeakMinutes / sessionCount) : 0;

    // Platform split as percentages
    const platformSplit = {};
    if (platformSamples > 0) {
      const totalViewers = platformTotals.youtube + platformTotals.facebook + platformTotals.other;
      if (totalViewers > 0) {
        platformSplit.youtube = Math.round((platformTotals.youtube / totalViewers) * 100);
        platformSplit.facebook = Math.round((platformTotals.facebook / totalViewers) * 100);
        if (platformTotals.other > 0) {
          platformSplit.other = Math.round((platformTotals.other / totalViewers) * 100);
        }
      }
    }

    // Trend: compare last 2 weeks vs prior 2 weeks
    let trendPct = 0;
    if (peaks.length >= 4) {
      const recentHalf = peaks.slice(0, Math.ceil(peaks.length / 2));
      const olderHalf = peaks.slice(Math.ceil(peaks.length / 2));
      const recentAvg = recentHalf.reduce((a, b) => a + b, 0) / recentHalf.length;
      const olderAvg = olderHalf.reduce((a, b) => a + b, 0) / olderHalf.length;
      if (olderAvg > 0) {
        trendPct = Math.round(((recentAvg - olderAvg) / olderAvg) * 100);
      }
    }

    const result = {
      expectedPeak,
      expectedAtMinute10,
      timeToPeakMinutes,
      platformSplit,
      trendPct,
      sampleCount: sessionCount,
    };

    // Cache to DB
    this._cacheBaselineSync(churchId, serviceDay, result, opts.instanceName, opts.roomId);

    return result;
  }

  async _computeAsync(churchId, serviceDay, opts = {}) {
    await this.ready;
    const weeks = opts.weeks || 6;
    const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
    const client = this._requireClient();
    const nonTestSessionClause = await buildNonTestSessionClause(client);

    const sessions = await client.query(
      `SELECT id, started_at, peak_viewers
       FROM service_sessions
       WHERE church_id = ? AND started_at > ?${nonTestSessionClause}
       ORDER BY started_at DESC`,
      [churchId, cutoff]
    );

    const daySessions = sessions.filter((session) => {
      const day = new Date(session.started_at);
      return day.getDay() === serviceDay;
    });

    if (!daySessions.length) {
      return { expectedPeak: 0, expectedAtMinute10: 0, timeToPeakMinutes: 0, platformSplit: {}, trendPct: 0, sampleCount: 0 };
    }

    const peaks = daySessions.map((session) => session.peak_viewers || 0).filter((peak) => peak > 0);
    const expectedPeak = peaks.length > 0
      ? Math.round(peaks.reduce((sum, peak) => sum + peak, 0) / peaks.length)
      : 0;

    let expectedAtMinute10 = 0;
    let timeToPeakMinutes = 0;
    const platformTotals = { youtube: 0, facebook: 0, other: 0 };
    let platformSamples = 0;

    for (const session of daySessions) {
      if (!session.id) continue;
      const snapshots = await client.query(
        `SELECT total_viewers, yt_viewers, fb_viewers, captured_at
         FROM viewer_snapshots
         WHERE session_id = ?
         ORDER BY captured_at ASC`,
        [session.id]
      );

      if (!snapshots.length) continue;

      const sessionStart = new Date(session.started_at).getTime();
      let closest10 = null;
      let closestDiff = Infinity;
      let peakSnapshot = { total_viewers: 0, captured_at: session.started_at };

      for (const snap of snapshots) {
        const minutesIn = (new Date(snap.captured_at).getTime() - sessionStart) / 60000;
        const diff = Math.abs(minutesIn - 10);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest10 = snap;
        }
        if ((snap.total_viewers || 0) > (peakSnapshot.total_viewers || 0)) {
          peakSnapshot = snap;
        }
      }

      if (closest10 && closestDiff < 5) {
        expectedAtMinute10 += closest10.total_viewers || 0;
      }

      if (peakSnapshot.total_viewers > 0) {
        const peakMinutes = (new Date(peakSnapshot.captured_at).getTime() - sessionStart) / 60000;
        timeToPeakMinutes += Math.max(0, peakMinutes);
      }

      const yt = peakSnapshot.yt_viewers || 0;
      const fb = peakSnapshot.fb_viewers || 0;
      const total = peakSnapshot.total_viewers || 0;
      if (total > 0) {
        platformTotals.youtube += yt;
        platformTotals.facebook += fb;
        platformTotals.other += Math.max(0, total - yt - fb);
        platformSamples++;
      }
    }

    const sessionCount = daySessions.length;
    expectedAtMinute10 = sessionCount > 0 ? Math.round(expectedAtMinute10 / sessionCount) : 0;
    timeToPeakMinutes = sessionCount > 0 ? Math.round(timeToPeakMinutes / sessionCount) : 0;

    const platformSplit = {};
    if (platformSamples > 0) {
      const totalViewers = platformTotals.youtube + platformTotals.facebook + platformTotals.other;
      if (totalViewers > 0) {
        platformSplit.youtube = Math.round((platformTotals.youtube / totalViewers) * 100);
        platformSplit.facebook = Math.round((platformTotals.facebook / totalViewers) * 100);
        if (platformTotals.other > 0) {
          platformSplit.other = Math.round((platformTotals.other / totalViewers) * 100);
        }
      }
    }

    let trendPct = 0;
    if (peaks.length >= 4) {
      const recentHalf = peaks.slice(0, Math.ceil(peaks.length / 2));
      const olderHalf = peaks.slice(Math.ceil(peaks.length / 2));
      const recentAvg = recentHalf.reduce((sum, peak) => sum + peak, 0) / recentHalf.length;
      const olderAvg = olderHalf.reduce((sum, peak) => sum + peak, 0) / olderHalf.length;
      if (olderAvg > 0) {
        trendPct = Math.round(((recentAvg - olderAvg) / olderAvg) * 100);
      }
    }

    const result = {
      expectedPeak,
      expectedAtMinute10,
      timeToPeakMinutes,
      platformSplit,
      trendPct,
      sampleCount: sessionCount,
    };

    await this._cacheBaseline(churchId, serviceDay, result, opts.instanceName, opts.roomId);
    return result;
  }

  /**
   * Get the cached baseline for a church/day. Falls back to computing if stale.
   */
  getBaseline(churchId, serviceDay) {
    if (this.db) return this._getBaselineSync(churchId, serviceDay);
    return this._getBaselineAsync(churchId, serviceDay);
  }

  _getBaselineSync(churchId, serviceDay) {
    const row = this.db.prepare(`
      SELECT * FROM viewer_baselines
      WHERE church_id = ? AND service_day = ?
      ORDER BY computed_at DESC LIMIT 1
    `).get(churchId, serviceDay);

    if (row) {
      const age = Date.now() - new Date(row.computed_at).getTime();
      // Return cached if less than 24 hours old
      if (age < 24 * 60 * 60 * 1000) {
        return {
          expectedPeak: row.expected_peak || 0,
          expectedAtMinute10: row.expected_at_minute_10 || 0,
          timeToPeakMinutes: row.time_to_peak_minutes || 0,
          platformSplit: JSON.parse(row.platform_split_json || '{}'),
          trendPct: row.trend_pct || 0,
          sampleCount: row.sample_count || 0,
        };
      }
    }

    // Recompute
    return this._computeSync(churchId, serviceDay);
  }

  async _getBaselineAsync(churchId, serviceDay) {
    await this.ready;
    const row = await this._requireClient().queryOne(
      `SELECT *
       FROM viewer_baselines
       WHERE church_id = ? AND service_day = ?
       ORDER BY computed_at DESC
       LIMIT 1`,
      [churchId, serviceDay]
    );

    if (row) {
      const age = Date.now() - new Date(row.computed_at).getTime();
      if (age < 24 * 60 * 60 * 1000) {
        return {
          expectedPeak: row.expected_peak || 0,
          expectedAtMinute10: row.expected_at_minute_10 || 0,
          timeToPeakMinutes: row.time_to_peak_minutes || 0,
          platformSplit: JSON.parse(row.platform_split_json || '{}'),
          trendPct: row.trend_pct || 0,
          sampleCount: row.sample_count || 0,
        };
      }
    }

    return this._computeAsync(churchId, serviceDay);
  }

  _cacheBaselineSync(churchId, serviceDay, result, instanceName, roomId) {
    try {
      // Delete old entry for this church/day
      this.db.prepare('DELETE FROM viewer_baselines WHERE church_id = ? AND service_day = ?')
        .run(churchId, serviceDay);
      this.db.prepare(`
        INSERT INTO viewer_baselines (id, church_id, instance_name, room_id, service_day,
          expected_peak, expected_at_minute_10, time_to_peak_minutes, platform_split_json,
          trend_pct, sample_count, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), churchId, instanceName || null, roomId || null, serviceDay,
        result.expectedPeak, result.expectedAtMinute10, result.timeToPeakMinutes,
        JSON.stringify(result.platformSplit), result.trendPct, result.sampleCount,
        new Date().toISOString()
      );
    } catch (e) {
      console.error(`[ViewerBaseline] Cache error for ${churchId}:`, e.message);
    }
  }

  async _cacheBaseline(churchId, serviceDay, result, instanceName, roomId) {
    try {
      const client = this._requireClient();
      await client.run('DELETE FROM viewer_baselines WHERE church_id = ? AND service_day = ?', [churchId, serviceDay]);
      await client.run(
        `INSERT INTO viewer_baselines (id, church_id, instance_name, room_id, service_day,
          expected_peak, expected_at_minute_10, time_to_peak_minutes, platform_split_json,
          trend_pct, sample_count, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          churchId,
          instanceName || null,
          roomId || null,
          serviceDay,
          result.expectedPeak,
          result.expectedAtMinute10,
          result.timeToPeakMinutes,
          JSON.stringify(result.platformSplit),
          result.trendPct,
          result.sampleCount,
          new Date().toISOString(),
        ]
      );
    } catch (e) {
      console.error(`[ViewerBaseline] Cache error for ${churchId}:`, e.message);
    }
  }

  /**
   * Recompute baselines for all churches (run weekly).
   */
  recomputeAll() {
    if (this.db) return this._recomputeAllSync();
    return this._recomputeAllAsync();
  }

  _recomputeAllSync() {
    try {
      const churches = this.db.prepare(
        'SELECT churchId AS "churchId", service_times FROM churches'
      ).all();
      let count = 0;
      for (const church of churches) {
        const schedule = JSON.parse(church.service_times || '[]');
        const days = new Set(schedule.map(s => s.day));
        for (const day of days) {
          this.compute(church.churchId, day);
          count++;
        }
      }
      if (count > 0) console.log(`[ViewerBaseline] Recomputed ${count} baselines`);
    } catch (e) {
      console.error('[ViewerBaseline] RecomputeAll error:', e.message);
    }
  }

  async _recomputeAllAsync() {
    try {
      await this.ready;
      const churches = await this._requireClient().query(
        'SELECT churchId AS "churchId", service_times FROM churches',
        []
      );
      let count = 0;
      for (const church of churches) {
        const schedule = JSON.parse(church.service_times || '[]');
        const days = new Set(schedule.map((service) => service.day));
        for (const day of days) {
          await this._computeAsync(church.churchId, day);
          count++;
        }
      }
      if (count > 0) console.log(`[ViewerBaseline] Recomputed ${count} baselines`);
    } catch (e) {
      console.error('[ViewerBaseline] RecomputeAll error:', e.message);
    }
  }
}

module.exports = { ViewerBaseline };
