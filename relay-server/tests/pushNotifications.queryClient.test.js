import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import { PushNotificationService } from '../src/pushNotifications.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-1', 'Grace Community');
  return db;
}

describe('PushNotificationService query client', () => {
  let db;
  let queryClient;
  let push;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    push = new PushNotificationService({ db: queryClient, log: vi.fn() });
    await push.ready;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await queryClient?.close();
    db?.close();
  });

  it('registers devices and returns stats through the query client', async () => {
    const created = await push.registerDevice({
      churchId: 'church-1',
      deviceToken: 'token-1',
      platform: 'ios',
      deviceName: 'Andrew iPhone',
    });

    expect(created.created).toBe(true);

    const devices = await push.getDevicesForChurch('church-1');
    const stats = await push.getStats('church-1');

    expect(devices).toHaveLength(1);
    expect(devices[0].device_name).toBe('Andrew iPhone');
    expect(stats.deviceCount).toBe(1);
    expect(stats.platforms[0]).toMatchObject({ platform: 'ios', cnt: 1 });
  });

  it('stores and reads notification prefs through the query client', async () => {
    const updated = await push.updatePrefs('church-1', null, {
      enabled: true,
      severityThreshold: 'WARNING',
      perRoomFiltering: { roomA: false },
      serviceReminders: false,
    });

    const prefs = await push.getPrefs('church-1');

    expect(updated.severityThreshold).toBe('WARNING');
    expect(prefs.perRoomFiltering).toEqual({ roomA: false });
    expect(prefs.serviceReminders).toBe(false);
  });

  it('sends service reminders using query-backed devices and prefs', async () => {
    await push.registerDevice({
      churchId: 'church-1',
      deviceToken: 'token-1',
      platform: 'ios',
    });
    await push.registerDevice({
      churchId: 'church-1',
      deviceToken: 'token-2',
      platform: 'ios',
      userId: 'user-2',
    });

    await push.updatePrefs('church-1', 'user-2', { enabled: false, serviceReminders: false });

    const sendSpy = vi.spyOn(push, '_sendToDevice').mockResolvedValue('ok');
    const result = await push.sendServiceReminder('church-1', {
      name: 'Sunday Service',
      startsAt: '2026-04-05T14:30:00.000Z',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ sent: 1, skipped: 1 });
  });
});
