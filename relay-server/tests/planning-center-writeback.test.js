import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { PlanningCenter } = require('../src/planningCenter');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL,
      service_times TEXT DEFAULT '[]'
    )
  `);
  return db;
}

function seedChurch(db, churchId, opts = {}) {
  const {
    name = 'Test Church',
    appId = 'app_123',
    secret = 'secret_456',
    serviceTypeId = 'stype_1',
    writebackEnabled = true,
  } = opts;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, name, `${churchId}@test.local`, `tok-${churchId}`, now);

  try {
    db.prepare(
      'UPDATE churches SET pc_app_id = ?, pc_secret = ?, pc_service_type_id = ?, pc_sync_enabled = 1, pc_writeback_enabled = ? WHERE churchId = ?'
    ).run(appId, secret, serviceTypeId, writebackEnabled ? 1 : 0, churchId);
  } catch {
    // columns added by _ensureColumns
  }
}

function okJson(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function errorResp(status, body = '') {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}

function makePlan(id, sortDate, title = 'Sunday Service') {
  return {
    id,
    type: 'Plan',
    attributes: { sort_date: sortDate, title },
  };
}

function makeTeamMember(id, name) {
  return {
    id,
    type: 'TeamMember',
    attributes: { name, status: 'U' },
  };
}

// ─── pushSessionRecap ────────────────────────────────────────────────────────

describe('PlanningCenter.pushSessionRecap', () => {
  let db, pc, fetchSpy;
  const churchId = 'church_recap_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('pushes a full session recap as a plan note', async () => {
    // Mock: verify plan exists
    fetchSpy.mockResolvedValueOnce(okJson({ data: makePlan('plan_42', new Date().toISOString()) }));
    // Mock: POST note
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const recapData = {
      grade: 'A',
      durationMinutes: 95,
      alertCount: 3,
      autoRecovered: 2,
      escalated: 1,
      peakViewers: 142,
      streamTotalMinutes: 88,
      streaming: true,
      recordingConfirmed: true,
      audioSilenceCount: 1,
      tdName: 'Sarah',
      alertTypes: { video_freeze: 2, audio_drop: 1 },
    };

    const result = await pc.pushSessionRecap(churchId, 'plan_42', recapData);
    expect(result.written).toBe(true);
    expect(result.planId).toBe('plan_42');

    // Verify note content
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [noteUrl, noteOpts] = fetchSpy.mock.calls[1];
    expect(noteUrl).toContain('/plans/plan_42/notes');
    expect(noteOpts.method).toBe('POST');

    const body = JSON.parse(noteOpts.body);
    const content = body.data.attributes.content;
    expect(content).toContain('Grade: A');
    expect(content).toContain('1h 35m');
    expect(content).toContain('TD: Sarah');
    expect(content).toContain('Peak Viewers: 142');
    expect(content).toContain('Stream: Yes (88 min)');
    expect(content).toContain('Recording: Confirmed');
    expect(content).toContain('Alerts: 3 (2 auto-recovered, 1 escalated)');
    expect(content).toContain('Audio silences: 1');
    expect(content).toContain('video_freeze: 2');
    expect(content).toContain('audio_drop: 1');
    expect(body.data.attributes.category_name).toBe('Production');
  });

  it('handles snake_case recap data fields', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ data: makePlan('plan_sc', new Date().toISOString()) }));
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const recapData = {
      grade: 'B',
      duration_minutes: 60,
      alert_count: 1,
      auto_recovered_count: 1,
      peak_viewers: 50,
      stream_runtime_minutes: 55,
      stream_ran: true,
      recording_confirmed: false,
      audio_silence_count: 0,
      td_name: 'Mike',
    };

    const result = await pc.pushSessionRecap(churchId, 'plan_sc', recapData);
    expect(result.written).toBe(true);

    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    const content = body.data.attributes.content;
    expect(content).toContain('Grade: B');
    expect(content).toContain('TD: Mike');
    expect(content).toContain('Peak Viewers: 50');
  });

  it('returns error when plan is not found (404)', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(404, 'Not Found'));

    const result = await pc.pushSessionRecap(churchId, 'plan_missing', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('404');
  });

  it('returns error on rate limit (429)', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(429, 'Rate limited'));

    const result = await pc.pushSessionRecap(churchId, 'plan_1', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('rate limit');
  });

  it('returns error on auth failure (401)', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(401, 'Unauthorized'));

    const result = await pc.pushSessionRecap(churchId, 'plan_1', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('auth failure');
  });

  it('skips when write-back is disabled', async () => {
    db.prepare('UPDATE churches SET pc_writeback_enabled = 0 WHERE churchId = ?').run(churchId);

    const result = await pc.pushSessionRecap(churchId, 'plan_1', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when church not found', async () => {
    const result = await pc.pushSessionRecap('nonexistent', 'plan_1', {});
    expect(result.written).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('handles recap with no stream and zero alerts', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ data: makePlan('plan_clean', new Date().toISOString()) }));
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const result = await pc.pushSessionRecap(churchId, 'plan_clean', {
      grade: 'Clean',
      durationMinutes: 90,
      alertCount: 0,
      autoRecovered: 0,
      streamTotalMinutes: 0,
      recordingConfirmed: true,
    });
    expect(result.written).toBe(true);

    const content = JSON.parse(fetchSpy.mock.calls[1][1].body).data.attributes.content;
    expect(content).toContain('Stream: No');
    expect(content).toContain('Alerts: 0');
  });
});

// ─── updateServiceTimes ──────────────────────────────────────────────────────

describe('PlanningCenter.updateServiceTimes', () => {
  let db, pc, fetchSpy;
  const churchId = 'church_times_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('posts actual start/end times as a plan note', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const actualTimes = {
      actualStart: '2026-03-15T09:58:00.000Z',
      actualEnd: '2026-03-15T11:32:00.000Z',
    };

    const result = await pc.updateServiceTimes(churchId, 'plan_t1', actualTimes);
    expect(result.updated).toBe(true);
    expect(result.planId).toBe('plan_t1');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/plans/plan_t1/notes');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body);
    expect(body.data.attributes.content).toContain('Actual Service Times');
    expect(body.data.attributes.content).toContain('2026-03-15T09:58:00.000Z');
    expect(body.data.attributes.content).toContain('2026-03-15T11:32:00.000Z');
    expect(body.data.attributes.category_name).toBe('Production');
  });

  it('accepts Date objects for times', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const result = await pc.updateServiceTimes(churchId, 'plan_t2', {
      actualStart: new Date('2026-03-15T10:00:00Z'),
      actualEnd: new Date('2026-03-15T11:30:00Z'),
    });
    expect(result.updated).toBe(true);
  });

  it('returns error when write-back is disabled', async () => {
    db.prepare('UPDATE churches SET pc_writeback_enabled = 0 WHERE churchId = ?').run(churchId);

    const result = await pc.updateServiceTimes(churchId, 'plan_1', {
      actualStart: new Date(), actualEnd: new Date(),
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  it('returns error on API failure', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(500, 'Server Error'));

    const result = await pc.updateServiceTimes(churchId, 'plan_1', {
      actualStart: new Date(), actualEnd: new Date(),
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('500');
  });

  it('returns error on rate limit', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(429, 'Too Many Requests'));

    const result = await pc.updateServiceTimes(churchId, 'plan_1', {
      actualStart: new Date(), actualEnd: new Date(),
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('rate limit');
  });
});

// ─── syncVolunteerAttendance ─────────────────────────────────────────────────

describe('PlanningCenter.syncVolunteerAttendance', () => {
  let db, pc, fetchSpy;
  const churchId = 'church_vol_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('matches active tokens to team members and confirms attendance', async () => {
    // Mock: fetch team members
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [
        makeTeamMember('tm_1', 'Alice Johnson'),
        makeTeamMember('tm_2', 'Bob Smith'),
        makeTeamMember('tm_3', 'Charlie Brown'),
      ],
    }));
    // Mock: PATCH for Alice
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));
    // Mock: PATCH for Bob
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const activeTokens = [
      { token: 'GUEST-A1', name: 'Alice Johnson', churchId },
      { token: 'GUEST-B2', name: 'Bob Smith', churchId },
    ];

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v1', activeTokens);
    expect(result.synced).toBe(true);
    expect(result.matched).toBe(2);
    expect(result.total).toBe(3);

    // Verify PATCH calls for matched members
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 1 GET + 2 PATCH
    const [patchUrl, patchOpts] = fetchSpy.mock.calls[1];
    expect(patchUrl).toContain('/team_members/tm_1');
    expect(patchOpts.method).toBe('PATCH');
    const patchBody = JSON.parse(patchOpts.body);
    expect(patchBody.data.attributes.status).toBe('C');
  });

  it('filters tokens to only the relevant church', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [makeTeamMember('tm_1', 'Alice Johnson')],
    }));

    const activeTokens = [
      { token: 'GUEST-X', name: 'Alice Johnson', churchId: 'other_church' },
    ];

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v2', activeTokens);
    expect(result.synced).toBe(true);
    expect(result.matched).toBe(0);
    // Only the GET call, no PATCH
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles empty team members list', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ data: [] }));

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v3', [
      { token: 'GUEST-A', name: 'Alice', churchId },
    ]);
    expect(result.synced).toBe(true);
    expect(result.matched).toBe(0);
    expect(result.total).toBe(0);
  });

  it('handles partial name matching', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [makeTeamMember('tm_1', 'Alice Johnson')],
    }));
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const activeTokens = [
      { token: 'GUEST-A', name: 'alice', churchId }, // lowercase partial
    ];

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v4', activeTokens);
    expect(result.synced).toBe(true);
    expect(result.matched).toBe(1);
  });

  it('returns error on API failure fetching team', async () => {
    fetchSpy.mockResolvedValueOnce(errorResp(500, 'Error'));

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v5', []);
    expect(result.synced).toBe(false);
    expect(result.reason).toContain('500');
  });

  it('continues when individual PATCH fails', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [
        makeTeamMember('tm_1', 'Alice'),
        makeTeamMember('tm_2', 'Bob'),
      ],
    }));
    // Alice PATCH fails
    fetchSpy.mockResolvedValueOnce(errorResp(403, 'Forbidden'));
    // Bob PATCH succeeds
    fetchSpy.mockResolvedValueOnce(okJson({ data: {} }));

    const activeTokens = [
      { token: 'GUEST-A', name: 'Alice', churchId },
      { token: 'GUEST-B', name: 'Bob', churchId },
    ];

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_v6', activeTokens);
    expect(result.synced).toBe(true);
    // Only Bob succeeded
    expect(result.matched).toBe(1);
  });

  it('skips when write-back is disabled', async () => {
    db.prepare('UPDATE churches SET pc_writeback_enabled = 0 WHERE churchId = ?').run(churchId);

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_1', []);
    expect(result.synced).toBe(false);
    expect(result.reason).toContain('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── getUpcomingPlans ────────────────────────────────────────────────────────

describe('PlanningCenter.getUpcomingPlans', () => {
  let db, pc, fetchSpy;
  const churchId = 'church_plans_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('fetches upcoming plans within the days window', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 8);
    nextWeek.setHours(10, 0, 0, 0);

    // Mock: service type fetch
    fetchSpy.mockResolvedValueOnce(okJson({
      data: { attributes: { name: 'Weekend Services' } },
    }));
    // Mock: plans fetch
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [
        makePlan('plan_a', tomorrow.toISOString(), 'Tomorrow Service'),
        makePlan('plan_b', nextWeek.toISOString(), 'Next Week Service'),
      ],
    }));

    const plans = await pc.getUpcomingPlans(churchId, 7);
    // Only tomorrow's plan should be within 7-day window
    expect(plans.length).toBe(1);
    expect(plans[0].planId).toBe('plan_a');
    expect(plans[0].title).toBe('Tomorrow Service');
    expect(plans[0].serviceTypeName).toBe('Weekend Services');
    expect(plans[0].dayName).toBeTruthy();
    expect(plans[0].startTime).toBe('10:00');
  });

  it('returns all plans within a larger window', async () => {
    const day2 = new Date();
    day2.setDate(day2.getDate() + 2);
    const day5 = new Date();
    day5.setDate(day5.getDate() + 5);

    fetchSpy.mockResolvedValueOnce(okJson({
      data: { attributes: { name: 'Services' } },
    }));
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [
        makePlan('p1', day2.toISOString(), 'Service A'),
        makePlan('p2', day5.toISOString(), 'Service B'),
      ],
    }));

    const plans = await pc.getUpcomingPlans(churchId, 14);
    expect(plans.length).toBe(2);
  });

  it('handles service type fetch failure gracefully', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Service type fetch fails
    fetchSpy.mockResolvedValueOnce(errorResp(500, 'Error'));
    // Plans fetch succeeds
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [makePlan('plan_1', tomorrow.toISOString(), 'Service')],
    }));

    const plans = await pc.getUpcomingPlans(churchId, 7);
    expect(plans.length).toBe(1);
    expect(plans[0].serviceTypeName).toBe('Unknown');
  });

  it('throws when church not found', async () => {
    await expect(pc.getUpcomingPlans('nonexistent'))
      .rejects.toThrow(/not found/i);
  });

  it('throws when credentials not configured', async () => {
    const noCredId = 'church_no_cred';
    db.prepare('INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)')
      .run(noCredId, 'No Creds', 'nc@test.local', 'tok', new Date().toISOString());

    await expect(pc.getUpcomingPlans(noCredId))
      .rejects.toThrow(/credentials not configured/i);
  });

  it('throws on API rate limit', async () => {
    // Service type fetch succeeds
    fetchSpy.mockResolvedValueOnce(okJson({
      data: { attributes: { name: 'Services' } },
    }));
    // Plans fetch rate limited
    fetchSpy.mockResolvedValueOnce(errorResp(429, 'Rate limited'));

    await expect(pc.getUpcomingPlans(churchId))
      .rejects.toThrow(/rate limit/i);
  });

  it('throws on auth failure', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({
      data: { attributes: { name: 'Services' } },
    }));
    fetchSpy.mockResolvedValueOnce(errorResp(401, 'Unauthorized'));

    await expect(pc.getUpcomingPlans(churchId))
      .rejects.toThrow(/auth failure/i);
  });

  it('filters out plans with missing sort_date', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    fetchSpy.mockResolvedValueOnce(okJson({ data: { attributes: { name: 'Svc' } } }));
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [
        { id: 'plan_bad', type: 'Plan', attributes: { sort_date: null, title: 'Bad' } },
        makePlan('plan_good', tomorrow.toISOString(), 'Good'),
      ],
    }));

    const plans = await pc.getUpcomingPlans(churchId, 7);
    expect(plans.length).toBe(1);
    expect(plans[0].planId).toBe('plan_good');
  });

  it('returns empty array when no plans in window', async () => {
    const farFuture = new Date();
    farFuture.setDate(farFuture.getDate() + 30);

    fetchSpy.mockResolvedValueOnce(okJson({ data: { attributes: { name: 'Svc' } } }));
    fetchSpy.mockResolvedValueOnce(okJson({
      data: [makePlan('plan_far', farFuture.toISOString(), 'Far Out')],
    }));

    const plans = await pc.getUpcomingPlans(churchId, 7);
    expect(plans.length).toBe(0);
  });
});

// ─── Error handling edge cases ───────────────────────────────────────────────

describe('PlanningCenter — error handling edge cases', () => {
  let db, pc, fetchSpy;
  const churchId = 'church_err_1';

  beforeEach(() => {
    db = createDb();
    pc = new PlanningCenter(db);
    seedChurch(db, churchId);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    pc.stop();
    fetchSpy.mockRestore();
    if (db) db.close();
  });

  it('pushSessionRecap handles network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network timeout'));

    const result = await pc.pushSessionRecap(churchId, 'plan_1', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('Network timeout');
  });

  it('updateServiceTimes handles network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('DNS resolution failed'));

    const result = await pc.updateServiceTimes(churchId, 'plan_1', {
      actualStart: new Date(), actualEnd: new Date(),
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toContain('DNS resolution failed');
  });

  it('syncVolunteerAttendance handles network error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Connection reset'));

    const result = await pc.syncVolunteerAttendance(churchId, 'plan_1', []);
    expect(result.synced).toBe(false);
    expect(result.reason).toContain('Connection reset');
  });

  it('pushSessionRecap with missing PC credentials', async () => {
    db.prepare('UPDATE churches SET pc_app_id = NULL WHERE churchId = ?').run(churchId);

    const result = await pc.pushSessionRecap(churchId, 'plan_1', { grade: 'A' });
    expect(result.written).toBe(false);
    expect(result.reason).toContain('credentials');
  });
});
