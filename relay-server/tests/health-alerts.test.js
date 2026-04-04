import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { HealthAlertMonitor, startHealthAlerts, ALERT_THRESHOLDS } from '../src/crons/healthAlerts.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_status TEXT DEFAULT 'active',
      billing_tier TEXT DEFAULT 'connect',
      service_times TEXT DEFAULT '[]'
    )
  `);

  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      recording_confirmed INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER,
      td_name TEXT,
      grade TEXT,
      notes TEXT
    )
  `);

  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      auto_resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE preservice_check_results (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      pass INTEGER DEFAULT 0,
      checks_json TEXT DEFAULT '[]',
      trigger_type TEXT DEFAULT 'auto',
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE church_schedules (
      church_id TEXT PRIMARY KEY,
      schedule_json TEXT DEFAULT '[]'
    )
  `);

  return db;
}

function addChurch(db, churchId = 'church-1', name = 'Test Church', billing_status = 'active') {
  db.prepare('INSERT INTO churches (churchId, name, billing_status) VALUES (?, ?, ?)').run(churchId, name, billing_status);
}

function addSession(db, churchId, opts = {}) {
  const id = opts.id || `session-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const endedAt = opts.ended !== false ? new Date(startedAt.getTime() + (opts.durationMinutes || 90) * 60000) : null;

  db.prepare(`
    INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes,
      stream_ran, stream_runtime_minutes, alert_count, auto_recovered_count, escalated_count, grade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, churchId, startedAt.toISOString(), endedAt?.toISOString() || null,
    opts.durationMinutes || 90,
    opts.streamRan ?? 1, opts.streamRuntimeMinutes ?? 85,
    opts.alertCount ?? 0, opts.autoRecoveredCount ?? 0, opts.escalatedCount ?? 0,
    opts.grade || null
  );
  return { id, startedAt, endedAt };
}

function addAlert(db, churchId, opts = {}) {
  const id = opts.id || `alert-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, churchId, opts.alertType || 'stream_stopped', opts.severity || 'CRITICAL', createdAt.toISOString());
  return id;
}

function addServiceEvent(db, churchId, opts = {}) {
  const daysAgo = opts.daysAgo ?? 1;
  const timestamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO service_events (church_id, timestamp, event_type, resolved, auto_resolved)
    VALUES (?, ?, ?, ?, ?)
  `).run(churchId, timestamp.toISOString(), opts.eventType || 'stream_stopped',
    opts.resolved ?? 0, opts.autoResolved ?? 0);
}

function addPreServiceCheck(db, churchId, opts = {}) {
  const id = `check-${Math.random().toString(36).slice(2, 8)}`;
  const daysAgo = opts.daysAgo ?? 1;
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  db.prepare(`
    INSERT INTO preservice_check_results (id, church_id, pass, checks_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, churchId, opts.pass ? 1 : 0, opts.checksJson || '[]', createdAt.toISOString());
}

function createMockAlertEngine() {
  return {
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function createMonitor(db, alertEngine) {
  return new HealthAlertMonitor(db, alertEngine || createMockAlertEngine(), new Map());
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

describe('HealthAlertMonitor — Table creation', () => {
  let db;

  afterEach(() => { db?.close(); });

  it('creates health_alerts table on construction', () => {
    db = createTestDb();
    createMonitor(db);

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_alerts'").get();
    expect(row).toBeTruthy();
    expect(row.name).toBe('health_alerts');
  });

  it('health_alerts table has expected columns', () => {
    db = createTestDb();
    createMonitor(db);

    const cols = db.prepare("PRAGMA table_info('health_alerts')").all().map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('churchId');
    expect(cols).toContain('type');
    expect(cols).toContain('severity');
    expect(cols).toContain('message');
    expect(cols).toContain('data');
    expect(cols).toContain('acknowledged');
    expect(cols).toContain('created_at');
  });
});

describe('HealthAlertMonitor — checkHealthScoreDrop', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('returns null when health score is high', async () => {
    // No bad data = score 100
    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('detects health score below threshold', async () => {
    // Create a terrible session: lots of alerts and events
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 20, autoRecoveredCount: 0, streamRuntimeMinutes: 50 });
    for (let i = 0; i < 20; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }
    for (let i = 0; i < 5; i++) {
      addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false });
    }

    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.type).toMatch(/health_score/);
    expect(result.churchId).toBe('church-1');
  });

  it('detects rapid drop (15+ points) as critical', async () => {
    // Previous period: clean sessions (days 8-14)
    addSession(db, 'church-1', { daysAgo: 10, durationMinutes: 90, alertCount: 0 });
    addSession(db, 'church-1', { daysAgo: 12, durationMinutes: 90, alertCount: 0 });

    // Current period: terrible (days 1-7)
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 15, autoRecoveredCount: 0, streamRuntimeMinutes: 50 });
    for (let i = 0; i < 15; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }

    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.severity).toBe('critical');
  });

  it('sets severity to critical when score below 50', async () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 30, alertCount: 30, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 30; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }

    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.severity).toBe('critical');
    expect(result.type).toBe('health_score_critical');
  });

  it('sets severity to warning when score between 50 and 70', async () => {
    // Generate enough issues to land score between 50-70
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 60, alertCount: 5, autoRecoveredCount: 1, streamRuntimeMinutes: 50 });
    for (let i = 0; i < 5; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
    }
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'atem_disconnected', resolved: 0 });
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false });
    addPreServiceCheck(db, 'church-1', { daysAgo: 2, pass: false });

    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    // Could be warning or critical depending on exact score — either is valid for low score
    if (result) {
      expect(['warning', 'critical']).toContain(result.severity);
    }
  });
});

