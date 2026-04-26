/**
 * Schedule Engine — Service window management per church
 */

const { createQueryClient } = require('./db');
const { createLogger } = require('./logger');
const { ensureColumnSync, ensureColumn, hasColumnSync, hasColumn } = require('./schemaCompat');
const log = createLogger('ScheduleEngine');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

/**
 * Get the current day-of-week (0=Sun) and minutes-since-midnight in a
 * given IANA timezone.  Falls back to server local time when tz is empty
 * or not recognised so existing behaviour is preserved for churches that
 * haven't synced their timezone yet.
 *
 * @param {string} tz  IANA timezone string e.g. 'America/Chicago'
 * @returns {{ day: number, minutesNow: number }}
 */
function _getLocalDayMinutes(tz) {
  const now = new Date();
  if (!tz) {
    return { day: now.getDay(), minutesNow: now.getHours() * 60 + now.getMinutes() };
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const weekdayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    // hour12:false can emit '24' for midnight; treat as 0
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    const day = weekdayNames[weekday] ?? now.getDay();
    return { day, minutesNow: hour * 60 + minute };
  } catch {
    return { day: now.getDay(), minutesNow: now.getHours() * 60 + now.getMinutes() };
  }
}

class ScheduleEngine {
  constructor(dbOrClient) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient);
    this._windowState = new Map();   // churchId → boolean (was in window last poll?)
    this._openCallbacks = [];        // fn(churchId) — fired when window opens
    this._closeCallbacks = [];       // fn(churchId) — fired when window closes
    this._preServiceCallbacks = [];  // fn(churchId, nextService) — fired at T-30 before service
    this._preServiceSent = new Map(); // churchId::dayStart → true (dedup pre-service reminders)
    this._pollTimer = null;
    this._churchConfigCache = new Map();
    this._churchColumns = {
      service_times: true,
      schedule: true,
    };

    if (this.db) {
      this._ensureColumnSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client && !this.db) throw new Error('[ScheduleEngine] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureColumn();
    await this._loadCache();
  }

  _ensureColumnSync() {
    ensureColumnSync(this.db, 'churches', 'service_times', "TEXT DEFAULT '[]'");
    ensureColumnSync(this.db, 'churches', 'schedule', "TEXT DEFAULT '{}'");
    this._churchColumns.service_times = hasColumnSync(this.db, 'churches', 'service_times');
    this._churchColumns.schedule = hasColumnSync(this.db, 'churches', 'schedule');
  }

  async _ensureColumn() {
    const client = this._requireClient();
    await ensureColumn(client, 'churches', 'service_times', "TEXT DEFAULT '[]'");
    await ensureColumn(client, 'churches', 'schedule', "TEXT DEFAULT '{}'");
    this._churchColumns.service_times = await hasColumn(client, 'churches', 'service_times');
    this._churchColumns.schedule = await hasColumn(client, 'churches', 'schedule');
  }

  _churchSelectColumns() {
    return [
      'churchId AS "churchId"',
      this._churchColumns.service_times ? 'service_times' : "'[]' AS service_times",
      this._churchColumns.schedule ? 'schedule' : "'' AS schedule",
      'timezone',
      'church_type',
      'event_expires_at',
    ].join(', ');
  }

  _scheduleSelectColumns() {
    return [
      this._churchColumns.service_times ? 'service_times' : "'[]' AS service_times",
      this._churchColumns.schedule ? 'schedule' : "'' AS schedule",
    ].join(', ');
  }

  async _all(sql, params = []) {
    if (this.db) return this.db.prepare(sql).all(...params);
    await this.ready;
    return this._requireClient().query(sql, params);
  }

  async _run(sql, params = []) {
    if (this.db) return this.db.prepare(sql).run(...params);
    await this.ready;
    return this._requireClient().run(sql, params);
  }

  _normalizeChurchRow(row = {}) {
    return {
      churchId: row.churchId || row.church_id || null,
      serviceTimesRaw: row.service_times || '[]',
      scheduleRaw: row.schedule || '',
      timezone: row.timezone || '',
      churchType: row.church_type || '',
      eventExpiresAt: row.event_expires_at || null,
    };
  }

  _parseSchedule(serviceTimesRaw) {
    if (!serviceTimesRaw) return [];
    let parsed;
    try { parsed = JSON.parse(serviceTimesRaw); } catch { return []; }
    return this._normalizeToLegacy(parsed);
  }

  /**
   * Normalize schedule data to legacy array format [{day, startHour, startMin, durationHours}].
   * Handles both:
   *   - Legacy array: [{day:0, startHour:9, startMin:0, durationHours:2}]
   *   - Modern object: {"sunday": [{start:"09:00", end:"11:00", label:"..."}]}
   */
  _normalizeToLegacy(parsed) {
    if (!parsed) return [];

    // Already legacy array format — check first element for expected fields
    if (Array.isArray(parsed)) {
      if (!parsed.length) return [];
      if (typeof parsed[0].day === 'number' && parsed[0].startHour !== undefined) return parsed;
      // Array of modern-format entries without day key — can't map, return empty
      return [];
    }

    // Modern object format: { sunday: [{start, end, label}], ... }
    if (typeof parsed === 'object') {
      const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const result = [];
      for (const [dayName, entries] of Object.entries(parsed)) {
        const dayNum = dayMap[dayName.toLowerCase()];
        if (dayNum === undefined || !Array.isArray(entries)) continue;
        for (const entry of entries) {
          const start = entry.start || entry.startTime || '';
          const end = entry.end || entry.endTime || '';
          const startParts = String(start).split(':').map(Number);
          const endParts = String(end).split(':').map(Number);
          if (startParts.length < 2 || endParts.length < 2) continue;
          const startMin = (startParts[0] || 0) * 60 + (startParts[1] || 0);
          const endMin = (endParts[0] || 0) * 60 + (endParts[1] || 0);
          const durationMin = endMin > startMin ? endMin - startMin : 120;
          result.push({
            day: dayNum,
            startHour: startParts[0] || 0,
            startMin: startParts[1] || 0,
            durationHours: Math.round((durationMin / 60) * 100) / 100,
            label: entry.label || '',
          });
        }
      }
      return result;
    }

    return [];
  }

  _updateChurchCache(churchId, updates = {}) {
    if (!churchId) return;
    const existing = this._churchConfigCache.get(churchId) || {
      churchId,
      serviceTimesRaw: '[]',
      scheduleRaw: '',
      timezone: '',
      churchType: '',
      eventExpiresAt: null,
    };
    const next = { ...existing, ...updates, churchId };
    this._churchConfigCache.set(churchId, next);
    return next;
  }

  async _loadCache() {
    const rows = await this._requireClient().query(`
      SELECT ${this._churchSelectColumns()}
      FROM churches
    `);
    this._churchConfigCache.clear();
    for (const row of rows) {
      const normalized = this._normalizeChurchRow(row);
      this._churchConfigCache.set(normalized.churchId, normalized);
    }
  }

  _getChurchConfig(churchId) {
    if (this.db) return null;
    return this._churchConfigCache.get(churchId) || {
      churchId,
      serviceTimesRaw: '[]',
      scheduleRaw: '',
      timezone: '',
      churchType: '',
      eventExpiresAt: null,
    };
  }

  setSchedule(churchId, serviceTimes) {
    if (this.db) return this._setScheduleSync(churchId, serviceTimes);
    return this._setScheduleAsync(churchId, serviceTimes);
  }

  _setScheduleSync(churchId, serviceTimes) {
    this.db.prepare("UPDATE churches SET service_times = ? WHERE churchId = ?")
      .run(JSON.stringify(serviceTimes), churchId);
  }

  async _setScheduleAsync(churchId, serviceTimes) {
    const serviceTimesRaw = JSON.stringify(serviceTimes);
    this._updateChurchCache(churchId, { serviceTimesRaw });
    await this.ready;
    await this._run("UPDATE churches SET service_times = ? WHERE churchId = ?", [serviceTimesRaw, churchId]);
  }

  getSchedule(churchId) {
    if (!this.db) {
      const config = this._getChurchConfig(churchId);
      const fromServiceTimes = this._parseSchedule(config.serviceTimesRaw);
      if (fromServiceTimes.length) return fromServiceTimes;
      // Fall back to the schedule column (modern format used by the portal schedule page)
      return this._parseSchedule(config.scheduleRaw);
    }
    const row = this.db.prepare(`SELECT ${this._scheduleSelectColumns()} FROM churches WHERE churchId = ?`).get(churchId);
    if (!row) return [];
    const fromServiceTimes = this._parseSchedule(row.service_times);
    if (fromServiceTimes.length) return fromServiceTimes;
    return this._parseSchedule(row.schedule);
  }

  /** Fetch the church's IANA timezone (empty string if unknown). */
  _getTimezone(churchId) {
    if (!this.db) {
      return this._getChurchConfig(churchId).timezone || '';
    }
    try {
      const row = this.db.prepare('SELECT timezone FROM churches WHERE churchId = ?').get(churchId);
      return row?.timezone || '';
    } catch { return ''; }
  }

  isServiceWindow(churchId) {
    // Event churches treat their entire monitoring window as one service window
    try {
      if (!this.db) {
        const row = this._getChurchConfig(churchId);
        if (row && row.churchType === 'event') {
          if (!row.eventExpiresAt) return true;
          return new Date(row.eventExpiresAt) > new Date();
        }
      } else {
        const row = this.db.prepare("SELECT church_type, event_expires_at FROM churches WHERE churchId = ?").get(churchId);
        if (row && row.church_type === 'event') {
          if (!row.event_expires_at) return true;
          return new Date(row.event_expires_at) > new Date();
        }
      }
    } catch (err) { /* column may not exist yet on very first run */ console.debug("[scheduleEngine] intentional swallow:", err); }

    const schedule = this.getSchedule(churchId);
    if (!schedule.length) return false;

    const tz = this._getTimezone(churchId);
    const { day, minutesNow } = _getLocalDayMinutes(tz);
    const nowWeekMinutes = day * 24 * 60 + minutesNow;
    const BUFFER = 30;
    const WEEK_MINUTES = 7 * 24 * 60;

    for (const s of schedule) {
      const startOfDay = s.startHour * 60 + (s.startMin || 0);
      const durationMinutes = (s.durationHours || 2) * 60;
      const baseStart = s.day * 24 * 60 + startOfDay;

      for (const offset of [-WEEK_MINUTES, 0, WEEK_MINUTES]) {
        const start = baseStart + offset;
        const end = start + durationMinutes;
        if (nowWeekMinutes >= start - BUFFER && nowWeekMinutes <= end + BUFFER) {
          return true;
        }
      }
    }
    return false;
  }

  // ─── WINDOW OPEN/CLOSE CALLBACKS ───────────────────────────────────────────

  /**
   * Register a callback that fires whenever a service window opens.
   * @param {function(churchId: string): (void|Promise<void>)} fn
   */
  addWindowOpenCallback(fn) {
    this._openCallbacks.push(fn);
  }

  /**
   * Register a callback that fires whenever a service window closes.
   * @param {function(churchId: string): (void|Promise<void>)} fn
   */
  addWindowCloseCallback(fn) {
    this._closeCallbacks.push(fn);
  }

  /**
   * Register a callback that fires ~30 minutes before a service window opens.
   * @param {function(churchId: string, nextService: object): (void|Promise<void>)} fn
   */
  addPreServiceCallback(fn) {
    this._preServiceCallbacks.push(fn);
  }

  _invokeCallback(callback, args, errorContext) {
    try {
      Promise.resolve(callback(...args)).catch((e) => {
        log.error(errorContext.message, {
          event: errorContext.event,
          churchId: errorContext.churchId,
          error: e.message,
        });
      });
    } catch (e) {
      log.error(errorContext.message, {
        event: errorContext.event,
        churchId: errorContext.churchId,
        error: e.message,
      });
    }
  }

  /**
   * Start polling all churches every 60 seconds for window transitions.
   * Fires onWindowOpen / onWindowClose callbacks on state changes.
   */
  startPolling() {
    if (this.db) {
      this._pollWindows();
      this._pollTimer = setInterval(() => this._pollWindows(), 60 * 1000);
      return;
    }

    Promise.resolve(this.ready).then(() => {
      this._pollWindows();
      this._pollTimer = setInterval(() => this._pollWindows(), 60 * 1000);
    }).catch((e) => {
      log.error('schedule polling start failed', { event: 'schedule_poll_start_error', error: e.message });
    });
  }

  _pollWindows() {
    let churches;
    try {
      if (this.db) {
        churches = this.db.prepare('SELECT churchId FROM churches').all();
      } else {
        churches = [...this._churchConfigCache.values()].map((row) => ({ churchId: row.churchId }));
      }
    } catch (e) {
      log.error('poll error', { event: 'schedule_poll_error', error: e.message });
      return;
    }

    for (const { churchId } of churches) {
      const inWindow = this.isServiceWindow(churchId);
      const wasInWindow = this._windowState.get(churchId) || false;

      if (inWindow !== wasInWindow) {
        this._windowState.set(churchId, inWindow);
        if (inWindow) {
          // Window just opened
          for (const fn of this._openCallbacks) {
            this._invokeCallback(fn, [churchId], {
              message: 'onWindowOpen callback error',
              event: 'window_open_error',
              churchId,
            });
          }
        } else {
          // Window just closed
          for (const fn of this._closeCallbacks) {
            this._invokeCallback(fn, [churchId], {
              message: 'onWindowClose callback error',
              event: 'window_close_error',
              churchId,
            });
          }
        }
      } else {
        this._windowState.set(churchId, inWindow);
      }

      // Pre-service reminder: fire callbacks ~30 minutes before service
      if (!inWindow && this._preServiceCallbacks.length > 0) {
        const next = this.getNextService(churchId);
        if (next && next.minutesUntil > 25 && next.minutesUntil <= 35) {
          const dedupKey = `${churchId}::${next.day}::${next.startTime}`;
          if (!this._preServiceSent.has(dedupKey)) {
            this._preServiceSent.set(dedupKey, true);
            for (const fn of this._preServiceCallbacks) {
              this._invokeCallback(fn, [churchId, next], {
                message: 'preService callback error',
                event: 'pre_service_error',
                churchId,
              });
            }
            // Clean up old dedup entries (keep only current week)
            if (this._preServiceSent.size > 200) {
              const keys = [...this._preServiceSent.keys()];
              for (let i = 0; i < keys.length - 100; i++) this._preServiceSent.delete(keys[i]);
            }
          }
        }
      }
    }
  }

  getNextService(churchId) {
    const schedule = this.getSchedule(churchId);
    if (!schedule.length) return null;

    const tz = this._getTimezone(churchId);
    const { day, minutesNow } = _getLocalDayMinutes(tz);

    let best = null;
    let bestMinutesUntil = Infinity;

    for (const s of schedule) {
      const start = s.startHour * 60 + (s.startMin || 0);
      let daysUntil = (s.day - day + 7) % 7;
      let minutesUntil = daysUntil * 24 * 60 + (start - minutesNow);
      if (minutesUntil <= 0) minutesUntil += 7 * 24 * 60;
      if (minutesUntil < bestMinutesUntil) {
        bestMinutesUntil = minutesUntil;
        best = { day: s.day, startTime: `${String(s.startHour).padStart(2,'0')}:${String(s.startMin||0).padStart(2,'0')}`, minutesUntil };
      }
    }
    return best;
  }
}

module.exports = { ScheduleEngine };
