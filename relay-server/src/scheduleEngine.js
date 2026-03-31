/**
 * Schedule Engine — Service window management per church
 */

const { createLogger } = require('./logger');
const log = createLogger('ScheduleEngine');

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
  constructor(db) {
    this.db = db;
    this._windowState = new Map();   // churchId → boolean (was in window last poll?)
    this._openCallbacks = [];        // fn(churchId) — fired when window opens
    this._closeCallbacks = [];       // fn(churchId) — fired when window closes
    this._preServiceCallbacks = [];  // fn(churchId, nextService) — fired at T-30 before service
    this._preServiceSent = new Map(); // churchId::dayStart → true (dedup pre-service reminders)
    this._pollTimer = null;
    this._ensureColumn();
  }

  _ensureColumn() {
    try {
      this.db.prepare("SELECT service_times FROM churches LIMIT 1").get();
    } catch {
      this.db.exec("ALTER TABLE churches ADD COLUMN service_times TEXT DEFAULT '[]'");
    }
  }

  setSchedule(churchId, serviceTimes) {
    this.db.prepare("UPDATE churches SET service_times = ? WHERE churchId = ?")
      .run(JSON.stringify(serviceTimes), churchId);
  }

  getSchedule(churchId) {
    const row = this.db.prepare("SELECT service_times FROM churches WHERE churchId = ?").get(churchId);
    if (!row || !row.service_times) return [];
    try { return JSON.parse(row.service_times); } catch { return []; }
  }

  /** Fetch the church's IANA timezone (empty string if unknown). */
  _getTimezone(churchId) {
    try {
      const row = this.db.prepare('SELECT timezone FROM churches WHERE churchId = ?').get(churchId);
      return row?.timezone || '';
    } catch { return ''; }
  }

  isServiceWindow(churchId) {
    // Event churches treat their entire monitoring window as one service window
    try {
      const row = this.db.prepare("SELECT church_type, event_expires_at FROM churches WHERE churchId = ?").get(churchId);
      if (row && row.church_type === 'event') {
        // Return true if the event hasn't expired yet
        if (!row.event_expires_at) return true;
        return new Date(row.event_expires_at) > new Date();
      }
    } catch { /* column may not exist yet on very first run */ }

    const schedule = this.getSchedule(churchId);
    if (!schedule.length) return false;

    const tz = this._getTimezone(churchId);
    const { day, minutesNow } = _getLocalDayMinutes(tz);
    const BUFFER = 30;

    for (const s of schedule) {
      if (s.day !== day) continue;
      const start = s.startHour * 60 + (s.startMin || 0);
      const end = start + (s.durationHours || 2) * 60;
      if (minutesNow >= start - BUFFER && minutesNow <= end + BUFFER) return true;
    }
    return false;
  }

  // ─── WINDOW OPEN/CLOSE CALLBACKS ───────────────────────────────────────────

  /**
   * Register a callback that fires whenever a service window opens.
   * @param {function(churchId: string): void} fn
   */
  addWindowOpenCallback(fn) {
    this._openCallbacks.push(fn);
  }

  /**
   * Register a callback that fires whenever a service window closes.
   * @param {function(churchId: string): void} fn
   */
  addWindowCloseCallback(fn) {
    this._closeCallbacks.push(fn);
  }

  /**
   * Register a callback that fires ~30 minutes before a service window opens.
   * @param {function(churchId: string, nextService: object): void} fn
   */
  addPreServiceCallback(fn) {
    this._preServiceCallbacks.push(fn);
  }

  /**
   * Start polling all churches every 60 seconds for window transitions.
   * Fires onWindowOpen / onWindowClose callbacks on state changes.
   */
  startPolling() {
    this._pollWindows(); // immediate check
    this._pollTimer = setInterval(() => this._pollWindows(), 60 * 1000);
  }

  _pollWindows() {
    let churches;
    try {
      churches = this.db.prepare('SELECT churchId FROM churches').all();
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
            try { fn(churchId); } catch (e) { log.error('onWindowOpen callback error', { event: 'window_open_error', churchId, error: e.message }); }
          }
        } else {
          // Window just closed
          for (const fn of this._closeCallbacks) {
            try { fn(churchId); } catch (e) { log.error('onWindowClose callback error', { event: 'window_close_error', churchId, error: e.message }); }
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
              try { fn(churchId, next); } catch (e) { log.error('preService callback error', { event: 'pre_service_error', churchId, error: e.message }); }
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
