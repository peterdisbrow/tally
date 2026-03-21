/**
 * Tests for src/dbBackup.js — encrypted backup creation, restoration,
 * key parsing, and retention pruning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const { createBackupSnapshot, restoreBackupSnapshot, parseEncryptionKey } = require('../src/dbBackup');

// ─── parseEncryptionKey ───────────────────────────────────────────────────────

describe('parseEncryptionKey', () => {
  it('returns null for null input', () => {
    expect(parseEncryptionKey(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseEncryptionKey('')).toBeNull();
    expect(parseEncryptionKey('   ')).toBeNull();
  });

  it('accepts a 64-char hex string and returns a 32-byte Buffer', () => {
    const hex = 'a'.repeat(64);
    const key = parseEncryptionKey(hex);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(hex);
  });

  it('accepts a valid base64 string encoding 32 bytes', () => {
    const raw = crypto.randomBytes(32);
    const b64 = raw.toString('base64');
    const key = parseEncryptionKey(b64);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    expect(key.equals(raw)).toBe(true);
  });

  it('falls back to sha256 derivation for an arbitrary passphrase', () => {
    const key = parseEncryptionKey('my secret passphrase');
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
    // Same passphrase must yield same key
    const key2 = parseEncryptionKey('my secret passphrase');
    expect(key.equals(key2)).toBe(true);
  });

  it('different passphrases produce different keys', () => {
    const k1 = parseEncryptionKey('passphrase-one');
    const k2 = parseEncryptionKey('passphrase-two');
    expect(k1.equals(k2)).toBe(false);
  });
});

// ─── createBackupSnapshot + restoreBackupSnapshot ────────────────────────────

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tally-backup-test-'));
}

function createFakeDb(dir, content = 'fake sqlite data for testing') {
  const dbPath = path.join(dir, 'test.sqlite');
  fs.writeFileSync(dbPath, content);
  return dbPath;
}

describe('createBackupSnapshot — unencrypted', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates a .sqlite.gz file in backupDir', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');
    const result = createBackupSnapshot({ dbPath, backupDir, label: 'test' });
    expect(fs.existsSync(result.fullPath)).toBe(true);
    expect(result.fullPath).toMatch(/\.sqlite\.gz$/);
  });

  it('returns encrypted: false when no key provided', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');
    const result = createBackupSnapshot({ dbPath, backupDir });
    expect(result.encrypted).toBe(false);
  });

  it('reports correct dbBytes', () => {
    const content = 'x'.repeat(500);
    const dbPath = createFakeDb(tmpDir, content);
    const backupDir = path.join(tmpDir, 'backups');
    const result = createBackupSnapshot({ dbPath, backupDir });
    expect(result.dbBytes).toBe(500);
  });

  it('creates backupDir if it does not exist', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'new', 'nested', 'dir');
    expect(fs.existsSync(backupDir)).toBe(false);
    createBackupSnapshot({ dbPath, backupDir });
    expect(fs.existsSync(backupDir)).toBe(true);
  });

  it('throws if dbPath is missing', () => {
    expect(() =>
      createBackupSnapshot({ dbPath: undefined, backupDir: tmpDir })
    ).toThrow('dbPath is required');
  });

  it('throws if dbPath does not exist', () => {
    expect(() =>
      createBackupSnapshot({ dbPath: '/no/such/file.sqlite', backupDir: tmpDir })
    ).toThrow('Database file not found');
  });
});

describe('createBackupSnapshot — encrypted', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates a .sqlite.gz.enc file when key is provided', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');
    const result = createBackupSnapshot({
      dbPath,
      backupDir,
      encryptionKey: 'a'.repeat(64),
    });
    expect(result.fullPath).toMatch(/\.sqlite\.gz\.enc$/);
    expect(result.encrypted).toBe(true);
  });
});

describe('restoreBackupSnapshot — unencrypted round-trip', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('restores original data from an unencrypted backup', () => {
    const original = 'original database content 12345';
    const dbPath = createFakeDb(tmpDir, original);
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({ dbPath, backupDir });

    const destPath = path.join(tmpDir, 'restored.sqlite');
    const result = restoreBackupSnapshot({ snapshotPath: fullPath, destinationPath: destPath });

    expect(fs.existsSync(destPath)).toBe(true);
    expect(fs.readFileSync(destPath, 'utf8')).toBe(original);
    expect(result.restoredBytes).toBe(Buffer.byteLength(original));
  });

  it('preserves the existing file with .pre-restore suffix when preserveExisting=true', () => {
    const dbPath = createFakeDb(tmpDir, 'original');
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({ dbPath, backupDir });

    const destPath = path.join(tmpDir, 'target.sqlite');
    fs.writeFileSync(destPath, 'existing data');

    restoreBackupSnapshot({ snapshotPath: fullPath, destinationPath: destPath, preserveExisting: true });

    // original preserved with timestamp suffix
    const files = fs.readdirSync(tmpDir);
    const preserved = files.find(f => f.startsWith('target.sqlite.pre-restore-'));
    expect(preserved).toBeDefined();
  });

  it('overwrites without preserving when preserveExisting=false', () => {
    const dbPath = createFakeDb(tmpDir, 'new content');
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({ dbPath, backupDir });

    const destPath = path.join(tmpDir, 'target.sqlite');
    fs.writeFileSync(destPath, 'old content');

    restoreBackupSnapshot({ snapshotPath: fullPath, destinationPath: destPath, preserveExisting: false });

    const files = fs.readdirSync(tmpDir);
    const preserved = files.find(f => f.startsWith('target.sqlite.pre-restore-'));
    expect(preserved).toBeUndefined();
    expect(fs.readFileSync(destPath, 'utf8')).toBe('new content');
  });

  it('throws if snapshotPath is missing', () => {
    expect(() =>
      restoreBackupSnapshot({ destinationPath: '/tmp/dest.sqlite' })
    ).toThrow('snapshotPath is required');
  });

  it('throws if destinationPath is missing', () => {
    const dbPath = createFakeDb(tmpDir);
    const { fullPath } = createBackupSnapshot({ dbPath, backupDir: path.join(tmpDir, 'b') });
    expect(() =>
      restoreBackupSnapshot({ snapshotPath: fullPath })
    ).toThrow('destinationPath is required');
  });

  it('throws if snapshot file does not exist', () => {
    expect(() =>
      restoreBackupSnapshot({ snapshotPath: '/no/such.sqlite.gz', destinationPath: '/tmp/d.sqlite' })
    ).toThrow('Snapshot file not found');
  });
});

describe('restoreBackupSnapshot — encrypted round-trip', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('restores original data from an encrypted backup with correct key', () => {
    const original = 'secret database contents';
    const dbPath = createFakeDb(tmpDir, original);
    const key = 'b'.repeat(64);
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({ dbPath, backupDir, encryptionKey: key });

    const destPath = path.join(tmpDir, 'restored.sqlite');
    restoreBackupSnapshot({ snapshotPath: fullPath, destinationPath: destPath, encryptionKey: key });

    expect(fs.readFileSync(destPath, 'utf8')).toBe(original);
  });

  it('throws when decrypting with wrong key', () => {
    const dbPath = createFakeDb(tmpDir, 'data');
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({
      dbPath,
      backupDir,
      encryptionKey: 'a'.repeat(64),
    });

    expect(() =>
      restoreBackupSnapshot({
        snapshotPath: fullPath,
        destinationPath: path.join(tmpDir, 'out.sqlite'),
        encryptionKey: 'c'.repeat(64),
      })
    ).toThrow();
  });

  it('throws when encrypted backup is restored without a key', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');
    const { fullPath } = createBackupSnapshot({
      dbPath,
      backupDir,
      encryptionKey: 'a'.repeat(64),
    });

    expect(() =>
      restoreBackupSnapshot({
        snapshotPath: fullPath,
        destinationPath: path.join(tmpDir, 'out.sqlite'),
        // no encryptionKey
      })
    ).toThrow('BACKUP_ENCRYPTION_KEY is required');
  });
});

describe('pruning via retainCount', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir(); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('removes old backups when retainCount is exceeded', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');

    // Create 4 backups, keep only 2
    for (let i = 0; i < 4; i++) {
      // Small delay ensures different timestamps in filename
      createBackupSnapshot({ dbPath, backupDir, retainCount: 2, label: `backup-${i}` });
    }

    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.sqlite.gz'));
    expect(files.length).toBe(2);
  });

  it('returns list of pruned files', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');

    // Create 3 backups with unique labels to ensure unique filenames even on fast hardware
    createBackupSnapshot({ dbPath, backupDir, retainCount: 10, label: 'first' });
    createBackupSnapshot({ dbPath, backupDir, retainCount: 10, label: 'second' });
    const result = createBackupSnapshot({ dbPath, backupDir, retainCount: 1, label: 'third' });

    expect(Array.isArray(result.pruned)).toBe(true);
    // After creating 3, retaining 1 should prune at least 1 (may be 2 if all unique filenames)
    expect(result.pruned.length).toBeGreaterThanOrEqual(1);
    // And final backup count in dir should be exactly 1
    const remaining = fs.readdirSync(backupDir).filter(f => f.endsWith('.sqlite.gz'));
    expect(remaining.length).toBe(1);
  });

  it('does not prune if retainCount is higher than file count', () => {
    const dbPath = createFakeDb(tmpDir);
    const backupDir = path.join(tmpDir, 'backups');

    const result = createBackupSnapshot({ dbPath, backupDir, retainCount: 100 });
    expect(result.pruned.length).toBe(0);
  });
});