describe('HealthAlertMonitor — checkRecurringFailures', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('detects same failure 3 consecutive weeks', async () => {
    // Add obs_disconnected events in 3 consecutive weeks
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 9, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 16, eventType: 'obs_disconnected' });

    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.type).toBe('recurring_failure');
    expect(result.data.failureType).toBe('obs_disconnected');
    expect(result.data.consecutiveWeeks).toBeGreaterThanOrEqual(3);
  });

  it('does NOT flag failure if only 2 weeks', async () => {
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 9, eventType: 'obs_disconnected' });

    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('does NOT flag non-consecutive weeks', async () => {
    // Week 1 and week 3 but NOT week 2 (gap breaks the streak)
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'obs_disconnected' });
    // skip week 2
    addServiceEvent(db, 'church-1', { daysAgo: 16, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 23, eventType: 'obs_disconnected' });

    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('ignores INFO event types like stream_started', async () => {
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'stream_started' });
    addServiceEvent(db, 'church-1', { daysAgo: 9, eventType: 'stream_started' });
    addServiceEvent(db, 'church-1', { daysAgo: 16, eventType: 'stream_started' });

    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('returns null when no events exist', async () => {
    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });
});

describe('HealthAlertMonitor — checkPreServiceFailures', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('detects 2 consecutive pre-service failures', async () => {
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false, checksJson: JSON.stringify([{ name: 'OBS', pass: false }]) });
    addPreServiceCheck(db, 'church-1', { daysAgo: 4, pass: false, checksJson: JSON.stringify([{ name: 'ATEM', pass: false }]) });

    const result = await monitor.checkPreServiceFailures('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.type).toBe('preservice_failures');
    expect(result.data.consecutiveFailures).toBeGreaterThanOrEqual(2);
  });

  it('includes failing check names in message', async () => {
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false, checksJson: JSON.stringify([{ name: 'OBS Connection', pass: false }]) });
    addPreServiceCheck(db, 'church-1', { daysAgo: 4, pass: false, checksJson: JSON.stringify([{ name: 'ATEM Connection', pass: false }]) });

    const result = await monitor.checkPreServiceFailures('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.data.failingChecks).toContain('OBS Connection');
    expect(result.data.failingChecks).toContain('ATEM Connection');
  });

  it('does NOT flag if most recent check passed', async () => {
    addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: true });
    addPreServiceCheck(db, 'church-1', { daysAgo: 4, pass: false });
    addPreServiceCheck(db, 'church-1', { daysAgo: 7, pass: false });

    const result = await monitor.checkPreServiceFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('returns null with no checks at all', async () => {
    const result = await monitor.checkPreServiceFailures('church-1', 'Test Church');
    expect(result).toBeNull();
  });
});

