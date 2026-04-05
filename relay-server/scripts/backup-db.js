#!/usr/bin/env node

const Database = require('better-sqlite3');
const { createBackupSnapshot } = require('../src/dbBackup');
const { resolveSqliteBackupConfig } = require('../src/db/config');

try {
  const {
    sqlitePath: resolvedDbPath,
    backupDir,
    retainCount,
    label,
    encryptionKey,
  } = resolveSqliteBackupConfig(process.env);

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
