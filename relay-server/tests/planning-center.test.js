import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { PlanningCenter } = require('../src/planningCenter');
const { ScheduleEngine } = require('../src/scheduleEngine');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL
    )
  `);
  return db;
}

function seedChurch(db, churchId, { name = 'Test Church', pcEnabled = true, appId = 'app_123', secret = 'secret_456', serviceTypeId = 'stype_1' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(churchId, name, `${churchId}@test.local`, `tok-${churchId}`, now);

  // PlanningCenter constructor adds these columns via _ensureColumns
  try {
    db.prepare('UPDATE churches SET pc_app_id = ?, pc_secret = ?, pc_service_type_id = ?, pc_sync_enabled = ? WHERE churchId = ?')
      .run(appId, secret, serviceTypeId, pcEnabled ? 1 : 0, churchId);
  } catch {
    // columns might not exist yet
  }
}

/**
 * Build a Planning Center API response with plan data.
 */
function makePCResponse(plans) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: plans }),
    json: async () => ({ data: plans }),
  };
}

function makePlan(id, sortDate, title = 'Sunday Service') {
  return {
    id,
    type: 'Plan',
    attributes: {
      sort_date: sortDate,
      title,
    },
  };
}

describe('PlanningCenter — API sync and data transformation', () => {
  let db;
  let pc;
  let scheduleEngine;
  let fetchSpy;
  const churchId = 'church_pc_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    scheduleEngine = new ScheduleEngine(db);
    pc.setScheduleEngine(scheduleEngine);

    seedChurch(db, churchId);

    // Mock global fetch
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  // ── 1. API sync — fetching services/plans ──────────────────────────────────

  it('fetches upcoming services from Planning Center API', async () => {
    const nextSunday = new Date();
    nextSunday.setDate(nextSunday.getDate() + (7 - nextSunday.getDay()));
    nextSunday.setHours(10, 0, 0, 0);

    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', nextSunday.toISOString(), 'Morning Service'),
    ]));

    const services = await pc.getUpcomingServicesForChurch(churchId);
    expect(services.length).toBe(1);
    expect(services[0].planId).toBe('plan_1');
    expect(services[0].title).toBe('Morning Service');
    expect(services[0].startHour).toBe(10);
    expect(services[0].startMin).toBe(0);

    // Verify fetch was called with correct URL pattern and auth header
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('service_types/stype_1/plans');
    expect(url).toContain('filter=future');
    expect(opts.headers.Authorization).toMatch(/^Basic /);
  });

  it('throws when church has no PC credentials', async () => {
    const noCredChurch = 'church_no_creds';
    const now = new Date().toISOString();
    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run(noCredChurch, 'No Creds', 'nc@test.local', 'tok', now);

    await expect(pc.getUpcomingServicesForChurch(noCredChurch))
      .rejects.toThrow(/credentials not configured/i);
  });

  it('throws when church does not exist', async () => {
    await expect(pc.getUpcomingServicesForChurch('nonexistent'))
      .rejects.toThrow(/not found/i);
  });

  // ── 2. Data transformation (PC format -> Tally format) ─────────────────────

  it('transforms PC plan data into service time entries', async () => {
    const sunday = new Date('2026-03-15T09:30:00');
    const wednesday = new Date('2026-03-18T19:00:00');

    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', sunday.toISOString(), 'Sunday AM'),
      makePlan('plan_2', wednesday.toISOString(), 'Wednesday PM'),
    ]));

    const result = await pc.syncChurch(churchId);
    expect(result.synced).toBe(2);

    const schedule = scheduleEngine.getSchedule(churchId);
    expect(schedule.length).toBe(2);

    // Each entry should have the Tally format
    for (const entry of schedule) {
      expect(entry).toHaveProperty('day');
      expect(entry).toHaveProperty('startHour');
      expect(entry).toHaveProperty('startMin');
      expect(entry).toHaveProperty('durationHours', 2);
      expect(entry).toHaveProperty('source', 'planning_center');
    }
  });

  it('deduplicates service times with same day+time', async () => {
    // Two Sundays at the same time (recurring weekly pattern)
    const sunday1 = new Date('2026-03-15T10:00:00');
    const sunday2 = new Date('2026-03-22T10:00:00');

    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', sunday1.toISOString(), 'Sunday 1'),
      makePlan('plan_2', sunday2.toISOString(), 'Sunday 2'),
    ]));

    const result = await pc.syncChurch(churchId);
    expect(result.synced).toBe(1); // Deduplicated to 1

    const schedule = scheduleEngine.getSchedule(churchId);
    expect(schedule.length).toBe(1);
  });

  it('handles plans with missing sort_date', async () => {
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      { id: 'plan_null', type: 'Plan', attributes: { sort_date: null, title: 'Bad Plan' } },
      makePlan('plan_good', new Date('2026-03-15T10:00:00').toISOString()),
    ]));

    const services = await pc.getUpcomingServices('app_123', 'secret_456', 'stype_1');
    expect(services.length).toBe(1);
    expect(services[0].planId).toBe('plan_good');
  });

  it('returns zero services when API returns empty list', async () => {
    fetchSpy.mockResolvedValueOnce(makePCResponse([]));

    const result = await pc.syncChurch(churchId);
    expect(result.synced).toBe(0);
    expect(result.services).toEqual([]);
  });

  // ── 3. Incremental sync — timestamp tracking ──────────────────────────────

  it('updates pc_last_synced timestamp after successful sync', async () => {
    const before = new Date().toISOString();

    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', new Date('2026-03-15T10:00:00').toISOString()),
    ]));

    await pc.syncChurch(churchId);

    const church = db.prepare('SELECT pc_last_synced FROM churches WHERE churchId = ?').get(churchId);
    expect(church.pc_last_synced).toBeTruthy();
    expect(new Date(church.pc_last_synced).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('does not update pc_last_synced on sync failure', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal Server Error' });

    await expect(pc.syncChurch(churchId)).rejects.toThrow(/API error 500/);

    const church = db.prepare('SELECT pc_last_synced FROM churches WHERE churchId = ?').get(churchId);
    expect(church.pc_last_synced).toBeNull();
  });

  // ── 4. Error handling ──────────────────────────────────────────────────────

  it('throws on API rate limit (429)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'Rate limited' });

    await expect(pc.getUpcomingServices('app_123', 'secret_456', 'stype_1'))
      .rejects.toThrow(/API error 429/);
  });

  it('throws on auth failure (401)', async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });

    await expect(pc.getUpcomingServices('app_123', 'bad_secret', 'stype_1'))
      .rejects.toThrow(/API error 401/);
  });

  it('throws on network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('fetch failed'));

    await expect(pc.getUpcomingServices('app_123', 'secret_456', 'stype_1'))
      .rejects.toThrow(/fetch failed/);
  });

  it('throws when sync is disabled for the church', async () => {
    db.prepare('UPDATE churches SET pc_sync_enabled = 0 WHERE churchId = ?').run(churchId);

    await expect(pc.syncChurch(churchId))
      .rejects.toThrow(/sync is disabled/i);
  });

  // ── 5. Service plan parsing ────────────────────────────────────────────────

  it('parses startTime as formatted HH:MM string', async () => {
    const date = new Date('2026-03-15T08:05:00');
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', date.toISOString(), 'Early Service'),
    ]));

    const services = await pc.getUpcomingServices('app_123', 'secret_456', 'stype_1');
    expect(services[0].startTime).toBe('08:05');
    expect(services[0].startHour).toBe(8);
    expect(services[0].startMin).toBe(5);
  });

  it('includes dayName and dayOfWeek in parsed data', async () => {
    // 2026-03-15 is a Sunday
    const date = new Date('2026-03-15T10:00:00');
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', date.toISOString(), 'Sunday'),
    ]));

    const services = await pc.getUpcomingServices('app_123', 'secret_456', 'stype_1');
    expect(services[0].dayOfWeek).toBe(date.getDay());
    expect(services[0].dayName).toBeTruthy();
  });

  it('generates a default title when plan has no title', async () => {
    const date = new Date('2026-03-15T10:00:00');
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      { id: 'plan_no_title', type: 'Plan', attributes: { sort_date: date.toISOString() } },
    ]));

    const services = await pc.getUpcomingServices('app_123', 'secret_456', 'stype_1');
    expect(services[0].title).toContain('Service');
  });

  // ── syncAll — per-church error isolation ───────────────────────────────────

  it('syncAll continues on per-church failure', async () => {
    const churchId2 = 'church_pc_2';
    seedChurch(db, churchId2, { name: 'Church 2' });

    // First church fails
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' });
    // Second church succeeds
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_ok', new Date('2026-03-15T10:00:00').toISOString()),
    ]));

    // Should not throw — errors are caught per-church
    await pc.syncAll();

    // Second church should have its schedule updated
    const schedule2 = scheduleEngine.getSchedule(churchId2);
    expect(schedule2.length).toBe(1);
  });

  it('syncAll skips churches with sync disabled', async () => {
    db.prepare('UPDATE churches SET pc_sync_enabled = 0 WHERE churchId = ?').run(churchId);

    await pc.syncAll();
    // fetch should not have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('PlanningCenter — credentials management', () => {
  let db;
  let pc;
  const churchId = 'church_cred_1';

  beforeEach(() => {
    db = createDb();
    // Instantiate ScheduleEngine to ensure service_times column exists
    new ScheduleEngine(db);
    pc = new PlanningCenter(db);
    seedChurch(db, churchId, { pcEnabled: false, appId: '', secret: '', serviceTypeId: '' });
  });

  afterEach(() => {
    pc.stop();
    if (db) db.close();
  });

  it('setCredentials updates only provided fields', () => {
    pc.setCredentials(churchId, { appId: 'new_app', syncEnabled: true });

    const row = db.prepare('SELECT pc_app_id, pc_secret, pc_sync_enabled FROM churches WHERE churchId = ?').get(churchId);
    expect(row.pc_app_id).toBe('new_app');
    expect(row.pc_secret).toBe(''); // unchanged
    expect(row.pc_sync_enabled).toBe(1);
  });

  it('setCredentials is a no-op when no fields are provided', () => {
    const before = db.prepare('SELECT pc_app_id FROM churches WHERE churchId = ?').get(churchId);
    pc.setCredentials(churchId, {});
    const after = db.prepare('SELECT pc_app_id FROM churches WHERE churchId = ?').get(churchId);
    expect(before.pc_app_id).toBe(after.pc_app_id);
  });

  it('getStatus returns safe public data without credentials', () => {
    pc.setCredentials(churchId, {
      appId: 'secret_app_id',
      secret: 'super_secret',
      serviceTypeId: 'stype_99',
      syncEnabled: true,
    });

    const status = pc.getStatus(churchId);
    expect(status.syncEnabled).toBe(true);
    expect(status.serviceTypeId).toBe('stype_99');
    expect(status).not.toHaveProperty('appId');
    expect(status).not.toHaveProperty('secret');
    // Verify credentials are NOT exposed
    expect(JSON.stringify(status)).not.toContain('secret_app_id');
    expect(JSON.stringify(status)).not.toContain('super_secret');
  });

  it('getStatus returns null for nonexistent church', () => {
    expect(pc.getStatus('nonexistent')).toBeNull();
  });
});

describe('PlanningCenter — write-back service notes', () => {
  let db;
  let pc;
  let fetchSpy;
  const churchId = 'church_wb_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    db.prepare('UPDATE churches SET pc_writeback_enabled = 1 WHERE churchId = ?').run(churchId);

    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('writes production notes to the most recent plan', async () => {
    // Mock: fetch recent plan
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_recent', new Date().toISOString(), 'Recent Service'),
    ]));
    // Mock: POST note
    fetchSpy.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

    const sessionData = {
      grade: 'A',
      duration_minutes: 75,
      alert_count: 2,
      auto_recovered_count: 1,
      stream_ran: true,
      stream_runtime_minutes: 70,
      td_name: 'John',
      recording_confirmed: true,
    };

    const result = await pc.writeServiceNotes(churchId, sessionData);
    expect(result.written).toBe(true);
    expect(result.planId).toBe('plan_recent');

    // Verify the note POST was called
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [noteUrl, noteOpts] = fetchSpy.mock.calls[1];
    expect(noteUrl).toContain('/notes');
    expect(noteOpts.method).toBe('POST');
    const body = JSON.parse(noteOpts.body);
    expect(body.data.attributes.content).toContain('Grade: A');
    expect(body.data.attributes.category_name).toBe('Production');
  });

  it('skips write-back when disabled', async () => {
    db.prepare('UPDATE churches SET pc_writeback_enabled = 0 WHERE churchId = ?').run(churchId);

    const result = await pc.writeServiceNotes(churchId, {});
    expect(result.written).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles API error during note POST gracefully', async () => {
    fetchSpy.mockResolvedValueOnce(makePCResponse([
      makePlan('plan_1', new Date().toISOString()),
    ]));
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, text: async () => 'Forbidden' });

    const result = await pc.writeServiceNotes(churchId, { grade: 'B' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('403');
  });

  it('handles no recent plan found', async () => {
    fetchSpy.mockResolvedValueOnce(makePCResponse([]));

    const result = await pc.writeServiceNotes(churchId, { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('No recent plan');
  });
});