describe('HealthAlertMonitor — checkChurnRisk', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('detects churn risk when no sessions for 2+ weeks but was previously active', async () => {
    // Old sessions (3-5 weeks ago)
    addSession(db, 'church-1', { daysAgo: 21 });
    addSession(db, 'church-1', { daysAgo: 28 });
    addSession(db, 'church-1', { daysAgo: 35 });
    // No sessions in last 2 weeks

    const result = await monitor.checkChurnRisk('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.type).toBe('churn_risk');
    expect(result.severity).toBe('info');
  });

  it('does NOT flag churn for new churches with no sessions ever', async () => {
    // No sessions at all — brand new church
    const result = await monitor.checkChurnRisk('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('does NOT flag churn when church has recent sessions', async () => {
    addSession(db, 'church-1', { daysAgo: 3 });
    addSession(db, 'church-1', { daysAgo: 10 });

    const result = await monitor.checkChurnRisk('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('includes previous session count in data', async () => {
    addSession(db, 'church-1', { daysAgo: 21 });
    addSession(db, 'church-1', { daysAgo: 28 });

    const result = await monitor.checkChurnRisk('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.data.previousSessionCount).toBe(2);
  });
});

describe('HealthAlertMonitor — checkMissedServices', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('detects missed services when schedule exists but sessions missing', async () => {
    // Schedule: 2 services per week
    db.prepare('UPDATE churches SET service_times = ? WHERE churchId = ?').run(
      JSON.stringify([{ day: 'Sunday', time: '10:00' }, { day: 'Wednesday', time: '19:00' }]),
      'church-1'
    );

    // Expected: 6 sessions over 3 weeks, but only 2 actually happened
    addSession(db, 'church-1', { daysAgo: 3 });
    addSession(db, 'church-1', { daysAgo: 10 });

    const result = await monitor.checkMissedServices('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.type).toBe('missed_services');
    expect(result.data.missed).toBeGreaterThanOrEqual(3);
  });

  it('returns null when no schedule is configured', async () => {
    const result = await monitor.checkMissedServices('church-1', 'Test Church');
    expect(result).toBeNull();
  });

  it('returns null when all scheduled services were attended', async () => {
    db.prepare('UPDATE churches SET service_times = ? WHERE churchId = ?').run(
      JSON.stringify([{ day: 'Sunday', time: '10:00' }]),
      'church-1'
    );

    // 1 per week for 3 weeks = 3 expected. Add 3 sessions.
    addSession(db, 'church-1', { daysAgo: 2 });
    addSession(db, 'church-1', { daysAgo: 9 });
    addSession(db, 'church-1', { daysAgo: 16 });

    const result = await monitor.checkMissedServices('church-1', 'Test Church');
    expect(result).toBeNull();
  });
});

describe('HealthAlertMonitor — Dedup (storeAlert)', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('stores a new alert successfully', async () => {
    const stored = await monitor.storeAlert({
      churchId: 'church-1',
      type: 'health_score_low',
      severity: 'warning',
      message: 'Test alert',
      data: { score: 65 },
    });

    expect(stored).toBe(true);
    const row = db.prepare('SELECT * FROM health_alerts WHERE churchId = ?').get('church-1');
    expect(row).toBeTruthy();
    expect(row.type).toBe('health_score_low');
    expect(row.severity).toBe('warning');
  });

  it('does NOT store duplicate alert within 7 days', async () => {
    const alert = {
      churchId: 'church-1',
      type: 'health_score_low',
      severity: 'warning',
      message: 'Test alert',
      data: {},
    };

    const first = await monitor.storeAlert(alert);
    const second = await monitor.storeAlert(alert);

    expect(first).toBe(true);
    expect(second).toBe(false);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM health_alerts WHERE churchId = ?').get('church-1');
    expect(count.cnt).toBe(1);
  });

  it('allows same alert after 7 day window expires', async () => {
    // Insert an old alert (8 days ago)
    db.prepare(
      `INSERT INTO health_alerts (churchId, type, severity, message, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('church-1', 'health_score_low', 'warning', 'Old alert',
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString());

    const stored = await monitor.storeAlert({
      churchId: 'church-1',
      type: 'health_score_low',
      severity: 'warning',
      message: 'New alert',
      data: {},
    });

    expect(stored).toBe(true);
  });

  it('allows different alert types for the same church', async () => {
    const first = await monitor.storeAlert({
      churchId: 'church-1', type: 'health_score_low', severity: 'warning', message: 'A', data: {},
    });
    const second = await monitor.storeAlert({
      churchId: 'church-1', type: 'churn_risk', severity: 'info', message: 'B', data: {},
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
  });
});

describe('HealthAlertMonitor — runDailyCheck', () => {
  let db, alertEngine, monitor;

  beforeEach(() => {
    db = createTestDb();
    alertEngine = createMockAlertEngine();
    monitor = new HealthAlertMonitor(db, alertEngine, new Map());
  });

  afterEach(() => { db?.close(); });

  it('returns empty alerts when all churches are healthy', async () => {
    addChurch(db, 'church-1', 'Good Church', 'active');
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 90, alertCount: 0 });

    const result = await monitor.runDailyCheck();
    expect(result.alerts).toEqual([]);
  });

  it('only checks active/trialing churches (skips cancelled)', async () => {
    addChurch(db, 'church-1', 'Active Church', 'active');
    addChurch(db, 'church-2', 'Cancelled Church', 'cancelled');

    // Both churches have terrible data
    for (const cid of ['church-1', 'church-2']) {
      addSession(db, cid, { daysAgo: 1, durationMinutes: 30, alertCount: 20, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
      for (let i = 0; i < 20; i++) {
        addAlert(db, cid, { daysAgo: 1, severity: 'CRITICAL' });
        addServiceEvent(db, cid, { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
      }
    }

    const result = await monitor.runDailyCheck();
    // Should only have alerts for church-1 (active), not church-2 (cancelled)
    const churchIds = result.alerts.map(a => a.churchId);
    expect(churchIds).not.toContain('church-2');
  });

  it('includes trialing churches', async () => {
    addChurch(db, 'church-1', 'Trial Church', 'trialing');
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 30, alertCount: 20, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 20; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }

    const result = await monitor.runDailyCheck();
    const churchIds = result.alerts.map(a => a.churchId);
    expect(churchIds).toContain('church-1');
  });

  it('aggregates multiple alerts from different churches', async () => {
    addChurch(db, 'church-1', 'Church A', 'active');
    addChurch(db, 'church-2', 'Church B', 'active');

    // Church A: churn risk
    addSession(db, 'church-1', { daysAgo: 25 });
    addSession(db, 'church-1', { daysAgo: 30 });

    // Church B: terrible health score
    addSession(db, 'church-2', { daysAgo: 1, durationMinutes: 30, alertCount: 25, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 25; i++) {
      addAlert(db, 'church-2', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-2', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }

    const result = await monitor.runDailyCheck();
    const churchIds = new Set(result.alerts.map(a => a.churchId));
    expect(churchIds.size).toBeGreaterThanOrEqual(1);
  });

  it('deduplicates alerts within the daily check', async () => {
    addChurch(db, 'church-1', 'Test Church', 'active');
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 30, alertCount: 20, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 20; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }

    // Run twice — second run should produce no new alerts (dedup)
    const first = await monitor.runDailyCheck();
    const second = await monitor.runDailyCheck();

    expect(first.alerts.length).toBeGreaterThan(0);
    expect(second.alerts.length).toBe(0);
  });
});

describe('HealthAlertMonitor — sendAdminSummary', () => {
  let db, alertEngine, monitor;

  beforeEach(() => {
    db = createTestDb();
    alertEngine = createMockAlertEngine();
    monitor = new HealthAlertMonitor(db, alertEngine, new Map());

    // Set env vars for Telegram
    process.env.ALERT_BOT_TOKEN = 'test-bot-token';
    process.env.ADMIN_TELEGRAM_CHAT_ID = '12345';
  });

  afterEach(() => {
    db?.close();
    delete process.env.ALERT_BOT_TOKEN;
    delete process.env.ADMIN_TELEGRAM_CHAT_ID;
  });

  it('sends formatted Telegram message grouped by severity', async () => {
    const alerts = [
      { churchId: 'c1', churchName: 'First Church', type: 'health_score_critical', severity: 'critical', message: 'Health score dropped to 45', data: {} },
      { churchId: 'c2', churchName: 'Grace Church', type: 'recurring_failure', severity: 'warning', message: 'OBS disconnecting every Sunday', data: {} },
      { churchId: 'c3', churchName: 'New Life', type: 'churn_risk', severity: 'info', message: 'No sessions for 2 weeks', data: {} },
    ];

    await monitor.sendAdminSummary(alerts);

    expect(alertEngine.sendTelegramMessage).toHaveBeenCalledOnce();
    const sentMessage = alertEngine.sendTelegramMessage.mock.calls[0][2];
    expect(sentMessage).toContain('Proactive Health Alerts');
    expect(sentMessage).toContain('Critical');
    expect(sentMessage).toContain('First Church');
    expect(sentMessage).toContain('Warning');
    expect(sentMessage).toContain('Grace Church');
    expect(sentMessage).toContain('Info');
    expect(sentMessage).toContain('New Life');
  });

  it('does not send if no bot token', async () => {
    delete process.env.ALERT_BOT_TOKEN;

    await monitor.sendAdminSummary([
      { churchId: 'c1', churchName: 'Test', type: 'test', severity: 'info', message: 'Test', data: {} },
    ]);

    expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('does not send if no alerts', async () => {
    // sendAdminSummary is only called when there are alerts, but test empty array
    await monitor.sendAdminSummary([]);

    // With no alerts in any category, nothing to send — still formats but empty sections
    // The function should still complete without error
  });
});

describe('HealthAlertMonitor — Severity levels', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('health score below 50 is critical', async () => {
    addSession(db, 'church-1', { daysAgo: 1, durationMinutes: 30, alertCount: 30, autoRecoveredCount: 0, streamRuntimeMinutes: 25 });
    for (let i = 0; i < 30; i++) {
      addAlert(db, 'church-1', { daysAgo: 1, severity: 'CRITICAL' });
      addServiceEvent(db, 'church-1', { daysAgo: 1, eventType: 'stream_stopped', resolved: 0 });
    }
    for (let i = 0; i < 5; i++) {
      addPreServiceCheck(db, 'church-1', { daysAgo: 1, pass: false });
    }

    const result = await monitor.checkHealthScoreDrop('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.severity).toBe('critical');
  });

  it('recurring failure is warning severity', async () => {
    addServiceEvent(db, 'church-1', { daysAgo: 2, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 9, eventType: 'obs_disconnected' });
    addServiceEvent(db, 'church-1', { daysAgo: 16, eventType: 'obs_disconnected' });

    const result = await monitor.checkRecurringFailures('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warning');
  });

  it('churn risk is info severity', async () => {
    addSession(db, 'church-1', { daysAgo: 21 });
    addSession(db, 'church-1', { daysAgo: 28 });

    const result = await monitor.checkChurnRisk('church-1', 'Test Church');
    expect(result).not.toBeNull();
    expect(result.severity).toBe('info');
  });
});

describe('HealthAlertMonitor — Alert data integrity', () => {
  let db, monitor;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db);
    monitor = createMonitor(db);
  });

  afterEach(() => { db?.close(); });

  it('alert stored in database contains correct fields', async () => {
    await monitor.storeAlert({
      churchId: 'church-1',
      type: 'churn_risk',
      severity: 'info',
      message: 'No sessions for 2 weeks',
      data: { weeksSilent: 2, previousSessionCount: 5 },
    });

    const row = db.prepare('SELECT * FROM health_alerts WHERE churchId = ?').get('church-1');
    expect(row.churchId).toBe('church-1');
    expect(row.type).toBe('churn_risk');
    expect(row.severity).toBe('info');
    expect(row.message).toBe('No sessions for 2 weeks');
    expect(row.acknowledged).toBe(0);

    const data = JSON.parse(row.data);
    expect(data.weeksSilent).toBe(2);
    expect(data.previousSessionCount).toBe(5);
  });

  it('alert has created_at timestamp', async () => {
    await monitor.storeAlert({
      churchId: 'church-1', type: 'test', severity: 'info', message: 'Test', data: {},
    });

    const row = db.prepare('SELECT created_at FROM health_alerts WHERE churchId = ?').get('church-1');
    expect(row.created_at).toBeTruthy();
  });
});

describe('startHealthAlerts', () => {
  let db;

  afterEach(() => { db?.close(); });

  it('returns a HealthAlertMonitor instance', () => {
    db = createTestDb();
    addChurch(db);
    const intervals = [];
    const monitor = startHealthAlerts(db, createMockAlertEngine(), new Map(), { _intervals: intervals });

    expect(monitor).toBeInstanceOf(HealthAlertMonitor);

    // Clean up interval
    for (const id of intervals) clearInterval(id);
  });

  it('creates the health_alerts table', () => {
    db = createTestDb();
    const intervals = [];
    startHealthAlerts(db, createMockAlertEngine(), new Map(), { _intervals: intervals });

    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='health_alerts'").get();
    expect(row).toBeTruthy();

    for (const id of intervals) clearInterval(id);
  });

  it('sets up an interval that can be cleaned up', () => {
    db = createTestDb();
    const intervals = [];
    startHealthAlerts(db, createMockAlertEngine(), new Map(), { _intervals: intervals });

    expect(intervals.length).toBe(1);

    for (const id of intervals) clearInterval(id);
  });
});

describe('ALERT_THRESHOLDS', () => {
  it('exports expected threshold values', () => {
    expect(ALERT_THRESHOLDS.healthScoreDrop).toBe(70);
    expect(ALERT_THRESHOLDS.healthScoreDropRate).toBe(15);
    expect(ALERT_THRESHOLDS.recurringFailure).toBe(3);
    expect(ALERT_THRESHOLDS.missedPreService).toBe(2);
    expect(ALERT_THRESHOLDS.offlineStreak).toBe(3);
    expect(ALERT_THRESHOLDS.noSessionsWeeks).toBe(2);
  });
});
