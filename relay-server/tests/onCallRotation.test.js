/**
 * Tests for src/onCallRotation.js — on-call TD rotation with real in-memory SQLite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { OnCallRotation } = require('../src/onCallRotation');

function createDb() {
  return new Database(':memory:');
}

function addTD(rotation, churchId, name, chatId = '', userId = '', isPrimary = 0) {
  rotation.db.prepare(
    'INSERT INTO td_oncall (churchId, name, telegramChatId, telegramUserId, isPrimary) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, name, chatId, userId, isPrimary);
}

describe('OnCallRotation', () => {
  let db;
  let rotation;

  beforeEach(() => {
    db = createDb();
    rotation = new OnCallRotation(db);
  });

  describe('constructor', () => {
    it('creates the td_oncall table on construction', () => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='td_oncall'").get();
      expect(row).toBeDefined();
    });

    it('works without a db (null db)', () => {
      // Should not throw when db is null
      const r = new OnCallRotation(null);
      expect(r.db).toBeNull();
    });
  });

  describe('getCurrentOnCall()', () => {
    it('returns null when no TDs registered', () => {
      expect(rotation.getCurrentOnCall('church_a')).toBeNull();
    });

    it('returns TD with matching weekOf first', () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      const weekKey = rotation._currentWeekKey();
      db.prepare('UPDATE td_oncall SET weekOf = ? WHERE name = ?').run(weekKey, 'Alice');

      addTD(rotation, 'church_a', 'Bob', '222', '', 1); // primary but not on-call this week

      const result = rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Alice');
    });

    it('falls back to isPrimary when no weekOf match', () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222', '', 1); // primary

      const result = rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Bob');
    });

    it('falls back to first registered TD when no weekOf or primary', () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222');

      const result = rotation.getCurrentOnCall('church_a');
      expect(result.name).toBe('Alice');
    });
  });

  describe('getOnCallTD()', () => {
    it('is an alias for getCurrentOnCall', () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      expect(rotation.getOnCallTD('church_a').name).toBe('Alice');
    });
  });

  describe('formatOnCallStatus()', () => {
    it('returns _(no TDs registered)_ when no TDs', () => {
      expect(rotation.formatOnCallStatus('church_a', db)).toBe('_(no TDs registered)_');
    });

    it('formats TDs with on-call and primary flags', () => {
      addTD(rotation, 'church_a', 'Alice', '111', '', 1); // primary
      const weekKey = rotation._currentWeekKey();
      db.prepare('UPDATE td_oncall SET weekOf = ? WHERE name = ?').run(weekKey, 'Alice');

      const result = rotation.formatOnCallStatus('church_a', db);
      expect(result).toContain('Alice');
      expect(result).toContain('on-call this week');
      expect(result).toContain('primary');
    });

    it('includes phone number when present', () => {
      db.prepare('INSERT INTO td_oncall (churchId, name, telegramChatId, phone) VALUES (?, ?, ?, ?)').run(
        'church_a', 'Bob', '222', '555-1234'
      );
      const result = rotation.formatOnCallStatus('church_a', db);
      expect(result).toContain('555-1234');
    });

    it('uses this.db when no external db is passed', () => {
      addTD(rotation, 'church_a', 'Charlie', '333');
      const result = rotation.formatOnCallStatus('church_a');
      expect(result).toContain('Charlie');
    });
  });

  describe('setOnCall()', () => {
    it('creates a new TD and sets them on-call', () => {
      const result = rotation.setOnCall('church_a', 'NewTD');
      expect(result.success).toBe(true);
      expect(result.message).toContain('NewTD');
      expect(result.message).toContain('on-call');
    });

    it('finds existing TD by partial name match', () => {
      addTD(rotation, 'church_a', 'Alice Johnson', '111');
      const result = rotation.setOnCall('church_a', 'Alice');
      expect(result.success).toBe(true);
      expect(result.message).toContain('Alice Johnson');
    });

    it('clears previous on-call assignment when setting new one', () => {
      addTD(rotation, 'church_a', 'Alice', '111');
      addTD(rotation, 'church_a', 'Bob', '222');
      rotation.setOnCall('church_a', 'Alice');
      rotation.setOnCall('church_a', 'Bob');

      const weekKey = rotation._currentWeekKey();
      const alice = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Alice');
      const bob = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Bob');
      expect(alice.weekOf).toBe('');
      expect(bob.weekOf).toBe(weekKey);
    });
  });

  describe('addOrUpdateTD()', () => {
    it('inserts a new TD', () => {
      rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Dave', telegramChatId: '444', telegramUserId: 'u444' });
      const row = db.prepare('SELECT * FROM td_oncall WHERE name = ?').get('Dave');
      expect(row).toBeDefined();
      expect(row.telegramChatId).toBe('444');
    });

    it('updates an existing TD by userId', () => {
      rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Dave', telegramChatId: '444', telegramUserId: 'u444' });
      rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Dave Updated', telegramChatId: '555', telegramUserId: 'u444' });
      const rows = db.prepare('SELECT * FROM td_oncall WHERE churchId = ?').all('church_a');
      expect(rows.length).toBe(1);
      expect(rows[0].name).toBe('Dave Updated');
    });

    it('updates an existing TD by name', () => {
      rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Eve', telegramChatId: '666', telegramUserId: 'u666' });
      rotation.addOrUpdateTD({ churchId: 'church_a', name: 'Eve', telegramChatId: '777', telegramUserId: 'u777' });
      const rows = db.prepare('SELECT * FROM td_oncall WHERE name = ?').all('Eve');
      expect(rows.length).toBe(1);
    });
  });

  describe('initiateSwap()', () => {
    it('returns failure when requester is not in rotation', () => {
      const result = rotation.initiateSwap('church_a', 'unknown-chat-id', 'Bob');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not registered');
    });

    it('returns failure when target TD is not found', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      const result = rotation.initiateSwap('church_a', 'alice-chat', 'NoSuchPerson');
      expect(result.success).toBe(false);
      expect(result.message).toContain('No TD found');
    });

    it('returns failure when target has no telegram chat ID', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', ''); // no chat ID
      const result = rotation.initiateSwap('church_a', 'alice-chat', 'Bob');
      expect(result.success).toBe(false);
      expect(result.message).toContain("doesn't have a Telegram chat");
    });

    it('successfully creates a swap request', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      const result = rotation.initiateSwap('church_a', 'alice-chat', 'Bob');
      expect(result.success).toBe(true);
      expect(result.target.name).toBe('Bob');
      expect(result.requester.name).toBe('Alice');
    });
  });

  describe('findPendingSwapForTarget()', () => {
    it('returns null when no pending swaps', () => {
      expect(rotation.findPendingSwapForTarget('some-chat-id')).toBeNull();
    });

    it('returns swap when target chatId matches', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      const found = rotation.findPendingSwapForTarget('bob-chat');
      expect(found).not.toBeNull();
      expect(found.targetName).toBe('Bob');
      expect(found.requesterName).toBe('Alice');
    });
  });

  describe('confirmSwap()', () => {
    it('returns failure for unknown swap key', () => {
      const result = rotation.confirmSwap('nonexistent-key');
      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('successfully confirms a swap and sets target as on-call', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      const swapKey = [...rotation._pendingSwaps.keys()][0];
      const confirm = rotation.confirmSwap(swapKey);
      expect(confirm.success).toBe(true);
      expect(confirm.sundayStr).toBeDefined();

      const weekKey = rotation._currentWeekKey();
      const bob = db.prepare('SELECT weekOf FROM td_oncall WHERE name = ?').get('Bob');
      expect(bob.weekOf).toBe(weekKey);
    });

    it('returns failure when target TD is not found in rotation at confirm time', () => {
      addTD(rotation, 'church_a', 'Alice', 'alice-chat');
      addTD(rotation, 'church_a', 'Bob', 'bob-chat');
      rotation.initiateSwap('church_a', 'alice-chat', 'Bob');

      // Delete Bob from the DB to simulate TD removed before confirmation
      db.prepare('DELETE FROM td_oncall WHERE name = ?').run('Bob');

      const swapKey = [...rotation._pendingSwaps.keys()][0];
      const confirm = rotation.confirmSwap(swapKey);
      expect(confirm.success).toBe(false);
      expect(confirm.message).toContain('Could not find target TD');
    });
  });

  describe('setOnCall() with church_tds table', () => {
    it('creates TD from church_tds if not in td_oncall', () => {
      // Create the church_tds table
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

      const result = rotation.setOnCall('church_a', 'Frank');
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
