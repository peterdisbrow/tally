import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuestTdMode } from '../src/guestTdMode.js';
import Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  return db;
}

// ─── A. GuestTdMode Core ─────────────────────────────────────────────────────

describe('GuestTdMode Core', () => {
  let db, guest;

  beforeEach(() => {
    db = createTestDb();
    guest = new GuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('creates guest_tokens table on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guest_tokens'").all();
    expect(tables).toHaveLength(1);
  });

  it('generateToken produces GUEST- prefixed token with 24h expiry', () => {
    const result = guest.generateToken('church-1', 'Test Church');
    expect(result.token).toMatch(/^GUEST-[A-F0-9]{24}$/);
    expect(result.expiresAt).toBeTruthy();
    // Verify ~24h from now
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('validateToken returns valid for fresh token', () => {
    const { token } = guest.generateToken('church-1', 'Test Church');
    const result = guest.validateToken(token);
    expect(result.valid).toBe(true);
    expect(result.guestRow.churchId).toBe('church-1');
  });

  it('validateToken returns invalid for unknown token', () => {
    const result = guest.validateToken('GUEST-NONEXISTENT');
    expect(result.valid).toBe(false);
  });

  it('registerGuest binds token to Telegram chat ID', () => {
    const { token } = guest.generateToken('church-1', 'Test Church');
    const result = guest.registerGuest(token, '12345', 'John');
    expect(result.success).toBe(true);
    expect(result.churchId).toBe('church-1');
    // Verify DB updated
    const row = db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(token);
    expect(row.usedByChat).toBe('12345');
    expect(row.name).toBe('John');
  });

  it('registerGuest rejects already-claimed token by different user', () => {
    const { token } = guest.generateToken('church-1', 'Test Church');
    guest.registerGuest(token, '12345', 'John');
    const result = guest.registerGuest(token, '99999', 'Jane');
    expect(result.success).toBe(false);
    expect(result.message).toContain('already been used');
  });

  it('revokeToken removes token from DB', () => {
    const { token } = guest.generateToken('church-1', 'Test Church');
    const result = guest.revokeToken(token);
    expect(result.revoked).toBe(true);
    expect(guest.validateToken(token).valid).toBe(false);
  });

  it('findActiveGuestByChatId returns registered guest', () => {
    const { token } = guest.generateToken('church-1', 'Test Church');
    guest.registerGuest(token, '12345', 'John');
    const found = guest.findActiveGuestByChatId('12345');
    expect(found).toBeTruthy();
    expect(found.churchId).toBe('church-1');
  });

  it('findActiveGuestByChatId returns null for unregistered chat', () => {
    const found = guest.findActiveGuestByChatId('99999');
    expect(found).toBeNull();
  });
});

// ─── B. New Methods (Portal Integration) ─────────────────────────────────────

describe('Portal Integration Methods', () => {
  let db, guest;

  beforeEach(() => {
    db = createTestDb();
    guest = new GuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('listTokensForChurch returns only tokens for that church', () => {
    guest.generateToken('church-1', 'Church A');
    guest.generateToken('church-1', 'Church A');
    guest.generateToken('church-2', 'Church B');

    const tokens1 = guest.listTokensForChurch('church-1');
    const tokens2 = guest.listTokensForChurch('church-2');
    expect(tokens1).toHaveLength(2);
    expect(tokens2).toHaveLength(1);
    expect(tokens2[0].churchId).toBe('church-2');
  });

  it('listTokensForChurch excludes expired tokens', () => {
    // Insert an expired token manually
    db.prepare('INSERT INTO guest_tokens (token, churchId, name, createdAt, expiresAt, usedByChat) VALUES (?, ?, ?, ?, ?, ?)')
      .run('GUEST-EXPIRED', 'church-1', 'Old', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', '');
    guest.generateToken('church-1', 'Church A');

    const tokens = guest.listTokensForChurch('church-1');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).not.toBe('GUEST-EXPIRED');
  });

  it('generateTokenWithOptions uses custom label', () => {
    const result = guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Visiting TD — March 9' });
    expect(result.name).toBe('Visiting TD — March 9');
    expect(result.token).toMatch(/^GUEST-/);

    const row = db.prepare('SELECT * FROM guest_tokens WHERE token = ?').get(result.token);
    expect(row.name).toBe('Visiting TD — March 9');
  });

  it('generateTokenWithOptions defaults label to churchName + Guest', () => {
    const result = guest.generateTokenWithOptions('church-1', 'Grace Chapel');
    expect(result.name).toBe('Grace Chapel Guest');
  });

  it('generateTokenWithOptions uses custom expiry hours', () => {
    const result = guest.generateTokenWithOptions('church-1', 'Church A', { expiresInHours: 48 });
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(47 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(48 * 60 * 60 * 1000 + 1000);
  });

  it('generateTokenWithOptions defaults to 24h expiry', () => {
    const result = guest.generateTokenWithOptions('church-1', 'Church A');
    const diff = new Date(result.expiresAt) - Date.now();
    expect(diff).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(diff).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('portal-generated tokens work with Telegram /register', () => {
    const { token } = guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Sunday Guest' });
    expect(token).toMatch(/^GUEST-/);

    // Simulate Telegram registration
    const result = guest.registerGuest(token, '12345', 'Guest User');
    expect(result.success).toBe(true);
    expect(result.churchId).toBe('church-1');

    // Verify findActiveGuestByChatId works
    const found = guest.findActiveGuestByChatId('12345');
    expect(found).toBeTruthy();
    expect(found.churchId).toBe('church-1');
  });
});

// ─── C. Legacy Token Migration ───────────────────────────────────────────────

describe('Legacy Token Migration', () => {
  it('cleans up gtd_ prefixed tokens on construction', () => {
    const db = createTestDb();
    // Create table manually with a gtd_ token
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

    // Constructing GuestTdMode triggers migration
    const guest = new GuestTdMode(db);

    const all = db.prepare('SELECT token FROM guest_tokens').all();
    expect(all).toHaveLength(1);
    expect(all[0].token).toBe('GUEST-VALID123');
    db.close();
  });

  it('no-op when no legacy tokens exist', () => {
    const db = createTestDb();
    const guest = new GuestTdMode(db);
    const all = db.prepare('SELECT * FROM guest_tokens').all();
    expect(all).toHaveLength(0);
    db.close();
  });
});

// ─── D. Schema Consistency ───────────────────────────────────────────────────

describe('Schema Consistency', () => {
  let db, guest;

  beforeEach(() => {
    db = createTestDb();
    guest = new GuestTdMode(db);
  });

  afterEach(() => {
    db?.close();
  });

  it('all tokens have required columns: token, churchId, name, createdAt, expiresAt, usedByChat', () => {
    guest.generateToken('church-1', 'Church A');
    guest.generateTokenWithOptions('church-1', 'Church A', { label: 'Test' });

    const rows = db.prepare('SELECT * FROM guest_tokens').all();
    expect(rows).toHaveLength(2);
    rows.forEach(row => {
      expect(row.token).toBeTruthy();
      expect(row.churchId).toBe('church-1');
      expect(row.name).toBeTruthy();
      expect(row.createdAt).toBeTruthy();
      expect(row.expiresAt).toBeTruthy();
      expect(row.usedByChat).toBeDefined(); // '' for unclaimed
    });
  });

  it('both token generation methods use same GUEST- prefix', () => {
    const t1 = guest.generateToken('church-1', 'Church A');
    const t2 = guest.generateTokenWithOptions('church-1', 'Church A');
    expect(t1.token).toMatch(/^GUEST-/);
    expect(t2.token).toMatch(/^GUEST-/);
  });
});
