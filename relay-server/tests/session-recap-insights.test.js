import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRecap } from '../src/sessionRecap.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect',
      alert_bot_token TEXT,
      td_telegram_chat_id TEXT,
      leadership_emails TEXT,
      engineer_profile TEXT DEFAULT '{}'
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

  return db;
}

function makeSession(overrides = {}) {
  return {
    sessionId: 'sess-001',
    churchId: 'church-1',
    startedAt: new Date('2026-03-08T09:00:00Z'),
    tdName: 'Mike',
    alertCount: 0,
    autoRecovered: 0,
    escalated: 0,
    audioSilenceCount: 0,
    peakViewers: null,
    streamTotalMinutes: 90,
    durationMinutes: 90,
    streaming: false,
    recordingConfirmed: true,
    alertTypes: {},
    grade: '🟢 Clean',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SessionRecap — Detailed Insights', () => {
  let db;
  let recap;

  beforeEach(() => {
    db = createTestDb();
    recap = new SessionRecap(db);
  });

  // ── Tier gating ──────────────────────────────────────────────────────────

  describe('tier gating', () => {
    it('returns only basic insights for connect tier', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights).toHaveProperty('performanceHighlights');
      expect(insights).toHaveProperty('areasForImprovement');
      expect(insights).not.toHaveProperty('incidentTimeline');
      expect(insights).not.toHaveProperty('comparisonToAverage');
      expect(insights).not.toHaveProperty('tdResponseAnalysis');
      expect(insights).not.toHaveProperty('equipmentReliability');
    });

    it('returns only basic insights for pro tier', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'pro');

      expect(insights).toHaveProperty('performanceHighlights');
      expect(insights).toHaveProperty('areasForImprovement');
      expect(insights).not.toHaveProperty('incidentTimeline');
    });

    it('returns full insights for pro_plus tier', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'pro_plus');

      expect(insights).toHaveProperty('performanceHighlights');
      expect(insights).toHaveProperty('areasForImprovement');
      expect(insights).toHaveProperty('incidentTimeline');
      expect(insights).toHaveProperty('comparisonToAverage');
      expect(insights).toHaveProperty('tdResponseAnalysis');
      expect(insights).toHaveProperty('equipmentReliability');
    });

    it('returns full insights for enterprise tier', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'enterprise');

      expect(insights).toHaveProperty('incidentTimeline');
      expect(insights).toHaveProperty('comparisonToAverage');
    });

    it('defaults to connect tier if no tier provided', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session);

      expect(insights).not.toHaveProperty('incidentTimeline');
    });
  });

  // ── Performance Highlights ───────────────────────────────────────────────

  describe('performanceHighlights', () => {
    it('highlights zero audio issues on clean session', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.performanceHighlights).toContain('Zero audio issues');
      expect(insights.performanceHighlights).toContain('No alerts triggered');
      expect(insights.performanceHighlights).toContain('100% stream uptime');
      expect(insights.performanceHighlights).toContain('Recording confirmed');
    });

    it('highlights all auto-resolved when applicable', () => {
      const session = makeSession({
        alertCount: 3,
        autoRecovered: 3,
        escalated: 0,
      });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.performanceHighlights).toContain('All alerts auto-resolved');
      expect(insights.performanceHighlights).toContain('Zero escalations');
    });

    it('includes peak viewer count', () => {
      const session = makeSession({ peakViewers: 250 });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.performanceHighlights).toContain('Peak viewers: 250');
    });

    it('highlights high stream uptime (90-99%)', () => {
      const session = makeSession({
        streamTotalMinutes: 85,
        durationMinutes: 90,
      });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.performanceHighlights).toContain('94% stream uptime');
    });

    it('returns no stream highlight if stream was down', () => {
      const session = makeSession({ streamTotalMinutes: 0 });
      const insights = recap.generateDetailedInsights(session, 'connect');

      const streamHighlights = insights.performanceHighlights.filter(h => h.includes('stream uptime'));
      expect(streamHighlights).toHaveLength(0);
    });
  });

  // ── Areas for Improvement ────────────────────────────────────────────────

  describe('areasForImprovement', () => {
    it('flags audio silence events', () => {
      const session = makeSession({ audioSilenceCount: 3 });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('audio silence'))).toBe(true);
    });

    it('flags unconfirmed recording', () => {
      const session = makeSession({ recordingConfirmed: false });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('Recording was not confirmed'))).toBe(true);
    });

    it('flags stream not running', () => {
      const session = makeSession({ streamTotalMinutes: 0 });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('Stream did not run'))).toBe(true);
    });

    it('flags low stream uptime', () => {
      const session = makeSession({
        streamTotalMinutes: 40,
        durationMinutes: 90,
      });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('Stream was only up'))).toBe(true);
    });

    it('flags escalated alerts', () => {
      const session = makeSession({ escalated: 2 });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('manual intervention'))).toBe(true);
    });

    it('flags recurring alert types (3+ times)', () => {
      const session = makeSession({
        alertCount: 5,
        alertTypes: { stream_stopped: 4, audio_low: 1 },
      });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('stream stopped') && i.includes('4 times'))).toBe(true);
      // audio_low only fired once — should not be flagged
      expect(insights.areasForImprovement.some(i => i.includes('audio low'))).toBe(false);
    });

    it('returns empty improvements for perfect session', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement).toHaveLength(0);
    });

    it('flags unused devices', () => {
      const session = makeSession({
        deviceStats: { 'Camera 3': { uptimeMinutes: 0 }, 'Camera 1': { uptimeMinutes: 60 } },
      });
      const insights = recap.generateDetailedInsights(session, 'connect');

      expect(insights.areasForImprovement.some(i => i.includes('Camera 3') && i.includes('unused'))).toBe(true);
      expect(insights.areasForImprovement.some(i => i.includes('Camera 1'))).toBe(false);
    });
  });

  // ── Incident Timeline (Pro+) ────────────────────────────────────────────

  describe('incidentTimeline', () => {
    it('builds timeline from service_events', () => {
      const session = makeSession();

      // Insert events
      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, auto_resolved, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:10:00Z', 'stream_stopped', 'Encoder disconnected', 1, '2026-03-08T09:13:00Z', 0, 'sess-001');

      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, auto_resolved, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:20:00Z', 'audio_silence', 'Mic 2', 1, '2026-03-08T09:21:00Z', 1, 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const timeline = insights.incidentTimeline;

      expect(timeline).toHaveLength(2);
      expect(timeline[0].eventType).toBe('stream_stopped');
      expect(timeline[0].duration).toBe(3); // 3 minutes
      expect(timeline[0].resolution).toBe('manual');

      expect(timeline[1].eventType).toBe('audio_silence');
      expect(timeline[1].duration).toBe(1);
      expect(timeline[1].resolution).toBe('auto');
    });

    it('marks unresolved events correctly', () => {
      const session = makeSession();

      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, auto_resolved, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:30:00Z', 'atem_disconnected', '', 0, 0, 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const timeline = insights.incidentTimeline;

      expect(timeline).toHaveLength(1);
      expect(timeline[0].resolution).toBe('unresolved');
      expect(timeline[0].duration).toBeNull();
    });

    it('returns empty array with no session ID', () => {
      const session = makeSession({ sessionId: null });
      const insights = recap.generateDetailedInsights(session, 'pro_plus');

      expect(insights.incidentTimeline).toEqual([]);
    });
  });

  // ── Comparison to Average (Pro+) ────────────────────────────────────────

  describe('comparisonToAverage', () => {
    it('returns note when not enough history', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'pro_plus');

      expect(insights.comparisonToAverage._note).toMatch(/Not enough/);
    });

    it('compares to historical averages when data exists', () => {
      // Insert historical sessions
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count, auto_recovered_count, escalated_count, audio_silence_count, stream_runtime_minutes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`hist-${i}`, 'church-1', '2026-03-01T09:00:00Z', '2026-03-01T10:30:00Z', 90, 4, 2, 1, 2, 85);
      }

      // Current session is better than average
      const session = makeSession({
        alertCount: 1,
        escalated: 0,
        audioSilenceCount: 0,
        streamTotalMinutes: 90,
      });

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const comparison = insights.comparisonToAverage;

      expect(comparison.alerts.verdict).toBe('better');
      expect(comparison.alerts.value).toBe(1);
      expect(comparison.alerts.average).toBe(4);

      expect(comparison.escalations.verdict).toBe('better');
      expect(comparison.audioSilence.verdict).toBe('better');
      expect(comparison.streamRuntime.verdict).toBe('better');
    });

    it('marks worse when session is worse than average', () => {
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count, auto_recovered_count, escalated_count, audio_silence_count, stream_runtime_minutes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`hist-${i}`, 'church-1', '2026-03-01T09:00:00Z', '2026-03-01T10:30:00Z', 90, 0, 0, 0, 0, 90);
      }

      const session = makeSession({
        alertCount: 5,
        escalated: 3,
        audioSilenceCount: 4,
        streamTotalMinutes: 30,
      });

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const comparison = insights.comparisonToAverage;

      expect(comparison.alerts.verdict).toBe('worse');
      expect(comparison.escalations.verdict).toBe('worse');
      expect(comparison.streamRuntime.verdict).toBe('worse');
    });
  });

  // ── TD Response Analysis (Pro+) ─────────────────────────────────────────

  describe('tdResponseAnalysis', () => {
    it('returns nulls when no acknowledged alerts', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'pro_plus');

      expect(insights.tdResponseAnalysis.averageResponseMinutes).toBeNull();
      expect(insights.tdResponseAnalysis.totalAcknowledged).toBe(0);
    });

    it('calculates response times from alerts table', () => {
      const session = makeSession();

      // 2-minute response
      db.prepare(`
        INSERT INTO alerts (id, church_id, alert_type, severity, created_at, acknowledged_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('a1', 'church-1', 'stream_stopped', 'critical', '2026-03-08T09:10:00Z', '2026-03-08T09:12:00Z', 'sess-001');

      // 5-minute response
      db.prepare(`
        INSERT INTO alerts (id, church_id, alert_type, severity, created_at, acknowledged_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('a2', 'church-1', 'audio_silence', 'warning', '2026-03-08T09:20:00Z', '2026-03-08T09:25:00Z', 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const analysis = insights.tdResponseAnalysis;

      expect(analysis.totalAcknowledged).toBe(2);
      expect(analysis.fastest).toBe(2);
      expect(analysis.slowest).toBe(5);
      expect(analysis.averageResponseMinutes).toBe(3.5);
    });
  });

  // ── Equipment Reliability (Pro+) ────────────────────────────────────────

  describe('equipmentReliability', () => {
    it('returns empty array with no events', () => {
      const session = makeSession();
      const insights = recap.generateDetailedInsights(session, 'pro_plus');

      expect(insights.equipmentReliability).toEqual([]);
    });

    it('calculates per-device uptime from events', () => {
      const session = makeSession({ durationMinutes: 90 });

      // ATEM down for 10 minutes
      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:15:00Z', 'atem_disconnected', '', 1, '2026-03-08T09:25:00Z', 'sess-001');

      // Stream down for 5 minutes
      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:30:00Z', 'stream_stopped', 'Encoder crash', 1, '2026-03-08T09:35:00Z', 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const equipment = insights.equipmentReliability;

      expect(equipment.length).toBeGreaterThanOrEqual(2);

      const atem = equipment.find(e => e.device === 'ATEM Switcher');
      expect(atem).toBeDefined();
      expect(atem.uptimePercent).toBe(89); // (90 - 10) / 90 * 100

      const encoder = equipment.find(e => e.device === 'Stream Encoder');
      expect(encoder).toBeDefined();
      expect(encoder.uptimePercent).toBe(94); // (90 - 5) / 90 * 100
    });

    it('sorts by worst uptime first', () => {
      const session = makeSession({ durationMinutes: 90 });

      // ATEM down 10 min
      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:15:00Z', 'atem_disconnected', '', 1, '2026-03-08T09:25:00Z', 'sess-001');

      // Stream down 20 min
      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, resolved_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:30:00Z', 'stream_stopped', '', 1, '2026-03-08T09:50:00Z', 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const equipment = insights.equipmentReliability;

      // Stream encoder should be first (worse uptime)
      expect(equipment[0].device).toBe('Stream Encoder');
      expect(equipment[1].device).toBe('ATEM Switcher');
    });

    it('assigns 5 min downtime for unresolved events', () => {
      const session = makeSession({ durationMinutes: 60 });

      db.prepare(`
        INSERT INTO service_events (church_id, timestamp, event_type, details, resolved, auto_resolved, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('church-1', '2026-03-08T09:15:00Z', 'audio_silence', '', 0, 0, 'sess-001');

      const insights = recap.generateDetailedInsights(session, 'pro_plus');
      const audio = insights.equipmentReliability.find(e => e.device === 'Audio System');

      expect(audio).toBeDefined();
      expect(audio.uptimePercent).toBe(92); // (60 - 5) / 60 * 100
    });
  });

  // ── Device inference ─────────────────────────────────────────────────────

  describe('_inferDevice', () => {
    it('infers ATEM Switcher', () => {
      expect(recap._inferDevice('atem_disconnected', '')).toBe('ATEM Switcher');
    });

    it('infers Camera with number from details', () => {
      expect(recap._inferDevice('camera_offline', 'Camera 3 lost')).toBe('Camera 3');
    });

    it('infers Camera without number', () => {
      expect(recap._inferDevice('camera_offline', '')).toBe('Camera');
    });

    it('infers Audio System', () => {
      expect(recap._inferDevice('audio_silence', 'Mic 1')).toBe('Audio System');
    });

    it('infers Stream Encoder', () => {
      expect(recap._inferDevice('stream_stopped', '')).toBe('Stream Encoder');
    });

    it('infers Recording System', () => {
      expect(recap._inferDevice('recording_failed', '')).toBe('Recording System');
    });

    it('infers Network', () => {
      expect(recap._inferDevice('network_disconnect', '')).toBe('Network');
    });

    it('returns null for unknown event types', () => {
      expect(recap._inferDevice('misc_event', '')).toBeNull();
    });
  });
});

// ─── Weekly Summary Insights ──────────────────────────────────────────────────

describe('SessionRecap — Weekly Summary Insights', () => {
  let db;
  let recap;

  beforeEach(() => {
    db = createTestDb();
    recap = new SessionRecap(db);
  });

  describe('tier gating', () => {
    it('returns null for non-Pro+ tiers', () => {
      const sessions = [makeSession()];
      expect(recap.generateWeeklySummaryInsights(sessions, 'connect')).toBeNull();
      expect(recap.generateWeeklySummaryInsights(sessions, 'pro')).toBeNull();
    });

    it('returns insights for pro_plus tier', () => {
      const sessions = [makeSession()];
      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');

      expect(result).not.toBeNull();
      expect(result).toHaveProperty('trendingMetrics');
      expect(result).toHaveProperty('recurringIssues');
      expect(result).toHaveProperty('bestWorstSession');
      expect(result).toHaveProperty('volunteerPatterns');
    });

    it('returns insights for enterprise tier', () => {
      const result = recap.generateWeeklySummaryInsights([makeSession()], 'enterprise');
      expect(result).not.toBeNull();
    });

    it('returns note for empty sessions', () => {
      const result = recap.generateWeeklySummaryInsights([], 'pro_plus');
      expect(result._note).toMatch(/No sessions/);
    });
  });

  describe('trendingMetrics', () => {
    it('returns empty for single session', () => {
      const result = recap.generateWeeklySummaryInsights([makeSession()], 'pro_plus');
      expect(result.trendingMetrics).toEqual([]);
    });

    it('detects improving alert trend', () => {
      const sessions = [
        makeSession({ alertCount: 5 }),
        makeSession({ alertCount: 4 }),
        makeSession({ alertCount: 2 }),
        makeSession({ alertCount: 1 }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const alertTrend = result.trendingMetrics.find(t => t.metric === 'Alerts');

      expect(alertTrend.trend).toBe('improving');
    });

    it('detects declining alert trend', () => {
      const sessions = [
        makeSession({ alertCount: 0 }),
        makeSession({ alertCount: 1 }),
        makeSession({ alertCount: 4 }),
        makeSession({ alertCount: 6 }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const alertTrend = result.trendingMetrics.find(t => t.metric === 'Alerts');

      expect(alertTrend.trend).toBe('declining');
    });

    it('detects stable trend when values are consistent', () => {
      const sessions = [
        makeSession({ alertCount: 2 }),
        makeSession({ alertCount: 2 }),
        makeSession({ alertCount: 2 }),
        makeSession({ alertCount: 2 }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const alertTrend = result.trendingMetrics.find(t => t.metric === 'Alerts');

      expect(alertTrend.trend).toBe('stable');
    });

    it('treats improving stream runtime as improving (higher is better)', () => {
      const sessions = [
        makeSession({ streamTotalMinutes: 30 }),
        makeSession({ streamTotalMinutes: 40 }),
        makeSession({ streamTotalMinutes: 80 }),
        makeSession({ streamTotalMinutes: 90 }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const streamTrend = result.trendingMetrics.find(t => t.metric === 'Stream runtime');

      expect(streamTrend.trend).toBe('improving');
    });
  });

  describe('recurringIssues', () => {
    it('identifies alert type appearing in >50% of sessions', () => {
      const sessions = [
        makeSession({ alertTypes: { stream_stopped: 1 } }),
        makeSession({ alertTypes: { stream_stopped: 2 } }),
        makeSession({ alertTypes: { audio_silence: 1 } }),
        makeSession({ alertTypes: { stream_stopped: 1, audio_silence: 1 } }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const recurring = result.recurringIssues;

      const streamIssue = recurring.find(r => r.alertType === 'stream_stopped');
      expect(streamIssue).toBeDefined();
      expect(streamIssue.sessionCount).toBe(3);
      expect(streamIssue.frequency).toBe(75);

      // audio_silence appeared in 2/4 = 50% — should NOT be included (>50% required)
      const audioIssue = recurring.find(r => r.alertType === 'audio_silence');
      expect(audioIssue).toBeUndefined();
    });

    it('returns empty when no recurring issues', () => {
      const sessions = [
        makeSession({ alertTypes: { stream_stopped: 1 } }),
        makeSession({ alertTypes: { audio_silence: 1 } }),
        makeSession({ alertTypes: { atem_disconnected: 1 } }),
        makeSession({ alertTypes: { recording_failed: 1 } }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      expect(result.recurringIssues).toEqual([]);
    });

    it('sorts by frequency descending', () => {
      const sessions = [
        makeSession({ alertTypes: { stream_stopped: 1, audio_silence: 1 } }),
        makeSession({ alertTypes: { stream_stopped: 1, audio_silence: 1 } }),
        makeSession({ alertTypes: { stream_stopped: 1, audio_silence: 1 } }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const recurring = result.recurringIssues;

      expect(recurring.length).toBe(2);
      // Both at 100%, order may vary but both should be present
      expect(recurring.every(r => r.frequency === 100)).toBe(true);
    });
  });

  describe('bestWorstSession', () => {
    it('identifies best and worst sessions', () => {
      const sessions = [
        makeSession({ sessionId: 'sess-clean', alertCount: 0, escalated: 0, audioSilenceCount: 0, recordingConfirmed: true, streamTotalMinutes: 90, grade: '🟢 Clean' }),
        makeSession({ sessionId: 'sess-bad', alertCount: 5, escalated: 3, audioSilenceCount: 2, recordingConfirmed: false, streamTotalMinutes: 0, grade: '🔴 Required intervention' }),
        makeSession({ sessionId: 'sess-mid', alertCount: 2, escalated: 0, audioSilenceCount: 1, recordingConfirmed: true, streamTotalMinutes: 85 }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const bw = result.bestWorstSession;

      expect(bw.best.sessionId).toBe('sess-clean');
      expect(bw.worst.sessionId).toBe('sess-bad');
    });

    it('returns null worst when only one session', () => {
      const sessions = [makeSession({ sessionId: 'only-one' })];
      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');

      expect(result.bestWorstSession.best.sessionId).toBe('only-one');
      expect(result.bestWorstSession.worst).toBeNull();
    });
  });

  describe('volunteerPatterns', () => {
    it('aggregates per-TD stats', () => {
      const sessions = [
        makeSession({ tdName: 'Alice', alertCount: 0, escalated: 0, grade: '🟢 Clean' }),
        makeSession({ tdName: 'Alice', alertCount: 2, escalated: 0, grade: '🟡 Minor issues (auto-resolved)' }),
        makeSession({ tdName: 'Bob', alertCount: 5, escalated: 3, grade: '🔴 Required intervention' }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const patterns = result.volunteerPatterns;

      const alice = patterns.find(p => p.tdName === 'Alice');
      expect(alice.sessionsWorked).toBe(2);
      expect(alice.avgAlerts).toBe(1);
      expect(alice.avgEscalations).toBe(0);
      expect(alice.cleanRate).toBe(50); // 1 clean out of 2

      const bob = patterns.find(p => p.tdName === 'Bob');
      expect(bob.sessionsWorked).toBe(1);
      expect(bob.avgAlerts).toBe(5);
      expect(bob.avgEscalations).toBe(3);
      expect(bob.cleanRate).toBe(0);
    });

    it('sorts by clean rate descending', () => {
      const sessions = [
        makeSession({ tdName: 'Worst', alertCount: 5, escalated: 3, grade: '🔴 Required intervention' }),
        makeSession({ tdName: 'Best', alertCount: 0, escalated: 0, grade: '🟢 Clean' }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      const patterns = result.volunteerPatterns;

      expect(patterns[0].tdName).toBe('Best');
      expect(patterns[1].tdName).toBe('Worst');
    });

    it('uses Unknown for sessions without TD name', () => {
      const sessions = [
        makeSession({ tdName: null }),
      ];

      const result = recap.generateWeeklySummaryInsights(sessions, 'pro_plus');
      expect(result.volunteerPatterns[0].tdName).toBe('Unknown');
    });
  });
});

// ─── Empty sessions (no events at all) ───────────────────────────────────────

describe('SessionRecap — Empty sessions', () => {
  let db, recap;

  beforeEach(() => {
    db = createTestDb();
    recap = new SessionRecap(db);
  });

  it('generateDetailedInsights works with completely empty session', () => {
    const session = makeSession({
      alertCount: 0,
      autoRecovered: 0,
      escalated: 0,
      audioSilenceCount: 0,
      peakViewers: null,
      streamTotalMinutes: 0,
      durationMinutes: 0,
      recordingConfirmed: false,
      alertTypes: {},
    });

    const insights = recap.generateDetailedInsights(session, 'pro_plus');
    expect(insights.performanceHighlights).toBeDefined();
    expect(insights.areasForImprovement).toBeDefined();
    expect(insights.incidentTimeline).toEqual([]);
  });

  it('formatRecap works with zero-duration session', () => {
    const church = { name: 'Test Church' };
    const session = makeSession({
      durationMinutes: 0,
      streamTotalMinutes: 0,
      alertCount: 0,
      audioSilenceCount: 0,
      recordingConfirmed: false,
    });

    const text = recap.formatRecap(church, session);
    expect(text).toContain('Test Church');
    expect(text).toContain('0m');
  });

  it('weekly summary handles empty sessions array', () => {
    const result = recap.generateWeeklySummaryInsights([], 'pro_plus');
    expect(result._note).toContain('No sessions');
  });

  it('weekly summary handles null sessions', () => {
    const result = recap.generateWeeklySummaryInsights(null, 'pro_plus');
    // null sessions fails the !sessions check, returns the empty note
    expect(result._note).toContain('No sessions');
  });
});

// ─── Sessions missing expected fields ──────────────────────────────────────────

describe('SessionRecap — Missing fields', () => {
  let db, recap;

  beforeEach(() => {
    db = createTestDb();
    recap = new SessionRecap(db);
  });

  it('generateDetailedInsights handles session with undefined alertTypes', () => {
    const session = makeSession({ alertTypes: undefined });
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.areasForImprovement).toBeDefined();
  });

  it('generateDetailedInsights handles session with null peakViewers', () => {
    const session = makeSession({ peakViewers: null });
    const insights = recap.generateDetailedInsights(session, 'connect');
    const hasViewerHighlight = insights.performanceHighlights.some(h => h.includes('Peak viewers'));
    expect(hasViewerHighlight).toBe(false);
  });

  it('generateDetailedInsights handles session with zero peakViewers', () => {
    const session = makeSession({ peakViewers: 0 });
    const insights = recap.generateDetailedInsights(session, 'connect');
    const hasViewerHighlight = insights.performanceHighlights.some(h => h.includes('Peak viewers'));
    expect(hasViewerHighlight).toBe(false);
  });

  it('generateDetailedInsights handles session with missing durationMinutes', () => {
    const session = makeSession({ durationMinutes: undefined, streamTotalMinutes: 90 });
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.performanceHighlights).toBeDefined();
  });

  it('comparisonToAverage handles missing churchId', () => {
    const session = makeSession({ churchId: undefined });
    const insights = recap.generateDetailedInsights(session, 'pro_plus');
    expect(insights.comparisonToAverage).toEqual({});
  });

  it('equipmentReliability handles session with no sessionId', () => {
    const session = makeSession({ sessionId: null, durationMinutes: 90 });
    const insights = recap.generateDetailedInsights(session, 'pro_plus');
    expect(insights.equipmentReliability).toEqual([]);
  });

  it('equipmentReliability handles session with zero duration', () => {
    const session = makeSession({ durationMinutes: 0 });
    const insights = recap.generateDetailedInsights(session, 'pro_plus');
    expect(insights.equipmentReliability).toEqual([]);
  });

  it('formatRecap handles session with string startedAt', () => {
    const church = { name: 'Test Church' };
    const session = makeSession({ startedAt: '2026-03-08T09:00:00Z' });
    const text = recap.formatRecap(church, session);
    expect(text).toContain('Test Church');
  });
});

// ─── Strict tier gating ──────────────────────────────────────────────────────

describe('SessionRecap — Strict tier gating', () => {
  let db, recap;

  beforeEach(() => {
    db = createTestDb();
    recap = new SessionRecap(db);
  });

  it('basic tier (connect) cannot access incidentTimeline', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.incidentTimeline).toBeUndefined();
  });

  it('basic tier (pro) cannot access incidentTimeline', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'pro');
    expect(insights.incidentTimeline).toBeUndefined();
  });

  it('basic tier cannot access comparisonToAverage', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.comparisonToAverage).toBeUndefined();
  });

  it('basic tier cannot access tdResponseAnalysis', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.tdResponseAnalysis).toBeUndefined();
  });

  it('basic tier cannot access equipmentReliability', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'connect');
    expect(insights.equipmentReliability).toBeUndefined();
  });

  it('pro_plus tier can access all Pro+ insights', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'pro_plus');
    expect(insights.incidentTimeline).toBeDefined();
    expect(insights.comparisonToAverage).toBeDefined();
    expect(insights.tdResponseAnalysis).toBeDefined();
    expect(insights.equipmentReliability).toBeDefined();
  });

  it('enterprise tier can access all Pro+ insights', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'enterprise');
    expect(insights.incidentTimeline).toBeDefined();
    expect(insights.comparisonToAverage).toBeDefined();
  });

  it('generateWeeklySummaryInsights returns null for connect tier', () => {
    expect(recap.generateWeeklySummaryInsights([makeSession()], 'connect')).toBeNull();
  });

  it('generateWeeklySummaryInsights returns null for pro tier', () => {
    expect(recap.generateWeeklySummaryInsights([makeSession()], 'pro')).toBeNull();
  });

  it('generateWeeklySummaryInsights returns null for plus tier', () => {
    expect(recap.generateWeeklySummaryInsights([makeSession()], 'plus')).toBeNull();
  });

  it('unknown tier defaults to connect (no Pro+ access)', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, 'unknown_tier');
    expect(insights.incidentTimeline).toBeUndefined();
    expect(insights.comparisonToAverage).toBeUndefined();
  });

  it('empty string tier defaults to connect (no Pro+ access)', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, '');
    expect(insights.incidentTimeline).toBeUndefined();
  });

  it('null tier defaults to connect (no Pro+ access)', () => {
    const session = makeSession();
    const insights = recap.generateDetailedInsights(session, null);
    expect(insights.incidentTimeline).toBeUndefined();
  });
});
