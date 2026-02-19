/**
 * Schedule Engine — Service window management per church
 */

class ScheduleEngine {
  constructor(db) {
    this.db = db;
    this._windowState = new Map();   // churchId → boolean (was in window last poll?)
    this._openCallbacks = [];        // fn(churchId) — fired when window opens
    this._closeCallbacks = [];       // fn(churchId) — fired when window closes
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
    const now = new Date();
    const day = now.getDay();
    const minutesNow = now.getHours() * 60 + now.getMinutes();
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
      console.error('[ScheduleEngine] poll error:', e.message);
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
            try { fn(churchId); } catch (e) { console.error('[ScheduleEngine] onWindowOpen error:', e.message); }
          }
        } else {
          // Window just closed
          for (const fn of this._closeCallbacks) {
            try { fn(churchId); } catch (e) { console.error('[ScheduleEngine] onWindowClose error:', e.message); }
          }
        }
      } else {
        this._windowState.set(churchId, inWindow);
      }
    }
  }

  getNextService(churchId) {
    const schedule = this.getSchedule(churchId);
    if (!schedule.length) return null;
    const now = new Date();
    const day = now.getDay();
    const minutesNow = now.getHours() * 60 + now.getMinutes();

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
