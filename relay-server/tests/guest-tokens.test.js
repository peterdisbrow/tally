import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuestTdMode } from '../src/guestTdMode.js';
import { createQueryClient } from '../src/db/queryClient.js';
import Database from 'better-sqlite3';

function createTestDb() {
  return new Database(':memory:');
}

async function createGuestTdMode(db = createTestDb()) {
  const guest = new GuestTdMode(db);
  await guest.ready;
  return guest;
}

describe('GuestTdMode Core', () => {
  let db;
  let guest;

  beforeEach(async () => {
    db = createTestDb();
    guest = await createGuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('creates guest_tokens table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guest_tokens'").all();
    expect(tables).toHaveLength(1);
  });

  it('works when constructed with a query client', async () => {
    const db2 = createTestDb();
    const queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db2,
    });
    const queryGuest = new GuestTdMode(queryClient);
    await queryGuest.ready;

    const result = await queryGuest.generateToken('church-1', 'Test Church');
    const row = db2.prepare('SELECT churchId FROM guest_tokens WHERE token = ?').get(result.token);
    expect(row?.churchId).toBe('church-1');

    await queryClient.close();
    db2.close();
  });

  it('generateToken produces GUEST- prefixed token with 24h expiry', async () => {
    const result = await guest.generateToken('church-1', 'Test Church');
    expect(result.token).toMatch(/^GUEST-[A-F0-9]{24}$/);
    expect(result.expiresAt).toBeTruthy();
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('validateToken returns valid for fresh token', async () => {
    const { token } = await guest.generateToken('church-1', 'Test Church');
    const result = await guest.validateToken(token);
    expect(result.valid).toBe(true);
    expect(result.guestRow.churchId).toBe('church-1');
  });

  it('validateToken returns invalid for unknown token', async () => {
    const result = await guest.validateToken('GUEST-NONEXISTENT');
    expect(result.valid).toBe(false);
  });

  it('registerGuest binds token to Telegram chat ID', async () => {
    const { token } = await guest.generateToken('church-1', 'Test Church');
    const result = await guest.registerGuest(token, '12345', 'John');
    expect(result.success).toBe(true);
    expect(result.churchId).toBe('church-1');
    const row = db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(token);
    expect(row.usedByChat).toBe('12345');
    expect(row.name).toBe('John');
  });

  it('registerGuest rejects already-claimed token by different user', async () => {
    const { token } = await guest.generateToken('church-1', 'Test Church');
    await guest.registerGuest(token, '12345', 'John');
    const result = await guest.registerGuest(token, '99999', 'Jane');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already been used');
  });

  it('revokeToken removes token from DB', async () => {
    const { token } = await guest.generateToken('church-1', 'Test Church');
    const result = await guest.revokeToken(token);
    expect(result.revoked).toBe(true);
    expect((await guest.validateToken(token)).valid).toBe(false);
  });

  it('findActiveGuestByChatId returns registered guest', async () => {
    const { token } = await guest.generateToken('church-1', 'Test Church');
    await guest.registerGuest(token, '12345', 'John');
    const found = await guest.findActiveGuestByChatId('12345');
    expect(found).toBeTruthy();
    expect(found.churchId).toBe('church-1');
  });

  it('findActiveGuestByChatId returns null for unregistered chat', async () => {
    const found = await guest.findActiveGuestByChatId('99999');
    expect(found).toBeNull();
  });
});

describe('Portal Integration Methods', () => {
  let db;
  let guest;

  beforeEach(async () => {
    db = createTestDb();
    guest = await createGuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('listTokensForChurch returns only tokens for that church', async () => {
    await guest.generateToken('church-1', 'Church A');
    await guest.generateToken('church-1', 'Church A');
    await guest.generateToken('church-2', 'Church B');

    const tokens1 = await guest.listTokensForChurch('church-1');
    const tokens2 = await guest.listTokensForChurch('church-2');
    expect(tokens1).toHaveLength(2);
    expect(tokens2).toHaveLength(1);
    expect(tokens2[0].churchId).toBe('church-2');
  });

  it('listTokensForChurch excludes expired tokens', async () => {
    db.prepare('INSERT INTO guest_tokens (token, churchId, name, createdAt, expiresAt, usedByChat) VALUES (?, ?, ?, ?, ?, ?)')
      .run('GUEST-EXPIRED', 'church-1', 'Old', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', '');
    await guest.generateToken('church-1', 'Church A');

    const tokens = await guest.listTokensForChurch('church-1');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).not.toBe('GUEST-EXPIRED');
  });

  it('generateTokenWithOptions uses custom label', async () => {
    const result = await guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Visiting TD - March 9' });
    expect(result.name).toBe('Visiting TD - March 9');
    expect(result.token).toMatch(/^GUEST-/);

    const row = db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(result.token);
    expect(row.name).toBe('Visiting TD - March 9');
  });

  it('generateTokenWithOptions defaults label to churchName + Guest', async () => {
    const result = await guest.generateTokenWithOptions('church-1', 'Grace Chapel');
    expect(result.name).toBe('Grace Chapel Guest');
  });

  it('generateTokenWithOptions uses custom expiry hours', async () => {
    const result = await guest.generateTokenWithOptions('church-1', 'Church A', { expiresInHours: 48 });
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 1000);
  });

  it('generateTokenWithOptions defaults to 24h expiry', async () => {
    const result = await guest.generateTokenWithOptions('church-1', 'Church A');
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('portal-generated tokens work with Telegram /register', async () => {
    const { token } = await guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Sunday Guest' });
    const result = await guest.registerGuest(token, '12345', 'Guest User');
    expect(result.success).toBe(true);
    expect(result.churchId).toBe('church-1');

    const found = await guest.findActiveGuestByChatId('12345');
    expect(found).toBeTruthy();
    expect(found.churchId).toBe('church-1');
  });
});

describe('Legacy Token Migration', () => {
  it('cleans up gtd_ prefixed tokens on construction', async () => {
    const db = createTestDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS guest_tokens (
        token TEXT PRIMARY KEY,
        churchId TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedByChat TEXT DEFAULT ''
      )
    `);
    db.prepare('INSERT INTO guest_tokens (token, churchId, name, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)')
      .run('gtd_abc123', 'church-1', '', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
    db.prepare('INSERT INTO guest_tokens (token, churchId, name, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)')
      .run('GUEST-VALID123', 'church-1', 'Real Token', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());

    const guest = await createGuestTdMode(db);

    const all = db.prepare('SELECT token FROM guest_tokens').all();
    expect(all).toHaveLength(1);
    expect(all[0].token).toBe('GUEST-VALID123');
    db.close();
  });

  it('no-op when no legacy tokens exist', async () => {
    const db = createTestDb();
    await createGuestTdMode(db);
    const all = db.prepare('SELECT * FROM guest_tokens').all();
    expect(all).toHaveLength(0);
    db.close();
  });
});

describe('Schema Consistency', () => {
  let db;
  let guest;

  beforeEach(async () => {
    db = createTestDb();
    guest = await createGuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('all tokens have required columns: token, churchId, name, createdAt, expiresAt, usedByChat', async () => {
    await guest.generateToken('church-1', 'Church A');
    await guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Test' });

    const rows = db.prepare('SELECT * FROM guest_tokens').all();
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row.token).toBeTruthy();
      expect(row.churchId).toBe('church-1');
      expect(row.name).toBeTruthy();
      expect(row.createdAt).toBeTruthy();
      expect(row.expiresAt).toBeTruthy();
      expect(row.usedByChat).toBeDefined();
    });
  });

  it('both token generation methods use same GUEST- prefix', async () => {
    const t1 = await guest.generateToken('church-1', 'Church A');
    const t2 = await guest.generateTokenWithOptions('church-1', 'Church A');
    expect(t1.token).toMatch(/^GUEST-/);
    expect(t2.token).toMatch(/^GUEST-/);
  });
});
