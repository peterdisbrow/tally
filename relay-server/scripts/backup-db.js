#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');
const { createBackupSnapshot } = require('../src/dbBackup');

const DB_PATH = process.env.DATABASE_PATH || './data/churches.db';
const resolvedDbPath = path.resolve(DB_PATH);
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(resolvedDbPath), 'backups'));
const retainCount = Number(process.env.BACKUP_RETAIN_COUNT || 96);
const label = process.env.BACKUP_LABEL || 'manual';
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY || '';

try {
  const db = new Database(resolvedDbPath);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  const snapshot = createBackupSnapshot({
    dbPath: resolvedDbPath,
    backupDir,
    encryptionKey,
    retainCount,
    label,
  });

  console.log(JSON.stringify({ ok: true, ...snapshot }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
