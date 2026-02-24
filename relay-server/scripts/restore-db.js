#!/usr/bin/env node

const path = require('path');
const Database = require('better-sqlite3');
const { restoreBackupSnapshot } = require('../src/dbBackup');

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--snapshot' || token === '-s') {
      args.snapshot = argv[++i];
    } else if (token === '--dest' || token === '-d') {
      args.dest = argv[++i];
    } else if (token === '--force') {
      args.force = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const snapshotPath = path.resolve(args.snapshot || process.env.BACKUP_SNAPSHOT_PATH || '');
const destinationPath = path.resolve(args.dest || process.env.DATABASE_PATH || './data/churches.db');
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY || '';

if (!snapshotPath || snapshotPath === path.resolve('')) {
  console.error('Usage: node scripts/restore-db.js --snapshot <path> [--dest <db_path>] [--force]');
  process.exit(1);
}

if (!args.force && process.env.CONFIRM_RESTORE !== 'YES') {
  console.error('Restore blocked. Pass --force or set CONFIRM_RESTORE=YES.');
  process.exit(1);
}

try {
  const result = restoreBackupSnapshot({
    snapshotPath,
    destinationPath,
    encryptionKey,
    preserveExisting: true,
  });

  // Quick integrity check after restore
  const db = new Database(destinationPath, { readonly: true });
  const integrity = db.prepare('PRAGMA integrity_check').pluck().get();
  db.close();

  if (String(integrity).toLowerCase() !== 'ok') {
    throw new Error(`Restored DB integrity check failed: ${integrity}`);
  }

  console.log(JSON.stringify({ ok: true, integrity, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
