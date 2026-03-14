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
      pc_writeback_enabled: 'INTEGER DEFAULT 0',
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
      signal: AbortSignal.timeout(10000),
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
    const allowedColumns = ['pc_app_id', 'pc_secret', 'pc_service_type_id', 'pc_sync_enabled'];
    const updates = [];
    const params = [];

    if (appId !== undefined && allowedColumns.includes('pc_app_id'))                { updates.push('pc_app_id = ?');          params.push(appId); }
    if (secret !== undefined && allowedColumns.includes('pc_secret'))               { updates.push('pc_secret = ?');           params.push(secret); }
    if (serviceTypeId !== undefined && allowedColumns.includes('pc_service_type_id')) { updates.push('pc_service_type_id = ?');  params.push(serviceTypeId); }
    if (syncEnabled !== undefined && allowedColumns.includes('pc_sync_enabled'))     { updates.push('pc_sync_enabled = ?');     params.push(syncEnabled ? 1 : 0); }

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

  // ─── WRITE-BACK — Push session recaps & data to Planning Center ──────────

  /**
   * Internal helper: build auth headers for a church's PC credentials.
   * @param {object} church - DB row with pc_app_id and pc_secret
   * @returns {{Authorization: string, 'Content-Type': string}}
   */
  _authHeaders(church) {
    const credentials = Buffer.from(`${church.pc_app_id}:${church.pc_secret}`).toString('base64');
    return {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Internal helper: load and validate a church for write-back operations.
   * @param {string} churchId
   * @returns {{church: object}|{error: {written: boolean, reason: string}}}
   */
  _loadChurchForWriteback(churchId) {
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return { error: { written: false, reason: 'Church not found' } };
    if (!church.pc_writeback_enabled) return { error: { written: false, reason: 'Write-back disabled' } };
    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      return { error: { written: false, reason: 'PC credentials not configured' } };
    }
    return { church };
  }

  /**
   * Internal helper: make a PC API request with error handling for rate limits and auth failures.
   * @param {string} url
   * @param {object} headers
   * @param {object} [options] - Additional fetch options (method, body, etc.)
   * @returns {Promise<Response>}
   * @throws {Error} With descriptive message for rate limits, auth failures, etc.
   */
  async _pcFetch(url, headers, options = {}) {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
      ...options,
    });

    if (!resp.ok) {
      const body = await resp.text();
      if (resp.status === 429) {
        throw new Error(`Planning Center rate limit exceeded (429): ${body.slice(0, 100)}`);
      }
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`Planning Center auth failure (${resp.status}): ${body.slice(0, 100)}`);
      }
      if (resp.status === 404) {
        throw new Error(`Planning Center resource not found (404): ${body.slice(0, 100)}`);
      }
      throw new Error(`Planning Center API error (${resp.status}): ${body.slice(0, 100)}`);
    }

    return resp;
  }

  /**
   * Push a full session recap to a Planning Center plan as a production note.
   * Includes: stream duration, alert count, auto-recoveries, grade,
   * peak viewers, recording status, and any incidents.
   *
   * @param {string} churchId
   * @param {string} planId  - The specific plan to write to
   * @param {object} recapData - Finalized session object from SessionRecap.endSession()
   * @returns {Promise<{written: boolean, planId?: string, reason?: string}>}
   */
  async pushSessionRecap(churchId, planId, recapData) {
    const loaded = this._loadChurchForWriteback(churchId);
    if (loaded.error) return loaded.error;
    const { church } = loaded;
    const headers = this._authHeaders(church);

    try {
      // Verify the plan exists
      const planUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${planId}`;
      await this._pcFetch(planUrl, headers);

      // Build comprehensive note text
      const grade = recapData.grade || 'N/A';
      const durationMin = recapData.durationMinutes || recapData.duration_minutes || 0;
      const hours = Math.floor(durationMin / 60);
      const mins = durationMin % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      const alerts = recapData.alertCount || recapData.alert_count || 0;
      const autoFixed = recapData.autoRecovered || recapData.auto_recovered_count || 0;
      const escalated = recapData.escalated || recapData.escalated_count || 0;
      const peakViewers = recapData.peakViewers || recapData.peak_viewers;
      const streamTotal = recapData.streamTotalMinutes || recapData.stream_runtime_minutes || 0;
      const streamRan = recapData.streaming !== undefined ? recapData.streaming : (recapData.stream_ran || streamTotal > 0);
      const recordingConfirmed = recapData.recordingConfirmed || recapData.recording_confirmed || false;
      const audioSilence = recapData.audioSilenceCount || recapData.audio_silence_count || 0;
      const tdName = recapData.tdName || recapData.td_name || 'Unknown';

      const streamLine = streamRan ? `Yes (${streamTotal} min)` : 'No';
      const viewersLine = peakViewers != null ? `${peakViewers}` : 'N/A';

      const lines = [
        `--- Tally Production Report ---`,
        `Grade: ${grade}`,
        `Duration: ${durationStr}`,
        `TD: ${tdName}`,
        `Stream: ${streamLine}`,
        `Peak Viewers: ${viewersLine}`,
        `Recording: ${recordingConfirmed ? 'Confirmed' : 'Not confirmed'}`,
        `Alerts: ${alerts} (${autoFixed} auto-recovered, ${escalated} escalated)`,
        `Audio silences: ${audioSilence}`,
      ];

      // Append incident details if any
      const alertTypes = recapData.alertTypes || {};
      if (Object.keys(alertTypes).length > 0) {
        lines.push('');
        lines.push('Incidents:');
        for (const [type, count] of Object.entries(alertTypes)) {
          lines.push(`  - ${type}: ${count}`);
        }
      }

      lines.push(`---`);

      const noteText = lines.join('\n');

      // POST the note to the plan
      const noteUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${planId}/notes`;
      await this._pcFetch(noteUrl, headers, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: noteText,
              category_name: 'Production',
            },
          },
        }),
      });

      console.log(`[PlanningCenter] Session recap pushed to plan ${planId} for ${church.name || churchId}`);
      return { written: true, planId };
    } catch (e) {
      console.warn(`[PlanningCenter] pushSessionRecap failed for ${church.name || churchId}: ${e.message}`);
      return { written: false, reason: e.message };
    }
  }

  /**
   * Update a Planning Center plan with actual start/end times (vs scheduled).
   *
   * @param {string} churchId
   * @param {string} planId
   * @param {{actualStart: string|Date, actualEnd: string|Date}} actualTimes
   * @returns {Promise<{updated: boolean, planId?: string, reason?: string}>}
   */
  async updateServiceTimes(churchId, planId, actualTimes) {
    const loaded = this._loadChurchForWriteback(churchId);
    if (loaded.error) return { updated: false, reason: loaded.error.reason };
    const { church } = loaded;
    const headers = this._authHeaders(church);

    try {
      const actualStart = actualTimes.actualStart instanceof Date
        ? actualTimes.actualStart.toISOString()
        : actualTimes.actualStart;
      const actualEnd = actualTimes.actualEnd instanceof Date
        ? actualTimes.actualEnd.toISOString()
        : actualTimes.actualEnd;

      const startTime = new Date(actualStart);
      const endTime = new Date(actualEnd);
      const startStr = startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const endStr = endTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

      // Post actual times as a note (PC API doesn't have a direct "actual time" field on plans)
      const noteUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${planId}/notes`;
      await this._pcFetch(noteUrl, headers, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: `--- Actual Service Times ---\nStart: ${startStr} (${actualStart})\nEnd: ${endStr} (${actualEnd})\n---`,
              category_name: 'Production',
            },
          },
        }),
      });

      console.log(`[PlanningCenter] Service times updated on plan ${planId} for ${church.name || churchId}`);
      return { updated: true, planId };
    } catch (e) {
      console.warn(`[PlanningCenter] updateServiceTimes failed for ${church.name || churchId}: ${e.message}`);
      return { updated: false, reason: e.message };
    }
  }

  /**
   * Sync volunteer/TD attendance to a Planning Center plan.
   * Matches active guest tokens against plan team members by name
   * and confirms their attendance.
   *
   * @param {string} churchId
   * @param {string} planId
   * @param {Array<{token: string, name: string, churchId: string}>} activeTokens - Currently active guest tokens
   * @returns {Promise<{synced: boolean, matched: number, total: number, reason?: string}>}
   */
  async syncVolunteerAttendance(churchId, planId, activeTokens) {
    const loaded = this._loadChurchForWriteback(churchId);
    if (loaded.error) return { synced: false, matched: 0, total: 0, reason: loaded.error.reason };
    const { church } = loaded;
    const headers = this._authHeaders(church);

    try {
      // Fetch team members for this plan
      const teamUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${planId}/team_members`;
      const teamResp = await this._pcFetch(teamUrl, headers);
      const teamData = await teamResp.json();
      const teamMembers = teamData.data || [];

      if (!teamMembers.length) {
        return { synced: true, matched: 0, total: 0 };
      }

      // Build a set of active volunteer names (lowercase for matching)
      const activeNames = new Set(
        activeTokens
          .filter(t => t.churchId === churchId)
          .map(t => (t.name || '').toLowerCase().trim())
          .filter(Boolean)
      );

      let matched = 0;

      for (const member of teamMembers) {
        const memberName = (member.attributes?.name || '').toLowerCase().trim();
        if (!memberName) continue;

        // Check if this team member was active (match by name)
        const isActive = activeNames.has(memberName) ||
          [...activeNames].some(n => memberName.includes(n) || n.includes(memberName));

        if (isActive) {
          // Confirm attendance via PATCH
          try {
            const memberUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${planId}/team_members/${member.id}`;
            await this._pcFetch(memberUrl, headers, {
              method: 'PATCH',
              body: JSON.stringify({
                data: {
                  type: 'TeamMember',
                  id: member.id,
                  attributes: {
                    status: 'C', // Confirmed
                  },
                },
              }),
            });
            matched++;
          } catch (e) {
            console.warn(`[PlanningCenter] Could not confirm attendance for ${member.attributes?.name}: ${e.message}`);
          }
        }
      }

      console.log(`[PlanningCenter] Volunteer attendance synced: ${matched}/${teamMembers.length} matched for plan ${planId}`);
      return { synced: true, matched, total: teamMembers.length };
    } catch (e) {
      console.warn(`[PlanningCenter] syncVolunteerAttendance failed for ${church.name || churchId}: ${e.message}`);
      return { synced: false, matched: 0, total: 0, reason: e.message };
    }
  }

  /**
   * Fetch upcoming plans with service type info for a church.
   *
   * @param {string} churchId
   * @param {number} [days=7] - Number of days to look ahead
   * @returns {Promise<{plans: Array<{planId, date, title, serviceTypeName, dayName, startTime}>, reason?: string}>}
   */
  async getUpcomingPlans(churchId, days = 7) {
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) throw new Error('Church not found');
    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      throw new Error('Planning Center credentials not configured for this church');
    }

    const headers = this._authHeaders(church);

    // Fetch the service type name
    let serviceTypeName = 'Unknown';
    try {
      const stUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}`;
      const stResp = await this._pcFetch(stUrl, headers);
      const stData = await stResp.json();
      serviceTypeName = stData.data?.attributes?.name || 'Unknown';
    } catch {
      // Non-fatal — continue with 'Unknown' service type name
    }

    // Fetch future plans
    const url = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans?filter=future&per_page=25&order=sort_date`;
    const resp = await this._pcFetch(url, headers);
    const data = await resp.json();
    const plans = data.data || [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + days);

    return plans
      .map(plan => {
        const sortDate = plan.attributes?.sort_date;
        if (!sortDate) return null;
        const date = new Date(sortDate);
        if (date > cutoff) return null;
        return {
          planId:          plan.id,
          date:            date.toISOString(),
          title:           plan.attributes?.title || `Service (${date.toLocaleDateString()})`,
          serviceTypeName,
          dayName:         DAYS[date.getDay()],
          startTime:       `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
        };
      })
      .filter(Boolean);
  }

  // ─── WRITE-BACK — Push production notes to Planning Center ────────────────

  /**
   * Write production notes back to the most recent Planning Center plan.
   * Called after each service session ends (from scheduleEngine close callback).
   *
   * @param {string} churchId
   * @param {object} sessionData - From sessionRecap.endSession()
   * @returns {Promise<{written: boolean, planId?: string}>}
   */
  async writeServiceNotes(churchId, sessionData) {
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return { written: false, reason: 'Church not found' };

    if (!church.pc_writeback_enabled) return { written: false, reason: 'Write-back disabled' };
    if (!church.pc_app_id || !church.pc_secret || !church.pc_service_type_id) {
      return { written: false, reason: 'PC credentials not configured' };
    }

    try {
      // Find the most recent plan (past, today's)
      const credentials = Buffer.from(`${church.pc_app_id}:${church.pc_secret}`).toString('base64');
      const url = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans?filter=past&per_page=1&order=-sort_date`;

      const resp = await fetch(url, {
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) throw new Error(`PC API ${resp.status}`);
      const data = await resp.json();
      const plan = data.data?.[0];
      if (!plan) return { written: false, reason: 'No recent plan found' };

      // Build production notes
      const grade = sessionData.grade || 'N/A';
      const duration = sessionData.duration_minutes ? `${sessionData.duration_minutes} min` : 'Unknown';
      const alerts = sessionData.alert_count || 0;
      const autoFixed = sessionData.auto_recovered_count || 0;
      const stream = sessionData.stream_ran ? `Yes (${sessionData.stream_runtime_minutes || 0} min)` : 'No';
      const tdName = sessionData.td_name || 'Unknown';

      const noteText = [
        `--- Tally Production Report ---`,
        `Grade: ${grade}`,
        `Duration: ${duration}`,
        `TD: ${tdName}`,
        `Stream: ${stream}`,
        `Alerts: ${alerts} (${autoFixed} auto-recovered)`,
        `Audio silences: ${sessionData.audio_silence_count || 0}`,
        `Recording confirmed: ${sessionData.recording_confirmed ? 'Yes' : 'No'}`,
        `---`,
      ].join('\n');

      // POST a note to the plan
      const noteUrl = `${PC_API_BASE}/service_types/${church.pc_service_type_id}/plans/${plan.id}/notes`;
      const noteResp = await fetch(noteUrl, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: {
            type: 'PlanNote',
            attributes: {
              content: noteText,
              category_name: 'Production',
            },
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!noteResp.ok) {
        const body = await noteResp.text();
        throw new Error(`Note POST failed ${noteResp.status}: ${body.slice(0, 100)}`);
      }

      console.log(`[PlanningCenter] ✅ Production notes written to plan ${plan.id} for ${church.name || churchId}`);
      return { written: true, planId: plan.id };
    } catch (e) {
      console.warn(`[PlanningCenter] ⚠️ Write-back failed for ${church.name || churchId}: ${e.message}`);
      return { written: false, reason: e.message };
    }
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
