/**
 * PostServiceReport — comprehensive tests
 *
 * Covers:
 *   A. _buildDeviceHealth — alert grouping by device pattern
 *   B. _buildRecommendations — all 7 rule categories
 *   C. _getSessionAlerts — session-based and 4h fallback
 *   D. _getFailoverEvents — filters failover alert types
 *   E. generate — creates and stores complete report in DB
 *   F. _buildReportText — plain-text report format
 *   G. _buildReportHtml — HTML report generation
 *   H. AI summary — skipped when no API key, called with key
 *   I. Email delivery — sends when leadership_emails configured
 *   J. Schema — _ensureSchema creates the table
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import PostServiceReport from '../src/postServiceReport.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'WARNING',
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  return db;
}

let alertCounter = 0;
function addAlert(db, churchId, opts = {}) {
  const id = `alert-${++alertCounter}-${Date.now()}`;
  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, resolved, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    churchId,
    opts.alertType || 'generic_alert',
    opts.severity || 'WARNING',
    JSON.stringify(opts.context || {}),
    opts.createdAt || new Date().toISOString(),
    opts.resolved ? 1 : 0,
    opts.sessionId || null
  );
  return id;
}

function makeChurch(churchId = 'ch1', opts = {}) {
  return {
    churchId,
    name: opts.name || 'Test Church',
    leadership_emails: opts.leadershipEmails || null,
    ...opts,
  };
}

function makeSession(opts = {}) {
  return {
    sessionId: opts.sessionId || 'session-123',
    durationMinutes: opts.durationMinutes ?? 90,
    streamTotalMinutes: opts.streamTotalMinutes ?? 85,
    grade: opts.grade || 'A',
    autoRecovered: opts.autoRecovered ?? 0,
    escalated: opts.escalated ?? 0,
    peakViewers: opts.peakViewers ?? 150,
    ...opts,
  };
}

// ─── A. _buildDeviceHealth ────────────────────────────────────────────────────

describe('A. _buildDeviceHealth', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
  });

  afterEach(() => db?.close());

  it('returns empty object when no alerts', () => {
    expect(report._buildDeviceHealth([])).toEqual({});
  });

  it('groups ATEM alerts under "atem" key', () => {
    const alerts = [
      { alert_type: 'atem_disconnected', severity: 'CRITICAL', resolved: 0 },
      { alert_type: 'atem_signal_loss', severity: 'WARNING', resolved: 1 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.atem).toBeDefined();
    expect(health.atem.alerts).toBe(2);
    expect(health.atem.critical).toBe(1);
    expect(health.atem.autoFixed).toBe(1);
  });

  it('groups OBS alerts under "obs" key', () => {
    const alerts = [
      { alert_type: 'obs_crash', severity: 'EMERGENCY', resolved: 0 },
      { alert_type: 'recording_failed', severity: 'WARNING', resolved: 1 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.obs.alerts).toBe(2);
    expect(health.obs.critical).toBe(1); // EMERGENCY counts as critical
    expect(health.obs.autoFixed).toBe(1);
  });

  it('groups audio alerts under "audio" key', () => {
    const alerts = [
      { alert_type: 'audio_silence', severity: 'CRITICAL', resolved: 1 },
      { alert_type: 'mixer_disconnect', severity: 'WARNING', resolved: 0 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.audio.alerts).toBe(2);
  });

  it('groups stream/bitrate/encoder alerts under "stream" key', () => {
    const alerts = [
      { alert_type: 'stream_stopped', severity: 'CRITICAL', resolved: 0 },
      { alert_type: 'low_bitrate', severity: 'WARNING', resolved: 0 },
      { alert_type: 'encoder_error', severity: 'WARNING', resolved: 0 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.stream.alerts).toBe(3);
  });

  it('groups hyperdeck/deck alerts under "hyperdeck" key', () => {
    const alerts = [
      { alert_type: 'hyperdeck_offline', severity: 'WARNING', resolved: 0 },
      { alert_type: 'deck_error', severity: 'WARNING', resolved: 0 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.hyperdeck.alerts).toBe(2);
  });

  it('groups network/connection alerts under "network" key', () => {
    const alerts = [
      { alert_type: 'network_failure', severity: 'CRITICAL', resolved: 0 },
      { alert_type: 'relay_disconnect', severity: 'WARNING', resolved: 0 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.network.alerts).toBe(2);
  });

  it('assigns alert to first matching pattern (no double-counting)', () => {
    // "obs_stream_stopped" could match OBS or stream — should match OBS first
    const alerts = [{ alert_type: 'obs_stream_stopped', severity: 'WARNING', resolved: 0 }];
    const health = report._buildDeviceHealth(alerts);
    const totalAlerts = Object.values(health).reduce((sum, h) => sum + h.alerts, 0);
    expect(totalAlerts).toBe(1);
  });

  it('ignores alerts with no matching device pattern', () => {
    const alerts = [{ alert_type: 'unknown_system_error', severity: 'WARNING', resolved: 0 }];
    const health = report._buildDeviceHealth(alerts);
    expect(Object.keys(health).length).toBe(0);
  });

  it('counts both CRITICAL and EMERGENCY as critical', () => {
    const alerts = [
      { alert_type: 'atem_loss', severity: 'CRITICAL', resolved: 0 },
      { alert_type: 'atem_black', severity: 'EMERGENCY', resolved: 0 },
      { alert_type: 'atem_flicker', severity: 'WARNING', resolved: 0 },
    ];
    const health = report._buildDeviceHealth(alerts);
    expect(health.atem.critical).toBe(2);
    expect(health.atem.alerts).toBe(3);
  });
});

// ─── B. _buildRecommendations ──────────────────────────────────────────────────

describe('B. _buildRecommendations', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
  });

  afterEach(() => db?.close());

  it('returns clean-service info rec when no alerts', () => {
    const recs = report._buildRecommendations(makeSession(), [], []);
    const cleanRec = recs.find(r => r.text.includes('Clean service'));
    expect(cleanRec).toBeTruthy();
    expect(cleanRec.priority).toBe('info');
  });

  it('returns high-priority rec when >2 critical alerts', () => {
    const criticals = [
      { alert_type: 'atem_loss', severity: 'CRITICAL' },
      { alert_type: 'obs_crash', severity: 'CRITICAL' },
      { alert_type: 'stream_stopped', severity: 'EMERGENCY' },
    ];
    const recs = report._buildRecommendations(makeSession(), criticals, []);
    const highRec = recs.find(r => r.priority === 'high' && r.text.includes('critical'));
    expect(highRec).toBeTruthy();
    expect(highRec.text).toContain('3');
  });

  it('returns audio recommendation when >= 2 audio silence alerts', () => {
    const audioAlerts = [
      { alert_type: 'audio_silence', severity: 'WARNING' },
      { alert_type: 'audio_silence', severity: 'WARNING' },
    ];
    const recs = report._buildRecommendations(makeSession(), audioAlerts, []);
    const audioRec = recs.find(r => r.text.toLowerCase().includes('audio'));
    expect(audioRec).toBeTruthy();
    expect(audioRec.priority).toBe('medium');
  });

  it('does NOT return audio recommendation with only 1 audio alert', () => {
    const audioAlerts = [{ alert_type: 'audio_silence', severity: 'WARNING' }];
    const recs = report._buildRecommendations(makeSession(), audioAlerts, []);
    const audioRec = recs.find(r => r.text.includes('mixer') && r.priority === 'medium');
    expect(audioRec).toBeUndefined();
  });

  it('returns stream recommendation when >= 2 stream alerts', () => {
    const streamAlerts = [
      { alert_type: 'low_bitrate', severity: 'WARNING' },
      { alert_type: 'stream_stopped', severity: 'CRITICAL' },
    ];
    const recs = report._buildRecommendations(makeSession(), streamAlerts, []);
    const streamRec = recs.find(r => r.text.includes('bandwidth'));
    expect(streamRec).toBeTruthy();
    expect(streamRec.priority).toBe('medium');
  });

  it('returns network recommendation when >= 1 network alert', () => {
    const networkAlerts = [{ alert_type: 'network_failure', severity: 'CRITICAL' }];
    const recs = report._buildRecommendations(makeSession(), networkAlerts, []);
    const netRec = recs.find(r => r.text.includes('network'));
    expect(netRec).toBeTruthy();
    expect(netRec.priority).toBe('medium');
  });

  it('returns failover recommendation when >= 1 failover event', () => {
    const failover = [{ type: 'signal_loss', severity: 'CRITICAL', timestamp: new Date().toISOString() }];
    const recs = report._buildRecommendations(makeSession(), [], failover);
    const failRec = recs.find(r => r.text.includes('failover'));
    expect(failRec).toBeTruthy();
    expect(failRec.priority).toBe('high');
    expect(failRec.text).toContain('1');
  });

  it('returns escalation recommendation when escalated > 0', () => {
    const session = makeSession({ escalated: 2 });
    const recs = report._buildRecommendations(session, [], []);
    const escRec = recs.find(r => r.text.includes('escalated'));
    expect(escRec).toBeTruthy();
    expect(escRec.priority).toBe('medium');
    expect(escRec.text).toContain('2');
  });

  it('returns uptime recommendation when uptime < 90%', () => {
    // 60 min stream / 90 min session = 66.67% → Math.round = 67%
    const session = makeSession({ durationMinutes: 90, streamTotalMinutes: 60 });
    const recs = report._buildRecommendations(session, [], []);
    const uptimeRec = recs.find(r => r.text.includes('uptime'));
    expect(uptimeRec).toBeTruthy();
    expect(uptimeRec.priority).toBe('high');
    expect(uptimeRec.text).toContain('67%');
  });

  it('does NOT add uptime rec when uptime >= 90%', () => {
    // 88 min / 90 min = ~97% uptime
    const session = makeSession({ durationMinutes: 90, streamTotalMinutes: 88 });
    const recs = report._buildRecommendations(session, [], []);
    const uptimeRec = recs.find(r => r.text.includes('uptime'));
    expect(uptimeRec).toBeUndefined();
  });

  it('does NOT add uptime rec when streamTotalMinutes is 0', () => {
    const session = makeSession({ durationMinutes: 90, streamTotalMinutes: 0 });
    const recs = report._buildRecommendations(session, [], []);
    const uptimeRec = recs.find(r => r.text.includes('uptime'));
    expect(uptimeRec).toBeUndefined();
  });

  it('returns multiple recs for a bad service', () => {
    const session = makeSession({
      durationMinutes: 90,
      streamTotalMinutes: 50,
      escalated: 3,
    });
    const alerts = [
      { alert_type: 'audio_silence', severity: 'WARNING' },
      { alert_type: 'audio_silence', severity: 'WARNING' },
      { alert_type: 'stream_stopped', severity: 'CRITICAL' },
      { alert_type: 'low_bitrate', severity: 'WARNING' },
      { alert_type: 'atem_crash', severity: 'CRITICAL' },
      { alert_type: 'obs_crash', severity: 'EMERGENCY' },
      { alert_type: 'network_fail', severity: 'CRITICAL' },
    ];
    const failovers = [{ type: 'signal_loss', timestamp: new Date().toISOString() }];
    const recs = report._buildRecommendations(session, alerts, failovers);
    expect(recs.length).toBeGreaterThanOrEqual(4);
  });
});

// ─── C. _getSessionAlerts ─────────────────────────────────────────────────────

describe('C. _getSessionAlerts', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
    alertCounter = 0;
  });

  afterEach(() => db?.close());

  it('returns alerts for a specific session', () => {
    addAlert(db, 'ch1', { alertType: 'obs_crash', sessionId: 'sess-1' });
    addAlert(db, 'ch1', { alertType: 'audio_silence', sessionId: 'sess-1' });
    addAlert(db, 'ch1', { alertType: 'other_alert', sessionId: 'sess-2' }); // different session

    const alerts = report._getSessionAlerts('ch1', 'sess-1');
    expect(alerts.length).toBe(2);
    expect(alerts.every(a => a.session_id === 'sess-1')).toBe(true);
  });

  it('falls back to last 4 hours when sessionId is null', () => {
    const recentTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min ago
    addAlert(db, 'ch1', { alertType: 'obs_crash', sessionId: null, createdAt: recentTime });
    addAlert(db, 'ch1', { alertType: 'audio_silence', sessionId: 'other-session', createdAt: recentTime });

    const alerts = report._getSessionAlerts('ch1', null);
    expect(alerts.length).toBe(2); // both within 4 hours
  });

  it('falls back to last 4 hours when sessionId is provided but returns no rows', () => {
    const recentTime = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Alert has no session_id
    addAlert(db, 'ch1', { alertType: 'obs_crash', sessionId: null, createdAt: recentTime });

    // Asking for a specific session that matches 0 rows → fallback to 4h window
    const alerts = report._getSessionAlerts('ch1', 'nonexistent-session');
    expect(alerts.length).toBe(1);
  });

  it('excludes alerts older than 4 hours in fallback mode', () => {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    addAlert(db, 'ch1', { alertType: 'old_alert', sessionId: null, createdAt: old });

    const alerts = report._getSessionAlerts('ch1', null);
    expect(alerts.length).toBe(0);
  });

  it('returns [] gracefully when alerts table does not exist', () => {
    const db2 = new Database(':memory:');
    const report2 = new PostServiceReport(db2);
    const alerts = report2._getSessionAlerts('ch1', null);
    expect(alerts).toEqual([]);
    db2.close();
  });
});

// ─── D. _getFailoverEvents ────────────────────────────────────────────────────

describe('D. _getFailoverEvents', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
    alertCounter = 0;
  });

  afterEach(() => db?.close());

  it('returns empty array when no failover alerts exist', () => {
    addAlert(db, 'ch1', { alertType: 'audio_silence', sessionId: 'sess-1' });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events).toEqual([]);
  });

  it('filters "failover" alert types', () => {
    addAlert(db, 'ch1', { alertType: 'atem_failover', sessionId: 'sess-1' });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('atem_failover');
  });

  it('filters "signal_loss" alert types', () => {
    addAlert(db, 'ch1', { alertType: 'signal_loss', sessionId: 'sess-1' });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events.length).toBe(1);
  });

  it('filters "black_screen" alert types', () => {
    addAlert(db, 'ch1', { alertType: 'black_screen', sessionId: 'sess-1' });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events.length).toBe(1);
  });

  it('filters "stream_offline" alert type', () => {
    addAlert(db, 'ch1', { alertType: 'stream_offline', sessionId: 'sess-1' });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events.length).toBe(1);
  });

  it('maps resolved field to autoRecovered boolean', () => {
    addAlert(db, 'ch1', { alertType: 'signal_loss', sessionId: 'sess-1', resolved: true });
    addAlert(db, 'ch1', { alertType: 'black_screen', sessionId: 'sess-1', resolved: false });

    const events = report._getFailoverEvents('ch1', 'sess-1');
    const resolved = events.find(e => e.type === 'signal_loss');
    const unresolved = events.find(e => e.type === 'black_screen');
    expect(resolved.autoRecovered).toBe(true);
    expect(unresolved.autoRecovered).toBe(false);
  });

  it('parses context JSON safely', () => {
    addAlert(db, 'ch1', { alertType: 'failover', sessionId: 'sess-1', context: { input: 2 } });
    const events = report._getFailoverEvents('ch1', 'sess-1');
    expect(events[0].context).toEqual({ input: 2 });
  });
});

// ─── E. generate ──────────────────────────────────────────────────────────────

describe('E. generate', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
    alertCounter = 0;
  });

  afterEach(() => db?.close());

  it('creates and stores a post-service report in the DB', async () => {
    const church = makeChurch('ch1');
    const session = makeSession({ sessionId: 'sess-1' });

    const result = await report.generate(church, session);

    expect(result.id).toBeTruthy();
    expect(result.church_id).toBe('ch1');
    expect(result.session_id).toBe('sess-1');
    expect(result.grade).toBe('A');

    // Verify DB row
    const row = db.prepare('SELECT * FROM post_service_reports WHERE id = ?').get(result.id);
    expect(row).not.toBeNull();
    expect(row.church_id).toBe('ch1');
  });

  it('calculates uptime_pct correctly', async () => {
    const church = makeChurch('ch1');
    const session = makeSession({ durationMinutes: 100, streamTotalMinutes: 80 });

    const result = await report.generate(church, session);
    expect(result.uptime_pct).toBe(80);
  });

  it('caps uptime_pct at 100', async () => {
    const church = makeChurch('ch1');
    // streamTotalMinutes > durationMinutes (edge case)
    const session = makeSession({ durationMinutes: 80, streamTotalMinutes: 100 });

    const result = await report.generate(church, session);
    expect(result.uptime_pct).toBe(100);
  });

  it('sets uptime_pct to null when durationMinutes is 0', async () => {
    const church = makeChurch('ch1');
    const session = makeSession({ durationMinutes: 0, streamTotalMinutes: 0 });

    const result = await report.generate(church, session);
    expect(result.uptime_pct).toBeNull();
  });

  it('counts alerts from the session', async () => {
    addAlert(db, 'ch1', { alertType: 'obs_crash', sessionId: 'sess-1' });
    addAlert(db, 'ch1', { alertType: 'audio_silence', sessionId: 'sess-1' });

    const church = makeChurch('ch1');
    const session = makeSession({ sessionId: 'sess-1' });
    const result = await report.generate(church, session);
    expect(result.alert_count).toBe(2);
  });

  it('counts failover events from alerts', async () => {
    addAlert(db, 'ch1', { alertType: 'signal_loss', sessionId: 'sess-1' });
    addAlert(db, 'ch1', { alertType: 'failover_trigger', sessionId: 'sess-1' });
    addAlert(db, 'ch1', { alertType: 'audio_silence', sessionId: 'sess-1' }); // not a failover

    const church = makeChurch('ch1');
    const session = makeSession({ sessionId: 'sess-1' });
    const result = await report.generate(church, session);
    expect(result.failover_count).toBe(2);
  });

  it('stores device_health as parseable JSON', async () => {
    addAlert(db, 'ch1', { alertType: 'atem_crash', severity: 'CRITICAL', sessionId: 'sess-1' });
    const church = makeChurch('ch1');
    const session = makeSession({ sessionId: 'sess-1' });
    const result = await report.generate(church, session);

    const health = JSON.parse(result.device_health);
    expect(health.atem).toBeDefined();
    expect(health.atem.alerts).toBe(1);
  });

  it('stores recommendations as parseable JSON', async () => {
    const church = makeChurch('ch1');
    const session = makeSession({ sessionId: 'sess-1' });
    const result = await report.generate(church, session);

    const recs = JSON.parse(result.recommendations);
    expect(Array.isArray(recs)).toBe(true);
  });

  it('does not call AI summary when no API key', async () => {
    const generateAiSpy = vi.spyOn(report, '_generateAiSummary');
    const church = makeChurch('ch1');
    const session = makeSession();

    await report.generate(church, session);
    expect(generateAiSpy).not.toHaveBeenCalled();
  });

  it('attempts AI summary when API key is provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: 'Great service!' }] }),
    }));

    const reportWithKey = new PostServiceReport(db, { anthropicApiKey: 'test-key' });
    const church = makeChurch('ch1');
    const session = makeSession();

    const result = await reportWithKey.generate(church, session);
    expect(result.ai_summary).toBe('Great service!');

    vi.unstubAllGlobals();
  });

  it('uses null AI summary when API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const reportWithKey = new PostServiceReport(db, { anthropicApiKey: 'test-key' });
    const church = makeChurch('ch1');
    const session = makeSession();

    const result = await reportWithKey.generate(church, session);
    expect(result.ai_summary).toBeNull();

    vi.unstubAllGlobals();
  });

  it('generates report_html as non-empty string', async () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const result = await report.generate(church, session);
    expect(typeof result.report_html).toBe('string');
    expect(result.report_html.length).toBeGreaterThan(100);
    expect(result.report_html).toContain('<!DOCTYPE html>');
  });

  it('sends email when leadership_emails configured', async () => {
    const lifecycleEmails = { sendEmail: vi.fn().mockResolvedValue(true) };
    const reportWithEmail = new PostServiceReport(db, { lifecycleEmails });
    const church = makeChurch('ch1', { leadershipEmails: 'pastor@church.com,board@church.com' });
    const session = makeSession();

    await reportWithEmail.generate(church, session);

    expect(lifecycleEmails.sendEmail).toHaveBeenCalledTimes(2);
    const [call1] = lifecycleEmails.sendEmail.mock.calls;
    expect(call1[0].to).toBe('pastor@church.com');
    expect(call1[0].subject).toContain('Test Church');
  });

  it('skips email when leadership_emails is null', async () => {
    const lifecycleEmails = { sendEmail: vi.fn() };
    const reportWithEmail = new PostServiceReport(db, { lifecycleEmails });
    const church = makeChurch('ch1', { leadershipEmails: null });
    const session = makeSession();

    await reportWithEmail.generate(church, session);
    expect(lifecycleEmails.sendEmail).not.toHaveBeenCalled();
  });
});

// ─── F. _buildReportText ──────────────────────────────────────────────────────

describe('F. _buildReportText', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
  });

  afterEach(() => db?.close());

  it('includes grade in text report', () => {
    const text = report._buildReportText({
      grade: 'B+',
      duration_minutes: 90,
      uptime_pct: 88,
      alert_count: 3,
      auto_recovered_count: 2,
      failover_count: 1,
      peak_viewers: 200,
      ai_summary: null,
      recommendations: '[]',
      failover_events: '[]',
      created_at: new Date().toISOString(),
    });
    expect(text).toContain('B+');
    expect(text).toContain('90');
    expect(text).toContain('88%');
  });

  it('includes AI summary when present', () => {
    const text = report._buildReportText({
      grade: 'A',
      duration_minutes: 60,
      uptime_pct: 100,
      alert_count: 0,
      auto_recovered_count: 0,
      failover_count: 0,
      peak_viewers: null,
      ai_summary: 'Service went beautifully.',
      recommendations: '[]',
      failover_events: '[]',
      created_at: new Date().toISOString(),
    });
    expect(text).toContain('Service went beautifully.');
    expect(text).toContain('SUMMARY');
  });

  it('skips AI summary section when null', () => {
    const text = report._buildReportText({
      grade: 'A',
      duration_minutes: 60,
      uptime_pct: 100,
      alert_count: 0,
      auto_recovered_count: 0,
      failover_count: 0,
      peak_viewers: null,
      ai_summary: null,
      recommendations: '[]',
      failover_events: '[]',
      created_at: new Date().toISOString(),
    });
    expect(text).not.toContain('SUMMARY');
  });

  it('includes recommendations in text', () => {
    const recs = JSON.stringify([
      { priority: 'high', text: 'Critical: Check ATEM before next service.' },
    ]);
    const text = report._buildReportText({
      grade: 'C',
      duration_minutes: 90,
      uptime_pct: 75,
      alert_count: 5,
      auto_recovered_count: 1,
      failover_count: 2,
      peak_viewers: 50,
      ai_summary: null,
      recommendations: recs,
      failover_events: '[]',
      created_at: new Date().toISOString(),
    });
    expect(text).toContain('[HIGH]');
    expect(text).toContain('Check ATEM');
  });

  it('includes failover events when present', () => {
    const failovers = JSON.stringify([
      { type: 'signal_loss', timestamp: new Date().toISOString(), autoRecovered: true },
    ]);
    const text = report._buildReportText({
      grade: 'B',
      duration_minutes: 90,
      uptime_pct: 90,
      alert_count: 1,
      auto_recovered_count: 1,
      failover_count: 1,
      peak_viewers: null,
      ai_summary: null,
      recommendations: '[]',
      failover_events: failovers,
      created_at: new Date().toISOString(),
    });
    expect(text).toContain('FAILOVER EVENTS');
    expect(text).toContain('signal_loss');
    expect(text).toContain('auto-recovered');
  });
});

// ─── G. _buildReportHtml ──────────────────────────────────────────────────────

describe('G. _buildReportHtml', () => {
  let db, report;

  beforeEach(() => {
    db = createTestDb();
    report = new PostServiceReport(db);
  });

  afterEach(() => db?.close());

  it('generates valid HTML with church name', () => {
    const church = makeChurch('ch1', { name: 'Grace Community' });
    const session = makeSession({ grade: 'A', durationMinutes: 90, streamTotalMinutes: 88 });
    const html = report._buildReportHtml(church, session, {
      uptimePct: 97,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Grace Community');
    expect(html).toContain('POST-SERVICE REPORT');
  });

  it('includes grade letter in HTML', () => {
    const church = makeChurch('ch1');
    const session = makeSession({ grade: 'B+' });
    const html = report._buildReportHtml(church, session, {
      uptimePct: 88,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });
    expect(html).toContain('B+');
  });

  it('includes uptime percentage', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 95,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });
    expect(html).toContain('95%');
  });

  it('includes AI summary section when provided', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 100,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [],
      aiSummary: 'The service went wonderfully with no issues.',
      alerts: [],
    });
    expect(html).toContain('AI Summary');
    expect(html).toContain('wonderfully');
  });

  it('omits AI summary section when null', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 100,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });
    expect(html).not.toContain('AI Summary');
  });

  it('includes device health table when devices have alerts', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 90,
      deviceHealth: { atem: { alerts: 2, critical: 1, autoFixed: 1 } },
      failoverEvents: [],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });
    expect(html).toContain('Device Health');
    expect(html).toContain('atem');
  });

  it('includes failover events table when events exist', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 90,
      deviceHealth: {},
      failoverEvents: [{ type: 'signal_loss', timestamp: new Date().toISOString(), autoRecovered: true }],
      recommendations: [],
      aiSummary: null,
      alerts: [],
    });
    expect(html).toContain('Failover Events');
    expect(html).toContain('Auto-recovered');
  });

  it('includes recommendations list when present', () => {
    const church = makeChurch('ch1');
    const session = makeSession();
    const html = report._buildReportHtml(church, session, {
      uptimePct: 70,
      deviceHealth: {},
      failoverEvents: [],
      recommendations: [{ priority: 'high', text: 'Review ATEM connections.' }],
      aiSummary: null,
      alerts: [],
    });
    expect(html).toContain('Recommendations');
    expect(html).toContain('Review ATEM connections.');
    expect(html).toContain('[HIGH]');
  });

  it('uses green grade color for A grades', () => {
    const church = makeChurch('ch1');
    const session = makeSession({ grade: 'A' });
    const html = report._buildReportHtml(church, session, {
      uptimePct: 100, deviceHealth: {}, failoverEvents: [],
      recommendations: [], aiSummary: null, alerts: [],
    });
    expect(html).toContain('#22c55e'); // green
  });

  it('uses yellow grade color for B grades', () => {
    const church = makeChurch('ch1');
    const session = makeSession({ grade: 'B' });
    const html = report._buildReportHtml(church, session, {
      uptimePct: 88, deviceHealth: {}, failoverEvents: [],
      recommendations: [], aiSummary: null, alerts: [],
    });
    expect(html).toContain('#eab308'); // yellow
  });

  it('uses red grade color for C and below', () => {
    const church = makeChurch('ch1');
    const session = makeSession({ grade: 'C' });
    const html = report._buildReportHtml(church, session, {
      uptimePct: 70, deviceHealth: {}, failoverEvents: [],
      recommendations: [], aiSummary: null, alerts: [],
    });
    expect(html).toContain('#ef4444'); // red
  });
});

// ─── H. AI summary edge cases ────────────────────────────────────────────────

describe('H. _generateAiSummary', () => {
  let db;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => db?.close());

  it('returns null when no API key', async () => {
    const report = new PostServiceReport(db, { anthropicApiKey: null });
    const result = await report._generateAiSummary({}, {}, [], [], []);
    expect(result).toBeNull();
  });

  it('returns null when fetch returns non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const report = new PostServiceReport(db, { anthropicApiKey: 'key-123' });
    const result = await report._generateAiSummary(
      makeChurch('ch1'), makeSession(), [], [], []
    );
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });

  it('returns null when response has no content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [] }),
    }));
    const report = new PostServiceReport(db, { anthropicApiKey: 'key-123' });
    const result = await report._generateAiSummary(
      makeChurch('ch1'), makeSession(), [], [], []
    );
    expect(result).toBeNull();
    vi.unstubAllGlobals();
  });

  it('trims whitespace from AI response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ text: '  Great service!  \n' }] }),
    }));
    const report = new PostServiceReport(db, { anthropicApiKey: 'key-123' });
    const result = await report._generateAiSummary(
      makeChurch('ch1'), makeSession(), [], [], []
    );
    expect(result).toBe('Great service!');
    vi.unstubAllGlobals();
  });
});

// ─── J. Schema ────────────────────────────────────────────────────────────────

describe('J. _ensureSchema', () => {
  it('creates post_service_reports table if not exists', () => {
    const db = new Database(':memory:');
    const report = new PostServiceReport(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('post_service_reports');
    db.close();
  });

  it('is idempotent — second instantiation does not throw', () => {
    const db = new Database(':memory:');
    expect(() => {
      new PostServiceReport(db);
      new PostServiceReport(db);
    }).not.toThrow();
    db.close();
  });
});
