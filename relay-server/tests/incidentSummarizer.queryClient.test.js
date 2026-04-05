import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import { IncidentSummarizer } from '../src/incidentSummarizer.js';

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      td_telegram_chat_id TEXT DEFAULT '',
      alert_bot_token TEXT DEFAULT ''
    )
  `);
  db.prepare(`
    INSERT INTO churches (churchId, name, td_telegram_chat_id, alert_bot_token)
    VALUES (?, ?, ?, ?)
  `).run('church-1', 'Grace Church', '12345', 'bot:token');
  return db;
}

function mockChatEngine() {
  return {
    saveMessage: vi.fn().mockReturnValue({
      id: 'msg-1',
      church_id: 'church-1',
      timestamp: new Date().toISOString(),
      sender_name: 'Tally',
      sender_role: 'system',
      source: 'system',
      message: 'test',
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
    addEvent: vi.fn().mockResolvedValue(1),
  };
}

function mockSessionRecap() {
  return {
    getActiveSessionId: vi.fn().mockReturnValue('session-1'),
  };
}

function mockSignalFailover() {
  return {
    onTransition: vi.fn(),
  };
}

function mockChurches() {
  return new Map([
    ['church-1', {
      churchId: 'church-1',
      name: 'Grace Church',
      status: {
        obs: { connected: true, streaming: true },
        atem: { connected: false },
        encoder: { connected: true, bitrateKbps: 0 },
      },
    }],
  ]);
}

describe('IncidentSummarizer query client mode', () => {
  let db;
  let queryClient;
  let summarizer;
  let weeklyDigest;
  let chatEngine;
  let alertEngine;
  let sessionRecap;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    weeklyDigest = mockWeeklyDigest();
    chatEngine = mockChatEngine();
    alertEngine = mockAlertEngine();
    sessionRecap = mockSessionRecap();

    summarizer = new IncidentSummarizer({
      db: queryClient,
      churches: mockChurches(),
      chatEngine,
      alertEngine,
      weeklyDigest,
      sessionRecap,
      signalFailover: mockSignalFailover(),
    });
    await summarizer.ready;
  });

  afterEach(async () => {
    await queryClient?.close();
    db?.close();
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('persists incident summaries and reads church config through the shared query client', async () => {
    await summarizer.handleTransition(
      'church-1',
      'SUSPECTED_BLACK',
      'CONFIRMED_OUTAGE',
      'black_timeout',
      {
        outageStartedAt: Date.now() - 5000,
        stateLog: [{ from: 'HEALTHY', to: 'SUSPECTED_BLACK', trigger: 'encoder_bitrate_loss' }],
      },
    );

    const row = db.prepare(`
      SELECT church_id, session_id, tier, model_used, summary, delivered_to
      FROM incident_summaries
      WHERE church_id = ?
    `).get('church-1');

    expect(row).toMatchObject({
      church_id: 'church-1',
      session_id: 'session-1',
      tier: 'critical',
      model_used: 'template',
    });
    expect(row.summary).toContain('Stream outage confirmed');
    expect(JSON.parse(row.delivered_to)).toEqual(expect.arrayContaining(['timeline', 'chat', 'telegram']));
    expect(weeklyDigest.addEvent).toHaveBeenCalled();
    expect(chatEngine.saveMessage).toHaveBeenCalled();
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  it('builds post-service narratives from query-client backed summary rows', async () => {
    await summarizer.handleTransition(
      'church-1',
      'SUSPECTED_BLACK',
      'CONFIRMED_OUTAGE',
      'black_timeout',
      {
        outageStartedAt: Date.now() - 5000,
        stateLog: [{ from: 'HEALTHY', to: 'SUSPECTED_BLACK', trigger: 'encoder_bitrate_loss' }],
      },
    );

    const narrative = await summarizer.generatePostServiceNarrative('church-1', {
      sessionId: 'session-1',
      alertCount: 2,
      autoRecovered: 1,
      escalated: 1,
      grade: 'Yellow',
      durationMinutes: 90,
    });

    expect(narrative).toContain('Grace Church');
    expect(narrative).toContain('90 minutes');
    expect(narrative).toContain('Key incidents');
    expect(narrative).toContain('Stream outage confirmed');
  });
});
