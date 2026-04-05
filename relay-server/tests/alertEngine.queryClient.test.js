import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertEngine } from '../src/alertEngine.js';
import { createQueryClient } from '../src/db/queryClient.js';

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function alwaysInWindow() {
  return { isServiceWindow: () => true };
}

describe('AlertEngine query client mode', () => {
  let db;
  let queryClient;
  let engine;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        name TEXT,
        td_telegram_chat_id TEXT DEFAULT '',
        alert_bot_token TEXT DEFAULT '',
        slack_webhook_url TEXT,
        slack_channel TEXT
      );
    `);
    db.prepare(`
      INSERT INTO churches (churchId, name, td_telegram_chat_id, alert_bot_token, slack_webhook_url, slack_channel)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('church-1', 'Test Church', '12345', 'bot:token', 'https://hooks.slack.test', '#alerts');

    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    engine = new AlertEngine(queryClient, alwaysInWindow(), { defaultBotToken: 'bot:token' });
    await engine.ready;
    vi.spyOn(engine, 'sendTelegramMessage').mockResolvedValue(undefined);
    vi.spyOn(engine, 'sendSlackAlert').mockResolvedValue(undefined);
    vi.spyOn(engine, 'sendSlackAcknowledgment').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await queryClient?.close();
    db?.close();
    vi.useRealTimers();
  });

  it('persists alerts through the shared query client', async () => {
    const church = { churchId: 'church-1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };

    const result = await engine.sendAlert(church, 'failover_confirmed_outage', { source: 'cam-1' });

    expect(result.action).toBe('notified');
    const row = db.prepare('SELECT church_id, alert_type, severity FROM alerts WHERE id = ?').get(result.alertId);
    expect(row).toMatchObject({
      church_id: 'church-1',
      alert_type: 'failover_confirmed_outage',
      severity: 'CRITICAL',
    });
  });

  it('acknowledges alerts and resolves prefix lookup through the shared query client', async () => {
    const church = { churchId: 'church-1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await engine.sendAlert(church, 'failover_confirmed_outage', {});
    const prefix = result.alertId.slice(0, 8);

    expect(await engine.findAlertByPrefix(prefix)).toBe(result.alertId);

    const ack = await engine.acknowledgeAlert(result.alertId, 'TD');

    expect(ack).toEqual({ acknowledged: true });
    expect(await engine.findAlertByPrefix(prefix)).toBeNull();
    const row = db.prepare('SELECT acknowledged_by FROM alerts WHERE id = ?').get(result.alertId);
    expect(row.acknowledged_by).toBe('TD');
    expect(engine.activeAlerts.has(result.alertId)).toBe(false);
  });
});
