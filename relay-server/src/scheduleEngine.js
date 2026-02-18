/**
 * Schedule Engine — Service window management per church
 */

class ScheduleEngine {
  constructor(db) {
    this.db = db;
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
