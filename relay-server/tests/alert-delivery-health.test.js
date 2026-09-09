/**
 * Last-successful alert send + consecutive-failure paging.
 *
 * Telegram HTTP ok and Slack ok are recorded independently. After N
 * consecutive failures we captureException once and page the admin contact
 * via the existing Andrew Telegram path (skipHealth so paging cannot recurse).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  AlertEngine,
  DEFAULT_ALERT_SEND_FAILURE_THRESHOLD,
  createAlertDeliveryHealth,
} from '../src/alertEngine.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      td_telegram_chat_id TEXT DEFAULT '',
      td_name TEXT DEFAULT '',
      alert_bot_token TEXT DEFAULT '',
      slack_webhook_url TEXT DEFAULT '',
      slack_channel TEXT DEFAULT ''
    )
  `);
  return db;
}

function makeChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'First Tally Church',
    td_telegram_chat_id: '987654321',
    alert_bot_token: 'church-bot-token',
    ...overrides,
  };
}

describe('createAlertDeliveryHealth', () => {
  it('stays operational with no sends (prepare mode)', () => {
    const health = createAlertDeliveryHealth({ failureThreshold: 3 });
    expect(health.getStatusComponent()).toEqual({
      state: 'operational',
      detail: 'No outbound alert sends since process start',
    });
  });

  it('records last success and resets consecutive failures', () => {
    const health = createAlertDeliveryHealth({ failureThreshold: 3 });
    health.record('telegram', { ok: false, error: '403' });
    health.record('telegram', { ok: true });
    const snap = health.snapshot();
    expect(snap.telegram.consecutiveFailures).toBe(0);
    expect(snap.telegram.lastSuccessAt).toBeTruthy();
    expect(health.getStatusComponent().state).toBe('operational');
    expect(health.getStatusComponent().detail).toContain('Telegram last ok');
  });

  it('pages only once when crossing the consecutive-failure threshold', () => {
    const health = createAlertDeliveryHealth({ failureThreshold: 3 });
    const first = health.record('telegram', { ok: false, error: '401' });
    const second = health.record('telegram', { ok: false, error: '401' });
    const third = health.record('telegram', { ok: false, error: '401' });
    const fourth = health.record('telegram', { ok: false, error: '401' });
    expect(first.shouldPage).toBe(false);
    expect(second.shouldPage).toBe(false);
    expect(third.shouldPage).toBe(true);
    expect(fourth.shouldPage).toBe(false);
    expect(health.getStatusComponent().state).toBe('degraded');
    expect(health.getStatusComponent().detail).toContain('3 consecutive send failures');
  });

  it('re-arms paging after a later success', () => {
    const health = createAlertDeliveryHealth({ failureThreshold: 2 });
    health.record('slack', { ok: false, error: '500' });
    expect(health.record('slack', { ok: false, error: '500' }).shouldPage).toBe(true);
    health.record('slack', { ok: true });
    expect(health.record('slack', { ok: false, error: '500' }).shouldPage).toBe(false);
    expect(health.record('slack', { ok: false, error: '500' }).shouldPage).toBe(true);
  });

  it('defaults the threshold to 3', () => {
    expect(DEFAULT_ALERT_SEND_FAILURE_THRESHOLD).toBe(3);
    const health = createAlertDeliveryHealth();
    expect(health.threshold).toBe(3);
  });
});

describe('AlertEngine delivery health', () => {
  let db;
  let engine;
  let captureException;

  beforeEach(() => {
    db = createTestDb();
    captureException = vi.fn();
    engine = new AlertEngine(db, { isServiceWindow: () => true }, {
      defaultBotToken: 'default-bot-token',
      adminChatId: 'admin-chat-id',
      alertSendFailureThreshold: 3,
      captureException,
    });
  });

  afterEach(() => {
    engine?.clearDedupState('church-1');
    db?.close();
    vi.unstubAllGlobals();
  });

  function stubTelegram({ ok = true, status = 200, slackOk = true } = {}) {
    const telegramCalls = [];
    const fetchMock = vi.fn(async (url, init) => {
      if (typeof url === 'string' && url.startsWith('https://api.telegram.org/bot')) {
        let body = {};
        try { body = JSON.parse(init.body); } catch { /* empty */ }
        telegramCalls.push({ url, chatId: body.chat_id, text: body.text });
        if (!ok) {
          return { ok: false, status, text: async () => 'bot forbidden' };
        }
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!slackOk) {
        return { ok: false, status: 500, text: async () => 'slack down' };
      }
      return { ok: true, status: 200, text: async () => 'ok' };
    });
    vi.stubGlobal('fetch', fetchMock);
    return { telegramCalls, fetchMock };
  }

  it('records last successful Telegram send on HTTP ok', async () => {
    stubTelegram({ ok: true });
    await engine.sendAlert(makeChurch(), 'audio_silence', {});
    const status = engine.getDeliveryStatusComponent();
    expect(status.state).toBe('operational');
    expect(status.detail).toMatch(/Telegram last ok /);
    expect(engine.deliveryHealth.snapshot().telegram.consecutiveFailures).toBe(0);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('records last successful Slack send on HTTP ok', async () => {
    stubTelegram({ ok: true, slackOk: true });
    const webhookUrl = 'https://hooks.slack.com/services/T1/B2/secret';
    db.prepare('INSERT INTO churches (churchId, name, slack_webhook_url) VALUES (?, ?, ?)')
      .run('church-1', 'First Tally Church', webhookUrl);
    await engine.sendAlert(makeChurch({ slack_webhook_url: webhookUrl }), 'audio_silence', {});
    const snap = engine.deliveryHealth.snapshot();
    expect(snap.telegram.lastSuccessAt).toBeTruthy();
    expect(snap.slack.lastSuccessAt).toBeTruthy();
    expect(engine.getDeliveryStatusComponent().detail).toContain('Slack last ok');
  });

  it('captures Sentry and pages Andrew after N consecutive Telegram failures', async () => {
    const { telegramCalls } = stubTelegram({ ok: false, status: 403 });
    const church = makeChurch();
    await engine.sendAlert(church, 'audio_silence', {});
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'bitrate_low', {});
    expect(captureException).not.toHaveBeenCalled();
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'fps_low', {});

    expect(captureException).toHaveBeenCalledTimes(1);
    const err = captureException.mock.calls[0][0];
    expect(err.code).toBe('ALERT_SEND_FAILURE');
    expect(err.message).toMatch(/telegram send failed 3 times/i);

    await vi.waitFor(() => {
      expect(telegramCalls.find((c) => c.chatId === 'admin-chat-id')).toBeTruthy();
    });
    const adminPage = telegramCalls.find((c) => c.chatId === 'admin-chat-id');
    expect(adminPage.text).toContain('Sunday pages may be silent');

    const status = engine.getDeliveryStatusComponent();
    expect(status.state).toBe('degraded');
    expect(status.detail).toContain('Telegram never succeeded');
    expect(status.detail).toContain('3 consecutive send failures');
  });

  it('does not page again until a later success resets the counter', async () => {
    stubTelegram({ ok: false, status: 500 });
    const church = makeChurch();
    for (const type of ['audio_silence', 'bitrate_low', 'fps_low', 'cpu_high']) {
      engine.clearDedupState('church-1');
      await engine.sendAlert(church, type, {});
    }
    expect(captureException).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    stubTelegram({ ok: true });
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'obs_disconnected', {});
    expect(engine.deliveryHealth.snapshot().telegram.consecutiveFailures).toBe(0);

    vi.unstubAllGlobals();
    stubTelegram({ ok: false, status: 500 });
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'mixer_disconnected', {});
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'ptz_disconnected', {});
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'hyperdeck_disconnected', {});
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('pages Andrew on consecutive Slack failures without treating skipped Telegram as a send', async () => {
    stubTelegram({ ok: true, slackOk: false });
    const webhookUrl = 'https://hooks.slack.com/services/T1/B2/secret';
    db.prepare('INSERT INTO churches (churchId, name, slack_webhook_url) VALUES (?, ?, ?)')
      .run('church-1', 'First Tally Church', webhookUrl);
    const church = makeChurch({ slack_webhook_url: webhookUrl });

    await engine.sendAlert(church, 'audio_silence', {});
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'bitrate_low', {});
    engine.clearDedupState('church-1');
    await engine.sendAlert(church, 'fps_low', {});

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][0].message).toMatch(/slack send failed 3 times/i);
    expect(engine.getDeliveryStatusComponent().state).toBe('degraded');
    expect(engine.getDeliveryStatusComponent().detail).toContain('Slack never succeeded');
  });

  it('does not count skipHealth admin pages as delivery failures', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'no' }));
    vi.stubGlobal('fetch', fetchMock);
    await engine.sendTelegramMessage('admin-chat-id', 'default-bot-token', 'page', { skipHealth: true });
    expect(engine.deliveryHealth.snapshot().telegram.consecutiveFailures).toBe(0);
    expect(engine.getDeliveryStatusComponent().detail).toBe('No outbound alert sends since process start');
  });
});
