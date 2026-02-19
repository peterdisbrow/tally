/**
 * Planning Center Integration
 * Pulls upcoming service times from planningcenteronline.com and syncs
 * them into the scheduleEngine so churches don't have to enter times manually.
 *
 * Auth: Personal Access Token — each church supplies their own App ID + Secret.
 * (https://api.planningcenteronline.com/oauth/applications)
 */

const PC_API_BASE = 'https://api.planningcenteronline.com/services/v2';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class PlanningCenter {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db;
    this._scheduleEngine = null;
    this._syncTimer = null;
    this._ensureColumns();
  }

  /** Inject the ScheduleEngine so syncs update it directly. */
  setScheduleEngine(scheduleEngine) {
    this._scheduleEngine = scheduleEngine;
  }

  _ensureColumns() {
    const cols = {
      pc_app_id:          'TEXT',
      pc_secret:          'TEXT',
      pc_service_type_id: 'TEXT',
      pc_sync_enabled:    'INTEGER DEFAULT 0',
      pc_last_synced:     'TEXT',
    };
    for (const [col, type] of Object.entries(cols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${type}`);
      }
    }
  }

  // ─── PLANNING CENTER API ─────────────────────────────────────────────────────

  /**
   * Fetch upcoming service plans from Planning Center.
   * @param {string} appId
   * @param {string} secret
   * @param {string} serviceTypeId
   * @returns {Promise<Array<{planId, date, dayOfWeek, dayName, startHour, startMin, startTime, title}>>}
   */
  async getUpcomingServices(appId, secret, serviceTypeId) {
    const credentials = Buffer.from(`${appId}:${secret}`).toString('base64');
    const url = `${PC_API_BASE}/service_types/${serviceTypeId}/plans?filter=future&per_page=10&order=sort_date`;

    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
      },
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Planning Center API error ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const plans = data.data || [];

    return plans.map(plan => {
      const sortDate = plan.attributes?.sort_date;
      if (!sortDate) return null;
      const date = new Date(sortDate);
      return {
        planId:    plan.id,
        date:      date.toISOString(),
        dayOfWeek: date.getDay(),
        dayName:   DAYS[date.getDay()],
        startHour: date.getHours(),
        startMin:  date.getMinutes(),
        startTime: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
        title:     plan.attributes?.title || `Service (${date.toLocaleDateString()})`,
      };
    }).filter(Boolean);
  }

  /**
   * Convenience wrapper — loads credentials from DB for a church.
   * @param {string} churchId
   */
  async getUpcomingServicesForChurch(churchId) {
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) throw new Error('Church not found');
    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      throw new Error('Planning Center credentials not configured for this church');
    }
    return this.getUpcomingServices(church.pc_app_id, church.pc_secret, church.pc_service_type_id);
  }

  // ─── SYNC ────────────────────────────────────────────────────────────────────

  /**
   * Sync one church's schedule from Planning Center.
   * On success: updates scheduleEngine with deduplicated (day, time) entries.
   * On failure: logs a warning and leaves existing schedule intact.
   * @param {string} churchId
   * @returns {Promise<{synced: number, services: Array}>}
   */
  async syncChurch(churchId) {
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) throw new Error(`Church ${churchId} not found`);

    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      throw new Error(`Church "${church.name}" has no Planning Center credentials configured`);
    }

    if (!church.pc_sync_enabled) {
      throw new Error(`Planning Center sync is disabled for "${church.name}"`);
    }

    console.log(`[PlanningCenter] Syncing schedule for ${church.name}...`);

    const services = await this.getUpcomingServices(
      church.pc_app_id,
      church.pc_secret,
      church.pc_service_type_id
    );

    if (!services.length) {
      console.log(`[PlanningCenter] No upcoming services found for ${church.name}`);
      return { synced: 0, services: [] };
    }

    // Deduplicate by day+time (multiple upcoming instances of same recurring service)
    const seen = new Set();
    const serviceTimes = [];

    for (const svc of services) {
      const key = `${svc.dayOfWeek}:${svc.startHour}:${svc.startMin}`;
      if (!seen.has(key)) {
        seen.add(key);
        serviceTimes.push({
          day:          svc.dayOfWeek,
          startHour:    svc.startHour,
          startMin:     svc.startMin,
          durationHours: 2,          // default; override manually if needed
          source:       'planning_center',
        });
      }
    }

    // Apply to scheduleEngine (or DB directly as fallback)
    if (this._scheduleEngine) {
      this._scheduleEngine.setSchedule(churchId, serviceTimes);
    } else {
      this.db.prepare('UPDATE churches SET service_times = ? WHERE churchId = ?')
        .run(JSON.stringify(serviceTimes), churchId);
    }

    // Persist last-synced timestamp
    this.db.prepare('UPDATE churches SET pc_last_synced = ? WHERE churchId = ?')
      .run(new Date().toISOString(), churchId);

    console.log(`[PlanningCenter] ✅ ${church.name}: synced ${serviceTimes.length} unique service time(s)`);
    return { synced: serviceTimes.length, services: serviceTimes };
  }

  /**
   * Sync all churches that have pc_sync_enabled = 1.
   * Failures are caught per-church so one bad credential doesn't block others.
   */
  async syncAll() {
    const churches = this.db.prepare('SELECT churchId, name FROM churches WHERE pc_sync_enabled = 1').all();
    if (!churches.length) return;

    console.log(`[PlanningCenter] Running sync for ${churches.length} church(es)...`);

    for (const church of churches) {
      try {
        await this.syncChurch(church.churchId);
      } catch (e) {
        console.warn(`[PlanningCenter] ⚠️ Sync failed for ${church.name}: ${e.message} — keeping existing schedule`);
      }
    }
  }

  // ─── CREDENTIALS ─────────────────────────────────────────────────────────────

  /**
   * Persist Planning Center credentials for a church.
   * Only updates fields that are provided (undefined = leave unchanged).
   * @param {string} churchId
   * @param {{appId?, secret?, serviceTypeId?, syncEnabled?}} opts
   */
  setCredentials(churchId, { appId, secret, serviceTypeId, syncEnabled }) {
    const updates = [];
    const params = [];

    if (appId !== undefined)         { updates.push('pc_app_id = ?');          params.push(appId); }
    if (secret !== undefined)        { updates.push('pc_secret = ?');           params.push(secret); }
    if (serviceTypeId !== undefined) { updates.push('pc_service_type_id = ?');  params.push(serviceTypeId); }
    if (syncEnabled !== undefined)   { updates.push('pc_sync_enabled = ?');     params.push(syncEnabled ? 1 : 0); }

    if (!updates.length) return;
    params.push(churchId);
    this.db.prepare(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`).run(...params);
  }

  /**
   * Return safe public status (NEVER includes credentials).
   * @param {string} churchId
   * @returns {{syncEnabled, serviceTypeId, lastSynced, nextService}|null}
   */
  getStatus(churchId) {
    const church = this.db.prepare(
      'SELECT pc_sync_enabled, pc_service_type_id, pc_last_synced, service_times FROM churches WHERE churchId = ?'
    ).get(churchId);
    if (!church) return null;

    // Compute next PC-sourced service
    let nextService = null;
    try {
      const times = JSON.parse(church.service_times || '[]');
      const pcTimes = times.filter(t => t.source === 'planning_center');
      if (pcTimes.length) {
        const now = new Date();
        const day = now.getDay();
        const minutesNow = now.getHours() * 60 + now.getMinutes();
        let bestMinutes = Infinity;

        for (const t of pcTimes) {
          const start = t.startHour * 60 + (t.startMin || 0);
          let daysUntil = (t.day - day + 7) % 7;
          let minsUntil = daysUntil * 1440 + (start - minutesNow);
          if (minsUntil <= 0) minsUntil += 7 * 1440;
          if (minsUntil < bestMinutes) {
            bestMinutes = minsUntil;
            nextService = {
              day:       DAYS[t.day],
              startTime: `${String(t.startHour).padStart(2, '0')}:${String(t.startMin || 0).padStart(2, '0')}`,
              minutesUntil: minsUntil,
            };
          }
        }
      }
    } catch { /* ignore parse errors */ }

    return {
      syncEnabled:    !!church.pc_sync_enabled,
      serviceTypeId:  church.pc_service_type_id || null,
      lastSynced:     church.pc_last_synced || null,
      nextService,
    };
  }

  // ─── LIFECYCLE ────────────────────────────────────────────────────────────────

  /** Start the 6-hour background sync. */
  start() {
    // Immediate first run, then every 6 hours
    this.syncAll().catch(e => console.error('[PlanningCenter] initial sync error:', e.message));

    this._syncTimer = setInterval(
      () => this.syncAll().catch(e => console.error('[PlanningCenter] syncAll error:', e.message)),
      6 * 60 * 60 * 1000
    );

    console.log('[PlanningCenter] Started — syncing every 6 hours');
  }

  stop() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }
}

module.exports = { PlanningCenter };
