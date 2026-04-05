import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalFailover, STATES } from '../src/signalFailover.js';
import { createQueryClient } from '../src/db/queryClient.js';

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function mockAlertEngine() {
  return {
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function mockAutoRecovery() {
  return {
    dispatchCommand: vi.fn().mockResolvedValue('ok'),
  };
}

function mockChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'Test Church',
    status: {
      atem: { connected: true, programInput: 1, streamingBitrate: 5000000 },
      encoder: { connected: true, live: true, bitrateKbps: 5000 },
    },
    ...overrides,
  };
}

describe('SignalFailover query client mode', () => {
  let db;
  let queryClient;
  let alertEngine;
  let autoRecovery;
  let church;
  let churches;
  let failover;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        failover_enabled INTEGER DEFAULT 0,
        failover_black_threshold_s INTEGER DEFAULT 5,
        failover_ack_timeout_s INTEGER DEFAULT 30,
        failover_action TEXT,
        failover_auto_recover INTEGER DEFAULT 0,
        failover_audio_trigger INTEGER DEFAULT 0,
        td_telegram_chat_id TEXT,
        telegram_bot_token TEXT
      );
    `);
    db.prepare(`
      INSERT INTO churches (
        churchId, failover_enabled, failover_black_threshold_s, failover_ack_timeout_s,
        failover_action, failover_auto_recover, failover_audio_trigger,
        td_telegram_chat_id, telegram_bot_token
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'church-1',
      1,
      5,
      30,
      JSON.stringify({ type: 'atem_switch', input: 3010 }),
      0,
      0,
      '12345',
      'bot:token'
    );

    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    alertEngine = mockAlertEngine();
    autoRecovery = mockAutoRecovery();
    church = mockChurch();
    churches = new Map([[church.churchId, church]]);
    failover = new SignalFailover(churches, alertEngine, autoRecovery, queryClient);
    await failover.ready;
  });

  afterEach(async () => {
    failover?.cleanup('church-1');
    await queryClient?.close();
    db?.close();
    vi.useRealTimers();
  });

  it('hydrates failover configuration from the shared query client cache', () => {
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });

    expect(failover.getState('church-1').state).toBe(STATES.SUSPECTED_BLACK);

    vi.advanceTimersByTime(5000);
    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    expect(alertEngine.sendTelegramMessage).toHaveBeenCalled();
  });

  it('refreshes church config cache after updates', async () => {
    db.prepare('UPDATE churches SET failover_enabled = 0, failover_action = NULL WHERE churchId = ?').run('church-1');
    await failover.refreshChurchConfig('church-1');

    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('church-1').state).toBe(STATES.HEALTHY);
  });
});
