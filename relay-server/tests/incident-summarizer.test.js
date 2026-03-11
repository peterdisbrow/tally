import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IncidentSummarizer, TIERS, TEMPLATES } from '../src/incidentSummarizer.js';
import Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      td_telegram_chat_id TEXT DEFAULT '',
      alert_bot_token TEXT DEFAULT '',
      summary_tiers TEXT DEFAULT '{}'
    )
  `);
  db.exec(`
    INSERT INTO churches (churchId, name, td_telegram_chat_id, alert_bot_token)
    VALUES ('church-1', 'Test Church', '12345', 'bot:token')
  `);
  return db;
}

function mockChatEngine() {
  return {
    saveMessage: vi.fn().mockReturnValue({
      id: 'msg-1', church_id: 'church-1', timestamp: new Date().toISOString(),
      sender_name: 'Tally', sender_role: 'system', source: 'system', message: 'test',
    }),
    broadcastChat: vi.fn(),
  };
}

function mockAlertEngine() {
  return {
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function mockWeeklyDigest() {
  return {
    addEvent: vi.fn().mockReturnValue(1),
  };
}

function mockSessionRecap() {
  return {
    getActiveSessionId: vi.fn().mockReturnValue('session-1'),
    getActiveSession: vi.fn().mockReturnValue(null),
  };
}

function mockSignalFailover() {
  return {
    getState: vi.fn().mockReturnValue({ state: 'HEALTHY' }),
    onTransition: vi.fn(),
  };
}

function mockChurches() {
  const map = new Map();
  map.set('church-1', {
    churchId: 'church-1',
    name: 'Test Church',
    status: {
      obs: { connected: true, streaming: true },
      atem: { connected: false },
      encoder: { connected: true, bitrateKbps: 0 },
    },
  });
  return map;
}

function makeSnapshot(overrides = {}) {
  return {
    state: 'CONFIRMED_OUTAGE',
    outageStartedAt: Date.now() - 10000,
    stateLog: [
      { ts: new Date().toISOString(), from: 'HEALTHY', to: 'SUSPECTED_BLACK', trigger: 'encoder_bitrate_loss' },
      { ts: new Date().toISOString(), from: 'SUSPECTED_BLACK', to: 'CONFIRMED_OUTAGE', trigger: 'black_timeout' },
    ],
    ...overrides,
  };
}

function createSummarizer(overrides = {}) {
  const db = overrides.db || createTestDb();
  const chatEngine = overrides.chatEngine || mockChatEngine();
  const alertEngine = overrides.alertEngine || mockAlertEngine();
  const weeklyDigest = overrides.weeklyDigest || mockWeeklyDigest();
  const sessionRecap = overrides.sessionRecap || mockSessionRecap();
  const signalFailover = overrides.signalFailover || mockSignalFailover();
  const churches = overrides.churches || mockChurches();

  const summarizer = new IncidentSummarizer({
    db, churches, chatEngine, alertEngine, weeklyDigest, sessionRecap, signalFailover,
  });

  return { summarizer, db, chatEngine, alertEngine, weeklyDigest, sessionRecap, signalFailover, churches };
}

// Mock fetch globally for AI tests
function mockFetch(response = {}) {
  const defaultResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ text: 'AI generated summary for test.' }],
      usage: { input_tokens: 150, output_tokens: 30 },
    }),
    text: async () => '',
  };
  const merged = { ...defaultResponse, ...response };
  return vi.spyOn(global, 'fetch').mockResolvedValue(merged);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('IncidentSummarizer', () => {

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  // ── A. Tier Classification ─────────────────────────────────────────────────

  describe('Tier Classification', () => {
    it('classifies CONFIRMED_OUTAGE as critical', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('SUSPECTED_BLACK', 'CONFIRMED_OUTAGE')).toBe(TIERS.CRITICAL);
    });

    it('classifies FAILOVER_ACTIVE as critical', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('CONFIRMED_OUTAGE', 'FAILOVER_ACTIVE')).toBe(TIERS.CRITICAL);
    });

    it('classifies ATEM_LOST as warning', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('HEALTHY', 'ATEM_LOST')).toBe(TIERS.WARNING);
    });

    it('classifies recovery (any → HEALTHY) as recovery', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('FAILOVER_ACTIVE', 'HEALTHY')).toBe(TIERS.RECOVERY);
      expect(summarizer._classifyTransition('ATEM_LOST', 'HEALTHY')).toBe(TIERS.RECOVERY);
      expect(summarizer._classifyTransition('SUSPECTED_BLACK', 'HEALTHY')).toBe(TIERS.RECOVERY);
      expect(summarizer._classifyTransition('CONFIRMED_OUTAGE', 'HEALTHY')).toBe(TIERS.RECOVERY);
    });

    it('classifies SUSPECTED_BLACK as info', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('HEALTHY', 'SUSPECTED_BLACK')).toBe(TIERS.INFO);
    });

    it('classifies self-transitions as info', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._classifyTransition('FAILOVER_ACTIVE', 'FAILOVER_ACTIVE')).toBe(TIERS.INFO);
      expect(summarizer._classifyTransition('CONFIRMED_OUTAGE', 'CONFIRMED_OUTAGE')).toBe(TIERS.INFO);
    });
  });

  // ── B. Template Fallback ───────────────────────────────────────────────────

  describe('Template Fallback', () => {
    it('produces templates for all known transitions', () => {
      const { summarizer } = createSummarizer();
      const transitions = [
        ['HEALTHY', 'SUSPECTED_BLACK'],
        ['HEALTHY', 'ATEM_LOST'],
        ['SUSPECTED_BLACK', 'CONFIRMED_OUTAGE'],
        ['ATEM_LOST', 'CONFIRMED_OUTAGE'],
        ['CONFIRMED_OUTAGE', 'FAILOVER_ACTIVE'],
        ['SUSPECTED_BLACK', 'HEALTHY'],
        ['ATEM_LOST', 'HEALTHY'],
        ['FAILOVER_ACTIVE', 'HEALTHY'],
        ['CONFIRMED_OUTAGE', 'HEALTHY'],
      ];

      for (const [from, to] of transitions) {
        const summary = summarizer._templateSummary(from, to, 'test_trigger', 'Test Church', makeSnapshot());
        expect(summary).toBeTruthy();
        expect(summary.length).toBeGreaterThan(10);
      }
    });

    it('includes church name in templates', () => {
      const { summarizer } = createSummarizer();
      const summary = summarizer._templateSummary('HEALTHY', 'ATEM_LOST', 'atem_lost', 'Grace Community', makeSnapshot());
      expect(summary).toContain('Grace Community');
    });

    it('produces generic fallback for unknown transitions', () => {
      const { summarizer } = createSummarizer();
      const summary = summarizer._templateSummary('UNKNOWN', 'OTHER', 'weird_trigger', 'Test Church', makeSnapshot());
      expect(summary).toContain('Test Church');
      expect(summary).toContain('weird trigger');
    });

    it('uses template when no ANTHROPIC_API_KEY', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { summarizer, weeklyDigest } = createSummarizer();
      await summarizer.handleTransition('church-1', 'SUSPECTED_BLACK', 'CONFIRMED_OUTAGE', 'black_timeout', makeSnapshot());

      // Should have written to timeline with a template summary
      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      const summary = weeklyDigest.addEvent.mock.calls[0][2];
      expect(summary).toContain('Stream outage confirmed');
    });

    it('uses template when API returns error', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockFetch({ ok: false, status: 500 });

      const { summarizer, weeklyDigest } = createSummarizer();
      await summarizer.handleTransition('church-1', 'SUSPECTED_BLACK', 'CONFIRMED_OUTAGE', 'black_timeout', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      const summary = weeklyDigest.addEvent.mock.calls[0][2];
      expect(summary).toContain('Stream outage confirmed');
    });
  });

  // ── C. Model Selection ─────────────────────────────────────────────────────

  describe('Model Selection', () => {
    it('selects sonnet for critical tier', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._selectModel(TIERS.CRITICAL)).toBe('sonnet');
    });

    it('selects sonnet for warning tier', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._selectModel(TIERS.WARNING)).toBe('sonnet');
    });

    it('selects none for info tier (template only)', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._selectModel(TIERS.INFO)).toBe('none');
    });

    it('selects sonnet for recovery tier', () => {
      const { summarizer } = createSummarizer();
      expect(summarizer._selectModel(TIERS.RECOVERY)).toBe('sonnet');
    });
  });

  // ── D. Fire-and-Forget Safety ──────────────────────────────────────────────

  describe('Fire-and-Forget Safety', () => {
    it('falls back to template on AI timeout', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('timeout'));

      const { summarizer, weeklyDigest } = createSummarizer();
      await summarizer.handleTransition('church-1', 'HEALTHY', 'ATEM_LOST', 'atem_lost', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      const summary = weeklyDigest.addEvent.mock.calls[0][2];
      expect(summary).toContain('ATEM connection lost');
    });

    it('does not throw when chat delivery fails', async () => {
      const chatEngine = mockChatEngine();
      chatEngine.saveMessage.mockImplementation(() => { throw new Error('DB error'); });

      const { summarizer } = createSummarizer({ chatEngine });
      // Should not throw
      await summarizer.handleTransition('church-1', 'HEALTHY', 'ATEM_LOST', 'atem_lost', makeSnapshot());
    });

    it('does not throw when telegram delivery fails', async () => {
      const alertEngine = mockAlertEngine();
      alertEngine.sendTelegramMessage.mockRejectedValue(new Error('Network error'));

      const db = createTestDb();
      // Set church to have telegram enabled for warning tier
      db.prepare("UPDATE churches SET summary_tiers = ? WHERE churchId = ?").run(
        JSON.stringify({ warning: { telegram: true, chat: true, timeline: true } }),
        'church-1'
      );

      const { summarizer } = createSummarizer({ alertEngine, db });
      // Should not throw
      await summarizer.handleTransition('church-1', 'HEALTHY', 'ATEM_LOST', 'atem_lost', makeSnapshot());
    });

    it('handleTransition never throws (outer catch)', async () => {
      const { summarizer } = createSummarizer();
      // Pass invalid data that might cause internal errors
      await summarizer.handleTransition(null, null, null, null, null);
      // If we get here, it didn't throw
    });
  });

  // ── E. Routing ─────────────────────────────────────────────────────────────

  describe('Routing', () => {
    it('routes critical to timeline + chat + telegram', async () => {
      const { summarizer, weeklyDigest, chatEngine, alertEngine } = createSummarizer();
      await summarizer.handleTransition('church-1', 'SUSPECTED_BLACK', 'CONFIRMED_OUTAGE', 'black_timeout', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      expect(chatEngine.saveMessage).toHaveBeenCalled();
      expect(chatEngine.broadcastChat).toHaveBeenCalled();
      expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
    });

    it('routes warning to timeline + chat only (no telegram)', async () => {
      const { summarizer, weeklyDigest, chatEngine, alertEngine } = createSummarizer();
      await summarizer.handleTransition('church-1', 'HEALTHY', 'ATEM_LOST', 'atem_lost', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      expect(chatEngine.saveMessage).toHaveBeenCalled();
      expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('routes info to timeline only', async () => {
      const { summarizer, weeklyDigest, chatEngine, alertEngine } = createSummarizer();
      await summarizer.handleTransition('church-1', 'HEALTHY', 'SUSPECTED_BLACK', 'encoder_bitrate_loss', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      expect(chatEngine.saveMessage).not.toHaveBeenCalled();
      expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('routes recovery to timeline + chat', async () => {
      const { summarizer, weeklyDigest, chatEngine, alertEngine } = createSummarizer();
      await summarizer.handleTransition('church-1', 'FAILOVER_ACTIVE', 'HEALTHY', 'td_confirmed_recovery', makeSnapshot());

      expect(weeklyDigest.addEvent).toHaveBeenCalled();
      expect(chatEngine.saveMessage).toHaveBeenCalled();
      expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('per-church config overrides default routing', async () => {
      const db = createTestDb();
      // Override: send telegram for warning tier too
      db.prepare("UPDATE churches SET summary_tiers = ? WHERE churchId = ?").run(
        JSON.stringify({ warning: { telegram: true, chat: true, timeline: true } }),
        'church-1'
      );

      const { summarizer, alertEngine } = createSummarizer({ db });
      await summarizer.handleTransition('church-1', 'HEALTHY', 'ATEM_LOST', 'atem_lost', makeSnapshot());

      expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
    });
  });

  // ── F. Per-Church Config ───────────────────────────────────────────────────

  describe('Per-Church Config', () => {
    it('uses defaults when no summary_tiers configured', () => {
      const { summarizer } = createSummarizer();
      const config = summarizer._getChurchTierConfig('church-1');

      expect(config.critical.telegram).toBe(true);
      expect(config.critical.chat).toBe(true);
      expect(config.warning.telegram).toBe(false);
      expect(config.warning.chat).toBe(true);
      expect(config.info.telegram).toBe(false);
      expect(config.info.chat).toBe(false);
      expect(config.info.timeline).toBe(true);
    });

    it('merges custom config with defaults', () => {
      const db = createTestDb();
      db.prepare("UPDATE churches SET summary_tiers = ? WHERE churchId = ?").run(
        JSON.stringify({ warning: { telegram: true } }),
        'church-1'
      );

      const { summarizer } = createSummarizer({ db });
      const config = summarizer._getChurchTierConfig('church-1');

      // Warning telegram overridden
      expect(config.warning.telegram).toBe(true);
      // Warning chat should still be default (true)
      expect(config.warning.chat).toBe(true);
      // Critical should be untouched defaults
      expect(config.critical.telegram).toBe(true);
    });

    it('falls back to defaults on invalid JSON', () => {
      const db = createTestDb();
      db.prepare("UPDATE churches SET summary_tiers = ? WHERE churchId = ?").run(
        'not-valid-json!!!',
        'church-1'
      );

      const { summarizer } = createSummarizer({ db });
      const config = summarizer._getChurchTierConfig('church-1');

      expect(config.critical.telegram).toBe(true);
      expect(config.warning.chat).toBe(true);
    });
  });

  // ── G. Post-Service Narrative ──────────────────────────────────────────────

  describe('Post-Service Narrative', () => {
    it('skips narrative for clean sessions (0 alerts)', async () => {
      const { summarizer } = createSummarizer();
      const result = await summarizer.generatePostServiceNarrative('church-1', {
        sessionId: 'session-1',
        alertCount: 0,
        autoRecovered: 0,
        escalated: 0,
        grade: '🟢 Clean',
        durationMinutes: 90,
      });
      expect(result).toBeNull();
    });

    it('generates narrative for sessions with alerts', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockFetch({
        ok: true,
        json: async () => ({
          content: [{ text: 'The service experienced a brief encoder outage that was auto-recovered.' }],
          usage: { input_tokens: 200, output_tokens: 40 },
        }),
      });

      const { summarizer } = createSummarizer();
      const result = await summarizer.generatePostServiceNarrative('church-1', {
        sessionId: 'session-1',
        alertCount: 2,
        autoRecovered: 1,
        escalated: 1,
        grade: '🟡 Minor issues',
        durationMinutes: 90,
      });

      expect(result).toBeTruthy();
      expect(result).toContain('encoder outage');
    });

    it('falls back to template narrative on AI failure', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockFetch({ ok: false, status: 500 });

      const { summarizer } = createSummarizer();
      const result = await summarizer.generatePostServiceNarrative('church-1', {
        sessionId: 'session-1',
        alertCount: 3,
        autoRecovered: 2,
        escalated: 1,
        grade: '🔴 Required intervention',
        durationMinutes: 75,
      });

      expect(result).toBeTruthy();
      expect(result).toContain('Test Church');
      expect(result).toContain('75 minutes');
      expect(result).toContain('3 alert');
    });
  });

  // ── H. SignalFailover Hook Integration ─────────────────────────────────────

  describe('SignalFailover Hook Integration', () => {
    it('listener receives transition events via onTransition', () => {
      const db = createTestDb();
      // Add failover columns needed by SignalFailover._getConfig()
      db.exec("ALTER TABLE churches ADD COLUMN failover_enabled INTEGER DEFAULT 0");
      db.exec("ALTER TABLE churches ADD COLUMN failover_black_threshold_s INTEGER DEFAULT 5");
      db.exec("ALTER TABLE churches ADD COLUMN failover_ack_timeout_s INTEGER DEFAULT 30");
      db.exec("ALTER TABLE churches ADD COLUMN failover_action TEXT DEFAULT ''");
      db.exec("ALTER TABLE churches ADD COLUMN failover_auto_recover INTEGER DEFAULT 0");
      db.exec("ALTER TABLE churches ADD COLUMN failover_audio_trigger INTEGER DEFAULT 0");

      db.prepare(`
        UPDATE churches SET failover_enabled = 1, failover_black_threshold_s = 5,
        failover_ack_timeout_s = 30, failover_action = ? WHERE churchId = ?
      `).run(JSON.stringify({ type: 'atem_switch', input: 3010 }), 'church-1');

      const alertEngine = mockAlertEngine();
      const autoRecovery = { dispatchCommand: vi.fn().mockResolvedValue('ok') };
      const churches = mockChurches();

      // Use real SignalFailover
      const { SignalFailover } = require('../src/signalFailover.js');
      const failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      const listener = vi.fn();
      failover.onTransition(listener);

      // Trigger a transition via the correct API
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { bitrateKbps: 0 });

      expect(listener).toHaveBeenCalledWith(
        'church-1',
        'HEALTHY',
        'SUSPECTED_BLACK',
        'encoder_bitrate_loss',
        expect.objectContaining({ state: 'SUSPECTED_BLACK' })
      );

      failover.cleanup('church-1');
    });

    it('listener error does not affect state machine', () => {
      const db = createTestDb();
      db.exec("ALTER TABLE churches ADD COLUMN failover_enabled INTEGER DEFAULT 0");
      db.exec("ALTER TABLE churches ADD COLUMN failover_black_threshold_s INTEGER DEFAULT 5");
      db.exec("ALTER TABLE churches ADD COLUMN failover_ack_timeout_s INTEGER DEFAULT 30");
      db.exec("ALTER TABLE churches ADD COLUMN failover_action TEXT DEFAULT ''");
      db.exec("ALTER TABLE churches ADD COLUMN failover_auto_recover INTEGER DEFAULT 0");
      db.exec("ALTER TABLE churches ADD COLUMN failover_audio_trigger INTEGER DEFAULT 0");

      db.prepare(`
        UPDATE churches SET failover_enabled = 1, failover_black_threshold_s = 5,
        failover_ack_timeout_s = 30, failover_action = ? WHERE churchId = ?
      `).run(JSON.stringify({ type: 'atem_switch', input: 3010 }), 'church-1');

      const alertEngine = mockAlertEngine();
      const autoRecovery = { dispatchCommand: vi.fn().mockResolvedValue('ok') };
      const churches = mockChurches();

      const { SignalFailover, STATES } = require('../src/signalFailover.js');
      const failover = new SignalFailover(churches, alertEngine, autoRecovery, db);

      // Register a listener that throws
      failover.onTransition(() => { throw new Error('Listener explosion!'); });

      // Trigger a transition — should NOT throw
      failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { bitrateKbps: 0 });

      // State machine should still have transitioned
      expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

      failover.cleanup('church-1');
    });
  });

  // ── I. Persistence ─────────────────────────────────────────────────────────

  describe('Persistence', () => {
    it('stores incident summaries in the database', async () => {
      const { summarizer, db } = createSummarizer();
      await summarizer.handleTransition('church-1', 'HEALTHY', 'SUSPECTED_BLACK', 'encoder_bitrate_loss', makeSnapshot());

      const rows = db.prepare('SELECT * FROM incident_summaries WHERE church_id = ?').all('church-1');
      expect(rows.length).toBe(1);
      expect(rows[0].tier).toBe('info');
      expect(rows[0].trigger_transition).toBe('HEALTHY→SUSPECTED_BLACK');
      expect(rows[0].model_used).toBe('template');
      expect(rows[0].summary).toBeTruthy();
    });

    it('stores AI-generated summaries with model info', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      mockFetch();

      const { summarizer, db } = createSummarizer();
      await summarizer.handleTransition('church-1', 'SUSPECTED_BLACK', 'CONFIRMED_OUTAGE', 'black_timeout', makeSnapshot());

      const rows = db.prepare('SELECT * FROM incident_summaries WHERE church_id = ?').all('church-1');
      expect(rows.length).toBe(1);
      expect(rows[0].tier).toBe('critical');
      expect(rows[0].model_used).toBe('sonnet');
      expect(rows[0].summary).toContain('AI generated summary');
    });
  });

  // ── J. AI Summary Context ──────────────────────────────────────────────────

  describe('Summary Context', () => {
    it('builds lean context with device status and state log', () => {
      const { summarizer } = createSummarizer();
      const snapshot = makeSnapshot();
      const context = summarizer._buildSummaryContext('church-1', snapshot);

      expect(context).toContain('OBS: connected, streaming');
      expect(context).toContain('ATEM: disconnected');
      expect(context).toContain('Outage duration:');
      expect(context).toContain('Recent transitions:');
    });

    it('handles missing church status gracefully', () => {
      const churches = new Map();
      churches.set('church-1', { churchId: 'church-1', name: 'Test Church' });
      const { summarizer } = createSummarizer({ churches });

      const context = summarizer._buildSummaryContext('church-1', makeSnapshot());
      // Should not crash, may have fewer details
      expect(context).toBeTruthy();
    });
  });
});
