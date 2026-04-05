/**
 * Tests for src/onCallRotation.js - on-call TD rotation with real in-memory SQLite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createQueryClient } = require('../src/db');
const { OnCallRotation } = require('../src/onCallRotation');

function createDb() {
  return new Database(':memory:');
}

async function createRotation(dbOrClient, options) {
  const rotation = new OnCallRotation(dbOrClient, options);
  await rotation.ready;
  return rotation;
}

function addTD(rotation, churchId, name, chatId = '', userId = '', isPrimary = 0) {
  rotation.db.prepare(
    'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, isPrimary) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, name, chatId, userId, isPrimary);
}

describe('OnCallRotation', () => {
  let db;
  let rotation;

  beforeEach(async () => {
    db = createDb();
    rotation = await createRotation(db);
  });

  describe('constructor', () => {
    it('creates the td_oncall table on construction', () => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='td_oncall'").get();
      expect(row).toBeDefined();
    });

    it('works without a db (null db)', () => {
      const r = new OnCallRotation(null);
      expect(r.db).toBeNull();
    });

    it('accepts the shared query client', async () => {
      const client = createQueryClient({
        config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
        sqliteDb: db,
      });
      const viaClient = await createRotation(client);
      const id = await viaClient.addOrUpdateTD({
        churchId: 'church_client',
        name: 'Client TD',
        telegramChatId: 'client-chat',
        telegramUserId: 'client-user',
      });

      expect(id).toBeTruthy();
      const row = db.prepare('SELECT name FROM td_oncall WHERE churchId = ?').get('church_client');
      expect(row?.name).toBe('Client TD');
    });
  });

  describe('getCurrentOnCall()', () => {
    it('returns null when no TDs registered', async () => {
      expect(await rotation.getCurrentOnCall('church_a')).toBeNull();
    });

    it('returns TD with matching weekOf first', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      const weekKey = rotation._currentWeekKey();
      db.prepare('UPDATE td_oncall SET weekOf = ? WHERE name = ?').run(weekKey, 'Alice');

      addTD(rotation, 'church_a', 'Bob', '222', '', 1);

      const result = await rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Alice');
    });

    it('falls back to isPrimary when no weekOf match', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222', '', 1);

      const result = await rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Bob');
    });

    it('falls back to first registered TD when no weekOf or primary', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222');

      const result = await rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Alice');
    });
  });

  describe('getOnCallTD()', () => {
    it('is an alias for getCurrentOnCall', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      expect((await rotation.getOnCallTD('church_a')).name).toBe('Alice');
    });
  });

  describe('listTDs()', () => {
    it('returns TDs in primary-first order', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222', '', 1);

      const rows = await rotation.listTDs('church_a');
      expect(rows.map((row) => row.name)).toEqual(['Bob', 'Alice']);
    });
  });

  describe('formatOnCallStatus()', () => {
    it('returns _(no TDs registered)_ when no TDs', async () => {
      expect(await rotation.formatOnCallStatus('church_a', db)).toBe('_(no TDs registered)_');
    });

    it('formats TDs with on-call and primary flags', async () => {
      addTD(rotation, 'church_a', 'Alice', '111', '', 1);
      const weekKey = rotation._currentWeekKey();
      db.prepare('UPDATE td_oncall SET weekOf = ? WHERE name = ?').run(weekKey, 'Alice');

      const result = await rotation.formatOnCallStatus('church_a', db);
      expect(result).toContain('Alice');
      expect(result).toContain('on-call this week');
      expect(result).toContain('primary');
    });

    it('includes phone number when present', async () => {
      db.prepare('INSERT INTO td_oncall (churchId, name, telegramChatId, phone) VALUES (?, ?, ?, ?)').run(
        'church_a', 'Bob', '222', '555-1234'
      );
      const result = await rotation.formatOnCallStatus('church_a', db);
      expect(result).toContain('555-1234');
    });

    it('uses this.db when no external db is passed', async () => {
      addTD(rotation, 'church_a', 'Charlie', '333');
      const result = await rotation.formatOnCallStatus('church_a');
      expect(result).toContain('Charlie');
    });
  });

  describe('setOnCall()', () => {
    it('creates a new TD and sets them on-call', async () => {
      const result = await rotation.setOnCall('church_a', 'NewTD');
      expect(result.success).toBe(true);
      expect(result.message).toContain('NewTD');
      expect(result.message).toContain('on-call');
    });

    it('finds existing TD by partial name match', async () => {
      addTD(rotation, 'church_a', 'Alice Johnson', '111');
      const result = await rotation.setOnCall('church_a', 'alice');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Alice Johnson');
    });

    it('clears previous on-call assignment when setting new one', async () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222');
      await rotation.setOnCall('church_a', 'Alice');
      await rotation.setOnCall('church_a', 'Bob');

      const weekKey = rotation._currentWeekKey();
      const alice = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Alice');
      const bob = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Bob');
      expect(alice.weekOf).toBe('');
      expect(bob.weekOf).toBe(weekKey);
    });
  });

  describe('addOrUpdateTD()', () => {
    it('inserts a new TD', async () => {
      await rotation.addOrUpdateTD({
        churchId: 'church_a',
        name: 'Dave',
        telegramChatId: '444',
        telegramUserId: 'u444',
        phone: '555-4444',
      });
      const row = db.prepare('SELECT * FROM td_oncall WHERE name = ?').get('Dave');
      expect(row).toBeDefined();
      expect(row.telegramChatId).toBe('444');
      expect(row.phone).toBe('555-4444');
    });

    it('updates an existing TD by userId', async () => {
      await rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Dave', telegramChatId: '444', telegramUserId: 'u444' });
      await rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Dave Updated', telegramChatId: '555', telegramUserId: 'u444' });
      const rows = db.prepare('SELECT * FROM td_oncall WHERE churchId = ?').all('church_a');
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Dave Updated');
    });

    it('updates an existing TD by name', async () => {
      await rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Eve', telegramChatId: '666', telegramUserId: 'u666' });
      await rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Eve', telegramChatId: '777', telegramUserId: 'u777' });
      const rows = db.prepare('SELECT * FROM td_oncall WHERE name = ?').all('Eve');
      expect(rows.length).toBe(1);
    });
  });

  describe('initiateSwap()', () => {
    it('returns failure when requester is not in rotation', async () => {
      const result = await rotation.initiateSwap('church_a', 'unknown-chat-id', 'Bob');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not registered');
    });

    it('returns failure when target TD is not found', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      const result = await rotation.initiateSwap('church_a', 'alice-chat', 'NoSuchPerson');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No TD found');
    });

    it('returns failure when target has no telegram chat ID', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', '');
      const result = await rotation.initiateSwap('church_a', 'alice-chat', 'Bob');
      expect(result.success).toBe(false);
      expect(result.message).toContain("doesn't have a Telegram chat");
    });

    it('successfully creates a swap request', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      const result = await rotation.initiateSwap('church_a', 'alice-chat', 'Bob');
      expect(result.success).toBe(true);
      expect(result.target.name).toBe('Bob');
      expect(result.requester.name).toBe('Alice');
    });
  });

  describe('findPendingSwapForTarget()', () => {
    it('returns null when no pending swaps', () => {
      expect(rotation.findPendingSwapForTarget('some-chat-id')).toBeNull();
    });

    it('returns swap when target chatId matches', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      await rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      const found = rotation.findPendingSwapForTarget('bob-chat');
      expect(found).not.toBeNull();
      expect(found.targetName).toBe('Bob');
      expect(found.requesterName).toBe('Alice');
    });
  });

  describe('confirmSwap()', () => {
    it('returns failure for unknown swap key', async () => {
      const result = await rotation.confirmSwap('nonexistent-key');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('successfully confirms a swap and sets target as on-call', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      await rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      const swapKey = [...rotation._pendingSwaps.keys()][0];
      const confirm = await rotation.confirmSwap(swapKey);
      expect(confirm.success).toBe(true);
      expect(confirm.sundayStr).toBeDefined();

      const weekKey = rotation._currentWeekKey();
      const bob = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Bob');
      expect(bob.weekOf).toBe(weekKey);
    });

    it('returns failure when target TD is not found in rotation at confirm time', async () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      await rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      db.prepare('DELETE FROM td_oncall WHERE name = ?').run('Bob');

      const swapKey = [...rotation._pendingSwaps.keys()][0];
      const confirm = await rotation.confirmSwap(swapKey);
      expect(confirm.success).toBe(false);
      expect(confirm.message).toContain('Could not find target TD');
    });
  });

  describe('setOnCall() with church_tds table', () => {
    it('creates TD from church_tds if not in td_oncall', async () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS church_tds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          name TEXT NOT NULL,
          telegram_chat_id TEXT DEFAULT '',
          telegram_user_id TEXT DEFAULT '',
          active INTEGER DEFAULT 1
        )
      `);
      db.prepare('INSERT INTO church_tds (church_id, name, telegram_chat_id, active) VALUES (?, ?, ?, 1)').run(
        'church_a', 'Frank from CTDs', 'frank-chat'
      );

      const result = await rotation.setOnCall('church_a', 'Frank');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Frank from CTDs');
    });
  });

  describe('_currentWeekKey()', () => {
    it('returns a string in YYYY-Www format', () => {
      const key = rotation._currentWeekKey();
      expect(key).toMatch(/^\d{4}-W\d{2}$/);
    });
  });

  describe('_nextSundayStr()', () => {
    it('returns a non-empty string', () => {
      const result = rotation._nextSundayStr();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
